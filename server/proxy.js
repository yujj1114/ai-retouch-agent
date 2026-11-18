#!/usr/bin/env node
/* ============================================================
 * server/proxy.js — 本地模型代理（零依赖，Node 18+）
 * 把浏览器请求转发到 DashScope（OpenAI 兼容模式）。
 * API Key 只存在于服务端 .env，不进入浏览器。
 *
 * 用法：
 *   1) 复制项目根目录 .env.example 为 .env，填入 DASHSCOPE_API_KEY
 *   2) node server/proxy.js            （默认端口 8619，可用 --port 或 .env 的 PROXY_PORT 覆盖）
 *
 * 端点：
 *   GET  /api/health              → { ok, keyConfigured, base }
 *   POST /api/chat/completions    → 转发对话（规划模型）
 *   POST /api/images/generations  → 转发文生图；URL 结果服务端回读为 base64
 * ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');

/* ---- 读取 .env（无依赖实现；process.env 优先级更高） ---- */
function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = Object.assign(loadEnvFile(path.join(__dirname, '..', '.env')), process.env);

const PORT = Number(env.PROXY_PORT || 8619);
const API_KEY = env.DASHSCOPE_API_KEY || '';
const BASE = (env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com').replace(/\/+$/, '') + '/compatible-mode/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function send(res, code, obj) {
  res.writeHead(code, Object.assign({}, CORS, { 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
async function forward(target, body) {
  const r = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}
/** 服务端回读图片 URL → data URL（规避浏览器跨域与 canvas 污染） */
async function urlToDataUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('图片回读失败 ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = r.headers.get('content-type') || 'image/png';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, { error: { message: 'bad url' } }); }

  if (req.method === 'GET' && u.pathname === '/api/health') {
    return send(res, 200, { ok: true, provider: 'dashscope', keyConfigured: !!API_KEY, base: BASE });
  }

  if (req.method === 'POST' && u.pathname === '/api/chat/completions') {
    if (!API_KEY) return send(res, 500, { error: { message: '代理未配置 DASHSCOPE_API_KEY：请在项目根目录 .env 中填写（可复制 .env.example）' } });
    try {
      const body = await readBody(req);
      const r = await forward(BASE + '/chat/completions', body);
      res.writeHead(r.status, Object.assign({}, CORS, { 'Content-Type': 'application/json; charset=utf-8' }));
      return res.end(r.text);
    } catch (e) {
      return send(res, 502, { error: { message: '代理转发失败: ' + e.message } });
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/images/generations') {
    if (!API_KEY) return send(res, 500, { error: { message: '代理未配置 DASHSCOPE_API_KEY' } });
    try {
      const body = await readBody(req);
      const r = await forward(BASE + '/images/generations', body);
      if (r.status !== 200) {
        res.writeHead(r.status, Object.assign({}, CORS, { 'Content-Type': 'application/json; charset=utf-8' }));
        return res.end(r.text);
      }
      const data = JSON.parse(r.text);
      const items = [];
      for (const it of data.data || []) {
        if (it.b64_json) {
          items.push({ b64_json: it.b64_json, revised_prompt: it.revised_prompt });
        } else if (it.url) {
          try {
            const dataUrl = await urlToDataUrl(it.url);
            items.push({ b64_json: dataUrl.split(',')[1], url: it.url, revised_prompt: it.revised_prompt });
          } catch (e) {
            items.push({ url: it.url, revised_prompt: it.revised_prompt, warn: e.message });
          }
        }
      }
      return send(res, 200, Object.assign({}, data, { data: items }));
    } catch (e) {
      return send(res, 502, { error: { message: '代理转发失败: ' + e.message } });
    }
  }

  send(res, 404, { error: { message: 'unknown endpoint: ' + u.pathname } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`retouch-agent proxy  ->  http://127.0.0.1:${PORT}`);
  console.log(`upstream             ->  ${BASE}`);
  console.log(`DASHSCOPE_API_KEY    ->  ${API_KEY ? '已配置' : '未配置（.env 中缺失，真实调用会失败）'}`);
});
