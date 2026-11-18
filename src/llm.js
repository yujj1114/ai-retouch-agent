/* ============================================================
 * llm.js — 模型客户端
 * 产品语义：填入 API Key 即用真实模型；未配置时自动使用内置引擎
 *（规则规划 + 程序生成，零费用）。不存在"模式选择"。
 * 派生状态：proxy（勾选代理转发）> direct（填了 Key）> builtin（未配置）
 * ============================================================ */
window.RA = window.RA || {};
RA.LLM = (function () {
  const LS_KEY = 'ra-llm-config-v1';
  const DEFAULTS = {
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    plannerModel: 'qwen-plus',
    imageModel: 'qwen-image',
    imageSize: '1024x1024',
    useProxy: false,
    proxyUrl: 'http://127.0.0.1:8619',
  };
  let cfg = Object.assign({}, DEFAULTS);
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) {
      const old = JSON.parse(s);
      cfg = Object.assign({}, DEFAULTS, old);
      // 兼容旧版三模式配置
      if (old.mode === 'proxy') cfg.useProxy = true;
      if (old.mode === 'mock') cfg.useProxy = false;
    }
  } catch (e) { /* localStorage 不可用则用默认值 */ }

  const listeners = [];
  function emit() { listeners.forEach((cb) => cb(get())); }
  function get() { return Object.assign({}, cfg); }
  function set(patch) {
    cfg = Object.assign({}, cfg, patch);
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {}
    emit();
  }
  function onChange(cb) { listeners.push(cb); }

  /** 派生状态：proxy > direct > builtin */
  function state() {
    if (cfg.useProxy) return 'proxy';
    if (cfg.apiKey) return 'direct';
    return 'builtin';
  }
  function isReal() { return state() !== 'builtin'; }
  function modeLabel() { return { proxy: '代理', direct: '直连', builtin: '内置' }[state()]; }

  function endpoint(kind) {
    if (state() === 'proxy') return cfg.proxyUrl.replace(/\/+$/, '') + '/api/' + kind;
    return cfg.baseUrl.replace(/\/+$/, '') + '/' + kind;
  }
  function authHeaders() {
    if (state() === 'direct') return { Authorization: 'Bearer ' + cfg.apiKey };
    return {}; // 代理模式的 Key 在服务端
  }
  async function parseErr(res) {
    let msg = res.status + ' ' + res.statusText;
    try {
      const j = await res.json();
      const m = j && j.error && j.error.message;
      if (m) msg += '：' + String(m).slice(0, 200);
    } catch (e) { /* 非 JSON 响应 */ }
    if (/failed|network/i.test(msg)) msg += '（浏览器直连可能被 CORS 拦截，可在模型配置中勾选「通过本地代理转发」）';
    return new Error('模型服务 ' + msg);
  }

  /** 对话补全，返回文本内容 */
  async function chat(messages, opt = {}) {
    if (!isReal()) throw new Error('尚未配置模型 Key');
    const res = await fetch(endpoint('chat/completions'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({
        model: opt.model || cfg.plannerModel,
        messages,
        temperature: opt.temperature != null ? opt.temperature : 0.1,
        response_format: opt.json ? { type: 'json_object' } : undefined,
      }),
    });
    if (!res.ok) throw await parseErr(res);
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('模型服务返回为空');
    return content;
  }

  /** 文生图，返回 dataURL 数组 */
  async function image(prompt, n) {
    if (!isReal()) throw new Error('尚未配置模型 Key');
    const res = await fetch(endpoint('images/generations'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ model: cfg.imageModel, prompt: prompt, n: n || 4, size: cfg.imageSize }),
    });
    if (!res.ok) throw await parseErr(res);
    const data = await res.json();
    const out = [];
    for (const it of data.data || []) {
      if (it.b64_json) out.push('data:image/png;base64,' + it.b64_json);
      else if (it.url) {
        try {
          const r = await fetch(it.url);
          const blob = await r.blob();
          out.push(await new Promise((res2, rej) => {
            const fr = new FileReader();
            fr.onload = () => res2(fr.result);
            fr.onerror = () => rej(new Error('图片读取失败'));
            fr.readAsDataURL(blob);
          }));
        } catch (e) {
          out.push(it.url); // 跨域读取失败时退回原 URL（导出可能受画布污染限制）
        }
      }
    }
    if (!out.length) throw new Error('模型服务未返回图片');
    return out;
  }

  /** 测试连接 */
  async function ping() {
    const st = state();
    if (st === 'builtin') {
      return { info: true, msg: '未配置模型 Key，当前使用内置引擎（规则规划 + 程序生成）' };
    }
    if (st === 'proxy') {
      const res = await fetch(cfg.proxyUrl.replace(/\/+$/, '') + '/api/health');
      if (!res.ok) throw new Error('代理未响应（' + res.status + '），请确认已运行 node server/proxy.js');
      const j = await res.json();
      if (!j.keyConfigured) throw new Error('代理已连接，但 .env 中未配置 DASHSCOPE_API_KEY');
      return { msg: '代理连接正常，Key 已配置' };
    }
    await chat([{ role: 'user', content: '只回复两个字：正常' }], { temperature: 0 });
    return { msg: '连接成功，Key 可用' };
  }

  return { get, set, isReal, state, modeLabel, chat, image, ping, onChange, DEFAULTS };
})();
