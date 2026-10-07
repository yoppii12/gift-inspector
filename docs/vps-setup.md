# VPS 構築手順書

対象: さくらのVPS 1Gプラン（Ubuntu 24.04 LTS、メモリ1GB）／ `https://gift-inspector-dev.laplust.com`
方針: Docker を使わず apt + systemd で構築する。**VPS 上でビルドしない**（ビルドは手元で行い、成果物を rsync する。D2）

上から順に実行すれば完成するように書いています。`<…>` は置き換えてください。
各章の末尾に **確認** があります。確認が通らないまま次へ進まないでください。

---

## 0. 完成形

```
スマホ/PC ──HTTPS(443)──> OpenResty ──(127.0.0.1:3000)──> gift-inspector-api (Node.js 22, systemd)
             └ TLS終端・BASIC認証・8MB上限・静的配信          ├──> MySQL 8.0 (127.0.0.1:3306)
                                                               ├──> 画像 /var/lib/gift-inspector/images
                                                               └──> AI API（外向き HTTPS）
```

| 項目 | 値 |
|---|---|
| 開放ポート | 22（SSH）、80（証明書更新と HTTPS への転送）、443 |
| ログインユーザー | `deploy`（SSH 鍵のみ、sudo 可） |
| API 実行ユーザー | `giftinsp`（ログイン不可） |
| アプリの配置 | `/srv/gift-inspector/{web,api,db,infra}`（所有者 `deploy`） |
| 画像・状態ファイル | `/var/lib/gift-inspector/`（所有者 `giftinsp`、公開ディレクトリの外） |
| 設定・秘匿情報 | `/etc/gift-inspector/`（`api.env`、`htpasswd`、`mysql-client.cnf`） |
| ログ | API: `journalctl -u gift-inspector-api`、nginx: `/var/log/openresty/`、ヘルスチェック: `journalctl -t gift-inspector-health` |

作業は手元の PC で、このリポジトリを clone した状態から始めます（設定ファイルを `scp` で送るため）。

---

## 1. 事前準備（さくらのコントロールパネル・DNS）

1. さくらのVPS コントロールパネルで OS を **Ubuntu 24.04** にしてインストールする（初期ユーザー `ubuntu`）。
2. **パケットフィルタ**（さくら側のファイアウォール）で、22・80・443 を許可する。UFW とは別物なので、両方で許可が必要です。
3. DNS に A レコードを登録する: `gift-inspector-dev.laplust.com` → VPS の IPv4 アドレス。
   - IPv6（AAAA）は登録しない（OpenResty は IPv4 のみで待ち受けます）。

**確認**（手元の PC で）
```bash
dig +short gift-inspector-dev.laplust.com   # VPS の IPv4 が返ること
ssh ubuntu@<VPSのIP>                         # ログインできること
```

---

## 2. 初期設定・ユーザー作成・SSH

以下は VPS 上で `ubuntu` ユーザーとして実行します。

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo timedatectl set-timezone Asia/Tokyo
sudo hostnamectl set-hostname gift-inspector-dev

# ログイン用ユーザー（sudo 可）
sudo adduser deploy                 # パスワードを設定（sudo 時に使う。社内の管理表で保管）
sudo usermod -aG sudo deploy

# API 実行用ユーザー（ログイン不可）
sudo adduser --system --group --no-create-home --shell /usr/sbin/nologin giftinsp

# 自動セキュリティ更新
sudo apt-get -y install unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
```

手元の PC から `deploy` に公開鍵を登録します。
```bash
ssh-copy-id -i ~/.ssh/<鍵>.pub deploy@<VPSのIP>
```

手元の `~/.ssh/config` に追記します（`deploy.sh` が `gift-vps` という名前で接続します）。
```
Host gift-vps
  HostName gift-inspector-dev.laplust.com
  User deploy
  IdentityFile ~/.ssh/<鍵>
```

**別のターミナルで `ssh gift-vps` でログインでき、`sudo -v` が通ることを確認してから**、パスワードログインと root ログインを禁止します。
```bash
sudo tee /etc/ssh/sshd_config.d/90-gift-inspector.conf > /dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo sshd -t && sudo systemctl reload ssh
```

**確認**
```bash
ssh gift-vps 'whoami && sudo -v && echo sudo-ok'   # deploy / sudo-ok
ssh -o PubkeyAuthentication=no deploy@<VPSのIP>   # Permission denied になること
```

---

## 3. ファイアウォール（UFW）

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

**確認**: `sudo ufw status verbose` で 22/80/443 だけが ALLOW であること。

---

## 4. スワップ 2GB とメモリ設定

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# スワップは最後の手段にする（常用すると判定が遅くなる）
sudo tee /etc/sysctl.d/90-gift-inspector.conf > /dev/null <<'EOF'
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOF
sudo sysctl --system > /dev/null

# 使わないサービスを止めてメモリを空ける
sudo systemctl disable --now snapd.service snapd.socket 2>/dev/null || true
```

journald の容量に上限を設けます（手元の PC からファイルを送る）。
```bash
# 手元の PC
scp infra/systemd/journald-gift-inspector.conf gift-vps:/tmp/
# VPS
sudo mkdir -p /etc/systemd/journald.conf.d
sudo mv /tmp/journald-gift-inspector.conf /etc/systemd/journald.conf.d/gift-inspector.conf
sudo systemctl restart systemd-journald
```

**確認**: `free -m` で Swap が約 2047MB、`cat /proc/sys/vm/swappiness` が 10。

---

## 5. ディレクトリ

```bash
sudo mkdir -p /srv/gift-inspector/{web,api,db,infra}
sudo chown -R deploy:deploy /srv/gift-inspector
sudo mkdir -p /var/lib/gift-inspector/images
sudo chown -R giftinsp:giftinsp /var/lib/gift-inspector
sudo chmod 750 /var/lib/gift-inspector
sudo mkdir -p /etc/gift-inspector
sudo chmod 755 /etc/gift-inspector
sudo mkdir -p /var/log/openresty /var/www/letsencrypt
```

---

## 6. MySQL 8.0

```bash
sudo apt-get -y install mysql-server
```

メモリを絞った設定を入れます。
```bash
# 手元の PC
scp infra/mysql/low-memory.cnf gift-vps:/tmp/
# VPS
sudo mv /tmp/low-memory.cnf /etc/mysql/mysql.conf.d/zz-gift-inspector.cnf
sudo systemctl restart mysql
```

DB とユーザーを作ります。パスワードは生成して控えます（`api.env` と `mysql-client.cnf` に使う）。
```bash
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24); echo "$DB_PASS"   # 控える
sudo mysql <<SQL
CREATE DATABASE gift_inspector CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'gift_inspector'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP ON gift_inspector.* TO 'gift_inspector'@'localhost';
SQL

# マイグレーション用の接続設定（root のみ読める）
sudo tee /etc/gift-inspector/mysql-client.cnf > /dev/null <<EOF
[client]
user=gift_inspector
password=${DB_PASS}
host=localhost
default-character-set=utf8mb4
EOF
sudo chmod 600 /etc/gift-inspector/mysql-client.cnf
unset DB_PASS
```

**確認**
```bash
sudo mysql --defaults-extra-file=/etc/gift-inspector/mysql-client.cnf -e "SELECT VERSION(), @@innodb_buffer_pool_size/1024/1024 AS pool_mb, @@performance_schema" gift_inspector
# 8.0.x / 64 / 0
```

---

## 7. Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt-get -y install nodejs
```

**確認**: `node -v` が `v22.x`。（npm は使いません。API は依存込みの1ファイルで配布します）

---

## 8. OpenResty

```bash
sudo apt-get -y install --no-install-recommends wget gnupg ca-certificates lsb-release
wget -O - https://openresty.org/package/pubkey.gpg | sudo gpg --dearmor -o /usr/share/keyrings/openresty.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/openresty.gpg] http://openresty.org/package/ubuntu $(lsb_release -sc) main" \
  | sudo tee /etc/apt/sources.list.d/openresty.list
sudo apt-get update && sudo apt-get -y install openresty
```

設定ファイルを配置します。まずは**証明書取得用の一時設定**で起動します（証明書がないと本番設定では起動できないため）。
```bash
# 手元の PC
scp -r infra/openresty gift-vps:/tmp/
# VPS
R=/usr/local/openresty/nginx/conf
sudo mkdir -p $R/sites $R/snippets
sudo cp /tmp/openresty/nginx.conf $R/nginx.conf
sudo cp /tmp/openresty/snippets/*.conf $R/snippets/
sudo cp /tmp/openresty/bootstrap-http.conf $R/sites/gift-inspector.conf
sudo openresty -t && sudo systemctl enable --now openresty && sudo systemctl reload openresty
```

**確認**（手元の PC）: `curl -sI http://gift-inspector-dev.laplust.com/` が `503`（"certificate not issued yet"）を返すこと。

---

## 9. Let's Encrypt（証明書）

```bash
sudo apt-get -y install certbot
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d gift-inspector-dev.laplust.com \
  --email <通知先メールアドレス> --agree-tos --no-eff-email

# 更新時に OpenResty を再読み込みする
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-openresty.sh > /dev/null <<'EOF'
#!/bin/sh
systemctl reload openresty
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-openresty.sh
```

本番の設定に切り替えます（BASIC 認証のファイルを先に作るため、10章を済ませてから reload してもよい）。
```bash
sudo cp /tmp/openresty/gift-inspector.conf /usr/local/openresty/nginx/conf/sites/gift-inspector.conf
```

**確認**
```bash
sudo certbot renew --dry-run     # Congratulations, all simulated renewals succeeded
systemctl list-timers | grep certbot
```

---

## 10. BASIC 認証

社内検証用とデモ用で**別のアカウント**を作ります（デモ用はコーリング社に共有する前提。検証期間とデモでパスワードを分ける）。
```bash
sudo apt-get -y install apache2-utils
sudo htpasswd -c -B /etc/gift-inspector/htpasswd internal     # 社内検証用
sudo htpasswd -B /etc/gift-inspector/htpasswd demo            # デモ用
sudo chown root:www-data /etc/gift-inspector/htpasswd
sudo chmod 640 /etc/gift-inspector/htpasswd

sudo openresty -t && sudo systemctl reload openresty
```

**確認**（手元の PC）
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://gift-inspector-dev.laplust.com/          # 401
curl -s -o /dev/null -w "%{http_code}\n" -u internal:<pw> https://gift-inspector-dev.laplust.com/   # 200（web 未配置なら 404 でも可）
curl -s -u internal:<pw> https://gift-inspector-dev.laplust.com/api/health               # API 未起動なら UPSTREAM_UNAVAILABLE の JSON
```

---

## 11. fail2ban とログローテート

```bash
sudo apt-get -y install fail2ban
# 手元の PC
scp infra/fail2ban/jail.local infra/logrotate/openresty gift-vps:/tmp/
# VPS
sudo mv /tmp/jail.local /etc/fail2ban/jail.d/gift-inspector.local
sudo mv /tmp/openresty /etc/logrotate.d/openresty
sudo systemctl restart fail2ban
```

**確認**: `sudo fail2ban-client status` に `sshd` と `nginx-http-auth` が出ること。

---

## 12. API（環境変数・systemd）とデプロイ

### 12.1 環境変数

`/etc/gift-inspector/api.env` を作ります。キーの一覧は `.env.example` を参照。
```bash
sudo tee /etc/gift-inspector/api.env > /dev/null <<'EOF'
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=3000
APP_VERSION=unknown
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=gift_inspector
DB_PASSWORD=<6章で控えたパスワード>
DB_NAME=gift_inspector
IMAGE_DIR=/var/lib/gift-inspector/images
IMAGE_MAX_BYTES=5242880
AI_PROVIDER=<確定後に設定>
AI_MODEL=<確定後に設定>
AI_API_KEY=<APIキー>
REF_MISMATCH_BLOCKS_OK=false
DEV_MODE_ENABLED=false
SLACK_WEBHOOK_URL=<通知先。空なら通知しない>
EOF
sudo chown root:giftinsp /etc/gift-inspector/api.env
sudo chmod 640 /etc/gift-inspector/api.env
```

> AI キーが届く前（10/8 の導通確認）は、`NODE_ENV=production` だと `AI_PROVIDER=mock` で起動できません（偽の判定を本番で出さないための安全装置）。導通確認の間だけ `NODE_ENV=development` と `AI_PROVIDER=mock` で起動し、キーが届いたら `production` に戻してください。

### 12.2 systemd

```bash
# 手元の PC
scp infra/systemd/gift-inspector-api.service gift-vps:/tmp/
# VPS
sudo mv /tmp/gift-inspector-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gift-inspector-api     # 起動はデプロイ後
```

### 12.3 初回デプロイ（手元の PC）

```bash
npm ci
infra/scripts/deploy.sh gift-vps
```

`deploy.sh` は、lint・テスト → ビルド → rsync → API 再起動 → ヘルスチェック、の順に実行し、失敗したら API のログを表示して止まります。

### 12.4 DB のマイグレーションとデモデータ（VPS）

```bash
sudo MYSQL_DEFAULTS_FILE=/etc/gift-inspector/mysql-client.cnf /srv/gift-inspector/db/migrate.sh --seed
# [migrate] demo_orders: 5 件
```

**確認**
```bash
curl -s http://127.0.0.1:3000/api/health      # {"status":"OK",...}
sudo journalctl -u gift-inspector-api -n 20 -o cat
```

---

## 13. ヘルスチェック（cron）

```bash
sudo tee /etc/cron.d/gift-inspector > /dev/null <<'EOF'
*/5 * * * * root /srv/gift-inspector/infra/scripts/healthcheck.sh > /dev/null 2>&1
EOF
sudo /srv/gift-inspector/infra/scripts/healthcheck.sh --print
```

**確認**
- `OK mem_avail=…MB swap_used=…MB disk_free=…MB` と表示されること。
- `sudo systemctl stop gift-inspector-api` → `--print` で NG になり、Slack に通知が届く → `start` で戻すと「復旧しました」が届くこと。

---

## 14. 10/8 の導通確認チェックリスト

スマホ（iOS Safari・Android Chrome）で `https://gift-inspector-dev.laplust.com/` を開き、接続確認画面で次を確認します。

| # | 確認 | 期待 |
|---|---|---|
| 1 | BASIC 認証のダイアログが出て、ログインできる | 画面が表示される |
| 2 | 「端末」の3項目 | すべてチェック |
| 3 | 「サーバー」の db / storage / ai | すべてチェック |
| 4 | 「カメラを起動」→ カメラ許可 → 印刷した QR を映す | 「登録済みオーダー」が表示される |
| 5 | カメラ許可を拒否してから「カメラを起動」 | `CAMERA_PERMISSION_DENIED` が表示される |
| 6 | 「撮影する」→ OS のカメラで撮影 | 写真と「変換後 1600×… / …KB」が表示される |
| 7 | LINE などのアプリ内ブラウザで開く | 4 か 5 のどちらかになる（無反応にならない） |
| 8 | 機内モードで「もう一度試す」 | `NETWORK_OFFLINE` が表示される |

結果（端末名・OS バージョン・可否・スクリーンショット）を共有してください。

---

## 15. メモリの確認と 2G プランへの移行基準

```bash
free -m
ps -eo rss,comm --sort=-rss | head -8 | awk '{printf "%6.0fMB %s\n", $1/1024, $2}'
```

想定（概算）: OS 200MB前後、MySQL 150〜250MB、Node 80〜120MB（検品中は一時的に +60〜100MB）、OpenResty 20MB。

次の**いずれか**が起きたら 2G プランへの移行を提案します（`healthcheck.sh` が検知して通知します）。
- 検品中に空きメモリ（MemAvailable）が 100MB 未満の状態が続く
- スワップ使用量が 300MB を超えた状態が続く
- MySQL か Node が OOM kill される（1回でも）
- 検品の応答時間の p95 が 30秒を超える

---

## 16. トラブルシュート

| 症状 | 確認すること |
|---|---|
| 画面に `UPSTREAM_UNAVAILABLE` | `systemctl status gift-inspector-api`、`journalctl -u gift-inspector-api -n 50 -o cat`（起動時の「環境変数が不正」など） |
| 画面に `DB_UNAVAILABLE` | `systemctl status mysql`、`journalctl -u mysql -n 50` |
| `openresty` が起動しない | `sudo openresty -t`、`/var/log/openresty/error.log` |
| 証明書エラー | `sudo certbot certificates`、`sudo certbot renew --dry-run` |
| 利用者から「検品ID」「受付ID」を聞いた | `sudo journalctl -u gift-inspector-api -o cat \| grep <ID>`、`grep <受付ID> /var/log/openresty/access.log` |

運用・撤去の手順は `docs/ops.md` を参照。
