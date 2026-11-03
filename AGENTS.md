# AGENTS.md

你正在操作一个「微信公众号每日自动发文」项目。用户通常不是程序员，只是想把账号跑通。
你的职责是**把它配置到能跑、验证一遍、如实汇报**，而不是改造它。

---

## 成功标准

以下 5 条全部满足，才算完成：

1. `npm install` 成功，`npm run selftest` 通过
2. 项目根目录有 `.env`，且 `npm run check` 里模型和微信凭证都显示可用
3. 用户已经把正确的出口 IP 加进公众号白名单（或项目已用固定 IP 中转）
4. 用 `npm run dry -- --topic="..."` 生成出一篇完整的 `article.md` / `article.html` / `cover.png`
5. 用 `npm run daily` 成功拿到草稿 `media_id`（或明确告诉用户卡在哪一步）

不要跳过第 4 步直接跑第 5 步——那会浪费用户的模型额度。

---

## 先读这些

| 文件 | 为什么读 |
|---|---|
| `使用说明.md` | 面向用户的完整中文手册（安装、配置、日常、排错） |
| `REQUIREMENTS.md` | 用户需要准备什么，缺什么就问 |
| `START-HERE.md` | 用户体验视角的流程 |
| `docs/SETUP.md` | 配置细节和 IP 白名单 |
| `docs/TROUBLESHOOTING.md` | 报错对照表 |

---

## 操作规程

### 0. 确认工作目录

所有命令都在项目根目录执行（有 `package.json` 的那一层）。
如果是 Windows，shell 用 PowerShell 或 cmd；`bin/*.sh` 不要碰。

### 1. 环境检查

```bash
node -v        # 必须 >= 20
npm install
npm run selftest
```

`selftest` 不联网，失败通常是 Node 版本、依赖没装好、或中文字体缺失。

### 2. 收取凭证（只收 3 个必填 + 1 个可选）

向用户要：

- `WECHAT_APPID`
- `WECHAT_APPSECRET`
- `OPENCODE_API_KEY`
- `WECHAT_AUTHOR`（可选）

**永远不要**把密钥回显在对话里、写进命令输出、写进 git、写进 README 或示例文件。
写 `.env` 时优先用非交互方式：

```bash
node scripts/setup.mjs --set WECHAT_APPID='wx...' --set WECHAT_APPSECRET='...' --set OPENCODE_API_KEY='...'
```

或者让用户在自己的终端 `export`，再：

```bash
node scripts/setup.mjs --from-env
```

`setup.mjs` 会保留已有 `.env` 的其它配置，并在修改前备份 `.env.bak`。
写完检查：

```bash
node scripts/setup.mjs --check
```

### 3. 处理出口 IP（90% 的失败都在这里）

```bash
npm run whitelist
```

- 输出里有 1–4 个 IP：把**全部 IP** 告诉用户，让他加到
  「公众平台 → 设置与开发 → 基本配置 → IP 白名单」。
- 输出 5 个以上且一直变：建议用户用固定 IP 中转，并设置 `WECHAT_BASE_URL`
  （先别改，问用户有没有固定 IP 的机器）。
- 如果直接返回 token：白名单已经配好了。

**你不能替用户点微信后台。** 到这一步就停下来，明确告诉用户要做什么，然后等他说「加好了」。

### 4. 联网自检

```bash
npm run check
```

逐项看：

- 模型可用 → 否则检查 `OPENCODE_BASE_URL` / `OPENCODE_API_KEY` / 模型名
- 封面渲染出 PNG → 否则大概率是 Sharp 或中文字体问题
- 出口 IP 列表 → 与用户填的白名单比对
- `AppID/AppSecret 有效` → 否则检查凭证或白名单
- 发布模式是 `draft` → 个人主体不要改成 `freepublish`

### 5. 试写一篇

```bash
npm run dry -- --topic="一个具体的、2000 字能讲清的问题"
```

耗时约 3–8 分钟。完成后验证：

```bash
ls data/out/<今天>/
```

- `article.md` 存在，字数在 1500–3000 之间
- `article.html` 存在，长度 > 5000 字符
- `cover.png` 存在，大小 > 20KB
- `meta.json` 里有 `plan.title`、`article.digest`

把标题、字数、产物路径告诉用户，并建议预览：

```bash
npm run preview -- data/out/<今天>/article.md --open
```

### 6. 正式进草稿箱

```bash
npm run daily
```

成功标志：日志里出现 `草稿已进箱：media_id=...`，退出码 0。

如果文章已经生成、只是草稿失败，修好之后再推，不要重写：

```bash
npm run push
```

### 7. 汇报

最后用简短中文告诉用户：

- 配置在哪、哪些是可选项
- 第一篇草稿的标题和入口（订阅号助手 / mp.weixin.qq.com → 草稿箱）
- 下一步：每天定时，还是聊天触发（见 `docs/OPERATIONS.md`、`docs/BOT.md`）
- 头两周建议人工过一遍再群发

---

## 失败处理

| 现象 | 先做什么 |
|---|---|
| `fetch failed` / 超时 | 检查网络；换模型 base URL；`npm run check` 重试 |
| `40164` | 跑 `npm run whitelist`，让用户加白名单 |
| `40001` / `40125` | AppSecret 错，让用户重置后再写 `.env` |
| `48001` | 个人主体没有发表权限；保持 `PUBLISH_MODE=draft`，用草稿箱 |
| `45002` | 正文超长；调低 `article.max_words` |
| 封面中文变方块 | 装中文字体（Linux: `fonts-noto-cjk`），或确认系统字体 |
| `sharp` 安装失败 | 换 npm 镜像；确认 Node 版本；Windows 需要 64 位 |
| 模型返回空内容 | 该模型可能是推理模型；调大 `max_tokens` 或换模型 |
| `npm run daily` 说今天已处理 | 正常防重；用 `--force`，或 `npm run push` 推已有文章 |
| 选题重复 | 检查 `config/topics.yaml` 的 `pool` 和 `data/state.json` |

**不要**为了绕过错误去改代码里的逻辑、删掉校验、或把 `PUBLISH_MODE` 改成 `freepublish`。
先如实告诉用户错误是什么。

---

## 安全红线

1. 不提交 `.env`、`.env.bak`、`data/`。
2. 不在输出里打印完整密钥；需要展示时用 `wx12…cdef` 这种形式。
3. 不把用户的 AppSecret / API Key 写进任何被 git 跟踪的文件。
4. 不修改用户的公众号设置、不代替用户点群发。
5. 不删除 `config/`、`src/`、`data/out/` 里的既有内容；只清理自己生成的临时文件。
6. 需要改配置时优先改 `.env` 和 `config/*.yaml`，不要改代码。
7. 用户如果要求「自动群发」，解释个人主体限制，不要尝试绕过。

---

## 可选模块（用户明确要求再做）

| 模块 | 入口 | 前提 |
|---|---|---|
| 定时每天跑 | `bin/daily.sh` + systemd timer | Linux 常开机器 |
| 文献配图 | `--paper=auto` | poppler + 支持视觉的模型 |
| PDF 解读 | `--from-paper=<pdf>` | poppler |
| 企业微信机器人 | `npm run bot` | 企业微信自建应用 + 公网回调 |
| 手机网页 | `npm run web` | 内网 + `WEB_TOKEN` |
| pi agent | `src/bot/agent.js` | 本机安装 pi |

这些都不是跑通主流程的必要条件。先让核心流程跑起来，再逐项加。

---

## 验收清单（复制到回复里逐项打勾）

- [ ] `npm run selftest` 通过
- [ ] `.env` 存在且 `npm run setup:check` 通过
- [ ] 白名单已由用户确认
- [ ] `npm run check` 模型 + 凭证可用
- [ ] `npm run dry` 产物齐全
- [ ] `npm run daily` 拿到 `media_id`
- [ ] 已告诉用户下一步和人工群发的位置
