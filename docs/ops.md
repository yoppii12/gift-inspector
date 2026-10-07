# 運用メモ

## エラーの調べ方

利用者の画面には、エラーコード・検品ID・受付ID が表示されます（`docs/error-handling.md` 5章）。

```bash
# 1. 受付ID（= OpenResty の $request_id）で、nginx と API のログを突き合わせる
sudo grep <受付ID> /var/log/openresty/access.log
sudo journalctl -u gift-inspector-api -o cat | grep <受付ID>

# 2. 検品ID で判定の記録を見る（試行ごとの生の応答・正規化後の文字列・理由コード）
sudo mysql --defaults-extra-file=/etc/gift-inspector/mysql-client.cnf gift_inspector -e "
  SELECT inspection_id, status, overall, error_code, unreadable_reason,
         result_omotegaki, result_atena, result_card, ai_attempt_count, duration_ms, created_at
  FROM inspections WHERE inspection_id = '<検品ID>'\G"

# 3. 直近のエラーをまとめて見る
sudo journalctl -u gift-inspector-api --since "-1h" -o cat | grep -E '"level":(50|60)'
sudo mysql --defaults-extra-file=/etc/gift-inspector/mysql-client.cnf gift_inspector -e "
  SELECT overall, error_code, COUNT(*) FROM inspections
  WHERE created_at > NOW() - INTERVAL 1 DAY GROUP BY overall, error_code"
```

ログの `level`: 30=情報、40=警告（利用者の操作で解消するもの）、50=エラー（開発者の対応が必要）、60=致命的（プロセス終了）。

## AI の API キーを設定する

キーは**チャット・Issue・Slack・コマンドライン引数に書かない**。（VPS のログインシェルが bash であることが前提。`read -s` を使うため）担当者が自分のターミナルで次を実行し、表示された入力欄に貼り付ける（画面にも履歴にも残らない）。最後に `設定済みの行数: 1` と出れば完了。

```bash
# NAME=ANTHROPIC_API_KEY（キーは sk-ant- で始まる）または NAME=GEMINI_API_KEY（AIza / AQ. で始まる）
ssh -t gift-vps '
NAME=GEMINI_API_KEY
read -rsp "$NAME を貼り付けて Enter（表示されません）: " K; echo
case "$NAME:$K" in ANTHROPIC_API_KEY:sk-ant-*|GEMINI_API_KEY:AIza*|GEMINI_API_KEY:AQ.*) ;; *) echo "形式が違います。中止します"; exit 1;; esac
printf "%s" "$K" | sudo env NAME=$NAME python3 -c "
import os, sys, re
p = \"/etc/gift-inspector/api.env\"; name = os.environ[\"NAME\"]
line = name + \"=\" + sys.stdin.read().strip(); s = open(p).read()
s = re.sub(\"^\" + name + \"=.*\", lambda m: line, s, flags=re.M) if re.search(\"^\" + name + \"=\", s, re.M) else s.rstrip(chr(10)) + chr(10) + line + chr(10)
open(p, \"w\").write(s)"
unset K
echo "設定済みの行数: $(sudo grep -c "^$NAME=." /etc/gift-inspector/api.env)"
'
```

使うプロバイダを切り替えるときは、次の「AI の切り替え」の手順で行う。キーの行は上書きしない（両方のプロバイダのキーを残しておく）。

## AI の切り替え（Claude に障害が起きたら Gemini へ）

方針（#25 の計測、2026/10/08、#37）: 通常は **Claude**、予備は **Gemini**。どちらも擬似のし・カードの計測ですべて正しく判定し、応答は 2〜5 秒程度。

| | `AI_PROVIDER` | `AI_MODEL` | `AI_EFFORT` |
|---|---|---|---|
| 通常 | `anthropic` | `claude-opus-5-5` | `low` |
| 予備 | `google` | `gemini-3.5-flash` | 空（**必ず空にする**） |

`AI_EFFORT` は anthropic のときだけ指定できる。指定したまま google にすると設定エラーで API が起動しない。

**切り替えの目安**: 画面で `AI_UNAVAILABLE`・`AI_OVERLOADED`・`AI_TIMEOUT` が続けて出る（再試行しても直らない）、または Anthropic の障害情報（https://status.anthropic.com）で障害が出ている。デモ中なら、迷ったら切り替える（切り替えは 1 分ほどで、戻すのも同じ手順）。

### Gemini に切り替える（VPS 上で）

```bash
sudo sed -i -e 's/^AI_PROVIDER=.*/AI_PROVIDER=google/' -e 's/^AI_MODEL=.*/AI_MODEL=gemini-3.5-flash/' \
  -e 's/^AI_EFFORT=.*/AI_EFFORT=/' /etc/gift-inspector/api.env
sudo grep -E '^AI_(PROVIDER|MODEL|EFFORT)=' /etc/gift-inspector/api.env   # 3行がこの表の「予備」になっているか
sudo systemctl restart gift-inspector-api
sleep 5; curl -s http://127.0.0.1:3000/api/health
```

ヘルスチェックの `"ai":{"ok":true,"detail":"google/gemini-3.5-flash"}` で切り替わったことを確かめ、デモ用オーダー（GIFT-DEMO-001）を1回撮影して OK になることを確認する。

### Claude に戻す（VPS 上で）

```bash
sudo sed -i -e 's/^AI_PROVIDER=.*/AI_PROVIDER=anthropic/' -e 's/^AI_MODEL=.*/AI_MODEL=claude-opus-5-5/' \
  -e 's/^AI_EFFORT=.*/AI_EFFORT=low/' /etc/gift-inspector/api.env
sudo grep -E '^AI_(PROVIDER|MODEL|EFFORT)=' /etc/gift-inspector/api.env   # 3行がこの表の「通常」になっているか
sudo systemctl restart gift-inspector-api
sleep 5; curl -s http://127.0.0.1:3000/api/health
```

`"detail":"anthropic/claude-opus-5-5"` に戻っていることを確認する。`grep` で `AI_EFFORT=` の行が出ないときは、`echo 'AI_EFFORT=low' | sudo tee -a /etc/gift-inspector/api.env` で追記してから再起動する。

### 起動しないとき

ヘルスチェックが応答しないときは、設定エラーの可能性が高い。原因はログに出る。

```bash
journalctl -u gift-inspector-api -n 30 --no-pager -o cat
```

`AI_EFFORT`（google なのに値が入っている）、`AI_MODEL`（空）、キーの未設定がよくある原因。直したら再起動する。

どのモデルで判定したかは検品ごとに記録される（`inspections.ai_provider`・`ai_model`）。切り替えの前後で結果を比べるときに使う。

## AI の計測（案C: プロバイダ・モデルの比較）

API キーを手元に持ち出さないよう、**VPS 上で** `api.env` を読み込んで実行する。計測用の画像は `/srv/gift-inspector/bench/` に置く（撮影画像と同じく、架空のデモ用の印刷物だけにする）。

```bash
# 手元: 計測用の画像を送る（デプロイで bench-ai.js も配置される）
rsync -az <画像のフォルダ>/ gift-vps:/srv/gift-inspector/bench/
# VPS: 実行（モデル・回数・オーダー=画像 は適宜変える）
sudo bash -c 'set -a; . /etc/gift-inspector/api.env; set +a; \
  node /srv/gift-inspector/api/bench-ai.js --provider google --model gemini-3.5-flash --runs 5 \
  --orders /srv/gift-inspector/db/seeds/demo_orders.json \
  GIFT-DEMO-001=/srv/gift-inspector/bench/demo001.jpg GIFT-DEMO-003=/srv/gift-inspector/bench/demo003.jpg'
```

Claude の場合は `--provider anthropic --model claude-opus-5-5`（推論の深さは `--effort low|medium|high`）。

1試行ごとの JSON 行と、画像ごとの `[集計]`（判定の内訳・成功時の応答 p50/p95・読取結果の種類）が出る。読取結果の種類が 1 なら、毎回同じ結果（再現性あり）。結果は Issue に記録する。

## 開発用の手入力モード（正解を手で入れて判定する）

社内検証で、デモ用オーダー以外の文字（実物サンプルなど）を試すための機能（#22）。アプリの既定は無効（`DEV_MODE_ENABLED=false`）。

**現在の運用（2026/10/08〜、#35）**: VPS（gift-inspector-dev）では**当面有効**にしておく。お客様に見えても問題ないとのオーナー判断による。手入力の検品は `inspections.mode = 'manual'` で記録されるので、デモ用オーダーの検品とは区別して集計できる。

- 有効にする: VPS の `/etc/gift-inspector/api.env` で `DEV_MODE_ENABLED=true` にして `sudo systemctl restart gift-inspector-api`
- 使う: `https://gift-inspector-dev.laplust.com/?dev=1` を開くと、オーダー選択画面の下に「開発モード（正解を手入力）」が出る。正解を入れて撮影に進む
- 画面のヘッダーに「開発モード」の目印が出る。記録は `inspections.mode = 'manual'`（オーダーなし、入力した正解を保存）
- 判定は通常と同じ関数・規則。手入力の正解も AI には渡さない
- 無効のとき（既定）は、手入力の依頼は `DEV_MODE_DISABLED`（403）で断られる。画面の入口は `?dev=1` を付けても出るが、送信すると上記のエラーになる
- 無効に戻す: `DEV_MODE_ENABLED=false` にして再起動。今の設定は `curl -s http://127.0.0.1:3000/api/health` の `devModeEnabled` で確認できる

## デモデータの変更

1. `db/seeds/demo_orders.json` を編集する（唯一の元データ）
2. `npm run demo-kit` で SQL シード・QR（PNG）・印刷用 PDF を再生成する
3. `npm run check`（元データと SQL のずれ、QR が読めることをテストで確認）
4. デプロイ後、VPS で `sudo MYSQL_DEFAULTS_FILE=/etc/gift-inspector/mysql-client.cnf /srv/gift-inspector/db/migrate.sh --seed`

## 定期確認

- ヘルスチェックは5分ごとに自動実行（`journalctl -t gift-inspector-health`）。異常時は Slack に通知される。
- 週1回: `free -m`、`df -h`、`sudo certbot certificates`。

## 2027年1月末の撤去（PoC 環境の提供期間終了）

撮影画像と判定記録を確実に消します。作業後に `docs/` の記録として日付と実施者を残してください。

```bash
sudo systemctl stop gift-inspector-api
sudo rm -rf /var/lib/gift-inspector/images                                   # 撮影画像（ディレクトリごと）
sudo mysql -e "DROP DATABASE gift_inspector; DROP USER 'gift_inspector'@'localhost';"  # 判定記録・オーダー
sudo journalctl --rotate && sudo journalctl --vacuum-time=1s                # API ログ（読取文字列を含む）
sudo rm -f /var/log/openresty/*.log*                                        # アクセスログ
sudo rm -rf /etc/gift-inspector                                             # 秘匿情報
```

AI ベンダー側のデータ保持期間・削除方法は、モデル確定時（10/23）に確認した内容に従う。
VPS 自体を解約する場合は、さくらのコントロールパネルからディスクごと削除する。
