# 常见问题与错误码

---

## 1. 先按这个顺序排查

```bash
node -v                  # 必须 >= 20
npm run selftest         # 离线：配置 / 排版 / 封面 / 密钥
npm run whitelist        # 出口 IP 和白名单
npm run check            # 联网：模型 / 微信凭证
npm run probe            # 只读探测接口权限
```

把 `check` 的完整输出留着，大部分问题能定位到具体一节。

---

## 2. 微信错误码

| errcode | 含义 | 处理 |
|---|---|---|
| `40001` | AppSecret 错 / token 失效 | 重新生成 AppSecret，更新 `.env`；确认没有多余空格 |
| `40013` | AppID 非法 | 检查 `WECHAT_APPID`，应为 `wx` + 16 位 |
| `40125` | AppSecret 无效 | 同上；确认用的是当前账号的密钥 |
| `40164` | 调用方 IP 不在白名单 | `npm run whitelist`，把全部 IP 加进白名单 |
| `40007` | media_id 无效 | 封面素材被删了；重跑 `npm run daily -- --force` |
| `40009` | 图片超过 2MB | 封面只有几十 KB，正常不会触发 |
| `42001` | token 过期 | 代码会自动刷新重试一次；持续出现检查系统时间 |
| `45002` | 内容超长 / 群发超限 | 调低 `article.max_words`；正文上限约 2 万字符 |
| `45009` | 接口调用超日限 | 等第二天；检查是否有循环重试 |
| `48001` | 接口未授权 | 个人主体没有发表权限；保持 `PUBLISH_MODE=draft`，用草稿箱 |
| `53404` | 账号未认证 | 该接口只对认证账号开放；换草稿箱链路 |

### 40164 的完整处理

1. 先确认 `.env` 里 AppID/AppSecret 是对的
2. 跑 `npm run whitelist`，它会打印微信看到的 IP
3. 全部加进：公众平台 → 设置与开发 → 基本配置 → IP 白名单
4. 等 1–2 分钟，再跑 `npm run check`
5. 如果 IP 有 5 个以上且一直变：用固定 IP 中转，设 `WECHAT_BASE_URL`

> `check` 里的「出口 IP」是用公共接口查的，可能和白名单里需要的 IP 不完全一致。
> 以 `whitelist` 从 40164 里读出来的为准。

### 48001 到底还能不能自动发

不能。个人主体账号 2025 年 7 月起被回收「发布」接口权限。
能做的只有：API 建草稿 → 你在手机上点群发。
不要尝试浏览器自动化绕过，有风控风险，也违反平台规则。

---

## 3. 模型相关

| 现象 | 原因 | 处理 |
|---|---|---|
| `401` / `invalid api key` | key 错或过期 | 更新 `.env`；确认 base URL 和 key 属于同一家 |
| `404` | base URL 少了 `/v1` 或多写了路径 | 常见正确形式：`https://api.deepseek.com/v1` |
| 返回空 content | 推理模型把 token 花在 reasoning 上 | 换模型或调大 `max_tokens` |
| `429` | 限流 | 代码会退避重试；仍失败就等一会 |
| `fetch failed` | 网络/代理/DNS | 换网络；检查能否 `curl` 到 base URL |
| 返回非 JSON | 中转服务返回了 HTML 错误页 | 看 HTTP 状态和前 300 字符 |
| 看图返回「我无法读取图片」 | 模型不支持视觉 | 换多模态模型，或关闭文献配图 |

`npm run check` 会真实调用一次模型（只回两个字），能快速验证 key、base URL、模型名。

---

## 4. 安装与运行

| 现象 | 处理 |
|---|---|
| `npm install` 卡住 | 换 npm 镜像：`npm config set registry https://registry.npmmirror.com` |
| `sharp` 安装失败 | 确认 Node 是 64 位、版本 ≥ 20；删掉 `node_modules` 重装；公司网络可能需要代理 |
| `Cannot find package '@wecom/aibot-node-sdk'` | `npm i @wecom/aibot-node-sdk`（只有用机器人时需要） |
| `EACCES` / `EPERM` | 不要把项目放在系统目录；检查文件权限 |
| `find: command not found`（Windows） | 用 PowerShell 的 `Get-ChildItem`，或直接用 `dir` |
| `bash: not found`（Windows） | `bin/*.sh` 只适用于 Linux/macOS，Windows 用任务计划程序 |
| `ENOENT pdftotext` | 装 poppler（见 [PAPER](PAPER.md)），或不用文献配图 |

---

## 5. 封面

| 现象 | 原因 | 处理 |
|---|---|---|
| 中文变方块 | 系统没有中文字体 | Linux: `sudo apt install fonts-noto-cjk`；容器里也要装 |
| 标题被截断 | 太长，超过 3 行 | 用 `--titles="短标题"`，或在标题里写 `\n` |
| 封面文件很小 | 渲染失败但没报错 | 看 `selftest` 第 3 节；检查 sharp 和中文字体 |
| 日期压住图 | 用了论文底图 | 已做避让；如仍有问题，用 `--base` 换一张图 |

---

## 6. 文章没生成 / 没进草稿箱

### `npm run daily` 说「今天已经处理过了」

这是防重复。状态在 `data/state.json`：

- `drafted` / `published` → 跳过
- `generated`（dry-run）→ 不会跳过

强制重跑：

```bash
npm run daily -- --force
```

### 文章生成了，但草稿失败

产物还在 `data/out/<日期>/`。修好凭证或白名单后：

```bash
npm run push
```

不要用 `--force` 重写，那会重新消耗模型额度。

### 想重置状态

```bash
rm data/state.json    # 只删这一个文件，不要删整个 data/
```

删掉后已用选题记录也会丢，可能会写出重复选题。

### 产物目录是空的

看 `data/logs/run-<日期>.log`。常见原因：模型失败、网络失败、`--until=render`
只生成到一半、磁盘满。

---

## 7. 机器人 / 网页

| 现象 | 处理 |
|---|---|
| 机器人没反应 | `systemctl status` + `data/logs/bot-*.log`；确认 `WECOM_BOT_ID/SECRET` 正确 |
| `errcode=60020` | 调用 API 的出口 IP 不在「企业可信 IP」里，加进去 |
| `errcode=81013` | 收件人 UserID 不存在，检查 `WECOM_ALLOWED_USERS` |
| 回调 URL 验证失败 | 自建应用方案要求备案域名；改用智能机器人长连接 |
| 网页 401 | `WEB_TOKEN` 不对或没带 `?token=` |
| 网页打不开 | 确认 `WEB_HOST` 和端口；`0.0.0.0` 才能被同网段访问 |

---

## 8. 怎么收集信息

```bash
# 单次运行日志
ls -lt data/logs/ | head

# 今天有没有产物
ls -la data/out/$(TZ=Asia/Shanghai date +%F)/

# 状态
cat data/state.json | head -50

# 自检
npm run check 2>&1 | tee /tmp/check.log
```

提问时附上：`node -v`、系统、`check` 输出、报错前后的日志。
**不要附 `.env` 原文或完整密钥。**
