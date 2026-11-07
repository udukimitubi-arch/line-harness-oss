'use client'

// まとめて受信箱：登録しているすべての LINE 公式アカウントの会話を、1つの画面で見て返信する。
//
// 送り間違いを防ぐための決まり：
//   - 返信は、その会話の相手が友だちになっているアカウントからしか送られない（Worker が決める）。
//   - 画面に出している送信元アカウントを expectedLineAccountId として送り、実際と違えば Worker が送らない。
//   - 送る前に「◯◯から△△さんへ」の確認をはさむ。
//   - 下書きは会話ごとに分けて持つ。会話を切り替えても、書きかけの文が別の相手に移らない。
// いつもの「個別チャット」（/chats）はこのまま。こちらは別の画面として置く。

import { useCallback, useEffect, useMemo, useState } from 'react'
import Header from '@/components/layout/header'
import { api, ApiError } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Checkbox } from '@cloudflare/kumo/components/checkbox'
import { Empty } from '@cloudflare/kumo/components/empty'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Loader } from '@cloudflare/kumo/components/loader'

const POLL_MS = 20_000

type InboxChat = {
  id: string
  friendId: string
  friendName: string
  friendPictureUrl: string | null
  lineAccountId: string | null
  status: 'unread' | 'in_progress' | 'resolved'
  lastMessageAt: string | null
  lastMessageContent: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  lastMessageType: string | null
}

type InboxMessage = {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

type InboxDetail = InboxChat & { messages: InboxMessage[] }

// アカウントごとの色（文字と背景の明るさも変えて、色だけに頼らない）。
const PALETTE = [
  { bg: '#E7F0FD', fg: '#123E7C', border: '#9DBDF0' },
  { bg: '#FDEDE4', fg: '#7A2E0B', border: '#F0B597' },
  { bg: '#E6F4EC', fg: '#0E5132', border: '#94CFAE' },
  { bg: '#F2E9FB', fg: '#4B1D7A', border: '#C4A4EA' },
  { bg: '#FFF6D6', fg: '#5E4500', border: '#E6CF7A' },
  { bg: '#FCE7F1', fg: '#7A1645', border: '#EDA3C5' },
]
const UNKNOWN = { bg: '#F1F1F1', fg: '#333333', border: '#BDBDBD' }

function formatTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function messageText(type: string | null, content: string | null): string {
  if (type === 'text' || type === null) return content ?? ''
  if (type === 'image') return '［画像］'
  if (type === 'sticker') return '［スタンプ］'
  if (type === 'flex') return '［カード型メッセージ］'
  return `［${type}］`
}

export default function InboxPage() {
  const { accounts } = useAccount()
  const [chats, setChats] = useState<InboxChat[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [unansweredOnly, setUnansweredOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<InboxDetail | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const accountInfo = useMemo(() => {
    const map = new Map<string, { name: string; color: typeof UNKNOWN }>()
    accounts.forEach((a, i) => map.set(a.id, { name: a.displayName || a.name, color: PALETTE[i % PALETTE.length] }))
    return map
  }, [accounts])

  const info = useCallback(
    (id: string | null) => (id && accountInfo.get(id)) || { name: 'アカウント不明', color: UNKNOWN },
    [accountInfo],
  )

  const loadList = useCallback(async () => {
    try {
      const res = await api.chats.list({ unansweredOnly, limit: 300 })
      if (!res.success) throw new Error(res.error)
      setChats(res.data as unknown as InboxChat[])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [unansweredOnly])

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await api.chats.get(id)
      if (!res.success) throw new Error(res.error)
      setDetail(res.data as unknown as InboxDetail)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    loadList()
    const t = setInterval(loadList, POLL_MS)
    return () => clearInterval(t)
  }, [loadList])

  useEffect(() => {
    setDetail(null)
    setConfirming(false)
    setNotice(null)
    if (!selectedId) return
    loadDetail(selectedId)
    const t = setInterval(() => loadDetail(selectedId), POLL_MS)
    return () => clearInterval(t)
  }, [selectedId, loadDetail])

  const visible = (chats ?? []).filter((c) => !hidden.has(c.lineAccountId ?? ''))
  const draft = selectedId ? drafts[selectedId] ?? '' : ''
  const sender = detail ? info(detail.lineAccountId) : null

  function toggleAccount(id: string) {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function send() {
    if (!detail || !selectedId || !draft.trim()) return
    setSending(true)
    setNotice(null)
    try {
      await api.chats.send(detail.friendId, { content: draft, messageType: 'text', expectedLineAccountId: detail.lineAccountId })
      setDrafts((prev) => ({ ...prev, [selectedId]: '' }))
      setConfirming(false)
      setNotice('送りました')
      await Promise.all([loadDetail(selectedId), loadList()])
    } catch (e) {
      setConfirming(false)
      if (e instanceof ApiError && e.status === 409) {
        setNotice('送信元のアカウントが画面の表示と違ったため、送りませんでした。画面を読み込み直してから、もう一度確かめてください。')
        loadDetail(selectedId)
      } else {
        setNotice(`送れませんでした（${e instanceof Error ? e.message : String(e)}）`)
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <div>
      <Header
        title="まとめて受信箱"
        description="すべての LINE 公式アカウントの会話を1つの画面で。返信は、その会話のアカウントからだけ送られます"
      />

      <LayerCard className="p-4 mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500 mr-1">表示するアカウント</span>
        {accounts.map((a) => {
          const c = info(a.id).color
          const on = !hidden.has(a.id)
          return (
            <button
              key={a.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggleAccount(a.id)}
              className="rounded-full px-3 py-1 text-xs font-bold border"
              style={on ? { background: c.bg, color: c.fg, borderColor: c.border } : { background: '#fff', color: '#6B6B6B', borderColor: '#D4D4D4', textDecoration: 'line-through' }}
            >
              {info(a.id).name}
            </button>
          )
        })}
        <div className="flex-1" />
        <Checkbox label="未対応だけ" checked={unansweredOnly} onCheckedChange={(v) => setUnansweredOnly(Boolean(v))} />
      </LayerCard>

      {error ? <Banner size="sm" variant="error" title="読み込めませんでした" description={error} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <LayerCard className="overflow-hidden">
          {chats === null ? (
            <div className="p-10"><Loader className="mx-auto" /></div>
          ) : visible.length === 0 ? (
            <p className="p-8 text-center text-sm text-gray-500">表示する会話はありません</p>
          ) : (
            <ul className="max-h-[70vh] overflow-y-auto divide-y divide-gray-100">
              {visible.map((c) => {
                const a = info(c.lineAccountId)
                const active = c.id === selectedId
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={`w-full text-left px-4 py-3 flex gap-3 ${active ? 'bg-gray-100' : 'hover:bg-gray-50'}`}
                      style={{ borderLeft: `6px solid ${a.color.border}` }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-bold text-sm">{c.friendName}</span>
                          {c.lastMessageDirection === 'incoming' ? <span className="rounded bg-red-50 px-1.5 text-[10px] font-bold text-red-700">受信</span> : null}
                          <span className="ml-auto shrink-0 text-[11px] text-gray-500">{formatTime(c.lastMessageAt)}</span>
                        </div>
                        <span className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-bold" style={{ background: a.color.bg, color: a.color.fg }}>{a.name}</span>
                        <p className="mt-1 truncate text-xs text-gray-600">{messageText(c.lastMessageType, c.lastMessageContent)}</p>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </LayerCard>

        <LayerCard className="flex min-h-[60vh] flex-col">
          {!selectedId ? (
            <Empty title="会話を選んでください" description="左の一覧から会話を選ぶと、ここに表示されます。" />
          ) : !detail || !sender ? (
            <div className="p-10"><Loader className="mx-auto" /></div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-3">
                <div className="font-bold">{detail.friendName}</div>
                <span className="rounded px-2 py-0.5 text-xs font-bold" style={{ background: sender.color.bg, color: sender.color.fg }}>{sender.name} の友だち</span>
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4" style={{ maxHeight: '50vh' }}>
                {detail.messages.slice(-100).map((m) => (
                  <div key={m.id} className={`flex ${m.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm"
                      style={m.direction === 'outgoing' ? { background: sender.color.bg, color: sender.color.fg } : { background: '#F3F4F6', color: '#1F2937' }}
                    >
                      {messageText(m.messageType, m.content)}
                      <div className="mt-1 text-[10px] opacity-70">{formatTime(m.createdAt)}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-3 border-t border-gray-100 p-4">
                <div className="rounded-lg px-3 py-2 text-sm" style={{ background: sender.color.bg, color: sender.color.fg, border: `1px solid ${sender.color.border}` }}>
                  送信元：<strong>{sender.name}</strong>　→　宛先：<strong>{detail.friendName}</strong> さん
                </div>
                {detail.lineAccountId === null ? (
                  <Banner size="sm" variant="alert" title="この会話は、どのアカウントの友だちか記録がありません" description="送り先のアカウントを確かめられないため、ここからは送れません。個別チャットから送ってください。" />
                ) : null}
                <textarea
                  aria-label="返信の文"
                  className="w-full rounded-lg border border-gray-300 p-3 text-sm"
                  rows={3}
                  value={draft}
                  disabled={sending || confirming}
                  onChange={(e) => {
                    const v = e.target.value
                    setNotice(null)
                    setDrafts((prev) => ({ ...prev, [selectedId]: v }))
                  }}
                  placeholder={`${detail.friendName} さんへの返信`}
                />
                {confirming ? (
                  <div className="rounded-lg border-2 p-3" style={{ borderColor: sender.color.border, background: sender.color.bg }}>
                    <p className="text-sm font-bold" style={{ color: sender.color.fg }}>
                      「{sender.name}」から {detail.friendName} さんへ送ります。よろしいですか？
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button type="button" variant="primary" loading={sending} onClick={send}>送る</Button>
                      <Button type="button" variant="secondary" disabled={sending} onClick={() => setConfirming(false)}>戻る</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-3">
                    <span className="text-xs text-gray-500">送信は1通ごとに、このアカウントの月の送信数を使います</span>
                    <Button type="button" variant="primary" disabled={!draft.trim() || detail.lineAccountId === null} onClick={() => setConfirming(true)}>
                      送信の確認へ
                    </Button>
                  </div>
                )}
                {notice ? <p className="text-sm text-gray-700">{notice}</p> : null}
              </div>
            </>
          )}
        </LayerCard>
      </div>
    </div>
  )
}
