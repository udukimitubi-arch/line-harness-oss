// 予約の承認時に Google Meet を付ける（メニューごとの設定 booking_menu_options）。
// Meet の URL は booking_meet_urls に残し、承認の通知（{meet_url}）・友だち情報（予約URL）・
// 管理者通知（{meet_url}）で使う。設定が無いメニューは今までどおり Meet を付けない。

import { syncConfirmedBookingToGoogle } from './booking-calendar-sync.js';
import type { GoogleCalendarCredentials } from './google-oauth.js';

export async function menuAddsGoogleMeet(db: D1Database, menuId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT add_google_meet FROM booking_menu_options WHERE menu_id = ?`)
    .bind(menuId)
    .first<{ add_google_meet: number }>();
  return row?.add_google_meet === 1;
}

export async function getBookingMeetUrl(db: D1Database, bookingId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT meet_url FROM booking_meet_urls WHERE booking_id = ?`)
    .bind(bookingId)
    .first<{ meet_url: string }>();
  return row?.meet_url ?? null;
}

/**
 * 確定した予約を Google カレンダーに入れる。メニューの設定がオンなら Meet も付けて URL を残す。
 * 戻り値は syncConfirmedBookingToGoogle と同じ。
 */
export async function syncConfirmedBookingWithMeet(
  db: D1Database,
  credentials: GoogleCalendarCredentials,
  bookingId: string,
): Promise<Awaited<ReturnType<typeof syncConfirmedBookingToGoogle>>> {
  const booking = await db
    .prepare(`SELECT menu_id FROM bookings WHERE id = ?`)
    .bind(bookingId)
    .first<{ menu_id: string }>();
  const addGoogleMeet = booking ? await menuAddsGoogleMeet(db, booking.menu_id) : false;
  const synced = await syncConfirmedBookingToGoogle(db, credentials, bookingId, { addGoogleMeet });
  if (addGoogleMeet && synced.meetUrl) {
    await db
      .prepare(`INSERT OR REPLACE INTO booking_meet_urls (booking_id, meet_url) VALUES (?, ?)`)
      .bind(bookingId, synced.meetUrl)
      .run();
  }
  return synced;
}
