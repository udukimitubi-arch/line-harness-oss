// Cron handler: expire request bookings left unanswered + purge idempotency rows.
// The wait is REQUEST_TTL_HOURS (24h) unless the account sets
// booking_request_ttl_hours (0 = wait until the booking's start time).

import type { BookingNotificationSender } from './booking-notifier.js';
import { purgeExpiredIdempotency } from './booking-idempotency.js';
import { REQUEST_TTL_HOURS } from './booking-types.js';
import { loadRequestTtlHours } from './booking-notification-settings.js';

interface StaleRow {
  id: string;
  starts_at: string;
  menu_name: string;
  staff_name: string;
  channel_access_token: string;
  line_user_id: string;
  line_account_id: string;
  requested_at: string;
}

const JST_OFFSET_MS = 9 * 3600_000;

function startsAtJst(utcIso: string): string {
  const jst = new Date(new Date(utcIso).getTime() + JST_OFFSET_MS).toISOString();
  return `${jst.slice(0, 10)} ${jst.slice(11, 16)}`;
}

export interface RunExpirerParams {
  now: Date;
  sender: BookingNotificationSender;
  /** 期限切れにした予約ごとに呼ぶ（予約のきっかけ。services/booking-automation.ts）。 */
  onExpired?: (bookingId: string) => Promise<void>;
}

export async function runExpirer(
  db: D1Database,
  params: RunExpirerParams,
): Promise<{ expired: number; idempotencyPurged: number }> {
  const cutoff = new Date(params.now.getTime() - REQUEST_TTL_HOURS * 3600_000).toISOString();
  const ttlByAccount = await loadRequestTtlHours(db);
  const select = `SELECT b.id, b.starts_at, b.requested_at, b.line_account_id,
              m.name AS menu_name,
              s.display_name AS staff_name,
              la.channel_access_token,
              f.line_user_id
         FROM bookings b
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
         INNER JOIN line_accounts la ON la.id = b.line_account_id
         INNER JOIN friends f ON f.id = b.friend_id
        WHERE b.status = 'requested'`;
  let candidates: StaleRow[];
  if (ttlByAccount.size === 0) {
    const res = await db
      .prepare(`${select}
          AND b.requested_at < ?
        LIMIT 200`)
      .bind(cutoff)
      .all<StaleRow>();
    candidates = res.results;
  } else {
    // Some account overrides the wait, so decide per row.
    const res = await db
      .prepare(`${select}
        ORDER BY b.requested_at
        LIMIT 500`)
      .all<StaleRow>();
    const nowMs = params.now.getTime();
    candidates = res.results
      .filter((row) => {
        const hours = ttlByAccount.get(row.line_account_id) ?? REQUEST_TTL_HOURS;
        if (hours === 0) return new Date(row.starts_at).getTime() <= nowMs;
        return new Date(row.requested_at).getTime() < nowMs - hours * 3600_000;
      })
      .slice(0, 200);
  }
  let expired = 0;
  for (const row of candidates) {
    // 条件付き UPDATE: cron 走行中に admin が同じ予約を承認/拒否した場合、
    // requested 行に対してのみ expired 化する。changes=0 なら後続処理（通知/reminders cancel）
    // をスキップして、誤通知を防ぐ。
    const upd = await db
      .prepare(`UPDATE bookings SET status='expired', decided_at = ? WHERE id = ? AND status = 'requested'`)
      .bind(params.now.toISOString(), row.id)
      .run();
    if ((upd.meta?.changes ?? 0) === 0) continue;
    await db
      .prepare(
        `UPDATE booking_reminders SET status='cancelled' WHERE booking_id = ? AND status IN ('pending','failed')`,
      )
      .bind(row.id)
      .run();
    try {
      await params.sender({
        channelAccessToken: row.channel_access_token,
        toLineUserId: row.line_user_id,
        kind: 'expired',
        ctx: {
          menuName: row.menu_name,
          staffName: row.staff_name,
          startsAtJst: startsAtJst(row.starts_at),
          hoursBefore: 0,
        },
        db,
        lineAccountId: row.line_account_id,
      });
    } catch {
      // 通知失敗は許容、expirer 自体は完了
    }
    if (params.onExpired) {
      try {
        await params.onExpired(row.id);
      } catch (err) {
        console.error('booking expired event failed:', err);
      }
    }
    expired++;
  }

  const idempotencyPurged = await purgeExpiredIdempotency(db, params.now);
  return { expired, idempotencyPurged };
}
