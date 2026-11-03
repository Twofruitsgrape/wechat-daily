# wechat-daily

个人主体微信公众号的每日自动写作流水线。

**选题 → 大纲 → 写作 → 自检 → 封面 → 排版 → 进草稿箱 → 通知你去点群发。**

只用微信官方服务端 API，不做浏览器模拟点击、不碰账号密码。
模型侧是任意 OpenAI 兼容接口（默认给了一套能跑的配置），不绑定某一家厂商。

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ 选题      │ → │ 大纲/正文 │ → │ 自检润色  │ → │ 封面/排版 │ → 草稿箱 → 你点群发
└──────────┘   └──────────┘   └──────────┘   └──────────┘
   话题池         4 次模型调用    去 AI 味        900×383 PNG
   或模型自选                     事实降级        微信安全 HTML
```

---

## 为什么最后一步要你点

微信官方文档写得很清楚：2025 年 7 月起，**个人主体账号被回收「发布」接口权限**，
`freepublish/submit` 会返回 `48001`。个人号能走通的完整链路只有：

```
API 写稿 → API 排版 → API 上传封面 → API 建草稿（draft/add）
   ↓
你在「订阅号助手」或 mp.weixin.qq.com 草稿箱看一眼，点「群发」
   ↓
粉丝收到推送
```

每天花 10 秒点一下。这是平台规则，不是工程上的偷懒。
如果哪天你的号变成已认证的企业主体，把 `.env` 的 `PUBLISH_MODE` 改成 `freepublish` 就能全自动。

---

## 三分钟上手

### 0. 你需要先准备

| 东西 | 在哪里拿 | 大概耗时 |
|---|---|---|
| 微信公众号（个人订阅号即可） | mp.weixin.qq.com 注册 | 已有账号则 0 |
| AppID | 设置与开发 → 基本配置 | 1 分钟 |
| AppSecret | 同上，需管理员微信扫码启用 | 3 分钟 |
| 模型 API Key | 任意 OpenAI 兼容服务 | 5 分钟 |
| Node.js ≥ 20 | https://nodejs.org | 5 分钟 |

完整清单（含 IP 白名单、常见坑）见 **[REQUIREMENTS.md](REQUIREMENTS.md)**。

### 1. 安装 + 配置

```bash
npm install
npm run setup        # 交互式向导，只问必填项，写 .env
npm run selftest     # 离线自检：配置 / 排版 / 封面 / 密钥扫描
```

### 2. 让微信认识你的 IP

```bash
npm run whitelist    # 反复请求微信接口，从 40164 报错里读出它看到的出口 IP
```

把打印出来的 IP 全部填进：
**公众平台 → 设置与开发 → 基本配置 → IP 白名单 → 修改**。

### 3. 联网自检

```bash
npm run check
```

看到 `✅ AppID/AppSecret 有效` 和模型可用，就可以正式跑了。

### 4. 先试一篇（不碰微信）

```bash
npm run dry -- --topic="选一个你真正关心的问题"
```

产物在 `data/out/<今天>/`：`article.md`、`article.html`、`cover.png`、`meta.json`。
浏览器预览排版：

```bash
npm run preview -- data/out/<今天>/article.md --open
```

### 5. 正式跑

```bash
npm run daily
```

写完自动进草稿箱。打开「订阅号助手」看一眼，点群发。

---

## 交给 agent 配置

这个仓库是按「用户把压缩包发给 agent，agent 自己配好」设计的：

1. 用户解压后，把 **[PROMPT-FOR-AGENT.md](PROMPT-FOR-AGENT.md)** 的内容发给 agent；
2. agent 会读 **[AGENTS.md](AGENTS.md)** 和 **[REQUIREMENTS.md](REQUIREMENTS.md)**；
3. 用户只需要提供 3 个值：AppID、AppSecret、模型 API Key；
4. agent 负责 `npm install`、写 `.env`、跑自检、处理 40164、试写第一篇。

密钥不会进 shell 历史的方式：

```bash
# 在 agent 的终端里先 export，再让脚本从环境变量读
export WECHAT_APPID='wx...'
export WECHAT_APPSECRET='...'
export OPENCODE_API_KEY='...'
node scripts/setup.mjs --from-env
```

`setup.mjs` 是幂等的：已有 `.env` 只在原行改值，注释和顺序都保留，改之前备份 `.env.bak`。

---

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run setup` | 配置向导（幂等） |
| `npm run selftest` | 离线自检，不联网 |
| `npm run check` | 联网自检：模型 / 封面 / 排版 / 出口 IP / 凭证 |
| `npm run whitelist` | 自动发现该填哪些出口 IP |
| `npm run dry` | 只生成，不碰微信 |
| `npm run daily` | 生成 + 进草稿箱 |
| `npm run daily -- --topic="..." --brief="..."` | 指定选题和额外要求 |
| `npm run daily -- --paper=auto` | 自动搜一篇论文并配图 |
| `npm run daily -- --from-paper=paper.pdf` | 以指定 PDF 为唯一依据写解读稿 |
| `npm run daily -- --until=render` | 只生成到本地，连图片都不上传 |
| `npm run push` | 文章已生成但草稿失败时，修好凭证后补推（不重写） |
| `npm run cover -- --date=YYYY-MM-DD --n=3` | 生成多个封面方案 |
| `npm run preview -- <md> --open` | 本地预览微信排版 |
| `npm run probe -- --write` | 逐个接口测权限（会写测试数据，测完删掉） |

定时运行、日志、失败重试见 **[docs/OPERATIONS.md](docs/OPERATIONS.md)**。

---

## 配置在哪

| 文件 | 管什么 |
|---|---|
| `.env` | 密钥和开关（不提交） |
| `config/site.yaml` | 人设、读者、文风、字数、排版主题、封面 |
| `config/topics.yaml` | 选题方向、选题池、明确不写的东西 |
| `config/agent-prompt.md` | 企业微信机器人把任务交给 agent 时的系统提示词 |

改 `config/*.yaml` 不需要重启任何东西，下一次运行自动生效。

**换一个号**：只改 `.env` 里的 `WECHAT_APPID` / `WECHAT_APPSECRET` / `WECHAT_AUTHOR`。

**换一个模型厂商**：改 `.env` 里的 `OPENCODE_BASE_URL` / `OPENCODE_API_KEY` / `OPENCODE_MODEL`。
变量名里的 `OPENCODE_` 是历史命名，不绑定 OpenCode，只要服务端实现 `/chat/completions` 就能用。

---

## 目录结构

```
wechat-daily/
├── .env.example            # 配置模板（所有键都有注释）
├── scripts/
│   ├── setup.mjs           # 配置向导（交互 / --set / --from-env / --check）
│   └── selftest.mjs        # 离线自检
├── config/
│   ├── site.yaml           # 人设、排版主题、封面
│   ├── topics.yaml         # 选题池
│   └── agent-prompt.md     # 机器人的系统提示词
├── src/
│   ├── main.js             # 主流程（10 个阶段）
│   ├── topic.js            # 选题
│   ├── writer.js           # 大纲 / 正文 / 补写 / 自检
│   ├── cover.js            # SVG → PNG 封面（sharp）
│   ├── render.js           # 自写 Markdown → 微信安全 HTML
│   ├── wechat.js           # 微信 API：token / 素材 / 草稿 / 发表
│   ├── llm.js              # OpenAI 兼容客户端
│   ├── paper.js            # 文献检索、PDF 抽图、看图写注
│   ├── images.js           # 正文图上传微信 CDN
│   ├── notify.js           # webhook / Server酱
│   ├── state.js            # token 缓存、运行记录、防重复
│   ├── tools/              # check / probe / push / cover / preview / whitelist
│   ├── bot/                # 企业微信机器人（可选）
│   └── web/                # 手机网页入口（可选）
├── bin/
│   ├── daily.sh            # 定时任务入口：等网络、防并发、失败重试
│   └── wifi-watchdog.sh    # 断网看门狗（可选，Linux）
└── data/                   # 运行产物（不提交）
```

---

## 文档

| 文档 | 内容 |
|---|---|
| **[REQUIREMENTS.md](REQUIREMENTS.md)** | 开工前需要准备什么，逐项怎么拿 |
| **[START-HERE.md](START-HERE.md)** | 解压后第一页（给人和 agent） |
| **[PROMPT-FOR-AGENT.md](PROMPT-FOR-AGENT.md)** | 直接复制给 agent 的提示词 |
| **[AGENTS.md](AGENTS.md)** | agent 的操作规程和验收标准 |
| **[docs/SETUP.md](docs/SETUP.md)** | 手工配置全流程、IP 白名单、换模型 |
| **[docs/CONTENT.md](docs/CONTENT.md)** | 人设、选题、篇幅、排版、封面的调法 |
| **[docs/OPERATIONS.md](docs/OPERATIONS.md)** | 定时、部署、日志、断网、备份 |
| **[docs/PAPER.md](docs/PAPER.md)** | 文献配图与 PDF 解读 |
| **[docs/BOT.md](docs/BOT.md)** | 企业微信机器人 / pi agent / 网页入口 |
| **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** | 错误码和常见问题 |

---

## 它能做什么，不能做什么

**能做**

- 每天定时或在聊天里触发，写一篇 1800–2600 字的文章
- 按你配置的人设和禁用词写，自动做一轮「去 AI 味 + 事实性」自检
- 自动生成 900×383 封面，标题自动折行、避头点
- 把 markdown 渲染成微信能接受的内联样式 HTML（外链收进文末）
- 从 arXiv / OpenAlex 找论文、抽图、写图注、插进正文
- 进草稿箱，并发通知给你

**不能做**

- 个人主体账号不能 API 直接群发（平台限制）
- 不能替代你对内容质量的判断。头两周建议每篇都过一眼再发
- 矢量图（matplotlib/TikZ 画的）抽不出来，只能识别 PDF 里的位图
- 不保证生成内容一定符合微信的 AI 内容治理规则

---

## 合规与风险

1. **AI 生成内容**：微信对低质量 AI 内容有限流和处置规则。本项目做了禁用套话、
   事实降级、不编造引用等约束，但它不会让一篇文章自动变得值得读。
2. **群发频次**：订阅号 1 次/天，服务号 4 次/月。
3. **原创声明**：API 建的草稿没有原创标识，需要在手机端点群发时手动勾选。
4. **密钥**：`.env` 权限 600，已在 `.gitignore`。如果曾经把密钥贴到聊天窗口，建议重新生成。
5. **文献图片版权**：arXiv 上很多是 CC BY，但 Elsevier/Springer 的图版权归出版商，
   公开发布前确认许可，或只引用不搬运。

---

## 说明与参考

本项目由 elice 维护，是独立实现：选题、写作、自检、排版、封面、草稿箱、机器人、文献配图
等模块都在个人使用中持续迭代，没有直接复制其他项目的代码。

设计阶段调研过下面这些同类项目，产品形态上受它们启发，特此致谢：

| 项目 | 它做了什么 |
|---|---|
| [jiji262/wechat-publisher](https://github.com/jiji262/wechat-publisher) | 选题 → 写作 → 配图 → 微信排版 → 草稿箱，可作为 agent Skill 调用；与本项目链路最接近 |
| [16Miku/wechat-auto-publishing](https://github.com/16Miku/wechat-auto-publishing) | 把「API 建草稿 + 人工发表」沉淀成可复现工作流，强调个人主体不要默认 freepublish |
| [liyown/ai-trend-publish](https://github.com/liyown/ai-trend-publish) | TrendPublish：从选题、排序、写作到草稿箱的全流程系统 |
| [TongTong313/wechat-ai-daily](https://github.com/TongTong313/wechat-ai-daily) | 采集公众号文章 → LLM 筛选 → 生成的日报式流水线 |

微信排版参数另参考了机器之心、可能吧等公众号的公开文章。

以上仅表示设计调研与启发，不代表代码来源；本项目未复制上述项目的代码。

## 从旧版本迁移

`.env` 的键名、`config/*.yaml` 的结构都没变。把旧 `.env` 直接复制到新目录即可，
已有的 AppID / AppSecret / 模型配置继续有效。

---

## License

[MIT](LICENSE)
