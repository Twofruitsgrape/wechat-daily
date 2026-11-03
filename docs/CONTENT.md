# 内容与人设怎么调

所有内容配置都在 `config/` 下，改完下一次运行自动生效，不用重启。

---

## 1. `config/site.yaml`

```yaml
account:        # 草稿箱显示的作者/署名
  name: ""      # 公众号名，封面右下角
  author: ""    # 留空则用 .env 的 WECHAT_AUTHOR

timezone: Asia/Shanghai

article:
  min_words: 1800
  max_words: 2600
  enable_review: true   # 写完后跑一轮「去 AI 味 + 事实性」自检
  review_model: fast

style:
  persona: ...   # 写作人设
  audience: ...  # 读者是谁
  tone: ...      # 语气
  must: [...]    # 硬性要求，写进 prompt
  ban: [...]     # 禁用词，写进 prompt，自检时删

theme:           # 微信排版（只能用内联样式）
  font_size: 15
  line_height: 1.75
  letter_spacing: 0.5
  text_color: "#3f3f3f"
  heading_color: "#1a1a1a"
  accent_color: "#0e7c86"
  quote_bg: "#f7f7f7"
  quote_border: "#d8d8d8"
  code_bg: "#282c34"
  code_color: "#abb2bf"
  inline_code_bg: "#f2f3f5"
  inline_code_color: "#c7254e"
  link_mode: text      # text=正文不放外链，统一收到文末
  show_footer: true
  footer_text: "..."
  justify: true        # 中文两端对齐
  pangu: true          # 中英文/数字之间自动加空格
  highlight_color: "#0e7c86"

cover:
  width: 900
  height: 383
  theme: auto          # ink | dawn | forest | clay | slate | auto
  kicker: "每日一篇"

topics_file: config/topics.yaml
```

---

## 2. 人设（最影响输出质量的一项）

`style.persona` / `audience` / `tone` 会拼进写作 prompt。写法建议：

- **persona**：具体职业 + 经验年限 + 说话习惯，不要写「专业、严谨、有深度」这种形容词
- **audience**：写清楚「知道什么、不知道什么、为什么读你」
- **tone**：可以写「允许尖锐，但不阴阳怪气」这类边界

示例（工程号）：

```yaml
persona: >-
  一个有十年一线经验的工程师/研究者，说话直接，不吹不黑。
  习惯先问「这个数从哪来的」，再问「所以呢」。
audience: >-
  有一定专业基础、但没时间读原论文的技术从业者与研究生。
tone: >-
  冷静、具体、有观点。可以尖锐，但不阴阳怪气。
```

### `must`：硬性要求

这些不是建议，是写进 prompt 的约束：

- 每篇围绕一个具体问题，不写综述
- 段落 3–5 行，不要一句话一段
- 用 `==关键句==` 标 3–5 处最重要的判断（会渲染成彩色）
- 出现数字要交代来源类型（实测/文献/估算/假设）
- 至少给一个「如果是我会怎么做」

### `ban`：禁用词

模型用了这些词，自检那一轮会删。建议保留：

```yaml
ban:
  - 首先/其次/最后/综上所述/总而言之
  - 在这个XX的时代 / 让我们 / 众所周知
  - 赋能 / 抓手 / 闭环 / 底层逻辑 / 降维打击 / 护城河
  - 空泛的排比句和形容词堆砌
  - 编造论文、作者、期刊、DOI、具体百分比
```

最后一条最重要：**编造引用**是 AI 写作最常见的硬伤。

---

## 3. 篇幅

`article.min_words` / `max_words` 控制正文汉字数。

大纲阶段会给每一节分配字数预算，这比在 prompt 里写「写 2000 字」有效得多。
如果模型总是写不够：

1. 提高 `min_words`
2. 在 `style.must` 里加「每节至少 300 字，必须有具体例子或数字」
3. 保持 `enable_review: true`，补写阶段会补足

---

## 4. 选题

`config/topics.yaml`：

```yaml
domain: "你的大方向"

pool:
  - "具体选题一"
  - topic: "具体选题二"
    angle: "从哪个角度切"

avoid:
  - 纯新闻搬运
  - 投资建议
```

- `pool` 非空：按顺序取，用过的记进 `data/state.json`，不会重复
- `pool` 为空：模型在 `domain` 内自己挑，并避开最近 15 篇的标题
- `avoid`：明确不写的东西

选题写法：越具体越好。「MVR 低负荷为什么不划算」比「MVR 技术综述」好。
`angle` 用来控制切入角度，不写则让模型自己找。

---

## 5. 排版

微信会把 `<style>`、`class`、`id` 全部剥掉，所以 `src/render.js` 是自己写的，
所有样式内联。默认参数不是拍脑袋定的：

| 项 | 默认 | 依据 |
|---|---|---|
| 正文字号 | 15px | 主流技术号常用 15–16px，15px 一屏能多排两行 |
| 行高 | 1.75 | 手机上阅读舒适区 |
| 对齐 | justify | 中文两端对齐，右边缘齐 |
| 段长 | 3–5 行 | 一句话一段在手机上会变成碎片 |
| 重点句 | `==文字==` → 彩色加粗 | 给读者视线一个落点 |
| 中英文间距 | pangu | 中文排版基本功 |
| 外链 | 收进文末 | 个人号正文外链不可点 |

### 常用开关

```yaml
theme:
  justify: false      # 不喜欢两端对齐
  pangu: false        # 不喜欢自动加空格
  link_mode: inline   # 外链保留在正文（个人号点了没反应）
  highlight_color: "#d94f4f"
```

### 预览

```bash
npm run preview -- data/out/2025-01-01/article.md --open
```

生成一个手机宽度的 HTML，样式和微信里基本一致。

---

## 6. 封面

900×383（2.35:1），纯本地 SVG → PNG，不调生图 API。

| 主题 | 气质 |
|---|---|
| `ink` | 深蓝，冷静技术感 |
| `dawn` | 暗红橙，抓眼 |
| `forest` | 墨绿 |
| `clay` | 陶土棕 |
| `slate` | 深灰 |

`theme: auto` 按日期轮换。标题会自动折行，并做「避头点」（标点不出现在行首）。
标题里可以写 `\n` 强制换行：

```bash
node src/tools/cover.js --date=2025-01-01 --titles="第一行\n第二行|另一个标题"
```

用论文图做底图：

```bash
node src/tools/cover.js --date=2025-01-01 --base=data/out/2025-01-01/figs/fig-1.png
```

---

## 7. 写作流程与模型调用

一次完整运行大约 4–6 次模型调用：

1. **选题**（pool 为空时）
2. **大纲**：标题、封面标题、摘要、每节字数预算
3. **正文**
4. **补写**（字数不够时）
5. **自检**：去 AI 味、事实降级、删禁用词（可 `--no-review` 跳过）
6. **配图定位**（启用文献配图时才有）

想省额度：`--no-review`；想更稳：保留自检，并在头两周人工过稿。

---

## 8. 调参的顺序

按影响从大到小：

1. `style.persona` / `audience` — 决定文章像谁写的
2. `style.must` — 决定结构
3. `topics.yaml` 的 `domain` / `pool` — 决定写什么
4. `article.min_words` — 决定篇幅
5. `theme` — 决定好看程度，不影响内容

不要一次改五项。改一项，跑一篇 `--dry-run`，看差异。
