import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { LineClient } from '@line-crm/line-sdk';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { processReminderDeliveries } from './reminder-delivery.js';

vi.mock('./stealth.js', () => ({
  sleep: async () => {},
  jitterDeliveryTime: (date: Date) => date,
  addJitter: (value: number) => value,
}));

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processReminderDeliveries variables', () => {
  it('expands {{name}} and {{metadata.KEY}} in reminder steps', async () => {
    const { db, sqlite } = sqliteD1();
    sqlite.exec(schema);
    const pushed: unknown[] = [];
    vi.spyOn(LineClient.prototype, 'request').mockImplementation(async function (_method, path, body) {
      if (path.includes('/message/push')) pushed.push(body);
      return { data: {}, headers: new Headers() };
    });
    sqlite.prepare('INSERT INTO friends(id,line_user_id,display_name,metadata) VALUES(?,?,?,?)')
      .run('friend-1', 'line-friend-1', 'テスト太郎', JSON.stringify({ 予約日: '10月27日(火)', 予約開始時刻: '10:00' }));
    sqlite.exec("INSERT INTO reminders(id,name) VALUES('rem-1','予約リマインド')");
    sqlite.exec(`INSERT INTO reminder_steps(id,reminder_id,offset_minutes,message_type,message_content)
      VALUES('step-1','rem-1',-60,'text','{{name}}様 {{metadata.予約日}} {{metadata.予約開始時刻}}からです')`);
    // 基準時刻は過去 → 1時間前のステップは配信時刻を過ぎている
    sqlite.exec("INSERT INTO friend_reminders(id,friend_id,reminder_id,target_date) VALUES('fr-1','friend-1','rem-1','2020-01-01T01:00:00.000Z')");

    await processReminderDeliveries(db, new LineClient('synthetic-token'));

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      to: 'line-friend-1',
      messages: [{ type: 'text', text: 'テスト太郎様 10月27日(火) 10:00からです' }],
    });
    const log = sqlite.prepare("SELECT content FROM messages_log WHERE source='reminder'").get() as { content: string };
    expect(log.content).toBe('テスト太郎様 10月27日(火) 10:00からです');
  });
});
