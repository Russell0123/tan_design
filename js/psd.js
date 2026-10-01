// PSD 讀取（8 位元 RGB / 灰階；圖層、群組、顯示狀態、不透明度、Unicode 名稱）
// 支援未壓縮、RLE（PackBits）與 ZIP 壓縮的圖層資料。混合模式、圖層效果、遮罩不處理。
const PSD = (() => {
  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(out);
  }

  function unpackBits(src, s, e, out, o, len) {
    const end = o + len;
    let i = s;
    while (o < end && i < e) {
      let n = src[i++];
      if (n > 127) n -= 256;
      if (n >= 0) { for (let k = 0; k <= n && o < end; k++) out[o++] = src[i++]; }
      else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n && o < end; k++) out[o++] = v; }
    }
  }

  async function decodeChannel(comp, u8, dv, p, end, w, h) {
    const out = new Uint8Array(w * h);
    if (comp === 0) out.set(u8.subarray(p, p + w * h));
    else if (comp === 1) {
      const lens = [];
      for (let y = 0; y < h; y++) lens.push(dv.getUint16(p + y * 2));
      let q = p + h * 2;
      for (let y = 0; y < h; y++) { unpackBits(u8, q, q + lens[y], out, y * w, w); q += lens[y]; }
    } else if (comp === 2 || comp === 3) {
      const raw = await inflate(u8.subarray(p, end));
      out.set(raw.subarray(0, w * h));
      if (comp === 3) for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) out[y * w + x] = (out[y * w + x] + out[y * w + x - 1]) & 255;
    } else throw new Error('不支援的 PSD 壓縮格式');
    return out;
  }

  async function parse(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let p = 0;
    const r8 = () => dv.getUint8(p++);
    const r16 = () => { const v = dv.getUint16(p); p += 2; return v; };
    const i16 = () => { const v = dv.getInt16(p); p += 2; return v; };
    const r32 = () => { const v = dv.getUint32(p); p += 4; return v; };
    const i32 = () => { const v = dv.getInt32(p); p += 4; return v; };
    const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[p + i]); p += n; return s; };

    if (str(4) !== '8BPS') throw new Error('不是 PSD 檔');
    if (r16() !== 1) throw new Error('不支援 PSB（大型文件）格式');
    p += 6;
    const nch = r16();
    const H = r32(), W = r32(), depth = r16(), mode = r16();
    if (depth !== 8) throw new Error('只支援 8 位元色彩深度的 PSD');
    if (mode !== 3 && mode !== 1) throw new Error('只支援 RGB 或灰階模式的 PSD');
    { const _n = r32(); p += _n; }              // color mode data
    { const _n = r32(); p += _n; }              // image resources
    const lmLen = r32(), lmStart = p;
    if (!lmLen) throw new Error('這個 PSD 沒有圖層（只有合併影像）');
    const liLen = r32();
    if (!liLen) throw new Error('這個 PSD 沒有圖層（只有合併影像）');
    const count = Math.abs(i16());
    const recs = [];
    for (let i = 0; i < count; i++) {
      const top = i32(), left = i32(), bottom = i32(), right = i32();
      const cn = r16(), chans = [];
      for (let c = 0; c < cn; c++) chans.push({ id: i16(), len: r32() });
      str(4); const blend = str(4);
      const opacity = r8(); const clip = r8(); const flags = r8(); r8();
      const exEnd = p + 4 + r32();
      { const _n = r32(); p += _n; }            // layer mask data
      { const _n = r32(); p += _n; }            // blending ranges
      const nl = r8();
      let name = str(nl);
      p += (4 - ((nl + 1) % 4)) % 4;
      let section = 0;
      while (p + 12 <= exEnd) {
        const sig = str(4);
        if (sig !== '8BIM' && sig !== '8B64') break;
        const key = str(4), len = r32(), start = p;
        if (key === 'luni') {
          const n = dv.getUint32(p);
          let s = '';
          for (let k = 0; k < n; k++) s += String.fromCharCode(dv.getUint16(p + 4 + k * 2));
          name = s.replace(/\0+$/, '');
        } else if (key === 'lsct' || key === 'lsdk') section = dv.getUint32(p);
        p = start + len + (len % 2);
      }
      p = exEnd;
      recs.push({ top, left, w: right - left, h: bottom - top, chans, opacity, hidden: !!(flags & 2), name, section, blend, clip: clip === 1 });
    }
    for (const r of recs) {
      r.data = {};
      for (const ch of r.chans) {
        const end = p + ch.len;
        if (ch.len >= 2 && ch.id >= -1 && r.w > 0 && r.h > 0) {
          const comp = dv.getUint16(p);
          r.data[ch.id] = await decodeChannel(comp, u8, dv, p + 2, end, r.w, r.h);
        }
        p = end;
      }
    }

    // 轉成影像，並依群組建立樹（檔案順序：由下往上）
    const toCanvas = r => {
      if (r.w <= 0 || r.h <= 0 || !r.data[0]) return null;
      const c = document.createElement('canvas');
      c.width = r.w; c.height = r.h;
      const im = c.getContext('2d').createImageData(r.w, r.h), d = im.data;
      const R = r.data[0], G = mode === 1 ? r.data[0] : r.data[1] || r.data[0], B = mode === 1 ? r.data[0] : r.data[2] || r.data[0], A = r.data[-1];
      const op = r.opacity / 255;
      for (let i = 0; i < r.w * r.h; i++) {
        d[i * 4] = R[i]; d[i * 4 + 1] = G[i]; d[i * 4 + 2] = B[i];
        d[i * 4 + 3] = (A ? A[i] : 255) * op;
      }
      c.getContext('2d').putImageData(im, 0, 0);
      return c;
    };
    // 合併影像（檔案最後的 Image Data：繪圖軟體存的「看起來的樣子」，含混合模式、剪裁、資料夾、效果）
    let composite = null;
    try {
      p = lmStart + lmLen;
      const comp = r16(), N = W * H, chs = [];
      if (comp === 0) { for (let c = 0; c < nch; c++) { chs.push(u8.subarray(p, p + N)); p += N; } }
      else if (comp === 1) {
        const counts = [];
        for (let i = 0; i < nch * H; i++) counts.push(r16());
        for (let c = 0; c < nch; c++) {
          const out = new Uint8Array(N);
          for (let y = 0; y < H; y++) { const len = counts[c * H + y]; unpackBits(u8, p, p + len, out, y * W, W); p += len; }
          chs.push(out);
        }
      }
      const colorN = mode === 1 ? 1 : 3;
      if (chs.length >= colorN) {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const im = c.getContext('2d').createImageData(W, H), d = im.data, A = chs.length > colorN ? chs[colorN] : null;
        let any = false;
        for (let i = 0; i < N; i++) {
          const a = A ? A[i] / 255 : 1;
          for (let k = 0; k < 3; k++) {
            const m = chs[mode === 1 ? 0 : k][i];
            // 合併影像在透明處是和白色混過的：還原回原本的顏色
            d[i * 4 + k] = a > 0 && a < 1 ? Math.max(0, Math.min(255, (m - 255 * (1 - a)) / a)) : m;
          }
          d[i * 4 + 3] = Math.round(a * 255);
          if (a > 0 && !(d[i * 4] === 255 && d[i * 4 + 1] === 255 && d[i * 4 + 2] === 255)) any = true;
        }
        if (any) { c.getContext('2d').putImageData(im, 0, 0); composite = c; }
      }
    } catch (_) { composite = null; }
    // 沒有合併影像時：自己把圖層疊起來（隱藏、不透明度、常見混合模式、剪裁遮色片）
    const BLEND = { norm: 'source-over', pass: 'source-over', 'mul ': 'multiply', scrn: 'screen', over: 'overlay', dark: 'darken', lite: 'lighten', 'div ': 'color-dodge', idiv: 'color-burn', hLit: 'hard-light', sLit: 'soft-light', diff: 'difference', smud: 'exclusion', 'hue ': 'hue', 'sat ': 'saturation', colr: 'color', 'lum ': 'luminosity', lddg: 'lighter' };
    function flatten() {
      if (composite) return composite;
      const out = document.createElement('canvas'); out.width = W; out.height = H;
      const g = out.getContext('2d');
      // 先掃一次：每個圖層屬於哪些資料夾（資料夾自己的記錄在內容之後才出現，帶著隱藏旗標）
      const st = [];
      for (const r of recs) {
        if (r.section === 3) { st.push({ hidden: false }); continue; }
        if (r.section === 1 || r.section === 2) { const f = st.pop(); if (f) f.hidden = r.hidden; continue; }
        r.folders = st.slice();
      }
      let base = null;   // 剪裁的底層：{ canvas }
      const flushBase = () => { if (base) { g.globalCompositeOperation = base.op; g.drawImage(base.canvas, 0, 0); g.globalCompositeOperation = 'source-over'; base = null; } };
      for (const r of recs) {
        if (r.section) continue;
        const hidden = r.hidden || (r.folders || []).some(f => f.hidden);
        const cv = toCanvas(r);
        if (!cv) continue;
        const op = BLEND[r.blend] || 'source-over';
        if (r.clip) {
          if (!base || hidden) continue;
          // 剪裁：只畫在底層有像素的地方
          const t = document.createElement('canvas'); t.width = W; t.height = H;
          const tg = t.getContext('2d'); tg.drawImage(cv, r.left, r.top); tg.globalCompositeOperation = 'destination-in'; tg.drawImage(base.alpha, 0, 0);
          const bg = base.canvas.getContext('2d'); bg.globalCompositeOperation = op; bg.drawImage(t, 0, 0); bg.globalCompositeOperation = 'source-over';
          continue;
        }
        flushBase();
        if (hidden) continue;
        const bc = document.createElement('canvas'); bc.width = W; bc.height = H; bc.getContext('2d').drawImage(cv, r.left, r.top);
        const al = document.createElement('canvas'); al.width = W; al.height = H; al.getContext('2d').drawImage(bc, 0, 0);
        base = { canvas: bc, alpha: al, op };
      }
      flushBase();
      return out;
    }
    const root = { children: [] }, stack = [root];
    for (const r of recs) {
      if (r.section === 3) {
        const g = { type: 'group', name: '群組', children: [] };
        stack[stack.length - 1].children.push(g);
        stack.push(g);
      } else if (r.section === 1 || r.section === 2) {
        const g = stack.length > 1 ? stack.pop() : { type: 'group', children: [] };
        g.name = r.name; g.hidden = r.hidden;
      } else {
        const canvas = toCanvas(r);
        if (canvas) stack[stack.length - 1].children.push({ type: 'layer', name: r.name, left: r.left, top: r.top, canvas, hidden: r.hidden, blend: r.blend, clip: r.clip });
      }
    }
    return { width: W, height: H, children: root.children, composite, flatten };
  }

  return { parse };
})();
