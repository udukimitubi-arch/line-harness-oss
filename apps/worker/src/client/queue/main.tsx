// 順番待ち（LIFF）の画面。main.ts の ?page=queue から動的 import される。
//
//   店頭QR（&t=合言葉）から開いた … 受付していなければ「その場で受付」、事前受付済みなら「到着」にする。
//   リッチメニューなどから開いた … 受付していなければ「事前に受付」、受付済みなら待ち状況を出す。

import { StrictMode, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BLOCK_MESSAGES, QueueApiError, createQueueApi, type QueueContext, type QueueEntry, type QueueStatus } from './api.js';
import '../salon-booking/styles.css';

const ACCENT = '#0F6B53';
const POLL_MS = 20_000;

function errorText(err: unknown): string {
  if (err instanceof QueueApiError) return BLOCK_MESSAGES[err.code] ?? `うまくいきませんでした（${err.code}）`;
  return 'うまくいきませんでした。通信状態を確かめて、もう一度お試しください。';
}

function Card({ children }: { children: ReactNode }) {
  return <div className="bg-white rounded-2xl border border-[#E2E5E1] p-5">{children}</div>;
}

function Choice({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className="h-12 rounded-xl text-[15px] font-medium"
      style={selected
        ? { background: '#E7F3EE', border: `2px solid ${ACCENT}`, color: '#0A4F3D', fontWeight: 700 }
        : { background: '#fff', border: '1px solid #D5DAD6', color: '#1C2321' }}
    >
      {children}
    </button>
  );
}

function JoinForm({ status, token, onJoined, api }: {
  status: QueueStatus;
  token: string | null;
  onJoined: (e: QueueEntry) => void;
  api: ReturnType<typeof createQueueApi>;
}) {
  const kind: 'walk_in' | 'remote' = status.token_valid ? 'walk_in' : 'remote';
  const block = kind === 'walk_in' ? status.walk_in_block : status.remote_block;
  const s = status.settings;
  const [party, setParty] = useState(2);
  const [seat, setSeat] = useState<string | null>(s.seat_types[0] ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sizes = Array.from({ length: s.max_party_size }, (_, i) => i + 1);

  async function submit() {
    setSending(true);
    setError(null);
    try {
      const { entry } = await api.join({ kind, party_size: party, seat_type: seat, token });
      onJoined(entry);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="text-[13px] text-[#5A635F]">{kind === 'walk_in' ? 'その場で受付' : '事前に受付（これから向かう）'}</div>
        <div className="mt-1 text-[15px]">
          いま <strong style={{ color: ACCENT, fontSize: 20 }}>{status.waiting_groups}組</strong> 待っています
        </div>
      </Card>

      {block ? (
        <Card><p className="text-[15px] leading-7">{BLOCK_MESSAGES[block]}</p></Card>
      ) : (
        <>
          <Card>
            <div className="text-[14px] font-bold mb-3">人数</div>
            <div className="grid grid-cols-5 gap-2">
              {sizes.map((n) => (
                <Choice key={n} selected={party === n} onClick={() => setParty(n)}>
                  {n === s.max_party_size && s.max_party_size > 1 ? `${n}+` : n}
                </Choice>
              ))}
            </div>
            {s.seat_types.length > 0 ? (
              <>
                <div className="text-[14px] font-bold mt-5 mb-3">席の希望</div>
                <div className="grid grid-cols-3 gap-2">
                  {s.seat_types.map((t) => (
                    <Choice key={t} selected={seat === t} onClick={() => setSeat(t)}>{t}</Choice>
                  ))}
                </div>
              </>
            ) : null}
          </Card>

          {kind === 'remote' ? (
            <div className="rounded-xl p-4 text-[13px] leading-6" style={{ background: '#FFF4EA', color: '#5B3415' }}>
              <strong>事前受付のご注意</strong><br />
              お店に着いたら、入口のQRを読んでください。<br />
              順番が来ても着いていない場合は、次の方を先にご案内します。着いてQRを読めば、次にご案内します。
              {s.arrival_timeout_minutes > 0 ? <><br />順番が来てから{s.arrival_timeout_minutes}分たってもQRが読まれない場合は、自動でキャンセルになります。</> : null}
            </div>
          ) : null}

          {error ? <p className="text-[14px] text-[#A12A1F]">{error}</p> : null}
          <button
            type="button"
            onClick={submit}
            disabled={sending}
            className="w-full h-14 rounded-2xl text-white text-[17px] font-bold disabled:opacity-60"
            style={{ background: ACCENT }}
          >
            {sending ? '受付しています…' : 'この内容で受付する'}
          </button>
        </>
      )}
    </div>
  );
}

function TicketView({ entry, status, justArrived, onCancel, cancelling }: {
  entry: QueueEntry;
  status: QueueStatus | null;
  justArrived: boolean;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const called = entry.status === 'called';
  const notify = status?.settings.notify_before_groups ?? 3;
  return (
    <div className="space-y-4">
      {justArrived ? (
        <div className="rounded-xl p-4 text-[14px] font-bold" style={{ background: '#E7F3EE', color: '#0A4F3D' }}>到着を確認しました</div>
      ) : null}
      <Card>
        <div className="flex flex-col items-center gap-1">
          <div className="text-[14px] text-[#5A635F]">あなたの番号</div>
          <div className="text-[64px] font-bold leading-none">{entry.ticket_label}</div>
          {called ? (
            <div className="mt-4 rounded-xl px-4 py-3 text-center text-[17px] font-bold" style={{ background: '#FFF4EA', color: '#8A3F0F' }}>
              お呼びしています。入口までお越しください。
            </div>
          ) : entry.passed && !entry.arrived ? (
            <div className="mt-4 rounded-xl px-4 py-3 text-center text-[14px] leading-6" style={{ background: '#FFF4EA', color: '#5B3415' }}>
              順番が来ています。着いて入口のQRを読めば、次にご案内します。
              {(status?.settings.arrival_timeout_minutes ?? 0) > 0 ? `${status?.settings.arrival_timeout_minutes}分以内にQRが読まれない場合は、自動でキャンセルになります。` : ''}
            </div>
          ) : (
            <div className="mt-3 flex items-baseline gap-1.5">
              <span className="text-[15px]">前に</span>
              <span className="text-[40px] font-bold" style={{ color: ACCENT }}>{entry.groups_ahead}</span>
              <span className="text-[15px]">組</span>
            </div>
          )}
          <div
            className="mt-2 rounded-full px-3 py-1 text-[13px] font-bold"
            style={entry.arrived ? { background: '#E7F3EE', color: '#0A4F3D' } : { background: '#EEF0F3', color: '#3D4652' }}
          >
            {entry.arrived ? '到着済み' : '向かっています（まだ到着していません）'}
          </div>
        </div>
      </Card>
      <Card>
        <div className="grid grid-cols-2 gap-3 text-[14px]">
          <div><div className="text-[12px] text-[#5A635F]">人数</div><div className="font-bold">{entry.party_size}名</div></div>
          {entry.seat_type ? <div><div className="text-[12px] text-[#5A635F]">席の希望</div><div className="font-bold">{entry.seat_type}</div></div> : null}
        </div>
      </Card>
      {!called ? (
        <p className="text-[13px] leading-6 text-[#3D4642] px-1">
          {notify > 0 ? `${notify}組前になったらLINEでお知らせします。` : ''}この画面は閉じても大丈夫です。
          {!entry.arrived ? ' お店に着いたら、入口のQRをLINEのカメラで読んでください。' : ''}
        </p>
      ) : null}
      {!called ? (
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="w-full h-12 rounded-2xl bg-white text-[15px] font-medium disabled:opacity-60"
          style={{ border: '1px solid #D5DAD6', color: '#A12A1F' }}
        >
          {cancelling ? 'キャンセルしています…' : '受付をキャンセルする'}
        </button>
      ) : null}
    </div>
  );
}

function App({ ctx }: { ctx: QueueContext }) {
  const api = useMemo(() => createQueueApi(ctx), [ctx]);
  const token = useMemo(() => new URLSearchParams(window.location.search).get('t'), []);
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [entry, setEntry] = useState<QueueEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [justArrived, setJustArrived] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const refresh = useCallback(async () => {
    const [st, me] = await Promise.all([api.status(token), api.me()]);
    setStatus(st);
    setEntry(me.entry);
    return me.entry;
  }, [api, token]);

  useEffect(() => {
    (async () => {
      try {
        const current = await refresh();
        // 事前受付済みの人が店頭QRから開いたら、そのまま「到着」にする。
        if (current && token && !current.arrived) {
          const { entry: arrived } = await api.checkin(token);
          setEntry(arrived);
          setJustArrived(true);
        }
      } catch (err) {
        setError(errorText(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [api, refresh, token]);

  useEffect(() => {
    if (!entry) return;
    const id = setInterval(() => { refresh().catch(() => undefined); }, POLL_MS);
    return () => clearInterval(id);
  }, [entry, refresh]);

  async function cancel() {
    if (!window.confirm('受付をキャンセルしますか？')) return;
    setCancelling(true);
    try {
      await api.cancel();
      setEntry(null);
      setCancelled(true);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="min-h-screen sb-fade-in" style={{ background: '#F6F7F5', color: '#1C2321' }}>
      <header className="px-4 py-3 text-white text-center font-bold" style={{ background: ACCENT, fontSize: 15 }}>
        順番待ち
      </header>
      <main className="max-w-md mx-auto px-4 py-4 pb-24 space-y-4">
        {loading ? <p className="text-center text-[14px] text-[#5A635F] py-10">読み込んでいます…</p> : null}
        {error ? <Card><p className="text-[14px] text-[#A12A1F]">{error}</p></Card> : null}
        {cancelled && !entry ? <Card><p className="text-[14px]">受付をキャンセルしました。</p></Card> : null}
        {!loading && entry ? (
          <TicketView entry={entry} status={status} justArrived={justArrived} onCancel={cancel} cancelling={cancelling} />
        ) : null}
        {!loading && !entry && status ? (
          <JoinForm status={status} token={token} api={api} onJoined={(e) => { setEntry(e); setError(null); }} />
        ) : null}
      </main>
    </div>
  );
}

let _root: Root | null = null;

export function mountQueue(container: HTMLElement, ctx: QueueContext): void {
  document.body.classList.add('sb-active');
  if (_root) {
    _root.unmount();
    _root = null;
  }
  container.innerHTML = '';
  _root = createRoot(container);
  _root.render(
    <StrictMode>
      <App ctx={ctx} />
    </StrictMode>,
  );
}
