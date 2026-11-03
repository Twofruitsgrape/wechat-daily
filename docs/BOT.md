# 可选：企业微信机器人 / 网页入口 / pi agent

这些都不是跑通发文主流程的必要条件。先让 `npm run daily` 跑通，再考虑加交互层。

---

## 1. 三种触发方式

| 方式 | 入口 | 适合 |
|---|---|---|
| 定时无人值守 | `bin/daily.sh` + systemd timer | 每天固定时间发 |
| 企业微信对话 | `npm run bot` | 想临时改选题、让 agent 干活 |
| 手机网页 | `npm run web` | 不想配企业微信 |

---

## 2. 企业微信智能机器人（推荐）

微信个人订阅号没有主动推送接口，所以「9 点问你写什么」「写完提醒你」这类能力
只能走企业微信。

### 为什么是「智能机器人」而不是自建应用

自建应用的「接收消息」回调要求域名备案主体与企业主体一致；个人注册的企业微信没有备案域名，
填 IP 也会被拒。智能机器人用**本地主动连出去的长连接**，官方说明是「不受企业域名或 IP 限制」
「无需固定公网 IP」「无需加解密」，所以更适合个人。

### 配置

1. 注册/登录企业微信，创建一个自建应用或智能机器人
2. 拿到 **Bot ID** 和 **Bot Secret**（不是自建应用的 CorpID/AgentID）
3. 写进 `.env`：

```bash
WECOM_BOT_ID=...
WECOM_BOT_SECRET=...
# 只允许你自己操作，逗号分隔。留空 = 任何人都能触发，危险
WECOM_ALLOWED_USERS=your-userid
```

4. 安装依赖并启动：

```bash
npm install
npm run bot
```

`@wecom/aibot-node-sdk` 在 `optionalDependencies` 里，正常 `npm install` 会装；
如果被跳过，手动 `npm i @wecom/aibot-node-sdk`。

5. 常驻（systemd）：

```ini
[Unit]
Description=wechat-daily bot
After=network-online.target

[Service]
User=youruser
WorkingDirectory=%h/wechat-daily
ExecStart=/usr/bin/node src/bot/aibot.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 指令

| 你说 | 它做什么 |
|---|---|
| *（直接说一段话）* | 当作选题 + 要求，立刻开写 |
| `主题 \| 要求` | 竖线分隔选题和额外要求 |
| `状态` | 当前在写什么、进行几分钟 |
| `重写 [新要求]` | 沿用上次选题再写一版 |
| `取消` | 放弃本次 |
| `帮助` | 说明 |

写完后它会主动推送结果。如果配置了 pi agent，复杂要求（做封面、改标题、重推草稿）会交给 agent。

### 每天 9:00 主动问

```bash
npm run ask
```

用 systemd timer 每天 09:00 触发即可（参考 [OPERATIONS](OPERATIONS.md) 的写法）。

### 安全

- `WECOM_ALLOWED_USERS` 必须填。长连接虽然不暴露公网端口，但机器人本身能执行命令。
- 不要把这个机器人拉进群，除非你确认群成员都可信。
- 机器人日志在 `data/logs/bot-*.log`。

---

## 3. 自建应用 + 回调（不推荐，代码保留）

`src/bot/server.js` 是早期方案：本地 HTTP 服务 + 企业微信回调 + Tailscale Funnel。
要求回调域名备案，个人一般走不通。保留它是为了将来有备案域名时用。

如果坚持要试：

```bash
node src/bot/server.js --port=8899
```

它只监听 `127.0.0.1`，公网入口建议用 Tailscale Funnel：

```bash
tailscale funnel --bg 8899
```

`.env` 需要：

```bash
WECOM_CORPID=...
WECOM_CORPSECRET=...
WECOM_AGENTID=...
WECOM_TOKEN=...
WECOM_AESKEY=...     # 43 位
BOT_PORT=8899
```

> Funnel 的 URL 是可被扫描到的，务必配置 `WECOM_ALLOWED_USERS` 并保持最小权限。

---

## 4. 手机网页入口

```bash
# .env
WEB_TOKEN=一个随机字符串
WEB_HOST=127.0.0.1     # 或 Tailscale 网卡地址；0.0.0.0 会暴露给同网段
WEB_PORT=8788

npm run web
```

打开 `http://<host>:8788/?token=<WEB_TOKEN>`，输入选题、看进度、完成后去草稿箱群发。

安全：

- 没有 `WEB_TOKEN` 服务会拒绝启动
- `WEB_HOST=0.0.0.0` 时同网段设备都能访问（有 token 保护，但仍建议改成内网地址）
- 这不是公网服务，不要直接暴露到互联网

---

## 5. 接入 pi agent（可选）

默认的机器人能理解固定指令；接入 pi 之后，说人话也行：

```
给今天这篇做两个不同风格的封面，放到 outbox 给我看
把第三段压一压，再推一次草稿
```

链路：

```
企业微信消息
  ↓ 固定指令（帮助/状态/取消）本地直接回
  ↓ 其余 → spawn pi --print --session-id wecom-<userid>
      pi 用 bash 跑 src/main.js / src/tools/cover.js …
      想给你看图 → 把文件放进 data/outbox/
  ↓ agent 结束后：先发 outbox 里的图，再发文字结果
```

配置：

```bash
# pi 可执行文件；默认在 PATH 里找
PI_BIN=/usr/local/bin/pi
PI_MODEL=opencode-go/deepseek-v4.1-flash
PI_THINKING=auto     # auto = 不传 --thinking，用 pi 自己的默认档位
```

pi 的模型凭证要让它自己能读到（pi 的 `models.json`），或者由 `.env` 注入。
`src/bot/agent.js` 会把 `OPENCODE_API_KEY` 传给子进程。

行为约定写在 `config/agent-prompt.md`：

- 工作目录 = 项目根目录
- 想让人看到图片 → 复制到 `data/outbox/`
- 有任务在跑时，依赖产物的要求要轮询等待
- 不编造结果、不乱删文件

安全：

- `WECOM_ALLOWED_USERS` 限定只有你能触发，否则等于把 shell 开放给任何人
- agent 只拿到 `bash,read,write,edit,ls,grep,find` 工具
- 单次任务默认 30 分钟超时，超时 kill

---

## 6. 通知（不配机器人也能用）

`.env`：

```bash
# none | webhook | serverchan
NOTIFY_CHANNEL=webhook
NOTIFY_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
# 或
NOTIFY_CHANNEL=serverchan
NOTIFY_SERVERCHAN_KEY=...
```

草稿成功或失败时会推一条消息，附带标题、字数、media_id。
通知失败不会让发文流程失败。
