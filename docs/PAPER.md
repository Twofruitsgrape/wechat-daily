# 文献配图与 PDF 解读

这两个功能是可选的，不影响纯文字写作。

---

## 1. 依赖

需要 poppler 里的两个命令：

```bash
pdftotext -v
pdfimages -v
```

安装：

| 平台 | 命令 |
|---|---|
| Ubuntu / Debian | `sudo apt install poppler-utils` |
| macOS | `brew install poppler` |
| Windows | `choco install poppler`，或从 poppler-windows 下载后加 PATH |

还需要模型支持图片输入（多模态）。如果模型只能读文字，「看图写图注」会失败。
确认方式：`npm run check` 第 2 节会打印 `视觉` 模型名，但不代表它真的能看图；
最稳的是跑一次 `--paper=auto` 看日志。

---

## 2. 自动搜文献配图

```bash
# 根据选题自动找
node src/main.js --topic="MVR 的吨水电耗受什么控制" --paper=auto

# 指定英文检索方向
node src/main.js --topic="..." --paper="falling film evaporator heat transfer"
```

流程：

```
中文选题
  ↓ 模型翻成英文检索词
arXiv（短语检索）→ 没命中就转 OpenAlex 开放获取库
  ↓ 下 PDF
pdfimages 抽位图
  ↓ 尺寸 / 比例 / 白底过滤
视觉模型逐张判断「是不是真图表」并写中文图注
  ↓
模型决定每张图插在哪个小节之后
  ↓
media/uploadimg 上传微信 CDN → 进正文
```

产物：

```
data/out/<日期>/
├── figs/          抽出来的候选图
├── paper.pdf      下载的论文（如果成功）
└── meta.json      论文标题、作者、arXiv ID、许可协议
```

文末会自动附图片来源：

```
图片来源：作者，标题，arXiv:xxxx.xxxxx，许可协议
```

### 已知限制

- **只抽位图**。matplotlib / TikZ 生成的矢量图抽不出来，那篇论文会退化成无图。
- 抽出来的大部分是图标、公式碎片，必须让视觉模型筛一遍；没有视觉模型就别开。
- arXiv 要 `https`，而且检索必须用短语（`all:"a b c"`），否则会命中不相干的论文。
- 版权：arXiv 上很多是 CC BY；Elsevier/Springer 的图版权归出版商，公开发布前确认许可。

---

## 3. 指定 PDF 写解读稿

```bash
node src/main.js --from-paper=/path/to/paper.pdf
node src/main.js --from-paper=/path/to/paper.pdf --topic="自定义选题"
```

和 `--paper=auto` 的区别：

| | `--paper=auto` | `--from-paper` |
|---|---|---|
| 文献来源 | arXiv / OpenAlex 检索 | **你指定的那篇** |
| 写作依据 | 只有选题 | **论文原文全文** |
| 配图来源 | 搜到的那篇 | 同一篇 |
| 事实纪律 | 不许编造 | 不许编造，且不得引入其他文献的数据 |

流程：

```
%PDF- 文件头识别
  ↓ pdftotext 抽全文（去掉参考文献，截 24k 字符）
  ↓ 模型从论文里提炼选题角度
写作（论文原文作为唯一可信来源，注入 prompt）
  ↓ pdfimages 抽图 → 视觉模型写图注 → 定位插图
进草稿箱
```

限制：

- 只支持 PDF，Word 不行
- 扫描版 PDF 没有文字层，`pdftotext` 会得到空文本（需要先 OCR）
- 矢量图同样抽不出来

---

## 4. 图片上传与失败处理

正文图片走 `media/uploadimg` 上传到微信 CDN，替换成本地图片路径。
如果某张图上传失败：

- 自动删掉这张图和它的图注，避免正文出现「图 1：xxx」却没有图
- 日志里记一条 WARN，不会让整篇文章失败

相关代码：`src/images.js`、`src/paper.js`。

---

## 5. 用论文图做封面

```bash
node src/tools/cover.js --date=<日期> --base=data/out/<日期>/figs/fig-1.png
```

封面左半边是纯色文字区，右半边放原图，接缝处有渐变过渡，原图不会被整张压暗。
