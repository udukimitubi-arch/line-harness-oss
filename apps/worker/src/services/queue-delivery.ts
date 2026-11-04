// 順番待ちの「外に出る」処理: LINE へのお知らせと、来店・不在のあとのマイル・タグ。
// 列の決まりそのものは services/queue.ts。ここは送る・付けるだけで、失敗しても列は戻さない。

import { LineClient } from '@line-crm/line-sdk';
import { awardActivityMileage } from './activity-mileage.js';
import { attachTagAndFireSideEffects } from './friend-tag-attach.js';
import {
  loadQueueConfig,
  renderQueueNotice,
  runQueueMaintenance,
  type QueueConfig,
  type QueueEntryRow,
  type QueueNotice,
} from './queue.js';

export type QueuePushSender = (channelAccessToken: string, toLineUserId: string, text: string) => Promise<void>;

export const defaultQueuePushSender: QueuePushSender = async (token, to, text) => {
  await new LineClient(token).pushMessage(to, [{ type: 'text', text }]);
};

export function queueStatusUrl(liffId: string | null | undefined): string | null {
  if (!liffId) return null;
  const id = encodeURIComponent(liffId);
  return `https://liff.line.me/${id}/?page=queue&liffId=${id}`;
}

export async function deliverQueueNotices(
  db: D1Database,
  config: QueueConfig,
  notices: QueueNotice[],
  sender: QueuePushSender = defaultQueuePushSender,
): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const list = notices.filter((n) => n.kind !== 'confirmed' || config.settings.sendConfirmation);
  if (list.length === 0) return out;
  const account = await db
    .prepare(`SELECT channel_access_token, liff_id FROM line_accounts WHERE id = ?`)
    .bind(config.lineAccountId)
    .first<{ channel_access_token: string | null; liff_id: string | null }>();
  if (!account?.channel_access_token) return { sent: 0, failed: list.length };
  const statusUrl = queueStatusUrl(account.liff_id);
  for (const n of list) {
    try {
      const friend = await db
        .prepare(`SELECT line_user_id, is_following FROM friends WHERE id = ? AND line_account_id = ?`)
        .bind(n.friendId, config.lineAccountId)
        .first<{ line_user_id: string; is_following: number }>();
      if (!friend?.line_user_id || friend.is_following === 0) {
        out.failed++;
        continue;
      }
      const text = renderQueueNotice(n, {
        notifyBeforeGroups: config.settings.notifyBeforeGroups,
        arrivalTimeoutMinutes: config.settings.arrivalTimeoutMinutes,
        statusUrl,
      });
      await sender(account.channel_access_token, friend.line_user_id, text);
      out.sent++;
    } catch (err) {
      out.failed++;
      console.error(`[queue] notice ${n.kind} failed:`, err);
    }
  }
  return out;
}

export interface FinishEffectsEnv {
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  WORKER_URL?: string;
}

/** 来店ならマイル（queue_visited）と来店タグ、不在なら不在タグ。LINE を使わない人は何もしない。 */
export async function applyQueueFinishEffects(
  db: D1Database,
  config: QueueConfig,
  entry: QueueEntryRow,
  finished: 'visited' | 'no_show',
  env: FinishEffectsEnv = {},
): Promise<void> {
  if (!entry.friend_id) return;
  if (finished === 'visited') {
    await awardActivityMileage(db, {
      eventType: 'queue_visited',
      source: 'queue',
      sourceEventId: entry.id,
      friendId: entry.friend_id,
      metadata: { kind: entry.kind, partySize: entry.party_size, businessDate: entry.business_date },
      occurredAt: new Date().toISOString(),
    });
  }
  const tagId = finished === 'visited' ? config.settings.visitTagId : config.settings.noShowTagId;
  if (!tagId) return;
  try {
    await attachTagAndFireSideEffects(
      db,
      entry.friend_id,
      tagId,
      env.LINE_CHANNEL_ACCESS_TOKEN
        ? { defaultAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN, workerUrl: env.WORKER_URL }
        : undefined,
      { lineAccountId: config.lineAccountId },
    );
  } catch (err) {
    console.error(`[queue] ${finished} tag failed:`, err);
  }
}

/** 毎分の見回り（scheduled.ts から呼ぶ）。自動キャンセル・自動の不在・N組前のお知らせ。 */
export async function runQueueTick(
  db: D1Database,
  now: Date,
  env: FinishEffectsEnv = {},
  sender: QueuePushSender = defaultQueuePushSender,
): Promise<{ arrivalTimeouts: number; noShows: number; dayEnded: number; sent: number }> {
  const result = await runQueueMaintenance(db, now);
  let sent = 0;
  const byAccount = new Map<string, QueueNotice[]>();
  for (const { lineAccountId, notice } of result.notices) {
    byAccount.set(lineAccountId, [...(byAccount.get(lineAccountId) ?? []), notice]);
  }
  for (const [accountId, notices] of byAccount) {
    const config = await loadQueueConfig(db, accountId);
    sent += (await deliverQueueNotices(db, config, notices, sender)).sent;
  }
  for (const entry of result.noShowEntries) {
    const config = await loadQueueConfig(db, entry.line_account_id);
    await applyQueueFinishEffects(db, config, entry, 'no_show', env);
  }
  return { arrivalTimeouts: result.arrivalTimeouts, noShows: result.noShows, dayEnded: result.dayEnded, sent };
}
