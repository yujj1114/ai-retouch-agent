/* ============================================================
 * samples.js — 示例素材与 Mock 文生图
 * 原项目此处为 DashScope 文生图 + SSE 推送；
 * 复刻版用程序生成（种子随机 + 渐变 + 分形山脊），
 * 保证零依赖、零 Key 也能完整体验「生成 → 修图」链路。
 * ============================================================ */
window.RA = window.RA || {};
RA.Samples = (function () {
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const lerp = (a, b, t) => a + (b - a) * t;

  /** 分形山脊线 */
  function ridge(rand, w, baseY, amp, roughness) {
    const pts = [];
    const n = 9;
    for (let i = 0; i <= n; i++) pts.push({ x: (i / n) * w, y: baseY - rand() * amp });
    for (let it = 0; it < 5; it++) {
      const next = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        next.push(p);
        next.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 + (rand() - 0.5) * amp * roughness });
      }
      next.push(pts[pts.length - 1]);
      pts.length = 0;
      pts.push(...next);
      roughness *= 0.55;
    }
    return pts;
  }
  function drawRidge(ctx, pts, w, h, color) {
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** 示例图 1：山间晨曦 */
  function drawMountain(ctx, w, h, rand) {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#1a2a6c'); sky.addColorStop(0.45, '#b21f66'); sky.addColorStop(0.75, '#fd9a45'); sky.addColorStop(1, '#ffd89b');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    // 太阳
    const sx = w * (0.3 + rand() * 0.4), sy = h * 0.52;
    const sun = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.22);
    sun.addColorStop(0, 'rgba(255,246,214,.95)'); sun.addColorStop(0.25, 'rgba(255,214,140,.55)'); sun.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, w, h);
    // 三层山脊（前深后浅）
    drawRidge(ctx, ridge(rand, w, h * 0.62, h * 0.16, 0.9), w, h, 'rgba(70,60,110,.55)');
    drawRidge(ctx, ridge(rand, w, h * 0.74, h * 0.2, 0.8), w, h, 'rgba(46,40,78,.75)');
    drawRidge(ctx, ridge(rand, w, h * 0.9, h * 0.22, 0.7), w, h, '#221d3d');
    // 飞鸟
    ctx.strokeStyle = 'rgba(30,25,50,.8)'; ctx.lineWidth = Math.max(1.5, w / 400);
    for (let i = 0; i < 5; i++) {
      const bx = w * (0.15 + rand() * 0.7), by = h * (0.18 + rand() * 0.2), s = w * 0.012;
      ctx.beginPath();
      ctx.moveTo(bx - s, by); ctx.quadraticCurveTo(bx - s / 2, by - s / 2, bx, by);
      ctx.quadraticCurveTo(bx + s / 2, by - s / 2, bx + s, by);
      ctx.stroke();
    }
    addGrain(ctx, w, h, rand, 10);
  }

  /** 示例图 2：日落海湾 */
  function drawBay(ctx, w, h, rand) {
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.55);
    sky.addColorStop(0, '#0f2027'); sky.addColorStop(0.6, '#ec6f66'); sky.addColorStop(1, '#ffc371');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h * 0.55);
    // 海面
    const sea = ctx.createLinearGradient(0, h * 0.55, 0, h);
    sea.addColorStop(0, '#c96a52'); sea.addColorStop(0.3, '#5b3a6e'); sea.addColorStop(1, '#131a2e');
    ctx.fillStyle = sea; ctx.fillRect(0, h * 0.55, w, h * 0.45);
    // 太阳倒影
    const sx = w * 0.5;
    for (let y = h * 0.55; y < h; y += 6) {
      const t = (y - h * 0.55) / (h * 0.45);
      const rw = w * (0.03 + t * 0.1) * (0.7 + rand() * 0.6);
      ctx.fillStyle = `rgba(255,200,130,${0.35 * (1 - t * 0.6)})`;
      ctx.fillRect(sx - rw / 2, y, rw, 3);
    }
    // 太阳
    const sun = ctx.createRadialGradient(sx, h * 0.5, 0, sx, h * 0.5, h * 0.16);
    sun.addColorStop(0, 'rgba(255,240,200,1)'); sun.addColorStop(1, 'rgba(255,180,110,0)');
    ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(sx, h * 0.5, h * 0.16, 0, Math.PI * 2); ctx.fill();
    // 海浪线
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const y = h * (0.58 + i * 0.055);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) ctx.lineTo(x, y + Math.sin(x * 0.02 + i) * 3);
      ctx.stroke();
    }
    addGrain(ctx, w, h, rand, 8);
  }

  /** 示例图 3：人像剪影（适合抠图/换背景/磨皮演示） */
  function drawPortrait(ctx, w, h, rand) {
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.38, h * 0.05, w * 0.5, h * 0.5, h * 0.85);
    bg.addColorStop(0, '#5b7bab'); bg.addColorStop(0.55, '#33465f'); bg.addColorStop(1, '#1a2233');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    // 主体：头 + 肩（纯色剪影，边缘干净，方便 Mock 抠图）
    const cx = w * 0.5, headR = h * 0.17, headY = h * 0.36;
    ctx.fillStyle = '#e8b48c';
    ctx.beginPath(); ctx.arc(cx, headY, headR, 0, Math.PI * 2); ctx.fill();
    // 脖子
    ctx.fillRect(cx - headR * 0.32, headY + headR * 0.7, headR * 0.64, headR * 0.8);
    // 肩膀
    ctx.beginPath();
    ctx.moveTo(cx - headR * 2.1, h);
    ctx.quadraticCurveTo(cx - headR * 1.7, headY + headR * 1.5, cx, headY + headR * 1.45);
    ctx.quadraticCurveTo(cx + headR * 1.7, headY + headR * 1.5, cx + headR * 2.1, h);
    ctx.closePath();
    ctx.fillStyle = '#3f5a7a'; ctx.fill();
    // 轮廓光
    ctx.strokeStyle = 'rgba(255,220,180,.5)'; ctx.lineWidth = Math.max(2, w / 260);
    ctx.beginPath(); ctx.arc(cx, headY, headR, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    // 简单五官
    ctx.fillStyle = 'rgba(40,30,30,.85)';
    ctx.beginPath(); ctx.ellipse(cx - headR * 0.36, headY - headR * 0.1, headR * 0.09, headR * 0.06, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + headR * 0.36, headY - headR * 0.1, headR * 0.09, headR * 0.06, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(40,30,30,.7)'; ctx.lineWidth = Math.max(1.5, w / 400);
    ctx.beginPath(); ctx.arc(cx, headY + headR * 0.12, headR * 0.3, 0.25 * Math.PI, 0.75 * Math.PI); ctx.stroke();
    addGrain(ctx, w, h, rand, 6);
  }

  function addGrain(ctx, w, h, rand, amount) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * amount;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Mock 文生图：提示词 → 4 张候选程序画 */
  function generate(prompt, size = 420) {
    const seed = hashStr(prompt || 'default');
    const scenes = [
      { name: '候选 A · 晨曦山脊', fn: drawMountain, pal: 'warm' },
      { name: '候选 B · ' + (prompt || '意境'), fn: drawBay, pal: 'sunset' },
      { name: '候选 C · 人像光影', fn: drawPortrait, pal: 'cool' },
      { name: '候选 D · ' + (prompt || '想象'), fn: drawMountain, pal: 'cool' },
    ];
    return scenes.map((s, i) => {
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      const rand = mulberry32(seed + i * 977);
      if (i === 3) {
        // 变体：冷色调山景
        ctx.save();
        s.fn(ctx, size, size, rand);
        const img = ctx.getImageData(0, 0, size, size);
        const d = img.data;
        for (let p = 0; p < d.length; p += 4) {
          const r = d[p], g = d[p + 1], b = d[p + 2];
          d[p] = lerp(r, b * 0.9 + 20, 0.45);
          d[p + 1] = lerp(g, (r + b) / 2 * 0.95, 0.3);
          d[p + 2] = lerp(b, Math.min(255, b * 1.15 + 25), 0.5);
        }
        ctx.putImageData(img, 0, 0);
        ctx.restore();
      } else {
        s.fn(ctx, size, size, rand);
      }
      return { canvas: c, name: s.name };
    });
  }

  /** 三张固定示例图 */
  function sample(index, w = 900, h = 620) {
    const fns = [drawMountain, drawBay, drawPortrait];
    const names = ['山间晨曦', '日落海湾', '人像剪影'];
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    fns[index](ctx, w, h, mulberry32(1234 + index * 77));
    return { canvas: c, name: names[index] };
  }

  return { generate, sample };
})();
