# 发给 agent 的提示词

把下面整段复制给 agent（Claude Code、Codex、pi、Cursor 等都可以），
然后把 3 个凭证单独发给它。**不要**把凭证写进这段提示词再发到公开地方。

---

```text
我解压了一个开源项目：微信公众号每日自动发文流水线（wechat-daily）。
请你帮我在本机把它配置到能跑，目标是先成功生成一篇草稿。

请严格按这个顺序：

1. 先读项目根目录的 AGENTS.md、REQUIREMENTS.md、START-HERE.md。
2. 检查 node -v（需要 >= 20），然后 npm install。
3. 跑 npm run selftest，把失败项修好。
4. 我会在下一条消息给你：
   - WECHAT_APPID
   - WECHAT_APPSECRET
   - OPENCODE_API_KEY
   - WECHAT_AUTHOR（可留空）
   请用 `node scripts/setup.mjs --set ...` 写入 .env，不要回显完整密钥，
   也不要把它们写进任何会被 git 跟踪的文件。
5. 跑 npm run whitelist，把微信看到的出口 IP 全部列给我。
   如果不止一个，也全部列出来。我会去公众号后台加白名单，加完告诉你。
6. 我确认加好后，跑 npm run check，逐项告诉我：模型、封面、出口 IP、微信凭证。
7. 跑 npm run dry -- --topic="一个具体的、2000 字能讲清的问题"。
   完成后告诉我：标题、字数、产物在哪个目录。
8. 我确认没问题后，跑 npm run daily，把草稿 media_id 告诉我，并说明去哪里点群发。

规则：
- 个人主体公众号只能进草稿箱，PUBLISH_MODE 保持 draft，不要改成 freepublish。
- 遇到 40164、48001、40001 这类错误，先解释原因，不要改代码绕过。
- 不确定的地方先问我，不要猜我的凭证或替我操作微信后台。
- 每一步做完给我一句简短结论，不要刷屏。
```

---

## 更安全的凭证传递方式

不想把密钥粘进聊天窗口，可以让 agent 只执行命令，密钥由你自己 export：

```bash
# 在你自己的终端里（不是聊天里）
export WECHAT_APPID='wx...'
export WECHAT_APPSECRET='...'
export OPENCODE_API_KEY='...'
```

然后对 agent 说：

```text
凭证已经在当前 shell 的环境变量里。请运行：
node scripts/setup.mjs --from-env
然后继续按 AGENTS.md 的流程走。
```

---

## 如果已经有 .env

把旧项目的 `.env` 复制到新目录，然后对 agent 说：

```text
.env 我已经放好了，键名和旧版本一致。
请从 npm install 开始，跑 selftest、check，然后试写一篇。
```

---

## agent 可能会问你的问题

- AppSecret 在哪拿？→ 公众平台 → 设置与开发 → 基本配置（需要管理员扫码）
- 出口 IP 怎么加？→ 同一页的 IP 白名单，注意可能有多个 IP
- 模型用哪家？→ 任意 OpenAI 兼容服务；没有就先用 DeepSeek 官方
- 能不能自动群发？→ 个人主体不行，只能进草稿箱
- 为什么文章里没有图？→ 文献配图是可选项，需要 poppler 和支持视觉的模型
