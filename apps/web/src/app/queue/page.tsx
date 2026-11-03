'use client'

// 順番待ち：今日の列（店のタブレットで開いておく画面）。
// 到着済みの人だけ呼べる。前にいた未到着の人は「飛ばし中」になり、到着すると一番前に戻る。
// 処理の中身は Worker の services/queue.ts。

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { queueApi, type QueueAction, type QueueEntry, type QueueToday } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Input } from '@cloudflare/kumo/components/input'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Loader } from '@cloudflare/kumo/components/loader'

const POLL_MS = 10_000

const KIND_LABEL: Record<QueueEntry['kind'], string> = { walk_in: 'その場', remote: '事前', staff: '代理' }

function statusOf(e: QueueEntry): { label: string; className: string } {
  if (e.status === 'called') return { label: e.call_count > 1 ? `呼び出し中（${e.call_count}回目）` : '呼び出し中', className: 'bg-orange-50 text-orange-800 border-orange-200' }
  if (!e.arrived) return { label: e.passed ? '向かっている（飛ばし中）' : '向かっている', className: 'bg-gray-50 text-gray-700 border-gray-200' }
  return { label: '到着済み', className: 'bg-emerald-50 text-emerald-800 border-emerald-200' }
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000))
}

export default function QueuePage() {
  const { selectedAccountId } = useAccount()
  const [today, setToday] = useState<QueueToday | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [party, setParty] = useState('2')
  const [guest, setGuest] = useState('')

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    try {
      setToday(await queueApi.today(selectedAccountId))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [selectedAccountId])

  useEffect(() => {
    setToday(null)
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  async function act(entry: QueueEntry, action: QueueAction) {
    if (!selectedAccountId) return
    if (action === 'cancel' && !window.confirm(`${entry.ticket_label} の受付を取り消しますか？`)) return
    setBusy(`${entry.id}:${action}`)
    try {
      await queueApi.act(selectedAccountId, entry.id, action)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function toggle(key: 'is_open' | 'remote_open', value: boolean) {
    if (!selectedAccountId) return
    setBusy(key)
    try {
      await queueApi.saveSettings(selectedAccountId, { [key]: value })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function addEntry() {
    if (!selectedAccountId) return
    const n = Number(party)
    if (!Number.isInteger(n) || n < 1) {
      setError('人数は1以上の数字で入れてください')
      return
    }
    setBusy('add')
    try {
      await queueApi.addEntry(selectedAccountId, { party_size: n, guest_label: guest.trim() || null })
      setGuest('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const button = (entry: QueueEntry, action: QueueAction, label: string, variant: 'primary' | 'secondary' | 'secondary-destructive') => (
    <Button
      key={action}
      type="button"
      size="sm"
      variant={variant}
      loading={busy === `${entry.id}:${action}`}
      disabled={busy !== null}
      onClick={() => act(entry, action)}
    >
      {label}
    </Button>
  )

  return (
    <div>
      <Header
        title="順番待ち"
        description="今日の列。到着済みの人だけ呼び出せます"
        action={
          <div className="flex gap-2">
            <Link href="/queue/monitor" className="text-sm text-emerald-700 hover:underline px-2 py-1">モニター表示</Link>
            <Link href="/queue/settings" className="text-sm text-emerald-700 hover:underline px-2 py-1">設定・店頭QR</Link>
          </div>
        }
      />
      {!selectedAccountId ? (
        <Empty title="アカウントが未選択です" description="サイドバーで操作するアカウントを選択してください。" />
      ) : !today ? (
        error ? <Banner variant="error" title="読み込めませんでした" description={error} /> : <LayerCard className="p-12"><Loader className="mx-auto" /></LayerCard>
      ) : (
        <div className="space-y-4">
          <LayerCard className="p-4 flex flex-wrap items-center gap-3">
            <div className="text-lg font-bold">
              待ち {today.waiting_groups}組
              <span className="ml-2 text-sm font-normal text-gray-500">
                （到着済み {today.entries.filter((e) => e.status === 'waiting' && e.arrived).length}・向かっている {today.entries.filter((e) => e.status === 'waiting' && !e.arrived).length}）
              </span>
            </div>
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${today.is_open ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-800 border-red-200'}`}>
              {today.is_open ? '受付中' : '受付停止中'}
            </span>
            <div className="flex-1" />
            <Button type="button" size="sm" variant="secondary" loading={busy === 'remote_open'} onClick={() => toggle('remote_open', !today.remote_open)}>
              {today.remote_open ? '事前受付を止める' : '事前受付を再開'}
            </Button>
            <Button type="button" size="sm" variant={today.is_open ? 'secondary-destructive' : 'primary'} loading={busy === 'is_open'} onClick={() => toggle('is_open', !today.is_open)}>
              {today.is_open ? '受付をすべて止める' : '受付を再開'}
            </Button>
          </LayerCard>

          <LayerCard className="p-4 flex flex-wrap items-end gap-3">
            <div className="w-24"><Input label="人数" type="number" min={1} value={party} onChange={(e) => setParty(e.target.value)} /></div>
            <div className="w-56"><Input label="お名前など（任意）" value={guest} maxLength={40} onChange={(e) => setGuest(e.target.value)} /></div>
            <Button type="button" variant="primary" loading={busy === 'add'} onClick={addEntry}>＋ 代わりに受付</Button>
            <p className="text-xs text-gray-500">LINE を使わない人の分です。到着済みとして列に入ります。</p>
          </LayerCard>

          {error ? <Banner size="sm" variant="error" title="うまくいきませんでした" description={error} /> : null}

          <LayerCard className="overflow-x-auto">
            {today.entries.length === 0 ? (
              <p className="p-8 text-center text-sm text-gray-500">いま待っている人はいません</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-600">
                  <tr>
                    <th className="px-4 py-2">番号</th>
                    <th className="px-4 py-2">人数</th>
                    <th className="px-4 py-2">席</th>
                    <th className="px-4 py-2">受付</th>
                    <th className="px-4 py-2">状態</th>
                    <th className="px-4 py-2">待ち</th>
                    <th className="px-4 py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {today.entries.map((e) => {
                    const st = statusOf(e)
                    return (
                      <tr key={e.id} className="border-t border-gray-100 align-middle">
                        <td className="px-4 py-3">
                          <div className="text-lg font-bold">{e.ticket_label}</div>
                          {e.guest_label ? <div className="text-xs text-gray-500">{e.guest_label}</div> : null}
                        </td>
                        <td className="px-4 py-3">{e.party_size}名</td>
                        <td className="px-4 py-3">{e.seat_type ?? '—'}</td>
                        <td className="px-4 py-3 text-gray-600">{KIND_LABEL[e.kind]}{e.has_line ? '' : '（LINEなし）'}</td>
                        <td className="px-4 py-3"><span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${st.className}`}>{st.label}</span></td>
                        <td className="px-4 py-3 text-gray-600">{minutesSince(e.created_at)}分</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            {e.status === 'called' ? (
                              <>
                                {button(e, 'visit', '来店（＋マイル）', 'primary')}
                                {button(e, 'recall', '再呼び出し', 'secondary')}
                                {button(e, 'no_show', '不在', 'secondary-destructive')}
                              </>
                            ) : e.arrived ? (
                              <>
                                {button(e, 'call', '呼び出し', 'primary')}
                                {button(e, 'defer', '後回し', 'secondary')}
                                {button(e, 'cancel', '取り消し', 'secondary-destructive')}
                              </>
                            ) : (
                              <>
                                <span className="text-xs text-gray-500 self-center">到着（QR）を待っています</span>
                                {button(e, 'cancel', '取り消し', 'secondary-destructive')}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </LayerCard>

          <LayerCard className="p-4 grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
            <div><div className="text-xs text-gray-500">今日の受付</div><div className="text-xl font-bold">{today.stats.total}</div></div>
            <div><div className="text-xs text-gray-500">来店</div><div className="text-xl font-bold">{today.stats.visited}</div></div>
            <div><div className="text-xs text-gray-500">不在</div><div className="text-xl font-bold">{today.stats.no_show}</div></div>
            <div><div className="text-xs text-gray-500">キャンセル</div><div className="text-xl font-bold">{today.stats.cancelled}</div></div>
            <div className="col-span-2 sm:col-span-1 text-xs text-gray-500 leading-5">来店でマイルと来店タグ、不在で不在タグが付きます（設定で選んだタグ）。</div>
          </LayerCard>
        </div>
      )}
    </div>
  )
}
