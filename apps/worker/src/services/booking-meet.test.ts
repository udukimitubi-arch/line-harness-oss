import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { sqliteD1 } from '../test-support/sqlite-d1.js';

const syncMock = vi.fn();
vi.mock('./booking-calendar-sync.js', () => ({ syncConfirmedBookingToGoogle: syncMock }));
const { getBookingMeetUrl, syncConfirmedBookingWithMeet } = await import('./booking-meet.js');
const { applyNotificationTemplate } = await import('./booking-notification-settings.js');

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

afterEach(() => {
  syncMock.mockReset();
});

function setup() {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(schema);
  sqlite.prepare('INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?,?,?,?)')
    .run('acc', 'channel-acc', 'acc', 'synthetic-token', 'synthetic-secret');
  sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES(?,?,?,?)')
    .run('friend-1', 'line-friend-1', 'acc', 'テスト太郎');
  sqlite.prepare('INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES(?,?,?,?,?)')
    .run('menu-1', 'acc', '無料診断', 60, 0);
  sqlite.prepare('INSERT INTO staff(id,line_account_id,name,display_name) VALUES(?,?,?,?)')
    .run('staff-1', 'acc', 'akimoto', '秋元');
  sqlite.prepare(
    `INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at)
     VALUES('b1','acc','friend-1','staff-1','menu-1','2026-10-27T01:00:00.000Z','2026-10-27T02:00:00.000Z','2026-10-27T02:00:00.000Z','confirmed',0,'2026-10-25T00:00:00.000Z')`,
  ).run();
  return { db, sqlite };
}

const creds = {} as never;

describe('syncConfirmedBookingWithMeet', () => {
  it('does not ask for Meet when the menu is not set', async () => {
    const { db } = setup();
    syncMock.mockResolvedValue({ synced: true, eventId: 'ev1', calendarId: 'cal' });
    await syncConfirmedBookingWithMeet(db, creds, 'b1');
    expect(syncMock).toHaveBeenCalledWith(db, creds, 'b1', { addGoogleMeet: false });
    expect(await getBookingMeetUrl(db, 'b1')).toBeNull();
  });

  it('asks for Meet and keeps the URL when the menu option is on', async () => {
    const { db, sqlite } = setup();
    sqlite.exec("INSERT INTO booking_menu_options(menu_id, add_google_meet) VALUES('menu-1', 1)");
    syncMock.mockResolvedValue({ synced: true, eventId: 'ev1', calendarId: 'cal', meetUrl: 'https://meet.google.com/abc-defg-hij' });
    await syncConfirmedBookingWithMeet(db, creds, 'b1');
    expect(syncMock).toHaveBeenCalledWith(db, creds, 'b1', { addGoogleMeet: true });
    expect(await getBookingMeetUrl(db, 'b1')).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('keeps nothing when Google did not return a Meet URL', async () => {
    const { db, sqlite } = setup();
    sqlite.exec("INSERT INTO booking_menu_options(menu_id, add_google_meet) VALUES('menu-1', 1)");
    syncMock.mockResolvedValue({ synced: false });
    await syncConfirmedBookingWithMeet(db, creds, 'b1');
    expect(await getBookingMeetUrl(db, 'b1')).toBeNull();
  });
});

describe('approved notification {meet_url}', () => {
  it('fills the Meet URL', () => {
    expect(
      applyNotificationTemplate('{datetime} {menu}\n{meet_url}', {
        menuName: '無料診断',
        staffName: '秋元',
        startsAtJst: '2026-10-27 10:00',
        hoursBefore: 0,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      }),
    ).toBe('2026-10-27 10:00 無料診断\nhttps://meet.google.com/abc-defg-hij');
  });
});
