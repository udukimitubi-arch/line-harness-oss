import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import {
  DEFAULT_QUEUE_SETTINGS,
  QueueAlreadyJoinedError,
  applyQueueAction,
  checkInEntry,
  collectNearNotices,
  createEntry,
  groupsAhead,
  joinBlockReason,
  jstBusinessDate,
  listActiveEntries,
  loadQueueConfig,
  parseQueueSettings,
  renderQueueNotice,
  runQueueMaintenance,
  saveQueueConfig,
  validateQueueSettings,
  type QueueConfig,
} from './queue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, '../../../../packages/db/migrations/076_queue.sql'), 'utf8');

function setup() {
  const { db, sqlite } = sqliteD1();
  // マイルのルールの INSERT より前（表と索引）だけを使う。
  sqlite.exec(MIGRATION.split('-- 来店したら')[0]);
  return { db, sqlite };
}

// 2026-11-03 19:00 JST
const T0 = new Date('2026-11-03T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function config(over: Partial<QueueConfig> = {}, settings: Partial<typeof DEFAULT_QUEUE_SETTINGS> = {}): QueueConfig {
  return {
    lineAccountId: 'acc1',
    checkinToken: 'tok',
    isOpen: true,
    remoteOpen: true,
    ...over,
    settings: { ...DEFAULT_QUEUE_SETTINGS, ...settings },
  };
}

describe('parseQueueSettings / validateQueueSettings', () => {
  test('欠けた値と壊れた値は既定に戻す', () => {
    expect(parseQueueSettings(null)).toEqual(DEFAULT_QUEUE_SETTINGS);
    expect(parseQueueSettings('not json')).toEqual(DEFAULT_QUEUE_SETTINGS);
    const s = parseQueueSettings(JSON.stringify({ notifyBeforeGroups: 99, openTime: '25:00', seatTypes: ['', ' テーブル '], remoteMaxPercent: null }));
    expect(s.notifyBeforeGroups).toBe(3);
    expect(s.openTime).toBeNull();
    expect(s.seatTypes).toEqual(['テーブル']);
    expect(s.remoteMaxPercent).toBeNull();
  });

  test('おかしな入力は理由を返す', () => {
    expect(validateQueueSettings({ openTime: '9:00' })).toMatch(/openTime/);
    expect(validateQueueSettings({ notifyBeforeGroups: -1 })).toMatch(/notifyBeforeGroups/);
    expect(validateQueueSettings({ seatTypes: [1] })).toMatch(/seatTypes/);
    expect(validateQueueSettings({ remoteMaxPercent: null, openTime: '11:00', sendConfirmation: false })).toBeNull();
  });
});

describe('joinBlockReason', () => {
  test('受付停止・合言葉ちがい・時間外', () => {
    expect(joinBlockReason(config({ isOpen: false }), 'remote', [], T0)).toBe('closed');
    expect(joinBlockReason(config(), 'walk_in', [], T0, 'bad')).toBe('invalid_token');
    expect(joinBlockReason(config(), 'walk_in', [], T0, 'tok')).toBeNull();
    // 19:00 JST は 18:00 終了の後
    expect(joinBlockReason(config({}, { closeTime: '18:00' }), 'walk_in', [], T0, 'tok')).toBe('outside_hours');
    // 20:00 開店の60分前から事前受付 → 19:00 はちょうど開始
    expect(joinBlockReason(config({}, { openTime: '20:00' }), 'remote', [], T0)).toBeNull();
    expect(joinBlockReason(config({}, { openTime: '20:30' }), 'remote', [], T0)).toBe('remote_not_started');
    expect(joinBlockReason(config({}, { openTime: '20:00' }), 'walk_in', [], T0, 'tok')).toBe('outside_hours');
    expect(joinBlockReason(config({ remoteOpen: false }), 'remote', [], T0)).toBe('remote_closed');
  });

  test('事前受付の割合と組数の上限', async () => {
    const { db } = setup();
    await createEntry(db, { lineAccountId: 'acc1', friendId: 'f1', partySize: 2, kind: 'walk_in', now: T0 });
    await createEntry(db, { lineAccountId: 'acc1', friendId: 'f2', partySize: 2, kind: 'remote', now: T0 });
    const active = await listActiveEntries(db, 'acc1', jstBusinessDate(T0));
    // 事前2/3 = 66% > 50%
    expect(joinBlockReason(config(), 'remote', active, T0)).toBe('remote_full');
    expect(joinBlockReason(config({}, { remoteMaxPercent: 70 }), 'remote', active, T0)).toBeNull();
    expect(joinBlockReason(config({}, { remoteMaxPercent: null, remoteStopAtGroups: 2 }), 'remote', active, T0)).toBe('remote_full');
    expect(joinBlockReason(config(), 'remote', [], T0)).toBeNull();
  });
});

describe('列の流れ', () => {
  test('番号は日ごとの通し番号。前に何組かを数える', async () => {
    const { db } = setup();
    const a = await createEntry(db, { lineAccountId: 'acc1', friendId: 'f1', partySize: 2, kind: 'walk_in', now: T0 });
    const b = await createEntry(db, { lineAccountId: 'acc1', friendId: 'f2', partySize: 3, kind: 'remote', now: at(1) });
    expect([a.ticket_no, b.ticket_no]).toEqual([1, 2]);
    expect(a.arrived_at).not.toBeNull();
    expect(b.arrived_at).toBeNull();
    const active = await listActiveEntries(db, 'acc1', jstBusinessDate(T0));
    expect(groupsAhead(active, active[1])).toBe(1);
    const other = await createEntry(db, { lineAccountId: 'acc2', friendId: 'f9', partySize: 1, kind: 'walk_in', now: T0 });
    expect(other.ticket_no).toBe(1);
  });

  test('呼べるのは到着済みの人だけ。前の未到着の人は飛ばし中になり、到着したら一番前へ', async () => {
    const { db } = setup();
    const cfg = config({}, { notifyBeforeGroups: 1 });
    const remote = await createEntry(db, { lineAccountId: 'acc1', friendId: 'fr', partySize: 2, kind: 'remote', now: T0 });
    const walk1 = await createEntry(db, { lineAccountId: 'acc1', friendId: 'f1', partySize: 2, kind: 'walk_in', now: at(1) });
    const walk2 = await createEntry(db, { lineAccountId: 'acc1', friendId: 'f2', partySize: 2, kind: 'walk_in', now: at(2) });

    expect(await applyQueueAction(db, cfg, remote.id, 'call', at(3))).toEqual({ error: 'not_arrived' });

    const r = await applyQueueAction(db, cfg, walk1.id, 'call', at(3));
    if ('error' in r) throw new Error(r.error);
    expect(r.entry.status).toBe('called');
    expect(r.notices.map((n) => [n.kind, n.friendId])).toEqual(
      expect.arrayContaining([['passed', 'fr'], ['called', 'f1'], ['near', 'f2']]),
    );

    const after = await checkInEntry(db, cfg, (await listActiveEntries(db, 'acc1', jstBusinessDate(T0))).find((e) => e.id === remote.id)!, at(5));
    expect(after.entry.arrived_at).not.toBeNull();
    const active = await listActiveEntries(db, 'acc1', jstBusinessDate(T0));
    const waiting = active.filter((e) => e.status === 'waiting').map((e) => e.id);
    expect(waiting).toEqual([remote.id, walk2.id]);
  });

  test('同じ友だちは同じ日に二重に並べない（二度押し）', async () => {
    const { db } = setup();
    await createEntry(db, { lineAccountId: 'acc1', friendId: 'f1', partySize: 2, kind: 'remote', now: T0 });
    await expect(createEntry(db, { lineAccountId: 'acc1', friendId: 'f1', partySize: 2, kind: 'remote', now: T0 }))
      .rejects.toBeInstanceOf(QueueAlreadyJoinedError);
    // LINE を使わない代理受付は何組でも入れられる
    await createEntry(db, { lineAccountId: 'acc1', friendId: null, partySize: 1, kind: 'staff', now: T0 });
    await createEntry(db, { lineAccountId: 'acc1', friendId: null, partySize: 1, kind: 'staff', now: T0 });
    expect(await listActiveEntries(db, 'acc1', jstBusinessDate(T0))).toHaveLength(3);
  });

  test('N組前のお知らせは1回だけ', async () => {
    const { db } = setup();
    const cfg = config({}, { notifyBeforeGroups: 3 });
    await createEntry(db, { lineAccountId: 'acc1', friendId: 'f1', partySize: 2, kind: 'walk_in', now: T0 });
    const date = jstBusinessDate(T0);
    expect((await collectNearNotices(db, cfg, date, T0)).map((n) => n.friendId)).toEqual(['f1']);
    expect(await collectNearNotices(db, cfg, date, T0)).toEqual([]);
  });

  test('後回しは1つ後ろと入れ替える。来店・不在・キャンセルで列から外れる', async () => {
    const { db } = setup();
    const cfg = config();
    const a = await createEntry(db, { lineAccountId: 'acc1', friendId: null, partySize: 1, kind: 'staff', now: T0 });
    const b = await createEntry(db, { lineAccountId: 'acc1', friendId: null, partySize: 1, kind: 'staff', now: T0 });
    const c = await createEntry(db, { lineAccountId: 'acc1', friendId: null, partySize: 1, kind: 'staff', now: T0 });
    await applyQueueAction(db, cfg, a.id, 'defer', T0);
    let ids = (await listActiveEntries(db, 'acc1', jstBusinessDate(T0))).map((e) => e.id);
    expect(ids).toEqual([b.id, a.id, c.id]);

    await applyQueueAction(db, cfg, b.id, 'call', T0);
    const visit = await applyQueueAction(db, cfg, b.id, 'visit', T0);
    expect('error' in visit ? null : visit.finished).toBe('visited');
    expect(await applyQueueAction(db, cfg, b.id, 'visit', T0)).toEqual({ error: 'invalid_state' });
    await applyQueueAction(db, cfg, a.id, 'cancel', T0);
    ids = (await listActiveEntries(db, 'acc1', jstBusinessDate(T0))).map((e) => e.id);
    expect(ids).toEqual([c.id]);
  });
});

describe('runQueueMaintenance', () => {
  test('到着しない事前受付の自動キャンセル・呼び出し後の自動の不在・前日の列を閉じる', async () => {
    const { db } = setup();
    await saveQueueConfig(db, 'acc1', { settings: { ...DEFAULT_QUEUE_SETTINGS, arrivalTimeoutMinutes: 30, noShowMinutes: 10 } });
    const cfg = await loadQueueConfig(db, 'acc1');
    const remote = await createEntry(db, { lineAccountId: 'acc1', friendId: 'fr', partySize: 2, kind: 'remote', now: T0 });
    const walk = await createEntry(db, { lineAccountId: 'acc1', friendId: 'fw', partySize: 2, kind: 'walk_in', now: T0 });
    const yesterday = await createEntry(db, { lineAccountId: 'acc1', friendId: 'fy', partySize: 1, kind: 'walk_in', now: new Date(T0.getTime() - 86_400_000) });
    // walk より後ろの事前受付は、順番がまだ来ていない
    const later = await createEntry(db, { lineAccountId: 'acc1', friendId: 'fl', partySize: 2, kind: 'remote', now: T0 });
    // walk を呼ぶと、前にいた remote は飛ばし中になる（ここから30分を数える）
    await applyQueueAction(db, cfg, walk.id, 'call', at(1));

    const early = await runQueueMaintenance(db, at(5));
    expect(early.arrivalTimeouts + early.noShows).toBe(0);
    expect(early.dayEnded).toBe(1);

    const late = await runQueueMaintenance(db, at(31));
    expect(late.arrivalTimeouts).toBe(1);
    expect(late.noShows).toBe(1);
    expect(late.notices.map((n) => n.notice.kind)).toContain('arrival_timeout');
    expect(late.noShowEntries.map((e) => e.id)).toEqual([walk.id]);
    expect(late.notices.find((n) => n.notice.kind === 'arrival_timeout')?.notice.friendId).toBe('fr');
    // 順番が来ていない事前受付は、受付から何分たってもキャンセルしない
    await runQueueMaintenance(db, at(120));
    expect((await listActiveEntries(db, 'acc1', jstBusinessDate(T0))).map((e) => e.id)).toEqual([later.id]);
    expect(remote.id && yesterday.id).toBeTruthy();
  });
});

describe('renderQueueNotice', () => {
  test('事前受付の受付完了には到着の案内と期限を入れる', () => {
    const text = renderQueueNotice(
      { kind: 'confirmed', entryId: 'e', friendId: 'f', ticketNo: 24, partySize: 2, ahead: 5, remoteNotArrived: true },
      { notifyBeforeGroups: 3, arrivalTimeoutMinutes: 30, statusUrl: 'https://liff.line.me/x/?page=queue' },
    );
    expect(text).toContain('番号：024（2名）');
    expect(text).toContain('前に5組');
    expect(text).toContain('30分');
    expect(text).toContain('待ち状況：https://liff.line.me/x/?page=queue');
  });
});
