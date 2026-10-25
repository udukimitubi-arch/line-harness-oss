-- Migration 073: 予約のきっかけ（自動ルール・リマインダー・管理者通知）
--
-- 予約の流れ（申し込み・承認・却下・期限切れ・キャンセル・終了後）で
-- 友だち情報の記録、リマインダーの登録/解除、自動ルール、管理者通知を動かす。
-- どれも設定が無いときは何もしない（既存の動きは変わらない）。
-- 既存の表は列を足すだけで、作り直さない。

-- リマインダーのステップを「基準日の N 日前の HH:MM（日本時間）」で送れるようにする。
-- send_time が NULL なら従来どおり offset_minutes（基準時刻からの分）で送る。
ALTER TABLE reminder_steps ADD COLUMN offset_days INTEGER;
ALTER TABLE reminder_steps ADD COLUMN send_time TEXT;

-- メニューごとに、承認時に登録するリマインダー。
CREATE TABLE IF NOT EXISTS booking_menu_reminders (
  menu_id      TEXT NOT NULL,
  reminder_id  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (menu_id, reminder_id)
);

-- 予約から登録したリマインダー（キャンセル・却下・期限切れで外すため）。
CREATE TABLE IF NOT EXISTS booking_friend_reminders (
  booking_id          TEXT NOT NULL,
  friend_reminder_id  TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (booking_id, friend_reminder_id)
);

-- 予約のきっかけごとの管理者通知（チャットワーク / Webhook）。
-- target: チャットワークはルームID、Webhook は URL。
-- minutes_after: event='ended' のとき、終了時刻から何分後に送るか。
CREATE TABLE IF NOT EXISTS booking_admin_notifications (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  event             TEXT NOT NULL CHECK (event IN ('requested','approved','rejected','expired','cancelled','ended')),
  channel           TEXT NOT NULL CHECK (channel IN ('chatwork','webhook')),
  target            TEXT NOT NULL,
  message_template  TEXT NOT NULL,
  minutes_after     INTEGER NOT NULL DEFAULT 30,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_booking_admin_notifications_account_event
  ON booking_admin_notifications (line_account_id, event, is_active);

-- 「終了後」のきっかけを二重に動かさないための記録。mark 例: 'ended:meta', 'ended:30'
CREATE TABLE IF NOT EXISTS booking_event_marks (
  booking_id  TEXT NOT NULL,
  mark        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (booking_id, mark)
);
