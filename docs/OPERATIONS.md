# 运维：定时、日志、失败恢复

---

## 1. 日常命令

```bash
# 手动跑一次（会进草稿箱）
node src/main.js

# 只生成，不碰微信接口
node src/main.js --dry-run

# 今天已经跑过也重跑
node src/main.js --force

# 指定日期
node src/main.js --date=2025-01-01 --force

# 跳到某个阶段停下
node src/main.js --until=render   # 只生成 md/html/封面
node src/main.js --until=draft    # 建草稿，不发表（freepublish 模式下有用）

# 跳过自检，省一次模型调用
node src/main.js --no-review

# 文章已生成但草稿失败，修好凭证后补推
node src/tools/push.js
node src/tools/push.js 2025-01-01
```

防重复：`data/state.json` 里记录了每天的状态。`drafted` / `published` 的日期会被跳过；
`generated`（dry-run 或只生成）不会阻止下一次正式运行。

---

## 2. 定时（Linux，推荐 systemd）

`/etc/systemd/system/wechat-daily.service`：

```ini
[Unit]
Description=wechat-daily 每日发文
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=youruser
WorkingDirectory=%h/wechat-daily
ExecStart=%h/wechat-daily/bin/daily.sh
TimeoutStartSec=3600
```

`/etc/systemd/system/wechat-daily.timer`：

```ini
[Unit]
Description=每天 07:30 生成公众号草稿

[Timer]
OnCalendar=*-*-* 07:30:00 Asia/Shanghai
Persistent=true
Unit=wechat-daily.service

[Install]
WantedBy=timers.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wechat-daily.timer
systemctl list-timers wechat-daily.timer
```

为什么用 systemd 而不是 cron：

- `OnCalendar` 原生支持时区，机器时区不是北京时间也不会错位
- Debian 的 cron 会忽略 `CRON_TZ`（实测），容易在半夜跑
- `Persistent=true` 能在关机/休眠错过后补跑
- 日志直接进 journald，`journalctl -u wechat-daily.service` 可查

---

## 3. 定时（其他平台）

**macOS**：launchd 的 `StartCalendarInterval`，或 cron（注意系统时区）。

**Windows**：任务计划程序 → 创建基本任务 → 每天 07:30 → 启动程序：
`node.exe`，参数 `src\main.js`，起始于项目目录。
时区跟随系统；如果系统不是北京时间，需要自己换算。

---

## 4. bin/daily.sh 做了什么

这个入口不是简单的一行 `node src/main.js`：

1. **flock 防并发**：同一时间只允许一个实例
2. **等网络**：先探测 `NET_PROBE`（默认 `https://www.baidu.com`），最多等 10 分钟
3. **失败重试**：最多 3 次，间隔 60s / 120s
4. **退出码区分**：
   - `0`：成功（或今天已跑过）
   - `1`：生成阶段失败
   - `2`：文章已生成，只有草稿失败（凭证/权限问题），**不重试**，避免白花模型额度

日志在 `data/logs/cron.out`，单次运行的详细日志在 `data/logs/run-<日期>.log`。

可调环境变量：

```bash
NET_PROBE=https://www.baidu.com
NET_WAIT_SEC=600
MAX_ATTEMPT=3
TZ=Asia/Shanghai
```

---

## 5. 网络看门狗（可选，Linux）

`bin/wifi-watchdog.sh` 适合「常开笔记本 + WiFi」的场景：

- 在线时什么都不做
- 连续 3 次探测失败才动手
- 先 `nmcli con up`，不行再重启 NetworkManager
- 每 5 分钟由 timer 触发

安装：

```bash
sudo cp bin/wifi-watchdog.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/wifi-watchdog.sh
```

然后建一个每 5 分钟的 timer（参考上面的写法，`OnUnitActiveSec=5min`）。

> Portal 认证过期时重连也没用，日志里会写出来，需要人工打开浏览器认证。

---

## 6. 部署到另一台机器

`deploy.sh` 用 tar + ssh 同步，不碰 `.env`、`data/`、`.git`：

```bash
WX_HOST=myserver WX_DEST=wechat-daily bash deploy.sh
```

首次部署后，在目标机器上：

```bash
cd ~/wechat-daily
npm run setup
npm run check
```

也可以直接 `git clone` + `npm install`，效果一样。

---

## 7. 日志与产物

```
data/
├── out/<YYYY-MM-DD>/
│   ├── article.md       原稿
│   ├── article.html     微信用 HTML
│   ├── cover.png        封面
│   ├── meta.json        选题、标题、字数、media_id、token 消耗
│   └── figs/            文献配图（如果启用了）
├── logs/
│   ├── cron.out         定时任务汇总日志
│   ├── run-<日期>.log   单次运行日志
│   └── bot-*.log        机器人拉起任务的日志
├── state.json           token 缓存、运行历史、已用选题
└── tmp/                 临时文件
```

`data/` 整个目录都在 `.gitignore` 里。

---

## 8. 故障恢复

### 文章写好了，但草稿失败

```bash
node src/tools/push.js            # 用今天的产物补推
node src/tools/push.js 2025-01-01 # 指定日期
```

`push.js` 会从 `article.md` 重新渲染（而不是直接用可能缺图的旧 HTML），
所以修好凭证后能补回配图，也不会重新调用模型。

### 今天已经跑过，想重写

```bash
node src/main.js --force
```

### 模型额度/网络问题导致只写了一半

主流程是先全部生成、最后才碰微信，所以要么有完整产物，要么完全没有。
如果产物在 `data/out/<日期>/` 但不完整，直接 `--force` 重跑。

### 进程被 kill

`state.json` 是原子写入，不会损坏。重跑即可；`article.md` 会在最后才落盘。

---

## 9. 备份与升级

需要备份的只有：

- `.env`（密钥）
- `config/*.yaml`（人设和选题）
- `config/agent-prompt.md`
- `data/state.json`（已用选题、防重复状态）

`data/out/` 是产物，可留可删。`node_modules/` 和 `data/tmp/` 不需要备份。

升级代码：

```bash
git pull
npm install
npm run selftest
```

`.env` 的键名向后兼容；新版本新增的可选键不填也能跑。
