-- Migration 074: 予約の承認時に Google Meet を自動で付ける（メニューごとの設定）
--
-- 通常の予約カレンダーは、承認すると Google カレンダーに予定を作るが Meet は付けない。
-- メニューで「Meet を付ける」をオンにすると、予定に Meet を付け、その URL を
-- 承認の通知・友だち情報・管理者通知で使えるようにする。既存の表は変えない。

CREATE TABLE IF NOT EXISTS booking_menu_options (
  menu_id          TEXT PRIMARY KEY,
  add_google_meet  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS booking_meet_urls (
  booking_id  TEXT PRIMARY KEY,
  meet_url    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
