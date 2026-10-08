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

1. さくらのVPS コントロールパネルで OS を **Ubuntu 24.04 LTS** にしてインストールする（初期ユーザー `ubuntu`）。
   - **26.04 などの新しい版は選ばない。** OpenResty の公式 apt リポジトリが未対応（2026/10/7 時点で 26.04 向けは 404）で、8章が通らない。
   - 再インストールするとホスト鍵が変わり、手元の SSH が `REMOTE HOST IDENTIFICATION HAS CHANGED` で止まる。コントロールパネルのコンソールなどで指紋を確かめてから、`ssh-keygen -R <VPSのIP>` で古い記録を消す。
2. **パケットフィルタ**（さくら側のファイアウォール）で、22・80・443 を許可する。UFW とは別物です。
   - パケットフィルタを**無効**にしている場合、さくら側では全ポートが開いている。UFW（3章）が唯一の防御になるので、2章のあとすぐに 3章を行う。
3. DNS に A レコードを登録する: `gift-inspector-dev.laplust.com` → VPS の IPv4 アドレス。
   - IPv6（AAAA）は登録しない（OpenResty は IPv4 のみで待ち受けます）。

**確認**（手元の PC で）
```bash
dig +short gift-inspector-dev.laplust.com   # VPS の IPv4 が返ること
ssh ubuntu@<VPSのIP>                         # ログインできること
. /etc/os-release && echo $VERSION_CODENAME  # （VPS 上で）noble であること
```

### 1.1 構築作業中だけ sudo をパスワードなしにする（Claude Code で構築する場合）

Claude Code などから非対話で構築する場合、`ubuntu` の sudo がパスワードを求めると先に進めない。**構築作業の間だけ** パスワードなしにし、終わったら必ず削除する（17章）。担当者が自分のターミナルで1回だけ実行する。

```bash
ssh -t ubuntu@<VPSのIP> \
  "echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/90-setup-temp && sudo chmod 440 /etc/sudoers.d/90-setup-temp"
```

**確認**: `ssh ubuntu@<VPSのIP> 'sudo -n true && echo OK'` が `OK`。

---

## 2. 初期設定・ユーザー作成・SSH

以下は VPS 上で `ubuntu` ユーザーとして実行します。

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo timedatectl set-timezone Asia/Tokyo
sudo hostnamectl set-hostname gift-inspector-dev

# ログイン用ユーザー（sudo 可）。パスワードは後で担当者が自分で設定する（下記）
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG sudo deploy

# API 実行用ユーザー（ログイン不可）
sudo adduser --system --group --no-create-home --shell /usr/sbin/nologin giftinsp

# 自動セキュリティ更新
sudo apt-get -y install unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
```

`ubuntu` に登録済みの公開鍵を `deploy` にも登録します（`deploy` はパスワードがないため `ssh-copy-id` は使えない）。
```bash
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo install -m 600 -o deploy -g deploy ~/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
```

`deploy` の sudo 用パスワードは、**担当者が自分のターミナルで**設定します（作業者や AI にパスワードを渡さない。社内の管理表で保管）。
```bash
ssh -t ubuntu@<VPSのIP> "sudo passwd deploy"
```

手元の `~/.ssh/config` に追記します（`deploy.sh` が `gift-vps` という名前で接続します）。
```
Host gift-vps
  HostName gift-inspector-dev.laplust.com
  User deploy
  IdentityFile ~/.ssh/<鍵>
```

**別のターミナルで `ssh gift-vps` でログインでき、`sudo -v` が通ることを確認してから**、パスワードログインと root ログインを禁止します。

さくらの初期状態は `PasswordAuthentication yes` / `PermitRootLogin without-password`（2026/10/7 確認）。`sshd_config.d/` 内は**先に読まれたファイルの値が優先**されるため、変更後は必ず `sshd -T` で実効値を確認する。
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
# （VPS 上で）実効値が passwordauthentication no / permitrootlogin no であること
sudo sshd -T | grep -iE "^(passwordauthentication|permitrootlogin)"
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

DB とユーザーを作ります。パスワードは VPS 上で生成し、**画面にもログにも出さず** `mysql-client.cnf`（root のみ読める）に直接書き込みます。`api.env`（12.1）へはこのファイルから転記します。人が控える必要はありません（必要なら `sudo cat` で確認できる）。
```bash
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
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

本番の設定に切り替えます。**切り替える前に、10章の前半（空のパスワードファイルの作成）を済ませる**こと。ファイルがないと、認証の失敗ではなく 500 エラーになります。
```bash
sudo cp /tmp/openresty/gift-inspector.conf /usr/local/openresty/nginx/conf/sites/gift-inspector.conf
sudo openresty -t && sudo systemctl reload openresty
```

**確認**
```bash
sudo certbot renew --dry-run     # Congratulations, all simulated renewals succeeded
systemctl list-timers | grep certbot
```

---

## 10. BASIC 認証

9章で本番設定に切り替える**前に**、空のパスワードファイルを作っておきます。アカウントを作るまでは全員が 401 になり、認証なしで公開される時間を作りません。
```bash
sudo apt-get -y install apache2-utils
sudo install -m 640 -o root -g www-data /dev/null /etc/gift-inspector/htpasswd
sudo openresty -t && sudo systemctl reload openresty
```

社内検証用とデモ用で**別のアカウント**を作ります（デモ用は顧客に共有する前提。検証期間とデモでパスワードを分ける）。パスワードは**担当者が自分のターミナルで**入力します（作業者や AI に渡さない）。
```bash
ssh -t ubuntu@<VPSのIP> \
  "sudo htpasswd -B /etc/gift-inspector/htpasswd internal && sudo htpasswd -B /etc/gift-inspector/htpasswd demo"
```

認証を通した動作確認を作業者が行う場合は、確認用の一時アカウントを作り、**確認後すぐに削除する**（`sudo htpasswd -D /etc/gift-inspector/htpasswd <一時アカウント>`）。

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

`/etc/gift-inspector/api.env` を作ります。キーの一覧は `.env.example` を参照。DB のパスワードは `mysql-client.cnf` から転記し、画面に出しません。
```bash
DB_PASS=$(sudo sed -n 's/^password=//p' /etc/gift-inspector/mysql-client.cnf)
sudo tee /etc/gift-inspector/api.env > /dev/null <<EOF
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=3000
APP_VERSION=unknown
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=gift_inspector
DB_PASSWORD=${DB_PASS}
DB_NAME=gift_inspector
IMAGE_DIR=/var/lib/gift-inspector/images
IMAGE_MAX_BYTES=5242880
AI_PROVIDER=<mock | anthropic | google | cti>
AI_MODEL=<モデル名。例: claude-opus-5-5 / gemini-3.5-flash>
# Claude の推論の深さ（low | medium | high。空ならモデルの既定）
AI_EFFORT=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
CTI_BASE_URL=https://api.laplust.com/v0/apps/1013
CTI_API_KEY=
REF_MISMATCH_BLOCKS_OK=false
DEV_MODE_ENABLED=false
SLACK_WEBHOOK_URL=<通知先。空なら通知しない>
EOF
unset DB_PASS
sudo chown root:giftinsp /etc/gift-inspector/api.env
sudo chmod 640 /etc/gift-inspector/api.env
```

> API キーは**この heredoc に書かず**、担当者が自分のターミナルから設定する（キーを画面・履歴・チャットに残さない）。`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `CTI_API_KEY` の設定コマンドは `docs/ops.md`「AI の API キーを設定する」を参照。

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

手元の前提: **Node.js 22**（`node -v` で確認。macOS の既定が 18 などの場合は nvm で 22 を使う）。`deploy.sh` は bash スクリプトなので、zsh に貼り付けず、そのまま実行する（zsh では変数が単語分割されず、同じ処理を手で打つと失敗する）。

```bash
node -v                      # v22.x
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

---

## 17. 構築後の後始末

1.1 で作った**一時的な sudo 設定を削除**します。以後、sudo は `deploy` のパスワード（2章）で行います。
```bash
sudo rm /etc/sudoers.d/90-setup-temp
```

**確認**: `ssh ubuntu@<VPSのIP> 'sudo -n true'` が `a password is required` で失敗すること。

あわせて、構築中に作った確認用の一時アカウント（BASIC 認証）が残っていないことを確認します。
```bash
sudo cut -d: -f1 /etc/gift-inspector/htpasswd   # internal と demo だけであること
```
