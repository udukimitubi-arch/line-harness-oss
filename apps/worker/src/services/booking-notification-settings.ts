// Per-account overrides for salon booking notifications, stored in the
// existing account_settings key/value table (no migration needed).
//
// - booking_notification_texts: JSON object keyed by NotificationKind.
//   A string replaces the built-in text ({menu} {staff} {datetime} {hours}
//   are filled in); an empty string stops that notification; a missing key
//   keeps the built-in text.
// - booking_request_ttl_hours: hours a request may wait for approval before
//   it expires. 0 = never expire by age; expire only once its start time has
//   passed. Missing = REQUEST_TTL_HOURS (24).

import type { NotificationContext, NotificationKind } from './booking-notifier.js';

export const NOTIFICATION_TEXTS_KEY = 'booking_notification_texts';
export const REQUEST_TTL_KEY = 'booking_request_ttl_hours';
export const MAX_REQUEST_TTL_HOURS = 24 * 30;

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'requested',
  'approved',
  'rejected',
  'expired',
  'day_before',
  'hours_before',
];

export type NotificationTexts = Partial<Record<NotificationKind, string>>;

function isKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

export function parseNotificationTexts(raw: string | null | undefined): NotificationTexts {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const texts: NotificationTexts = {};
  for (const [kind, text] of Object.entries(parsed)) {
    if (isKind(kind) && typeof text === 'string') texts[kind] = text;
  }
  return texts;
}

export function parseRequestTtlHours(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0 || hours > MAX_REQUEST_TTL_HOURS) return null;
  return hours;
}

export function applyNotificationTemplate(template: string, ctx: NotificationContext): string {
  return template
    .replaceAll('{menu}', ctx.menuName)
    .replaceAll('{staff}', ctx.staffName)
    .replaceAll('{datetime}', ctx.startsAtJst)
    .replaceAll('{hours}', String(ctx.hoursBefore));
}

export async function loadNotificationTexts(
  db: D1Database,
  lineAccountId: string,
): Promise<NotificationTexts> {
  const row = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`)
    .bind(lineAccountId, NOTIFICATION_TEXTS_KEY)
    .first<{ value: string }>();
  return parseNotificationTexts(row?.value);
}

export async function loadRequestTtlHours(db: D1Database): Promise<Map<string, number>> {
  const rows = await db
    .prepare(`SELECT line_account_id, value FROM account_settings WHERE key = ?`)
    .bind(REQUEST_TTL_KEY)
    .all<{ line_account_id: string; value: string }>();
  const ttl = new Map<string, number>();
  for (const row of rows.results ?? []) {
    const hours = parseRequestTtlHours(row.value);
    if (hours != null) ttl.set(row.line_account_id, hours);
  }
  return ttl;
}

/** Upsert a setting, or delete it when value is null (back to the default). */
export async function saveAccountSetting(
  db: D1Database,
  lineAccountId: string,
  key: string,
  value: string | null,
): Promise<void> {
  if (value === null) {
    await db
      .prepare(`DELETE FROM account_settings WHERE line_account_id = ? AND key = ?`)
      .bind(lineAccountId, key)
      .run();
    return;
  }
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
  await db
    .prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`,
    )
    .bind(crypto.randomUUID(), lineAccountId, key, value, now, now, value, now)
    .run();
}
