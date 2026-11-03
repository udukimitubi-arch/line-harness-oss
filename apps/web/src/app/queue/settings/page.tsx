'use client'

// 順番待ちの設定と店頭QR。保存先は Worker の /api/queue/admin/settings（services/queue.ts）。

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import QRCode from 'qrcode'
import type { Tag } from '@line-crm/shared'
import Header from '@/components/layout/header'
import { api, queueApi, queueCheckinUrl, queueRemoteUrl, type QueueAdminSettings, type QueueSettings } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Checkbox } from '@cloudflare/kumo/components/checkbox'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Input } from '@cloudflare/kumo/components/input'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Loader } from '@cloudflare/kumo/components/loader'
import { Select } from '@cloudflare/kumo/components/select'

type Form = {
  openTime: string
  closeTime: string
  remoteStartMinutesBefore: string
  remoteMaxPercent: string
  remoteStopAtGroups: string
  notifyBeforeGroups: string
  arrivalTimeoutMinutes: string
  noShowMinutes: string
  maxPartySize: string
  seatTypes: string
  visitTagId: string
  noShowTagId: string
  sendConfirmation: boolean
}

function toForm(s: QueueSettings): Form {
  const str = (v: number | null) => (v === null ? '' : String(v))
  return {
    openTime: s.openTime ?? '',
    closeTime: s.closeTime ?? '',
    remoteStartMinutesBefore: String(s.remoteStartMinutesBefore),
    remoteMaxPercent: str(s.remoteMaxPercent),
    remoteStopAtGroups: str(s.remoteStopAtGroups),
    notifyBeforeGroups: String(s.notifyBeforeGroups),
    arrivalTimeoutMinutes: String(s.arrivalTimeoutMinutes),
    noShowMinutes: String(s.noShowMinutes),
    maxPartySize: String(s.maxPartySize),
    seatTypes: s.seatTypes.join('、'),
    visitTagId: s.visitTagId ?? '',
    noShowTagId: s.noShowTagId ?? '',
    sendConfirmation: s.sendConfirmation,
  }
}

function fromForm(f: Form): QueueSettings {
  const int = (v: string, label: string): number => {
    const n = Number(v)
    if (v.trim() === '' || !Number.isInteger(n) || n < 0) throw new Error(`${label}は0以上の数字で入れてください`)
    return n
  }
  const optional = (v: string, label: string): number | null => (v.trim() === '' ? null : int(v, label))
  return {
    openTime: f.openTime || null,
    closeTime: f.closeTime || null,
    remoteStartMinutesBefore: int(f.remoteStartMinutesBefore, '事前受付を始める時間'),
    remoteMaxPercent: optional(f.remoteMaxPercent, '事前受付の割合'),
    remoteStopAtGroups: optional(f.remoteStopAtGroups, '事前受付を止める組数'),
    notifyBeforeGroups: int(f.notifyBeforeGroups, '何組前にお知らせするか'),
    arrivalTimeoutMinutes: int(f.arrivalTimeoutMinutes, '自動キャンセルまでの時間'),
    noShowMinutes: int(f.noShowMinutes, '不在にするまでの時間'),
    maxPartySize: int(f.maxPartySize, '人数の上限'),
    seatTypes: f.seatTypes.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
    visitTagId: f.visitTagId || null,
    noShowTagId: f.noShowTagId || null,
    sendConfirmation: f.sendConfirmation,
  }
}

export default function QueueSettingsPage() {
  const { selectedAccountId } = useAccount()
  const [data, setData] = useState<QueueAdminSettings | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const apply = useCallback((d: QueueAdminSettings) => {
    setData(d)
    setForm(toForm(d.settings))
  }, [])

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    setError(null)
    setData(null)
    try {
      apply(await queueApi.getSettings(selectedAccountId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [selectedAccountId, apply])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    api.tags.list().then((r) => { if (r.success) setTags(r.data) }).catch(() => undefined)
  }, [])

  const checkinUrl = data?.liff_id ? queueCheckinUrl(data.liff_id, data.checkin_token) : null
  const remoteUrl = data?.liff_id ? queueRemoteUrl(data.liff_id) : null

  useEffect(() => {
    if (!checkinUrl) { setQr(null); return }
    QRCode.toDataURL(checkinUrl, { width: 480, margin: 2 }).then(setQr).catch(() => setQr(null))
  }, [checkinUrl])

  function update(patch: Partial<Form>) {
    setSaved(false)
    setForm((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  async function save() {
    if (!selectedAccountId || !form) return
    setSaving(true)
    setError(null)
    try {
      apply(await queueApi.saveSettings(selectedAccountId, { settings: fromForm(form) }))
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function rotate() {
    if (!selectedAccountId) return
    if (!window.confirm('店頭QRを作り直すと、いま貼ってあるQRは使えなくなります。作り直しますか？')) return
    try {
      apply(await queueApi.saveSettings(selectedAccountId, { rotate_token: true }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function printQr() {
    if (!qr) return
    const w = window.open('', '_blank', 'width=600,height=800')
    if (!w) return
    w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>順番待ち 店頭QR</title>
<style>body{font-family:sans-serif;text-align:center;padding:40px}h1{font-size:28px}p{font-size:18px;line-height:1.7}img{width:360px;height:360px}</style></head>
<body><h1>順番待ちの受付</h1><img src="${qr}" alt="順番待ちの店頭QR"><p>LINEのカメラで読んでください。<br>その場での受付と、事前に受付した方の到着の確認ができます。</p></body></html>`)
    w.document.close()
    w.focus()
    w.print()
  }

  const tagItems = { '': '— 付けない —', ...Object.fromEntries(tags.map((t) => [t.id, t.name])) }

  return (
    <div>
      <Header title="順番待ちの設定" description="受付の決まり・お知らせ・来店と不在のときの動き・店頭QR" action={<Link href="/queue" className="text-sm text-emerald-700 hover:underline">← 今日の列に戻る</Link>} />
      {!selectedAccountId ? (
        <Empty title="アカウントが未選択です" description="サイドバーで操作するアカウントを選択してください。" />
      ) : !data || !form ? (
        error ? <Banner variant="error" title="読み込めませんでした" description={error} /> : <LayerCard className="p-12"><Loader className="mx-auto" /></LayerCard>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2 max-w-5xl">
          <div className="space-y-6">
            <LayerCard className="p-6 space-y-4">
              <h2 className="text-sm font-semibold text-gray-800">受付</h2>
              <div className="grid grid-cols-2 gap-3">
                <Input label="受付を始める時刻（空欄 = 制限なし）" type="time" value={form.openTime} onChange={(e) => update({ openTime: e.target.value })} />
                <Input label="受付を終える時刻（空欄 = 制限なし）" type="time" value={form.closeTime} onChange={(e) => update({ closeTime: e.target.value })} />
              </div>
              <Input label="人数の上限（これ以上は「N名以上」）" type="number" min={1} value={form.maxPartySize} onChange={(e) => update({ maxPartySize: e.target.value })} />
              <Input label="席の希望の選択肢（「、」区切り。空欄なら聞かない）" value={form.seatTypes} placeholder="どこでも、テーブル、カウンター" onChange={(e) => update({ seatTypes: e.target.value })} />
            </LayerCard>

            <LayerCard className="p-6 space-y-4">
              <h2 className="text-sm font-semibold text-gray-800">事前受付（これから向かう人）</h2>
              <Input label="受付を始める時刻の何分前から受けるか" type="number" min={0} value={form.remoteStartMinutesBefore} onChange={(e) => update({ remoteStartMinutesBefore: e.target.value })} />
              <Input label="列のうち事前受付が占めてよい割合 %（空欄 = 制限なし）" type="number" min={0} max={100} value={form.remoteMaxPercent} onChange={(e) => update({ remoteMaxPercent: e.target.value })} />
              <Input label="待ちがこの組数以上なら事前受付を止める（空欄 = 制限なし）" type="number" min={1} value={form.remoteStopAtGroups} onChange={(e) => update({ remoteStopAtGroups: e.target.value })} />
              <Input label="順番が来て飛ばしてから何分たっても到着（QR）しなければ自動キャンセルするか（0 = しない）" type="number" min={0} value={form.arrivalTimeoutMinutes} onChange={(e) => update({ arrivalTimeoutMinutes: e.target.value })} />
              <p className="text-xs text-gray-500">順番が来ても到着していない人は飛ばして、次の到着済みの人を呼びます。その人が到着してQRを読むと、列の一番前に戻ります。順番が来る前は、どれだけ待っても自動ではキャンセルしません。</p>
            </LayerCard>

            <LayerCard className="p-6 space-y-4">
              <h2 className="text-sm font-semibold text-gray-800">お知らせ（LINE）</h2>
              <Checkbox label="受付完了のメッセージを送る" checked={form.sendConfirmation} onCheckedChange={(c) => update({ sendConfirmation: Boolean(c) })} />
              <Input label="何組前にお知らせするか（0 = 送らない）" type="number" min={0} value={form.notifyBeforeGroups} onChange={(e) => update({ notifyBeforeGroups: e.target.value })} />
              <p className="text-xs text-gray-500">呼び出し・飛ばし・自動キャンセルのときも送ります。1通ごとに LINE の月の送信数を使います。</p>
            </LayerCard>

            <LayerCard className="p-6 space-y-4">
              <h2 className="text-sm font-semibold text-gray-800">呼び出したあと</h2>
              <Input label="呼び出しから何分で「不在」にするか（0 = 自動にしない）" type="number" min={0} value={form.noShowMinutes} onChange={(e) => update({ noShowMinutes: e.target.value })} />
              <Select label="来店したときに付けるタグ" value={form.visitTagId} onValueChange={(v) => update({ visitTagId: String(v ?? '') })} items={tagItems} />
              <Select label="不在のときに付けるタグ" value={form.noShowTagId} onValueChange={(v) => update({ noShowTagId: String(v ?? '') })} items={tagItems} />
              <p className="text-xs text-gray-500">
                来店したらマイルも付きます。量は<Link href="/scoring" className="text-emerald-700 hover:underline">マイル</Link>画面の「順番待ちで来店」ルールで変えられます（はじめは50マイル）。
                タグを付けると、そのタグをきっかけにしたシナリオ（お礼・再来店のご案内など）が動きます。
              </p>
            </LayerCard>

            {error ? <Banner size="sm" variant="error" title="保存できませんでした" description={error} /> : null}
            {saved ? <Banner size="sm" variant="default" title="保存しました" /> : null}
            <div className="flex justify-end">
              <Button type="button" variant="primary" loading={saving} onClick={save}>保存</Button>
            </div>
          </div>

          <div className="space-y-6">
            <LayerCard className="p-6 space-y-4">
              <h2 className="text-sm font-semibold text-gray-800">店頭QR</h2>
              {!data.liff_id ? (
                <Banner size="sm" variant="alert" title="このアカウントに LIFF が設定されていません" description="アカウント設定で LIFF ID を入れると、店頭QRを作れます。" />
              ) : (
                <>
                  {qr ? <img src={qr} alt="順番待ちの店頭QR" className="w-64 h-64 mx-auto" /> : <Loader className="mx-auto" />}
                  <p className="text-xs text-gray-500">入口に貼ってください。その場での受付と、事前受付の人の到着の確認を、このQR1枚で受けます。</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="primary" onClick={printQr} disabled={!qr}>印刷する</Button>
                    <Button type="button" variant="secondary-destructive" onClick={rotate}>QRを作り直す</Button>
                  </div>
                  <p className="text-xs text-gray-500 break-all">事前受付の URL（リッチメニューなどに置く）：{remoteUrl}</p>
                </>
              )}
            </LayerCard>
          </div>
        </div>
      )}
    </div>
  )
}
