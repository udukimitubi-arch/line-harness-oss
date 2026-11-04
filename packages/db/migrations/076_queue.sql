-- Migration 076: 順番待ち（受付・事前受付・到着チェックイン・呼び出し）
--
-- 店ごとの設定（queue_settings）と、その日の列（queue_entries）を足す。既存の表は変えない。
-- 時刻は Worker が UTC ISO8601 で書く。business_date は日本時間の日付（YYYY-MM-DD）。

CREATE TABLE IF NOT EXISTS queue_settings (
  line_account_id  TEXT PRIMARY KEY,
  -- 受付時間・事前受付の上限・お知らせの組数などの決まり（services/queue.ts の QueueSettings）。
  settings_json    TEXT NOT NULL DEFAULT '{}',
  -- 店頭QRに入れる合言葉。これを持っている人だけが「その場で受付」と「到着」をできる。
  checkin_token    TEXT NOT NULL,
  is_open          INTEGER NOT NULL DEFAULT 1,
  remote_open      INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS queue_entries (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  business_date     TEXT NOT NULL,
  ticket_no         INTEGER NOT NULL,
  -- LINE を使わない人をスタッフが代わりに受付したときは NULL。
  friend_id         TEXT,
  guest_label       TEXT,
  party_size        INTEGER NOT NULL,
  seat_type         TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('walk_in', 'remote', 'staff')),
  status            TEXT NOT NULL CHECK (status IN ('waiting', 'called', 'visited', 'no_show', 'cancelled')),
  -- 列の並び。小さいほど前。後回し・到着時の繰り上げはこの値を動かす。
  sort_key          REAL NOT NULL,
  arrived_at        TEXT,
  -- 到着前に順番が来て、次の人を先に呼んだ時刻。
  passed_at         TEXT,
  near_notified_at  TEXT,
  called_at         TEXT,
  call_count        INTEGER NOT NULL DEFAULT 0,
  finished_at       TEXT,
  cancel_reason     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (line_account_id, business_date, ticket_no)
);

CREATE INDEX IF NOT EXISTS idx_queue_entries_active
  ON queue_entries(line_account_id, business_date, status, sort_key);
CREATE INDEX IF NOT EXISTS idx_queue_entries_friend
  ON queue_entries(friend_id, business_date, status);
-- 同じ友だちが同じ日に二重に並ばないようにする（ボタンの二度押しなど）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_queue_entries_active_friend
  ON queue_entries(line_account_id, friend_id, business_date)
  WHERE friend_id IS NOT NULL AND status IN ('waiting', 'called');

-- 来店したらマイルを付ける。量は「マイル」画面のこのルールで変えられる。
INSERT OR IGNORE INTO mileage_rules
  (id, program_id, name, event_type, source, amount, initial_status,
   conditions, is_active, created_at, updated_at)
VALUES
  ('builtin-queue-visited', 'default', '順番待ちで来店', 'queue_visited', 'queue', 50,
   'available', NULL, 1,
   strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'));
