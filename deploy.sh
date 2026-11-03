#!/usr/bin/env bash
# 把工程同步到一台常开的 Linux 机器并装依赖。
#
# 用法：
#   WX_HOST=myserver WX_DEST=wechat-daily bash deploy.sh
#   WX_HOST=myserver bash deploy.sh          # 默认同步到远端的 ~/wechat-daily
#
# 前提：本机能免密 ssh 到 WX_HOST（建议在 ~/.ssh/config 里配好别名）。
# 注意：.env 不会同步（密钥只留在目标机器上）；首次部署完要到目标机器上跑
#       npm run setup 或手动建 .env。

set -euo pipefail

HOST="${WX_HOST:-}"
DEST="${WX_DEST:-wechat-daily}"
if [ -z "$HOST" ]; then
  echo "请先设置 WX_HOST，例如：WX_HOST=myserver bash deploy.sh" >&2
  exit 2
fi

cd "$(dirname "$0")"

echo "→ 同步到 $HOST:$DEST"
tar --exclude=./node_modules --exclude=./data --exclude=./.env \
    --exclude=./.env.bak --exclude=./.git -czf - . \
  | ssh "$HOST" "mkdir -p \"\$HOME/$DEST\" && tar -xzf - -C \"\$HOME/$DEST\""

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  echo "→ 安装依赖"
  ssh "$HOST" "cd \"\$HOME/$DEST\" && npm install --silent --no-fund --no-audit 2>&1 | tail -3"
fi

ssh "$HOST" "cd \"\$HOME/$DEST\" && chmod +x bin/*.sh 2>/dev/null || true"

echo "✅ 部署完成：$HOST:$DEST"
echo "   下一步：ssh $HOST 'cd $DEST && npm run setup && npm run check'"
