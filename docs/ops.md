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
