# エラーハンドリング設計

最終更新: 2026/10/07（Fableレビュー指摘を反映した初版）

この文書は**実装より先に決める仕様**。コードと食い違ったら、この文書を直してからコードを直す。

## 0. 原則

1. **読めなかったのにOKになる経路を作らない。** 判定のデフォルトは非OK。OKを返すのは突合関数（`judge/match.ts`）と総合判定関数（`judge/judge.ts`）の明示的な分岐だけ。
2. **エラーは握りつぶさない。** すべての失敗は本書4章のエラーコードのどれかに写像される。写像できない失敗は `SYS_UNEXPECTED` として表に出す。空の catch は lint で禁止。
3. **利用者が気づける。** エラーはトーストで流さず、画面に残る表示にする。「何が起きたか・次に何をするか・エラーコード・検品ID」を必ず出す。
4. **開発者が気づける。** すべてのエラーは構造化ログに出る。検品のエラーはDBに残る。`SYSTEM` と `CONFIG` 分類のエラーと、総合 `ERROR` の検品は Slack に通知する（Webhook設定時）。
5. **判定結果とシステムエラーを混ぜない。** `NG`・`UNREADABLE` は品質判定の結果。`ERROR` は「判定が行われていない」ことを表す。画面でも別物として見せる。

## 1. 用語

| 用語 | 意味 |
|---|---|
| 検品 | 撮影画像1枚に対する1回の判定。クライアントが発行する `inspection_id`（UUID v4）で識別する |
| 項目 | 主判定の対象。`omotegaki`（表書き）、`atena`（宛名）、`card_text`（カード文面）の3つ |
| 参考判定 | のし有無・カード有無・水引種別。表示のみ（D7のフラグで総合に反映可） |
| 試行 | AI API への1回の呼び出し。1検品あたり最大2回 |

## 2. ステータスモデル

### 2.1 項目結果 `ItemResult`

| 値 | 意味 | 理由コード `ItemReason` |
|---|---|---|
| `OK` | 正規化後の読取値と正解値が一致 | `MATCH` |
| `NG` | 不一致、または対象物が写っていない | `MISMATCH` / `NOT_PRESENT` |
| `UNREADABLE` | 文字を読み取れなかった | `TEXT_UNREADABLE` |
| `SKIP` | オーダー上、その項目が不要 | `NOT_REQUIRED` |

項目ごとの判定手順（上から順に評価し、最初に当てはまったもので確定する）:

| # | 条件 | 結果 |
|---|---|---|
| 1 | 項目が不要（のし項目は `noshi_required=false`、カード項目は `card_required=false`） | `SKIP` / `NOT_REQUIRED` |
| 2 | 正解値が正規化後に空 | **検品全体を `ERROR` / `CONFIG_INVALID_EXPECTED`**。AI呼出前に検査するので、AIは呼ばない |
| 3 | AIが対象物なしと回答（`noshi_present=false` / `card_present=false`） | `NG` / `NOT_PRESENT` |
| 4 | 読取値が `null`、または正規化後に空 | `UNREADABLE` / `TEXT_UNREADABLE` |
| 5 | 正規化後の読取値と正解値が完全一致 | `OK` / `MATCH` |
| 6 | 上記以外 | `NG` / `MISMATCH` |

- 両辺とも空の場合は、2と4で必ず先に弾かれるため、5の一致判定に到達しない（テストで保証する）。
- 一致判定は D6 のとおり完全一致から開始する。閾値（編集距離）を導入する場合は、この表と6章のテストを先に更新する。

### 2.2 総合結果 `Overall`

| 値 | 意味 | 画面の扱い |
|---|---|---|
| `OK` | 主判定がすべて一致 | 一致表示 |
| `NG` | いずれかの項目が不一致・対象物なし | NGアラート（アクセント色） |
| `UNREADABLE` | 不一致はないが、読み取れない項目がある、またはAI応答がスキーマ不適合 | 判定不能（**NG扱い**）、撮り直しを促す |
| `ERROR` | 判定が行われていない（通信・AI障害・設定不備・保存失敗など） | エラー画面。品質判定ではない旨を明示 |

合成規則（`judge/judge.ts` の唯一の実装。上から順に評価する）:

1. 判定前・判定中・保存時のいずれかでエラーが起きた → `ERROR`
2. AI応答が2回ともスキーマ不適合 → `UNREADABLE`（項目はすべて `UNREADABLE`）
3. `NG` の項目が1つ以上ある → `NG`
4. `UNREADABLE` の項目が1つ以上ある → `UNREADABLE`
5. `REF_MISMATCH_BLOCKS_OK=true` かつ参考判定の警告が1つ以上ある → `NG`（理由 `REF_MISMATCH`）
6. `SKIP` 以外の項目が1つ以上あり、それらがすべて `OK` → `OK`
7. 上記以外（全項目が `SKIP` など） → `ERROR` / `CONFIG_INVALID_EXPECTED`

項目状態の全組合せ（`OK/NG/UNREADABLE/SKIP` の3乗 = 64通り）× 参考警告の有無 × フラグの値について、総合結果を表としてテストで固定する（6章）。

### 2.3 参考判定の警告 `RefWarning`

| コード | 条件 |
|---|---|
| `NOSHI_MISSING` | `noshi_required=true` なのに `noshi_present=false` |
| `NOSHI_UNEXPECTED` | `noshi_required=false` なのに `noshi_present=true` |
| `CARD_MISSING` | `card_required=true` なのに `card_present=false` |
| `CARD_UNEXPECTED` | `card_required=false` なのに `card_present=true`（不要なカードの混入） |
| `MIZUHIKI_MISMATCH` | 水引種別が登録と異なる |
| `MIZUHIKI_UNKNOWN` | のしが必要なのに、水引種別が `不明` |

警告は結果画面の上部に、目立つ形（アクセント色の左帯）で必ず表示する。既定では総合結果に影響しない（D7）。

## 3. AI呼び出しのリトライとタイムアウト

### 3.1 失敗の3分類

| 分類 | 該当 | 再試行 | 最終的な扱い |
|---|---|---|---|
| (a) スキーマ系 | tool_use が返らない／zod検証に失敗（`.strict()`、enum外の値、型違い）／`stop_reason=max_tokens`（打ち切り）／拒否応答 | **すぐに1回** | 2回とも失敗 → `UNREADABLE`（理由は最後の試行の `AI_SCHEMA_*`） |
| (b) 一時障害 | タイムアウト／接続断・DNS失敗／HTTP 408・429・5xx・529 | **2秒待って1回**（`retry-after` が5秒以下ならその値を使う） | 2回とも失敗 → `ERROR`（`AI_TIMEOUT` など） |
| (c) 設定不備 | HTTP 400・401・403・404・413 | **再試行しない** | `ERROR`（`AI_AUTH` / `AI_BAD_REQUEST`、分類 `CONFIG`） |

- 1回目と2回目で分類が異なる場合は、**2回目の分類**で確定する。ただし (c) が1回でも出たら `ERROR` で確定する。
- 1検品あたりの試行は**最大2回**。分類が異なっても合計で2回を超えない。
- **SDKの自動リトライは無効化する**（`maxRetries: 0`）。SDKの既定のリトライが働くと、試行回数と時間の予算が守れなくなるため。
- 2回目の試行の前に、残りの予算（3.2）が試行1回分のタイムアウトより少なければ、再試行せずに `ERROR` / `INSPECTION_TIMEOUT` で確定する。

### 3.2 タイムアウトの予算（外側ほど長くする）

| 層 | 設定 | 値（暫定） |
|---|---|---|
| AI 1試行 | SDK の `timeout` ＋ AbortSignal | 30s |
| API 検品全体 | 検品処理全体の AbortController | 65s |
| Fastify | `requestTimeout` | 70s |
| OpenResty | `proxy_read_timeout` | 75s |
| OpenResty | `client_body_timeout` / `proxy_send_timeout` | 30s |
| フロント | 送信の fetch を AbortController で中断 | 85s |

10/9 に実APIで計測し、p95 レイテンシを見て確定する。値を変える場合は、この表と `infra/openresty`・`apps/api`・`apps/web` の設定を同時に変更する（`packages/shared/src/timeouts.ts` に集約する）。

### 3.3 冪等性と二重送信

- クライアントは**撮影ごとに** `inspection_id`（UUID v4）を発行し、multipart に同梱する。
- APIは `inspections.inspection_id` の UNIQUE 制約で二重登録を防ぐ。
  - 同じIDで判定が完了済み → 保存済みの結果を返す（AIは呼ばない）
  - 同じIDで処理中（`PENDING`） → `409` / `INSPECTION_IN_PROGRESS`
- 送信中は送信ボタンを無効化する。画面がバックグラウンドに移ったら（`visibilitychange`）送信を中断し、`REQUEST_ABORTED` を表示する。
- 「再試行」は**新しい `inspection_id`** で送り直す（各試行を別の記録として残す）。

### 3.4 記録の順序（記録されないOKを出さない）

1. 入力検証（オーダーの存在、画像の形式・サイズ、正解値の妥当性）
2. 画像をファイルに保存 → 失敗したら `ERROR` / `STORAGE_WRITE_FAILED`
3. `inspections` に `status=PENDING` の行を INSERT → 失敗したら `ERROR` / `DB_UNAVAILABLE`
4. AIで読取（3.1）
5. 突合（2章）
6. 行を UPDATE（結果を確定） → **失敗したら、判定結果は返さずに `ERROR` / `PERSIST_FAILED`**
7. 結果を返す

- APIの起動時と5分ごとに、作成から5分を超えた `PENDING` 行を `ERROR` / `SYS_ABANDONED` に更新し、通知する（プロセスが落ちて処理が途中で止まった検品を見逃さないため）。

## 4. エラーカタログ

実装上の唯一の定義は `packages/shared/src/errors.ts`。この表と常に一致させる（テストで照合する）。

分類（`category`）:
- `USER_ACTION`: 利用者が対処できる（撮り直し、権限の許可など）
- `RETRYABLE`: 少し待って再試行すれば直る可能性がある
- `SYSTEM`: 開発者の対応が必要。**通知する**
- `CONFIG`: 設定やデータの不備。開発者の対応が必要。**通知する**

| コード | 発生源 | HTTP | 分類 | 利用者への表示（要旨） | 次の操作 |
|---|---|---|---|---|---|
| `CAMERA_PERMISSION_DENIED` | web | – | USER_ACTION | カメラの使用が許可されていません。ブラウザの設定で許可してください | 一覧から選ぶ |
| `CAMERA_UNAVAILABLE` | web | – | USER_ACTION | カメラを起動できませんでした（他のアプリが使用中、または非対応のブラウザ） | 一覧から選ぶ |
| `QR_ENGINE_LOAD_FAILED` | web | – | SYSTEM | コードの読み取り機能を準備できませんでした（読取エンジンの読込失敗） | 一覧から選ぶ |
| `QR_INVALID_FORMAT` | web | – | USER_ACTION | このコードはデモ用オーダーのコードではありません | 読み直す |
| `IMAGE_DECODE_FAILED` | web | – | USER_ACTION | 写真を読み込めませんでした。もう一度撮影してください | 撮り直す |
| `NETWORK_OFFLINE` | web | – | RETRYABLE | 通信できませんでした。電波の状態を確認してください | 再試行 |
| `REQUEST_TIMEOUT` | web | – | RETRYABLE | 応答がありませんでした | 再試行 |
| `REQUEST_ABORTED` | web | – | RETRYABLE | 画面を離れたため、判定を中断しました | 再試行 |
| `RESPONSE_INVALID` | web | – | SYSTEM | サーバーから想定外の応答がありました | 最初に戻る |
| `AUTH_REQUIRED` | edge | 401 | USER_ACTION | ログインが必要です。ページを再読み込みしてください | 再読み込み |
| `UPLOAD_TOO_LARGE` | edge/api | 413 | USER_ACTION | 写真のサイズが大きすぎます | 撮り直す |
| `RATE_LIMITED` | edge | 429 | RETRYABLE | アクセスが集中しています | 再試行 |
| `UPSTREAM_UNAVAILABLE` | edge | 502/503 | SYSTEM | 判定サーバーが応答していません | 再試行 |
| `UPSTREAM_TIMEOUT` | edge | 504 | RETRYABLE | 判定サーバーの応答が遅れています | 再試行 |
| `VALIDATION_FAILED` | api | 400 | SYSTEM | 送信内容に不備があります | 最初に戻る |
| `ORDER_NOT_FOUND` | api | 404 | USER_ACTION | 登録されていないオーダーです | 読み直す |
| `IMAGE_UNSUPPORTED_TYPE` | api | 415 | USER_ACTION | この形式の写真は使えません（JPEG/PNG/WebPのみ） | 撮り直す |
| `IMAGE_INVALID` | api | 400 | USER_ACTION | 写真が壊れているため読み込めません | 撮り直す |
| `INSPECTION_IN_PROGRESS` | api | 409 | RETRYABLE | 同じ判定を処理しています。しばらくお待ちください | 再試行 |
| `DEV_MODE_DISABLED` | api | 403 | CONFIG | 開発モードは無効です | 最初に戻る |
| `CONFIG_INVALID_EXPECTED` | api | 422 | CONFIG | 登録データに不備があるため判定できません | 最初に戻る |
| `STORAGE_WRITE_FAILED` | api | 500 | SYSTEM | 写真を保存できませんでした | 再試行 |
| `DB_UNAVAILABLE` | api | 503 | SYSTEM | データベースに接続できません | 再試行 |
| `PERSIST_FAILED` | api | 500 | SYSTEM | 判定結果を保存できませんでした（結果は表示しません） | 再試行 |
| `AI_TIMEOUT` | api | 504 | RETRYABLE | 読み取りに時間がかかりすぎました | 再試行 |
| `AI_RATE_LIMITED` | api | 503 | RETRYABLE | 読み取りサービスが混み合っています | 再試行 |
| `AI_OVERLOADED` | api | 503 | RETRYABLE | 読み取りサービスが混み合っています | 再試行 |
| `AI_UNAVAILABLE` | api | 502 | SYSTEM | 読み取りサービスに接続できません | 再試行 |
| `AI_AUTH` | api | 502 | CONFIG | 読み取りサービスの設定に不備があります | 最初に戻る |
| `AI_BAD_REQUEST` | api | 502 | CONFIG | 読み取りサービスへの依頼に不備があります | 最初に戻る |
| `INSPECTION_TIMEOUT` | api | 504 | RETRYABLE | 判定が時間内に終わりませんでした | 再試行 |
| `SYS_ABANDONED` | api | – | SYSTEM | （画面には出ない。通知とDBのみ） | – |
| `SYS_UNEXPECTED` | web/api | 500 | SYSTEM | 想定外のエラーが発生しました | 最初に戻る |

`UNREADABLE` の理由コード（エラーではなく判定の理由。DBの `unreadable_reason` に保存する）:
`AI_SCHEMA_NO_TOOL_USE` / `AI_SCHEMA_INVALID` / `AI_SCHEMA_TRUNCATED` / `AI_SCHEMA_REFUSAL` / `TEXT_UNREADABLE`

## 5. 見える化

### 5.1 利用者（画面）

| 状態 | 見出し | 補足・操作 | 見た目 |
|---|---|---|---|
| `OK` | 登録内容と一致しました | 項目ごとの「正解／AI読取／結果」 | メイン色のチェック。アクセント色は使わない |
| `NG` | 登録内容と一致しません（〇〇） | 不一致の項目を強調し、現物の確認を促す。撮り直す／最初に戻る | アクセント色の「!」と左帯 |
| `UNREADABLE` | 読み取れませんでした（NG扱い） | 明るい場所で、のし・カード全体が写るように撮り直す | アクセント色の「?」。NGとはアイコンで区別する |
| `ERROR` | 判定できませんでした | **「この結果は品質の判定ではありません」**と明記。エラーコードの文言・次の操作・エラーコード・検品ID・時刻を表示 | メイン色の警告アイコン（判定結果の色と区別） |

- エラー表示のコンポーネントは1つにまとめる（`ErrorPanel`）。どの画面のエラーも、必ずこれを通して表示する。
- 文言は作業者向けの言葉にする（「API」「推論」などの用語を使わない）。開発者向けの情報は、コードとIDとして小さく併記する。
- フロントの最上位に ErrorBoundary を置き、`window.onerror`・`unhandledrejection` も捕捉する。いずれも `SYS_UNEXPECTED` として `ErrorPanel` に表示し、5.2 のクライアントエラー報告に送る。

### 5.2 開発者

| 手段 | 内容 |
|---|---|
| 構造化ログ | Fastify（pino）のJSONログ。全行に `reqId`。検品の処理中は `inspectionId` も付ける。エラー行には `errorCode`・`category`・`err.message`・HTTPステータスを付ける。**ヘッダー・APIキー・画像本体は出さない** |
| 判定記録（DB） | `inspections` に、試行ごとの記録（生の応答・stop_reason・レイテンシ・エラー分類）、正規化後の文字列、項目ごとの理由コード、`error_code`、モデル名、プロンプトとスキーマのバージョン、アプリのバージョン、UAを保存する |
| クライアントエラー報告 | `POST /api/client-errors`。web で発生した `SYSTEM` 分類と `SYS_UNEXPECTED` のエラーを送り、APIのログに出して通知する。送信に失敗しても画面表示には影響させない |
| 通知 | `SLACK_WEBHOOK_URL` を設定した場合のみ。対象は `SYSTEM` と `CONFIG` 分類のエラー、総合 `ERROR` の検品、`SYS_ABANDONED`、ヘルスチェックの失敗。同じコードの通知は5分に1回にまとめ、件数を付ける。通知の失敗はログに出す（通知は再帰させない） |
| ヘルスチェック | `GET /api/health`: DBへのping、画像ディレクトリの書き込み可否と空き容量（500MB以上）、AIの設定値の有無を確認し、失敗した項目を返す（503）。VPSの cron で5分ごとに実行し、メモリ・スワップ・ディスクと合わせて確認する（`infra/scripts/healthcheck.sh`） |
| 調査手順 | 利用者から検品IDを聞く → `journalctl -u gift-inspector-api -o cat \| grep <inspectionId>` → DBの `inspections` を参照。手順は `docs/ops.md` にまとめる |

## 6. テスト（ガードレールの保証）

`apps/api/test/guardrail.spec.ts` を必須とし、以下を満たさない変更はマージしない。

**突合（judge）**
- 読取値が `null`・`""`・空白のみ・記号のみ（正規化後に空） → 非OK
- 正解値が空 → `ERROR` / `CONFIG_INVALID_EXPECTED`
- 両辺とも空 → 非OK
- 1文字違い（例:「渡辺」と「渡部」、「御祝」と「御礼」） → `NG`
- 異体字表の各ペアは一致する。表にない似た字は一致しない
- NFKCの副作用（`㈱`→`(株)`、全角ダッシュなど）を期待値として固定する
- property-based: ランダムな文字列で、正規化後に読取値と正解値が異なるなら必ず非OK

**合成（judge）**
- 項目状態の全組合せ（64通り）× 参考警告の有無 × フラグの値で、総合結果の表をスナップショット化する
- `card_required=false` で `card_present=true` → 警告 `CARD_UNEXPECTED`。総合はフラグの値に従う
- 全項目 `SKIP` → `ERROR`

**AI呼び出し（guard）**
- 2回ともスキーマ不適合 → `UNREADABLE`（AIの呼び出しは2回）
- tool_use なし／`max_tokens`／拒否応答 → (a) スキーマ系として扱われる
- タイムアウト・429・529・5xx が2回 → `ERROR`（試行は2回、待機あり）
- 400・401 → `ERROR`（**試行は1回だけ**であることを検証）
- 余計なキーを含む応答（`.strict()`） → 不適合
- 1回目がスキーマ系、2回目が一時障害 → `ERROR`
- 残りの予算が不足 → 2回目を呼ばずに `INSPECTION_TIMEOUT`

**API（route）**
- 413・404・壊れた画像・HEIC・DB停止・画像保存失敗・UPDATE失敗の応答に、`overall: "OK"` が含まれない
- 同じ `inspection_id` を2回送ると、AIの呼び出しは1回だけ
- `PENDING` のまま放置された行が `SYS_ABANDONED` になる

**カタログ**
- `errors.ts` のコードと本書4章の表が一致する（表をパースして照合する）
- すべてのコードに文言・分類・HTTPステータス・次の操作が定義されている

## 7. 障害注入の訓練（10/15、VPS上）

| # | 操作 | 期待する表示 | 期待するログ・通知 |
|---|---|---|---|
| 1 | `systemctl stop mysql` | `DB_UNAVAILABLE`（検品IDつき） | error ログ、Slack |
| 2 | 不正なAPIキーで再起動 | `AI_AUTH` | error ログ、Slack、試行1回 |
| 3 | `systemctl stop gift-inspector-api` | `UPSTREAM_UNAVAILABLE` | ヘルスチェックの失敗が Slack に届く |
| 4 | 端末を機内モードにして送信 | `NETWORK_OFFLINE` | （ログなし。端末側のみ） |
| 5 | 9MB以上の画像を直接 POST（上限 8MB） | `UPLOAD_TOO_LARGE` | nginx のログ |
| 6 | 送信中にホーム画面へ戻る | `REQUEST_ABORTED` | API 側は処理を完了し、記録が残る |
| 7 | 画像ディレクトリを読み取り専用にする | `STORAGE_WRITE_FAILED` | error ログ、Slack、ヘルスチェックの失敗 |
| 8 | モックAIで不適合応答を2回返す | `UNREADABLE`（NG扱い） | 試行2回分の記録 |
| 9 | 判定中に API を kill する | `UPSTREAM_UNAVAILABLE` | 5分以内に `SYS_ABANDONED` が通知される |

すべての項目で「OKが表示されない」「利用者にコードと検品IDが見える」「開発者がログかDBで原因を特定できる」ことを確認する。
