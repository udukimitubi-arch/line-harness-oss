import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { isJapaneseHoliday, japaneseHolidays } from './jp-holidays.js';
import {
  applyBookingRules,
  autoAssignCandidates,
  dateIsOpen,
  DEFAULT_BOOKING_RULES,
  friendReachedMenuLimit,
  parseBookingRules,
  validateBookingRulesInput,
} from './booking-rules.js';
import booking from '../routes/booking.js';

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('japanese holidays', () => {
  it('knows the 2026 holidays, including substitute and sandwiched days', () => {
    const days = [...japaneseHolidays(2026)].sort();
    expect(days).toEqual([
      '2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29',
      '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11',
      '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23',
    ]);
  });
  it('answers single dates', () => {
    expect(isJapaneseHoliday('2027-03-21')).toBe(true); // 春分の日（日曜）
    expect(isJapaneseHoliday('2027-03-22')).toBe(true); // 振替休日
    expect(isJapaneseHoliday('2026-10-27')).toBe(false);
  });
});

describe('booking rules', () => {
  it('falls back to the current behavior when nothing is saved', () => {
    expect(parseBookingRules(null)).toEqual(DEFAULT_BOOKING_RULES);
    expect(parseBookingRules('{broken')).toEqual(DEFAULT_BOOKING_RULES);
  });

  it('validates input', () => {
    expect(validateBookingRulesInput({ cutoffPrevDayTime: '25:00' })).toMatch(/cutoffPrevDayTime/);
    expect(validateBookingRulesInput({ menuSelect: false })).toMatch(/fixedMenuId/);
    expect(validateBookingRulesInput({ menuSelect: false, fixedMenuId: 'm1', maxDaysAhead: 30 })).toBeNull();
  });

  it('closes a date after the previous-day cutoff and beyond the window', () => {
    const rules = { ...DEFAULT_BOOKING_RULES, cutoffPrevDayTime: '18:00', maxDaysAhead: 7 };
    // 10/26 17:59 JST: 10/27 はまだ受け付ける。18:00 を過ぎたら閉める
    expect(dateIsOpen(rules, '2026-10-27', new Date('2026-10-26T08:59:00Z'))).toBe(true);
    expect(dateIsOpen(rules, '2026-10-27', new Date('2026-10-26T09:00:00Z'))).toBe(false);
    // 7日先まで
    expect(dateIsOpen(rules, '2026-11-02', new Date('2026-10-26T00:00:00Z'))).toBe(true);
    expect(dateIsOpen(rules, '2026-11-03', new Date('2026-10-26T00:00:00Z'))).toBe(false);
  });

  it('removes holiday slots unless the staff has a shift that day', async () => {
    const { db, sqlite } = sqliteD1();
    sqlite.exec(schema);
    sqlite.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('acc','c','acc','t','s')");
    sqlite.exec("INSERT INTO staff(id,line_account_id,name,display_name) VALUES('s2','acc','s2','B')");
    sqlite.exec("INSERT INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES('sh1','s2','2026-11-03','10:00','12:00')");
    const result = {
      by_staff: [
        { staff_id: 's1', display_name: 'A', slots: [{ date: '2026-11-03', start: '10:00', end: '11:00' }, { date: '2026-11-04', start: '10:00', end: '11:00' }] },
        { staff_id: 's2', display_name: 'B', slots: [{ date: '2026-11-03', start: '10:00', end: '11:00' }] },
      ],
      calendar_sync: [],
    };
    const out = await applyBookingRules(db, result as never, { ...DEFAULT_BOOKING_RULES, closedOnHolidays: true }, new Date('2026-10-26T00:00:00Z'));
    expect(out.by_staff[0].slots.map((s) => s.date)).toEqual(['2026-11-04']);
    expect(out.by_staff[1].slots.map((s) => s.date)).toEqual(['2026-11-03']);
  });
});

// ---------------------------------------------------------------
// LIFF の予約（担当者おまかせ・上限）

const LIFF = '1234567890-abcdefgh';
const MENU = 'menu-1';
const JST = 9 * 3600_000;

/** 1週間以上先の、祝日でない日の 10:00 JST（UTC ISO と 'YYYY-MM-DD'）。 */
function futureSlot(): { iso: string; date: string } {
  let t = Date.now() + 8 * 86400_000;
  for (;;) {
    const date = new Date(t + JST).toISOString().slice(0, 10);
    if (!isJapaneseHoliday(date)) return { iso: new Date(`${date}T01:00:00.000Z`).toISOString(), date };
    t += 86400_000;
  }
}

function setupLiff(rules: Record<string, unknown>) {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(schema);
  sqlite.prepare('INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,liff_id) VALUES(?,?,?,?,?,?)')
    .run('acc', '1234567890', 'acc', 'synthetic-token', 'synthetic-secret', LIFF);
  for (const f of ['f1', 'f2', 'f3']) {
    sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name,is_following) VALUES(?,?,?,?,1)')
      .run(f, `U-${f}`, 'acc', f);
  }
  sqlite.prepare('INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES(?,?,?,?,?)')
    .run(MENU, 'acc', '無料診断', 60, 0);
  for (const [id, prio] of [['s1', 0], ['s2', 10]] as const) {
    sqlite.prepare('INSERT INTO staff(id,line_account_id,name,display_name) VALUES(?,?,?,?)').run(id, 'acc', id, id);
    sqlite.prepare('INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES(?,?,1)').run(id, MENU);
    for (let wd = 0; wd < 7; wd++) {
      sqlite.prepare('INSERT INTO staff_availability_rules(id,staff_id,weekday,start_time,end_time) VALUES(?,?,?,?,?)')
        .run(`${id}-${wd}`, id, wd, '09:00', '17:00');
    }
    sqlite.prepare('INSERT INTO booking_staff_priority(staff_id, priority) VALUES(?,?)').run(id, prio);
  }
  sqlite.prepare(`INSERT INTO account_settings(id,line_account_id,key,value) VALUES('r','acc','booking_rules',?)`)
    .run(JSON.stringify(rules));
  // id_token の検証（LINE）は、Bearer の値をそのまま userId として返す偽物にする
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    return new Response(JSON.stringify({ sub: body.get('id_token') }), { status: 200 });
  });
  vi.spyOn(LineClient.prototype, 'request').mockResolvedValue({ data: {}, headers: new Headers() });
  const app = new Hono();
  app.route('/', booking);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };
  const request = (lineUserId: string, body: Record<string, unknown>) =>
    app.request(`/api/liff/booking/requests?liffId=${LIFF}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${lineUserId}`,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    }, { DB: db }, ctx as never);
  return { db, sqlite, app, request };
}

describe('LIFF booking with automatic staff', () => {
  it('assigns the highest-priority free staff, then the next one, then refuses', async () => {
    const t = setupLiff({ staffSelect: false });
    const slot = futureSlot();
    let res = await t.request('U-f1', { menu_id: MENU, starts_at: slot.iso });
    expect(res.status).toBe(201);
    res = await t.request('U-f2', { menu_id: MENU, starts_at: slot.iso });
    expect(res.status).toBe(201);
    const rows = t.sqlite.prepare('SELECT friend_id, staff_id FROM bookings ORDER BY friend_id').all();
    expect(rows).toEqual([{ friend_id: 'f1', staff_id: 's2' }, { friend_id: 'f2', staff_id: 's1' }]);
    res = await t.request('U-f3', { menu_id: MENU, starts_at: slot.iso });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'slot_not_available' });
  });

  it('still requires a staff when customers choose the staff', async () => {
    const t = setupLiff({});
    const res = await t.request('U-f1', { menu_id: MENU, starts_at: futureSlot().iso });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'no_staff_available' });
  });

  it('refuses when the friend reached the menu limit', async () => {
    const t = setupLiff({});
    t.sqlite.exec(`INSERT INTO booking_menu_options(menu_id, add_google_meet, max_active_per_friend) VALUES('${MENU}', 0, 1)`);
    const slot = futureSlot();
    let res = await t.request('U-f1', { menu_id: MENU, staff_id: 's1', starts_at: slot.iso });
    expect(res.status).toBe(201);
    const later = new Date(new Date(slot.iso).getTime() + 2 * 3600_000).toISOString();
    res = await t.request('U-f1', { menu_id: MENU, staff_id: 's1', starts_at: later });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'limit_reached' });
    expect(await friendReachedMenuLimit(t.db, 'f2', MENU, new Date())).toBe(false);
  });

  it('orders candidates by priority', async () => {
    const t = setupLiff({});
    expect(await autoAssignCandidates(t.db, 'acc', MENU)).toEqual(['s2', 's1']);
  });

  it('serves the display settings to the booking page', async () => {
    const t = setupLiff({ staffSelect: false, showStaffName: false });
    const res = await t.app.request(`/api/liff/booking/settings?liffId=${LIFF}`, {}, { DB: t.db });
    expect(await res.json()).toEqual({
      menu_select: true,
      fixed_menu_id: null,
      show_menu_name: true,
      staff_select: false,
      show_staff_name: false,
    });
  });
});
