/* ============================================================
 * app.js — 界面装配 + Agent 对话 + 计划卡片 + 事件流
 * ============================================================ */
(function () {
  const Reg = () => RA.ToolRegistry;
  const Agent = RA.Agent;
  const Editor = RA.Editor;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let currentBrush = null;   // 当前激活的画笔工具 id
  let popTool = null;        // 参数浮层正在编辑的工具
  let running = false;       // 计划执行中

  /* ---------------- 通用工具 ---------------- */
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  let toastTimer = null;
  function toast(msg, type = '') {
    let t = $('#toast');
    if (!t) {
      t = el('<div id="toast"></div>');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'show ' + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), 2200);
  }
  function now() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  }
  function scrollChat() {
    const c = $('#chat');
    c.scrollTop = c.scrollHeight;
  }

  /* ---------------- 对话 ---------------- */
  function addMsg(role, html) {
    const m = el(`<div class="msg ${role}"><div class="bubble">${html}</div></div>`);
    $('#chat').appendChild(m);
    scrollChat();
    return m;
  }
  function addSystemLine(html) {
    const m = el(`<div class="msg system"><div class="bubble">${html}</div></div>`);
    $('#chat').appendChild(m);
    scrollChat();
    return m;
  }
  function typing(on) {
    if (on) {
      const m = el('<div class="msg agent" id="typing"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>');
      $('#chat').appendChild(m);
      scrollChat();
    } else {
      const t = $('#typing');
      if (t) t.remove();
    }
  }

  /* ---------------- 工具面板 ---------------- */
  const LAYER_ICONS = { base: '🖼', bg: '🌄', paint: '🖌' };
  function renderTools() {
    const wrapEl = $('#tool-groups');
    wrapEl.innerHTML = '';
    let count = 0;
    for (const [cat, list] of Reg().byCategory()) {
      count += list.length;
      const g = el(`<div class="tool-group"><div class="tool-group-title">${esc(cat)}</div><div class="tool-grid"></div></div>`);
      const grid = g.querySelector('.tool-grid');
      for (const spec of list) {
        const b = el(`<button class="tool-btn ${spec.brush ? 'brush' : ''}" data-tool="${spec.id}" title="${esc(spec.desc || '')}">
          <span class="t-ico">${spec.icon || '🔧'}</span><span class="t-name">${esc(spec.name)}</span></button>`);
        b.addEventListener('click', (e) => onToolClick(spec, b, e));
        grid.appendChild(b);
      }
      wrapEl.appendChild(g);
    }
    $('#tool-count').textContent = count;
  }

  function onToolClick(spec, btn) {
    if (!Editor.hasImage()) { toast('请先打开一张图片', 'err'); return; }
    if (spec.brush) {
      // 画笔工具：先弹参数（大小/强度），再启用；已激活则实时更新
      openPop(spec, btn, true);
      return;
    }
    if (spec.params.length) openPop(spec, btn);
    else applyFromUI(spec.id, {});
  }

  function applyFromUI(id, params) {
    try {
      Editor.applyTool(id, params);
      const spec = Reg().get(id);
      const pstr = Object.entries(params).map(([k, v]) => `${k}:${typeof v === 'number' ? v : '"' + v + '"'}`).join(', ');
      addSystemLine(`UI 调用 <code>${esc(id)}</code>{${esc(pstr)}} <span style="color:var(--ok)">✓</span>`);
      toast(`${spec.name} 已应用`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /* ---------------- 工具参数浮层 ---------------- */
  function openPop(spec, anchor, brushMode) {
    closePop();
    popTool = { spec, values: Reg().defaults(spec.id) };
    const pop = $('#tool-pop');
    let fields = '';
    for (const p of spec.params) {
      const v = popTool.values[p.key];
      if (p.type === 'range') {
        fields += `<div class="tp-field"><label>${esc(p.label)}<output id="tp-out-${p.key}">${v}</output></label>
          <input type="range" id="tp-${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}"></div>`;
      } else if (p.type === 'select') {
        fields += `<div class="tp-field"><label>${esc(p.label)}</label><select id="tp-${p.key}">${p.options.map((o) => `<option value="${o[0]}" ${o[0] === v ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select></div>`;
      } else if (p.type === 'color') {
        fields += `<div class="tp-field"><label>${esc(p.label)}</label><input type="color" id="tp-${p.key}" value="${v}"></div>`;
      }
    }
    const applyLabel = brushMode ? (currentBrush === spec.id ? '更新参数' : '启用画笔') : '应用';
    pop.innerHTML = `<div class="tp-title">${esc(spec.name)}${brushMode ? ' · 画笔参数' : ''}<span>${esc(spec.id)}</span></div>${fields}
      <div class="tp-actions"><button class="tbtn primary" id="tp-apply">${applyLabel}</button><button class="tbtn" id="tp-cancel">取消</button></div>
      ${brushMode ? '<div class="tp-hint">启用后还可用画布下方滑块或 [ ] 键随时调整大小</div>' : ''}`;
    pop.hidden = false;
    // 定位
    const r = anchor.getBoundingClientRect();
    const pw = 230, ph = pop.offsetHeight;
    let x = r.right + 8, y = r.top;
    if (x + pw > window.innerWidth - 8) x = r.left - pw - 8;
    if (y + ph > window.innerHeight - 8) y = window.innerHeight - ph - 8;
    pop.style.left = Math.max(8, x) + 'px';
    pop.style.top = Math.max(8, y) + 'px';
    // 事件
    pop.querySelectorAll('input[type=range]').forEach((inp) => {
      inp.addEventListener('input', () => {
        popTool.values[inp.id.slice(3)] = Number(inp.value);
        const out = pop.querySelector('#tp-out-' + inp.id.slice(3));
        if (out) out.textContent = inp.value;
      });
    });
    pop.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => (popTool.values[s.id.slice(3)] = s.value)));
    pop.querySelectorAll('input[type=color]').forEach((c) => c.addEventListener('input', () => (popTool.values[c.id.slice(3)] = c.value)));
    pop.querySelector('#tp-apply').addEventListener('click', () => {
      const values = { ...popTool.values };
      if (brushMode) {
        if (currentBrush === spec.id) {
          Editor.setBrushParams(values);
          toast(`${spec.name} 参数已更新`, 'ok');
        } else {
          $$('.tool-btn').forEach((x) => x.classList.remove('active'));
          document.querySelector(`[data-tool="${spec.id}"]`).classList.add('active');
          Editor.activateBrush(spec.id, values);
          currentBrush = spec.id;
          toast(`${spec.name} 已启用（${values.size}px），在画布上涂抹`, 'ok');
        }
        closePop();
        return;
      }
      applyFromUI(spec.id, values);
      closePop();
    });
    pop.querySelector('#tp-cancel').addEventListener('click', closePop);
  }
  function closePop() {
    const pop = $('#tool-pop');
    if (pop) pop.hidden = true;
    popTool = null;
  }
  document.addEventListener('pointerdown', (e) => {
    const pop = $('#tool-pop');
    if (pop && !pop.hidden && !pop.contains(e.target) && !e.target.closest('.tool-btn')) closePop();
  }, true);

  /* ---------------- 图层面板 ---------------- */
  function renderLayers() {
    const wrapEl = $('#layer-list');
    const layers = Editor.layers();
    if (!layers.length) {
      wrapEl.innerHTML = '<div class="layer-empty">还没有图层，先打开一张图片</div>';
      return;
    }
    wrapEl.innerHTML = '';
    for (const l of [...layers].reverse()) {
      const item = el(`<div class="layer-item">
        <span class="l-ico">${LAYER_ICONS[l.type] || '▦'}</span>
        <span class="l-name">${esc(l.name)}</span>
        <span class="l-type">${l.type}</span>
        <button class="l-eye ${l.visible ? '' : 'off'}" title="显示/隐藏">${l.visible ? '👁' : '🚫'}</button>
        ${l.type !== 'base' ? '<button class="l-eye" title="删除图层">×</button>' : ''}
      </div>`);
      const [eye, del] = item.querySelectorAll('.l-eye');
      eye.addEventListener('click', () => Editor.toggleLayer(l.id));
      if (del) del.addEventListener('click', () => Editor.removeLayer(l.id));
      wrapEl.appendChild(item);
    }
  }

  /* ---------------- 计划卡片 ---------------- */
  const STEP_STATE = { wait: ['⏳', '等待'], running: ['▶', '执行中'], done: ['✓', '完成'], fail: ['✕', '失败'], skipped: ['⊘', '跳过'], manual: ['✋', '待涂抹'] };

  function buildPlanCard(plan, vres, auto) {
    const stepsHtml = plan.steps.map((s) => {
      const spec = s.tool.startsWith('__') ? { name: s.note } : Reg().get(s.tool);
      const pstr = Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(' ');
      return `<div class="pc-step" data-step="${s.id}">
        <span class="ps-idx">${s.id.replace('s', '')}</span>
        <span class="ps-tool">${esc(s.tool)}</span>
        <span class="ps-desc">${esc(spec ? spec.name : '')}${pstr ? ' · ' + esc(pstr) : ''}</span>
        <span class="ps-state">${STEP_STATE.wait[0]} ${STEP_STATE.wait[1]}</span>
      </div>`;
    }).join('');
    const badge = vres.ok
      ? `<span class="pc-badge">✓ 校验通过 · ${plan.steps.length} 步 · ${plan.steps.filter((s) => s.dependsOn.length).length} 条依赖 · 无环</span>`
      : `<span class="pc-badge fail">✕ 校验失败</span>`;
    const card = el(`<div class="plan-card">
      <div class="pc-head"><span class="pc-title">修图计划</span>${badge}</div>
      <div class="pc-steps">${stepsHtml}</div>
      ${vres.ok ? '' : `<div style="color:var(--err);font-size:11.5px;margin-top:6px">${vres.errors.map(esc).join('<br>')}</div>`}
      <div class="pc-progress"><div></div></div>
      ${auto || !vres.ok ? '' : `<div class="pc-actions">
        <button class="tbtn primary" data-act="confirm">确认执行</button>
        <button class="tbtn" data-act="cancel">取消</button>
      </div>`}
    </div>`);
    return card;
  }

  function sseLog(card) {
    let log = card.querySelector('.sse-log');
    if (!log) {
      log = el('<details class="sse-log"><summary>执行日志 · SSE 风格事件流</summary><div class="sse-body"></div></details>');
      card.appendChild(log);
    }
    return log.querySelector('.sse-body');
  }
  function sseLine(body, type, text) {
    body.appendChild(el(`<div class="sse-line ${type}"><span class="t">${now()}</span><span class="v">${esc(text)}</span></div>`));
    body.scrollTop = body.scrollHeight;
  }

  function setStepState(card, stepId, state) {
    const row = card.querySelector(`[data-step="${stepId}"]`);
    if (!row) return;
    row.className = 'pc-step ' + state;
    row.querySelector('.ps-state').textContent = `${STEP_STATE[state][0]} ${STEP_STATE[state][1]}`;
  }
  function setProgress(card, i, total) {
    const bar = card.querySelector('.pc-progress > div');
    if (bar) bar.style.width = total ? Math.round(((i + 1) / total) * 100) + '%' : '0%';
  }

  /* ---------------- Agent 主流程 ---------------- */
  async function handleUserText(text) {
    text = text.trim();
    if (!text || running) return;
    addMsg('user', `<p>${esc(text)}</p>`);
    $('#inp').value = '';
    autoGrow();

    if (!Editor.hasImage() && !/打开|上传|示例|创作|生成/.test(text)) {
      typing(true);
      await sleep(420);
      typing(false);
      addMsg('agent', `<p>我准备好了，但画布上还没有图片 🖼</p><p>点击顶栏「打开图片」上传本地照片，或点击「AI 创作」用提示词生成一张，也可以直接用示例图试试。</p>`);
      return;
    }

    const real = RA.LLM.isReal();
    typing(true);
    await sleep(real ? 900 : 480); // 模拟规划延迟

    // 真实模式：优先交给规划模型
    if (real) {
      const r = await Agent.realPlan(text);
      if (r.ok) {
        typing(false);
        presentPlan(r.plan, r.vres, true);
        return;
      }
      typing(false);
      addMsg('agent', `<p>⚠ 真实模型规划失败（${esc(r.error)}），已回退本地规则引擎。</p>`);
    } else {
      typing(false);
    }

    // 本地规则引擎
    const parsed = Agent.parse(text);
    if (!parsed.ops.length) {
      addMsg('agent', `<p>这句我还没理解 🤔${parsed.unknown.length ? '（' + parsed.unknown.map(esc).join('、') + '）' : ''}</p>
        <p>我现在具备的能力：</p><p style="font-size:12px;color:var(--txt-1)">${esc(Agent.capabilities()).replace(/\n/g, '<br>')}</p>
        <p>换个说法试试，比如「亮一点，暖一些，背景虚化」。</p>`);
      return;
    }
    const plan = Agent.buildPlan(parsed.ops, text);
    presentPlan(plan, Agent.verify(plan), false);
  }

  /** 展示计划卡片；单步免确认直接执行，多步人机协作 */
  function presentPlan(plan, vres, fromReal) {
    const auto = plan.steps.length === 1;
    const card = buildPlanCard(plan, vres, auto);
    const bubble = addMsg('agent', `<p>${fromReal ? '真实模型' : '收到，我'}的规划如下 ✦</p>`);
    bubble.querySelector('.bubble').appendChild(card);
    const body = sseLog(card);
    sseLine(body, 'think', `意图解析：${fromReal ? 'LLM 规划' : '本地规则'}，${plan.steps.length} 个步骤`);
    sseLine(body, 'plan', `生成计划 ${plan.id}：${plan.steps.length} 步，链式依赖`);
    sseLine(body, 'verify', vres.ok ? '校验通过：工具存在性 / 参数合法性 / 依赖补全 / 环检测' : '校验失败：' + vres.errors.join('；'));

    if (!vres.ok) return;
    if (!auto) {
      card.querySelector('[data-act="confirm"]').addEventListener('click', () => runPlan(plan, card));
      card.querySelector('[data-act="cancel"]').addEventListener('click', () => {
        card.querySelector('.pc-actions').innerHTML = '<span style="font-size:12px;color:var(--txt-2)">已取消执行</span>';
        plan.steps.forEach((s) => setStepState(card, s.id, 'skipped'));
        addMsg('agent', '<p>好的，计划已取消。需要调整随时告诉我。</p>');
      });
      addMsg('agent', `<p style="font-size:12px;color:var(--txt-2)">多步计划需要你确认后执行（人机协作）。</p>`);
    } else {
      runPlan(plan, card);
    }
  }

  async function runPlan(plan, card) {
    running = true;
    $('#btn-send').disabled = true;
    const actions = card.querySelector('.pc-actions');
    if (actions) actions.innerHTML = '<span style="font-size:12px;color:var(--txt-2)">执行中…</span>';
    const body = sseLog(card);
    let manual = [];

    await Agent.run(plan, Editor, {
      onEvent: (ev) => {
        const spec = ev.spec;
        switch (ev.type) {
          case 'step_start':
            setStepState(card, ev.step.id, 'running');
            sseLine(body, 'tool', `[${ev.index + 1}/${ev.total}] 调用 ${ev.step.tool}(${JSON.stringify(ev.step.params)})`);
            break;
          case 'step_done':
            setStepState(card, ev.step.id, 'done');
            setProgress(card, ev.index, ev.total);
            sseLine(body, 'tool', `[${ev.index + 1}/${ev.total}] ${ev.step.tool} 完成`);
            break;
          case 'step_manual':
            setStepState(card, ev.step.id, 'manual');
            manual.push(spec);
            sseLine(body, 'tool', `[${ev.index + 1}/${ev.total}] ${ev.step.tool} 等待手动涂抹`);
            break;
          case 'step_fail':
            setStepState(card, ev.step.id, 'fail');
            sseLine(body, 'error', `[${ev.index + 1}/${ev.total}] ${ev.step.tool} 失败：${ev.error}`);
            break;
          case 'step_skipped':
            setStepState(card, ev.step.id, 'skipped');
            break;
          case 'plan_done': {
            const ok = ev.results.filter((r) => r.status === 'done').length;
            const man = ev.results.filter((r) => r.status === 'manual').length;
            const skip = ev.results.filter((r) => r.status === 'skipped').length;
            sseLine(body, 'done', `计划执行完毕：成功 ${ok} 步${man ? '，手动 ' + man + ' 步' : ''}${skip ? '，跳过 ' + skip + ' 步' : ''}，耗时 ${ev.ms}ms`);
            let reply = `<p>完成 ✅ ${ok ? `自动执行 ${ok} 个步骤` : ''}${ok && man ? '，' : ''}${man ? `激活 ${man} 个画笔步骤` : ''}，耗时 ${(ev.ms / 1000).toFixed(1)}s。</p>`;
            if (manual.length) {
              reply += `<p>其中 <b>${manual.map((s) => esc(s.name)).join('、')}</b> 需要你手动完成：笔刷已激活，直接在画布上涂抹即可，每一笔都是独立图层，可随时撤销。</p><p style="font-size:12px;color:var(--txt-2)">笔刷大小/强度可用画布下方滑块或 <b>[ ]</b> 键随时调整。</p>`;
            }
            reply += `<p style="font-size:12px;color:var(--txt-2)">点击顶栏「前后对比」查看修图效果，或继续告诉我调整方向。</p>`;
            addMsg('agent', reply);
            break;
          }
        }
      },
    });
    running = false;
    $('#btn-send').disabled = false;
  }

  /* ---------------- 图片装载 ---------------- */
  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) { toast('请选择图片文件', 'err'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        Editor.loadImage(img, file.name.replace(/\.[^.]+$/, ''));
        $('#dropzone').classList.add('hidden');
        toast('图片已载入', 'ok');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }
  function loadCanvas(canvas, name) {
    Editor.loadImage(canvas, name);
    $('#dropzone').classList.add('hidden');
    toast(`已载入「${name}」`, 'ok');
  }

  /* ---------------- 弹窗 ---------------- */
  function openModal(id) { $('#' + id).classList.add('show'); }
  function closeModal(id) { $('#' + id).classList.remove('show'); }
  $$('.modal-close').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
  $$('.modal-mask').forEach((m) => m.addEventListener('pointerdown', (e) => { if (e.target === m) m.classList.remove('show'); }));

  function renderCreateGridMock(prompt) {
    const grid = $('#create-grid');
    grid.innerHTML = '<div class="create-cell loading">生成中…</div><div class="create-cell loading">生成中…</div><div class="create-cell loading">生成中…</div><div class="create-cell loading">生成中…</div>';
    setTimeout(() => {
      const imgs = RA.Samples.generate(prompt);
      grid.innerHTML = '';
      imgs.forEach((im, i) => {
        const cell = el(`<div class="create-cell" title="点击选中并进入编辑器">${im.canvas.outerHTML}<span class="cc-tag">${esc(im.name)}</span></div>`);
        cell.addEventListener('click', () => {
          loadCanvas(im.canvas, im.name.replace('候选 ', ''));
          closeModal('modal-create');
        });
        grid.appendChild(cell);
      });
    }, 500);
  }

  function renderCreateGrid(prompt) {
    if (!RA.LLM.isReal()) return renderCreateGridMock(prompt);
    const grid = $('#create-grid');
    grid.innerHTML = '<div class="create-cell loading">调用模型中…</div><div class="create-cell loading">调用模型中…</div><div class="create-cell loading">调用模型中…</div><div class="create-cell loading">调用模型中…</div>';
    RA.LLM.image(prompt || '一幅好看的风景画', 4)
      .then((urls) => {
        grid.innerHTML = '';
        urls.forEach((u, i) => {
          const cell = el(`<div class="create-cell" title="点击选中并进入编辑器"><img src="${u}" alt="候选${i + 1}"><span class="cc-tag">候选 ${String.fromCharCode(65 + i)} · 真实生成</span></div>`);
          cell.addEventListener('click', () => {
            const img = new Image();
            img.onload = () => {
              Editor.loadImage(img, 'AI 创作 ' + String.fromCharCode(65 + i));
              $('#dropzone').classList.add('hidden');
              toast('已载入真实生成图', 'ok');
            };
            img.onerror = () => toast('图片加载失败', 'err');
            img.src = u;
            closeModal('modal-create');
          });
          grid.appendChild(cell);
        });
      })
      .catch((e) => {
        toast('真实生图失败：' + e.message + '，已回退本地生成', 'err');
        renderCreateGridMock(prompt);
      });
  }

  /* ---------------- 画笔浮动控制条 ---------------- */
  function showBrushBar(spec) {
    const p = Editor.brushParams() || {};
    $('#bb-name').textContent = spec.name;
    const hasStrength = (spec.params || []).some((x) => x.key === 'strength');
    $('#bb-strength-field').style.display = hasStrength ? '' : 'none';
    $('#bb-size').value = p.size || 60;
    $('#bb-size-out').textContent = p.size || 60;
    $('#bb-strength').value = p.strength || 50;
    $('#bb-strength-out').textContent = p.strength || 50;
    $('#brush-bar').hidden = false;
  }
  function hideBrushBar() { $('#brush-bar').hidden = true; }
  function syncBrushBar() {
    const p = Editor.brushParams();
    if (!p) return;
    $('#bb-size').value = p.size;
    $('#bb-size-out').textContent = p.size;
    $('#bb-strength').value = p.strength;
    $('#bb-strength-out').textContent = p.strength;
  }
  function adjustBrushSize(delta) {
    const p = Editor.brushParams();
    if (!p) return;
    const size = Math.max(4, Math.min(300, (p.size || 60) + delta));
    Editor.setBrushParams({ size });
    syncBrushBar();
    toast('笔刷大小 ' + size + 'px');
  }
  function bindBrushBar() {
    $('#bb-size').addEventListener('input', () => {
      const v = Number($('#bb-size').value);
      $('#bb-size-out').textContent = v;
      Editor.setBrushParams({ size: v });
    });
    $('#bb-strength').addEventListener('input', () => {
      const v = Number($('#bb-strength').value);
      $('#bb-strength-out').textContent = v;
      Editor.setBrushParams({ strength: v });
    });
    $('#bb-exit').addEventListener('click', () => {
      Editor.clearBrush();
      currentBrush = null;
      $$('.tool-btn').forEach((b) => b.classList.remove('active'));
    });
    // [ ] 快捷键调笔刷大小（Shift 加速）
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (!currentBrush) return;
      if (e.key === '[') { adjustBrushSize(e.shiftKey ? -16 : -4); e.preventDefault(); }
      if (e.key === ']') { adjustBrushSize(e.shiftKey ? 16 : 4); e.preventDefault(); }
    });
  }

  /* ---------------- 模型配置 ---------------- */
  function refreshModeBadge() {
    const st = RA.LLM.state();
    $('#mode-dot').className = 'md-dot mode-' + st;
    $('#btn-settings').title = '模型配置 · 当前：' + {
      builtin: '内置引擎（未配置 Key）',
      direct: '浏览器直连（Key 在 localStorage）',
      proxy: '本地代理（Key 在服务端 .env）',
    }[st];
  }
  function toggleProxyGroup(on) {
    $('#set-proxy').classList.toggle('show', on);
  }
  function openSettings() {
    const cfg = RA.LLM.get();
    $('#set-apikey').value = cfg.apiKey;
    $('#set-baseurl').value = cfg.baseUrl;
    $('#set-planner').value = cfg.plannerModel;
    $('#set-imagemodel').value = cfg.imageModel;
    $('#set-imagesize').value = cfg.imageSize;
    $('#set-proxyurl').value = cfg.proxyUrl;
    $('#set-useproxy').checked = !!cfg.useProxy;
    toggleProxyGroup(!!cfg.useProxy);
    const tr = $('#test-result');
    tr.textContent = '';
    tr.className = '';
    openModal('modal-settings');
  }
  function bindSettings() {
    $('#btn-settings').addEventListener('click', openSettings);
    $('#set-useproxy').addEventListener('change', () => toggleProxyGroup($('#set-useproxy').checked));
    $('#btn-save-settings').addEventListener('click', () => {
      RA.LLM.set({
        apiKey: $('#set-apikey').value.trim(),
        baseUrl: $('#set-baseurl').value.trim() || RA.LLM.DEFAULTS.baseUrl,
        plannerModel: $('#set-planner').value.trim() || 'qwen-plus',
        imageModel: $('#set-imagemodel').value.trim() || 'qwen-image',
        imageSize: $('#set-imagesize').value.trim() || '1024x1024',
        useProxy: $('#set-useproxy').checked,
        proxyUrl: $('#set-proxyurl').value.trim() || 'http://127.0.0.1:8619',
      });
      closeModal('modal-settings');
      toast(RA.LLM.isReal() ? '已保存，真实模型已启用' : '已保存，未配置 Key，使用内置引擎');
    });
    $('#btn-test-conn').addEventListener('click', async () => {
      // 先保存当前表单再测试，保证测的就是用户刚填的
      $('#btn-save-settings').click();
      const tr = $('#test-result');
      tr.className = 'loading';
      tr.textContent = '测试中…';
      try {
        const r = await RA.LLM.ping();
        tr.className = r.info ? 'loading' : 'ok';
        tr.textContent = (r.info ? 'ℹ ' : '✓ ') + r.msg;
      } catch (e) {
        tr.className = 'err';
        tr.textContent = '✗ ' + (e.message || e);
      }
    });
    RA.LLM.onChange(refreshModeBadge);
  }

  function renderRegistry() {
    const list = $('#registry-list');
    list.innerHTML = '';
    for (const spec of Reg().specs) {
      const ps = spec.params.map((p) => `${p.key}:${p.type}${p.type === 'range' ? `[${p.min}..${p.max}]` : ''}`).join(' ');
      list.appendChild(el(`<div class="reg-row"><span class="rr-id">${esc(spec.id)}</span><span class="rr-name">${esc(spec.name)}</span><span class="rr-cat">${esc(spec.category)}</span><span class="rr-params">${esc(ps || '无参数')}</span></div>`));
    }
  }

  /* ---------------- 输入框 ---------------- */
  function autoGrow() {
    const inp = $('#inp');
    inp.style.height = 'auto';
    inp.style.height = Math.min(96, inp.scrollHeight) + 'px';
  }

  /* ---------------- 事件装配 ---------------- */
  function bind() {
    // 顶栏
    $('#btn-open').addEventListener('click', () => $('#file-input').click());
    $('#dz-open').addEventListener('click', () => $('#file-input').click());
    $('#dz-create').addEventListener('click', () => { openModal('modal-create'); renderCreateGrid($('#create-prompt').value); });
    $('#btn-create').addEventListener('click', () => { openModal('modal-create'); renderCreateGrid($('#create-prompt').value); });
    $('#btn-generate').addEventListener('click', () => renderCreateGrid($('#create-prompt').value));
    $('#file-input').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
    $('#btn-undo').addEventListener('click', () => Editor.undo());
    $('#btn-redo').addEventListener('click', () => Editor.redo());
    $('#btn-reset').addEventListener('click', () => { if (Editor.hasImage()) { Editor.reset(); toast('已重置为原图'); } });
    $('#btn-export').addEventListener('click', () => { if (Editor.hasImage()) { Editor.exportPNG(); toast('已导出 PNG', 'ok'); } else toast('请先打开图片', 'err'); });
    $('#btn-compare').addEventListener('click', () => {
      const on = Editor.toggleCompare();
      $('#btn-compare').classList.toggle('active', on);
      if (on) toast('拖动画布上的分割线查看前后对比');
    });
    $('#btn-registry').addEventListener('click', () => { renderRegistry(); openModal('modal-registry'); });

    // 示例图
    $$('.sample-chip').forEach((c) => c.addEventListener('click', () => {
      const im = RA.Samples.sample(Number(c.dataset.sample));
      loadCanvas(im.canvas, im.name);
    }));

    bindSettings();

    // 面板 tab
    $$('.ptab').forEach((t) => t.addEventListener('click', () => {
      $$('.ptab').forEach((x) => x.classList.remove('active'));
      $$('.ptab-page').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('#page-' + t.dataset.ptab).classList.add('active');
    }));

    // 对话
    $('#btn-send').addEventListener('click', () => handleUserText($('#inp').value));
    $('#inp').addEventListener('input', autoGrow);
    $('#inp').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleUserText($('#inp').value); }
    });
    $$('.chip').forEach((c) => c.addEventListener('click', () => handleUserText(c.textContent)));

    // 拖拽
    const cw = $('#canvas-wrap');
    ['dragenter', 'dragover'].forEach((ev) => cw.addEventListener(ev, (e) => { e.preventDefault(); cw.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => cw.addEventListener(ev, (e) => { e.preventDefault(); cw.classList.remove('dragover'); }));
    cw.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

    // 编辑器事件
    Editor.on('layers', renderLayers);
    Editor.on('brush', (spec) => {
      if (spec) {
        currentBrush = spec.id;
        showBrushBar(spec);
        $$('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === spec.id));
      } else {
        currentBrush = null;
        hideBrushBar();
        $$('.tool-btn').forEach((b) => b.classList.remove('active'));
      }
    });
    Editor.on('history', (st) => {
      $('#btn-undo').disabled = !st.canUndo;
      $('#btn-redo').disabled = !st.canRedo;
    });
    Editor.on('status', (data) => {
      const { w, h } = Editor.imageSize();
      $('#st-size').textContent = w ? `${w} × ${h}` : '—';
      const p = Editor.brushParams();
      $('#st-tool').textContent = p ? `画笔：${Editor.brushSpec().name} · ${p.size}px` : (data.brush ? `画笔：${data.brush}` : '就绪');
    });
    bindBrushBar();
    // 缩放百分比显示
    setInterval(() => {
      $('#st-zoom').textContent = Editor.imageSize().w ? Math.round(Editor.viewScale() * 100) + '%' : '100%';
    }, 300);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    Editor.init();
    renderTools();
    renderLayers();
    bind();
    refreshModeBadge();
    $('#st-zoom').textContent = '100%';
    // 欢迎后自动加载第一张示例图，降低体验门槛
    setTimeout(() => {
      const im = RA.Samples.sample(0);
      loadCanvas(im.canvas, im.name);
      addSystemLine('已自动载入示例图「山间晨曦」，试试右侧的快捷指令，或直接输入你的修图需求');
    }, 300);
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();

  // 供调试
  window.RAApp = { handleUserText, applyFromUI };
})();
