# Configuration — L Harness 設定リファレンス

## wrangler.toml

Workers のデプロイ設定ファイル。パス: `apps/worker/wrangler.toml`

```toml
name = "your-worker-name"
main = "src/index.ts"
compatibility_date = "2024-12-01"
workers_dev = true

# シークレットは wrangler secret put で設定
# ここにハードコードしない

[[d1_databases]]
binding = "DB"
database_name = "line-crm"
database_id = "YOUR_D1_DATABASE_ID"

[triggers]
crons = ["*/5 * * * *"]
```

### 各フィールドの説明

| フィールド | 値 | 説明 |
|-----------|-----|------|
| `name` | `your-worker-name` | Workers の名前（デプロイ先URLに影響） |
| `main` | `src/index.ts` | エントリーポイント |
| `compatibility_date` | `2024-12-01` | Workers ランタイム互換日 |
| `workers_dev` | `true` | `*.workers.dev` サブドメインを有効化 |
| `binding` | `DB` | D1 バインディング名（コード内で `c.env.DB` としてアクセス） |
| `database_name` | `line-crm` | D1 データベース名 |
| `database_id` | UUID | `wrangler d1 create` で取得した ID |
| `crons` | `["*/5 * * * *"]` | 5分毎の Cron トリガー |

## 環境変数 / シークレット

### Workers シークレット（wrangler secret put）

| 変数名 | 必須 | 型 | 説明 | 例 |
|--------|------|-----|------|-----|
| `LINE_CHANNEL_SECRET` | 必須 | string | Messaging API チャネルシークレット | `abc123def456...` |
| `LINE_CHANNEL_ACCESS_TOKEN` | 必須 | string | Messaging API 長期アクセストークン | `eyJhbGciOi...` |
| `API_KEY` | 必須 | string | REST API 認証用 Bearer トークン | `sk-my-secret-key` |
| `LINE_CHANNEL_ID` | 任意 | string | Messaging API チャネルID | `1234567890` |
| `LIFF_URL` | 任意 | string | LIFF アプリ URL | `https://liff.line.me/12345-abcde` |
| `LINE_LOGIN_CHANNEL_ID` | 任意 | string | LINE Login チャネルID（UUID連携用） | `9876543210` |
| `LINE_LOGIN_CHANNEL_SECRET` | 任意 | string | LINE Login チャネルシークレット | `xyz789...` |
| `GOOGLE_OAUTH_CLIENT_ID` | 推奨 | string | GoogleカレンダーOAuth接続用クライアントID | `123.apps.googleusercontent.com` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | 推奨 | string | OAuthクライアントの秘密鍵（Worker secretとして保存） | `GOCSPX-...` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | 互換用 | string | 旧サービスアカウント方式で使うメールアドレス | `calendar-sync@project.iam.gserviceaccount.com` |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | 互換用 | string | 旧サービスアカウント方式で使うPKCS#8秘密鍵 | `-----BEGIN PRIVATE KEY-----...` |

### シークレット設定コマンド

```bash
# 全シークレットを設定
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put API_KEY
npx wrangler secret put LINE_CHANNEL_ID
npx wrangler secret put LIFF_URL
npx wrangler secret put LINE_LOGIN_CHANNEL_ID
npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET

# 設定済みシークレット一覧確認
npx wrangler secret list
```

### Env 型定義

```typescript
// apps/worker/src/index.ts
export type Env = {
  Bindings: {
    DB: D1Database;
    LINE_CHANNEL_SECRET: string;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    API_KEY: string;
    LIFF_URL: string;
    LINE_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_SECRET: string;
  };
};
```

### 予約とGoogleカレンダーの同期

新規環境ではOAuth方式を推奨します。

1. Google Calendar APIとOAuth同意画面を設定します。
2. `calendar.events` と `calendar.events.freebusy` の2スコープを許可します。
3. OAuthクライアントのコールバックURIへ `<WORKER_URL>/api/booking/google-calendar/oauth/callback` を登録します。
4. `GOOGLE_OAUTH_CLIENT_ID` と `GOOGLE_OAUTH_CLIENT_SECRET` をWorker secretへ設定します。
5. L Harnessの「予約管理 → スタッフ → 受付時間」で「Googleアカウントで接続」を押します。

サービスアカウントキーやカレンダー共有は不要です。組織ポリシー `iam.disableServiceAccountKeyCreation` が有効な環境でも、この方式なら接続できます。

接続後は、L Harnessの受付時間からGoogleの「予定あり」を除外します。予約が確定するとGoogle Meet付きの予定を作成し、前日・1時間前のLINEリマインドも登録します。Google側を確認できない場合は、二重予約を防ぐため該当スタッフの枠を一時的に非表示にします。

詳しい設定手順、ライブCTAから予約確定までの流れ、エラー解決方法は [Googleカレンダー連携とライブCTA即時予約](28-Google-Calendar-and-Webinar-Booking.md) を参照してください。

### 予約リマインドのオン・オフ（BOOKING_REMINDERS_ENABLED）

予約カレンダーの標準リマインド（開始24時間前・2時間前の固定文）は、Worker の変数 `BOOKING_REMINDERS_ENABLED` で止められます。

- `false` / `0` / `off` / `no`：止める。承認しても `booking_reminders` に行を入れず、cron も送りません（すでに `pending` の行も送りません）。
- 未設定・それ以外の値：送る（従来どおり）。

止まるのは予約カレンダーの2通だけです。申し込み・承認・却下・期限切れの通知、イベント予約のリマインド、Meet相談のリマインドはそのまま届きます。

`wrangler deploy` はダッシュボードで足した変数を消すため、フォーク運用ではリポジトリの Variables に `BOOKING_REMINDERS_ENABLED=false` を登録してください。`deploy-cloudflare-worker.yml` が毎回の反映設定に書き込みます。

### 予約通知の文面と申し込みの期限（notification-settings API）

予約カレンダーの通知6種類の文面と、申し込みが期限切れになるまでの時間は、アカウントごとに API で変えられます（反映し直しは不要）。値は `account_settings` に保存されます。

```bash
# 読む
curl "$W/api/booking/admin/notification-settings?account_id=$A" -H "Authorization: Bearer $K"
# 変える（null で標準に戻す）
curl -X PUT "$W/api/booking/admin/notification-settings?account_id=$A" \
  -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"texts":{"requested":"","approved":"{datetime} のご予約が確定しました。"},"requestTtlHours":0}'
```

- `texts` のキー：`requested`（申し込み直後）/ `approved`（承認）/ `rejected`（却下）/ `expired`（期限切れ）/ `day_before`（前日）/ `hours_before`（N時間前）
- 文面に `{menu}` `{staff}` `{datetime}` `{hours}` を書くと、メニュー名・担当者名・日時・時間数に置きかわります。
- 空文字 `""` にした通知は送りません。キーが無ければ標準の文面です。
- `requestTtlHours`：承認待ちのまま何時間たったら期限切れにするか（0〜720）。`0` は「予約の開始時刻を過ぎるまで期限切れにしない」。未設定は24時間。標準の期限切れ文面は「24 時間」と書いているので、期限を変えたら `expired` の文面も合わせて変えてください。

### 予約のきっかけ（友だち情報・リマインダー・自動ルール・管理者通知）

予約の流れ（申し込み・承認・却下・期限切れ・キャンセル・終了後）で、次のことが自動で動きます。どれも設定が無ければ何もしません。

**友だち情報への記録**：きっかけのたびに、その友だちの友だち情報に最新の予約を書きます。シナリオ・自動応答・リマインダーの本文で `{{metadata.予約日}}` のように差し込めます。

| キー | 例 |
|---|---|
| 予約日 | 10月25日(土) |
| 予約開始時刻 / 予約終了時刻 | 10:00 / 11:00 |
| 予約メニュー / 予約担当者 | LINE Harness 無料診断 / 秋元 |
| 予約状態 | 申し込み中／確定／却下／期限切れ／キャンセル／終了 |
| 予約の有無 | あり／なし（まだ終わっていない申し込み中か確定の予約があれば「あり」） |
| 最終予約日 | 最後に確定した予約の日付 |
| 予約URL | 承認時に付けた Google Meet の URL（付けていなければ空） |

入るのは1件だけです。まだ終わっていない予約が複数あるときは、一番早い予約を書きます。

**リマインダーへの自動登録**：管理画面「予約 → メニュー → 編集」で、承認したときに登録するリマインダーを選べます（API: `GET/PUT /api/booking/admin/menus/:id/reminders`）。予約の開始時刻を基準に登録し、キャンセル・却下・期限切れで外します。承認が遅れて送る時刻を過ぎたステップは送りません。リマインダーのステップは「基準時刻から何分」のほか、「N日前の HH:MM（日本時間）」でも作れます。

**Google Meet を自動で付ける**：管理画面「予約 → メニュー → 編集」の「承認したら Google Meet を自動で付ける」をオンにすると（API: `GET/PUT /api/booking/admin/menus/:id/options`）、承認したとき担当者の Google カレンダーの予定に Meet を付けます。URL は承認の通知文の `{meet_url}`、友だち情報の `予約URL`、管理者通知の `{meet_url}` で使えます。担当者が Google カレンダーと連携していないと付きません。

**自動ルールのきっかけ**：`booking_requested` / `booking_approved` / `booking_rejected` / `booking_expired` / `booking_cancelled` / `booking_ended`。条件に `{"menu_id": "...", "staff_id": "..."}` を書くと絞れます。`booking_ended` は `{"minutes_after": 30}` で終了から何分後に動かすかを決めます（省略時30分）。承認のときは `calendar_booked` も動きます。

**管理者への通知**：`/api/booking/admin/notify-targets` で、きっかけごとにチャットワークか Webhook（https）へ送れます。文面の差し込みは `{event}` `{name}` `{date}` `{start}` `{end}` `{datetime}` `{menu}` `{staff}` `{status}` `{note}` `{admin_url}` `{meet_url}`。`POST /api/booking/admin/notify-targets/:id/test` で見本の予約を1回送れます。チャットワークのトークンは Worker のシークレット `CHATWORK_API_TOKEN` に置きます（`wrangler secret put CHATWORK_API_TOKEN` または Cloudflare の画面で「シークレット」として追加）。自分の投稿も未読になるよう `self_unread=1` を付けて送ります。

**時間について**：「終了後」と「リマインダー」は cron で拾うため、cron が5分ごとなら最大5分遅れます。6時間より前に終わった予約は「終了後」の対象にしません。お客さんが自分でキャンセルする機能は無いため、「キャンセル」は管理画面でキャンセルしたときに動きます。

### 管理画面の環境変数

Next.js 管理画面で必要な環境変数。Vercel / CF Pages のダッシュボードで設定:

| 変数名 | 説明 | 例 |
|--------|------|-----|
| `NEXT_PUBLIC_API_URL` | Workers API URL | `https://your-worker.your-subdomain.workers.dev` |

> **セキュリティ注意**: APIキーはログイン画面で入力する方式です。`NEXT_PUBLIC_*` にAPIキーを絶対に設定しないでください。クライアントバンドルに埋め込まれ、第三者から抽出可能になります。

## D1 データベースセットアップ

### 新規作成

```bash
# D1 作成
npx wrangler d1 create line-crm

# 出力される database_id を wrangler.toml に記入
```

### スキーマ適用

```bash
# 本番
npx wrangler d1 execute your-database --file=packages/db/schema.sql

# ローカル開発
pnpm db:migrate:local
# = wrangler d1 execute your-database --file=packages/db/schema.sql --local
```

### D1 ダッシュボード確認

```bash
# テーブル一覧確認
npx wrangler d1 execute your-database --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# レコード数確認
npx wrangler d1 execute your-database --command="SELECT COUNT(*) FROM friends"
```

### D1 バインディング

Workers 内では `c.env.DB` として D1Database インスタンスにアクセス:

```typescript
const db = c.env.DB;
const result = await db.prepare('SELECT * FROM friends WHERE id = ?').bind(id).first();
```

## Cron トリガー

### 設定

`wrangler.toml` の `[triggers]` セクションで定義:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

### Cron ハンドラ

5分毎に以下の4つの処理を `Promise.allSettled` で並列実行:

```typescript
// apps/worker/src/index.ts
async function scheduled(event, env, ctx) {
  const lineClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
  await Promise.allSettled([
    processStepDeliveries(env.DB, lineClient),      // ステップ配信
    processScheduledBroadcasts(env.DB, lineClient),  // 予約配信
    processReminderDeliveries(env.DB, lineClient),   // リマインダー
    checkAccountHealth(env.DB),                       // ヘルスチェック
  ]);
}
```

### Cron 実行間隔の変更

```toml
# 1分毎（より即時的な配信が必要な場合）
crons = ["* * * * *"]

# 10分毎（コスト節約）
crons = ["*/10 * * * *"]

# 毎時0分（1時間毎）
crons = ["0 * * * *"]
```

注意: 間隔を変更すると `next_delivery_at` の精度に影響する。5分毎が推奨。

## CORS 設定

管理画面は Cookie 認証を使うため、CORS は全許可ではなく管理画面の
Origin だけを許可します。初回セットアップ / アップデート時に
`create-line-harness` が次の Worker シークレットを設定します。

```bash
ADMIN_ORIGIN=https://<admin>.pages.dev
ADMIN_ALLOW_CROSS_SITE=true
```

Cloudflare Pages のデプロイ直後に表示される
`https://<hash>.<admin>.pages.dev` のようなプレビューURLも、同じ Pages
プロジェクトとして許可されます。まったく別の Pages プロジェクトや別ドメインは
拒否されます。

```typescript
app.use('*', cors({
  origin: (origin, c) => resolveCorsOrigin(c.env, origin, c.req.url),
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
}));
```

## JST タイムゾーン標準化

### 設計方針

L Harness は全タイムスタンプを **JST (UTC+9)** で統一しています。理由:
- LINE公式アカウントの利用者は日本が大多数
- Cron 配信の時間計算で UTC 変換ミスを防ぐ
- D1 (SQLite) にはタイムゾーン機能がないため、アプリケーション層で統一

### フォーマット

```
YYYY-MM-DDTHH:mm:ss.sss+09:00
```

例: `2026-03-21T14:30:00.000+09:00`

### ユーティリティ関数

```typescript
// packages/db/src/utils.ts

// 現在時刻を JST 文字列で取得
jstNow(): string
// → "2026-03-23T15:30:00.000+09:00"

// Date オブジェクトを JST 文字列に変換
toJstString(date: Date): string

// 2つのタイムスタンプをエポック比較（Z と +09:00 混在対応）
isTimeBefore(a: string, b: string): boolean
```

### API レスポンスでの表示

全 API レスポンスの `createdAt`, `updatedAt`, `scheduledAt` 等は JST 形式:

```json
{
  "createdAt": "2026-03-21T10:30:00.000+09:00",
  "updatedAt": "2026-03-21T10:30:00.000+09:00"
}
```

### 予約配信の時刻指定

配信予約はJST文字列で指定:

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/api/broadcasts \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "明日のお知らせ",
    "messageType": "text",
    "messageContent": "明日10時からセール開始！",
    "targetType": "all",
    "scheduledAt": "2026-03-24T10:00:00.000+09:00"
  }'
```

## 認証が不要なパス一覧

以下のパスは `authMiddleware` で認証をスキップします:

| パス | 理由 |
|------|------|
| `/webhook` | LINE Webhook署名検証で保護 |
| `/docs` | OpenAPI ドキュメント（公開） |
| `/openapi.json` | OpenAPI 仕様（公開） |
| `/api/affiliates/click` | クリックトラッキング（匿名アクセス可） |
| `/t/*` | トラッキングリンクリダイレクト |
| `/api/liff/*` | LIFF IDトークン認証 |
| `/auth/*` | LINE Login フロー |
| `/api/integrations/stripe/webhook` | Stripe Webhook 署名検証 |
| `/api/webhooks/incoming/*/receive` | 受信Webhook（個別シークレット検証） |
| `/api/forms/*/submit` | フォーム送信（LIFFから） |
| `/api/forms/*` (GET) | フォーム定義取得（LIFF表示用） |

## ローカル開発設定

### Workers ローカル起動

```bash
pnpm dev:worker
# → http://localhost:8787
# D1 はローカルモード（.wrangler/state/ に SQLite ファイル）
```

### 管理画面ローカル起動

```bash
pnpm dev:web
# → http://localhost:3001
# NEXT_PUBLIC_API_URL=http://localhost:8787 に設定
```

### ローカル Webhook テスト

ngrok 等で localhost をトンネル:

```bash
ngrok http 8787
# → https://xxxx.ngrok.io
# LINE Console で Webhook URL を https://xxxx.ngrok.io/webhook に設定
```

## npm スクリプト一覧

```bash
pnpm dev:worker          # Workers ローカル起動
pnpm dev:web             # 管理画面ローカル起動
pnpm build               # 全パッケージビルド
pnpm deploy:worker       # Workers デプロイ
pnpm deploy:web          # 管理画面ビルド
pnpm db:migrate          # 本番D1にスキーマ適用
pnpm db:migrate:local    # ローカルD1にスキーマ適用
```
