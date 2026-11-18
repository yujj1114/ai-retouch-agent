/* ============================================================
 * editor.js — 画布编辑引擎
 * 图层系统（基层 / 背景层 / 画笔层）、视口变换、
 * 撤销重做（历史快照）、前后对比、画笔局部编辑、导出。
 * ============================================================ */
window.RA = window.RA || {};
RA.Editor = (function () {
  const Reg = () => RA.ToolRegistry;

  let wrap, display, dctx;
  let layers = [];              // [{id,name,type,visible,opacity,canvas}]
  let original = null;          // 原图快照（对比 / 还原笔 / 重置）
  let history = [], future = [];
  let view = { scale: 1, x: 0, y: 0 };
  let compare = { on: false, x: 0.5 };
  let brush = { spec: null, params: {}, drawing: false, points: [], layer: null };
  let panning = false, panStart = null, spaceDown = false;
  let hasTransparency = false;
  let checker = null;
  const listeners = {};
  const HISTORY_CAP = 40;

  const $ = (s) => document.querySelector(s);
  const on = (evt, cb) => { (listeners[evt] = listeners[evt] || []).push(cb); };
  const emit = (evt, data) => { (listeners[evt] || []).forEach((cb) => cb(data)); };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function newCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  function copyCanvas(src) {
    const c = newCanvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }
  let layerSeq = 0;
  function addLayer(name, type, canvas, opts = {}) {
    const layer = { id: 'L' + ++layerSeq + '_' + Date.now().toString(36), name, type, canvas, visible: true, opacity: 1, ...opts };
    layers.push(layer);
    return layer;
  }
  function baseLayer() { return layers.find((l) => l.type === 'base'); }
  function bgLayer() { return layers.find((l) => l.type === 'bg'); }
  /** 廉价透明度检测：缩放到 24px 采样，避免每次渲染全图 getImageData */
  let alphaProbe = null;
  function detectTransparency() {
    const { w, h } = imageSize();
    if (!w || !h) { hasTransparency = false; return; }
    if (!alphaProbe) alphaProbe = newCanvas(24, 24);
    const pctx = alphaProbe.getContext('2d');
    pctx.clearRect(0, 0, 24, 24);
    for (const l of layers) {
      if (!l.visible || l.opacity <= 0) continue;
      pctx.globalAlpha = l.opacity;
      pctx.drawImage(l.canvas, 0, 0, 24, 24);
      pctx.globalAlpha = 1;
    }
    const d = pctx.getImageData(0, 0, 24, 24).data;
    hasTransparency = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasTransparency = true; break; }
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    wrap = $('#canvas-wrap');
    display = $('#canvas');
    dctx = display.getContext('2d');

    // 棋盘格 pattern（屏幕空间）
    checker = document.createElement('canvas');
    checker.width = checker.height = 16;
    const cctx = checker.getContext('2d');
    cctx.fillStyle = '#191d29'; cctx.fillRect(0, 0, 16, 16);
    cctx.fillStyle = '#141822'; cctx.fillRect(0, 0, 8, 8); cctx.fillRect(8, 8, 8, 8);

    display.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    wrap.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    new ResizeObserver(render).observe(wrap);
  }

  /* ---------------- 图片装载 ---------------- */
  function loadImage(source, name) {
    const img = source instanceof HTMLImageElement ? source : null;
    const src = img || source;
    const base = newCanvas(src.naturalWidth || src.width, src.naturalHeight || src.height);
    base.getContext('2d').drawImage(src, 0, 0);
    // 超大图保护
    const MAX = 2200;
    let finalBase = base;
    if (Math.max(base.width, base.height) > MAX) {
      const k = MAX / Math.max(base.width, base.height);
      finalBase = newCanvas(base.width * k, base.height * k);
      finalBase.getContext('2d').imageSmoothingQuality = 'high';
      finalBase.getContext('2d').drawImage(base, 0, 0, finalBase.width, finalBase.height);
    }
    layers = [];
    addLayer(name || '基层', 'base', finalBase);
    original = copyCanvas(finalBase);
    history = []; future = [];
    brush.spec = null; brush.layer = null;
    detectTransparency();
    fitView();
    snapshot('打开图片');
    emitAll();
  }

  function hasImage() { return layers.length > 0; }
  function imageSize() { const b = baseLayer(); return b ? { w: b.canvas.width, h: b.canvas.height } : { w: 0, h: 0 }; }

  /* ---------------- 合成与渲染 ---------------- */
  function compositeTo(target) {
    const ctx = target.getContext('2d');
    ctx.clearRect(0, 0, target.width, target.height);
    for (const l of layers) {
      if (!l.visible || l.opacity <= 0) continue;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  function render() {
    if (!display) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    if (display.width !== w * dpr || display.height !== h * dpr) {
      display.width = w * dpr; display.height = h * dpr;
    }
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.clearRect(0, 0, w, h);
    if (!hasImage()) return;

    const { w: iw, h: ih } = imageSize();
    const vx = view.x, vy = view.y, vs = view.scale;
    const sx = vx, sy = vy, sw = iw * vs, sh = ih * vs;

    // 棋盘格（屏幕空间）
    if (hasTransparency) {
      const pat = dctx.createPattern(checker, 'repeat');
      dctx.fillStyle = pat;
      dctx.fillRect(sx, sy, sw, sh);
    }
    // 图像
    const tmp = compositeBuffer || (compositeBuffer = newCanvas(iw, ih));
    if (tmp.width !== iw || tmp.height !== ih) { tmp.width = iw; tmp.height = ih; }
    compositeTo(tmp);

    if (compare.on && original) {
      // 左：原图 / 右：当前
      const div = sx + sw * compare.x;
      dctx.save();
      dctx.beginPath(); dctx.rect(sx, sy, Math.max(0, div - sx), sh); dctx.clip();
      dctx.drawImage(original, sx, sy, sw, sh);
      dctx.restore();
      dctx.save();
      dctx.beginPath(); dctx.rect(div, sy, Math.max(0, sx + sw - div), sh); dctx.clip();
      dctx.drawImage(tmp, sx, sy, sw, sh);
      dctx.restore();
      // 分割线
      dctx.strokeStyle = 'rgba(255,255,255,.9)';
      dctx.lineWidth = 1.5;
      dctx.beginPath(); dctx.moveTo(div, sy); dctx.lineTo(div, sy + sh); dctx.stroke();
      dctx.fillStyle = 'rgba(255,255,255,.95)';
      dctx.beginPath(); dctx.arc(div, sy + sh / 2, 9, 0, Math.PI * 2); dctx.fill();
      dctx.fillStyle = '#222';
      dctx.font = '10px sans-serif'; dctx.textAlign = 'center'; dctx.textBaseline = 'middle';
      dctx.fillText('⇔', div, sy + sh / 2 + 0.5);
      // 标签
      dctx.font = '11px sans-serif';
      dctx.fillStyle = 'rgba(0,0,0,.55)';
      dctx.fillRect(sx + 8, sy + 8, 44, 20);
      dctx.fillRect(sx + sw - 52, sy + 8, 44, 20);
      dctx.fillStyle = '#fff';
      dctx.textAlign = 'left';
      dctx.fillText('原图', sx + 16, sy + 19);
      dctx.fillText('修图后', sx + sw - 44, sy + 19);
    } else {
      dctx.drawImage(tmp, sx, sy, sw, sh);
    }
    // 画笔描边预览由画笔层实时呈现，无需额外处理
    emit('status', {});
  }
  let compositeBuffer = null;

  /* ---------------- 视口 ---------------- */
  function fitView() {
    const { w: iw, h: ih } = imageSize();
    const pw = wrap.clientWidth - 90, ph = wrap.clientHeight - 70;
    view.scale = Math.min(pw / iw, ph / ih, 1);
    view.x = (wrap.clientWidth - iw * view.scale) / 2;
    view.y = (wrap.clientHeight - ih * view.scale) / 2;
    render();
  }
  function zoomAt(mx, my, factor) {
    const ns = Math.min(8, Math.max(0.05, view.scale * factor));
    const k = ns / view.scale;
    view.x = mx - (mx - view.x) * k;
    view.y = my - (my - view.y) * k;
    view.scale = ns;
    render();
  }
  function toImage(mx, my) {
    return { x: (mx - view.x) / view.scale, y: (my - view.y) / view.scale };
  }

  /* ---------------- 历史 ---------------- */
  function snapshotLayers() {
    return layers.map((l) => ({ ...l, canvas: copyCanvas(l.canvas) }));
  }
  function pushHistory(label) {
    history.push({ label, layers: snapshotLayers() });
    if (history.length > HISTORY_CAP) history.shift();
    future = [];
    emit('history', { canUndo: history.length > 1, canRedo: false });
  }
  function snapshot(label) { pushHistory(label); }
  function undo() {
    if (history.length <= 1) return;
    future.push(history.pop());
    const s = history[history.length - 1];
    layers = s.layers.map((l) => ({ ...l, canvas: copyCanvas(l.canvas) }));
    emitAll();
  }
  function redo() {
    if (!future.length) return;
    const s = future.pop();
    history.push(s);
    layers = s.layers.map((l) => ({ ...l, canvas: copyCanvas(l.canvas) }));
    emitAll();
  }
  function reset() {
    if (!original) return;
    const base = newCanvas(original.width, original.height);
    base.getContext('2d').drawImage(original, 0, 0);
    layers = [addLayer('基层', 'base', base)];
    // addLayer 在空 layers 上调用，保持顺序
    brush.spec = null; brush.layer = null;
    fitView();
    pushHistory('重置为原图');
    emitAll();
  }
  function historyState() {
    return { canUndo: history.length > 1, canRedo: future.length > 0 };
  }

  /* ---------------- 工具执行（UI 与 Agent 共用入口） ---------------- */
  function applyTool(id, params) {
    if (!hasImage()) throw new Error('尚未打开图片');
    const spec = Reg().get(id);
    if (!spec) throw new Error('工具未注册：' + id);
    if (spec.brush) throw new Error(spec.name + '是画笔工具，请在画布上涂抹使用');
    const p = Object.assign(Reg().defaults(id), params || {});
    const errs = Reg().validateParams(spec, p);
    if (errs.length) throw new Error(errs[0]);

    pushHistory(spec.name);

    /* —— 智能换背景：生成独立背景层 —— */
    if (id === 'smart_replace_bg') {
      const base = baseLayer();
      const mask = Reg().computeBgMask(base.canvas, p.tolerance);
      let bg = bgLayer();
      if (!bg) {
        bg = { id: 'L' + ++layerSeq + '_' + Date.now().toString(36), name: '背景层', type: 'bg', canvas: newCanvas(base.canvas.width, base.canvas.height), visible: true, opacity: 1 };
        layers.unshift(bg); // 背景层置底
      }
      const bctx = bg.canvas.getContext('2d');
      bctx.clearRect(0, 0, bg.canvas.width, bg.canvas.height);
      if (p.type === 'blur') {
        bctx.drawImage(base.canvas, 0, 0);
        const img = bctx.getImageData(0, 0, bg.canvas.width, bg.canvas.height);
        img.data.set(Reg().boxBlur(img.data, bg.canvas.width, bg.canvas.height, Math.max(4, Math.round(Math.min(bg.canvas.width, bg.canvas.height) / 45))));
        bctx.putImageData(img, 0, 0);
      } else if (p.type === 'color') {
        bctx.fillStyle = p.color || '#2980b9';
        bctx.fillRect(0, 0, bg.canvas.width, bg.canvas.height);
      } else {
        const presets = { '海边': ['#0a3d62', '#3c9dde', '#82ccdd'], '森林': ['#134e3a', '#3d9970', '#a8e6cf'], '星空': ['#0b0d2b', '#3b2f7a', '#7c5cff'], '夕阳': ['#4a1f2e', '#e17055', '#fdcb6e'] };
        const stops = presets[p.preset] || presets['海边'];
        const grad = bctx.createLinearGradient(0, 0, 0, bg.canvas.height);
        stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
        bctx.fillStyle = grad;
        bctx.fillRect(0, 0, bg.canvas.width, bg.canvas.height);
      }
      // 基层背景区域透明化，露出背景层
      const bctx2 = base.canvas.getContext('2d');
      const img2 = bctx2.getImageData(0, 0, base.canvas.width, base.canvas.height);
      for (let i = 0; i < mask.length; i++) if (mask[i]) img2.data[i * 4 + 3] = 0;
      bctx2.putImageData(img2, 0, 0);
      detectTransparency(); render(); emit('layers');
      return;
    }

    /* —— 返回新画布的变换类工具：同步作用于所有图层 —— */
    const isTransform = spec.category === '变换' || id === 'smart_expand' || id === 'smart_superres';
    if (isTransform) {
      const newLayers = layers.map((l) => {
        const nc = spec.apply(l.canvas, p);
        return { ...l, canvas: nc || l.canvas };
      });
      layers = newLayers;
    } else {
      const base = baseLayer();
      const nc = spec.apply(base.canvas, p);
      if (nc && nc !== base.canvas) base.canvas = nc;
    }
    detectTransparency(); render(); emit('layers');
  }

  /* ---------------- 画笔 ---------------- */
  function activateBrush(id, params) {
    const spec = Reg().get(id);
    if (!spec) throw new Error('画笔工具未注册：' + id);
    brush.spec = spec;
    brush.params = Object.assign(Reg().defaults(id), params || {});
    display.classList.add('tool-brush');
    emit('status', { brush: spec.name });
    emit('brush', spec);
  }
  /** 实时调整当前画笔参数（大小/强度），不影响进行中的笔画 */
  function setBrushParams(patch) {
    if (!brush.spec) return;
    brush.params = Object.assign({}, brush.params, patch);
    emit('brush', brush.spec);
    emit('status', { brush: brush.spec.name });
  }
  function clearBrush() {
    brush.spec = null; brush.layer = null; brush.points = [];
    display.classList.remove('tool-brush');
    $('#brush-cursor').style.display = 'none';
    emit('status', {});
    emit('brush', null);
  }

  function onPointerDown(e) {
    if (!hasImage()) return;
    if (e.button === 1 || spaceDown || (!brush.spec && e.button === 0)) {
      panning = true;
      panStart = { mx: e.clientX, my: e.clientY, vx: view.x, vy: view.y };
      display.setPointerCapture(e.pointerId);
      return;
    }
    if (brush.spec && e.button === 0) {
      const rect = display.getBoundingClientRect();
      const pt0 = toImage(e.clientX - rect.left, e.clientY - rect.top);
      const sz0 = imageSize();
      // 图片外不落笔（缩小视图时避免起笔在灰域被裁剪，感觉"对不上"）
      if (pt0.x < 0 || pt0.y < 0 || pt0.x > sz0.w || pt0.y > sz0.h) return;
      const pt = { x: clamp(pt0.x, 0, sz0.w), y: clamp(pt0.y, 0, sz0.h) };
      brush.drawing = true;
      brush.points = [pt];
      // 每一笔独立画笔层；先画实时预览，抬手时替换为真实效果
      pushHistory(brush.spec.name);
      const sz = imageSize();
      brush.layer = addLayer(brush.spec.name, 'paint', newCanvas(sz.w, sz.h));
      brush.layer.name = brush.spec.name + ' ' + layers.filter((l) => l.type === 'paint').length;
      const pctx = brush.layer.canvas.getContext('2d');
      if (brush.spec.id === 'brush_lighten' || brush.spec.id === 'brush_darken') {
        const a = (brush.params.strength / 100) * 0.5;
        pctx.globalCompositeOperation = brush.spec.id === 'brush_lighten' ? 'lighten' : 'darken';
        pctx.fillStyle = brush.spec.id === 'brush_lighten' ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
      } else {
        pctx.fillStyle = 'rgba(124,92,255,.4)'; // 预览标记（松手后替换）
      }
      pctx.beginPath();
      pctx.arc(pt.x, pt.y, Math.max(2, brush.params.size / 2), 0, Math.PI * 2);
      pctx.fill();
      pctx.globalCompositeOperation = 'source-over';
      render();
      display.setPointerCapture(e.pointerId);
    }
  }

  function onPointerMove(e) {
    if (!hasImage()) return;
    const rect = display.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    // 画笔光标（始终反映真实效果大小，不做最低钳制）
    const cursor = $('#brush-cursor');
    if (brush.spec) {
      const size = Math.max(3, brush.params.size * view.scale);
      cursor.style.display = 'block';
      cursor.style.width = cursor.style.height = size + 'px';
      cursor.style.left = mx + 'px';
      cursor.style.top = my + 'px';
    }

    if (panning && panStart) {
      view.x = panStart.vx + (e.clientX - panStart.mx);
      view.y = panStart.vy + (e.clientY - panStart.my);
      render();
      return;
    }
    // 画笔绘制优先于对比分割线（避免开对比时画笔失灵）
    if (brush.drawing && brush.spec) {
      const raw = toImage(mx, my);
      const sz = imageSize();
      const pt = { x: clamp(raw.x, 0, sz.w), y: clamp(raw.y, 0, sz.h) }; // 出界的点钳制回图内
      brush.points.push(pt);
      const pctx = brush.layer.canvas.getContext('2d');
      const n = brush.points.length;
      const p0 = brush.points[n - 2], p1 = brush.points[n - 1];
      pctx.lineCap = pctx.lineJoin = 'round';
      pctx.lineWidth = brush.params.size;
      if (brush.spec.id === 'brush_lighten' || brush.spec.id === 'brush_darken') {
        const a = (brush.params.strength / 100) * 0.5;
        pctx.globalCompositeOperation = brush.spec.id === 'brush_lighten' ? 'lighten' : 'darken';
        pctx.strokeStyle = brush.spec.id === 'brush_lighten' ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
      } else {
        pctx.globalCompositeOperation = 'source-over';
        pctx.strokeStyle = 'rgba(124,92,255,.4)'; // 实时预览标记，抬手后替换为真实效果
      }
      pctx.beginPath(); pctx.moveTo(p0.x, p0.y); pctx.lineTo(p1.x, p1.y); pctx.stroke();
      pctx.globalCompositeOperation = 'source-over';
      render();
      return;
    }

    if (compare.on) {
      const iw = imageSize().w * view.scale;
      compare.x = Math.min(0.98, Math.max(0.02, (mx - view.x) / (iw || 1)));
      render();
      return;
    }
  }

  function onPointerUp(e) {
    if (panning) { panning = false; panStart = null; return; }
    if (!brush.drawing || !brush.spec) return;
    brush.drawing = false;
    const spec = brush.spec;
    const pts = brush.points;
    brush.points = [];
    const layer = brush.layer;
    brush.layer = null;
    if (!layer || !pts.length) return;

    const { w: iw, h: ih } = imageSize();
    const lctx = layer.canvas.getContext('2d');
    const size = brush.params.size;

    // 提亮 / 压暗：绘制过程中已实时完成
    if (spec.id === 'brush_lighten' || spec.id === 'brush_darken') {
      render(); emit('layers');
      return;
    }

    /* ---- 笔迹蒙版：只有画笔经过的区域生效（不再是整块外接矩形） ---- */
    const maskC = newCanvas(iw, ih);
    const mctx = maskC.getContext('2d');
    mctx.strokeStyle = '#fff';
    mctx.fillStyle = '#fff';
    mctx.lineWidth = size;
    mctx.lineCap = mctx.lineJoin = 'round';
    if (pts.length === 1) {
      mctx.beginPath();
      mctx.arc(pts[0].x, pts[0].y, Math.max(2, size / 2), 0, Math.PI * 2);
      mctx.fill();
    } else {
      mctx.beginPath();
      mctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) mctx.lineTo(pts[i].x, pts[i].y);
      mctx.stroke();
    }
    const maskData = mctx.getImageData(0, 0, iw, ih).data;

    // 当前合成结果（排除本画笔层里的预览标记）
    layer.visible = false;
    const tmp = newCanvas(iw, ih);
    compositeTo(tmp);
    layer.visible = true;
    const src = tmp.getContext('2d').getImageData(0, 0, iw, ih);

    if (spec.id === 'brush_restore') {
      // 原图 ∩ 笔迹蒙版
      lctx.clearRect(0, 0, iw, ih);
      lctx.drawImage(maskC, 0, 0);
      lctx.globalCompositeOperation = 'source-in';
      lctx.drawImage(original, 0, 0);
      lctx.globalCompositeOperation = 'source-over';
    } else if (spec.applyBrush) {
      // 模糊 / 磨皮 / 消除：整图处理后，图层只写笔迹蒙版区域
      // 图层 alpha = 蒙版 alpha，RGB = 处理后值；source-over 合成即得 处理*m + 原合成*(1-m)
      const work = { data: new Uint8ClampedArray(src.data), width: iw, height: ih };
      spec.applyBrush(work, iw, ih, brush.params);
      const wd = work.data;
      const out = lctx.createImageData(iw, ih);
      const od = out.data;
      for (let i = 0; i < wd.length; i += 4) {
        const m = maskData[i + 3];
        if (m <= 0) continue;
        od[i] = wd[i];
        od[i + 1] = wd[i + 1];
        od[i + 2] = wd[i + 2];
        od[i + 3] = m;
      }
      lctx.clearRect(0, 0, iw, ih);
      lctx.putImageData(out, 0, 0);
    }
    detectTransparency(); render(); emit('layers');
  }

  function onWheel(e) {
    if (!hasImage()) return;
    e.preventDefault();
    const rect = display.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    emit('status', {});
  }

  function onKey(e) {
    if (e.code === 'Space') spaceDown = e.type === 'keydown';
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    }
  }

  /* ---------------- 对比 / 导出 ---------------- */
  function setCompare(onoff) {
    compare.on = !!onoff;
    if (compare.on) compare.x = 0.5;
    render();
  }
  function toggleCompare() { setCompare(!compare.on); return compare.on; }

  function exportPNG() {
    if (!hasImage()) return;
    const { w, h } = imageSize();
    const out = newCanvas(w, h);
    compositeTo(out);
    out.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'retouch-agent-' + Date.now() + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }

  /* ---------------- 图层操作 ---------------- */
  function toggleLayer(id) {
    const l = layers.find((x) => x.id === id);
    if (l) { l.visible = !l.visible; detectTransparency(); render(); emit('layers'); }
  }
  function removeLayer(id) {
    const idx = layers.findIndex((x) => x.id === id);
    if (idx > -1 && layers[idx].type !== 'base') {
      layers.splice(idx, 1);
      pushHistory('删除图层');
      detectTransparency(); render(); emit('layers');
    }
  }

  function emitAll() {
    detectTransparency();
    render();
    emit('layers');
    emit('history', historyState());
    emit('status', {});
  }

  return {
    init, loadImage, hasImage, imageSize, applyTool, activateBrush, setBrushParams, clearBrush,
    undo, redo, reset, exportPNG, setCompare, toggleCompare, fitView,
    toggleLayer, removeLayer, on, layers: () => layers, historyState,
    isCompare: () => compare.on, viewScale: () => view.scale,
    brushParams: () => (brush.spec ? Object.assign({}, brush.params) : null),
    brushSpec: () => brush.spec,
  };
})();
