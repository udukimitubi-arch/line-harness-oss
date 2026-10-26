'use client'

// 予約の決まり（アカウントごと）: 予約画面の表示と、受付の締切・何日先まで・祝日。
// 保存先は Worker の /api/booking/admin/booking-settings（services/booking-rules.ts）。

import { useCallback, useEffect, useState } from 'react'
import Header from '@/components/layout/header'
import { bookingApi, type BookingMenu, type BookingRules } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Checkbox } from '@cloudflare/kumo/components/checkbox'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Input } from '@cloudflare/kumo/components/input'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Loader } from '@cloudflare/kumo/components/loader'
import { Select } from '@cloudflare/kumo/components/select'

type CutoffMode = 'minutes' | 'prevDay'

export default function BookingSettingsPage() {
  const { selectedAccountId } = useAccount()
  const [rules, setRules] = useState<BookingRules | null>(null)
  const [menus, setMenus] = useState<BookingMenu[]>([])
  const [cutoffMode, setCutoffMode] = useState<CutoffMode>('minutes')
  const [maxDays, setMaxDays] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    setError(null)
    setRules(null)
    try {
      const [r, m] = await Promise.all([
        bookingApi.getBookingSettings(selectedAccountId),
        bookingApi.listMenus(selectedAccountId),
      ])
      setRules(r.settings)
      setMenus(m.menus)
      setCutoffMode(r.settings.cutoffPrevDayTime ? 'prevDay' : 'minutes')
      setMaxDays(r.settings.maxDaysAhead == null ? '' : String(r.settings.maxDaysAhead))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [selectedAccountId])

  useEffect(() => {
    load()
  }, [load])

  function update(patch: Partial<BookingRules>) {
    setSaved(false)
    setRules((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  async function save() {
    if (!selectedAccountId || !rules) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const days = maxDays.trim() === '' ? null : Number(maxDays)
      if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365)) {
        throw new Error('何日先までは 0〜365 の数字で入れてください（制限なしは空欄）')
      }
      if (!rules.menuSelect && !rules.fixedMenuId) {
        throw new Error('メニューを選ばせない場合は、使うメニューを選んでください')
      }
      const body: BookingRules = {
        ...rules,
        cutoffPrevDayTime: cutoffMode === 'prevDay' ? rules.cutoffPrevDayTime ?? '18:00' : null,
        maxDaysAhead: days,
      }
      const r = await bookingApi.setBookingSettings(selectedAccountId, body)
      setRules(r.settings)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <Header title="予約の設定" description="予約画面の見せ方と、受付の決まり" />
      {!selectedAccountId ? (
        <Empty title="アカウントが未選択です" description="サイドバーで操作するアカウントを選択してください。" />
      ) : !rules ? (
        error ? (
          <Banner variant="error" title="読み込めませんでした" description={error} />
        ) : (
          <LayerCard className="p-12"><Loader className="mx-auto" /></LayerCard>
        )
      ) : (
        <div className="space-y-6 max-w-xl">
          <LayerCard className="p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-800">予約画面の見せ方</h2>
            <Checkbox
              label="お客さんにメニューを選ばせる"
              checked={rules.menuSelect}
              onCheckedChange={(checked) => update({ menuSelect: Boolean(checked) })}
            />
            {!rules.menuSelect ? (
              <Select
                label="使うメニュー（選ばせないとき）"
                value={rules.fixedMenuId ?? ''}
                onValueChange={(value) => update({ fixedMenuId: value || null })}
                placeholder="— 選んでください —"
                items={Object.fromEntries(menus.map((m) => [m.id, m.name]))}
              />
            ) : null}
            <Checkbox
              label="メニュー名を出す（確認画面・お客さんへの通知・差し込み）"
              checked={rules.showMenuName}
              onCheckedChange={(checked) => update({ showMenuName: Boolean(checked) })}
            />
            <Checkbox
              label="お客さんに担当者を選ばせる"
              checked={rules.staffSelect}
              onCheckedChange={(checked) => update({ staffSelect: Boolean(checked) })}
            />
            {!rules.staffSelect ? (
              <p className="text-xs text-gray-500">
                選ばせないときは、その時間に空いている担当者のうち、優先度（スタッフの編集画面）が大きい人に自動で割り振ります。
              </p>
            ) : null}
            <Checkbox
              label="担当者名を出す（確認画面・お客さんへの通知・差し込み）"
              checked={rules.showStaffName}
              onCheckedChange={(checked) => update({ showStaffName: Boolean(checked) })}
            />
          </LayerCard>

          <LayerCard className="p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-800">受付の決まり</h2>
            <Select
              label="受付の締切"
              value={cutoffMode}
              onValueChange={(value) => { setSaved(false); setCutoffMode(value === 'prevDay' ? 'prevDay' : 'minutes') }}
              items={{ minutes: '開始の何分前まで', prevDay: '予約日の前日の決まった時刻まで' }}
            />
            {cutoffMode === 'minutes' ? (
              <Input
                label="開始の何分前まで受け付けるか（既定60分）"
                type="number"
                min={0}
                value={rules.minLeadMinutes}
                onChange={(e) => update({ minLeadMinutes: Math.max(0, Number(e.target.value) || 0) })}
              />
            ) : (
              <Input
                label="前日の何時まで受け付けるか（日本時間）"
                type="time"
                value={rules.cutoffPrevDayTime ?? '18:00'}
                onChange={(e) => update({ cutoffPrevDayTime: e.target.value || null })}
              />
            )}
            <Input
              label="今日から何日先まで受け付けるか（空欄 = 制限なし）"
              type="number"
              min={0}
              value={maxDays}
              onChange={(e) => { setSaved(false); setMaxDays(e.target.value) }}
            />
            <Checkbox
              label="祝日は受け付けない（シフトを入れた日は開ける）"
              checked={rules.closedOnHolidays}
              onCheckedChange={(checked) => update({ closedOnHolidays: Boolean(checked) })}
            />
          </LayerCard>

          {error ? <Banner size="sm" variant="error" title="保存できませんでした" description={error} /> : null}
          {saved ? <Banner size="sm" variant="default" title="保存しました" /> : null}
          <div className="flex justify-end">
            <Button type="button" variant="primary" loading={saving} onClick={save}>保存</Button>
          </div>
        </div>
      )}
    </div>
  )
}
