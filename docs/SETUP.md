# 详细配置

三分钟版本在 [README](../README.md)，这里写每一步的细节和踩坑。

---

## 1. 微信侧

### 1.1 AppID / AppSecret

公众平台 → 设置与开发 → 基本配置：

| 项 | 用途 | 是否敏感 |
|---|---|---|
| 开发者ID(AppID) | 标识你的公众号 | 否 |
| 开发者密码(AppSecret) | 换 access_token | **是** |

AppSecret 需要管理员微信扫码才能生成/重置。生成后填进 `.env`：

```bash
WECHAT_APPID=<你的 AppID>
WECHAT_APPSECRET=0123456789abcdef0123456789abcdef
```

> 个人主体如果看不到「开发者密码」，先在安全中心启用。

### 1.2 IP 白名单

微信只接受白名单内 IP 的调用。很多人卡在这里，因为「本机出口 IP」并不是
`ifconfig` 里那个内网地址，而是运营商/公司 NAT 之后、微信看到的那个地址。

本项目不让你猜，直接问微信：

```bash
npm run whitelist
```

原理：反复请求 `stable_token`，微信如果发现 IP 不在白名单，会在 `40164` 的
错误信息里写出它看到的 IP（`invalid ip 203.0.113.42 ..., not in whitelist`）。
脚本把这些 IP 汇总去重，打印成可直接粘贴的列表。

- 只有 1 个：填它
- 2–4 个：全部填（白名单支持多个）
- 5 个以上还在轮换：说明出口 IP 不固定

**出口 IP 不固定怎么办**

1. 找一台有固定公网 IP 的小机器（VPS），做反向代理到 `https://api.weixin.qq.com`
2. 白名单只填 VPS 的 IP
3. `.env` 里设置：

```bash
WECHAT_BASE_URL=https://wxapi.your-domain.example
```

代码里所有微信请求都会走这个地址。注意：反代要保留原始 Host 和路径，并且只允许你的机器访问。

### 1.3 发布模式

| 值 | 行为 | 适合 |
|---|---|---|
| `draft` | 只建草稿，人工点群发 | **个人主体（默认）** |
| `freepublish` | 调 `freepublish/submit` 直接发表 | 已认证企业主体 |

个人主体调 `freepublish` 会返回 `48001`。不要为了「全自动」去改这个值。

---

## 2. 模型侧

变量名是历史遗留的 `OPENCODE_*`，实际是 OpenAI 兼容协议：

```
POST {OPENCODE_BASE_URL}/chat/completions
Authorization: Bearer {OPENCODE_API_KEY}
```

| 变量 | 说明 |
|---|---|
| `OPENCODE_API_KEY` | 必填 |
| `OPENCODE_BASE_URL` | 必填，通常以 `/v1` 结尾 |
| `OPENCODE_MODEL` | 写正文用的模型 |
| `OPENCODE_MODEL_FAST` | 选题 / 大纲 / 自检 / 看图；留空复用上面 |
| `PAPER_VISION_MODEL` | 只看论文配图的模型；留空复用 fast |

### 换厂商示例

```bash
# DeepSeek 官方
OPENCODE_BASE_URL=https://api.deepseek.com/v1
OPENCODE_MODEL=deepseek-chat
OPENCODE_MODEL_FAST=deepseek-chat

# 月之暗面
OPENCODE_BASE_URL=https://api.moonshot.cn/v1
OPENCODE_MODEL=moonshot-v1-32k
OPENCODE_MODEL_FAST=moonshot-v1-32k

# OpenAI
OPENCODE_BASE_URL=https://api.openai.com/v1
OPENCODE_MODEL=gpt-4.1-mini
OPENCODE_MODEL_FAST=gpt-4.1-mini
```

注意事项：

- **推理模型**可能把 `max_tokens` 全花在 reasoning 上，`content` 返回空。
  遇到就换模型或调大 `max_tokens`（`src/llm.js` 里的默认值）。
- **文献配图**需要模型支持图片输入；纯文字模型会在「看图写图注」这一步失败。
- 有些中转服务不支持 `max_tokens` 或 `temperature`，会直接 400。先用 `npm run check` 验证。

### 用 OpenCode Go

```bash
OPENCODE_BASE_URL=https://opencode.ai/zen/go/v1
OPENCODE_MODEL=deepseek-v4.1-flash
OPENCODE_API_KEY=...
```

这个服务要求 `x-opencode-session` 请求头。代码只在 base URL 属于 `opencode.ai` 时自动加，
换别家不会带这个头。

---

## 3. 写入 .env

推荐向导：

```bash
npm run setup
```

它只问 5 个问题，且：

- 已有 `.env` 时在原行改值，保留注释
- 改之前备份 `.env.bak`
- POSIX 下 `chmod 600`
- 屏幕上不回显密钥
- 缺必填项会明确报出来

非交互（agent 用）：

```bash
node scripts/setup.mjs --set WECHAT_APPID='wx...' --set WECHAT_APPSECRET='...' --set OPENCODE_API_KEY='...'
node scripts/setup.mjs --check
```

从环境变量读：

```bash
export WECHAT_APPID='wx...'
export WECHAT_APPSECRET='...'
export OPENCODE_API_KEY='...'
node scripts/setup.mjs --from-env
```

手动创建也可以：复制 `.env.example` 为 `.env`，只改必填项。

---

## 4. 验证

按顺序跑：

```bash
npm run selftest     # 离线：配置语法、排版、封面、密钥扫描
npm run whitelist    # 出口 IP
npm run check        # 联网：模型、封面、排版、凭证
npm run dry          # 试写一篇
```

`check` 的输出逐项含义：

| 行 | 通过标准 |
|---|---|
| 运行环境 | Node ≥ 20，配置文件存在 |
| 模型 | 模型返回了文本 |
| 封面渲染 | 生成 900×383 PNG |
| 排版 | 没有 script/class/style，外链进文末 |
| 出口 IP | 列出微信看到的 IP，与白名单比对 |
| 微信凭证 | `AppID/AppSecret 有效` |
| 发布模式 | 个人主体应为 draft |

---

## 5. 账号信息

`.env` 里的 `WECHAT_AUTHOR` 和 `config/site.yaml` 里的 `account` 控制草稿箱显示的作者名。
留空也可以，微信会用账号默认信息。

```yaml
account:
  name: ""       # 公众号名（封面右下角署名）
  author: ""     # 留空则用 WECHAT_AUTHOR
```

---

## 6. 平台说明

| 平台 | 核心流程 | 定时 | 机器人 |
|---|---|---|---|
| Windows | 支持 | 任务计划程序 | 可以，但 `bin/*.sh` 不适用 |
| macOS | 支持 | launchd / cron | 可以 |
| Linux | 支持 | systemd timer（推荐） | 可以 |

Windows 注意事项：

- 用 PowerShell 或 cmd，不要用 `bash deploy.sh`
- `sharp` 预编译二进制需要 64 位 Node
- 中文字体系统自带（微软雅黑），封面一般不会缺字
- 如果遇到 `EPERM`，把项目放在非系统目录（不要在 `C:\Program Files` 下）

Linux 注意事项：

- 封面需要中文字体：`sudo apt install fonts-noto-cjk`
- 文献配图需要 poppler：`sudo apt install poppler-utils`
- 用 systemd timer 而不是 cron（见 [OPERATIONS](OPERATIONS.md)）

---

## 7. 迁移旧配置

`.env` 的键名和 `config/*.yaml` 的结构保持稳定。旧项目的 `.env` 可以直接复制过来。
新增的可选键（如 `WECHAT_BASE_URL`）不填也不影响。
