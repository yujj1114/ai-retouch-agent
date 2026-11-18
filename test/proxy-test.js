/* ============================================================
 * test/proxy-test.js — 代理链路测试
 * 用一个本地 stub 上游模拟 DashScope（OpenAI 兼容模式），验证：
 *   1. /api/health 报告 Key 配置状态
 *   2. /api/chat/completions 透传 + 鉴权头注入
 *   3. /api/images/generations 的 URL 结果被服务端回读为 base64
 *   4. 未知端点 404
 * 运行：node test/proxy-test.js
 * ============================================================ */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const STUB_PORT = 9911;
const PROXY_PORT = 8620;
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra || ''); }
}

async function main() {
  /* ---- stub 上游 ---- */
  const seen = { auth: null, chatBody: null, imgBody: null };
  const stub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/compatible-mode/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.auth = req.headers['authorization'];
        seen.chatBody = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '{"steps":[{"tool":"adjust_brightness","params":{"value":30},"note":"提亮"}]}' } }],
        }));
      });
    } else if (req.method === 'POST' && u.pathname === '/compatible-mode/v1/images/generations') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.imgBody = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ url: `http://127.0.0.1:${STUB_PORT}/mock-img.png`, revised_prompt: '一幅山' }],
        }));
      });
    } else if (req.method === 'GET' && u.pathname === '/mock-img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(TINY_PNG);
    } else {
      res.writeHead(404); res.end('{}');
    }
  });
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

  /* ---- 启动代理（环境变量覆盖 .env） ---- */
  const proxy = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'proxy.js')], {
    env: {
      ...process.env,
      DASHSCOPE_API_KEY: 'test-key-123',
      DASHSCOPE_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
      PROXY_PORT: String(PROXY_PORT),
    },
    stdio: 'pipe',
  });
  proxy.stderr.on('data', (d) => console.error('[proxy stderr]', String(d)));
  await new Promise((r) => setTimeout(r, 800));

  const base = `http://127.0.0.1:${PROXY_PORT}`;
  try {
    console.log('— 代理链路 —');

    const h = await fetch(base + '/api/health').then((r) => r.json());
    check('health: ok', h.ok === true, JSON.stringify(h));
    check('health: key 已配置', h.keyConfigured === true);
    check('health: 上游指向 stub', h.base === `http://127.0.0.1:${STUB_PORT}/compatible-mode/v1`, h.base);

    const chat = await fetch(base + '/api/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-plus', messages: [{ role: 'user', content: '亮一点' }] }),
    });
    const chatJson = await chat.json();
    check('chat: 状态 200', chat.status === 200);
    check('chat: 响应透传', /adjust_brightness/.test(chatJson.choices[0].message.content));
    check('chat: 注入 Bearer 鉴权', seen.auth === 'Bearer test-key-123', seen.auth);
    check('chat: 请求体透传', seen.chatBody.model === 'qwen-plus' && seen.chatBody.messages[0].content === '亮一点');

    const img = await fetch(base + '/api/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-image', prompt: '山', n: 1, size: '1024x1024' }),
    });
    const imgJson = await img.json();
    const b64 = imgJson.data[0] && imgJson.data[0].b64_json;
    const isPng = b64 && Buffer.from(b64, 'base64').slice(0, 4).toString('hex') === '89504e47';
    check('image: 状态 200', img.status === 200);
    check('image: URL 已回读为 base64（PNG 魔数校验）', !!isPng, JSON.stringify(imgJson.data[0]).slice(0, 120));
    check('image: 请求体透传', seen.imgBody.prompt === '山' && seen.imgBody.n === 1);

    const nf = await fetch(base + '/api/unknown');
    check('未知端点 404', nf.status === 404);

    const noKey = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'proxy.js')], {
      env: { ...process.env, DASHSCOPE_API_KEY: '', DASHSCOPE_BASE_URL: `http://127.0.0.1:${STUB_PORT}`, PROXY_PORT: String(PROXY_PORT + 1) },
      stdio: 'pipe',
    });
    await new Promise((r) => setTimeout(r, 800));
    const nk = await fetch(`http://127.0.0.1:${PROXY_PORT + 1}/api/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] }),
    });
    check('无 Key 时拒绝并提示', nk.status === 500 && /DASHSCOPE_API_KEY/.test(await nk.text()));
    noKey.kill();
  } finally {
    proxy.kill();
    stub.close();
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
