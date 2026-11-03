import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteD1 } from '../test-support/sqlite-d1.js';

// LIFF の本人確認は booking.ts の仕組みをそのまま使う。ここでは結果だけ差し替える。
const auth = { lineUserId: 'U1' as string | null };
vi.mock('./booking.js', () => ({
  resolveAccountIdFromLiff: async (c: { req: { query: (k: string) => string | undefined } }) =>
    c.req.query('liffId') === 'liff-1' ? 'acc1' : null,
  verifyCallerLineUserId: async () => auth.lineUserId,
  resolveFriendId: async (c: { env: { DB: D1Database } }, lineUserId: string, accountId: string) => {
    const row = await c.env.DB
      .prepare(`SELECT id FROM friends WHERE line_user_id = ? AND line_account_id = ?`)
      .bind(lineUserId, accountId)
      .first<{ id: string }>();
    return row?.id ?? null;
  },
}));

const pushes: Array<{ to: string; text: string }> = [];
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    async pushMessage(to: string, messages: Array<{ text: string }>) {
      pushes.push({ to, text: messages[0].text });
    }
  },
}));

const effects = { mileage: [] as string[], tags: [] as string[] };
vi.mock('../services/activity-mileage.js', () => ({
  awardActivityMileage: async (_db: unknown, input: { eventType: string; friendId: string }) => {
    effects.mileage.push(`${input.eventType}:${input.friendId}`);
  },
}));
vi.mock('../services/friend-tag-attach.js', () => ({
  attachTagAndFireSideEffects: async (_db: unknown, friendId: string, tagId: string) => {
    effects.tags.push(`${tagId}:${friendId}`);
    return { added: true };
  },
}));

const { default: queue } = await import('./queue.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, '../../../../packages/db/migrations/076_queue.sql'), 'utf8');

function setup() {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(MIGRATION.split('-- 来店したら')[0]);
  sqlite.exec(`
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY, channel_access_token TEXT, liff_id TEXT);
    CREATE TABLE friends (id TEXT PRIMARY KEY, line_user_id TEXT, line_account_id TEXT, is_following INTEGER);
    INSERT INTO line_accounts VALUES ('acc1', 'token-1', 'liff-1');
    INSERT INTO friends VALUES ('f1', 'U1', 'acc1', 1), ('f2', 'U2', 'acc1', 1), ('f3', 'U3', 'acc1', 0);
    INSERT INTO queue_settings (line_account_id, settings_json, checkin_token, is_open, remote_open, updated_at)
      VALUES ('acc1', '{"remoteMaxPercent":null,"visitTagId":"tag-visit","noShowTagId":"tag-noshow"}', 'qr-secret', 1, 1, '2026-01-01');
  `);
  const app = new Hono();
  app.route('/', queue);
  const env = { DB: db };
  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x', ...(init.headers ?? {}) } }, env);
  return { db, sqlite, call };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  auth.lineUserId = 'U1';
  pushes.length = 0;
  effects.mileage.length = 0;
  effects.tags.length = 0;
});

describe('LIFF /api/liff/queue/*', () => {
  test('店頭QRの合言葉が無いと「その場で受付」はできない', async () => {
    const { call } = setup();
    const res = await call('/api/liff/queue/entries?liffId=liff-1', post({ kind: 'walk_in', party_size: 2 }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  test('事前受付 → 受付完了が届く → 店頭QRで到着 → 二重受付はできない', async () => {
    const { call } = setup();
    const join = await call('/api/liff/queue/entries?liffId=liff-1', post({ kind: 'remote', party_size: 2 }));
    expect(join.status).toBe(201);
    const { entry } = (await join.json()) as { entry: { ticket_label: string; arrived: boolean } };
    expect(entry).toMatchObject({ ticket_label: '001', arrived: false });
    expect(pushes[0].to).toBe('U1');
    expect(pushes[0].text).toContain('順番待ちを受け付けました');
    expect(pushes[0].text).toContain('https://liff.line.me/liff-1/?page=queue&liffId=liff-1');

    const again = await call('/api/liff/queue/entries?liffId=liff-1', post({ kind: 'remote', party_size: 2 }));
    expect(again.status).toBe(409);

    expect((await call('/api/liff/queue/checkin?liffId=liff-1', post({ token: 'nope' }))).status).toBe(403);
    const arrived = await call('/api/liff/queue/checkin?liffId=liff-1', post({ token: 'qr-secret' }));
    expect(((await arrived.json()) as { entry: { arrived: boolean } }).entry.arrived).toBe(true);

    const me = await call('/api/liff/queue/me?liffId=liff-1');
    expect(((await me.json()) as { entry: { ticket_no: number } }).entry.ticket_no).toBe(1);
  });

  test('ブロック中の友だちは受付できない。キャンセルで列から外れる', async () => {
    const { call } = setup();
    auth.lineUserId = 'U3';
    expect((await call('/api/liff/queue/entries?liffId=liff-1', post({ kind: 'remote', party_size: 1 }))).status).toBe(403);

    auth.lineUserId = 'U2';
    await call('/api/liff/queue/entries?liffId=liff-1', post({ kind: 'walk_in', party_size: 1, token: 'qr-secret' }));
    expect((await call('/api/liff/queue/cancel?liffId=liff-1', post({}))).status).toBe(200);
    const me = await call('/api/liff/queue/me?liffId=liff-1');
    expect(await me.json()).toEqual({ entry: null });
  });

  test('status は合言葉の正しさと待ち組数だけを返す', async () => {
    const { call } = setup();
    const res = await call('/api/liff/queue/status?liffId=liff-1&t=qr-secret');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ open: true, waiting_groups: 0, token_valid: true, walk_in_block: null });
    expect(JSON.stringify(body)).not.toContain('qr-secret');
    expect((await call('/api/liff/queue/status?liffId=unknown')).status).toBe(404);
  });
});

describe('管理画面 /api/queue/admin/*', () => {
  test('代理受付 → 呼び出し → 来店でマイルとタグ。LINE の無い人には何も送らない', async () => {
    const { call } = setup();
    await call('/api/liff/queue/entries?liffId=liff-1', post({ kind: 'walk_in', party_size: 2, token: 'qr-secret' }));
    const staff = await call('/api/queue/admin/entries?account_id=acc1', post({ party_size: 3, guest_label: '佐藤' }));
    expect(staff.status).toBe(201);

    const list = (await (await call('/api/queue/admin/entries?account_id=acc1')).json()) as {
      entries: Array<{ id: string; kind: string; has_line: boolean; groups_ahead: number }>;
      waiting_groups: number;
    };
    expect(list.waiting_groups).toBe(2);
    const [line, walkIn] = list.entries;
    expect(walkIn).toMatchObject({ kind: 'staff', has_line: false, groups_ahead: 1 });

    pushes.length = 0;
    const called = await call(`/api/queue/admin/entries/${line.id}/action?account_id=acc1`, post({ action: 'call' }));
    expect(called.status).toBe(200);
    expect(pushes.map((p) => p.text)).toEqual([expect.stringContaining('入口までお越しください')]);

    await call(`/api/queue/admin/entries/${line.id}/action?account_id=acc1`, post({ action: 'visit' }));
    expect(effects.mileage).toEqual(['queue_visited:f1']);
    expect(effects.tags).toEqual(['tag-visit:f1']);

    await call(`/api/queue/admin/entries/${walkIn.id}/action?account_id=acc1`, post({ action: 'call' }));
    await call(`/api/queue/admin/entries/${walkIn.id}/action?account_id=acc1`, post({ action: 'no_show' }));
    expect(effects.tags).toEqual(['tag-visit:f1']);

    const stats = (await (await call('/api/queue/admin/entries?account_id=acc1')).json()) as { stats: Record<string, number> };
    expect(stats.stats).toMatchObject({ visited: 1, no_show: 1, total: 2 });
  });

  test('操作の入力チェック', async () => {
    const { call } = setup();
    expect((await call('/api/queue/admin/entries')).status).toBe(400);
    expect((await call('/api/queue/admin/entries/x/action?account_id=acc1', post({ action: 'boom' }))).status).toBe(400);
    expect((await call('/api/queue/admin/entries/x/action?account_id=acc1', post({ action: 'call' }))).status).toBe(404);
    expect((await call('/api/queue/admin/entries?account_id=acc1', post({ party_size: 0 }))).status).toBe(400);
  });

  test('設定の保存・受付の一時停止・QRの合言葉の作り直し', async () => {
    const { call } = setup();
    const bad = await call('/api/queue/admin/settings?account_id=acc1', { method: 'PUT', body: JSON.stringify({ settings: { openTime: '9:00' } }) });
    expect(bad.status).toBe(400);

    const res = await call('/api/queue/admin/settings?account_id=acc1', {
      method: 'PUT',
      body: JSON.stringify({ settings: { notifyBeforeGroups: 2, seatTypes: ['テーブル', 'カウンター'] }, remote_open: false, rotate_token: true }),
    });
    const body = (await res.json()) as { settings: Record<string, unknown>; remote_open: boolean; checkin_token: string; liff_id: string };
    expect(body.settings).toMatchObject({ notifyBeforeGroups: 2, seatTypes: ['テーブル', 'カウンター'], visitTagId: 'tag-visit' });
    expect(body.remote_open).toBe(false);
    expect(body.checkin_token).not.toBe('qr-secret');
    expect(body.liff_id).toBe('liff-1');

    const remote = await call('/api/liff/queue/entries?liffId=liff-1', post({ kind: 'remote', party_size: 1, seat_type: 'テーブル' }));
    expect(await remote.json()).toEqual({ error: 'remote_closed' });
    const wrongSeat = await call('/api/liff/queue/entries?liffId=liff-1', post({ kind: 'walk_in', party_size: 1, seat_type: '個室', token: body.checkin_token }));
    expect(wrongSeat.status).toBe(400);
  });
});
