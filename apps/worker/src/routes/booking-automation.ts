// 予約のきっかけの設定窓口（管理者用）。
//
// - メニューごとに、承認時に登録するリマインダー
//   GET/PUT /api/booking/admin/menus/:id/reminders
// - メニューごとの設定（承認時に Google Meet を付けるか、1人あたりの予約数の上限）
//   GET/PUT /api/booking/admin/menus/:id/options
// - アカウントの予約の決まり（表示・受付の締切・何日先まで・祝日）
//   GET/PUT /api/booking/admin/booking-settings
// - 担当者の自動割り振りの優先度
//   GET/PUT /api/booking/admin/staff/:id/priority
// - 予約のきっかけごとの管理者通知（チャットワーク / Webhook）
//   GET/POST /api/booking/admin/notify-targets
//   PUT/DELETE /api/booking/admin/notify-targets/:id
//   POST /api/booking/admin/notify-targets/:id/test（見本の予約で送ってみる）
//
// どれも ?account_id=... が必要（ほかの /api/booking/admin/* と同じ）。

import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  BOOKING_EVENTS,
  DEFAULT_ENDED_MINUTES_AFTER,
  renderAdminNotification,
  sendAdminNotification,
  type AdminNotificationRow,
  type BookingEvent,
} from '../services/booking-automation.js';
import { bookingAutomationDeps } from '../services/booking-automation-hooks.js';
import {
  loadBookingRules,
  saveBookingRules,
  validateBookingRulesInput,
  type BookingRules,
} from '../services/booking-rules.js';

const bookingAutomation = new Hono<Env>();

type NotifyBody = {
  event?: string;
  channel?: string;
  target?: string;
  message_template?: string;
  minutes_after?: number;
  is_active?: boolean;
};

function toApi(row: AdminNotificationRow) {
  return {
    id: row.id,
    event: row.event,
    channel: row.channel,
    target: row.target,
    message_template: row.message_template,
    minutes_after: row.minutes_after,
    is_active: row.is_active === 1,
  };
}

/** 入力の確認。問題があればエラーの文、無ければ null。partial=true は更新（足りない項目は可）。 */
export function validateNotifyBody(body: NotifyBody, partial: boolean): string | null {
  if (!partial || body.event !== undefined) {
    if (!BOOKING_EVENTS.includes(body.event as BookingEvent)) return `event must be one of ${BOOKING_EVENTS.join(', ')}`;
  }
  if (!partial || body.channel !== undefined) {
    if (body.channel !== 'chatwork' && body.channel !== 'webhook') return 'channel must be chatwork or webhook';
  }
  if (!partial || body.target !== undefined) {
    if (typeof body.target !== 'string' || body.target.trim() === '') return 'target is required';
  }
  if (!partial || body.message_template !== undefined) {
    if (typeof body.message_template !== 'string' || body.message_template.trim() === '') return 'message_template is required';
  }
  if (body.minutes_after !== undefined) {
    if (!Number.isInteger(body.minutes_after) || body.minutes_after < 0 || body.minutes_after > 10080) {
      return 'minutes_after must be an integer between 0 and 10080';
    }
  }
  return null;
}

function validateTarget(channel: string, target: string): string | null {
  if (channel === 'chatwork' && !/^\d+$/.test(target.trim())) return 'chatwork target must be a room ID (digits)';
  if (channel === 'webhook') {
    try {
      const url = new URL(target);
      if (url.protocol !== 'https:') return 'webhook target must be an https URL';
    } catch {
      return 'webhook target must be an https URL';
    }
  }
  return null;
}

// ---------------------------------------------------------------
// メニュー ↔ リマインダー

bookingAutomation.get('/api/booking/admin/menus/:id/reminders', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const menu = await c.env.DB
    .prepare(`SELECT id FROM menus WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
    .bind(c.req.param('id'), accountId)
    .first<{ id: string }>();
  if (!menu) return c.json({ error: 'not_found' }, 404);
  const rows = await c.env.DB
    .prepare(`SELECT reminder_id FROM booking_menu_reminders WHERE menu_id = ? ORDER BY created_at`)
    .bind(menu.id)
    .all<{ reminder_id: string }>();
  return c.json({ reminder_ids: rows.results.map((r) => r.reminder_id) });
});

bookingAutomation.put('/api/booking/admin/menus/:id/reminders', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const body = await c.req.json<{ reminder_ids?: unknown }>().catch(() => ({ reminder_ids: undefined }));
  if (!Array.isArray(body.reminder_ids) || !body.reminder_ids.every((v) => typeof v === 'string')) {
    return c.json({ error: 'reminder_ids must be an array of strings' }, 400);
  }
  const ids = [...new Set(body.reminder_ids as string[])];
  const menu = await c.env.DB
    .prepare(`SELECT id FROM menus WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
    .bind(c.req.param('id'), accountId)
    .first<{ id: string }>();
  if (!menu) return c.json({ error: 'not_found' }, 404);
  for (const reminderId of ids) {
    const r = await c.env.DB
      .prepare(`SELECT id FROM reminders WHERE id = ? AND (line_account_id IS NULL OR line_account_id = ?)`)
      .bind(reminderId, accountId)
      .first<{ id: string }>();
    if (!r) return c.json({ error: 'reminder_not_found', reminder_id: reminderId }, 400);
  }
  await c.env.DB.prepare(`DELETE FROM booking_menu_reminders WHERE menu_id = ?`).bind(menu.id).run();
  for (const reminderId of ids) {
    await c.env.DB
      .prepare(`INSERT OR IGNORE INTO booking_menu_reminders (menu_id, reminder_id) VALUES (?, ?)`)
      .bind(menu.id, reminderId)
      .run();
  }
  return c.json({ reminder_ids: ids });
});

// ---------------------------------------------------------------
// メニューの設定（承認時に Google Meet を付ける）

bookingAutomation.get('/api/booking/admin/menus/:id/options', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const menu = await c.env.DB
    .prepare(`SELECT id FROM menus WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
    .bind(c.req.param('id'), accountId)
    .first<{ id: string }>();
  if (!menu) return c.json({ error: 'not_found' }, 404);
  const row = await c.env.DB
    .prepare(`SELECT add_google_meet, max_active_per_friend FROM booking_menu_options WHERE menu_id = ?`)
    .bind(menu.id)
    .first<{ add_google_meet: number; max_active_per_friend: number | null }>();
  return c.json({
    add_google_meet: row?.add_google_meet === 1,
    max_active_per_friend: row?.max_active_per_friend ?? null,
  });
});

bookingAutomation.put('/api/booking/admin/menus/:id/options', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const body = await c.req
    .json<{ add_google_meet?: unknown; max_active_per_friend?: unknown }>()
    .catch(() => ({ add_google_meet: undefined, max_active_per_friend: undefined }));
  if (body.add_google_meet !== undefined && typeof body.add_google_meet !== 'boolean') {
    return c.json({ error: 'add_google_meet must be a boolean' }, 400);
  }
  if (body.max_active_per_friend !== undefined && body.max_active_per_friend !== null
    && !(typeof body.max_active_per_friend === 'number' && Number.isInteger(body.max_active_per_friend)
      && body.max_active_per_friend >= 1 && body.max_active_per_friend <= 100)) {
    return c.json({ error: 'max_active_per_friend must be an integer between 1 and 100, or null' }, 400);
  }
  const menu = await c.env.DB
    .prepare(`SELECT id FROM menus WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
    .bind(c.req.param('id'), accountId)
    .first<{ id: string }>();
  if (!menu) return c.json({ error: 'not_found' }, 404);
  const current = await c.env.DB
    .prepare(`SELECT add_google_meet, max_active_per_friend FROM booking_menu_options WHERE menu_id = ?`)
    .bind(menu.id)
    .first<{ add_google_meet: number; max_active_per_friend: number | null }>();
  const addGoogleMeet = body.add_google_meet === undefined ? current?.add_google_meet === 1 : body.add_google_meet === true;
  const maxActive = body.max_active_per_friend === undefined
    ? current?.max_active_per_friend ?? null
    : (body.max_active_per_friend as number | null);
  await c.env.DB
    .prepare(
      `INSERT INTO booking_menu_options (menu_id, add_google_meet, max_active_per_friend) VALUES (?, ?, ?)
       ON CONFLICT(menu_id) DO UPDATE SET add_google_meet = excluded.add_google_meet,
         max_active_per_friend = excluded.max_active_per_friend,
         updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`,
    )
    .bind(menu.id, addGoogleMeet ? 1 : 0, maxActive)
    .run();
  return c.json({ add_google_meet: addGoogleMeet, max_active_per_friend: maxActive });
});

// ---------------------------------------------------------------
// アカウントの予約の決まり

bookingAutomation.get('/api/booking/admin/booking-settings', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  return c.json({ settings: await loadBookingRules(c.env.DB, accountId) });
});

bookingAutomation.put('/api/booking/admin/booking-settings', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const input = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const current = await loadBookingRules(c.env.DB, accountId);
  const merged = { ...current, ...input } as Record<string, unknown>;
  const error = validateBookingRulesInput(merged);
  if (error) return c.json({ error }, 400);
  if (merged.fixedMenuId) {
    const menu = await c.env.DB
      .prepare(`SELECT id FROM menus WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
      .bind(merged.fixedMenuId, accountId)
      .first<{ id: string }>();
    if (!menu) return c.json({ error: 'fixed_menu_not_found' }, 400);
  }
  const next: BookingRules = {
    menuSelect: merged.menuSelect as boolean,
    fixedMenuId: (merged.fixedMenuId as string | null) ?? null,
    showMenuName: merged.showMenuName as boolean,
    staffSelect: merged.staffSelect as boolean,
    showStaffName: merged.showStaffName as boolean,
    minLeadMinutes: merged.minLeadMinutes as number,
    cutoffPrevDayTime: (merged.cutoffPrevDayTime as string | null) ?? null,
    maxDaysAhead: (merged.maxDaysAhead as number | null) ?? null,
    closedOnHolidays: merged.closedOnHolidays as boolean,
  };
  await saveBookingRules(c.env.DB, accountId, next);
  return c.json({ settings: await loadBookingRules(c.env.DB, accountId) });
});

// ---------------------------------------------------------------
// 担当者の自動割り振りの優先度（大きいほど先に割り振る）

bookingAutomation.get('/api/booking/admin/staff/:id/priority', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const staff = await c.env.DB
    .prepare(`SELECT id FROM staff WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
    .bind(c.req.param('id'), accountId)
    .first<{ id: string }>();
  if (!staff) return c.json({ error: 'not_found' }, 404);
  const row = await c.env.DB
    .prepare(`SELECT priority FROM booking_staff_priority WHERE staff_id = ?`)
    .bind(staff.id)
    .first<{ priority: number }>();
  return c.json({ priority: row?.priority ?? 0 });
});

bookingAutomation.put('/api/booking/admin/staff/:id/priority', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const body = await c.req.json<{ priority?: unknown }>().catch(() => ({ priority: undefined }));
  if (!(typeof body.priority === 'number' && Number.isInteger(body.priority) && body.priority >= -1000 && body.priority <= 1000)) {
    return c.json({ error: 'priority must be an integer between -1000 and 1000' }, 400);
  }
  const staff = await c.env.DB
    .prepare(`SELECT id FROM staff WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
    .bind(c.req.param('id'), accountId)
    .first<{ id: string }>();
  if (!staff) return c.json({ error: 'not_found' }, 404);
  await c.env.DB
    .prepare(
      `INSERT INTO booking_staff_priority (staff_id, priority) VALUES (?, ?)
       ON CONFLICT(staff_id) DO UPDATE SET priority = excluded.priority,
         updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`,
    )
    .bind(staff.id, body.priority)
    .run();
  return c.json({ priority: body.priority });
});

// ---------------------------------------------------------------
// 管理者通知

bookingAutomation.get('/api/booking/admin/notify-targets', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const rows = await c.env.DB
    .prepare(`SELECT * FROM booking_admin_notifications WHERE line_account_id = ? ORDER BY created_at`)
    .bind(accountId)
    .all<AdminNotificationRow>();
  return c.json({ targets: rows.results.map(toApi), chatwork_token_set: !!c.env.CHATWORK_API_TOKEN });
});

bookingAutomation.post('/api/booking/admin/notify-targets', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const body = await c.req.json<NotifyBody>().catch(() => ({}) as NotifyBody);
  const error = validateNotifyBody(body, false) ?? validateTarget(body.channel as string, body.target as string);
  if (error) return c.json({ error }, 400);
  const id = crypto.randomUUID();
  await c.env.DB
    .prepare(
      `INSERT INTO booking_admin_notifications
         (id, line_account_id, event, channel, target, message_template, minutes_after, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      accountId,
      body.event,
      body.channel,
      (body.target as string).trim(),
      body.message_template,
      body.minutes_after ?? DEFAULT_ENDED_MINUTES_AFTER,
      body.is_active === false ? 0 : 1,
    )
    .run();
  const row = await c.env.DB
    .prepare(`SELECT * FROM booking_admin_notifications WHERE id = ?`)
    .bind(id)
    .first<AdminNotificationRow>();
  return c.json({ target: row ? toApi(row) : null }, 201);
});

bookingAutomation.put('/api/booking/admin/notify-targets/:id', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const current = await c.env.DB
    .prepare(`SELECT * FROM booking_admin_notifications WHERE id = ? AND line_account_id = ?`)
    .bind(c.req.param('id'), accountId)
    .first<AdminNotificationRow>();
  if (!current) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json<NotifyBody>().catch(() => ({}) as NotifyBody);
  const error = validateNotifyBody(body, true)
    ?? validateTarget(body.channel ?? current.channel, (body.target ?? current.target).trim());
  if (error) return c.json({ error }, 400);
  await c.env.DB
    .prepare(
      `UPDATE booking_admin_notifications
          SET event = ?, channel = ?, target = ?, message_template = ?, minutes_after = ?, is_active = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE id = ?`,
    )
    .bind(
      body.event ?? current.event,
      body.channel ?? current.channel,
      (body.target ?? current.target).trim(),
      body.message_template ?? current.message_template,
      body.minutes_after ?? current.minutes_after,
      body.is_active === undefined ? current.is_active : body.is_active ? 1 : 0,
      current.id,
    )
    .run();
  const row = await c.env.DB
    .prepare(`SELECT * FROM booking_admin_notifications WHERE id = ?`)
    .bind(current.id)
    .first<AdminNotificationRow>();
  return c.json({ target: row ? toApi(row) : null });
});

bookingAutomation.delete('/api/booking/admin/notify-targets/:id', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const res = await c.env.DB
    .prepare(`DELETE FROM booking_admin_notifications WHERE id = ? AND line_account_id = ?`)
    .bind(c.req.param('id'), accountId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ deleted: true });
});

/** 見本の予約で1回送ってみる（設定の確認用。お客さんには何も送らない）。 */
bookingAutomation.post('/api/booking/admin/notify-targets/:id/test', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const row = await c.env.DB
    .prepare(`SELECT * FROM booking_admin_notifications WHERE id = ? AND line_account_id = ?`)
    .bind(c.req.param('id'), accountId)
    .first<AdminNotificationRow>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const start = new Date(Date.now() + 24 * 3600_000);
  start.setUTCMinutes(0, 0, 0);
  const sample = {
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 3600_000).toISOString(),
    menu_name: '（テスト）メニュー',
    meet_url: 'https://meet.google.com/xxx-xxxx-xxx',
    staff_name: '（テスト）担当者',
    friend_name: '（テスト）お客さま',
    customer_note: '（テスト送信です）',
    status: 'requested',
  };
  const deps = bookingAutomationDeps(c.env);
  const text = `【テスト送信】\n${renderAdminNotification(row.message_template, sample, row.event, deps.adminPublicUrl)}`;
  try {
    await sendAdminNotification(deps, row, text, { event: 'booking_test', booking: sample });
  } catch (err) {
    return c.json({ sent: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
  return c.json({ sent: true });
});

export default bookingAutomation;
