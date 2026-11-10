#!/usr/bin/env bash
# 小账本一键部署（在服务器上以 root 运行）
# 用法：cd /opt/ledger-app && bash deploy/setup.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="/var/lib/ledger"
RUN_USER="ledger"

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行：sudo bash deploy/setup.sh"; exit 1; }

echo "==> 1/6 检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
fi
echo "    Node $(node -v)"

echo "==> 2/6 创建运行账号 ${RUN_USER}"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$RUN_USER"

echo "==> 3/6 安装依赖"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

echo "==> 4/6 生成图标"
if command -v python3 >/dev/null 2>&1; then
  python3 -c "import PIL" 2>/dev/null \
    || DEBIAN_FRONTEND=noninteractive apt-get install -y python3-pil >/dev/null 2>&1 \
    || true
  python3 tools/gen_icons.py || echo "    图标生成失败，跳过（不影响功能）"
else
  echo "    没有 python3，跳过"
fi

echo "==> 5/6 准备数据目录与环境变量"
mkdir -p "$DATA_DIR"
[ -f .env ] || cp .env.example .env
grep -q '^DATA_DIR=' .env || echo "DATA_DIR=$DATA_DIR" >> .env
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR" "$APP_DIR"

echo "==> 6/6 注册并启动 systemd 服务"
sed -e "s#/opt/ledger-app#${APP_DIR}#g" deploy/ledger.service > /etc/systemd/system/ledger.service
systemctl daemon-reload
systemctl enable --now ledger
sleep 1

echo
systemctl --no-pager --lines=0 status ledger || true
echo
echo "---------------------------------------------"
echo "服务已启动，本机监听 8080。"
echo "请检查 $(pwd)/.env 里的两项："
echo "  REGISTER_CODE      注册邀请码，务必改掉默认值"
echo "  DEEPSEEK_API_KEY   AI 记账用的 Key，不填则该功能隐藏"
echo "改完执行：systemctl restart ledger"
echo
echo "接着配域名和 HTTPS：见 deploy/nginx-ledger.conf.example"
echo "---------------------------------------------"
