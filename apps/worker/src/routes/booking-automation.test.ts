import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { Hono } from 'hono';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import bookingAutomation, { validateNotifyBody } from './booking-automation.js';

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(env: Record<string, unknown> = {}) {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(schema);
  sqlite.prepare('INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?,?,?,?)')
    .run('acc', 'channel-acc', 'acc', 'synthetic-token', 'synthetic-secret');
  sqlite.prepare('INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES(?,?,?,?,?)')
    .run('menu-1', 'acc', '無料診断', 60, 0);
  sqlite.exec("INSERT INTO reminders(id,name,line_account_id) VALUES('rem-1','予約リマインド','acc'),('rem-x','他アカウント','other')");
  const app = new Hono();
  app.route('/', bookingAutomation);
  const call = (path: string, init?: RequestInit) => app.request(path, init, { DB: db, ...env });
  return { db, sqlite, call };
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('validateNotifyBody', () => {
  it('requires every field on create', () => {
    expect(validateNotifyBody({}, false)).toMatch(/event/);
    expect(validateNotifyBody({ event: 'requested', channel: 'mail', target: 'x', message_template: 'x' }, false)).toMatch(/channel/);
    expect(validateNotifyBody({ event: 'requested', channel: 'chatwork', target: '1', message_template: 'x' }, false)).toBeNull();
  });
  it('accepts partial updates', () => {
    expect(validateNotifyBody({ is_active: false }, true)).toBeNull();
    expect(validateNotifyBody({ minutes_after: -1 }, true)).toMatch(/minutes_after/);
  });
});

describe('menu reminders', () => {
  it('saves and reads the reminders linked to a menu', async () => {
    const t = setup();
    let res = await t.call('/api/booking/admin/menus/menu-1/reminders?account_id=acc', json({ reminder_ids: ['rem-1'] }, 'PUT'));
    expect(res.status).toBe(200);
    res = await t.call('/api/booking/admin/menus/menu-1/reminders?account_id=acc');
    expect(await res.json()).toEqual({ reminder_ids: ['rem-1'] });
  });

  it('rejects a reminder of another account and an unknown menu', async () => {
    const t = setup();
    let res = await t.call('/api/booking/admin/menus/menu-1/reminders?account_id=acc', json({ reminder_ids: ['rem-x'] }, 'PUT'));
    expect(res.status).toBe(400);
    res = await t.call('/api/booking/admin/menus/nope/reminders?account_id=acc', json({ reminder_ids: [] }, 'PUT'));
    expect(res.status).toBe(404);
  });
});

describe('menu options', () => {
  it('saves and reads the Google Meet option', async () => {
    const t = setup();
    let res = await t.call('/api/booking/admin/menus/menu-1/options?account_id=acc');
    expect(await res.json()).toEqual({ add_google_meet: false });
    res = await t.call('/api/booking/admin/menus/menu-1/options?account_id=acc', json({ add_google_meet: true }, 'PUT'));
    expect(res.status).toBe(200);
    res = await t.call('/api/booking/admin/menus/menu-1/options?account_id=acc');
    expect(await res.json()).toEqual({ add_google_meet: true });
    res = await t.call('/api/booking/admin/menus/menu-1/options?account_id=acc', json({ add_google_meet: 'yes' }, 'PUT'));
    expect(res.status).toBe(400);
  });
});

describe('notify targets', () => {
  it('creates, updates, tests and deletes a Chatwork target', async () => {
    const t = setup({ CHATWORK_API_TOKEN: 'synthetic-cw', ADMIN_PUBLIC_URL: 'https://admin.example' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    let res = await t.call('/api/booking/admin/notify-targets?account_id=acc', json({
      event: 'requested',
      channel: 'chatwork',
      target: '436942990',
      message_template: '【{event}】{name}様 {date} {start}',
    }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { target: { id: string; minutes_after: number; is_active: boolean } };
    expect(created.target).toMatchObject({ minutes_after: 30, is_active: true });

    res = await t.call(`/api/booking/admin/notify-targets/${created.target.id}?account_id=acc`, json({ is_active: false }, 'PUT'));
    expect(((await res.json()) as { target: { is_active: boolean } }).target.is_active).toBe(false);

    res = await t.call(`/api/booking/admin/notify-targets/${created.target.id}/test?account_id=acc`, { method: 'POST' });
    expect(await res.json()).toEqual({ sent: true });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.chatwork.com/v2/rooms/436942990/messages');
    expect(new URLSearchParams(init.body as string).get('body')).toMatch(/^【テスト送信】\n【申し込み】（テスト）お客さま様/);

    res = await t.call('/api/booking/admin/notify-targets?account_id=acc');
    expect(await res.json()).toMatchObject({ chatwork_token_set: true, targets: [{ id: created.target.id }] });

    res = await t.call(`/api/booking/admin/notify-targets/${created.target.id}?account_id=acc`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('rejects a non-numeric Chatwork room and a non-https webhook', async () => {
    const t = setup();
    let res = await t.call('/api/booking/admin/notify-targets?account_id=acc', json({
      event: 'requested', channel: 'chatwork', target: 'room', message_template: 'x',
    }));
    expect(res.status).toBe(400);
    res = await t.call('/api/booking/admin/notify-targets?account_id=acc', json({
      event: 'requested', channel: 'webhook', target: 'http://example.com', message_template: 'x',
    }));
    expect(res.status).toBe(400);
  });

  it('reports a failed test send without a Chatwork token', async () => {
    const t = setup();
    t.sqlite.prepare(
      `INSERT INTO booking_admin_notifications(id,line_account_id,event,channel,target,message_template) VALUES(?,?,?,?,?,?)`,
    ).run('n1', 'acc', 'approved', 'chatwork', '1', 'x');
    const res = await t.call('/api/booking/admin/notify-targets/n1/test?account_id=acc', { method: 'POST' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ sent: false, error: 'CHATWORK_API_TOKEN is not set' });
  });
});
