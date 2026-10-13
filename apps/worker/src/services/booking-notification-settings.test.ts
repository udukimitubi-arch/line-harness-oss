import { describe, expect, test, vi } from 'vitest';

const pushMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({ pushMessage })),
}));

import {
  applyNotificationTemplate,
  parseNotificationTexts,
  parseRequestTtlHours,
} from './booking-notification-settings.js';
import { sendBookingNotification } from './booking-notifier.js';
import { runExpirer } from './booking-expirer.js';

const ctx = {
  menuName: 'LINE Harness 無料診断',
  staffName: '秋元',
  startsAtJst: '2026-10-20 10:00',
  hoursBefore: 2,
};

// account_settings と bookings だけを返す最小の D1 スタブ。
function stubDB(opts: { texts?: string; ttl?: Array<{ line_account_id: string; value: string }>; bookings?: unknown[] }) {
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      const stmt = {
        bind: () => stmt,
        async first() {
          if (sql.includes('FROM account_settings') && opts.texts !== undefined) return { value: opts.texts };
          return null;
        },
        async all() {
          if (sql.includes('FROM account_settings')) return { results: opts.ttl ?? [] };
          if (sql.includes('FROM bookings')) return { results: opts.bookings ?? [] };
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, queries };
}

describe('parse helpers', () => {
  test('知らない種類や文字列以外は捨てる', () => {
    expect(parseNotificationTexts('{"approved":"OK","foo":"x","rejected":1}')).toEqual({ approved: 'OK' });
    expect(parseNotificationTexts('not json')).toEqual({});
    expect(parseNotificationTexts(null)).toEqual({});
  });

  test('期限は 0〜720 時間だけ有効', () => {
    expect(parseRequestTtlHours('0')).toBe(0);
    expect(parseRequestTtlHours('72')).toBe(72);
    expect(parseRequestTtlHours('-1')).toBeNull();
    expect(parseRequestTtlHours('abc')).toBeNull();
    expect(parseRequestTtlHours('721')).toBeNull();
  });

  test('差し込み文字を埋める', () => {
    expect(applyNotificationTemplate('{menu}/{staff}/{datetime}/{hours}', ctx)).toBe(
      'LINE Harness 無料診断/秋元/2026-10-20 10:00/2',
    );
  });
});

describe('sendBookingNotification の上書き', () => {
  const base = { channelAccessToken: 'tok', toLineUserId: 'U1', ctx, lineAccountId: 'A1' };

  test('上書きが無ければ標準の文面', async () => {
    pushMessage.mockClear();
    const { db } = stubDB({});
    await sendBookingNotification({ ...base, kind: 'approved', db });
    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(pushMessage.mock.calls[0][1][0].text).toContain('予約が確定しました');
  });

  test('上書きの文面で送る', async () => {
    pushMessage.mockClear();
    const { db } = stubDB({ texts: JSON.stringify({ approved: '{datetime} で確定です' }) });
    await sendBookingNotification({ ...base, kind: 'approved', db });
    expect(pushMessage.mock.calls[0][1][0].text).toBe('2026-10-20 10:00 で確定です');
  });

  test('空の文面なら送らない', async () => {
    pushMessage.mockClear();
    const { db } = stubDB({ texts: JSON.stringify({ requested: '' }) });
    await sendBookingNotification({ ...base, kind: 'requested', db });
    expect(pushMessage).not.toHaveBeenCalled();
  });
});

describe('runExpirer の期限設定', () => {
  const NOW = new Date('2026-10-14T00:00:00Z');
  const row = (id: string, requestedAt: string, startsAt: string) => ({
    id,
    starts_at: startsAt,
    requested_at: requestedAt,
    line_account_id: 'A1',
    menu_name: 'm',
    staff_name: 's',
    channel_access_token: 'tok',
    line_user_id: 'U',
  });

  test('0 時間 = 開始時刻を過ぎた申し込みだけ期限切れ', async () => {
    const { db } = stubDB({
      ttl: [{ line_account_id: 'A1', value: '0' }],
      bookings: [
        row('old-future', '2026-10-01T00:00:00Z', '2026-10-20T01:00:00Z'),
        row('past', '2026-10-13T00:00:00Z', '2026-10-13T23:00:00Z'),
      ],
    });
    const sender = vi.fn().mockResolvedValue(undefined);
    const result = await runExpirer(db, { now: NOW, sender });
    expect(result.expired).toBe(1);
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ kind: 'expired', lineAccountId: 'A1' }));
  });

  test('72 時間なら 24 時間を過ぎただけでは期限切れにしない', async () => {
    const { db } = stubDB({
      ttl: [{ line_account_id: 'A1', value: '72' }],
      bookings: [
        row('2days', '2026-10-12T00:00:00Z', '2026-10-20T01:00:00Z'),
        row('4days', '2026-10-10T00:00:00Z', '2026-10-20T01:00:00Z'),
      ],
    });
    const sender = vi.fn().mockResolvedValue(undefined);
    const result = await runExpirer(db, { now: NOW, sender });
    expect(result.expired).toBe(1);
  });

  test('設定が無ければ従来どおり 24 時間で絞り込む', async () => {
    const { db, queries } = stubDB({ bookings: [] });
    await runExpirer(db, { now: NOW, sender: vi.fn() });
    expect(queries.some((q) => q.includes('FROM bookings') && q.includes('b.requested_at < ?'))).toBe(true);
  });
});
