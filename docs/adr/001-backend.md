# ADR-001: バックエンド方式の選定（方式b: Node.js + TypeScript 分離）

- 状態: 採用（2026/10/07 合意）
- 関連: CLAUDE.md 3章・9章、`docs/plan.md`

## 背景

CLAUDE.md 3章は、バックエンドを社内キット Mcs の構成を基盤として次のいずれかにすると定めている。

- a. OpenResty + Lua 方式（Mcs と同一基盤に統合）
- b. Node.js + TypeScript 方式（AI 呼出・突合を独立アプリ化）

選定観点: Mcs の既存構成との親和性／AI API リトライ・スキーマ検証の書きやすさ／保守性。どちらでも機能要件・ガードレールは同一に実現する。

## 調査した事実（2026/10/07 時点）

**Mcs（LAplust/Mcs.Multi-Code-Scanner）**
- フロント: React 18 + TypeScript + MUI v5 + webpack。QR 読取は `@yudiel/react-qr-scanner` と `zxing-wasm`（`app/src/components/Scanner.tsx`、`types/BarcodeScanner.ts`）。
- バックエンド: `web/backend/*.lua` の4ファイル。いずれも外部 API（`API_BASE_URL`）に中継するだけの薄い BFF で、DB・画像受信・AI 呼出の実装はない。
- インフラ: Docker Compose。web イメージは OpenSSL・OpenResty・LuaRocks をソースビルドする。nginx 設定に `client_max_body_size` と BASIC 認証はなく、`Access-Control-Allow-Origin *` を全体に付与している。

**Lua-Modules（Mcs のサブモジュール `lib/lua`）**
- `db/mysql.lua`（MySQL）、`upload.lua`（multipart）、`experimental/http.lua`（HTTP クライアント。タイムアウトはあるが、リトライやエラー種別の判別はない）、`typing.lua`（`StrictDict`・`Union`・`Enum`・`NonEmptyStr` などの型検証）を持つ。
- `extend.lua` が `require("rust")` と `cc.*` を無条件に読み込み、`func.lua`・`uuid.lua`・`experimental/http.lua` がそれに依存する。このため、上記モジュールのほぼすべてで **Rust（cargo）と C++（cmake）のネイティブビルドが必須**になる（`build.sh` が `luarocks make` で実行する）。
- `db/mysql.lua` は luasocket を使う。nginx ワーカー内でブロッキング I/O になるかどうかは未確認。

## 決定

**方式b** を採用する。OpenResty は前段（TLS 終端・BASIC 認証・サイズ制限・静的配信）として残し、AI 呼出・突合・保存は Node.js + TypeScript（Fastify）の独立アプリにする。

## 理由

1. **1GB VPS の制約（決め手）**: 方式aで Lua-Modules を使うには、Rust・C++ のネイティブモジュールをビルドする必要がある。1GB の VPS で cargo ビルドを行うとメモリ不足になる可能性が高い。別環境でビルドした `.so` を持ち込む場合は、LuaJIT の ABI や OpenSSL のバージョンの整合を管理する手間が増える。方式bなら OpenResty は公式 apt で入り、API は依存込みの1ファイル（esbuild）を置くだけで済む。
2. **AI クライアントの手間**: スキーマ検証は `typing.lua` でも同等にできる。差が出るのは AI 呼び出し側で、tool use のリクエスト組み立て、429/529/5xx/タイムアウトの判別、`stop_reason` の判定を Lua では一から書くことになる。TS は AI ベンダーの公式 SDK がそろっている。
3. **Mcs から再利用する部分は方式bでも残る**: 再利用の本体はフロントの QR 読取と、OpenResty の前段設定の考え方。Lua バックエンドには流用できる業務ロジックがない。
4. **型の共有とテスト**: AI 読取スキーマ・判定ステータス・エラーカタログを `packages/shared` でフロントと共有し、ガードレールの否定テスト（「OKにならないこと」）を vitest で網羅できる。

## 方式aの利点として認識していること

- プロセスが1つ少なく、メモリに多少の余裕が出る。
- Lua-Modules に MySQL・multipart・型検証がそろっている。
- 社内に Lua の保守者がいる（Lua-Modules は CI・カバレッジつきで保守されている）。

本件は、1GB VPS 上での構築の確実性と、AI クライアントのエコシステムを優先した。

## Mcs からの再利用の範囲

- `@yudiel/react-qr-scanner` による QR 読取（`apps/web/src/components/QrScanner.tsx`）。読むのは QR だけで、トラッカー描画や複数カメラの選択 UI は持ち込まない。
- 読取エンジン（wasm）は自前で配信する（ライブラリの既定は外部 CDN から取得するため）。
- Mcs のライブラリ既定値のままだとカメラの最低解像度（高さ 640px）を満たせない端末で起動に失敗するため、希望値（ideal）だけを指定する。
- OpenResty の設定は Mcs を参考にしたうえで、CORS `*` は付けず、`client_max_body_size` と BASIC 認証を明記した。
- Mcs は `env/.env.*` に Webhook URL などをコミットしているが、本リポジトリでは `.env.example` だけを管理する。
