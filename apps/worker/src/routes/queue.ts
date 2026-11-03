// 順番待ちの HTTP ルート。
//
// LIFF（お客さん）: /api/liff/queue/*（authMiddleware の対象外）。liffId クエリで店を決め、
//   Authorization: Bearer <id_token> で LINE の本人を確かめる（routes/booking.ts と同じ）。
// 管理画面（店側）: /api/queue/admin/*。全体の authMiddleware でログインを確かめ、
//   account_id クエリで店を決める。
// 処理の中身は services/queue.ts、お知らせとマイル・タグは services/queue-delivery.ts。

import { Hono, type Context } from 'hono';
import type { Env } from '../index.js';
import { resolveAccountIdFromLiff, resolveFriendId, verifyCallerLineUserId } from './booking.js';
import {
  QUEUE_ACTIONS,
  QueueAlreadyJoinedError,
  applyQueueAction,
  cancelByCustomer,
  checkInEntry,
  collectNearNotices,
  confirmationNotice,
  createEntry,
  findActiveEntryForFriend,
  groupsAhead,
  joinBlockReason,
  jstBusinessDate,
  listActiveEntries,
  loadQueueConfig,
  parseQueueSettings,
  saveQueueConfig,
  ticketLabel,
  todayStats,
  validateQueueSettings,
  waitingCount,
  type QueueAction,
  type QueueConfig,
  type QueueEntryRow,
  type QueueNotice,
} from '../services/queue.js';
import { applyQueueFinishEffects, deliverQueueNotices } from '../services/queue-delivery.js';

const queue = new Hono<Env>();

/** 応答を返したあとに続ける処理。テストなど waitUntil が無いときはその場で待つ。 */
async function afterResponse(c: Context<Env>, work: Promise<unknown>): Promise<void> {
  const safe = work.catch((err) => console.error('[queue] background work failed:', err));
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    await safe;
  }
}

function sendNotices(c: Context<Env>, config: QueueConfig, notices: QueueNotice[]): Promise<void> {
  if (notices.length === 0) return Promise.resolve();
  return afterResponse(c, deliverQueueNotices(c.env.DB, config, notices));
}

/** お客さん・店側の画面に返す形。 */
function present(e: QueueEntryRow, active: QueueEntryRow[]) {
  return {
    id: e.id,
    ticket_no: e.ticket_no,
    ticket_label: ticketLabel(e.ticket_no),
    party_size: e.party_size,
    seat_type: e.seat_type,
    kind: e.kind,
    status: e.status,
    arrived: Boolean(e.arrived_at),
    passed: Boolean(e.passed_at),
    groups_ahead: e.status === 'waiting' ? groupsAhead(active, e) : 0,
    guest_label: e.guest_label,
    has_line: Boolean(e.friend_id),
    call_count: e.call_count,
    called_at: e.called_at,
    created_at: e.created_at,
  };
}

function publicSettings(config: QueueConfig) {
  const s = config.settings;
  return {
    max_party_size: s.maxPartySize,
    seat_types: s.seatTypes,
    notify_before_groups: s.notifyBeforeGroups,
    arrival_timeout_minutes: s.arrivalTimeoutMinutes,
    open_time: s.openTime,
    close_time: s.closeTime,
  };
}

function readPartySize(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : null;
}

function readSeatType(v: unknown, config: QueueConfig): string | null | false {
  if (config.settings.seatTypes.length === 0) return null;
  if (v === undefined || v === null || v === '') return config.settings.seatTypes[0];
  return typeof v === 'string' && config.settings.seatTypes.includes(v) ? v : false;
}

// ================================================================
// LIFF（お客さん）
// ================================================================

async function liffCaller(c: Context<Env>): Promise<
  { accountId: string; friendId: string } | { error: string; status: 401 | 403 | 404 }
> {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return { error: 'unknown_liff', status: 404 };
  const lineUserId = await verifyCallerLineUserId(c);
  if (!lineUserId) return { error: 'unauthorized', status: 401 };
  const friendId = await resolveFriendId(c, lineUserId, accountId);
  if (!friendId) return { error: 'friend_not_found', status: 404 };
  const friend = await c.env.DB
    .prepare(`SELECT is_following FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ is_following: number }>();
  if (!friend || friend.is_following === 0) return { error: 'not_following', status: 403 };
  return { accountId, friendId };
}

queue.get('/api/liff/queue/status', async (c) => {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return c.json({ error: 'unknown_liff' }, 404);
  const config = await loadQueueConfig(c.env.DB, accountId);
  const now = new Date();
  const active = await listActiveEntries(c.env.DB, accountId, jstBusinessDate(now));
  const token = c.req.query('t') ?? null;
  return c.json({
    open: config.isOpen,
    waiting_groups: waitingCount(active),
    token_valid: Boolean(token) && token === config.checkinToken,
    walk_in_block: joinBlockReason(config, 'walk_in', active, now, token),
    remote_block: joinBlockReason(config, 'remote', active, now),
    settings: publicSettings(config),
  });
});

queue.get('/api/liff/queue/me', async (c) => {
  const who = await liffCaller(c);
  if ('error' in who) return c.json({ error: who.error }, who.status);
  const today = jstBusinessDate(new Date());
  const entry = await findActiveEntryForFriend(c.env.DB, who.accountId, who.friendId, today);
  if (!entry) return c.json({ entry: null });
  const active = await listActiveEntries(c.env.DB, who.accountId, today);
  return c.json({ entry: present(entry, active) });
});

queue.post('/api/liff/queue/entries', async (c) => {
  const who = await liffCaller(c);
  if ('error' in who) return c.json({ error: who.error }, who.status);
  const body = await c.req.json<{ kind?: unknown; party_size?: unknown; seat_type?: unknown; token?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const kind = body.kind === 'walk_in' || body.kind === 'remote' ? body.kind : null;
  if (!kind) return c.json({ error: 'invalid_kind' }, 400);
  const config = await loadQueueConfig(c.env.DB, who.accountId);
  const partySize = readPartySize(body.party_size, config.settings.maxPartySize);
  if (partySize === null) return c.json({ error: 'invalid_party_size' }, 400);
  const seatType = readSeatType(body.seat_type, config);
  if (seatType === false) return c.json({ error: 'invalid_seat_type' }, 400);

  const now = new Date();
  const today = jstBusinessDate(now);
  const existing = await findActiveEntryForFriend(c.env.DB, who.accountId, who.friendId, today);
  if (existing) return c.json({ error: 'already_in_queue' }, 409);
  const active = await listActiveEntries(c.env.DB, who.accountId, today);
  const blocked = joinBlockReason(config, kind, active, now, typeof body.token === 'string' ? body.token : null);
  if (blocked) return c.json({ error: blocked }, blocked === 'invalid_token' ? 403 : 409);

  let entry: QueueEntryRow;
  try {
    entry = await createEntry(c.env.DB, {
      lineAccountId: who.accountId,
      friendId: who.friendId,
      partySize,
      seatType,
      kind,
      now,
    });
  } catch (err) {
    if (err instanceof QueueAlreadyJoinedError) return c.json({ error: 'already_in_queue' }, 409);
    throw err;
  }
  const after = await listActiveEntries(c.env.DB, who.accountId, today);
  const notices: QueueNotice[] = [];
  const confirm = confirmationNotice(after, entry);
  if (confirm) notices.push(confirm);
  // 受付した時点で N組前以内なら、受付完了に続けて知らせる。
  notices.push(...(await collectNearNotices(c.env.DB, config, today, now)));
  await sendNotices(c, config, notices);
  return c.json({ entry: present(entry, after) }, 201);
});

queue.post('/api/liff/queue/checkin', async (c) => {
  const who = await liffCaller(c);
  if ('error' in who) return c.json({ error: who.error }, who.status);
  const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const config = await loadQueueConfig(c.env.DB, who.accountId);
  if (typeof body.token !== 'string' || body.token !== config.checkinToken) {
    return c.json({ error: 'invalid_token' }, 403);
  }
  const now = new Date();
  const today = jstBusinessDate(now);
  const entry = await findActiveEntryForFriend(c.env.DB, who.accountId, who.friendId, today);
  if (!entry) return c.json({ error: 'not_in_queue' }, 404);
  const result = await checkInEntry(c.env.DB, config, entry, now);
  await sendNotices(c, config, result.notices);
  const active = await listActiveEntries(c.env.DB, who.accountId, today);
  return c.json({ entry: present(result.entry, active) });
});

queue.post('/api/liff/queue/cancel', async (c) => {
  const who = await liffCaller(c);
  if ('error' in who) return c.json({ error: who.error }, who.status);
  const now = new Date();
  const today = jstBusinessDate(now);
  const entry = await findActiveEntryForFriend(c.env.DB, who.accountId, who.friendId, today);
  if (!entry) return c.json({ error: 'not_in_queue' }, 404);
  const config = await loadQueueConfig(c.env.DB, who.accountId);
  const result = await cancelByCustomer(c.env.DB, config, entry, now);
  if (!result.cancelled) return c.json({ error: 'invalid_state' }, 409);
  await sendNotices(c, config, result.notices);
  return c.json({ ok: true });
});

// ================================================================
// 管理画面（店側）
// ================================================================

function adminAccount(c: Context<Env>): string | null {
  return c.req.query('account_id') ?? null;
}

queue.get('/api/queue/admin/entries', async (c) => {
  const accountId = adminAccount(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const config = await loadQueueConfig(c.env.DB, accountId);
  const today = jstBusinessDate(new Date());
  const active = await listActiveEntries(c.env.DB, accountId, today);
  return c.json({
    business_date: today,
    is_open: config.isOpen,
    remote_open: config.remoteOpen,
    waiting_groups: waitingCount(active),
    entries: active.map((e) => present(e, active)),
    stats: await todayStats(c.env.DB, accountId, today),
  });
});

queue.post('/api/queue/admin/entries', async (c) => {
  const accountId = adminAccount(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const body = await c.req.json<{ party_size?: unknown; seat_type?: unknown; guest_label?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const config = await loadQueueConfig(c.env.DB, accountId);
  const partySize = readPartySize(body.party_size, config.settings.maxPartySize);
  if (partySize === null) return c.json({ error: 'invalid_party_size' }, 400);
  const seatType = readSeatType(body.seat_type, config);
  if (seatType === false) return c.json({ error: 'invalid_seat_type' }, 400);
  const guestLabel = typeof body.guest_label === 'string' ? body.guest_label.trim().slice(0, 40) || null : null;
  const now = new Date();
  const entry = await createEntry(c.env.DB, {
    lineAccountId: accountId,
    friendId: null,
    guestLabel,
    partySize,
    seatType,
    kind: 'staff',
    now,
  });
  const today = jstBusinessDate(now);
  await sendNotices(c, config, await collectNearNotices(c.env.DB, config, today, now));
  const active = await listActiveEntries(c.env.DB, accountId, today);
  return c.json({ entry: present(entry, active) }, 201);
});

queue.post('/api/queue/admin/entries/:id/action', async (c) => {
  const accountId = adminAccount(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const body = await c.req.json<{ action?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const action = QUEUE_ACTIONS.find((a) => a === body.action) as QueueAction | undefined;
  if (!action) return c.json({ error: 'invalid_action' }, 400);
  const config = await loadQueueConfig(c.env.DB, accountId);
  const result = await applyQueueAction(c.env.DB, config, c.req.param('id'), action, new Date());
  if ('error' in result) {
    return c.json({ error: result.error }, result.error === 'not_found' ? 404 : 409);
  }
  await sendNotices(c, config, result.notices);
  if (result.finished) {
    await afterResponse(c, applyQueueFinishEffects(c.env.DB, config, result.entry, result.finished, c.env));
  }
  const active = await listActiveEntries(c.env.DB, accountId, result.entry.business_date);
  return c.json({ entry: present(result.entry, active) });
});

function adminSettingsBody(config: QueueConfig, liffId: string | null) {
  return {
    settings: config.settings,
    is_open: config.isOpen,
    remote_open: config.remoteOpen,
    checkin_token: config.checkinToken,
    liff_id: liffId,
  };
}

async function accountLiffId(db: D1Database, accountId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT liff_id FROM line_accounts WHERE id = ?`).bind(accountId).first<{ liff_id: string | null }>();
  return row?.liff_id ?? null;
}

queue.get('/api/queue/admin/settings', async (c) => {
  const accountId = adminAccount(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const config = await loadQueueConfig(c.env.DB, accountId);
  return c.json(adminSettingsBody(config, await accountLiffId(c.env.DB, accountId)));
});

queue.put('/api/queue/admin/settings', async (c) => {
  const accountId = adminAccount(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const body = await c.req
    .json<{ settings?: unknown; is_open?: unknown; remote_open?: unknown; rotate_token?: unknown }>()
    .catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);
  let settings: ReturnType<typeof parseQueueSettings> | undefined;
  if (body.settings !== undefined) {
    if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      return c.json({ error: 'invalid_settings' }, 400);
    }
    const error = validateQueueSettings(body.settings as Record<string, unknown>);
    if (error) return c.json({ error }, 400);
    const current = await loadQueueConfig(c.env.DB, accountId);
    settings = parseQueueSettings(JSON.stringify({ ...current.settings, ...(body.settings as object) }));
  }
  for (const k of ['is_open', 'remote_open', 'rotate_token'] as const) {
    if (body[k] !== undefined && typeof body[k] !== 'boolean') return c.json({ error: `${k} must be a boolean` }, 400);
  }
  const config = await saveQueueConfig(c.env.DB, accountId, {
    settings,
    isOpen: body.is_open as boolean | undefined,
    remoteOpen: body.remote_open as boolean | undefined,
    rotateToken: body.rotate_token === true,
  });
  return c.json(adminSettingsBody(config, await accountLiffId(c.env.DB, accountId)));
});

export default queue;
