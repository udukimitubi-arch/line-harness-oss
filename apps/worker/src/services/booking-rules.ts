// 予約の決まりごと（アカウントごと）。account_settings の key='booking_rules' に JSON で持つ。
//
// - 表示: メニューを選ばせるか（選ばせないなら固定メニュー）、メニュー名・担当者名を出すか、
//         担当者を選ばせるか（選ばせないなら自動で割り振る）
// - 受付: 開始の何分前まで（既定60分）、前日の HH:MM まで、何日先まで、祝日は受け付けない
//
// 設定が無いアカウントは、今までと同じ動き（すべて選ばせる・すべて表示・60分前まで）。

import type { AvailabilityResult } from './availability.js';
import { DEFAULT_ACCOUNT_SETTINGS } from './booking-types.js';
import { saveAccountSetting } from './booking-notification-settings.js';
import { isJapaneseHoliday } from './jp-holidays.js';

export const BOOKING_RULES_KEY = 'booking_rules';

export interface BookingRules {
  /** false: メニューを選ばせず fixedMenuId に固定する */
  menuSelect: boolean;
  fixedMenuId: string | null;
  showMenuName: boolean;
  /** false: 担当者を選ばせず、自動で割り振る */
  staffSelect: boolean;
  showStaffName: boolean;
  /** 開始の何分前まで受け付けるか */
  minLeadMinutes: number;
  /** 'HH:MM': 予約日の前日の、この時刻（日本時間）まで受け付ける */
  cutoffPrevDayTime: string | null;
  /** 今日から何日先まで受け付けるか（0 = 今日だけ） */
  maxDaysAhead: number | null;
  closedOnHolidays: boolean;
}

export const DEFAULT_BOOKING_RULES: BookingRules = {
  menuSelect: true,
  fixedMenuId: null,
  showMenuName: true,
  staffSelect: true,
  showStaffName: true,
  minLeadMinutes: DEFAULT_ACCOUNT_SETTINGS.min_lead_time_minutes,
  cutoffPrevDayTime: null,
  maxDaysAhead: null,
  closedOnHolidays: false,
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 保存してある JSON を読む。壊れた項目は既定値にする。 */
export function parseBookingRules(raw: string | null | undefined): BookingRules {
  let obj: Record<string, unknown> = {};
  try {
    obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    obj = {};
  }
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const int = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
  return {
    menuSelect: bool(obj.menuSelect, true),
    fixedMenuId: typeof obj.fixedMenuId === 'string' && obj.fixedMenuId ? obj.fixedMenuId : null,
    showMenuName: bool(obj.showMenuName, true),
    staffSelect: bool(obj.staffSelect, true),
    showStaffName: bool(obj.showStaffName, true),
    minLeadMinutes: int(obj.minLeadMinutes, 0, 60 * 24 * 30) ?? DEFAULT_BOOKING_RULES.minLeadMinutes,
    cutoffPrevDayTime: typeof obj.cutoffPrevDayTime === 'string' && HHMM.test(obj.cutoffPrevDayTime) ? obj.cutoffPrevDayTime : null,
    maxDaysAhead: int(obj.maxDaysAhead, 0, 365),
    closedOnHolidays: bool(obj.closedOnHolidays, false),
  };
}

/** 入力の確認（API 用）。問題があればエラーの文、無ければ null。 */
export function validateBookingRulesInput(input: Record<string, unknown>): string | null {
  for (const k of ['menuSelect', 'showMenuName', 'staffSelect', 'showStaffName', 'closedOnHolidays']) {
    if (input[k] !== undefined && typeof input[k] !== 'boolean') return `${k} must be a boolean`;
  }
  if (input.fixedMenuId !== undefined && input.fixedMenuId !== null && typeof input.fixedMenuId !== 'string') {
    return 'fixedMenuId must be a string or null';
  }
  if (input.minLeadMinutes !== undefined && input.minLeadMinutes !== null
    && !(typeof input.minLeadMinutes === 'number' && Number.isInteger(input.minLeadMinutes) && input.minLeadMinutes >= 0 && input.minLeadMinutes <= 43200)) {
    return 'minLeadMinutes must be an integer between 0 and 43200';
  }
  if (input.cutoffPrevDayTime !== undefined && input.cutoffPrevDayTime !== null
    && !(typeof input.cutoffPrevDayTime === 'string' && HHMM.test(input.cutoffPrevDayTime))) {
    return 'cutoffPrevDayTime must be HH:MM or null';
  }
  if (input.maxDaysAhead !== undefined && input.maxDaysAhead !== null
    && !(typeof input.maxDaysAhead === 'number' && Number.isInteger(input.maxDaysAhead) && input.maxDaysAhead >= 0 && input.maxDaysAhead <= 365)) {
    return 'maxDaysAhead must be an integer between 0 and 365 or null';
  }
  if (input.menuSelect === false && !input.fixedMenuId) return 'fixedMenuId is required when menuSelect is false';
  return null;
}

export async function loadBookingRules(db: D1Database, lineAccountId: string): Promise<BookingRules> {
  const row = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`)
    .bind(lineAccountId, BOOKING_RULES_KEY)
    .first<{ value: string }>();
  return parseBookingRules(row?.value);
}

export async function saveBookingRules(db: D1Database, lineAccountId: string, rules: BookingRules): Promise<void> {
  await saveAccountSetting(db, lineAccountId, BOOKING_RULES_KEY, JSON.stringify(rules));
}

const JST_MS = 9 * 3600_000;

function jstDate(d: Date): string {
  return new Date(d.getTime() + JST_MS).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400_000).toISOString().slice(0, 10);
}

/** その日付の枠を、今の時点で受け付けてよいか（前日締切・何日先まで）。祝日は別に見る。 */
export function dateIsOpen(rules: BookingRules, date: string, now: Date): boolean {
  if (rules.maxDaysAhead !== null && date > addDays(jstDate(now), rules.maxDaysAhead)) return false;
  if (rules.cutoffPrevDayTime) {
    const [hh, mm] = rules.cutoffPrevDayTime.split(':').map(Number);
    const cutoffMs = new Date(`${addDays(date, -1)}T00:00:00Z`).getTime() - JST_MS + (hh * 60 + mm) * 60_000;
    if (now.getTime() >= cutoffMs) return false;
  }
  return true;
}

/**
 * 空き枠に、受付の決まり（前日締切・何日先まで・祝日）を当てる。
 * 祝日は、その担当者がその日にシフト（staff_shifts）を入れていれば開ける。
 */
export async function applyBookingRules(
  db: D1Database,
  result: AvailabilityResult,
  rules: BookingRules,
  now: Date,
): Promise<AvailabilityResult> {
  if (!rules.cutoffPrevDayTime && rules.maxDaysAhead === null && !rules.closedOnHolidays) return result;
  const shiftDays = new Map<string, Set<string>>();
  if (rules.closedOnHolidays) {
    for (const s of result.by_staff) {
      const dates = [...new Set(s.slots.map((x) => x.date))].filter(isJapaneseHoliday);
      if (dates.length === 0) continue;
      const rows = await db
        .prepare(
          `SELECT work_date AS date FROM staff_shifts WHERE staff_id = ? AND work_date IN (${dates.map(() => '?').join(',')})`,
        )
        .bind(s.staff_id, ...dates)
        .all<{ date: string }>();
      shiftDays.set(s.staff_id, new Set(rows.results.map((r) => r.date)));
    }
  }
  return {
    ...result,
    by_staff: result.by_staff.map((s) => ({
      ...s,
      slots: s.slots.filter((slot) => {
        if (!dateIsOpen(rules, slot.date, now)) return false;
        if (rules.closedOnHolidays && isJapaneseHoliday(slot.date) && !shiftDays.get(s.staff_id)?.has(slot.date)) {
          return false;
        }
        return true;
      }),
    })),
  };
}

/** 担当者を選ばせないときの割り振りの順番（優先度が大きい順 → 並び順）。 */
export async function autoAssignCandidates(db: D1Database, lineAccountId: string, menuId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT s.id FROM staff s
         INNER JOIN staff_menus sm ON sm.staff_id = s.id AND sm.menu_id = ? AND sm.is_offered = 1
         LEFT JOIN booking_staff_priority p ON p.staff_id = s.id
        WHERE s.line_account_id = ? AND s.is_active = 1 AND s.deleted_at IS NULL
        ORDER BY COALESCE(p.priority, 0) DESC, s.sort_order ASC, s.id ASC`,
    )
    .bind(menuId, lineAccountId)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

/** 1人あたりの上限に達しているか（申し込み中と確定で、まだ終わっていない予約を数える）。 */
export async function friendReachedMenuLimit(
  db: D1Database,
  friendId: string,
  menuId: string,
  now: Date,
): Promise<boolean> {
  const opt = await db
    .prepare(`SELECT max_active_per_friend FROM booking_menu_options WHERE menu_id = ?`)
    .bind(menuId)
    .first<{ max_active_per_friend: number | null }>();
  const max = opt?.max_active_per_friend;
  if (max === null || max === undefined) return false;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bookings
        WHERE friend_id = ? AND menu_id = ? AND status IN ('requested','confirmed') AND ends_at > ?`,
    )
    .bind(friendId, menuId, now.toISOString())
    .first<{ n: number }>();
  return (row?.n ?? 0) >= max;
}
