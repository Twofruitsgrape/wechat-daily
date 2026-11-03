#!/usr/bin/env node
/**
 * 手机网页入口（Tailscale 内网访问）
 *
 *   node src/web/server.js
 *
 * 为什么要有这个：企业微信智能机器人的长连接认证一直过不去（errcode 853000），
 * 而写作流水线本身是完全可用的。所以先用一个极简网页把「交互」这一环补上：
 * 手机上输入选题 → 点开始 → 实时看进度 → 完了去草稿箱点群发。
 *
 * 安全设计：
 *   - 只监听 Tailscale 网卡地址（100.x），校园网/公网访问不到
 *   - 再加一层 token（.env 里的 WEB_TOKEN），防止 tailnet 里其他设备乱点
 */

import http from "node:http";
import { execFile } from "node:child_process";

import { loadEnv, env, ROOT } from "../env.js";
import { dateInTZ } from "../util.js";
import { loadBotState } from "../bot/state.js";
import { startPipeline, pipelineRunning } from "../bot/runner.js";

loadEnv();

const TOKEN = env("WEB_TOKEN");
const PORT = Number(env("WEB_PORT", "8788"));

if (!TOKEN) {
  console.error("缺少 WEB_TOKEN，请在 .env 里配一个随机字符串");
  process.exit(1);
}


const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

/* ------------------------------ 页面 ------------------------------ */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="theme-color" content="#111c33">
<title>写作助手</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;
       background:#0f1420;color:#e8ecf5;min-height:100vh}
  .wrap{max-width:560px;margin:0 auto;padding:20px 18px 60px}
  h1{font-size:20px;margin:8px 0 4px;font-weight:700}
  .sub{font-size:13px;color:#8b95a8;margin-bottom:22px}
  textarea{width:100%;min-height:120px;padding:14px;border-radius:12px;border:1px solid #26304a;
           background:#161d2e;color:#e8ecf5;font-size:16px;line-height:1.6;resize:vertical;
           font-family:inherit}
  textarea:focus{outline:none;border-color:#4f7cff}
  .files{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
  .chip{padding:8px 14px;border-radius:20px;border:1px solid #26304a;background:#161d2e;
        color:#a9b4c8;font-size:13px;cursor:pointer}
  .chip:active{background:#1e2942}
  button{width:100%;margin-top:16px;padding:16px;border:none;border-radius:12px;
         background:linear-gradient(135deg,#4f7cff,#3a5fd9);color:#fff;font-size:17px;
         font-weight:600;cursor:pointer}
  button:disabled{opacity:.45;cursor:default}
  .card{margin-top:22px;padding:16px;border-radius:12px;background:#161d2e;border:1px solid #26304a}
  .card h2{font-size:13px;margin:0 0 10px;color:#8b95a8;font-weight:600;letter-spacing:.5px}
  .big{font-size:16px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .idle{background:#5a6478}.work{background:#f0a020;animation:p 1.2s infinite}.done{background:#2fbf71}.err{background:#e05a5a}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
  .muted{color:#7b859a;font-size:13px;line-height:1.7}
  code{background:#0b101a;padding:2px 6px;border-radius:4px;font-size:13px;color:#9fb4ff}
</style></head>
<body><div class="wrap">
  <h1>写作助手</h1>
  <div class="sub">输入选题和要求，我会写完、排版、配封面，放进公众号草稿箱</div>

  <textarea id="t" placeholder="例：余热回收里最常见的估算错误，要举一个手算例子&#10;&#10;也可以用竖线分开：主题 | 额外要求"></textarea>
  <div class="files">
    <div class="chip" data-f="换成能源方向">能源方向</div>
    <div class="chip" data-f="要具体到手算案例，结尾给检查清单">加要求：手算</div>
    <div class="chip" data-f="少一点理论，多讲一个真实场景的取舍">加要求：多场景</div>
  </div>
  <button id="go">开始写作</button>

  <div class="card">
    <h2>当前状态</h2>
    <div class="big" id="st"><span class="dot idle"></span>加载中…</div>
  </div>

  <div class="card" id="res" style="display:none">
    <h2>上一次结果</h2>
    <div class="big" id="rst"></div>
  </div>

  <div class="card">
    <h2>怎么发布</h2>
    <div class="muted">草稿进箱后，打开「订阅号助手」App 或 mp.weixin.qq.com 的草稿箱，确认排版后点「群发」。</div>
  </div>
</div>
<script>
  const T = new URLSearchParams(location.search).get('t') || '';
  const H = {'Content-Type':'application/json','X-Token':T};

  document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{
    const ta=document.getElementById('t');
    ta.value = (ta.value.trim()? ta.value.trim()+'\\n' : '') + c.dataset.f;
    ta.focus();
  });

  const $go=document.getElementById('go'), $st=document.getElementById('st');
  let busy=false;

  async function refresh(){
    if(!busy){ try{ await poll(); }catch(e){} }
    setTimeout(refresh, 4000);
  }

  async function poll(){
    const r = await fetch('/api/status',{headers:H});
    const j = await r.json();
    if(j.phase==='generating'){
      busy=true; $go.disabled=true;
      $st.innerHTML='<span class="dot work"></span>正在写：'+esc(j.topic||'')+'\\n已进行 '+(j.elapsedMin??'?')+' 分钟…';
    } else {
      busy=false; $go.disabled=false;
      $st.innerHTML = j.lastSummary
        ? '<span class="dot '+(j.lastExit===0?'done':'err')+'"></span>空闲（上次已完成）'
        : '<span class="dot idle"></span>空闲，可以开始';
      const res=document.getElementById('res'), rst=document.getElementById('rst');
      if(j.lastSummary){ res.style.display='block'; rst.textContent=j.lastSummary; }
    }
  }

  $go.onclick=async()=>{
    const topic=document.getElementById('t').value.trim();
    if(!topic){ alert('先写点什么'); return; }
    $go.disabled=true;
    $st.innerHTML='<span class="dot work"></span>提交中…';
    const r=await fetch('/api/start',{method:'POST',headers:H,body:JSON.stringify({text:topic})});
    const j=await r.json();
    if(!j.ok){ alert(j.error||'启动失败'); $go.disabled=false; return; }
    document.getElementById('t').value='';
    poll();
  };

  function esc(s){return String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
  refresh();
</script>
</body></html>`;

/* ------------------------------ 服务 ------------------------------ */
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = req.headers["x-token"] || url.searchParams.get("t");

  if (url.pathname === "/") {
    if (token !== TOKEN) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<h1>401</h1><p>缺少访问令牌，请用带 ?t=令牌 的完整地址打开。</p>");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }

  if (token !== TOKEN) return json(res, 401, { ok: false, error: "unauthorized" });

  if (url.pathname === "/api/status") {
    const s = loadBotState();
    return json(res, 200, {
      phase: s.phase,
      topic: s.topic,
      date: s.date ?? dateInTZ("Asia/Shanghai"),
      elapsedMin: s.startedAt ? Math.round((Date.now() - Date.parse(s.startedAt)) / 60000) : null,
      lastSummary: s.lastSummary ?? null,
      lastExit: s.lastExitCode ?? null,
    });
  }

  if (url.pathname === "/api/start" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { text } = JSON.parse(body || "{}");
        const t = String(text ?? "").trim();
        if (!t) return json(res, 400, { ok: false, error: "内容为空" });
        if (pipelineRunning()) return json(res, 409, { ok: false, error: "已经有一篇在写了" });

        const m = t.match(/^([^|｜\n]{2,120})\s*[|｜]\s*([\s\S]+)$/);
        const topic = (m ? m[1] : t).trim().slice(0, 120);
        const brief = m ? m[2].trim() : t;

        startPipeline({ topic, brief, force: true });
        log(`网页触发写作：${topic}`);
        json(res, 200, { ok: true, topic });
      } catch (err) {
        json(res, 500, { ok: false, error: err.message });
      }
    });
    return;
  }

  json(res, 404, { ok: false });
});


const HOST = env("WEB_HOST", "0.0.0.0");
server.listen(PORT, HOST, () => {
  log(`网页入口已启动 http://${HOST}:${PORT}`);
  if (HOST === "0.0.0.0") log("⚠️ 监听 0.0.0.0，同网段设备也能访问（靠 token 保护）");
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
