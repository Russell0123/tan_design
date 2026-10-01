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
  // 閉合程度 → 貼圖欄位（0 = 不換）
  const slotOf = (n, b) => b < 0.03 ? 0 : (n.image.variants.length + Math.max(1, Math.min(LEVELS, Math.round(b * LEVELS))));

  // ---------- 產生各閉合程度的圖 ----------
  // eye / closed / lid：同一個座標（眼睛圖層的像素）的 RGBA；回傳 LEVELS 張 canvas
  function build(eye, closed, lid, w, h, B, dil = 0) {
    const N = w * h;
    const lash = B.lash ?? 0.4, low = B.low ?? 0.7, line = B.line ?? 0.62;
    // 每一欄：眼睛上下緣、閉合線
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
    let cover = null;
    if (lid) {
      cover = new Float32Array(N);
      for (let i = 0; i < N; i++) cover[i] = dil ? 1 : Math.min(1, eye[i * 4 + 3] / 255 * 1.6);   // 自動補膚色：範圍由補色圖自己的 alpha 決定
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
          // 眼睛
          if (has && eyeA > 0) {
            const y0 = y, y1 = y + 1, ym = y + 0.5;
            let s0 = NaN, s1 = NaN;
            if (ym < c) {
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
  return { LEVELS, STYLES, styleOf, clampDur, durOf, at, slotOf, build, buildTilted };
})();
