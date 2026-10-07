# gift-inspector — ギフト出荷向け AI 画像検品デモ（カスタムPoC）

スマホのブラウザでデモ用 QR コードを読み取り → のし・メッセージカードを撮影 → AI が文字を読み取り → 登録済みの正解と突合して OK/NG を表示するデモアプリです。

- 本番 URL: `https://gift-inspector-dev.laplust.com`（BASIC 認証）
- 開発の前提・ルール: [`CLAUDE.md`](CLAUDE.md)
- 計画: [`docs/plan.md`](docs/plan.md)

## バックエンド方式

**方式b（Node.js + TypeScript 分離）** を採用しました。OpenResty は前段（TLS 終端・BASIC 認証・サイズ制限・静的配信）として残し、AI 呼出・突合・保存は Node.js（Fastify）の独立アプリです。
決め手は、社内 Lua ライブラリが Rust/C++ のネイティブビルドを前提としていて、1GB VPS での構築が不確実なことです。詳細と方式aの利点は [`docs/adr/001-backend.md`](docs/adr/001-backend.md) に記録しています。

## 構成

```
apps/web/        React + TypeScript + MUI（Vite）。スマホファースト
apps/api/        Node.js + TypeScript（Fastify）。esbuild で1ファイルにまとめて配布
packages/shared/ エラーカタログ・判定ステータス・タイムアウト・AI 読取スキーマ（web と api で共有）
db/              マイグレーション・シード（db/migrate.sh）
tools/demo-kit/  デモ用データ → SQL シード・QR（PNG）・印刷用 PDF
infra/           OpenResty・systemd・MySQL・fail2ban の設定、デプロイとヘルスチェックのスクリプト
docs/            計画・ADR・エラー設計・VPS 構築手順・運用メモ・デザイン資料
```

## ガードレール（省略不可）

- 読めなかったのに OK になる経路を作らない。判定のデフォルトは非 OK
- AI へのプロンプトに正解情報を含めない（読取と照合の分離）
- エラーは握りつぶさない。すべてのエラーはエラーカタログのコードを持ち、利用者にはコードと ID を、開発者にはログ・DB・通知で見えるようにする

設計の詳細: [`docs/error-handling.md`](docs/error-handling.md)

## 開発

必要なもの: Node.js 22、MySQL 8.0

```bash
npm ci
cp .env.example .env              # DB_USER などを設定（.env はコミットしない）
db/migrate.sh --seed              # ~/.my.cnf か MYSQL_DEFAULTS_FILE で接続情報を渡す
npm run dev:api                   # http://127.0.0.1:3000
npm run dev:web                   # http://localhost:5173（/api は API に中継）
```

| コマンド | 内容 |
|---|---|
| `npm run check` | lint・型検査・テスト（コミット前に必ず通す） |
| `npm run build` | API と web のビルド |
| `npm run demo-kit` | デモ用データから SQL シード・QR・印刷用 PDF を生成 |
| `npm run gen:nginx -w @gift-inspector/api` | OpenResty のエラー応答をエラーカタログから生成 |

ESLint で、空の catch・コメントだけの catch・空の `.catch()`・await し忘れを禁止しています。

## デプロイ・運用

- VPS の構築: [`docs/vps-setup.md`](docs/vps-setup.md)
- デプロイ: `infra/scripts/deploy.sh gift-vps`（VPS 上ではビルドしない）
- 運用・障害調査・2027年1月末の撤去: [`docs/ops.md`](docs/ops.md)
- デモデータ: [`docs/demo-kit.md`](docs/demo-kit.md)
