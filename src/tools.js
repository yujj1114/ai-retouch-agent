/* ============================================================
 * tools.js — 工具注册表 ToolRegistry
 * 复刻自 yuyuanweb/ai-picture-editor 的核心设计：
 * 所有编辑工具一处定义，UI 按钮调用与 Agent 调用
 * 走同一条执行路径（Editor.applyTool），参数校验不漂移。
 * ============================================================ */
window.RA = window.RA || {};
RA.ToolRegistry = (function () {
  const specs = [];

  /* ---------------- 像素级工具函数 ---------------- */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /** 一次性取图 → 依次执行像素算子 → 写回 */
  function pipeline(canvas, ops) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (const op of ops) op(d, w, h);
    ctx.putImageData(img, 0, 0);
  }

  /** 可分离盒模糊（作用于 RGBA 字节数组） */
  function boxBlur(src, w, h, r) {
    const tmp = new Uint8ClampedArray(src.length);
    const out = new Uint8ClampedArray(src.length);
    const win = r * 2 + 1;
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          const x = clamp(k, 0, w - 1);
          sum += src[(y * w + x) * 4 + c];
        }
        for (let x = 0; x < w; x++) {
          tmp[(y * w + x) * 4 + c] = sum / win;
          const xa = clamp(x - r, 0, w - 1), xb = clamp(x + r + 1, 0, w - 1);
          sum += src[(y * w + xb) * 4 + c] - src[(y * w + xa) * 4 + c];
        }
      }
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          const y = clamp(k, 0, h - 1);
          sum += tmp[(y * w + x) * 4 + c];
        }
        for (let y = 0; y < h; y++) {
          out[(y * w + x) * 4 + c] = sum / win;
          const ya = clamp(y - r, 0, h - 1), yb = clamp(y + r + 1, 0, h - 1);
          sum += tmp[(yb * w + x) * 4 + c] - tmp[(ya * w + x) * 4 + c];
        }
      }
    }
    return out;
  }

  /* ---- 11 参调色算子 ---- */
  const opBrightness = (v) => (d) => {
    const b = v * 2.55;
    for (let i = 0; i < d.length; i += 4) { d[i] += b; d[i + 1] += b; d[i + 2] += b; }
  };
  const opContrast = (v) => (d) => {
    const c = clamp(v * 2.55, -255, 255);
    const f = (259 * (c + 255)) / (255 * (259 - c));
    for (let i = 0; i < d.length; i += 4) {
      d[i] = f * (d[i] - 128) + 128;
      d[i + 1] = f * (d[i + 1] - 128) + 128;
      d[i + 2] = f * (d[i + 2] - 128) + 128;
    }
  };
  const opSaturation = (v) => (d) => {
    const f = 1 + v / 100;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = lum + (d[i] - lum) * f;
      d[i + 1] = lum + (d[i + 1] - lum) * f;
      d[i + 2] = lum + (d[i + 2] - lum) * f;
    }
  };
  const opTemperature = (v) => (d) => {
    const t = v * 0.9;
    for (let i = 0; i < d.length; i += 4) { d[i] += t; d[i + 2] -= t; }
  };
  const opTint = (v) => (d) => {
    const m = v * 0.6;
    for (let i = 0; i < d.length; i += 4) { d[i + 1] -= m; d[i] += m * 0.5; d[i + 2] += m * 0.5; }
  };
  const opExposure = (v) => (d) => {
    const f = Math.pow(2, v / 50);
    for (let i = 0; i < d.length; i += 4) { d[i] *= f; d[i + 1] *= f; d[i + 2] *= f; }
  };
  const opShadows = (v) => (d) => {
    const a = v * 0.8;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      const wgt = clamp((0.55 - lum) * 2, 0, 1);
      const add = a * wgt;
      d[i] += add; d[i + 1] += add; d[i + 2] += add;
    }
  };
  const opHighlights = (v) => (d) => {
    const a = v * 0.8;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      const wgt = clamp((lum - 0.45) * 2, 0, 1);
      const add = a * wgt;
      d[i] += add; d[i + 1] += add; d[i + 2] += add;
    }
  };
  const opSharpen = (v) => (d, w, h) => {
    const k = (v / 100) * 2.2;
    if (k <= 0) return;
    const src = new Uint8ClampedArray(d);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const p = src[i + c];
          const up = src[(y > 0 ? y - 1 : y) * w * 4 + x * 4 + c];
          const dn = src[(y < h - 1 ? y + 1 : y) * w * 4 + x * 4 + c];
          const lf = src[y * w * 4 + (x > 0 ? x - 1 : x) * 4 + c];
          const rt = src[y * w * 4 + (x < w - 1 ? x + 1 : x) * 4 + c];
          d[i + c] = p + k * (p - (up + dn + lf + rt) / 4);
        }
      }
    }
  };
  const opVignette = (strength, size) => (d, w, h) => {
    const s = strength / 100;
    if (s <= 0) return;
    const inner = 0.30 + (size / 100) * 0.45;
    const cx = w / 2, cy = h / 2, maxR = Math.hypot(cx, cy) || 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / maxR, dy = (y - cy) / maxR;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let t = (dist - inner) / (1 - inner);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        t = t * t * (3 - 2 * t);
        const f = 1 - s * t;
        const i = (y * w + x) * 4;
        d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
      }
    }
  };
  const opGrain = (v) => (d) => {
    const a = v * 1.1;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * a;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
  };
  /** 智能磨皮：低频混合 + 边缘保护 */
  const opSkinSmooth = (v) => (d, w, h) => {
    const k = (v / 100) * 0.85;
    if (k <= 0) return;
    const src = new Uint8ClampedArray(d);
    const r = Math.max(2, Math.round(Math.min(w, h) / 110));
    const blur = boxBlur(src, w, h, r);
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const diff = Math.abs(src[i + c] - blur[i + c]);
        const edge = Math.min(1, diff / 24);
        const wgt = k * (1 - edge);
        d[i + c] = src[i + c] * (1 - wgt) + blur[i + c] * wgt;
      }
    }
  };

  /* ---------------- 画布级工具函数 ---------------- */
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
  function flipCanvas(src, horiz, vert) {
    const c = newCanvas(src.width, src.height);
    const ctx = c.getContext('2d');
    ctx.translate(horiz ? src.width : 0, vert ? src.height : 0);
    ctx.scale(horiz ? -1 : 1, vert ? -1 : 1);
    ctx.drawImage(src, 0, 0);
    return c;
  }
  function rotateCanvas(src, deg) {
    const rad = (deg * Math.PI) / 180;
    const w = src.width, h = src.height;
    const nw = Math.abs(Math.round(w * Math.cos(rad))) + Math.abs(Math.round(h * Math.sin(rad)));
    const nh = Math.abs(Math.round(w * Math.sin(rad))) + Math.abs(Math.round(h * Math.cos(rad)));
    const c = newCanvas(nw, nh);
    const ctx = c.getContext('2d');
    ctx.translate(nw / 2, nh / 2);
    ctx.rotate(rad);
    ctx.drawImage(src, -w / 2, -h / 2);
    return c;
  }
  function scaleCanvas(src, pct) {
    const c = newCanvas((src.width * pct) / 100, (src.height * pct) / 100);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function cropCanvas(src, ratio) {
    if (!ratio) return copyCanvas(src);
    let w = src.width, h = src.height;
    if (w / h > ratio) w = Math.round(h * ratio);
    else h = Math.round(w / ratio);
    const x = Math.round((src.width - w) / 2);
    const y = Math.round((src.height - h) / 2);
    const c = newCanvas(w, h);
    c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
    return c;
  }

  /** Mock 抠图：从四边向内做颜色相似度漫水，把背景抠成透明 */
  function computeBgMask(canvas, tolerance) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h); // 1 = 背景
    // 参考色 = 四角像素均值
    let r = 0, g = 0, b = 0, n = 0;
    const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
    for (const [x, y] of corners) {
      const i = (y * w + x) * 4;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    r /= n; g /= n; b /= n;
    const tol2 = tolerance * tolerance * 4;
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const p = y * w + x;
      if (mask[p]) return;
      const i = p * 4;
      const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
      if (dr * dr + dg * dg + db * db <= tol2) { mask[p] = 1; stack.push(x, y); }
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
    return mask;
  }

  /** Mock AI 换背景：背景区域替换为 模糊 / 纯色 / 渐变 */
  function replaceBg(canvas, params) {
    const w = canvas.width, h = canvas.height;
    const mask = computeBgMask(canvas, params.tolerance || 42);
    const ctx = canvas.getContext('2d');
    const src = copyCanvas(canvas);

    if (params.type === 'blur') {
      const blurred = newCanvas(w, h);
      const bctx = blurred.getContext('2d');
      bctx.drawImage(src, 0, 0);
      const img = bctx.getImageData(0, 0, w, h);
      const bl = boxBlur(img.data, w, h, Math.max(4, Math.round(Math.min(w, h) / 45)));
      img.data.set(bl);
      bctx.putImageData(img, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(blurred, 0, 0);
      // 主体区域贴回原图
      const sub = newCanvas(w, h);
      const sctx = sub.getContext('2d');
      const sd = sctx.createImageData(w, h);
      const orig = src.getContext('2d').getImageData(0, 0, w, h).data;
      for (let p = 0; p < w * h; p++) {
        if (!mask[p]) {
          sd.data[p * 4] = orig[p * 4];
          sd.data[p * 4 + 1] = orig[p * 4 + 1];
          sd.data[p * 4 + 2] = orig[p * 4 + 2];
          sd.data[p * 4 + 3] = 255;
        }
      }
      sctx.putImageData(sd, 0, 0);
      ctx.drawImage(sub, 0, 0);
      return;
    }

    // 纯色 / 渐变
    let fill;
    if (params.type === 'color') {
      fill = params.color || '#2980b9';
    } else {
      const presets = {
        '海边': ['#0a3d62', '#3c9dded0', '#82ccdd'],
        '森林': ['#134e3a', '#3d9970', '#a8e6cf'],
        '星空': ['#0b0d2b', '#3b2f7a', '#7c5cff'],
        '夕阳': ['#4a1f2e', '#e17055', '#fdcb6e'],
      };
      const stops = presets[params.preset] || presets['海边'];
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
      fill = grad;
    }
    const bg = newCanvas(w, h);
    const bgctx = bg.getContext('2d');
    bgctx.fillStyle = fill;
    bgctx.fillRect(0, 0, w, h);
    const orig = src.getContext('2d').getImageData(0, 0, w, h).data;
    const bd = bgctx.getImageData(0, 0, w, h);
    for (let p = 0; p < w * h; p++) {
      if (!mask[p]) {
        bd.data[p * 4] = orig[p * 4];
        bd.data[p * 4 + 1] = orig[p * 4 + 1];
        bd.data[p * 4 + 2] = orig[p * 4 + 2];
        bd.data[p * 4 + 3] = 255;
      }
    }
    bgctx.putImageData(bd, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bg, 0, 0);
  }

  /** Mock AI 扩图：镜像边缘内容外扩 + 整体虚化 + 中心清晰回贴 */
  function expandCanvas(src, pct) {
    const w = src.width, h = src.height;
    const dx = Math.round((w * pct) / 100), dy = Math.round((h * pct) / 100);
    const nw = w + dx * 2, nh = h + dy * 2;
    const out = newCanvas(nw, nh);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    // 九宫格镜像填充
    for (let gy = -1; gy <= 1; gy++) {
      for (let gx = -1; gx <= 1; gx++) {
        ctx.save();
        ctx.translate(dx + gx * w, dy + gy * h);
        if (gx < 0) { ctx.translate(w, 0); ctx.scale(-1, 1); }
        if (gx > 0) { ctx.scale(-1, 1); }
        if (gy < 0) { ctx.translate(0, h); ctx.scale(1, -1); }
        if (gy > 0) { ctx.scale(1, -1); }
        ctx.drawImage(src, 0, 0);
        ctx.restore();
      }
    }
    // 整体轻微模糊，弱化镜像接缝
    const img = ctx.getImageData(0, 0, nw, nh);
    const bl = boxBlur(img.data, nw, nh, Math.max(3, Math.round(Math.min(nw, nh) / 160)));
    img.data.set(bl);
    ctx.putImageData(img, 0, 0);
    // 中心原图清晰回贴
    ctx.drawImage(src, dx, dy);
    return out;
  }

  /* ---------------- 工具注册 ---------------- */
  const R = (spec) => specs.push(spec);

  /* ---- 调色（11 参）---- */
  R({ id: 'adjust_brightness', name: '亮度', category: '调色', icon: '☀', desc: '提高或降低整体亮度', params: [{ key: 'value', label: '亮度', type: 'range', min: -100, max: 100, step: 1, default: 25 }], apply: (cv, p) => pipeline(cv, [opBrightness(p.value)]) });
  R({ id: 'adjust_contrast', name: '对比度', category: '调色', icon: '◐', desc: '增强或减弱明暗对比', params: [{ key: 'value', label: '对比度', type: 'range', min: -100, max: 100, step: 1, default: 20 }], apply: (cv, p) => pipeline(cv, [opContrast(p.value)]) });
  R({ id: 'adjust_saturation', name: '饱和度', category: '调色', icon: '❋', desc: '色彩鲜艳程度', params: [{ key: 'value', label: '饱和度', type: 'range', min: -100, max: 100, step: 1, default: 20 }], apply: (cv, p) => pipeline(cv, [opSaturation(p.value)]) });
  R({ id: 'adjust_temperature', name: '色温', category: '调色', icon: '🌡', desc: '冷暖色调（暖为正）', params: [{ key: 'value', label: '色温', type: 'range', min: -100, max: 100, step: 1, default: 20 }], apply: (cv, p) => pipeline(cv, [opTemperature(p.value)]) });
  R({ id: 'adjust_tint', name: '色调', category: '调色', icon: '🎨', desc: '绿—品红倾向', params: [{ key: 'value', label: '色调', type: 'range', min: -100, max: 100, step: 1, default: 0 }], apply: (cv, p) => pipeline(cv, [opTint(p.value)]) });
  R({ id: 'adjust_exposure', name: '曝光', category: '调色', icon: '💡', desc: '以档位调整进光量', params: [{ key: 'value', label: '曝光', type: 'range', min: -100, max: 100, step: 1, default: 15 }], apply: (cv, p) => pipeline(cv, [opExposure(p.value)]) });
  R({ id: 'adjust_shadows', name: '阴影', category: '调色', icon: '🌓', desc: '提亮或压暗暗部', params: [{ key: 'value', label: '阴影', type: 'range', min: -100, max: 100, step: 1, default: 20 }], apply: (cv, p) => pipeline(cv, [opShadows(p.value)]) });
  R({ id: 'adjust_highlights', name: '高光', category: '调色', icon: '🔆', desc: '恢复或增强亮部', params: [{ key: 'value', label: '高光', type: 'range', min: -100, max: 100, step: 1, default: 0 }], apply: (cv, p) => pipeline(cv, [opHighlights(p.value)]) });
  R({ id: 'adjust_sharpen', name: '锐化', category: '调色', icon: '📌', desc: '增强边缘清晰度', params: [{ key: 'value', label: '锐化', type: 'range', min: 0, max: 100, step: 1, default: 35 }], apply: (cv, p) => pipeline(cv, [opSharpen(p.value)]) });
  R({ id: 'adjust_vignette', name: '暗角', category: '调色', icon: '⦿', desc: '四角压暗，突出主体', params: [{ key: 'strength', label: '强度', type: 'range', min: 0, max: 100, step: 1, default: 35 }, { key: 'size', label: '范围', type: 'range', min: 0, max: 100, step: 1, default: 55 }], apply: (cv, p) => pipeline(cv, [opVignette(p.strength, p.size)]) });
  R({ id: 'adjust_grain', name: '颗粒', category: '调色', icon: '▦', desc: '添加胶片颗粒感', params: [{ key: 'value', label: '颗粒', type: 'range', min: 0, max: 100, step: 1, default: 30 }], apply: (cv, p) => pipeline(cv, [opGrain(p.value)]) });

  /* ---- 变换 ---- */
  R({ id: 'transform_crop', name: '裁剪', category: '变换', icon: '⛶', desc: '按比例居中裁剪', params: [{ key: 'ratio', label: '比例', type: 'select', default: '1:1', options: [['1:1', '1:1 方形'], ['4:3', '4:3 横向'], ['3:4', '3:4 竖向'], ['16:9', '16:9 宽屏'], ['9:16', '9:16 手机屏']] }], apply: (cv, p) => { const r = { '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16 }[p.ratio]; return cropCanvas(cv, r); } });
  R({ id: 'transform_rotate', name: '旋转', category: '变换', icon: '⟳', desc: '顺时针旋转', params: [{ key: 'deg', label: '角度', type: 'select', default: '90', options: [['90', '90°'], ['180', '180°'], ['270', '270°']] }], apply: (cv, p) => rotateCanvas(cv, Number(p.deg)) });
  R({ id: 'transform_flip_h', name: '水平翻转', category: '变换', icon: '⇋', desc: '左右镜像', params: [], apply: (cv) => flipCanvas(cv, true, false) });
  R({ id: 'transform_flip_v', name: '垂直翻转', category: '变换', icon: '⇅', desc: '上下镜像', params: [], apply: (cv) => flipCanvas(cv, false, true) });
  R({ id: 'transform_scale', name: '缩放', category: '变换', icon: '⤢', desc: '按百分比缩放画布', params: [{ key: 'pct', label: '缩放', type: 'range', min: 10, max: 200, step: 5, default: 100 }], apply: (cv, p) => scaleCanvas(cv, p.pct) });

  /* ---- 滤镜 ---- */
  R({ id: 'filter_film', name: '胶片', category: '滤镜', icon: '🎞', desc: '电影感：暖调 + 淡色 + 颗粒', params: [], apply: (cv) => pipeline(cv, [opTemperature(18), opContrast(-12), opSaturation(-12), opShadows(14), opVignette(28, 60), opGrain(26)]) });
  R({ id: 'filter_portrait', name: '人像美颜', category: '滤镜', icon: '👤', desc: '磨皮 + 亮肤 + 微暖', params: [], apply: (cv) => pipeline(cv, [opSkinSmooth(55), opBrightness(10), opTemperature(10), opSaturation(8), opSharpen(12)]) });
  R({ id: 'filter_bw', name: '黑白', category: '滤镜', icon: '⬤', desc: '去色 + 高对比', params: [], apply: (cv) => pipeline(cv, [opSaturation(-100), opContrast(16), opSharpen(18)]) });
  R({ id: 'filter_vintage', name: '复古', category: '滤镜', icon: '📻', desc: '怀旧色调 + 重暗角', params: [], apply: (cv) => pipeline(cv, [opTemperature(34), opTint(14), opSaturation(-26), opContrast(-8), opVignette(42, 48), opGrain(34)]) });
  R({ id: 'filter_cool', name: '清冷', category: '滤镜', icon: '❄', desc: '冷色调电影感', params: [], apply: (cv) => pipeline(cv, [opTemperature(-32), opContrast(10), opSaturation(6), opShadows(10)]) });
  R({ id: 'filter_warm', name: '暖阳', category: '滤镜', icon: '🌅', desc: '温暖阳光色调', params: [], apply: (cv) => pipeline(cv, [opTemperature(32), opBrightness(8), opSaturation(10), opHighlights(8)]) });

  /* ---- 智能（Mock AI 能力）---- */
  R({ id: 'smart_matting', name: '智能抠图', category: '智能', icon: '✂', desc: '边缘颜色相似度自动分割主体', params: [{ key: 'tolerance', label: '容差', type: 'range', min: 10, max: 80, step: 1, default: 42 }], apply: (cv, p) => {
      const w = cv.width, h = cv.height;
      const mask = computeBgMask(cv, p.tolerance);
      const ctx = cv.getContext('2d');
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 0; i < w * h; i++) if (mask[i]) d[i * 4 + 3] = 0;
      ctx.putImageData(img, 0, 0);
    } });
  R({ id: 'smart_replace_bg', name: 'AI 换背景', category: '智能', icon: '🖼', desc: '背景替换为 模糊/纯色/渐变', params: [
      { key: 'type', label: '方式', type: 'select', default: 'gradient', options: [['blur', '背景虚化'], ['color', '纯色'], ['gradient', '渐变场景']] },
      { key: 'color', label: '颜色', type: 'color', default: '#2980b9' },
      { key: 'preset', label: '场景', type: 'select', default: '海边', options: [['海边', '海边'], ['森林', '森林'], ['星空', '星空'], ['夕阳', '夕阳']] },
      { key: 'tolerance', label: '抠图容差', type: 'range', min: 10, max: 80, step: 1, default: 42 },
    ], apply: (cv, p) => replaceBg(cv, p) });
  R({ id: 'smart_expand', name: 'AI 扩图', category: '智能', icon: '↔', desc: '镜像边缘内容外扩画布', params: [{ key: 'pct', label: '扩展比例 %', type: 'range', min: 5, max: 60, step: 5, default: 25 }], apply: (cv, p) => expandCanvas(cv, p.pct) });
  R({ id: 'smart_superres', name: '超分辨率', category: '智能', icon: '🔍', desc: '2 倍高清放大', params: [], apply: (cv) => {
      const c = scaleCanvas(cv, 200);
      pipeline(c, [opSharpen(30)]);
      return c;
    } });

  /* ---- 画笔（局部编辑，由编辑器提供笔迹载体）---- */
  R({ id: 'brush_lighten', name: '提亮笔', category: '画笔', icon: '✨', brush: true, desc: '涂抹提亮局部', params: [{ key: 'size', label: '笔刷大小', type: 'range', min: 8, max: 200, step: 2, default: 60 }, { key: 'strength', label: '强度', type: 'range', min: 5, max: 100, step: 5, default: 40 }] });
  R({ id: 'brush_darken', name: '压暗笔', category: '画笔', icon: '🌑', brush: true, desc: '涂抹压暗局部', params: [{ key: 'size', label: '笔刷大小', type: 'range', min: 8, max: 200, step: 2, default: 60 }, { key: 'strength', label: '强度', type: 'range', min: 5, max: 100, step: 5, default: 40 }] });
  R({ id: 'brush_smooth', name: '磨皮笔', category: '画笔', icon: '🌸', brush: true, desc: '涂抹磨皮（人像）', params: [{ key: 'size', label: '笔刷大小', type: 'range', min: 8, max: 200, step: 2, default: 50 }, { key: 'strength', label: '强度', type: 'range', min: 5, max: 100, step: 5, default: 60 }], applyBrush: (img, w, h, p) => {
      const src = new Uint8ClampedArray(img.data);
      const r = Math.max(2, Math.round(p.size / 12));
      const blur = boxBlur(src, w, h, r);
      const k = (p.strength / 100) * 0.85;
      for (let i = 0; i < img.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const diff = Math.abs(src[i + c] - blur[i + c]);
          const edge = Math.min(1, diff / 24);
          const wgt = k * (1 - edge);
          img.data[i + c] = src[i + c] * (1 - wgt) + blur[i + c] * wgt;
        }
      }
    } });
  R({ id: 'brush_blur', name: '模糊笔', category: '画笔', icon: '💨', brush: true, desc: '涂抹虚化局部', params: [{ key: 'size', label: '笔刷大小', type: 'range', min: 8, max: 200, step: 2, default: 60 }, { key: 'strength', label: '强度', type: 'range', min: 5, max: 100, step: 5, default: 70 }], applyBrush: (img, w, h, p) => {
      const r = Math.max(2, Math.round((p.size / 8) * (0.5 + p.strength / 200)));
      img.data.set(boxBlur(img.data, w, h, r));
    } });
  R({ id: 'brush_restore', name: '还原笔', category: '画笔', icon: '🧽', brush: true, desc: '涂抹还原为原图', params: [{ key: 'size', label: '笔刷大小', type: 'range', min: 8, max: 200, step: 2, default: 60 }] });
  R({ id: 'brush_remove', name: '消除笔', category: '画笔', icon: '🩹', brush: true, desc: '涂抹消除物体', params: [{ key: 'size', label: '笔刷大小', type: 'range', min: 8, max: 200, step: 2, default: 60 }], applyBrush: (img, w, h, p) => {
      const r = Math.max(3, Math.round(p.size / 4));
      img.data.set(boxBlur(img.data, w, h, r));
    } });

  /* ---------------- 查询接口 ---------------- */
  function get(id) { return specs.find((s) => s.id === id); }
  function defaults(id) {
    const spec = get(id);
    const out = {};
    if (spec) for (const p of spec.params) out[p.key] = p.default;
    return out;
  }
  function byCategory() {
    const map = new Map();
    for (const s of specs) {
      if (!map.has(s.category)) map.set(s.category, []);
      map.get(s.category).push(s);
    }
    return map;
  }
  /** 参数校验（与原项目服务端校验同构） */
  function validateParams(spec, params) {
    const errs = [];
    for (const p of spec.params) {
      const v = params[p.key];
      if (v === undefined || v === null || v === '') { errs.push(`${spec.id} 缺少参数 ${p.key}`); continue; }
      if (p.type === 'range') {
        const n = Number(v);
        if (Number.isNaN(n)) errs.push(`${spec.id}.${p.key} 不是数字`);
        else if (n < p.min || n > p.max) errs.push(`${spec.id}.${p.key}=${n} 超出范围 [${p.min}, ${p.max}]`);
      }
      if (p.type === 'select' && p.options && !p.options.some((o) => o[0] === String(v))) {
        errs.push(`${spec.id}.${p.key}="${v}" 不是合法选项`);
      }
    }
    return errs;
  }

  return { specs, register: R, get, defaults, byCategory, validateParams, boxBlur, pipeline, newCanvas, copyCanvas, computeBgMask };
})();
