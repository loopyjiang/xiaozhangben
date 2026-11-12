#!/usr/bin/env bash
# 小账本 - 只更新代码并重启服务
#
# 不碰 nginx、不碰证书、不改 .env，只做「拉代码 → 装依赖 → 重启 → 自检」。
#
# 用法一（服务器能连 GitHub）：
#   curl -fsSL https://raw.githubusercontent.com/loopyjiang/xiaozhangben/main/deploy/update.sh -o /tmp/u.sh
#   sudo bash /tmp/u.sh
#
# 用法二（国内机房连不上 GitHub，用本地打包好的快照）：
#   sudo env LOCAL_TARBALL=/tmp/ledger-main.tgz bash /tmp/u.sh
#   快照可由开发机生成： git archive --format=tar.gz -o ledger-main.tgz HEAD
#   注意 sudo 会清空环境变量，LOCAL_TARBALL 必须写在 sudo 之后
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ledger-app}"
REPO="https://github.com/loopyjiang/xiaozhangben.git"
SERVICE="${SERVICE:-ledger}"
PORT="${PORT:-8080}"
LOCAL_TARBALL="${LOCAL_TARBALL:-}"

say() { printf '\n==> %s\n' "$1"; }
ok()  { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn(){ printf '    \033[33m!\033[0m %s\n' "$1"; }

# 脚本若在 APP_DIR 内执行，解压会覆盖自身，先搬到 /tmp 再继续
case "$(readlink -f "$0" 2>/dev/null || echo "$0")" in
  "$APP_DIR"/*)
    cp "$0" /tmp/ledger-update-self.sh
    export LOCAL_TARBALL
    exec bash /tmp/ledger-update-self.sh "$@"
    ;;
esac

[ "$(id -u)" = "0" ] || { echo "请用 root 运行：sudo bash $0"; exit 1; }
[ -d "$APP_DIR" ] || { echo "找不到 $APP_DIR，请先执行 deploy/install.sh"; exit 1; }

# .env 不在归档里，但先记下指纹，更新后核对，防止误伤配置
ENV_BEFORE="$(sha256sum "$APP_DIR/.env" 2>/dev/null | cut -d' ' -f1 || true)"

MIRRORS=(
  "https://ghproxy.net/"
  "https://gh-proxy.com/"
  "https://ghfast.top/"
)
TARBALL="${REPO%.git}/archive/refs/heads/main.tar.gz"

cd "$APP_DIR"

say "1/5 获取最新代码"
UPDATED=0

if [ -n "$LOCAL_TARBALL" ]; then
  [ -f "$LOCAL_TARBALL" ] || { echo "找不到快照 $LOCAL_TARBALL"; exit 1; }
  tar tzf "$LOCAL_TARBALL" >/dev/null 2>&1 || { echo "快照不是有效的 tar.gz"; exit 1; }
  # GitHub 的 main.tar.gz 有顶层目录（xiaozhangben-main/），需要剥一层；
  # 开发机 git archive 出来的快照没有顶层目录，剥了会把 public/ 写散到根目录。
  SW_MEMBER="$(tar tzf "$LOCAL_TARBALL" | grep -E '(^|/)public/sw\.js$' | head -1)"
  if [ -z "$SW_MEMBER" ]; then
    echo "快照里找不到 public/sw.js，已停止"; exit 1
  fi
  case "$SW_MEMBER" in
    public/sw.js) tar xzf "$LOCAL_TARBALL" -C "$APP_DIR" ;;
    *)            tar xzf "$LOCAL_TARBALL" -C "$APP_DIR" --strip-components=1 ;;
  esac
  # 硬校验：归档里的 sw.js 版本必须与落盘的一致，路径错位立刻失败
  WANT_SW="$(tar xzf "$LOCAL_TARBALL" -O "$SW_MEMBER" | grep -oE 'ledger-shell-v[0-9]+' | head -1)"
  GOT_SW="$(grep -oE 'ledger-shell-v[0-9]+' "$APP_DIR/public/sw.js" | head -1 || true)"
  if [ "$WANT_SW" != "$GOT_SW" ]; then
    echo "前端资源路径错位（期望 $WANT_SW，实际 ${GOT_SW:-未读到}），已停止"; exit 1
  fi
  ok "已更新（本地快照，$WANT_SW）"
  UPDATED=1
elif [ -d .git ] && git rev-parse --verify HEAD >/dev/null 2>&1; then
  # .git 属主常是服务账号，root 执行需显式声明 safe.directory
  if git -c safe.directory="$APP_DIR" fetch --quiet origin main 2>/dev/null \
     && git -c safe.directory="$APP_DIR" reset --hard --quiet origin/main; then
    ok "已更新（git）"
    UPDATED=1
  else
    warn "git 更新失败，改用压缩包"
  fi
fi

if [ "$UPDATED" = "0" ]; then
  for prefix in "" "${MIRRORS[@]}"; do
    url="${prefix}${TARBALL}"
    if curl -fsSL --max-time 120 "$url" -o /tmp/ledger-update.tgz 2>/dev/null \
       && tar tzf /tmp/ledger-update.tgz >/dev/null 2>&1; then
      tar xzf /tmp/ledger-update.tgz -C "$APP_DIR" --strip-components=1
      rm -f /tmp/ledger-update.tgz
      ok "已更新（压缩包 ${prefix:-直连}）"
      UPDATED=1
      break
    fi
    rm -f /tmp/ledger-update.tgz
  done
  [ "$UPDATED" = "1" ] || { echo "代码获取失败，请检查服务器网络，或改用 LOCAL_TARBALL"; exit 1; }
fi

say "2/5 核对配置未被改动"
ENV_AFTER="$(sha256sum "$APP_DIR/.env" 2>/dev/null | cut -d' ' -f1 || true)"
if [ -n "$ENV_BEFORE" ] && [ "$ENV_BEFORE" != "$ENV_AFTER" ]; then
  echo ".env 被改动了，已停止后续步骤，请检查"; exit 1
fi
[ -z "$ENV_BEFORE" ] && warn ".env 不存在，AI 与注册码可能未配置"
ok ".env 完好"

say "3/5 安装依赖"
if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请先执行 deploy/install.sh"
  exit 1
fi
npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund >/dev/null 2>&1 \
  && ok "依赖就绪" || warn "依赖安装有警告，继续"

say "4/5 重启服务"
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

say "5/5 健康检查与静态资源自检"
HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
if [ -n "$HEALTH" ]; then
  ok "接口正常"
  echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "    $HEALTH"
else
  warn "健康检查未通过，请查看 journalctl -u $SERVICE -n 50"
  exit 1
fi

# 前端资源漏传是最常见的「界面没变」原因，逐项确认
MISSING=""
for f in public/sw.js public/index.html public/app.css public/app.js \
         public/manifest.webmanifest public/loopy/hero.webp \
         public/icons/icon-192.png; do
  [ -f "$APP_DIR/$f" ] || MISSING="$MISSING $f"
done
if [ -n "$MISSING" ]; then
  warn "缺少资源：$MISSING"
else
  ok "前端资源齐全（Loopy 素材与图标都在）"
fi
SW_VER="$(grep -oE 'ledger-shell-v[0-9]+' "$APP_DIR/public/sw.js" | head -1)"
[ -n "$SW_VER" ] && ok "Service Worker 缓存版本 $SW_VER" \
                  || warn "未读到 sw.js 缓存版本"

echo
echo "更新完成。刷新手机上的页面即可（PWA 会自动拉新版本）。"
