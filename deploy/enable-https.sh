#!/usr/bin/env bash
# 小账本：为子域名开启 HTTPS（在服务器上以 root 运行）
# 用法：sudo bash /opt/ledger-app/deploy/enable-https.sh
#
# 做什么：
#   1. 给 80 的配置加 ACME 验证目录
#   2. 用 certbot webroot 模式签 ledger.krshare.site 的证书（不依赖 nginx 插件）
#   3. 签好后写入 443 配置，80 自动跳转 https（保留 ACME 路径供续期）
# 不改动机器上已有站点的任何配置。
set -euo pipefail

DOMAIN="ledger.krshare.site"
PORT="8080"
WEBROOT="/var/www/html"

say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '    \033[33m!\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行：sudo bash $0"; exit 1; }

# ---------- 找到我们的配置文件 ----------
if [ -f /etc/nginx/sites-enabled/ledger.conf ]; then
  CONF=/etc/nginx/sites-enabled/ledger.conf
elif [ -f /etc/nginx/conf.d/ledger.conf ]; then
  CONF=/etc/nginx/conf.d/ledger.conf
elif [ -d /etc/nginx/sites-available ]; then
  CONF=/etc/nginx/sites-available/ledger.conf
else
  CONF=/etc/nginx/conf.d/ledger.conf
fi
say "配置文件：$CONF"

mkdir -p "$WEBROOT"

# ---------- 1. 80 端口：先加 ACME 路径并代理 ----------
write_http_only() {
  cat > "$CONF" <<NGINX
# 小账本 - 由 deploy/enable-https.sh 生成
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 4m;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    # 证书续期验证目录
    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
    }

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
NGINX
}

write_http_only
[ -d /etc/nginx/sites-available ] && [ "$CONF" = "/etc/nginx/sites-available/ledger.conf" ] \
  && ln -sf "$CONF" /etc/nginx/sites-enabled/ledger.conf

nginx -t >/dev/null 2>&1 && systemctl reload nginx || { warn "nginx 校验失败"; nginx -t || true; exit 1; }
sleep 2
ok "80 已就绪"

# ---------- 2. 签证书 ----------
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
if [ -f "${CERT_DIR}/fullchain.pem" ]; then
  ok "证书已存在，跳过签发"
else
  say "申请证书"
  if ! command -v certbot >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y certbot >/dev/null 2>&1 || true
  fi
  command -v certbot >/dev/null 2>&1 || { warn "没有 certbot，无法自动签证书"; exit 1; }

  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
    --non-interactive --agree-tos --keep-until-expiring 2>&1 | tail -8 \
    || { warn "签发失败。确认 DNS 已生效后重试，或去掉 --non-interactive 手动跑一次"; exit 1; }

  [ -f "${CERT_DIR}/fullchain.pem" ] || { warn "证书文件未生成"; exit 1; }
  ok "证书已签发"
fi

# ---------- 3. 写 443 配置 ----------
write_https() {
  cat > "$CONF" <<NGINX
# 小账本 - 由 deploy/enable-https.sh 生成
server {
    listen 80;
    server_name ${DOMAIN};

    # 续期验证走 80，其余跳转 https
    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name ${DOMAIN};

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
$( [ -f /etc/letsencrypt/options-ssl-nginx.conf ] && echo "    include /etc/letsencrypt/options-ssl-nginx.conf;" )
$( [ -f /etc/letsencrypt/ssl-dhparams.pem ] && echo "    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;" )

    client_max_body_size 4m;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
NGINX
}

write_https
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  sleep 2
  ok "443 已启用"
else
  warn "443 配置校验失败，回退到仅 http"
  nginx -t || true
  write_http_only
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  exit 1
fi

# ---------- 4. 自测 ----------
code=$(curl -ks -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: ${DOMAIN}" "https://127.0.0.1/api/health" || echo 000)
if [ "$code" = "200" ]; then
  ok "本机 https 自测通过（200）"
else
  warn "本机 https 自测返回 ${code}，请检查服务状态：systemctl status ledger"
fi

say "HTTPS 已就绪"
echo "    站点地址： https://${DOMAIN}"
echo "    证书到期自动续期：systemctl list-timers | grep certbot"
echo "---------------------------------------------"
