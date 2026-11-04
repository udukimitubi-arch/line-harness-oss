// 順番待ち（受付・事前受付・到着チェックイン・呼び出し）の決まりと処理。
//
// 流れ:
//   その場の受付  … 店頭QR（checkin_token）を読んで受付。受付した時点で「到着済み」。
//   事前の受付    … LINE から受付。店頭QRを読むと「到着済み」になる。
//   呼び出し      … 店側が呼ぶのは到着済みの人だけ。その人より前にいた未到着の人は
//                    「飛ばし中」（passed_at）になり、到着したら列の一番前に戻る。
//   お知らせ      … N組前（既定3組前）・呼び出し・飛ばし・自動キャンセルを LINE で送る。
//   来店          … マイル（queue_visited）とタグを付ける。タグからステップ配信を始められる。
//
// 時刻は UTC ISO8601。business_date は日本時間の日付。

export type QueueEntryKind = 'walk_in' | 'remote' | 'staff';
export type QueueEntryStatus = 'waiting' | 'called' | 'visited' | 'no_show' | 'cancelled';
export type QueueAction = 'call' | 'recall' | 'visit' | 'no_show' | 'defer' | 'cancel';

export const QUEUE_ACTIONS: readonly QueueAction[] = ['call', 'recall', 'visit', 'no_show', 'defer', 'cancel'];

export interface QueueSettings {
  /** 受付を始める時刻（日本時間 HH:MM）。null なら時刻の制限なし。 */
  openTime: string | null;
  /** 受付を終える時刻（日本時間 HH:MM）。null なら時刻の制限なし。 */
  closeTime: string | null;
  /** 事前受付を openTime の何分前から受けるか。 */
  remoteStartMinutesBefore: number;
  /** 列のうち事前受付が占めてよい割合（%）。null は制限なし。 */
  remoteMaxPercent: number | null;
  /** 待ちがこの組数以上なら事前受付を止める。null は制限なし。 */
  remoteStopAtGroups: number | null;
  /** 何組前にお知らせするか。0 で送らない。 */
  notifyBeforeGroups: number;
  /** 順番が来て飛ばされてから何分たっても到着しなければ自動キャンセルするか。0 で自動キャンセルしない。 */
  arrivalTimeoutMinutes: number;
  /** 呼び出しから何分で「不在」にするか。0 で自動にしない。 */
  noShowMinutes: number;
  /** 人数の上限（この人数以上は「N名以上」としてまとめる）。 */
  maxPartySize: number;
  /** 席の希望の選択肢。空なら聞かない。 */
  seatTypes: string[];
  /** 来店時に付けるタグ。 */
  visitTagId: string | null;
  /** 不在時に付けるタグ。 */
  noShowTagId: string | null;
  /** 受付完了のメッセージを LINE で送るか。 */
  sendConfirmation: boolean;
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  openTime: null,
  closeTime: null,
  remoteStartMinutesBefore: 60,
  remoteMaxPercent: 50,
  remoteStopAtGroups: null,
  notifyBeforeGroups: 3,
  arrivalTimeoutMinutes: 30,
  noShowMinutes: 10,
  maxPartySize: 6,
  seatTypes: [],
  visitTagId: null,
  noShowTagId: null,
  sendConfirmation: true,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function intIn(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/** 保存済みの JSON を、欠けた値を既定で埋めて読む。壊れた値は既定に戻す。 */
export function parseQueueSettings(raw: string | null | undefined): QueueSettings {
  let obj: Record<string, unknown> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    /* 既定値を使う */
  }
  const d = DEFAULT_QUEUE_SETTINGS;
  const time = (v: unknown) => (typeof v === 'string' && HHMM.test(v) ? v : null);
  const nullableInt = (v: unknown, min: number, max: number, fallback: number | null) =>
    v === null ? null : intIn(v, min, max) ?? fallback;
  const tag = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    openTime: 'openTime' in obj ? time(obj.openTime) : d.openTime,
    closeTime: 'closeTime' in obj ? time(obj.closeTime) : d.closeTime,
    remoteStartMinutesBefore: intIn(obj.remoteStartMinutesBefore, 0, 720) ?? d.remoteStartMinutesBefore,
    remoteMaxPercent: 'remoteMaxPercent' in obj ? nullableInt(obj.remoteMaxPercent, 0, 100, d.remoteMaxPercent) : d.remoteMaxPercent,
    remoteStopAtGroups: 'remoteStopAtGroups' in obj ? nullableInt(obj.remoteStopAtGroups, 1, 999, d.remoteStopAtGroups) : d.remoteStopAtGroups,
    notifyBeforeGroups: intIn(obj.notifyBeforeGroups, 0, 20) ?? d.notifyBeforeGroups,
    arrivalTimeoutMinutes: intIn(obj.arrivalTimeoutMinutes, 0, 720) ?? d.arrivalTimeoutMinutes,
    noShowMinutes: intIn(obj.noShowMinutes, 0, 180) ?? d.noShowMinutes,
    maxPartySize: intIn(obj.maxPartySize, 1, 50) ?? d.maxPartySize,
    seatTypes: Array.isArray(obj.seatTypes)
      ? obj.seatTypes.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()).slice(0, 10)
      : d.seatTypes,
    visitTagId: 'visitTagId' in obj ? tag(obj.visitTagId) : d.visitTagId,
    noShowTagId: 'noShowTagId' in obj ? tag(obj.noShowTagId) : d.noShowTagId,
    sendConfirmation: typeof obj.sendConfirmation === 'boolean' ? obj.sendConfirmation : d.sendConfirmation,
  };
}

/** 管理画面から届いた設定を確かめる。問題があれば理由を返す。 */
export function validateQueueSettings(input: Record<string, unknown>): string | null {
  const checkTime = (k: string) =>
    input[k] !== undefined && input[k] !== null && !(typeof input[k] === 'string' && HHMM.test(input[k] as string))
      ? `${k} must be HH:MM or null`
      : null;
  const checkInt = (k: string, min: number, max: number, nullable = false) => {
    const v = input[k];
    if (v === undefined || (nullable && v === null)) return null;
    return intIn(v, min, max) === undefined ? `${k} must be an integer between ${min} and ${max}` : null;
  };
  const errors = [
    checkTime('openTime'),
    checkTime('closeTime'),
    checkInt('remoteStartMinutesBefore', 0, 720),
    checkInt('remoteMaxPercent', 0, 100, true),
    checkInt('remoteStopAtGroups', 1, 999, true),
    checkInt('notifyBeforeGroups', 0, 20),
    checkInt('arrivalTimeoutMinutes', 0, 720),
    checkInt('noShowMinutes', 0, 180),
    checkInt('maxPartySize', 1, 50),
  ].filter(Boolean);
  if (errors.length) return errors[0] as string;
  if (input.seatTypes !== undefined && !(Array.isArray(input.seatTypes) && input.seatTypes.every((s) => typeof s === 'string'))) {
    return 'seatTypes must be a list of strings';
  }
  for (const k of ['visitTagId', 'noShowTagId']) {
    if (input[k] !== undefined && input[k] !== null && typeof input[k] !== 'string') return `${k} must be a string or null`;
  }
  if (input.sendConfirmation !== undefined && typeof input.sendConfirmation !== 'boolean') {
    return 'sendConfirmation must be a boolean';
  }
  return null;
}

// ─── 日本時間 ──────────────────────────────────────────────

const JST_MS = 9 * 60 * 60 * 1000;

export function jstBusinessDate(now: Date): string {
  return new Date(now.getTime() + JST_MS).toISOString().slice(0, 10);
}

function jstMinutesOfDay(now: Date): number {
  const d = new Date(now.getTime() + JST_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
}

// ─── 行と設定 ──────────────────────────────────────────────

export interface QueueEntryRow {
  id: string;
  line_account_id: string;
  business_date: string;
  ticket_no: number;
  friend_id: string | null;
  guest_label: string | null;
  party_size: number;
  seat_type: string | null;
  kind: QueueEntryKind;
  status: QueueEntryStatus;
  sort_key: number;
  arrived_at: string | null;
  passed_at: string | null;
  near_notified_at: string | null;
  called_at: string | null;
  call_count: number;
  finished_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueueConfig {
  lineAccountId: string;
  settings: QueueSettings;
  checkinToken: string;
  isOpen: boolean;
  remoteOpen: boolean;
}

function newToken(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** 店の設定を読む。まだ無ければ既定値で作る（店頭QRの合言葉もここで決まる）。 */
export async function loadQueueConfig(db: D1Database, lineAccountId: string): Promise<QueueConfig> {
  type Row = { settings_json: string; checkin_token: string; is_open: number; remote_open: number };
  let row = await db
    .prepare(`SELECT settings_json, checkin_token, is_open, remote_open FROM queue_settings WHERE line_account_id = ?`)
    .bind(lineAccountId)
    .first<Row>();
  if (!row) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO queue_settings (line_account_id, settings_json, checkin_token, is_open, remote_open, updated_at)
         VALUES (?, '{}', ?, 1, 1, ?)`,
      )
      .bind(lineAccountId, newToken(), new Date().toISOString())
      .run();
    row = await db
      .prepare(`SELECT settings_json, checkin_token, is_open, remote_open FROM queue_settings WHERE line_account_id = ?`)
      .bind(lineAccountId)
      .first<Row>();
  }
  return {
    lineAccountId,
    settings: parseQueueSettings(row?.settings_json),
    checkinToken: row?.checkin_token ?? '',
    isOpen: row?.is_open !== 0,
    remoteOpen: row?.remote_open !== 0,
  };
}

export async function saveQueueConfig(
  db: D1Database,
  lineAccountId: string,
  patch: { settings?: QueueSettings; isOpen?: boolean; remoteOpen?: boolean; rotateToken?: boolean },
): Promise<QueueConfig> {
  const current = await loadQueueConfig(db, lineAccountId);
  await db
    .prepare(
      `UPDATE queue_settings
          SET settings_json = ?, is_open = ?, remote_open = ?, checkin_token = ?, updated_at = ?
        WHERE line_account_id = ?`,
    )
    .bind(
      JSON.stringify(patch.settings ?? current.settings),
      (patch.isOpen ?? current.isOpen) ? 1 : 0,
      (patch.remoteOpen ?? current.remoteOpen) ? 1 : 0,
      patch.rotateToken ? newToken() : current.checkinToken,
      new Date().toISOString(),
      lineAccountId,
    )
    .run();
  return loadQueueConfig(db, lineAccountId);
}

/** その日の、まだ終わっていない列（並び順）。 */
export async function listActiveEntries(db: D1Database, lineAccountId: string, businessDate: string): Promise<QueueEntryRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM queue_entries
        WHERE line_account_id = ? AND business_date = ? AND status IN ('waiting', 'called')
        ORDER BY sort_key ASC, ticket_no ASC`,
    )
    .bind(lineAccountId, businessDate)
    .all<QueueEntryRow>();
  return rows.results ?? [];
}

export async function getEntry(db: D1Database, lineAccountId: string, entryId: string): Promise<QueueEntryRow | null> {
  return db
    .prepare(`SELECT * FROM queue_entries WHERE id = ? AND line_account_id = ?`)
    .bind(entryId, lineAccountId)
    .first<QueueEntryRow>();
}

export async function findActiveEntryForFriend(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
  businessDate: string,
): Promise<QueueEntryRow | null> {
  return db
    .prepare(
      `SELECT * FROM queue_entries
        WHERE line_account_id = ? AND friend_id = ? AND business_date = ? AND status IN ('waiting', 'called')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(lineAccountId, friendId, businessDate)
    .first<QueueEntryRow>();
}

// ─── 列の見え方 ────────────────────────────────────────────

/** その人の前にいる「待っている」組の数。呼び出し中の組は数えない。 */
export function groupsAhead(active: QueueEntryRow[], entry: QueueEntryRow): number {
  return active.filter((e) => e.status === 'waiting' && e.id !== entry.id && e.sort_key < entry.sort_key).length;
}

export function waitingCount(active: QueueEntryRow[]): number {
  return active.filter((e) => e.status === 'waiting').length;
}

export type JoinBlockReason =
  | 'closed'
  | 'outside_hours'
  | 'remote_closed'
  | 'remote_not_started'
  | 'remote_full'
  | 'invalid_token';

/** 受付できるかどうか。できないときは理由を返す。 */
export function joinBlockReason(
  config: QueueConfig,
  kind: 'walk_in' | 'remote',
  active: QueueEntryRow[],
  now: Date,
  token?: string | null,
): JoinBlockReason | null {
  if (!config.isOpen) return 'closed';
  const s = config.settings;
  const nowMin = jstMinutesOfDay(now);
  if (s.closeTime && nowMin >= hhmmToMinutes(s.closeTime)) return 'outside_hours';
  if (kind === 'walk_in') {
    if (!token || token !== config.checkinToken) return 'invalid_token';
    if (s.openTime && nowMin < hhmmToMinutes(s.openTime)) return 'outside_hours';
    return null;
  }
  if (!config.remoteOpen) return 'remote_closed';
  if (s.openTime && nowMin < hhmmToMinutes(s.openTime) - s.remoteStartMinutesBefore) return 'remote_not_started';
  const waiting = waitingCount(active);
  if (s.remoteStopAtGroups !== null && waiting >= s.remoteStopAtGroups) return 'remote_full';
  if (s.remoteMaxPercent !== null) {
    const remoteWaiting = active.filter((e) => e.status === 'waiting' && e.kind === 'remote').length;
    // この人を入れたあとの割合で判断する。列が空なら事前受付の1組目は受ける。
    if (waiting > 0 && ((remoteWaiting + 1) / (waiting + 1)) * 100 > s.remoteMaxPercent) return 'remote_full';
    if (waiting === 0 && s.remoteMaxPercent === 0) return 'remote_full';
  }
  return null;
}

// ─── 受付 ──────────────────────────────────────────────────

export interface CreateEntryInput {
  lineAccountId: string;
  friendId: string | null;
  guestLabel?: string | null;
  partySize: number;
  seatType?: string | null;
  kind: QueueEntryKind;
  now: Date;
}

export class QueueAlreadyJoinedError extends Error {
  constructor() {
    super('already_in_queue');
  }
}

export async function createEntry(db: D1Database, input: CreateEntryInput): Promise<QueueEntryRow> {
  const businessDate = jstBusinessDate(input.now);
  const nowIso = input.now.toISOString();
  const id = crypto.randomUUID();
  // 番号はその日の通し番号。同時に受付が来たら UNIQUE で弾かれるので取り直す。
  for (let attempt = 0; attempt < 5; attempt++) {
    const max = await db
      .prepare(
        `SELECT COALESCE(MAX(ticket_no), 0) AS n, COALESCE(MAX(sort_key), 0) AS k
           FROM queue_entries WHERE line_account_id = ? AND business_date = ?`,
      )
      .bind(input.lineAccountId, businessDate)
      .first<{ n: number; k: number }>();
    const ticketNo = (max?.n ?? 0) + 1;
    const sortKey = Math.max(max?.k ?? 0, ticketNo - 1) + 1;
    try {
      await db
        .prepare(
          `INSERT INTO queue_entries
             (id, line_account_id, business_date, ticket_no, friend_id, guest_label, party_size, seat_type,
              kind, status, sort_key, arrived_at, call_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, 0, ?, ?)`,
        )
        .bind(
          id,
          input.lineAccountId,
          businessDate,
          ticketNo,
          input.friendId,
          input.guestLabel ?? null,
          input.partySize,
          input.seatType ?? null,
          input.kind,
          sortKey,
          input.kind === 'remote' ? null : nowIso,
          nowIso,
          nowIso,
        )
        .run();
      const row = await getEntry(db, input.lineAccountId, id);
      if (row) return row;
    } catch (err) {
      if (!String(err).includes('UNIQUE')) throw err;
      // 同じ友だちがすでに並んでいる（二度押しなど）なら、番号を取り直さずに知らせる。
      if (input.friendId && (await findActiveEntryForFriend(db, input.lineAccountId, input.friendId, businessDate))) {
        throw new QueueAlreadyJoinedError();
      }
    }
  }
  throw new Error('queue_ticket_conflict');
}

// ─── お知らせ ──────────────────────────────────────────────

export type QueueNoticeKind = 'confirmed' | 'near' | 'passed' | 'called' | 'arrival_timeout';

export interface QueueNotice {
  kind: QueueNoticeKind;
  entryId: string;
  friendId: string;
  ticketNo: number;
  partySize: number;
  ahead: number;
  remoteNotArrived: boolean;
}

function notice(kind: QueueNoticeKind, e: QueueEntryRow, ahead: number): QueueNotice | null {
  if (!e.friend_id) return null;
  return {
    kind,
    entryId: e.id,
    friendId: e.friend_id,
    ticketNo: e.ticket_no,
    partySize: e.party_size,
    ahead,
    remoteNotArrived: e.kind === 'remote' && !e.arrived_at,
  };
}

export function ticketLabel(ticketNo: number): string {
  return String(ticketNo).padStart(3, '0');
}

export function renderQueueNotice(
  n: QueueNotice,
  ctx: { notifyBeforeGroups: number; arrivalTimeoutMinutes: number; statusUrl: string | null },
): string {
  const no = ticketLabel(n.ticketNo);
  const link = ctx.statusUrl ? `\n\n待ち状況：${ctx.statusUrl}` : '';
  switch (n.kind) {
    case 'confirmed': {
      const lines = [
        '順番待ちを受け付けました。',
        `番号：${no}（${n.partySize}名）`,
        `前に${n.ahead}組です。`,
      ];
      if (ctx.notifyBeforeGroups > 0) lines.push(`${ctx.notifyBeforeGroups}組前になったらお知らせします。`);
      if (n.remoteNotArrived) {
        lines.push('お店に着いたら、入口のQRを読んでください。');
        if (ctx.arrivalTimeoutMinutes > 0) {
          lines.push(`順番が来ても着いていない場合は次の方を先にご案内し、そこから${ctx.arrivalTimeoutMinutes}分たってもQRが読まれない場合は、自動でキャンセルになります。`);
        }
      }
      return lines.join('\n') + link;
    }
    case 'near':
      return (
        `まもなく順番です（前に${n.ahead}組）。番号：${no}` +
        (n.remoteNotArrived ? '\nまだの方は、お店に向かってください。着いたら入口のQRを読んでください。' : '') +
        link
      );
    case 'passed':
      return (
        `順番が来ましたが、まだ到着の確認ができていません（番号：${no}）。\n` +
        '次の方を先にご案内しています。着いて入口のQRを読めば、次にご案内します。' +
        (ctx.arrivalTimeoutMinutes > 0 ? `\n${ctx.arrivalTimeoutMinutes}分以内にQRが読まれない場合は、自動でキャンセルになります。` : '') +
        link
      );
    case 'called':
      return `お待たせしました。番号 ${no} の方、入口までお越しください。`;
    case 'arrival_timeout':
      return `到着の確認ができなかったため、順番待ち（番号：${no}）をキャンセルしました。`;
  }
}

/**
 * まだ「N組前」のお知らせを送っていない人のうち、N組前以内に入った人を選び、
 * 送った印を付ける（印を付けてから送るので、二重には送らない）。
 */
export async function collectNearNotices(
  db: D1Database,
  config: QueueConfig,
  businessDate: string,
  now: Date,
): Promise<QueueNotice[]> {
  const n = config.settings.notifyBeforeGroups;
  if (n <= 0) return [];
  const active = await listActiveEntries(db, config.lineAccountId, businessDate);
  const out: QueueNotice[] = [];
  for (const e of active) {
    if (e.status !== 'waiting' || e.near_notified_at || !e.friend_id || e.passed_at) continue;
    const ahead = groupsAhead(active, e);
    if (ahead > n) continue;
    const res = await db
      .prepare(`UPDATE queue_entries SET near_notified_at = ?, updated_at = ? WHERE id = ? AND near_notified_at IS NULL`)
      .bind(now.toISOString(), now.toISOString(), e.id)
      .run();
    if (res.meta.changes === 0) continue;
    const item = notice('near', e, ahead);
    if (item) out.push(item);
  }
  return out;
}

export function confirmationNotice(active: QueueEntryRow[], entry: QueueEntryRow): QueueNotice | null {
  return notice('confirmed', entry, groupsAhead(active, entry));
}

// ─── 店側の操作 ────────────────────────────────────────────

export type ActionError = 'not_found' | 'invalid_state' | 'not_arrived';

export interface ActionResult {
  entry: QueueEntryRow;
  notices: QueueNotice[];
  /** 来店・不在になったとき（マイルとタグの後処理に使う）。 */
  finished: 'visited' | 'no_show' | null;
}

async function setStatus(
  db: D1Database,
  e: QueueEntryRow,
  status: QueueEntryStatus,
  nowIso: string,
  extra: { cancelReason?: string | null } = {},
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE queue_entries SET status = ?, finished_at = ?, cancel_reason = ?, updated_at = ?
        WHERE id = ? AND status IN ('waiting', 'called')`,
    )
    .bind(status, nowIso, extra.cancelReason ?? null, nowIso, e.id)
    .run();
  return res.meta.changes > 0;
}

export async function applyQueueAction(
  db: D1Database,
  config: QueueConfig,
  entryId: string,
  action: QueueAction,
  now: Date,
): Promise<ActionResult | { error: ActionError }> {
  const entry = await getEntry(db, config.lineAccountId, entryId);
  if (!entry) return { error: 'not_found' };
  if (entry.status !== 'waiting' && entry.status !== 'called') return { error: 'invalid_state' };
  const nowIso = now.toISOString();
  const notices: QueueNotice[] = [];
  let finished: ActionResult['finished'] = null;

  switch (action) {
    case 'call': {
      if (entry.status !== 'waiting') return { error: 'invalid_state' };
      if (!entry.arrived_at) return { error: 'not_arrived' };
      await db
        .prepare(
          `UPDATE queue_entries SET status = 'called', called_at = ?, call_count = call_count + 1, updated_at = ?
            WHERE id = ? AND status = 'waiting'`,
        )
        .bind(nowIso, nowIso, entry.id)
        .run();
      // この人より前にいた未到着の人は「飛ばし中」にして知らせる。
      const active = await listActiveEntries(db, config.lineAccountId, entry.business_date);
      for (const e of active) {
        if (e.status !== 'waiting' || e.arrived_at || e.passed_at || e.sort_key >= entry.sort_key) continue;
        await db.prepare(`UPDATE queue_entries SET passed_at = ?, updated_at = ? WHERE id = ?`).bind(nowIso, nowIso, e.id).run();
        const item = notice('passed', e, 0);
        if (item) notices.push(item);
      }
      const called = notice('called', entry, 0);
      if (called) notices.push(called);
      break;
    }
    case 'recall': {
      if (entry.status !== 'called') return { error: 'invalid_state' };
      await db
        .prepare(`UPDATE queue_entries SET called_at = ?, call_count = call_count + 1, updated_at = ? WHERE id = ?`)
        .bind(nowIso, nowIso, entry.id)
        .run();
      const called = notice('called', entry, 0);
      if (called) notices.push(called);
      break;
    }
    case 'visit':
      if (!(await setStatus(db, entry, 'visited', nowIso))) return { error: 'invalid_state' };
      finished = 'visited';
      break;
    case 'no_show':
      if (!(await setStatus(db, entry, 'no_show', nowIso))) return { error: 'invalid_state' };
      finished = 'no_show';
      break;
    case 'cancel':
      if (!(await setStatus(db, entry, 'cancelled', nowIso, { cancelReason: 'staff' }))) return { error: 'invalid_state' };
      break;
    case 'defer': {
      if (entry.status !== 'waiting') return { error: 'invalid_state' };
      // すぐ後ろの「待っている」人と入れ替える。
      const active = await listActiveEntries(db, config.lineAccountId, entry.business_date);
      const behind = active.filter((e) => e.status === 'waiting' && e.sort_key > entry.sort_key);
      if (behind.length > 0) {
        const next = behind[0];
        const after = behind[1];
        const key = after ? (next.sort_key + after.sort_key) / 2 : next.sort_key + 1;
        await db.prepare(`UPDATE queue_entries SET sort_key = ?, updated_at = ? WHERE id = ?`).bind(key, nowIso, entry.id).run();
      }
      break;
    }
  }

  notices.push(...(await collectNearNotices(db, config, entry.business_date, now)));
  const updated = (await getEntry(db, config.lineAccountId, entry.id)) ?? entry;
  return { entry: updated, notices, finished };
}

/** 店頭QRを読んで「到着」にする。飛ばし中だった人は列の一番前に戻す。 */
export async function checkInEntry(
  db: D1Database,
  config: QueueConfig,
  entry: QueueEntryRow,
  now: Date,
): Promise<{ entry: QueueEntryRow; notices: QueueNotice[] }> {
  const nowIso = now.toISOString();
  if (!entry.arrived_at && entry.status === 'waiting') {
    let sortKey = entry.sort_key;
    if (entry.passed_at) {
      const active = await listActiveEntries(db, config.lineAccountId, entry.business_date);
      const waitingKeys = active.filter((e) => e.status === 'waiting' && e.id !== entry.id).map((e) => e.sort_key);
      sortKey = waitingKeys.length ? Math.min(...waitingKeys) - 1 : entry.sort_key;
    }
    await db
      .prepare(`UPDATE queue_entries SET arrived_at = ?, sort_key = ?, updated_at = ? WHERE id = ?`)
      .bind(nowIso, sortKey, nowIso, entry.id)
      .run();
  }
  const notices = await collectNearNotices(db, config, entry.business_date, now);
  return { entry: (await getEntry(db, config.lineAccountId, entry.id)) ?? entry, notices };
}

export async function cancelByCustomer(
  db: D1Database,
  config: QueueConfig,
  entry: QueueEntryRow,
  now: Date,
): Promise<{ cancelled: boolean; notices: QueueNotice[] }> {
  const cancelled = await setStatus(db, entry, 'cancelled', now.toISOString(), { cancelReason: 'customer' });
  const notices = cancelled ? await collectNearNotices(db, config, entry.business_date, now) : [];
  return { cancelled, notices };
}

// ─── 毎分の見回り ──────────────────────────────────────────

export interface MaintenanceResult {
  arrivalTimeouts: number;
  noShows: number;
  dayEnded: number;
  notices: Array<{ lineAccountId: string; notice: QueueNotice }>;
  noShowEntries: QueueEntryRow[];
}

/**
 * 1. 前の日のまま残った列を閉じる。
 * 2. 順番が来て飛ばされてから決まった時間たっても到着しない人を自動キャンセルする。
 *    順番が来る前は、どれだけ待っても自動ではキャンセルしない。
 * 3. 呼び出しから決まった時間たっても来ない人を「不在」にする。
 * 4. 列が動いたぶんの「N組前」のお知らせを集める。
 */
export async function runQueueMaintenance(db: D1Database, now: Date): Promise<MaintenanceResult> {
  const nowIso = now.toISOString();
  const today = jstBusinessDate(now);
  const result: MaintenanceResult = { arrivalTimeouts: 0, noShows: 0, dayEnded: 0, notices: [], noShowEntries: [] };

  const ended = await db
    .prepare(
      `UPDATE queue_entries SET status = 'cancelled', cancel_reason = 'day_end', finished_at = ?, updated_at = ?
        WHERE business_date < ? AND status IN ('waiting', 'called')`,
    )
    .bind(nowIso, nowIso, today)
    .run();
  result.dayEnded = ended.meta.changes;

  const accounts = await db
    .prepare(
      `SELECT DISTINCT line_account_id FROM queue_entries WHERE business_date = ? AND status IN ('waiting', 'called')`,
    )
    .bind(today)
    .all<{ line_account_id: string }>();

  for (const { line_account_id: accountId } of accounts.results ?? []) {
    const config = await loadQueueConfig(db, accountId);
    const s = config.settings;
    const active = await listActiveEntries(db, accountId, today);
    for (const e of active) {
      if (
        s.arrivalTimeoutMinutes > 0 &&
        e.status === 'waiting' &&
        e.kind === 'remote' &&
        !e.arrived_at &&
        e.passed_at &&
        now.getTime() - Date.parse(e.passed_at) >= s.arrivalTimeoutMinutes * 60_000
      ) {
        if (await setStatus(db, e, 'cancelled', nowIso, { cancelReason: 'arrival_timeout' })) {
          result.arrivalTimeouts++;
          const item = notice('arrival_timeout', e, 0);
          if (item) result.notices.push({ lineAccountId: accountId, notice: item });
        }
      } else if (
        s.noShowMinutes > 0 &&
        e.status === 'called' &&
        e.called_at &&
        now.getTime() - Date.parse(e.called_at) >= s.noShowMinutes * 60_000
      ) {
        if (await setStatus(db, e, 'no_show', nowIso)) {
          result.noShows++;
          result.noShowEntries.push(e);
        }
      }
    }
    for (const item of await collectNearNotices(db, config, today, now)) {
      result.notices.push({ lineAccountId: accountId, notice: item });
    }
  }
  return result;
}

// ─── 今日の実績 ────────────────────────────────────────────

export async function todayStats(
  db: D1Database,
  lineAccountId: string,
  businessDate: string,
): Promise<Record<QueueEntryStatus, number> & { total: number }> {
  const rows = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM queue_entries
        WHERE line_account_id = ? AND business_date = ? GROUP BY status`,
    )
    .bind(lineAccountId, businessDate)
    .all<{ status: QueueEntryStatus; n: number }>();
  const out = { waiting: 0, called: 0, visited: 0, no_show: 0, cancelled: 0, total: 0 };
  for (const r of rows.results ?? []) {
    out[r.status] = Number(r.n);
    out.total += Number(r.n);
  }
  return out;
}
