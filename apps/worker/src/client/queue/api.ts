// 順番待ち（LIFF）の API。main.ts が liff.init を済ませ、id_token を渡してくる。

export interface QueueContext {
  liffId: string;
  idToken: string;
}

export type BlockReason =
  | 'closed'
  | 'outside_hours'
  | 'remote_closed'
  | 'remote_not_started'
  | 'remote_full'
  | 'invalid_token';

export interface QueueStatus {
  open: boolean;
  waiting_groups: number;
  token_valid: boolean;
  walk_in_block: BlockReason | null;
  remote_block: BlockReason | null;
  settings: {
    max_party_size: number;
    seat_types: string[];
    notify_before_groups: number;
    arrival_timeout_minutes: number;
    open_time: string | null;
    close_time: string | null;
  };
}

export interface QueueEntry {
  id: string;
  ticket_no: number;
  ticket_label: string;
  party_size: number;
  seat_type: string | null;
  kind: 'walk_in' | 'remote' | 'staff';
  status: 'waiting' | 'called' | 'visited' | 'no_show' | 'cancelled';
  arrived: boolean;
  passed: boolean;
  groups_ahead: number;
  created_at: string;
}

export class QueueApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

function url(path: string, ctx: QueueContext, extra: Record<string, string> = {}): string {
  const u = new URL(path, window.location.origin);
  u.searchParams.set('liffId', ctx.liffId);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.pathname + u.search;
}

async function request<T>(ctx: QueueContext, path: string, init: RequestInit = {}, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url(path, ctx, extra), {
    ...init,
    headers: { Authorization: `Bearer ${ctx.idToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new QueueApiError(res.status, body.error ?? `http_${res.status}`);
  return body as T;
}

export function createQueueApi(ctx: QueueContext) {
  return {
    status: (token: string | null) =>
      request<QueueStatus>(ctx, '/api/liff/queue/status', {}, token ? { t: token } : {}),
    me: () => request<{ entry: QueueEntry | null }>(ctx, '/api/liff/queue/me'),
    join: (body: { kind: 'walk_in' | 'remote'; party_size: number; seat_type?: string | null; token?: string | null }) =>
      request<{ entry: QueueEntry }>(ctx, '/api/liff/queue/entries', { method: 'POST', body: JSON.stringify(body) }),
    checkin: (token: string) =>
      request<{ entry: QueueEntry }>(ctx, '/api/liff/queue/checkin', { method: 'POST', body: JSON.stringify({ token }) }),
    cancel: () => request<{ ok: true }>(ctx, '/api/liff/queue/cancel', { method: 'POST', body: '{}' }),
  };
}

export const BLOCK_MESSAGES: Record<BlockReason | string, string> = {
  closed: 'ただいま受付を止めています。',
  outside_hours: '受付時間外です。',
  remote_closed: 'ただいま事前の受付を止めています。お店に着いてから入口のQRで受付してください。',
  remote_not_started: '事前の受付はまだ始まっていません。',
  remote_full: '事前の受付がいっぱいです。お店に着いてから入口のQRで受付してください。',
  invalid_token: 'お店の入口のQRを読んでから受付してください。',
  already_in_queue: 'すでに受付しています。',
  not_following: '友だち追加（ブロック解除）をしてからご利用ください。',
  not_in_queue: '受付が見つかりませんでした。',
};
