# 从这里开始

你拿到的是一个可以自己写公众号的流水线。它不会替你注册账号，也不需要你懂代码——
把凭证填进去，剩下的交给命令或 agent。

> 需要完整版？看 **[使用说明.md](使用说明.md)**（中文，包含配置、命令、排错、定时）。

---

## 你会得到什么

每天（或你触发时）自动生成一篇 1800–2600 字的文章、一张 900×383 的封面、
一份微信能直接用的排版 HTML，最后进你的公众号草稿箱。你只需要在手机上点「群发」。

---

## 第一步：装 Node.js

需要 20 或更高版本：https://nodejs.org

装完在终端里确认：

```bash
node -v
```

---

## 第二步：安装依赖

在项目目录里打开终端：

```bash
npm install
```

Windows 用户：在文件夹地址栏输入 `cmd` 回车，就能在当前目录打开终端。

---

## 第三步：配置

```bash
npm run setup
```

会依次问你：AppID、AppSecret、作者名、模型 API Key、模型地址。
**AppSecret 和 API Key 输入时不回显**，这是正常的。

不知道这些在哪拿？看 [REQUIREMENTS.md](REQUIREMENTS.md)。

---

## 第四步：把 IP 加进白名单

```bash
npm run whitelist
```

把打印出来的 IP 粘到：公众平台 → 设置与开发 → 基本配置 → IP 白名单。

然后联网自检：

```bash
npm run check
```

---

## 第五步：试一篇

```bash
npm run dry -- --topic="一个你真正关心的问题"
```

去 `data/out/<今天>/` 看 `article.md`、`article.html`、`cover.png`。

觉得可以，再正式跑：

```bash
npm run daily
```

打开「订阅号助手」App → 草稿箱 → 看一眼 → 群发。

---

## 不想自己配？把这句话发给 agent

> 我解压了一个公众号自动发文项目。请读 `AGENTS.md` 和 `REQUIREMENTS.md`，
> 帮我把环境配到能跑：装依赖、写 `.env`、跑通自检、试写一篇。
> 我的 AppID / AppSecret / 模型 API Key 稍后发你。不要把它们写进任何提交。

完整提示词在 [PROMPT-FOR-AGENT.md](PROMPT-FOR-AGENT.md)，直接整段复制即可。

---

## 卡住了

1. 先跑 `npm run selftest`，它会把配置、排版、封面、密钥问题分开报出来
2. 再跑 `npm run check`，看是模型、凭证还是 IP 的问题
3. 对照 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
4. 如果 `check` 报 `40164`：你的出口 IP 不在白名单，跑 `npm run whitelist`
5. 如果 `check` 报 `48001`：个人主体没有发表权限，继续用草稿箱模式即可

---

## 三个重要提醒

1. **`.env` 是密钥文件**，不要提交到 git，不要发给别人，不要贴截图。
2. **个人主体不能 API 直接群发**，最后一下必须你点。这是微信的规则。
3. **头两周每篇都看一眼**再发。AI 能帮你写完，但不能替你判断值不值得发。
