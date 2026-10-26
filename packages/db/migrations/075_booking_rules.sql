-- Migration 075: 予約の決まりごと（自動割り振りの優先度・1人あたりの予約数の上限）
--
-- 表示の設定・受付の締切・何日先まで・祝日は account_settings（key='booking_rules'）に入れる。
-- ここでは担当者の優先度と、メニューごとの上限だけを足す。既存の表は変えない。

-- 担当者を選ばせないとき、空いている担当者のうち priority が大きい人から割り振る。
CREATE TABLE IF NOT EXISTS booking_staff_priority (
  staff_id    TEXT PRIMARY KEY,
  priority    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- メニューごとに、1人が同時に持てる予約の数（申し込み中と確定で、まだ終わっていないもの）。NULL は上限なし。
ALTER TABLE booking_menu_options ADD COLUMN max_active_per_friend INTEGER;
