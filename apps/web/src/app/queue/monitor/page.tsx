'use client'

// 店内モニター用の表示。ログインしたブラウザ（テレビにつないだ端末など）で開いておく。
// 「お呼び出し中」と「次のご案内（到着済みの人）」を大きく出す。

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { queueApi, type QueueToday } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'

const POLL_MS = 5_000

export default function QueueMonitorPage() {
  const { selectedAccountId } = useAccount()
  const [today, setToday] = useState<QueueToday | null>(null)
  const [offline, setOffline] = useState(false)

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    try {
      setToday(await queueApi.today(selectedAccountId))
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [selectedAccountId])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const called = today?.entries.filter((e) => e.status === 'called') ?? []
  const next = today?.entries.filter((e) => e.status === 'waiting' && e.arrived).slice(0, 6) ?? []

  return (
    <div className="fixed inset-0 z-50 flex flex-col gap-6 p-10" style={{ background: '#142420', color: '#F3F6F4' }}>
      <div className="flex items-baseline gap-5">
        <div className="text-3xl font-bold">順番待ち</div>
        <div className="flex-1" />
        {offline ? <div className="text-base text-orange-300">通信できていません</div> : null}
        <div className="text-2xl" style={{ color: '#B9C7C1' }}>
          待ち <strong className="text-4xl" style={{ color: '#F3F6F4' }}>{today?.waiting_groups ?? '—'}</strong> 組
        </div>
        <button type="button" className="text-sm underline" style={{ color: '#B9C7C1' }} onClick={() => document.documentElement.requestFullscreen?.()}>全画面</button>
        <Link href="/queue" className="text-sm underline" style={{ color: '#B9C7C1' }}>閉じる</Link>
      </div>
      <div className="flex flex-1 gap-8 min-h-0">
        <section className="flex flex-[3] flex-col gap-5 rounded-3xl p-8" style={{ background: '#1F3630' }}>
          <h2 className="text-3xl font-bold" style={{ color: '#FFC58F' }}>お呼び出し中</h2>
          <div className="grid grid-cols-2 gap-5">
            {called.length === 0 ? <p className="text-2xl" style={{ color: '#D3DED9' }}>—</p> : null}
            {called.map((e) => (
              <div key={e.id} className="flex h-44 items-center justify-center rounded-2xl text-8xl font-bold" style={{ background: '#F3F6F4', color: '#142420' }}>
                {e.ticket_label}
              </div>
            ))}
          </div>
          <p className="mt-auto text-xl" style={{ color: '#D3DED9' }}>番号を呼ばれた方は、入口までお越しください。</p>
        </section>
        <section className="flex flex-[2] flex-col gap-4 rounded-3xl p-8" style={{ background: '#1F3630' }}>
          <h2 className="text-2xl font-bold" style={{ color: '#D3DED9' }}>次のご案内</h2>
          <div className="grid grid-cols-2 gap-3">
            {next.map((e) => (
              <div key={e.id} className="flex h-20 items-center justify-center rounded-xl text-4xl font-bold" style={{ border: '2px solid #4C6A60' }}>
                {e.ticket_label}
              </div>
            ))}
          </div>
          <p className="mt-auto text-lg leading-8" style={{ color: '#D3DED9' }}>LINEで受付した方は、入口のQRを読むと到着になります。</p>
        </section>
      </div>
    </div>
  )
}
