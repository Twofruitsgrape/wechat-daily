# 开工前需要准备什么

这份清单是给「人」看的。全部准备完大约 15 分钟，其中只有 AppSecret 和 IP 白名单两步必须你本人操作。

---

## 一、必须准备（缺一不可）

### 1. 一个微信公众号

个人订阅号就行，不需要认证，不需要企业主体。

- 没有账号：https://mp.weixin.qq.com → 立即注册 → 订阅号
- 已有账号：确认你能用管理员微信扫码登录

> 个人订阅号能用的接口：拿到 access_token、上传图片/封面、建草稿。
> 不能用的接口：API 直接群发（`freepublish`，会报 `48001`）。
> 所以本项目的默认模式是「进草稿箱 + 你手动点群发」。

### 2. AppID

公众平台 → 设置与开发 → 基本配置 → 开发者ID(AppID)，形如 `wx` + 16 位十六进制。

这个不算秘密，但也别到处贴。

### 3. AppSecret

公众平台 → 设置与开发 → 基本配置 → 开发者密码(AppSecret) → 生成/重置。

**需要管理员微信扫码**，agent 代替不了。生成后只显示一次（或需重置），复制保存好。

常见坑：

- 个人主体要先在「安全中心」启用开发者密码
- AppSecret 是 32 位字母数字，前后不要带空格
- 如果泄露过，直接在同一个页面重置，旧的立即失效

### 4. 把出口 IP 加进白名单

公众平台 → 设置与开发 → 基本配置 → IP 白名单 → 修改。

**这是最容易卡住的一步**：你不需要提前知道 IP，项目里有工具会问微信：

```bash
npm run whitelist
# 或 node src/tools/whitelist.js --times=40
```

它会反复请求微信接口，从 `40164` 的报错里读出「微信看到的你的 IP」，并打印一份可直接粘贴的列表。

- 只出现 1 个 IP：填这一个
- 出现 2–4 个：全填（白名单支持多个）
- 出现 5 个以上还在变：说明出口 IP 不固定，建议用一台固定 IP 的小机器做反向代理，
  然后在 `.env` 里设置 `WECHAT_BASE_URL`

> 白名单改完可能有一两分钟生效。改完跑 `npm run check` 确认。

### 5. 一个 OpenAI 兼容的模型 API Key

任意一家都行，只要接口是 `POST {base}/chat/completions`。常见选择：

| 服务 | Base URL | 模型示例 | 备注 |
|---|---|---|---|
| OpenCode Go（默认） | `https://opencode.ai/zen/go/v1` | `deepseek-v4.1-flash` | 项目作者用的订阅，模型带视觉 |
| DeepSeek 官方 | `https://api.deepseek.com/v1` | `deepseek-chat` | 便宜；确认所选模型支持图片输入 |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-32k` | 中文写作稳定 |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` | 需要能访问 |
| 自建 / 中转 | 你的地址 | 你的模型名 | 注意中转是否支持 `max_tokens` |

配置时只需要 3 个值：

```bash
OPENCODE_API_KEY=...
OPENCODE_BASE_URL=https://api.deepseek.com/v1
OPENCODE_MODEL=deepseek-chat
```

**关于视觉模型**：只有用「文献配图」或「PDF 解读」时才需要模型能看图。
如果模型不支持图片输入，那部分会失败，但纯文字写作不受影响。

### 6. Node.js 20 或更高

```bash
node -v    # 需要 v20.x 或 v22.x / v24.x
```

没有就去 https://nodejs.org 装 LTS 版。Windows 安装时勾选「Add to PATH」。

> 项目依赖 `sharp`（图片处理）。`npm install` 会自动下载预编译二进制，
> 不需要本地编译工具。如果公司网络拦截了 npm，先配置镜像。

---

## 二、可选准备（用到才装）

| 需求 | 需要什么 | 说明 |
|---|---|---|
| 定时每天跑 | 一台常开的 Linux 机器 | 也可以用 Windows 任务计划程序，但仓库里的 `bin/*.sh` 是给 Linux 的 |
| 文献配图 / PDF 解读 | `pdftotext`、`pdfimages`（poppler） | Ubuntu: `sudo apt install poppler-utils`；macOS: `brew install poppler`；Windows: `choco install poppler` |
| 封面中文不显示方块 | 中文字体 | Linux: `sudo apt install fonts-noto-cjk`；Windows/macOS 自带 |
| 机器人对话发文 | 企业微信自建应用 + 公网回调地址 | 见 [docs/BOT.md](docs/BOT.md) |
| 手机网页入口 | 内网访问 + 一个随机 token | 见 [docs/BOT.md](docs/BOT.md) |
| 机器人接 pi agent | 本机安装 pi | 见 [docs/BOT.md](docs/BOT.md) |

---

## 三、你要给 agent 的信息

只给这 3 个（外加可选的作者名）：

```
WECHAT_APPID=wx...
WECHAT_APPSECRET=...
OPENCODE_API_KEY=...
WECHAT_AUTHOR=你的笔名（可留空）
```

**不要**把密钥写进 GitHub issue、公开聊天、截图或代码里。
更稳妥的方式是在自己的终端里 `export`，再让 agent 跑：

```bash
node scripts/setup.mjs --from-env
```

---

## 四、准备完的自检清单

- [ ] `node -v` ≥ 20
- [ ] 能登录 mp.weixin.qq.com
- [ ] 有 AppID
- [ ] 有 AppSecret（32 位）
- [ ] 模型 API Key 可用（能发一次 `chat/completions`）
- [ ] 知道怎么改 IP 白名单
- [ ] 决定好公众号的定位和读者（会写进 `config/site.yaml`）

全打勾后，回到 [START-HERE.md](START-HERE.md) 或把 [PROMPT-FOR-AGENT.md](PROMPT-FOR-AGENT.md) 发给 agent。
