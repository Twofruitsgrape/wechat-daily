#!/usr/bin/env bash
# WiFi 看门狗：每 5 分钟跑一次，只在真的断网时才动手。
#
# 背景：无人值守跑公众号发文时，机器开着但 WiFi 掉线就等于当天断更。
#
# 设计原则：宁可不动，也不要乱动。
#   - 在线 = 直接退出，什么都不做
#   - 连续失败 3 次（约 15 分钟）才算真断网
#   - 先温和重连（nmcli con up），不行才重启 NetworkManager
#   - 每次动作都写日志，方便事后判断是不是 Portal 认证过期
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="/var/log/wifi-watchdog.log"
STATE="/run/wifi-watchdog.fails"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

export PATH="/usr/local/bin:/usr/bin:/bin"

say() { echo "[$(date -Is)] $*" >> "$LOG"; }

online() {
  # 用 IP 直连，避开 DNS 故障造成的误判
  curl -s -o /dev/null --max-time 8 https://223.5.5.5/ 2>/dev/null && return 0
  ping -c 2 -W 3 223.5.5.5 >/dev/null 2>&1 && return 0
  return 1
}

if online; then
  [ -f "$STATE" ] && { say "网络已恢复（之前连续失败 $(cat "$STATE") 次）"; rm -f "$STATE"; }
  exit 0
fi

fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE"
say "探测失败，连续第 $fails 次"

# 前两次只记录，不动手，避免网络抖动时来回折腾
if [ "$fails" -lt 3 ]; then
  exit 0
fi

CON="$(nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null | grep -v ':lo$' | head -1 | cut -d: -f1)"

if [ -n "$CON" ]; then
  say "连续失败 $fails 次，尝试重连：$CON"
  nmcli connection down "$CON" >> "$LOG" 2>&1
  sleep 3
  nmcli connection up "$CON" >> "$LOG" 2>&1
else
  say "连续失败 $fails 次，但没有活动连接，重启 NetworkManager"
  systemctl restart NetworkManager >> "$LOG" 2>&1
fi

sleep 10
if online; then
  say "重连成功"
  rm -f "$STATE"
else
  say "重连后仍然不通 —— 可能是 Portal 认证过期，需要人工打开浏览器重新认证"
  # 计数归一到 3，避免每 5 分钟无脑重连一次
  echo 3 > "$STATE"
fi
