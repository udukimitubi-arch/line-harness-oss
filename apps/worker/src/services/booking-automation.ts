// 予約のきっかけ（申し込み・承認・却下・期限切れ・キャンセル・終了後）で動く処理。
//
// 1. 友だち情報（metadata）に予約の内容を記録する
// 2. メニューに紐づくリマインダーへの登録 / 解除
// 3. 自動ルール（automations）のきっかけ booking_* を発火する
// 4. 管理者への通知（チャットワーク / Webhook）
//
// どれも設定が無ければ何もしない。予約の処理そのものを止めないよう、
// 失敗はすべてログに残して握りつぶす。

import { enrollFriendInReminder, cancelFriendReminder, reminderStepDueAt } from '@line-crm/db';
import { fireEvent } from './event-bus.js';
import { loadBookingRules } from './booking-rules.js';

export type BookingEvent =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'ended'
  | 'attended'
  | 'no_show';

/** 管理者通知に使えるきっかけ（booking_admin_notifications.event の CHECK と同じ）。 */
export const BOOKING_EVENTS: readonly BookingEvent[] = [
  'requested',
  'approved',
  'rejected',
  'expired',
  'cancelled',
  'ended',
];

/** 自動ルールの event_type。 */
export const BOOKING_EVENT_TYPES: Record<BookingEvent, string> = {
  requested: 'booking_requested',
  approved: 'booking_approved',
  rejected: 'booking_rejected',
  expired: 'booking_expired',
  cancelled: 'booking_cancelled',
  ended: 'booking_ended',
  attended: 'booking_attended',
  no_show: 'booking_no_show',
};

export const BOOKING_EVENT_LABELS: Record<BookingEvent, string> = {
  requested: '申し込み',
  approved: '承認',
  rejected: '却下',
  expired: '期限切れ',
  cancelled: 'キャンセル',
  ended: '終了後',
  attended: '来た',
  no_show: '来なかった',
};

/** 「終了後」のきっかけの既定（終了時刻から何分後か）。 */
export const DEFAULT_ENDED_MINUTES_AFTER = 30;

/** 終了後のきっかけを拾う範囲。これより前に終わった予約は対象にしない。 */
const ENDED_LOOKBACK_MS = 6 * 3600_000;

/** 友だち情報に書くキー（日本語のまま差し込みで使う: {{metadata.予約日}}）。 */
export const BOOKING_METADATA_KEYS = {
  date: '予約日',
  start: '予約開始時刻',
  end: '予約終了時刻',
  menu: '予約メニュー',
  staff: '予約担当者',
  status: '予約状態',
  active: '予約の有無',
  lastDate: '最終予約日',
  meetUrl: '予約URL',
} as const;

const STATUS_LABELS: Record<string, string> = {
  requested: '申し込み中',
  confirmed: '確定',
  rejected: '却下',
  expired: '期限切れ',
  cancelled: 'キャンセル',
  completed: '来た',
  no_show: '来なかった',
};

const JST_OFFSET_MS = 9 * 3600_000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** UTC ISO → 日本時間の「10月25日(土)」と「10:00」。 */
export function formatJstParts(utcIso: string): { date: string; time: string; ymd: string } {
  const jst = new Date(new Date(utcIso).getTime() + JST_OFFSET_MS);
  const month = jst.getUTCMonth() + 1;
  const day = jst.getUTCDate();
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mm = String(jst.getUTCMinutes()).padStart(2, '0');
  const iso = jst.toISOString();
  return {
    date: `${month}月${day}日(${WEEKDAYS[jst.getUTCDay()]})`,
    time: `${hh}:${mm}`,
    ymd: `${iso.slice(0, 10)} ${hh}:${mm}`,
  };
}

export interface BookingSnapshot {
  id: string;
  line_account_id: string;
  friend_id: string;
  staff_id: string;
  menu_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  customer_note: string | null;
  menu_name: string;
  staff_name: string;
  friend_name: string | null;
  channel_access_token: string | null;
  /** 承認時に付けた Google Meet の URL（booking_meet_urls）。無ければ null。 */
  meet_url: string | null;
}

export async function loadBookingSnapshot(db: D1Database, bookingId: string): Promise<BookingSnapshot | null> {
  return db
    .prepare(
      `SELECT b.id, b.line_account_id, b.friend_id, b.staff_id, b.menu_id, b.starts_at, b.ends_at,
              b.status, b.customer_note,
              m.name AS menu_name,
              s.display_name AS staff_name,
              f.display_name AS friend_name,
              la.channel_access_token,
              bmu.meet_url
         FROM bookings b
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
         INNER JOIN friends f ON f.id = b.friend_id
         LEFT JOIN line_accounts la ON la.id = b.line_account_id
         LEFT JOIN booking_meet_urls bmu ON bmu.booking_id = b.id
        WHERE b.id = ?`,
    )
    .bind(bookingId)
    .first<BookingSnapshot>();
}

// ----------------------------------------------------------------
// 1. 友だち情報

/**
 * 友だち情報に書く値を作る。
 * 表示するのは「まだ終わっていない申し込み中・確定の予約のうち一番早いもの」。
 * 無ければ今回の予約。予約状態は今回のきっかけ（ended は「終了」）。
 */
export function buildBookingMetadata(params: {
  shown: Pick<BookingSnapshot, 'starts_at' | 'ends_at' | 'menu_name' | 'staff_name' | 'status'> & { meet_url?: string | null };
  statusLabel: string;
  hasActive: boolean;
  lastConfirmedStartsAt: string | null;
}): Record<string, string> {
  const start = formatJstParts(params.shown.starts_at);
  const end = formatJstParts(params.shown.ends_at);
  const meta: Record<string, string> = {
    [BOOKING_METADATA_KEYS.date]: start.date,
    [BOOKING_METADATA_KEYS.start]: start.time,
    [BOOKING_METADATA_KEYS.end]: end.time,
    [BOOKING_METADATA_KEYS.menu]: params.shown.menu_name,
    [BOOKING_METADATA_KEYS.staff]: params.shown.staff_name,
    [BOOKING_METADATA_KEYS.status]: params.statusLabel,
    [BOOKING_METADATA_KEYS.active]: params.hasActive ? 'あり' : 'なし',
    [BOOKING_METADATA_KEYS.meetUrl]: params.shown.meet_url ?? '',
  };
  if (params.lastConfirmedStartsAt) {
    meta[BOOKING_METADATA_KEYS.lastDate] = formatJstParts(params.lastConfirmedStartsAt).date;
  }
  return meta;
}

export async function syncBookingMetadata(
  db: D1Database,
  booking: BookingSnapshot,
  event: BookingEvent,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const active = await db
    .prepare(
      `SELECT b.starts_at, b.ends_at, b.status, m.name AS menu_name, s.display_name AS staff_name,
              bmu.meet_url
         FROM bookings b
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
         LEFT JOIN booking_meet_urls bmu ON bmu.booking_id = b.id
        WHERE b.friend_id = ? AND b.status IN ('requested','confirmed') AND b.ends_at > ?
        ORDER BY b.starts_at ASC
        LIMIT 1`,
    )
    .bind(booking.friend_id, nowIso)
    .first<Pick<BookingSnapshot, 'starts_at' | 'ends_at' | 'status' | 'menu_name' | 'staff_name' | 'meet_url'>>();
  const lastConfirmed = await db
    .prepare(
      `SELECT starts_at FROM bookings
        WHERE friend_id = ? AND status IN ('confirmed','completed','no_show')
        ORDER BY starts_at DESC LIMIT 1`,
    )
    .bind(booking.friend_id)
    .first<{ starts_at: string }>();

  // 別の有効な予約が残っているなら、その予約を見せる（終わった予約で上書きしない）。
  const rules = await loadBookingRules(db, booking.line_account_id);
  const picked = active ?? booking;
  // 「名前を出さない」設定なら、お客さん向けの差し込みにも出さない。
  const shown = {
    ...picked,
    menu_name: rules.showMenuName ? picked.menu_name : '',
    staff_name: rules.showStaffName ? picked.staff_name : '',
  };
  const statusLabel = active
    ? STATUS_LABELS[active.status] ?? active.status
    : event === 'ended' && booking.status === 'confirmed'
      ? '終了'
      : STATUS_LABELS[booking.status] ?? booking.status;
  const values = buildBookingMetadata({
    shown,
    statusLabel,
    hasActive: !!active,
    lastConfirmedStartsAt: lastConfirmed?.starts_at ?? null,
  });

  const row = await db
    .prepare(`SELECT metadata FROM friends WHERE id = ?`)
    .bind(booking.friend_id)
    .first<{ metadata: string | null }>();
  let current: Record<string, unknown> = {};
  try {
    current = row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
  } catch {
    current = {};
  }
  await db
    .prepare(`UPDATE friends SET metadata = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE id = ?`)
    .bind(JSON.stringify({ ...current, ...values }), booking.friend_id)
    .run();
}

// ----------------------------------------------------------------
// 2. リマインダー

/** 承認したとき、メニューに紐づくリマインダーへ登録する。過ぎたステップは送らない。 */
export async function enrollBookingReminders(db: D1Database, booking: BookingSnapshot, now: Date): Promise<number> {
  const links = await db
    .prepare(
      `SELECT bmr.reminder_id FROM booking_menu_reminders bmr
         INNER JOIN reminders r ON r.id = bmr.reminder_id
        WHERE bmr.menu_id = ? AND r.is_active = 1`,
    )
    .bind(booking.menu_id)
    .all<{ reminder_id: string }>();
  let enrolled = 0;
  for (const { reminder_id } of links.results) {
    const already = await db
      .prepare(
        `SELECT 1 AS ok FROM booking_friend_reminders bfr
           INNER JOIN friend_reminders fr ON fr.id = bfr.friend_reminder_id
          WHERE bfr.booking_id = ? AND fr.reminder_id = ? AND fr.status = 'active'`,
      )
      .bind(booking.id, reminder_id)
      .first<{ ok: number }>();
    if (already) continue;
    const fr = await enrollFriendInReminder(db, {
      friendId: booking.friend_id,
      reminderId: reminder_id,
      targetDate: booking.starts_at,
    });
    await db
      .prepare(`INSERT OR IGNORE INTO booking_friend_reminders (booking_id, friend_reminder_id) VALUES (?, ?)`)
      .bind(booking.id, fr.id)
      .run();
    // 承認が遅れて配信時刻を過ぎたステップは、送らずに「済み」にする（いきなり届かないように）。
    const steps = await db
      .prepare(`SELECT id, offset_minutes, offset_days, send_time FROM reminder_steps WHERE reminder_id = ?`)
      .bind(reminder_id)
      .all<{ id: string; offset_minutes: number; offset_days: number | null; send_time: string | null }>();
    for (const step of steps.results) {
      if (reminderStepDueAt(booking.starts_at, step) <= now.getTime()) {
        await db
          .prepare(`INSERT OR IGNORE INTO friend_reminder_deliveries (id, friend_reminder_id, reminder_step_id) VALUES (?, ?, ?)`)
          .bind(crypto.randomUUID(), fr.id, step.id)
          .run();
      }
    }
    enrolled++;
  }
  return enrolled;
}

/** キャンセル・却下・期限切れのとき、予約から登録したリマインダーを外す。 */
export async function cancelBookingReminders(db: D1Database, bookingId: string): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT fr.id FROM booking_friend_reminders bfr
         INNER JOIN friend_reminders fr ON fr.id = bfr.friend_reminder_id
        WHERE bfr.booking_id = ? AND fr.status = 'active'`,
    )
    .bind(bookingId)
    .all<{ id: string }>();
  for (const row of rows.results) {
    await cancelFriendReminder(db, row.id);
  }
  return rows.results.length;
}

// ----------------------------------------------------------------
// 4. 管理者通知

export interface AdminNotificationRow {
  id: string;
  line_account_id: string;
  event: BookingEvent;
  channel: 'chatwork' | 'webhook';
  target: string;
  message_template: string;
  minutes_after: number;
  is_active: number;
}

export interface BookingAutomationDeps {
  db: D1Database;
  /** チャットワークの API トークン（Worker のシークレット CHATWORK_API_TOKEN）。 */
  chatworkToken?: string;
  /** 管理画面の URL（{admin_url} に使う）。 */
  adminPublicUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** 通知文の差し込み。 */
export function renderAdminNotification(
  template: string,
  booking: Pick<BookingSnapshot, 'starts_at' | 'ends_at' | 'menu_name' | 'staff_name' | 'friend_name' | 'customer_note' | 'status'> & { meet_url?: string | null },
  event: BookingEvent,
  adminPublicUrl?: string,
): string {
  const start = formatJstParts(booking.starts_at);
  const end = formatJstParts(booking.ends_at);
  const adminUrl = adminPublicUrl ? `${adminPublicUrl.replace(/\/+$/, '')}/booking/bookings` : '';
  const values: Record<string, string> = {
    event: BOOKING_EVENT_LABELS[event],
    name: booking.friend_name ?? '',
    date: start.date,
    start: start.time,
    end: end.time,
    datetime: start.ymd,
    menu: booking.menu_name,
    staff: booking.staff_name,
    status: STATUS_LABELS[booking.status] ?? booking.status,
    note: booking.customer_note ?? '',
    admin_url: adminUrl,
    meet_url: booking.meet_url ?? '',
  };
  return template.replace(/\{(event|name|date|start|end|datetime|menu|staff|status|note|admin_url|meet_url)\}/g, (_m, key: string) => values[key] ?? '');
}

export async function sendAdminNotification(
  deps: BookingAutomationDeps,
  row: Pick<AdminNotificationRow, 'channel' | 'target'>,
  text: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  if (row.channel === 'chatwork') {
    if (!deps.chatworkToken) throw new Error('CHATWORK_API_TOKEN is not set');
    const res = await doFetch(`https://api.chatwork.com/v2/rooms/${encodeURIComponent(row.target)}/messages`, {
      method: 'POST',
      headers: {
        'X-ChatWorkToken': deps.chatworkToken,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      // self_unread=1: 自分の投稿でも未読にして気づけるようにする。
      body: new URLSearchParams({ body: text, self_unread: '1' }).toString(),
    });
    if (!res.ok) throw new Error(`chatwork ${res.status}`);
    return;
  }
  const res = await doFetch(row.target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, text }),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

async function notifyAdmins(
  deps: BookingAutomationDeps,
  booking: BookingSnapshot,
  event: BookingEvent,
  minutesAfter?: number,
): Promise<void> {
  const rows = await deps.db
    .prepare(
      `SELECT * FROM booking_admin_notifications
        WHERE line_account_id = ? AND event = ? AND is_active = 1`,
    )
    .bind(booking.line_account_id, event)
    .all<AdminNotificationRow>();
  for (const row of rows.results) {
    if (event === 'ended' && row.minutes_after !== minutesAfter) continue;
    const text = renderAdminNotification(row.message_template, booking, event, deps.adminPublicUrl);
    try {
      await sendAdminNotification(deps, row, text, {
        event: BOOKING_EVENT_TYPES[event],
        booking: bookingPayload(booking),
      });
    } catch (err) {
      console.error(`booking admin notification ${row.id} failed:`, err);
    }
  }
}

function bookingPayload(booking: BookingSnapshot): Record<string, unknown> {
  return {
    bookingId: booking.id,
    menuId: booking.menu_id,
    menuName: booking.menu_name,
    staffId: booking.staff_id,
    staffName: booking.staff_name,
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    status: booking.status,
    friendId: booking.friend_id,
    friendName: booking.friend_name,
    customerNote: booking.customer_note,
    meetUrl: booking.meet_url,
  };
}

// ----------------------------------------------------------------
// まとめ

/**
 * 予約のきっかけ1回分の処理。ended は minutesAfter（終了から何分後か）を渡す。
 * 友だち情報の記録とリマインダーは ended では動かさない（processBookingEnded が別に行う）。
 */
export async function handleBookingEvent(
  deps: BookingAutomationDeps,
  bookingId: string,
  event: BookingEvent,
  opts: { minutesAfter?: number } = {},
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const booking = await loadBookingSnapshot(deps.db, bookingId);
  if (!booking) return;

  if (event !== 'ended') {
    try {
      await syncBookingMetadata(deps.db, booking, event, now);
    } catch (err) {
      console.error('booking metadata sync failed:', err);
    }
    try {
      if (event === 'approved') await enrollBookingReminders(deps.db, booking, now);
      else if (event === 'rejected' || event === 'expired' || event === 'cancelled') {
        await cancelBookingReminders(deps.db, booking.id);
      }
    } catch (err) {
      console.error('booking reminder enroll/cancel failed:', err);
    }
  }

  const eventData: Record<string, unknown> = { ...bookingPayload(booking) };
  if (event === 'ended') eventData.minutesAfter = opts.minutesAfter ?? DEFAULT_ENDED_MINUTES_AFTER;
  const token = booking.channel_access_token ?? undefined;
  try {
    await fireEvent(deps.db, BOOKING_EVENT_TYPES[event], { friendId: booking.friend_id, eventData }, token, booking.line_account_id);
    // 管理画面の選択肢にある「カレンダー予約」は、承認と同じきっかけとして動かす。
    if (event === 'approved') {
      await fireEvent(deps.db, 'calendar_booked', { friendId: booking.friend_id, eventData }, token, booking.line_account_id);
    }
  } catch (err) {
    console.error('booking automation event failed:', err);
  }

  try {
    await notifyAdmins(deps, booking, event, event === 'ended' ? (opts.minutesAfter ?? DEFAULT_ENDED_MINUTES_AFTER) : undefined);
  } catch (err) {
    console.error('booking admin notifications failed:', err);
  }
}

/** 印を付ける。初めて付いたときだけ true（cron が重なっても1回だけ動かすため）。 */
async function claimMark(db: D1Database, bookingId: string, mark: string): Promise<boolean> {
  const res = await db
    .prepare(`INSERT OR IGNORE INTO booking_event_marks (booking_id, mark) VALUES (?, ?)`)
    .bind(bookingId, mark)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** 終了後の「何分後」の一覧（有効な自動ルールと管理者通知から集める）。 */
export async function collectEndedMinutes(db: D1Database): Promise<number[]> {
  const set = new Set<number>();
  const autos = await db
    .prepare(`SELECT conditions FROM automations WHERE event_type = 'booking_ended' AND is_active = 1`)
    .all<{ conditions: string }>();
  for (const a of autos.results) {
    let n = DEFAULT_ENDED_MINUTES_AFTER;
    try {
      const c = JSON.parse(a.conditions || '{}') as Record<string, unknown>;
      if (c.minutes_after !== undefined && Number.isFinite(Number(c.minutes_after))) n = Math.max(0, Math.trunc(Number(c.minutes_after)));
    } catch {
      // 壊れた条件は既定値
    }
    set.add(n);
  }
  const notes = await db
    .prepare(`SELECT DISTINCT minutes_after FROM booking_admin_notifications WHERE event = 'ended' AND is_active = 1`)
    .all<{ minutes_after: number }>();
  for (const n of notes.results) set.add(Math.max(0, Math.trunc(n.minutes_after)));
  return [...set].sort((a, b) => a - b);
}

/**
 * cron から呼ぶ。終了時刻を過ぎた予約について
 * - 友だち情報を「終了」にする（1回だけ）
 * - 「終了後 N 分」のきっかけを、N ごとに1回だけ動かす
 * 6時間より前に終わった予約は対象にしない（ルールを作った瞬間に昔の予約が動かないように）。
 */
export async function processBookingEnded(deps: BookingAutomationDeps): Promise<{ metadata: number; fired: number }> {
  const now = deps.now?.() ?? new Date();
  const nowMs = now.getTime();
  const minutesList = await collectEndedMinutes(deps.db);
  const maxMinutes = minutesList.length ? minutesList[minutesList.length - 1] : 0;
  const since = new Date(nowMs - ENDED_LOOKBACK_MS - maxMinutes * 60_000).toISOString();
  const rows = await deps.db
    .prepare(
      `SELECT id, ends_at FROM bookings
        WHERE status IN ('confirmed','completed') AND ends_at <= ? AND ends_at > ?
        ORDER BY ends_at ASC LIMIT 500`,
    )
    .bind(now.toISOString(), since)
    .all<{ id: string; ends_at: string }>();

  let metadata = 0;
  let fired = 0;
  for (const row of rows.results) {
    const endsMs = new Date(row.ends_at).getTime();
    try {
      if (endsMs > nowMs - ENDED_LOOKBACK_MS && (await claimMark(deps.db, row.id, 'ended:meta'))) {
        const booking = await loadBookingSnapshot(deps.db, row.id);
        if (booking) {
          await syncBookingMetadata(deps.db, booking, 'ended', now);
          metadata++;
        }
      }
      for (const n of minutesList) {
        const dueMs = endsMs + n * 60_000;
        if (dueMs > nowMs || dueMs <= nowMs - ENDED_LOOKBACK_MS) continue;
        if (!(await claimMark(deps.db, row.id, `ended:${n}`))) continue;
        await handleBookingEvent(deps, row.id, 'ended', { minutesAfter: n });
        fired++;
      }
    } catch (err) {
      console.error(`booking ended processing failed (${row.id}):`, err);
    }
  }
  return { metadata, fired };
}
