#!/usr/bin/env bash
# systemd timer 入口。三件事：防并发、等网络、失败重试。
#
# 为什么需要"等网络"：定时任务可能在机器刚从休眠里醒来、WiFi 还没连上时就触发，
# 第一条模型请求就 fetch failed，整篇文章没生成。所以这里必须先探测外网再干活。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

export TZ="${WX_TZ:-Asia/Shanghai}"
export PATH="$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[$(date -Is)] 找不到 node，检查 PATH" >&2
  exit 127
fi

LOG_DIR="$DIR/data/logs"
mkdir -p "$LOG_DIR"
OUT="$LOG_DIR/cron.out"
say() { echo "[$(date -Is)] $*" | tee -a "$OUT"; }

# 同一时间只允许一个实例
exec 9>"$LOG_DIR/.daily.lock"
if ! flock -n 9; then
  say "已有实例在运行，本次跳过"
  exit 0
fi

# ---------- 1. 等网络 ----------
NET_PROBE="${NET_PROBE:-https://www.baidu.com}"
NET_WAIT_SEC="${NET_WAIT_SEC:-600}"
wait_for_network() {
  local deadline=$((SECONDS + NET_WAIT_SEC))
  local first=1
  while [ $SECONDS -lt $deadline ]; do
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$NET_PROBE" 2>/dev/null)
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      [ $first -eq 0 ] && say "网络已恢复（等了 $SECONDS 秒）"
      return 0
    fi
    if [ $first -eq 1 ]; then
      say "网络未就绪，开始等待（最多 ${NET_WAIT_SEC}s）"
      first=0
    fi
    sleep 10
  done
  return 1
}

if ! wait_for_network; then
  say "网络 ${NET_WAIT_SEC}s 内未恢复，放弃本次运行"
  exit 75   # EX_TEMPFAIL
fi

# ---------- 2. 跑主流程，失败重试 ----------
say "===== 启动 ====="
MAX_ATTEMPT="${MAX_ATTEMPT:-3}"
rc=1
for attempt in $(seq 1 "$MAX_ATTEMPT"); do
  "$NODE_BIN" src/main.js "$@" >> "$OUT" 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then
    say "第 $attempt 次运行成功"
    break
  fi
  say "第 $attempt 次运行失败 rc=$rc"
  # rc=2 表示文章已生成、只有草稿这步失败（通常是凭证/权限问题），重试无意义且白花模型额度
  if [ $rc -eq 2 ]; then
    say "文章已生成但草稿失败，不重试（先去看 data/out/ 里的产物）"
    break
  fi
  if [ "$attempt" -lt "$MAX_ATTEMPT" ]; then
    backoff=$((60 * attempt))
    say "等 ${backoff}s 后重试"
    sleep "$backoff"
  fi
done

say "===== 结束 rc=$rc ====="
exit $rc
