#!/bin/bash
# 每天把账目打包一份，保留 30 天。
# 任何一步失败都 exit 1，systemd 会记成 failed，journalctl 里查得到。
set -uo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/ledger}"
SRC="$DATA_DIR/db.json"
DEST="${BACKUP_DIR:-/var/backups/ledger}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP=$(date +%Y%m%d-%H%M)

log() { echo "[$(date '+%F %T')] $*"; }

if [ ! -f "$SRC" ]; then
  log "找不到 $SRC，本轮跳过"
  exit 1
fi

mkdir -p "$DEST"

# 先确认源文件是合法 JSON：坏文件备份下来也没用
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import json;json.load(open('$SRC'))" 2>/dev/null; then
    log "db.json 不是合法 JSON（可能在写入中），本轮跳过"
    exit 1
  fi
fi

OUT="$DEST/db-$STAMP.json.gz"
if ! gzip -c "$SRC" > "$OUT.tmp"; then
  log "打包失败"
  rm -f "$OUT.tmp"
  exit 1
fi

# 解压校验，防止留下一个坏压缩包当备份
if ! gunzip -t "$OUT.tmp" 2>/dev/null; then
  log "压缩包自检失败"
  rm -f "$OUT.tmp"
  exit 1
fi

mv "$OUT.tmp" "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
COUNT=$(gunzip -c "$OUT" 2>/dev/null | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('records',[])))" 2>/dev/null || echo '?')
log "备份完成：$OUT（$SIZE，$COUNT 条账目）"

DELETED=$(find "$DEST" -maxdepth 1 -name 'db-*.json.gz' -mtime +"$KEEP_DAYS" -print -delete 2>/dev/null | wc -l)
if [ "$DELETED" -gt 0 ]; then
  log "清理了 $DELETED 个超过 $KEEP_DAYS 天的旧备份"
fi

exit 0
