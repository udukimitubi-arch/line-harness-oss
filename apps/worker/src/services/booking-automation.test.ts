import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { LineClient } from '@line-crm/line-sdk';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import {
  buildBookingMetadata,
  formatJstParts,
  handleBookingEvent,
  processBookingEnded,
  renderAdminNotification,
} from './booking-automation.js';

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

afterEach(() => {
  vi.restoreAllMocks();
});

// 2026-10-27(火) 10:00〜11:00 JST
const STARTS = '2026-10-27T01:00:00.000Z';
const ENDS = '2026-10-27T02:00:00.000Z';

function setup() {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(schema);
  const lineRequests: Array<{ path: string; body: unknown }> = [];
  vi.spyOn(LineClient.prototype, 'request').mockImplementation(async function (_method, path, body) {
    lineRequests.push({ path, body });
    return { data: {}, headers: new Headers() };
  });
  sqlite.prepare('INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?,?,?,?)')
    .run('acc', 'channel-acc', 'acc', 'synthetic-token', 'synthetic-secret');
  sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES(?,?,?,?)')
    .run('friend-1', 'line-friend-1', 'acc', 'テスト太郎');
  sqlite.prepare('INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES(?,?,?,?,?)')
    .run('menu-1', 'acc', '無料診断', 60, 0);
  sqlite.prepare('INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES(?,?,?,?,?)')
    .run('menu-2', 'acc', '別メニュー', 60, 0);
  sqlite.prepare('INSERT INTO staff(id,line_account_id,name,display_name) VALUES(?,?,?,?)')
    .run('staff-1', 'acc', 'akimoto', '秋元');
  sqlite.exec("INSERT INTO tags(id,name) VALUES('tag-approved','承認済み'),('tag-ended','終了'),('tag-other','別メニュー')");

  function booking(id: string, status: string, startsAt = STARTS, endsAt = ENDS, menuId = 'menu-1') {
    sqlite.prepare(
      `INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,customer_note,price_at_booking,requested_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, 'acc', 'friend-1', 'staff-1', menuId, startsAt, endsAt, endsAt, status, 'よろしくお願いします', 0, '2026-10-25T00:00:00.000Z');
  }
  function automation(id: string, eventType: string, conditions: object, actions: object[]) {
    sqlite.prepare('INSERT INTO automations(id,name,event_type,line_account_id,conditions,actions) VALUES(?,?,?,?,?,?)')
      .run(id, id, eventType, 'acc', JSON.stringify(conditions), JSON.stringify(actions));
  }
  function friendTags(): string[] {
    return (sqlite.prepare("SELECT tag_id FROM friend_tags WHERE friend_id='friend-1' ORDER BY tag_id").all() as Array<{ tag_id: string }>)
      .map((r) => r.tag_id);
  }
  function metadata(): Record<string, string> {
    const row = sqlite.prepare("SELECT metadata FROM friends WHERE id='friend-1'").get() as { metadata: string };
    return JSON.parse(row.metadata);
  }
  return { db, sqlite, lineRequests, booking, automation, friendTags, metadata };
}

describe('formatJstParts', () => {
  it('formats in JST', () => {
    expect(formatJstParts(STARTS)).toEqual({ date: '10月27日(火)', time: '10:00', ymd: '2026-10-27 10:00' });
  });
});

describe('buildBookingMetadata', () => {
  it('writes the Japanese keys', () => {
    expect(
      buildBookingMetadata({
        shown: { starts_at: STARTS, ends_at: ENDS, menu_name: '無料診断', staff_name: '秋元', status: 'confirmed', meet_url: 'https://meet.google.com/abc-defg-hij' },
        statusLabel: '確定',
        hasActive: true,
        lastConfirmedStartsAt: STARTS,
      }),
    ).toEqual({
      予約日: '10月27日(火)',
      予約開始時刻: '10:00',
      予約終了時刻: '11:00',
      予約メニュー: '無料診断',
      予約担当者: '秋元',
      予約状態: '確定',
      予約の有無: 'あり',
      予約URL: 'https://meet.google.com/abc-defg-hij',
      最終予約日: '10月27日(火)',
    });
  });
});

describe('renderAdminNotification', () => {
  it('fills placeholders', () => {
    const text = renderAdminNotification(
      '【{event}】{name}様 {date} {start}〜{end} {menu}/{staff} {status} メモ:{note} {admin_url} {meet_url}',
      { starts_at: STARTS, ends_at: ENDS, menu_name: '無料診断', staff_name: '秋元', friend_name: 'テスト太郎', customer_note: 'よろしく', status: 'requested', meet_url: 'https://meet.google.com/x' },
      'requested',
      'https://admin.example/',
    );
    expect(text).toBe('【申し込み】テスト太郎様 10月27日(火) 10:00〜11:00 無料診断/秋元 申し込み中 メモ:よろしく https://admin.example/booking/bookings https://meet.google.com/x');
  });
});

describe('handleBookingEvent', () => {
  it('requested: records metadata, runs matching rules, notifies Chatwork', async () => {
    const t = setup();
    t.booking('b1', 'requested');
    t.automation('auto-menu', 'booking_requested', { menu_id: 'menu-1' }, [{ type: 'add_tag', params: { tagId: 'tag-approved' } }]);
    t.automation('auto-other', 'booking_requested', { menu_id: 'menu-2' }, [{ type: 'add_tag', params: { tagId: 'tag-other' } }]);
    t.sqlite.prepare(
      `INSERT INTO booking_admin_notifications(id,line_account_id,event,channel,target,message_template) VALUES(?,?,?,?,?,?)`,
    ).run('n1', 'acc', 'requested', 'chatwork', '436942990', '{name}様 {date} {start}');
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    await handleBookingEvent(
      { db: t.db, chatworkToken: 'synthetic-cw', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => new Date('2026-10-25T03:00:00Z') },
      'b1',
      'requested',
    );

    expect(t.metadata()).toMatchObject({ 予約日: '10月27日(火)', 予約状態: '申し込み中', 予約の有無: 'あり', 予約メニュー: '無料診断' });
    expect(t.friendTags()).toEqual(['tag-approved']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.chatwork.com/v2/rooms/436942990/messages');
    expect((init.headers as Record<string, string>)['X-ChatWorkToken']).toBe('synthetic-cw');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('self_unread')).toBe('1');
    expect(body.get('body')).toBe('テスト太郎様 10月27日(火) 10:00');
  });

  it('approved: enrolls menu reminders, skips past steps, fires calendar_booked too', async () => {
    const t = setup();
    t.booking('b1', 'confirmed');
    t.sqlite.exec("INSERT INTO reminders(id,name,line_account_id) VALUES('rem-1','予約リマインド','acc')");
    // 前日 18:00 JST（= 10/26 09:00Z）と 1時間前（= 10/27 00:00Z）
    t.sqlite.exec(`INSERT INTO reminder_steps(id,reminder_id,offset_minutes,offset_days,send_time,message_type,message_content)
      VALUES('step-day','rem-1',-1440,1,'18:00','text','明日 {{metadata.予約開始時刻}} です'),
            ('step-hour','rem-1',-60,NULL,NULL,'text','1時間前です')`);
    t.sqlite.exec("INSERT INTO booking_menu_reminders(menu_id,reminder_id) VALUES('menu-1','rem-1')");
    t.automation('auto-cal', 'calendar_booked', {}, [{ type: 'add_tag', params: { tagId: 'tag-approved' } }]);

    // 承認が前日 20:00 JST（10/26 11:00Z）と遅れた → 前日 18:00 のステップは送らない扱い
    await handleBookingEvent({ db: t.db, now: () => new Date('2026-10-26T11:00:00Z') }, 'b1', 'approved');

    const fr = t.sqlite.prepare("SELECT id, target_date, status FROM friend_reminders WHERE friend_id='friend-1'").all() as Array<{ id: string; target_date: string; status: string }>;
    expect(fr).toHaveLength(1);
    expect(fr[0]).toMatchObject({ target_date: STARTS, status: 'active' });
    const delivered = t.sqlite.prepare('SELECT reminder_step_id FROM friend_reminder_deliveries WHERE friend_reminder_id = ?').all(fr[0].id) as Array<{ reminder_step_id: string }>;
    expect(delivered.map((d) => d.reminder_step_id)).toEqual(['step-day']);
    expect(t.friendTags()).toEqual(['tag-approved']);
    expect(t.metadata()).toMatchObject({ 予約状態: '確定', 最終予約日: '10月27日(火)' });

    // 2回承認しても二重に登録しない
    await handleBookingEvent({ db: t.db, now: () => new Date('2026-10-26T11:00:00Z') }, 'b1', 'approved');
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM friend_reminders").get()).toEqual({ n: 1 });
  });

  it('cancelled: removes the reminder enrolled for the booking', async () => {
    const t = setup();
    t.booking('b1', 'confirmed');
    t.sqlite.exec("INSERT INTO reminders(id,name,line_account_id) VALUES('rem-1','予約リマインド','acc')");
    t.sqlite.exec("INSERT INTO reminder_steps(id,reminder_id,offset_minutes,message_type,message_content) VALUES('step-hour','rem-1',-60,'text','1時間前です')");
    t.sqlite.exec("INSERT INTO booking_menu_reminders(menu_id,reminder_id) VALUES('menu-1','rem-1')");
    await handleBookingEvent({ db: t.db, now: () => new Date('2026-10-25T03:00:00Z') }, 'b1', 'approved');

    t.sqlite.exec("UPDATE bookings SET status='cancelled' WHERE id='b1'");
    await handleBookingEvent({ db: t.db, now: () => new Date('2026-10-25T04:00:00Z') }, 'b1', 'cancelled');

    expect(t.sqlite.prepare("SELECT status FROM friend_reminders").get()).toEqual({ status: 'cancelled' });
    expect(t.metadata()).toMatchObject({ 予約状態: 'キャンセル', 予約の有無: 'なし' });
  });

  it('does nothing extra when nothing is configured', async () => {
    const t = setup();
    t.booking('b1', 'requested');
    const fetchImpl = vi.fn();
    await handleBookingEvent({ db: t.db, fetchImpl: fetchImpl as unknown as typeof fetch }, 'b1', 'requested');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(t.lineRequests).toHaveLength(0);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM friend_reminders').get()).toEqual({ n: 0 });
  });
});

describe('attended / no_show', () => {
  it('records 来た and fires booking_attended; ended later keeps 来た', async () => {
    const t = setup();
    t.booking('b1', 'completed');
    t.automation('auto-att', 'booking_attended', {}, [{ type: 'add_tag', params: { tagId: 'tag-ended' } }]);
    await handleBookingEvent({ db: t.db, now: () => new Date('2026-10-27T02:00:00Z') }, 'b1', 'attended');
    expect(t.metadata()).toMatchObject({ 予約状態: '来た' });
    expect(t.friendTags()).toEqual(['tag-ended']);
    await processBookingEnded({ db: t.db, now: () => new Date('2026-10-27T02:10:00Z') });
    expect(t.metadata()).toMatchObject({ 予約状態: '来た' });
  });

  it('records 来なかった', async () => {
    const t = setup();
    t.booking('b1', 'no_show');
    await handleBookingEvent({ db: t.db, now: () => new Date('2026-10-27T02:00:00Z') }, 'b1', 'no_show');
    expect(t.metadata()).toMatchObject({ 予約状態: '来なかった' });
  });

  it('hides names from customer-facing metadata when the account says so', async () => {
    const t = setup();
    t.booking('b1', 'requested');
    t.sqlite.exec(`INSERT INTO account_settings(id,line_account_id,key,value) VALUES('r','acc','booking_rules','{"showStaffName":false}')`);
    await handleBookingEvent({ db: t.db, now: () => new Date('2026-10-25T03:00:00Z') }, 'b1', 'requested');
    expect(t.metadata()).toMatchObject({ 予約担当者: '', 予約メニュー: '無料診断' });
  });
});

describe('processBookingEnded', () => {
  it('marks the booking ended and fires "N minutes after" rules once', async () => {
    const t = setup();
    t.booking('b1', 'confirmed');
    t.automation('auto-30', 'booking_ended', {}, [{ type: 'add_tag', params: { tagId: 'tag-ended' } }]);
    t.automation('auto-120', 'booking_ended', { minutes_after: 120 }, [{ type: 'add_tag', params: { tagId: 'tag-other' } }]);

    // 終了の 10 分後: 予約状態は「終了」、30分後のルールはまだ
    let r = await processBookingEnded({ db: t.db, now: () => new Date('2026-10-27T02:10:00Z') });
    expect(r).toEqual({ metadata: 1, fired: 0 });
    expect(t.metadata()).toMatchObject({ 予約状態: '終了', 予約の有無: 'なし' });
    expect(t.friendTags()).toEqual([]);

    // 終了の 35 分後: 30分後のルールだけ動く
    r = await processBookingEnded({ db: t.db, now: () => new Date('2026-10-27T02:35:00Z') });
    expect(r).toEqual({ metadata: 0, fired: 1 });
    expect(t.friendTags()).toEqual(['tag-ended']);

    // もう一度回しても二重に動かない
    r = await processBookingEnded({ db: t.db, now: () => new Date('2026-10-27T02:40:00Z') });
    expect(r).toEqual({ metadata: 0, fired: 0 });

    // 2時間後: 120分のルールが動く
    r = await processBookingEnded({ db: t.db, now: () => new Date('2026-10-27T04:05:00Z') });
    expect(r).toEqual({ metadata: 0, fired: 1 });
    expect(t.friendTags()).toEqual(['tag-ended', 'tag-other']);
  });

  it('ignores bookings that ended long ago', async () => {
    const t = setup();
    t.booking('old', 'confirmed', '2026-10-20T01:00:00.000Z', '2026-10-20T02:00:00.000Z');
    t.automation('auto-30', 'booking_ended', {}, [{ type: 'add_tag', params: { tagId: 'tag-ended' } }]);
    const r = await processBookingEnded({ db: t.db, now: () => new Date('2026-10-27T02:35:00Z') });
    expect(r).toEqual({ metadata: 0, fired: 0 });
    expect(t.friendTags()).toEqual([]);
  });

  it('keeps showing a later active booking when an earlier one ends', async () => {
    const t = setup();
    t.booking('b1', 'confirmed');
    t.booking('b2', 'confirmed', '2026-11-03T01:00:00.000Z', '2026-11-03T02:00:00.000Z');
    await processBookingEnded({ db: t.db, now: () => new Date('2026-10-27T02:10:00Z') });
    expect(t.metadata()).toMatchObject({ 予約日: '11月3日(火)', 予約状態: '確定', 予約の有無: 'あり' });
  });
});
