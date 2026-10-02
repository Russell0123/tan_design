'use strict';
// ---------- 眨眼 ----------
// 設定放在眼睛圖層：n.blink = { on, closedId, lidId, lidColor, line, lash, low, style }
//   closedId：閉眼差分圖層（選用；沒有時把上睫毛壓成一條線當閉眼）
//   lidId / lidColor：遮擋（選用；底下的圖原本畫著眼睛時才需要）— 圖層，或用底色填滿眼睛範圍
//   line：沒有閉眼圖時，閉合線在眼睛高度的哪裡（0 上 … 1 下）；lash：上睫毛厚度（佔上半部的比例）；low：下眼瞼上移多少
// 眨眼事件 = 關鍵影格軌道 n.keys.blink = [[u, 強度, 樣式], …]（u 同其他影格：整條時間軸的位置；增加循環時會一起複製）
// 閉合程度 0 … 1 預先算成 LEVELS 張圖，放在差分之後的貼圖欄位
const Blink = (() => {
  const LEVELS = 10;
  // 樣式：長度以「幀」為單位（時間軸上的橫條可以拉長縮短，範圍 min … max）；三種的動作不同
  //   一般：很快閉上、停一下、稍慢張開；慢眨（新增的預設）：眼皮沉重，閉上與張開都慢慢的；瞇眼：只閉到一半多，瞇上與張開都拉長
  const STYLES = {
    normal: { label: '一般', def: 4, min: 2, max: 6 },
    slow:   { label: '慢眨', def: 11, min: 6, max: 24 },
    squint: { label: '瞇眼', def: 18, min: 10, max: 36 },
  };
  const styleOf = st => STYLES[st] ? st : 'normal';   // 舊版的「快速」「連眨」→ 一般
  const clampDur = (st, d) => { const S = STYLES[styleOf(st)]; return Math.max(S.min, Math.min(S.max, Math.round(d ?? S.def))); };
  const durOf = (st, d) => clampDur(st, d);
  const ss = q => q * q * (3 - 2 * q);
  // q = 0 … 1（這次眨眼的進度）→ 閉合程度
  function shape(st, q) {
    if (q <= 0 || q >= 1) return 0;
    if (st === 'slow') return q < 0.4 ? ss(q / 0.4) : q < 0.6 ? 1 : ss(1 - (q - 0.6) / 0.4);
    if (st === 'squint') return 0.55 * (q < 0.35 ? ss(q / 0.35) : q < 0.65 ? 1 : ss(1 - (q - 0.65) / 0.35));   // 瞇眼：慢慢瞇、慢慢張開
    return q < 0.35 ? Math.pow(q / 0.35, 1.5) : q <= 0.5 ? 1 : Math.pow(1 - (q - 0.5) / 0.5, 1.6);
  }
  // 時間 t（幀）的閉合程度 0 … 1；眨眼事件 = n.keys.blink = [[u, 強度, 樣式, 幀數], …]
  function at(data, n, t) {
    const B = n.blink;
    if (!B || !B.on) return 0;
    const ks = n.keys && n.keys.blink;
    if (!ks || !ks.length) return 0;
    const T = Model.totalOf(data);
    let v = 0;
    for (const [u, k, st0, d] of ks) {
      const st = styleOf(st0), dur = clampDur(st, d);
      let dt = t - Math.round(u * T);   // 對齊到最近的一幀
      dt -= Math.floor(dt / T) * T;   // 循環：尾端的眨眼接到開頭
      v = Math.max(v, shape(st, dt / dur) * (k ?? 1));
    }
    return Math.min(1, v);
  }
  // ---------- 閉眼公版（沒有閉眼差分時淡入）----------
  // 公版 = 畫面左側那隻眼睛（角色的右眼）閉起來的睫毛線；右側那隻水平翻轉
  let TPL = null;
  function setTemplate(c) {
    const w = c.width, h = c.height, px = c.getContext('2d').getImageData(0, 0, w, h).data, cov = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) { const l = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3; cov[i] = px[i * 4 + 3] / 255 * Math.max(0, Math.min(1, (200 - l) / 120)); }
    // 每一欄：最粗那段（睫毛線本體）的中心與厚度；上方的雙眼皮細線跟著平移
    const tc = new Float32Array(w).fill(NaN), tk = new Float32Array(w);
    let bx0 = w, bx1 = -1, maxT = 1;
    for (let x = 0; x < w; x++) {
      let best = null, st = -1;
      for (let y = 0; y <= h; y++) {
        const on = y < h && cov[y * w + x] > 0.5;
        if (on && st < 0) st = y;
        if (!on && st >= 0) { if (!best || y - st > best[1] - best[0]) best = [st, y]; st = -1; }
      }
      if (best && best[1] - best[0] >= 2) { tc[x] = (best[0] + best[1]) / 2; tk[x] = best[1] - best[0]; maxT = Math.max(maxT, tk[x]); if (x < bx0) bx0 = x; bx1 = x; }
    }
    // 沒有本體的欄（兩端）用最近的中心
    for (let x = bx0; x <= bx1; x++) if (isNaN(tc[x])) { let k = 1; while (isNaN(tc[x - k]) && isNaN(tc[x + k]) && k < w) k++; tc[x] = isNaN(tc[x - k]) ? tc[x + k] : tc[x - k]; }
    TPL = bx1 > bx0 ? { w, h, cov, tc, bx0, bx1, maxT } : null;
  }
  // 依眼睛的閉合線、寬度、頭尾把公版變形成閉眼圖（eye 座標的 RGBA）
  // 依閉合線、寬度、頭尾把公版變形成「一隻眼睛」的閉眼圖（eye 座標的 RGBA）；flip = 水平翻轉（畫面右側那隻）
  function synthClosed(eye, w, h, cols, C0, lashT, flip, T0) {
    if (!TPL || !cols.length) return null;
    // 只用最寬的一段欄（雜點不算）
    const groups = [];
    let g = null, prev = -99;
    for (const x of cols) { if (x - prev > 3) { g = [x, x]; groups.push(g); } else g[1] = x; prev = x; }
    const [xa, xb] = groups.reduce((p, q) => (q[1] - q[0] > p[1] - p[0] ? q : p));
    // 線稿顏色：眼睛裡最暗的 10% 像素的中位數
    const dk = [];
    for (let i = 0; i < w * h; i++) if (eye[i * 4 + 3] > 200) dk.push(i);
    dk.sort((a, b) => (eye[a * 4] + eye[a * 4 + 1] + eye[a * 4 + 2]) - (eye[b * 4] + eye[b * 4 + 1] + eye[b * 4 + 2]));
    const dark = dk.slice(0, Math.max(1, Math.round(dk.length * 0.1)));
    const med = k => { const v = dark.map(i => eye[i * 4 + k]).sort((a, b) => a - b); return v[v.length >> 1] ?? 40; };
    let col = [med(0), med(1), med(2)];
    // 改用上眼皮（睫毛帶）的顏色：取該帶像素中偏暗的 30% 位置，不用最黑的線稿色
    if (T0) {
      const lum = i => eye[i * 4] + eye[i * 4 + 1] + eye[i * 4 + 2], band = [];
      for (let x = xa; x <= xb; x++) {
        if (isNaN(T0[x]) || isNaN(C0[x])) continue;
        const y0 = Math.max(0, Math.floor(T0[x])), y1 = Math.min(h - 1, Math.ceil(T0[x] + Math.max(2, lashT[x] * 1.2)));
        for (let y = y0; y <= y1; y++) { const i = y * w + x; if (eye[i * 4 + 3] > 200) band.push(i); }
      }
      if (band.length >= 6) {
        band.sort((a, b) => lum(a) - lum(b));
        const pick = band.slice(Math.floor(band.length * 0.2), Math.ceil(band.length * 0.4) + 1);
        const m = k => { const v = pick.map(i => eye[i * 4 + k]).sort((a, b) => a - b); return v[v.length >> 1]; };
        col = [m(0), m(1), m(2)];
      }
    }
    const out = new Uint8ClampedArray(w * h * 4), span = Math.max(1, xb - xa);
    for (let x = xa; x <= xb; x++) {
      if (isNaN(C0[x])) continue;
      let u = (x - xa) / span; if (flip) u = 1 - u;
      const tx = Math.round(TPL.bx0 + u * (TPL.bx1 - TPL.bx0)), tcx = TPL.tc[tx];
      if (isNaN(tcx)) continue;
      const sv = Math.max(1.5, lashT[x] * 0.9) / TPL.maxT;   // 公版 1px → 眼睛幾 px（線的粗細 ≈ 上睫毛帶）
      for (let y = 0; y < h; y++) {
        const ty = tcx + (y + 0.5 - C0[x]) / sv, y0 = Math.floor(ty), f = ty - y0;
        if (y0 < 0 || y0 + 1 >= TPL.h) continue;
        const a = TPL.cov[y0 * TPL.w + tx] * (1 - f) + TPL.cov[(y0 + 1) * TPL.w + tx] * f;
        if (a <= 0.01) continue;
        const o = (y * w + x) * 4;
        out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = Math.round(a * 255);
      }
    }
    return out;
  }
  // 眼睛本體的欄：高度夠的欄（細線、髮絲、臉的輪廓線這種只有一條線的欄不算），取最長的一段；
  // 閉合線用二次曲線擬合，平滑、不會被雜點拉歪
  function mainLine(G) {
    const hs = G.cols.map(x => G.B0[x] - G.T0[x]).sort((a, b) => a - b), med = hs[hs.length >> 1] || 1;
    const ok = G.cols.filter(x => G.B0[x] - G.T0[x] >= med * 0.45);
    if (ok.length < 3) return { cols: G.cols, C0: G.C0 };
    let best = [ok[0], ok[0]], cur = [ok[0], ok[0]];
    for (let k = 1; k < ok.length; k++) { if (ok[k] - ok[k - 1] <= 3) cur[1] = ok[k]; else cur = [ok[k], ok[k]]; if (cur[1] - cur[0] > best[1] - best[0]) best = [cur[0], cur[1]]; }
    const cols = ok.filter(x => x >= best[0] && x <= best[1]);
    // 二次擬合 y = a + b u + c u²（u 以中心為 0）
    const xm = (best[0] + best[1]) / 2;
    let S = [0, 0, 0, 0, 0], T = [0, 0, 0];
    for (const x of cols) { const u = x - xm, y = G.C0[x], p = [1, u, u * u, u * u * u, u * u * u * u]; for (let i = 0; i < 5; i++) S[i] += p[i]; T[0] += y; T[1] += y * u; T[2] += y * u * u; }
    const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
    const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const d = det(M);
    const C0 = new Float32Array(G.C0);
    if (Math.abs(d) > 1e-9) {
      const solve = i => det(M.map((row, r) => row.map((v, c) => (c === i ? T[r] : v)))) / d;
      const a = solve(0), b = solve(1), c = solve(2);
      for (const x of cols) { const u = x - xm; C0[x] = Math.max(G.T0[x] + 1, Math.min(G.B0[x] - 0.5, a + b * u + c * u * u)); }
    }
    return { cols, C0 };
  }
  // ---------- 旋轉 / 分眼睛的共用工具 ----------
  const sizeRot = (w, h, ang) => { const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang)); return [Math.ceil(w * c + h * s) + 2, Math.ceil(w * s + h * c) + 2]; };
  // RGBA 轉正（-ang）→ 回傳 [資料, W, H]
  function rotIn(arr, w, h, ang) {
    if (!arr) return null;
    const [W, H] = sizeRot(w, h, ang);
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(arr), w, h), 0, 0);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.translate(W / 2, H / 2); g.rotate(-ang); g.translate(-w / 2, -h / 2); g.drawImage(src, 0, 0);
    return g.getImageData(0, 0, W, H).data;
  }
  // 轉正後的 canvas 轉回原本角度（w × h）
  function rotOut(cv, w, h, ang) {
    const o = document.createElement('canvas'); o.width = w; o.height = h;
    const g = o.getContext('2d');
    g.translate(w / 2, h / 2); g.rotate(ang); g.translate(-cv.width / 2, -cv.height / 2); g.drawImage(cv, 0, 0);
    return o;
  }
  // 只留 x0 … x1 的欄（一隻眼睛）
  function cut(arr, w, h, x0, x1) {
    if (!arr) return null;
    const out = new Uint8ClampedArray(arr);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < x0 || x > x1) out[(y * w + x) * 4 + 3] = 0;
    return out;
  }
  // 以角度 ang 閉眼時，閉合線在原圖座標的角度（度）
  function closureAngle(eye, w, h, B, ang) {
    const [W, H] = sizeRot(w, h, ang), e2 = Math.abs(ang) < 1e-4 ? eye : rotIn(eye, w, h, ang), Ww = Math.abs(ang) < 1e-4 ? w : W, Hh = Math.abs(ang) < 1e-4 ? h : H;
    const G0 = geom(e2, null, Ww, Hh, B);
    if (!G0 || G0.cols.length < 4) return null;
    const G = mainLine(G0);
    const c = Math.cos(ang), s = Math.sin(ang);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const x of G.cols) {
      const qx = x + 0.5 - Ww / 2, qy = G.C0[x] - Hh / 2;
      const px = c * qx - s * qy, py = s * qx + c * qy;   // 轉回原圖（相對中心）
      n++; sx += px; sy += py; sxx += px * px; sxy += px * py;
    }
    const k = (n * sxy - sx * sy) / Math.max(1e-6, n * sxx - sx * sx);
    return Math.atan(k) * 180 / Math.PI;
  }
  // 自動傾斜：找讓「閉起來的線」跟兩眼連線（target，度）平行的角度（每隻眼睛各自找）
  function autoAngle(eye, w, h, B, target) {
    let best = 0, bd = Infinity;
    const tryA = deg => { const a = closureAngle(eye, w, h, B, deg * Math.PI / 180); if (a == null) return; const d = Math.abs(a - target); if (d < bd) { bd = d; best = deg; } };
    for (let d = -40; d <= 40; d += 4) tryA(d);
    const b0 = best;
    for (let d = b0 - 3; d <= b0 + 3; d += 1) tryA(d);
    return best;
  }
  // 分眼睛各自用自己的角度閉（parts = [{ x0, x1, ang }]）
  function buildParts(eye, closed, w, h, B, parts) {
    if (!parts || parts.length <= 1) return buildTilted(eye, closed, null, w, h, B, 0, parts && parts[0] ? parts[0].ang : 0);
    const outs = parts.map(p => buildTilted(cut(eye, w, h, p.x0, p.x1), cut(closed, w, h, p.x0, p.x1), null, w, h, B, 0, p.ang)).filter(Boolean);
    if (!outs.length) return null;
    return outs[0].map((_, k) => {
      const o = document.createElement('canvas'); o.width = w; o.height = h;
      const g = o.getContext('2d');
      for (const lv of outs) g.drawImage(lv[k], 0, 0);
      return o;
    });
  }
  // 用公版做出閉眼圖（整個眼睛圖層大小的 RGBA）：每隻眼睛依自己的角度、閉合線、寬度變形；畫面右側那隻翻轉
  function templateClosed(eye, w, h, B, parts, midFrac) {
    if (!TPL) return null;
    const lash = B.lash ?? 0.4, out = new Uint8ClampedArray(w * h * 4);
    const list = parts && parts.length ? parts : [{ x0: 0, x1: w - 1, ang: 0 }];
    list.forEach((p, i) => {
      const flip = list.length >= 2 ? i === list.length - 1 : (p.x0 + p.x1) / 2 > (midFrac ?? 0.5) * w;
      const e1 = cut(eye, w, h, p.x0, p.x1), rot = Math.abs(p.ang) > 1e-4;
      const [W, H] = rot ? sizeRot(w, h, p.ang) : [w, h], e2 = rot ? rotIn(e1, w, h, p.ang) : e1;
      const G0 = geom(e2, null, W, H, B);
      if (!G0) return;
      const G = mainLine(G0);
      const lashT = new Float32Array(W);
      for (const x of G.cols) lashT[x] = Math.max(1, (G.C0[x] - G0.T0[x]) * lash);
      const syn = synthClosed(e2, W, H, G.cols, G.C0, lashT, flip, G0.T0);
      if (!syn) return;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      cv.getContext('2d').putImageData(new ImageData(syn, W, H), 0, 0);
      const back = rot ? rotOut(cv, w, h, p.ang) : cv, px = back.getContext('2d').getImageData(0, 0, w, h).data;
      for (let k = 0; k < w * h; k++) if (px[k * 4 + 3] > out[k * 4 + 3]) { out[k * 4] = px[k * 4]; out[k * 4 + 1] = px[k * 4 + 1]; out[k * 4 + 2] = px[k * 4 + 2]; out[k * 4 + 3] = px[k * 4 + 3]; }
    });
    return out;
  }
  // 閉合程度 → 貼圖欄位（0 = 不換）
  const slotOf = (n, b) => b < 0.03 ? 0 : (n.image.variants.length + Math.max(1, Math.min(LEVELS, Math.round(b * LEVELS))));

  // ---------- 產生各閉合程度的圖 ----------
  // eye / closed / lid：同一個座標（眼睛圖層的像素）的 RGBA；回傳 LEVELS 張 canvas
  // 每一欄：眼睛上下緣（T0 / B0）與閉合線（C0）
  function geom(eye, closed, w, h, B) {
    const line = B.line ?? 0.62;
    const top = new Float32Array(w).fill(NaN), bot = new Float32Array(w).fill(NaN), cl = new Float32Array(w).fill(NaN);
    for (let x = 0; x < w; x++) {
      let t = -1, b = -1, sw = 0, sy = 0;
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (eye[i * 4 + 3] > 60) { if (t < 0) t = y; b = y + 1; }
        if (closed) { const a = closed[i * 4 + 3]; if (a > 40) { sw += a; sy += a * (y + 0.5); } }
      }
      if (t >= 0) { top[x] = t; bot[x] = b; }
      if (sw > 200) cl[x] = sy / sw;
    }
    const cols = [];
    for (let x = 0; x < w; x++) if (!isNaN(top[x])) cols.push(x);
    if (!cols.length) return null;
    // 閉合線：有閉眼圖用它每一欄的中心；缺的欄用左右最近的值內插；沒有閉眼圖用比例
    const known = cols.filter(x => !isNaN(cl[x]));
    for (const x of cols) {
      if (!closed || known.length < 2) { cl[x] = top[x] + (bot[x] - top[x]) * line; continue; }
      if (!isNaN(cl[x])) continue;
      let L = -1, R = -1;
      for (const k of known) { if (k < x) L = k; else { R = k; break; } }
      cl[x] = L < 0 ? cl[R] : R < 0 ? cl[L] : cl[L] + (cl[R] - cl[L]) * (x - L) / (R - L);
    }
    // 平滑（避免欄與欄之間鋸齒）
    const smooth = (arr, r) => {
      const out = new Float32Array(arr);
      for (const x of cols) { let s = 0, k = 0; for (let d = -r; d <= r; d++) { const v = arr[x + d]; if (x + d >= 0 && x + d < w && !isNaN(v)) { s += v; k++; } } out[x] = s / k; }
      return out;
    };
    const T0 = smooth(top, 5), B0 = smooth(bot, 5), C0 = smooth(cl, 7);
    for (const x of cols) C0[x] = Math.max(T0[x] + 1, Math.min(B0[x] - 0.5, C0[x]));
    return { cols, top, bot, T0, B0, C0 };
  }
  function build(eye, closed, lid, w, h, B, dil = 0) {
    const N = w * h;
    const lash = B.lash ?? 0.4, low = B.low ?? 0.7;
    const G = geom(eye, closed, w, h, B);
    if (!G) return null;
    const { cols, top, bot, T0, B0, C0 } = G;
    // 每一欄的累加（預乘 alpha），用來做區間平均（壓扁時不會鋸齒）
    const pre = new Float32Array((h + 1) * 4 * w);
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b2 = 0, a = 0;
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4, al = eye[i + 3] / 255;
        r += eye[i] * al; g += eye[i + 1] * al; b2 += eye[i + 2] * al; a += al;
        const o = ((y + 1) * w + x) * 4;
        pre[o] = r; pre[o + 1] = g; pre[o + 2] = b2; pre[o + 3] = a;
      }
    }
    const P = (x, y, c) => {   // 前 y 列的累加（y 可為小數）
      if (y <= 0) return 0;
      if (y >= h) return pre[(h * w + x) * 4 + c];
      const y0 = Math.floor(y), f = y - y0, a = pre[(y0 * w + x) * 4 + c];
      return a + (pre[((y0 + 1) * w + x) * 4 + c] - a) * f;
    };
    const avg = (x, y0, y1, out) => {
      if (y1 <= 0 || y0 >= h || y1 - y0 < 1e-4) { out[0] = out[1] = out[2] = out[3] = 0; return; }
      const d = y1 - y0;
      for (let c = 0; c < 4; c++) out[c] = (P(x, y1, c) - P(x, y0, c)) / d;
    };
    // 遮擋範圍：原本眼睛的範圍（半透明的邊緣加強，蓋得住底下畫的眼睛，又不會在外圍多一圈）
    // 眼睛本體的範圍：每一欄上下緣（原始與平滑後取較寬的）；外面的柔邊（半透明、圈選時多帶到的一圈）保持原樣
    const inT = new Float32Array(w), inB = new Float32Array(w);
    for (let x = 0; x < w; x++) { inT[x] = isNaN(T0[x]) ? Infinity : Math.min(top[x], T0[x]); inB[x] = isNaN(B0[x]) ? -Infinity : Math.max(bot[x], B0[x]); }
    // 之前整張圖層都照 alpha 蓋上遮擋，柔邊會被蓋上一層淡淡的顏色 → 看起來有一圈框
    let cover = null;
    if (lid) {
      cover = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = i % w, y = (i - x) / w;
        if (dil) { cover[i] = 1; continue; }   // 自動補膚色：範圍由補色圖自己的 alpha 決定
        cover[i] = y + 0.5 < inT[x] - 1 || y + 0.5 > inB[x] + 1 ? 0 : Math.min(1, eye[i * 4 + 3] / 255 * 1.6);
      }
    }
    const smoothstep = (a, b, v) => { const q = Math.max(0, Math.min(1, (v - a) / (b - a))); return q * q * (3 - 2 * q); };
    const out = [], px = [0, 0, 0, 0];
    for (let L = 1; L <= LEVELS; L++) {
      const b = L / LEVELS;
      const img = new ImageData(w, h), D = img.data;
      const eyeA = closed ? 1 - smoothstep(0.8, 1, b) : 1;   // 有閉眼圖：最後換成閉眼圖
      const cA = closed ? smoothstep(0.55, 0.92, b) : 0;
      const lidA = Math.min(1, b * 3);
      for (let x = 0; x < w; x++) {
        const has = !isNaN(T0[x]);
        const t = T0[x], c = C0[x], bt = B0[x];
        const T = Math.max(1, (c - t) * lash);                 // 上睫毛帶的厚度
        const minT = closed ? 0 : Math.max(1.5, T * 0.45);      // 沒閉眼圖：睫毛壓到這麼細就停
        const e = has ? Math.min(t + (c - t) * b, c - minT) : 0;   // 上眼瞼（睫毛上緣）目前的位置
        const lw = low + (1 - low) * smoothstep(0.55, 1, b);    // 快閉上時下半部一定收乾淨
        const sL = 1 - lw * Math.pow(b, 1.3);                   // 下半部的高度比例
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          let r = 0, g = 0, bb = 0, a = 0;
          // 遮擋（最底層）
          if (cover && cover[y * w + x] > 0) {
            const m = cover[y * w + x] * lidA * lid[i + 3] / 255;
            r = lid[i] * m; g = lid[i + 1] * m; bb = lid[i + 2] * m; a = m;
          }
          // 沒有眼睛本體的欄（只有外圍柔邊）：原樣保留，眨眼時不會忽隱忽現
          if (!has && eyeA > 0 && eye[i + 3]) {
            const pa = eye[i + 3] / 255 * eyeA;
            r = eye[i] * pa + r * (1 - pa); g = eye[i + 1] * pa + g * (1 - pa); bb = eye[i + 2] * pa + bb * (1 - pa); a = pa + a * (1 - pa);
          }
          // 眼睛
          if (has && eyeA > 0) {
            const y0 = y, y1 = y + 1, ym = y + 0.5;
            let s0 = NaN, s1 = NaN;
            if (ym < inT[x] || ym > inB[x]) { s0 = y0; s1 = y1; }   // 本體外面的柔邊：不動
            else if (ym < c) {
              if (e + T <= c) {
                // 睫毛帶整條往下移；底下的眼珠跟著往閉合線收（連續，不會有切線）
                if (ym < e + T) { s0 = y0 - (e - t); s1 = y1 - (e - t); }
                else { const k = (c - t - T) / Math.max(1e-3, c - e - T); s0 = t + T + (y0 - e - T) * k; s1 = t + T + (y1 - e - T) * k; }
              } else if (ym >= e) {
                // 睫毛帶碰到閉合線：壓扁
                const k = T / Math.max(1e-3, c - e);
                s0 = t + (y0 - e) * k; s1 = t + (y1 - e) * k;
              } else { s0 = y0 - (e - t); s1 = y1 - (e - t); }
            } else if (sL > 0.02) {
              s0 = c + (y0 - c) / sL; s1 = c + (y1 - c) / sL;
            }
            if (!isNaN(s0)) {
              avg(x, Math.max(0, s0), Math.min(h, s1), px);
              const k = eyeA;
              const pa = px[3] * k;
              r = px[0] * k + r * (1 - pa); g = px[1] * k + g * (1 - pa); bb = px[2] * k + bb * (1 - pa); a = pa + a * (1 - pa);
            }
          }
          // 閉眼圖（最上層）
          if (closed && cA > 0) {
            const m = closed[i + 3] / 255 * cA;
            if (m > 0) { r = closed[i] * m + r * (1 - m); g = closed[i + 1] * m + g * (1 - m); bb = closed[i + 2] * m + bb * (1 - m); a = m + a * (1 - m); }
          }
          if (a > 0.002) { D[i] = r / a; D[i + 1] = g / a; D[i + 2] = bb / a; D[i + 3] = a * 255; }
        }
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').putImageData(img, 0, 0);
      out.push(cv);
    }
    return out;
  }
  // 眼睛是斜的（兩眼連線不是水平）：先把圖轉正（ang = 兩眼連線的角度，弧度）再算，算完轉回原本的角度
  // 這樣閉合方向永遠垂直於兩眼連線
  function buildTilted(eye, closed, lid, w, h, B, dil, ang) {
    if (!ang || Math.abs(ang) < 0.3 * Math.PI / 180) return build(eye, closed, lid, w, h, B, dil);
    const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang));
    const W = Math.ceil(w * c + h * s) + 2, H = Math.ceil(w * s + h * c) + 2;
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    const sg = src.getContext('2d');
    const rot = arr => {
      if (!arr) return null;
      sg.clearRect(0, 0, w, h);
      sg.putImageData(new ImageData(new Uint8ClampedArray(arr), w, h), 0, 0);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      g.translate(W / 2, H / 2); g.rotate(-ang); g.translate(-w / 2, -h / 2);
      g.drawImage(src, 0, 0);
      return g.getImageData(0, 0, W, H).data;
    };
    const outs = build(rot(eye), rot(closed), rot(lid), W, H, B, dil);
    if (!outs) return null;
    return outs.map(cv => {
      const o = document.createElement('canvas'); o.width = w; o.height = h;
      const g = o.getContext('2d');
      g.translate(w / 2, h / 2); g.rotate(ang); g.translate(-W / 2, -H / 2);
      g.drawImage(cv, 0, 0);
      return o;
    });
  }
  return { LEVELS, STYLES, styleOf, clampDur, durOf, at, slotOf, build, buildTilted, buildParts, autoAngle, templateClosed, setTemplate, get hasTemplate() { return !!TPL; } };
})();
