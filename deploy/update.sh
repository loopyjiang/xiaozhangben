#!/usr/bin/env bash
# 小账本 - 只更新代码并重启服务
#
# 与 deploy/install.sh 的区别：本脚本不碰 nginx、不碰证书、不改 .env，
# 只做「拉最新代码 → 装依赖 → 重启 → 健康检查」，适合日常升级。
#
# 用法： sudo bash /opt/ledger-app/deploy/update.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ledger-app}"
REPO="https://github.com/loopyjiang/xiaozhangben.git"
SERVICE="${SERVICE:-ledger}"
PORT="${PORT:-8080}"

say() { printf '\n==> %s\n' "$1"; }
ok()  { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn(){ printf '    \033[33m!\033[0m %s\n' "$1"; }

[ "$(id -u)" = "0" ] || { echo "请用 root 运行：sudo bash $0"; exit 1; }
[ -d "$APP_DIR" ] || { echo "找不到 $APP_DIR，请先执行 deploy/install.sh"; exit 1; }

# 国内机房直连 GitHub 常被中断，依次尝试直连与镜像
MIRRORS=(
  "https://ghproxy.net/"
  "https://gh-proxy.com/"
  "https://ghfast.top/"
)
TARBALL="${REPO%.git}/archive/refs/heads/main.tar.gz"

cd "$APP_DIR"

say "1/4 获取最新代码"
UPDATED=0
if [ -d .git ] && git rev-parse --verify HEAD >/dev/null 2>&1; then
  if git fetch --quiet origin main 2>/dev/null && git reset --hard --quiet origin/main; then
    ok "已更新（git）"
    UPDATED=1
  else
    warn "git 更新失败，改用压缩包"
  fi
fi

if [ "$UPDATED" = "0" ]; then
  for prefix in "${MIRRORS[@]}" ""; do
    url="${prefix}${TARBALL}"
    if curl -fsSL --max-time 120 "$url" -o /tmp/ledger-update.tgz 2>/dev/null \
       && tar tzf /tmp/ledger-update.tgz >/dev/null 2>&1; then
      # .env 与 data/ 不在压缩包里，解压不会覆盖它们
      tar xzf /tmp/ledger-update.tgz -C "$APP_DIR" --strip-components=1
      rm -f /tmp/ledger-update.tgz
      ok "已更新（压缩包 ${prefix:-直连}）"
      UPDATED=1
      break
    fi
    rm -f /tmp/ledger-update.tgz
  done
  [ "$UPDATED" = "1" ] || { echo "代码获取失败，请检查服务器网络"; exit 1; }
fi

say "2/4 安装依赖"
if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请先执行 deploy/install.sh"
  exit 1
fi
npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund >/dev/null 2>&1 \
  && ok "依赖就绪" || warn "依赖安装有警告，继续"

say "3/4 重启服务"
chown -R "${RUN_USER:-ledger}:${RUN_USER:-ledger}" "$APP_DIR" 2>/dev/null || true
systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  ok "服务已重启"
else
  warn "服务未启动，最近日志："
  journalctl -u "$SERVICE" -n 25 --no-pager || true
  exit 1
fi

say "4/4 健康检查"
HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
if [ -n "$HEALTH" ]; then
  ok "接口正常"
  echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "    $HEALTH"
else
  warn "健康检查未通过，请查看 journalctl -u $SERVICE -n 50"
  exit 1
fi

echo
echo "更新完成。刷新手机上的页面即可（PWA 会自动拉新版本）。"
