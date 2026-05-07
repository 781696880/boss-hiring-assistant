#!/bin/bash
set -euo pipefail

REQUESTED_MODE="${1:-dry-run}"
MODE="$REQUESTED_MODE"
if [ "$MODE" = "screen-and-send" ]; then
  MODE="screen-and-greet"
fi
BASE_DIR="${BOSS_AUTO_BASE_DIR:-/Users/apple/Documents/boss-auto-lightweight-loop-python}"
BRIEF_DIR="$BASE_DIR/briefs"
LOG_DIR="$BRIEF_DIR/logs"
RESUME_DIR="$BASE_DIR/resumes"
LOCK_DIR="${BOSS_AUTO_LOCK_DIR:-$BRIEF_DIR/boss-auto.lockdir}"
LOCK_TTL_MINUTES="${BOSS_AUTO_LOCK_TTL_MINUTES:-30}"
TODAY="$(date '+%Y%m%d')"
LOG_FILE="$LOG_DIR/boss-auto-$TODAY.log"

mkdir -p "$BRIEF_DIR" "$LOG_DIR" "$RESUME_DIR"

log() {
  echo "$(date '+%F %T') [$MODE] $*" >> "$LOG_FILE"
}

lock_age_minutes() {
  perl -e 'my $p=shift; if(-e $p){print int((time-(stat($p))[9])/60)} else {print 0}' "$LOCK_DIR"
}

acquired=0

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    acquired=1
    cat > "$LOCK_DIR/meta.json" <<META
{"pid": $$, "mode": "$MODE", "started_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')", "host": "$(hostname)"}
META
    log "lock acquired: $LOCK_DIR"
    return 0
  fi

  age="$(lock_age_minutes)"
  if [ "$age" -ge "$LOCK_TTL_MINUTES" ]; then
    log "stale lock found age=${age}m ttl=${LOCK_TTL_MINUTES}m, removing"
    rm -rf "$LOCK_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      acquired=1
      cat > "$LOCK_DIR/meta.json" <<META
{"pid": $$, "mode": "$MODE", "started_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')", "host": "$(hostname)", "stale_lock_recovered": true}
META
      log "lock acquired after stale cleanup: $LOCK_DIR"
      return 0
    fi
  fi

  log "skip because lock exists: $LOCK_DIR age=${age}m"
  echo "{\"status\":\"skipped\",\"reason\":\"lock_exists\",\"mode\":\"$MODE\",\"lock_dir\":\"$LOCK_DIR\"}"
  exit 0
}

release_lock() {
  if [ "$acquired" = "1" ]; then
    rm -rf "$LOCK_DIR"
    log "lock released: $LOCK_DIR"
  fi
}
trap release_lock EXIT INT TERM

acquire_lock

PROMPT="runtime=lite
mode=$MODE
requested_mode=$REQUESTED_MODE
使用 assets/default-config.yaml 默认配置。
本轮已由外层脚本获得本地运行锁：$LOCK_DIR。
执行业务动作前必须按当前 mode 的最小必读 reference 清单加载文档。
所有 Boss 页面读取、点击、发送、接收附件和下载都固定使用 web-access CDP Proxy；不得使用 opencli boss 站点适配器或其他浏览器封装。
如首次连接出现 Chrome/web-access 远程调试授权或系统确认，只能在入口检查阶段处理一次；推荐牛人页逐个打招呼时必须复用已授权连接和 Boss target，不得每位候选人重复弹出授权确认。
只允许执行当前模式对应动作；遇到验证码、登录失效、身份不匹配、连续发送失败、下载失败或队列写入失败时立即停止。
结束时只输出短 JSON 摘要。"

log "start automation mode=$MODE"

if [ -z "${AUTOMATION_CMD:-}" ]; then
  log "AUTOMATION_CMD is not set"
  echo "{\"status\":\"failed\",\"reason\":\"AUTOMATION_CMD_not_set\",\"mode\":\"$MODE\"}"
  exit 1
fi

# 示例：export AUTOMATION_CMD="your-runner --skill boss-auto-lightweight-loop"
# 如果你的自动化运行器需要其它参数，可以直接把完整命令放在 AUTOMATION_CMD 中。
eval "$AUTOMATION_CMD" --prompt "\$PROMPT" >> "$LOG_FILE" 2>&1

log "finish automation mode=$MODE"
echo "{\"status\":\"ok\",\"mode\":\"$MODE\",\"lock\":\"released\"}"
