// 影像處理：遮罩羽化、被切走區域的補色（onion-peel 擴散填補）、形狀點陣化
const ImgProc = (() => {
  // 三次盒狀模糊 ≈ 高斯模糊
  function boxBlur(src, w, h, r) {
    r = Math.round(r);
    if (r < 1) return src;
    let a = Float32Array.from(src), b = new Float32Array(w * h);
    for (let pass = 0; pass < 3; pass++) { blurH(a, b, w, h, r); blurV(b, a, w, h, r); }
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = a[i];
    return out;
  }
  function blurH(s, d, w, h, r) {
    const k = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += s[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        d[row + x] = acc * k;
        acc += s[row + Math.min(w - 1, x + r + 1)] - s[row + Math.max(0, x - r)];
      }
    }
  }
  function blurV(s, d, w, h, r) {
    const k = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += s[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        d[y * w + x] = acc * k;
        acc += s[Math.min(h - 1, y + r + 1) * w + x] - s[Math.max(0, y - r) * w + x];
      }
    }
  }

  // 只往外柔化：邊緣外側漸淡，原本的範圍保持完整
  function outerSoft(src, w, h, r) {
    const b = boxBlur(src, w, h, r);
    if (b === src) return src;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(src[i], Math.min(255, b[i] * 2));
    return out;
  }

  // 從已知像素向 target 區域一圈一圈往內擴散平均色；known 會被更新（填過的設為 1）
  function fill(rgba, w, h, known, target, maxLayers = Infinity, layerOut = null) {
    const N = w * h;
    const queued = new Uint8Array(N);
    let front = new Int32Array(N), next = new Int32Array(N), fn = 0;
    const hasKnown = i => {
      const x = i % w;
      return (x > 0 && known[i - 1]) || (x < w - 1 && known[i + 1]) || (i >= w && known[i - w]) || (i < N - w && known[i + w]);
    };
    for (let i = 0; i < N; i++) if (target[i] && !known[i] && hasKnown(i)) { front[fn++] = i; queued[i] = 1; }
    let layer = 0;
    while (fn && layer < maxLayers) {
      const col = new Float32Array(fn * 3);
      for (let k = 0; k < fn; k++) {
        const i = front[k], x = i % w, y = (i / w) | 0;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (!known[j]) continue;
          r += rgba[j * 4]; g += rgba[j * 4 + 1]; b += rgba[j * 4 + 2]; c++;
        }
        if (c) { col[k * 3] = r / c; col[k * 3 + 1] = g / c; col[k * 3 + 2] = b / c; }
      }
      for (let k = 0; k < fn; k++) {
        const i = front[k];
        rgba[i * 4] = col[k * 3]; rgba[i * 4 + 1] = col[k * 3 + 1]; rgba[i * 4 + 2] = col[k * 3 + 2];
        known[i] = 1;
        if (layerOut) layerOut[i] = layer + 1;
      }
      let nn = 0;
      for (let k = 0; k < fn; k++) {
        const i = front[k], x = i % w;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
        for (const j of nb) {
          if (j < 0 || j >= N || queued[j] || known[j] || !target[j]) continue;
          queued[j] = 1; next[nn++] = j;
        }
      }
      [front, next] = [next, front];
      fn = nn; layer++;
    }
  }

  // 用 Canvas2D 畫形狀並取出 alpha（遮罩產生用）
  function paint(w, h, painter) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.strokeStyle = '#fff';
    g.lineCap = 'round'; g.lineJoin = 'round';
    painter(g);
    const d = g.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
    return out;
  }

  function toCanvas(rgba, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    return c;
  }

  // 到遮罩核心（>= thr）的近似歐氏距離（兩趟 chamfer）
  function distanceField(mask, w, h, thr = 128) {
    const INF = 1e9, d = new Float32Array(w * h), S2 = Math.SQRT2;
    for (let i = 0; i < d.length; i++) d[i] = mask[i] >= thr ? 0 : INF;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (!v) continue;
      if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      if (y > 0) {
        if (d[i - w] + 1 < v) v = d[i - w] + 1;
        if (x > 0 && d[i - w - 1] + S2 < v) v = d[i - w - 1] + S2;
        if (x < w - 1 && d[i - w + 1] + S2 < v) v = d[i - w + 1] + S2;
      }
      d[i] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (!v) continue;
      if (x < w - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      if (y < h - 1) {
        if (d[i + w] + 1 < v) v = d[i + w] + 1;
        if (x < w - 1 && d[i + w + 1] + S2 < v) v = d[i + w + 1] + S2;
        if (x > 0 && d[i + w - 1] + S2 < v) v = d[i + w - 1] + S2;
      }
      d[i] = v;
    }
    return d;
  }

  // 依仿射矩陣重新取樣遮罩（inv：新座標 → 舊座標）
  function resample(src, w, h, inv) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.round(inv[0] * x + inv[2] * y + inv[4]), sy = Math.round(inv[1] * x + inv[3] * y + inv[5]);
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) out[y * w + x] = src[sy * w + sx];
    }
    return out;
  }

  return { boxBlur, outerSoft, fill, paint, toCanvas, distanceField, resample };
})();
