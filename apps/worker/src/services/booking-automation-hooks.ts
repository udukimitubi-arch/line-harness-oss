// routes/booking.ts から予約のきっかけを呼ぶための薄い入口。
// 予約の応答を待たせないよう waitUntil で後ろに回し、失敗は握りつぶす。
import type { Context } from 'hono';
import type { Env } from '../index.js';
import { handleBookingEvent, type BookingAutomationDeps, type BookingEvent } from './booking-automation.js';

export function bookingAutomationDeps(env: Env['Bindings']): BookingAutomationDeps {
  return {
    db: env.DB,
    chatworkToken: env.CHATWORK_API_TOKEN,
    adminPublicUrl: env.ADMIN_PUBLIC_URL,
  };
}

export function queueBookingEvent(c: Context<Env>, bookingId: string, event: BookingEvent): void {
  c.executionCtx.waitUntil(
    handleBookingEvent(bookingAutomationDeps(c.env), bookingId, event).catch((err) =>
      console.error(`booking event (${event}) failed:`, err),
    ),
  );
}
