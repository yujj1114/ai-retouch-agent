/* ============================================================
 * agent.js — Agent 运行时
 * 复刻原项目的核心链路：
 *   自然语言 → 意图解析 → 结构化 JSON 计划（含依赖）
 *   → 计划校验（工具存在性 / 参数合法性 / 依赖补全 / 环检测）
 *   → 拓扑排序执行 → 事件流反馈
 * 说明：本项目为纯前端复刻，规划模型由内置规则引擎模拟
 *   （对应原项目的 IMAGE_PROVIDER=mock 模式）。
 * ============================================================ */
window.RA = window.RA || {};
RA.Agent = (function () {
  const Reg = () => RA.ToolRegistry;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ================= 意图解析（规则式 NLU） ================= */

  // 背景场景 / 颜色词典
  const BG_SCENES = { '海边': '海边', '海滩': '海边', '大海': '海边', '森林': '森林', '树林': '森林', '草地': '森林', '星空': '星空', '宇宙': '星空', '夕阳': '夕阳', '日落': '夕阳', '黄昏': '夕阳' };
  const BG_COLORS = { '红': '#e74c3c', '橙': '#e67e22', '黄': '#f1c40f', '绿': '#27ae60', '青': '#1abc9c', '蓝': '#2980b9', '紫': '#8e44ad', '粉': '#fd79a8', '黑': '#1a1d24', '白': '#f5f6fa', '灰': '#7f8c9a', '金': '#d4af37' };
  const RATIOS = { '1:1': '1:1', '正方形': '1:1', '方图': '1:1', '4:3': '4:3', '3:4': '3:4', '16:9': '16:9', '9:16': '9:16', '宽屏': '16:9', '手机屏': '9:16' };

  const O = (tool, params, note) => ({ tool, params: Object.assign({}, Reg().defaults(tool), params || {}), note });
  const isBrushTool = (tools) => ['brush_lighten', 'brush_darken', 'brush_smooth', 'brush_blur', 'brush_restore', 'brush_remove'].some((b) => tools.has(b));
  /** 否定语义：关键词前 4 字内出现「不要/别/不用/无需」则忽略该命中 */
  function negated(seg, idx) {
    return /不要|别|不用|无需|不能|禁止/.test(seg.slice(Math.max(0, idx - 4), idx));
  }

  // 规则按优先级排列；同一语句段内每条规则最多命中一次，同一工具只取最高优先级
  const RULES = [
    /* ---- 全局指令 ---- */
    { re: /(重置|恢复原图|还原所有|全部撤销|回到原图)/, make: () => ({ tool: '__reset', params: {}, note: '重置为原图' }) },
    { re: /(导出|保存图片|下载图片|下载)/, make: () => ({ tool: '__export', params: {}, note: '导出 PNG' }) },

    /* ---- 智能（先于画笔，避免「去掉背景」被误判为消除笔）---- */
    { re: /(抠图|抠出|抠出来|去背景|去掉背景|删除背景|移除背景|背景透明|透明背景|扣图)/, make: () => O('smart_matting', {}, '智能抠图') },

    /* ---- 局部画笔 ---- */
    { re: /(磨皮笔|局部磨皮|脸上?磨皮|涂抹磨皮|皮肤.*磨皮)/, make: () => O('brush_smooth', {}, '磨皮笔（需涂抹）') },
    { re: /(提亮笔|局部提亮|涂抹提亮|眼睛.*提亮|面部提亮)/, make: () => O('brush_lighten', {}, '提亮笔（需涂抹）') },
    { re: /(压暗笔|局部压暗|涂抹压暗)/, make: () => O('brush_darken', {}, '压暗笔（需涂抹）') },
    { re: /(模糊笔|局部模糊|涂抹.*模糊)/, make: () => O('brush_blur', {}, '模糊笔（需涂抹）') },
    { re: /(消除|去掉|去除|抹掉|擦掉|p掉|P掉|移除)/, skipIf: (t) => t.has('smart_matting'), make: (seg) => {
        const what = (seg.match(/(路人|物体|对象|东西|水印|文字|杂物|人影|瑕疵|痘痘|黑眼圈|斑点)/) || [])[1];
        return O('brush_remove', {}, what ? `消除${what}（需涂抹）` : '消除笔（需涂抹）');
      } },

    /* ---- 滤镜 ---- */
    { re: /(黑白|灰度|单色|去色)/, make: () => O('filter_bw', {}, '黑白滤镜') },
    { re: /(胶片|电影感|电影色调|film)/i, make: () => O('filter_film', {}, '胶片滤镜') },
    { re: /(复古|怀旧|老照片|vintage)/i, make: () => O('filter_vintage', {}, '复古滤镜') },
    { re: /(清冷|青橙|橙青)/, make: () => O('filter_cool', {}, '清冷滤镜') },
    { re: /(暖阳|阳光感|日光感)/, make: () => O('filter_warm', {}, '暖阳滤镜') },
    { re: /(美颜|人像美化|磨皮|美白|嫩肤|皮肤光滑)/, make: () => O('filter_portrait', {}, '人像美颜'), skipIf: (t) => isBrushTool(t) },

    /* ---- 11 参调色 ---- */
    { re: /(亮一点|提亮|变亮|亮一些|调亮|加亮|提高亮度|增加亮度|太暗|偏暗|暗了)/, skipIf: (t) => isBrushTool(t), make: (seg) => O('adjust_brightness', { value: magnitude(seg, 25, /亮[^\d]{0,4}(\d{1,3})/) }, '提高亮度') },
    { re: /(暗一点|压暗|变暗|暗一些|调暗|降低亮度|减少亮度|太亮|过曝|亮了)/, skipIf: (t) => isBrushTool(t), make: (seg) => O('adjust_brightness', { value: -magnitude(seg, 25, /暗[^\d]{0,4}(\d{1,3})/) }, '降低亮度') },
    { re: /对比/, make: (seg) => O('adjust_contrast', { value: /(减弱|降低|减少|低一点|柔一点)/.test(seg) ? -20 : 20 }, '调整对比度') },
    { re: /(饱和|鲜艳|浓郁|色彩浓)/, make: (seg) => O('adjust_saturation', { value: magnitude(seg, 22, /饱和[^\d]{0,4}(\d{1,3})/) }, '提高饱和度') },
    { re: /(淡一点|清淡|寡淡|颜色淡|饱和度低|色彩淡)/, make: (seg) => O('adjust_saturation', { value: -magnitude(seg, 22, /淡[^\d]{0,4}(\d{1,3})/) }, '降低饱和度') },
    { re: /(暖一点|变暖|暖一些|偏暖|暖色调|温暖一点)/, make: (seg) => O('adjust_temperature', { value: magnitude(seg, 28, /暖[^\d]{0,4}(\d{1,3})/) }, '色温加暖') },
    { re: /(冷一点|变冷|冷一些|偏冷|冷色调)/, make: (seg) => O('adjust_temperature', { value: -magnitude(seg, 28, /冷[^\d]{0,4}(\d{1,3})/) }, '色温加冷') },
    { re: /(曝光)/, make: (seg) => O('adjust_exposure', { value: /(降低|减少|减)/.test(seg) ? -15 : 15 }, '调整曝光') },
    { re: /(暗部|阴影)/, make: (seg) => O('adjust_shadows', { value: /(压暗|加深|降)/.test(seg) ? -20 : 20 }, '调整阴影') },
    { re: /(亮部|高光)/, make: (seg) => O('adjust_highlights', { value: /(恢复|降低|压|减)/.test(seg) ? -15 : 15 }, '调整高光') },
    { re: /(锐化|清晰一点|更清晰|sharp)/i, make: () => O('adjust_sharpen', { value: 35 }, '锐化') },
    { re: /(暗角)/, make: () => O('adjust_vignette', { strength: 35, size: 55 }, '添加暗角') },
    { re: /(颗粒|噪点)/, make: () => O('adjust_grain', { value: 25 }, '添加颗粒') },
    /* 裸「亮 / 暗」兜底（排除 黑暗/漂亮/暗角/暗部/亮部 等误命中；画笔语境下不触发） */
    { re: /(?<![黑漂])亮(?![部一点些])/, skipIf: (t) => isBrushTool(t), make: (seg) => O('adjust_brightness', { value: magnitude(seg, 25, /亮[^\d]{0,4}(\d{1,3})/) }, '提高亮度') },
    { re: /(?<![黑])暗(?![角部一点些])/, skipIf: (t) => isBrushTool(t), make: (seg) => O('adjust_brightness', { value: -magnitude(seg, 25, /暗[^\d]{0,4}(\d{1,3})/) }, '降低亮度') },

    /* ---- 变换 ---- */
    { re: /(逆时针)/, make: () => O('transform_rotate', { deg: '270' }, '逆时针旋转 90°') },
    { re: /(转\s*180|旋转\s*180|倒过来|倒置|颠倒)/, make: () => O('transform_rotate', { deg: '180' }, '旋转 180°') },
    { re: /(旋转|转一下|转个方向|顺时针)/, make: () => O('transform_rotate', { deg: '90' }, '顺时针旋转 90°') },
    { re: /(水平翻转|左右翻转|镜像|flip)/i, make: () => O('transform_flip_h', {}, '水平翻转') },
    { re: /(垂直翻转|上下翻转)/, make: () => O('transform_flip_v', {}, '垂直翻转') },
    { re: /(裁剪|裁成|切成|剪成|构图|比例改)/, make: (seg) => {
        const m = seg.match(/1:1|4:3|3:4|16:9|9:16|正方形|方图|宽屏|手机屏/);
        return O('transform_crop', { ratio: m ? RATIOS[m[0]] : '1:1' }, `裁剪为 ${m ? m[0] : '1:1'}`);
      } },
    { re: /(超分|高清放大|提高清晰度到|变高清|更高清|2\s*倍|两倍|四倍|分辨率提高)/, make: () => O('smart_superres', {}, '超分辨率放大 2×') },
    { re: /(?<!高清)(?<!超分)(?<!倍)放大/, skipIf: (t) => t.has('smart_superres'), make: (seg) => O('transform_scale', { pct: scalePct(seg, 130) }, '放大画布') },
    { re: /(缩小)/, make: (seg) => O('transform_scale', { pct: scalePct(seg, 80) }, '缩小画布') },

    /* ---- 换背景 ---- */
    { re: /(背景虚化|虚化背景|背景模糊|景深|突出主体)/, make: () => O('smart_replace_bg', { type: 'blur' }, '背景虚化') },
    { re: /(换个背景|换背景|背景换|背景改成|背景改为|背景变成|替换背景|背景换成)/, make: (seg) => {
        let params = { type: 'gradient', preset: '海边' };
        let note = '背景换成海边';
        for (const k of Object.keys(BG_SCENES)) {
          if (seg.includes(k)) { params = { type: 'gradient', preset: BG_SCENES[k] }; note = `背景换成${k}`; break; }
        }
        for (const k of Object.keys(BG_COLORS)) {
          if (seg.includes(k + '色') || seg.includes(k + '背景') || new RegExp('换成' + k).test(seg)) {
            params = { type: 'color', color: BG_COLORS[k] }; note = `背景换成${k}色`; break;
          }
        }
        return O('smart_replace_bg', params, note);
      } },
    { re: /(扩图|扩展画布|画布扩大|向外扩展|补全画面|画面外扩)/, make: () => O('smart_expand', { pct: 25 }, 'AI 扩图 25%') },
  ];

  /** 取关键词后第一个数字，否则默认值 */
  function magnitude(seg, def, nearRe) {
    if (nearRe) {
      const m = seg.match(nearRe);
      if (m) return clamp(Math.round(+m[1]), 5, 100);
    }
    const m = seg.match(/(\d{1,3})\s*%?/);
    return m ? clamp(Math.round(+m[1]), 5, 100) : def;
  }
  function scalePct(seg, def) {
    const m = seg.match(/(\d{1,3})\s*%/);
    return m ? clamp(Math.round(+m[1]), 10, 200) : def;
  }

  /** 语句切分：标点 + 顺序连接词 */
  function splitSegments(text) {
    return String(text)
      .split(/[，。；！？、,!?;~～\n]|然后|接着|并且|而且|之后再|后再/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** 解析自然语言 → 操作列表（支持单段多意图，同段同工具去重，相邻相同操作合并） */
  function parse(text) {
    const segments = splitSegments(text);
    const ops = [];
    const unknown = [];
    for (const seg of segments) {
      const segTools = new Set();
      let hit = false;
      for (const rule of RULES) {
        const m = seg.match(rule.re);
        if (!m) continue;
        if (negated(seg, m.index)) continue;                       // 「不要颗粒」这类否定
        if (rule.skipIf && rule.skipIf(segTools)) continue;        // 规则间互斥
        const op = rule.make(seg);
        if (segTools.has(op.tool)) continue; // 同一段同一工具只取最高优先级规则
        segTools.add(op.tool);
        ops.push(op);
        hit = true;
      }
      if (!hit) unknown.push(seg);
    }
    // 相邻且参数完全相同的操作合并（如「太暗了，提亮一些」）
    const merged = [];
    for (const op of ops) {
      const last = merged[merged.length - 1];
      if (last && last.tool === op.tool && JSON.stringify(last.params) === JSON.stringify(op.params)) continue;
      merged.push(op);
    }
    return { segments, ops: merged, unknown };
  }

  /* ================= 计划生成 ================= */
  let planSeq = 0;
  function buildPlan(ops, goal) {
    planSeq += 1;
    return {
      id: 'plan_' + Date.now().toString(36) + '_' + planSeq,
      goal: goal || ops.map((o) => o.note).join(' → '),
      steps: ops.map((op, i) => ({
        id: 's' + (i + 1),
        tool: op.tool,
        params: op.params,
        note: op.note,
        dependsOn: i === 0 ? [] : ['s' + i],
      })),
    };
  }

  /* ================= 计划校验（同构原项目服务端校验） ================= */
  function verify(plan) {
    const errors = [];
    const warnings = [];
    const ids = new Set(plan.steps.map((s) => s.id));

    for (const s of plan.steps) {
      if (s.tool.startsWith('__')) continue; // 系统指令
      const spec = Reg().get(s.tool);
      if (!spec) { errors.push(`工具不存在：${s.tool}`); continue; }
      for (const e of Reg().validateParams(spec, s.params)) errors.push(e);
      for (const dep of s.dependsOn || []) {
        if (!ids.has(dep)) errors.push(`步骤 ${s.id} 依赖了不存在的步骤 ${dep}`);
      }
      if (spec.brush) warnings.push(`步骤 ${s.id}（${spec.name}）需要你在画布上手动涂抹完成`);
    }
    // 环检测
    try { topoOrder(plan.steps); } catch (e) { errors.push('计划存在循环依赖，已阻止执行'); }

    return { ok: errors.length === 0, errors, warnings };
  }

  /* ================= 拓扑排序 ================= */
  function topoOrder(steps) {
    const indeg = new Map();
    const adj = new Map();
    for (const s of steps) { indeg.set(s.id, 0); adj.set(s.id, []); }
    for (const s of steps) {
      for (const dep of s.dependsOn || []) {
        if (indeg.has(dep)) { indeg.set(s.id, indeg.get(s.id) + 1); adj.get(dep).push(s.id); }
      }
    }
    const queue = steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const next of adj.get(id)) {
        indeg.set(next, indeg.get(next) - 1);
        if (indeg.get(next) === 0) queue.push(next);
      }
    }
    if (order.length !== steps.length) throw new Error('cycle detected');
    return order.map((id) => steps.find((s) => s.id === id));
  }

  /* ================= 执行引擎 ================= */
  /**
   * 按拓扑序执行计划，通过 onEvent 推送事件（SSE 风格）。
   * editor 需提供：applyTool / activateBrush / reset / exportPNG / hasImage
   */
  async function run(plan, editor, opt = {}) {
    const onEvent = opt.onEvent || (() => {});
    const stepDelay = opt.stepDelay != null ? opt.stepDelay : 280;
    const order = topoOrder(plan.steps);
    const t0 = performance.now();
    const results = [];
    let failed = false;

    for (let i = 0; i < order.length; i++) {
      const step = order[i];
      const spec = step.tool.startsWith('__') ? null : Reg().get(step.tool);
      onEvent({ type: 'step_start', step, index: i, total: order.length, spec });

      if (failed) {
        onEvent({ type: 'step_skipped', step, index: i, total: order.length, spec });
        results.push({ step, status: 'skipped' });
        continue;
      }
      try {
        if (step.tool === '__reset') {
          editor.reset();
        } else if (step.tool === '__export') {
          editor.exportPNG();
        } else if (spec && spec.brush) {
          editor.activateBrush(step.tool, step.params);
          onEvent({ type: 'step_manual', step, index: i, total: order.length, spec });
          results.push({ step, status: 'manual' });
          await delay(stepDelay);
          continue;
        } else {
          editor.applyTool(step.tool, step.params);
        }
        onEvent({ type: 'step_done', step, index: i, total: order.length, spec });
        results.push({ step, status: 'done' });
      } catch (e) {
        onEvent({ type: 'step_fail', step, index: i, total: order.length, spec, error: e.message || String(e) });
        results.push({ step, status: 'fail', error: e.message });
        if (opt.stopOnError !== false) failed = true;
      }
      await delay(stepDelay);
    }
    onEvent({ type: 'plan_done', ms: Math.round(performance.now() - t0), results });
    return results;
  }

  /* ================= 真实模型规划 ================= */
  /** 工具注册表 → 提示词文本 */
  function toolCatalogText() {
    return Reg().specs.map((s) => {
      const ps = s.params.map((p) => {
        let d = p.key + ':' + p.type;
        if (p.type === 'range') d += `(${p.min}~${p.max})`;
        if (p.options) d += '(' + p.options.map((o) => o[0]).join('/') + ')';
        return d;
      }).join(', ');
      return `- ${s.id}（${s.name}）：${s.desc || ''}${ps ? ' 参数 { ' + ps + ' }' : ''}`;
    }).join('\n');
  }

  const PLAN_SYSTEM = [
    '你是「Retouch Agent」的修图规划器。根据用户的自然语言指令，从下方工具注册表中选择合适的工具，生成结构化修图计划。',
    '',
    '严格要求：',
    '1. 只输出 JSON，格式：{"steps":[{"tool":"工具id","params":{"参数名":值},"note":"这一步的中文说明"}]}',
    '2. tool 必须来自工具注册表，params 必须符合取值范围/合法选项，没必要的参数不要给',
    '3. 涉及局部涂抹的需求（brush_ 开头）也照常规划，执行时会要求用户手动涂抹',
    '4. 用户明确否定的操作（如"不要颗粒"）不要安排',
    '5. 步骤按执行顺序排列；能一步完成就不要拆成多步',
    '6. 无法映射到任何工具时输出 {"steps":[]}',
    '',
    '【工具注册表】',
  ].join('\n');

  /**
   * 真实模型规划：LLM → JSON 计划 → 复用本地校验。
   * 任何一步失败都返回 { ok:false, error }，由调用方回退本地规则。
   */
  async function realPlan(text) {
    let content;
    try {
      content = await RA.LLM.chat([
        { role: 'system', content: PLAN_SYSTEM + '\n' + toolCatalogText() },
        { role: 'user', content: text },
      ], { json: true });
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
    let raw;
    try {
      const m = String(content).match(/\{[\s\S]*\}/);
      raw = JSON.parse(m ? m[0] : content);
    } catch (e) {
      return { ok: false, error: '模型返回不是合法 JSON' };
    }
    if (!raw || !Array.isArray(raw.steps) || !raw.steps.length) {
      return { ok: false, error: '模型未给出可执行的步骤' };
    }
    const plan = buildPlan(raw.steps.map((s) => O(s.tool, s.params || {}, s.note || '')), text);
    const vres = verify(plan);
    if (!vres.ok) return { ok: false, error: '计划校验未通过：' + vres.errors.join('；'), plan, vres };
    return { ok: true, plan, vres };
  }

  /* ================= 兜底回复 ================= */
  function capabilities() {
    const cats = Reg().byCategory();
    const lines = [];
    for (const [cat, list] of cats) lines.push(`${cat}：${list.map((s) => s.name).join('、')}`);
    return lines.join('\n');
  }

  return { parse, buildPlan, verify, topoOrder, run, capabilities, splitSegments, realPlan, toolCatalogText };
})();
