#!/usr/bin/env bash
# 小账本一键部署（在腾讯云服务器上以 root 运行）
#
# 用法（腾讯云控制台「登录」打开的网页终端里粘贴即可）：
#   bash <(curl -fsSL https://raw.githubusercontent.com/loopyjiang/xiaozhangben/main/deploy/install.sh)
#
# 或者先把仓库克隆下来再跑：
#   git clone https://github.com/loopyjiang/xiaozhangben.git /opt/ledger-app
#   bash /opt/ledger-app/deploy/install.sh
#
# 脚本只做加法：新增 /etc/nginx/conf.d/ledger.conf，不改动机器上已有的任何站点。
set -euo pipefail

REPO="https://github.com/loopyjiang/xiaozhangben.git"
APP_DIR="/opt/ledger-app"
DATA_DIR="/var/lib/ledger"
RUN_USER="ledger"
DOMAIN="ledger.krshare.site"
PORT="8080"

say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '    \033[33m!\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行"; exit 1; }

# ---------- 1. 取代码 ----------
say "1/7 获取代码"
# 国内机房直连 github 常被中断，依次尝试：直连 → 镜像 → 压缩包
MIRRORS="https://ghproxy.net/ https://gh-proxy.com/ https://ghfast.top/"
got=0

if [ -d "$APP_DIR/.git" ]; then
  if git -C "$APP_DIR" fetch --quiet origin main 2>/dev/null; then
    git -C "$APP_DIR" reset --hard --quiet origin/main
    ok "已更新到最新版本"
  else
    warn "更新失败（网络），沿用现有代码"
  fi
  got=1
elif [ -f "$APP_DIR/package.json" ]; then
  ok "已存在代码目录"
  # 当初是用压缩包解压的（没有 .git）时，用压缩包整体刷新一遍；.env 不会被覆盖
  if [ ! -d "$APP_DIR/.git" ]; then
    for prefix in "" $MIRRORS; do
      url="${prefix}${REPO%.git}/archive/refs/heads/main.tar.gz"
      if curl -fsSL --max-time 120 "$url" -o /tmp/ledger-src.tgz 2>/dev/null \
         && tar tzf /tmp/ledger-src.tgz >/dev/null 2>&1; then
        tar xzf /tmp/ledger-src.tgz -C "$APP_DIR" --strip-components=1
        rm -f /tmp/ledger-src.tgz
        ok "已用压缩包刷新代码（${prefix:-直连}）"
        break
      fi
      rm -f /tmp/ledger-src.tgz
    done
  fi
  got=1
fi

if [ "$got" -eq 0 ]; then
  for prefix in "" $MIRRORS; do
    name="${prefix:-直连}"
    if git clone --depth 1 "${prefix}${REPO}" "$APP_DIR" >/dev/null 2>&1; then
      ok "已克隆（${name}）"
      got=1
      break
    fi
    rm -rf "$APP_DIR"
  done
fi

if [ "$got" -eq 0 ]; then
  warn "git 不通，改用压缩包下载"
  for prefix in "" $MIRRORS; do
    name="${prefix:-直连}"
    url="${prefix}${REPO%.git}/archive/refs/heads/main.tar.gz"
    if curl -fsSL --max-time 120 "$url" -o /tmp/ledger-src.tgz 2>/dev/null \
       && tar tzf /tmp/ledger-src.tgz >/dev/null 2>&1; then
      mkdir -p "$APP_DIR"
      tar xzf /tmp/ledger-src.tgz -C "$APP_DIR" --strip-components=1
      rm -f /tmp/ledger-src.tgz
      ok "已解压源码（${name}）"
      got=1
      break
    fi
    rm -f /tmp/ledger-src.tgz
  done
fi

if [ "$got" -eq 0 ]; then
  echo
  echo "拉取代码失败：直连和镜像都不通。"
  echo "可以手动把源码放到 $APP_DIR 后重新运行本脚本。"
  exit 1
fi

# ---------- 2. Node.js ----------
say "2/7 检查 Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [ "$major" -ge 18 ] 2>/dev/null && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm >/dev/null
fi
ok "Node $(node -v) / npm $(npm -v)"

# ---------- 3. 运行账号与依赖 ----------
say "3/7 安装依赖"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$RUN_USER"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund --loglevel=error
ok "依赖就绪"

# 图标（缺了也能跑，只是图标不好看）
if command -v python3 >/dev/null 2>&1; then
  python3 -c "import PIL" 2>/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y python3-pil >/dev/null 2>&1 || true
  python3 tools/gen_icons.py >/dev/null 2>&1 && ok "图标已生成" || warn "图标生成跳过"
fi

# ---------- 4. 环境变量 ----------
say "4/7 配置文件"
mkdir -p "$DATA_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
  CODE="$(head -c 9 /dev/urandom | base64 | tr -d '/+=' | head -c 8)"
  sed -i "s#^REGISTER_CODE=.*#REGISTER_CODE=${CODE}#" .env
  echo "DATA_DIR=$DATA_DIR" >> .env
  echo "HOST=127.0.0.1" >> .env
  echo "PORT=$PORT" >> .env
  ok "已生成 .env，注册码：${CODE}"
else
  grep -q '^DATA_DIR=' .env || echo "DATA_DIR=$DATA_DIR" >> .env
  grep -q '^HOST=' .env || echo "HOST=127.0.0.1" >> .env
  ok ".env 已存在，沿用原配置"
fi

if [ -t 0 ] && ! grep -q '^ICP_BEIAN=..*' .env; then
  printf '    备案号（留空跳过，例如 京ICP备2024000000号-1）: '
  read -r BEIAN || true
  if [ -n "${BEIAN:-}" ]; then
    grep -q '^ICP_BEIAN=' .env \
      && sed -i "s#^ICP_BEIAN=.*#ICP_BEIAN=${BEIAN}#" .env \
      || echo "ICP_BEIAN=${BEIAN}" >> .env
    ok "备案号已写入"
  fi
fi

chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR" "$APP_DIR"

# ---------- 5. systemd ----------
say "5/7 注册服务"
sed -e "s#/opt/ledger-app#${APP_DIR}#g" deploy/ledger.service > /etc/systemd/system/ledger.service
systemctl daemon-reload
systemctl enable ledger >/dev/null 2>&1 || true
systemctl restart ledger
sleep 2
if systemctl is-active --quiet ledger; then
  ok "服务已启动，监听 127.0.0.1:${PORT}"
else
  warn "服务启动失败，最近日志："
  journalctl -u ledger -n 20 --no-pager || true
  exit 1
fi
curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null && ok "本机健康检查通过" || warn "本机健康检查未通过"

# ---------- 6. nginx ----------
say "6/7 配置 nginx 反向代理"
if [ -d /etc/nginx/conf.d ] && ls /etc/nginx/conf.d/*.conf >/dev/null 2>&1; then
  CONF=/etc/nginx/conf.d/ledger.conf
elif [ -d /etc/nginx/sites-available ]; then
  CONF=/etc/nginx/sites-available/ledger.conf
else
  CONF=/etc/nginx/conf.d/ledger.conf
fi

WROTE_CONF=0
if [ -f "$CONF" ] && grep -q 'listen 443' "$CONF"; then
  ok "已有 HTTPS 配置，保留不动（如需重建请先删 $CONF）"
else
  cat > "$CONF" <<NGINX
# 小账本 - 由 deploy/install.sh 生成
server {
    listen 80;
    server_name ${DOMAIN};

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
  WROTE_CONF=1
fi

if [ "$CONF" = "/etc/nginx/sites-available/ledger.conf" ]; then
  ln -sf "$CONF" /etc/nginx/sites-enabled/ledger.conf
fi

if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  sleep 2
  ok "nginx 已重载，未改动其他站点"
else
  warn "nginx 配置校验失败。详情："
  nginx -t || true
  if [ "${WROTE_CONF:-0}" = "1" ]; then
    warn "已撤销本次写入的配置"
    rm -f "$CONF" /etc/nginx/sites-enabled/ledger.conf
  fi
  exit 1
fi

curl -fsS --max-time 5 -H "Host: ${DOMAIN}" "http://127.0.0.1/" >/dev/null && ok "反向代理链路通" || warn "反向代理自测未通过"

# ---------- 7. HTTPS ----------
say "7/7 申请证书并启用 HTTPS"
if [ -f "$APP_DIR/deploy/enable-https.sh" ]; then
  if bash "$APP_DIR/deploy/enable-https.sh"; then
    ok "HTTPS 已启用"
  else
    warn "HTTPS 未完成，稍后可手动重试： sudo bash $APP_DIR/deploy/enable-https.sh"
  fi
else
  warn "未找到 deploy/enable-https.sh，跳过"
fi

# ---------- 收尾 ----------
say "部署完成"
echo "    站点地址： https://${DOMAIN}"
echo "    运行账号： ${RUN_USER}    数据目录： ${DATA_DIR}"
echo "    配置文件： ${APP_DIR}/.env    日志： /var/log/ledger.log"
echo
echo "    常用命令："
echo "      systemctl status ledger          查看状态"
echo "      systemctl restart ledger         重启"
echo "      journalctl -u ledger -n 50       看日志"
echo "      bash $(pwd)/deploy/install.sh     重新跑一遍（等于更新）"
echo "---------------------------------------------"
