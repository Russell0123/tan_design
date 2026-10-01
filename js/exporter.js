// 輸出：GIF 編碼器、ZIP（PNG 序列）、影片錄製（MediaRecorder）。全部為瀏覽器內建功能，無外部套件。
const Exporter = (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- GIF ----------
  // 中位切割建立調色盤
  function medianCut(samples, n, maxColors) {
    let boxes = [Int32Array.from({ length: n }, (_, i) => i)];
    const range = idx => {
      let mn = [255, 255, 255], mx = [0, 0, 0];
      for (const i of idx) for (let c = 0; c < 3; c++) { const v = samples[i * 3 + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
      return [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    };
    while (boxes.length < maxColors) {
      let bi = -1, best = 0, bc = 0;
      boxes.forEach((b, i) => {
        if (b.length < 2) return;
        const r = range(b), c = r.indexOf(Math.max(...r)), score = r[c] * Math.sqrt(b.length);
        if (score > best) { best = score; bi = i; bc = c; }
      });
      if (bi < 0) break;
      const b = Array.from(boxes[bi]).sort((x, y) => samples[x * 3 + bc] - samples[y * 3 + bc]);
      const mid = b.length >> 1;
      boxes.splice(bi, 1, Int32Array.from(b.slice(0, mid)), Int32Array.from(b.slice(mid)));
    }
    return boxes.map(b => {
      let r = 0, g = 0, bl = 0;
      for (const i of b) { r += samples[i * 3]; g += samples[i * 3 + 1]; bl += samples[i * 3 + 2]; }
      return [Math.round(r / b.length), Math.round(g / b.length), Math.round(bl / b.length)];
    });
  }

  function lzw(indices, minCode) {
    const out = [], block = [];
    let cur = 0, bits = 0;
    const emit = (code, size) => {
      cur |= code << bits; bits += size;
      while (bits >= 8) { block.push(cur & 255); cur >>>= 8; bits -= 8; if (block.length === 255) { out.push(255, ...block); block.length = 0; } }
    };
    const clear = 1 << minCode, eoi = clear + 1;
    const dict = new Int32Array(4096 * 256);
    const used = [];
    let size = minCode + 1, next = eoi + 1;
    emit(clear, size);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i], key = prefix * 256 + k, code = dict[key];
      if (code) { prefix = code - 1; continue; }
      emit(prefix, size);
      if (next < 4096) {
        dict[key] = next + 1; used.push(key);
        if (next === (1 << size) && size < 12) size++;
        next++;
      } else {
        emit(clear, size);
        for (const u of used) dict[u] = 0;
        used.length = 0;
        size = minCode + 1; next = eoi + 1;
      }
      prefix = k;
    }
    emit(prefix, size);
    emit(eoi, size);
    if (bits > 0) block.push(cur & 255);
    if (block.length) out.push(block.length, ...block);
    out.push(0);
    return Uint8Array.from(out);
  }

  // 調色盤：從所有取樣格平均取樣（不只第一格）→ 中位切割 → 兩輪 k-means 微調；
  // 找最接近顏色用人眼加權距離（R2 G4 B3），查表用每通道 6 位元（避免色帶與偏色）
  const W8 = [2, 4, 3];
  function buildLut(pal) {
    const lut = new Uint8Array(1 << 18), n = pal.length;
    for (let c = 0; c < lut.length; c++) {
      const r = (c >> 12) << 2 | 2, g = ((c >> 6) & 63) << 2 | 2, b = (c & 63) << 2 | 2;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const p = pal[i], dr = p[0] - r, dg = p[1] - g, db = p[2] - b, d = 2 * dr * dr + 4 * dg * dg + 3 * db * db; if (d < bd) { bd = d; bi = i; } }
      lut[c] = bi;
    }
    return lut;
  }
  const lutIndex = (r, g, b) => (r >> 2) << 12 | (g >> 2) << 6 | (b >> 2);
  function gifPalette(frameAt, frames, width, height, cancelled) {
    const pick = Math.min(frames, 16), target = 150000;
    const stride = Math.max(1, Math.floor(width * height * pick / target));
    const samples = [];
    for (let k = 0; k < pick; k++) {
      const f = Math.floor(k * frames / pick), d = frameAt(f).data;
      for (let i = (k * 7919) % stride; i < width * height; i += stride) { const j = i * 4; if (d[j + 3] >= 128) samples.push(d[j], d[j + 1], d[j + 2]); }
      if (cancelled()) return null;
    }
    const n = samples.length / 3;
    if (!n) return { pal: [[0, 0, 0]], lut: new Uint8Array(1 << 18) };
    const S = Uint8Array.from(samples);
    let pal = medianCut(S, n, 255), lut = buildLut(pal);
    for (let it = 0; it < 2; it++) {
      const sum = new Float64Array(pal.length * 4);
      for (let i = 0; i < n; i++) { const r = S[i * 3], g = S[i * 3 + 1], b = S[i * 3 + 2], q = lut[lutIndex(r, g, b)] * 4; sum[q] += r; sum[q + 1] += g; sum[q + 2] += b; sum[q + 3]++; }
      pal = pal.map((p, i) => sum[i * 4 + 3] ? [Math.round(sum[i * 4] / sum[i * 4 + 3]), Math.round(sum[i * 4 + 1] / sum[i * 4 + 3]), Math.round(sum[i * 4 + 2] / sum[i * 4 + 3])] : p);
      lut = buildLut(pal);
    }
    return { pal, lut };
  }

  // frameAt(i) → ImageData；loops: 1 = 播一次，0 = 無限
  async function gif({ width, height, frames, fps, loops, transparent, frameAt, progress, cancelled }) {
    const P = gifPalette(frameAt, frames, width, height, cancelled);
    if (!P) return null;
    const pal = P.pal.slice(), lut = P.lut;
    while (pal.length < 256) pal.push([0, 0, 0]);
    const TI = 255;
    const parts = [];
    const head = [];
    const w16 = v => head.push(v & 255, v >> 8);
    for (const ch of 'GIF89a') head.push(ch.charCodeAt(0));
    w16(width); w16(height); head.push(0xF7, 0, 0);
    for (const p of pal) head.push(p[0], p[1], p[2]);
    if (loops !== 1) {
      head.push(0x21, 0xFF, 11);
      for (const ch of 'NETSCAPE2.0') head.push(ch.charCodeAt(0));
      head.push(3, 1); const c = loops === 0 ? 0 : loops - 1; head.push(c & 255, c >> 8, 0);
    }
    parts.push(Uint8Array.from(head));
    let acc = 0;
    for (let f = 0; f < frames; f++) {
      if (cancelled()) return null;
      const d = frameAt(f).data, idx = new Uint8Array(width * height);
      for (let i = 0, j = 0; i < idx.length; i++, j += 4) {
        idx[i] = transparent && d[j + 3] < 128 ? TI : lut[lutIndex(d[j], d[j + 1], d[j + 2])];
      }
      acc += 100 / fps;
      const delay = Math.round(acc); acc -= delay;
      parts.push(Uint8Array.from([0x21, 0xF9, 4, transparent ? 0x09 : 0x04, delay & 255, delay >> 8, TI, 0,
        0x2C, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 8]));
      parts.push(lzw(idx, 8));
      progress((f + 1) / frames);
      await sleep(0);
    }
    parts.push(Uint8Array.from([0x3B]));
    return new Blob(parts, { type: 'image/gif' });
  }

  // ---------- ZIP（不壓縮，PNG 本身已壓縮） ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = d => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true); h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + sz;
    }
    const csize = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }

  // ---------- 影片 ----------
  function pickMime(kind) {
    const list = kind === 'mp4'
      ? ['video/mp4;codecs=avc1.42E01F', 'video/mp4;codecs=avc1', 'video/mp4']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || null;
  }
  // 逐幀送進錄影器，依 fps 即時錄製
  async function video({ canvas, fps, frames, mime, drawFrame, progress, cancelled }) {
    const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10e6 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start();
    const t0 = performance.now(), dt = 1000 / fps;
    for (let f = 0; f < frames; f++) {
      if (cancelled()) break;
      drawFrame(f);
      track.requestFrame();
      progress((f + 1) / frames);
      const wait = t0 + (f + 1) * dt - performance.now();
      await sleep(Math.max(0, wait));
    }
    await sleep(dt * 2);
    rec.stop();
    await stopped;
    track.stop();
    return cancelled() ? null : new Blob(chunks, { type: mime.split(';')[0] });
  }

  // ---------- APNG（全彩 + 半透明，逐格編碼）----------
  const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255], u16 = v => [(v >>> 8) & 255, v & 255];
  function pngChunks(bytes) {
    const out = [], dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let p = 8; p < bytes.length;) {
      const len = dv.getUint32(p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
      out.push({ type, data: bytes.subarray(p + 8, p + 8 + len) });
      p += 12 + len;
    }
    return out;
  }
  function chunk(type, data) {
    const t = new TextEncoder().encode(type), body = new Uint8Array(4 + data.length);
    body.set(t, 0); body.set(data, 4);
    return [Uint8Array.from(u32(data.length)), body, Uint8Array.from(u32(crc32(body)))];
  }
  async function apng({ width, height, frames, fps, loops, framePng, progress, cancelled }) {
    const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])];
    let seq = 0, ihdr = null;
    const body = [];
    for (let f = 0; f < frames; f++) {
      if (cancelled()) return null;
      const cs = pngChunks(framePng(f));
      if (!ihdr) ihdr = cs.find(c => c.type === 'IHDR');
      body.push(...chunk('fcTL', Uint8Array.from([...u32(seq++), ...u32(width), ...u32(height), ...u32(0), ...u32(0), ...u16(1), ...u16(fps), 0, 0])));
      for (const c of cs.filter(c => c.type === 'IDAT')) {
        if (f === 0) body.push(...chunk('IDAT', c.data));
        else { const d = new Uint8Array(4 + c.data.length); d.set(u32(seq++), 0); d.set(c.data, 4); body.push(...chunk('fdAT', d)); }
      }
      progress((f + 1) / frames);
      if (f % 4 === 3) await sleep(0);
    }
    parts.push(...chunk('IHDR', ihdr.data), ...chunk('acTL', Uint8Array.from([...u32(frames), ...u32(loops)])), ...body, ...chunk('IEND', new Uint8Array(0)));
    return new Blob(parts, { type: 'image/apng' });
  }

  // ---------- 影片編碼（WebCodecs，逐格編碼，不是即時錄影）----------
  const canEncode = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  async function pickCodec(kind, width, height, fps) {
    const list = kind === 'mp4' ? ['avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4d0028', 'avc1.42001f'] : ['vp09.00.41.08', 'vp09.00.31.08', 'vp8'];
    for (const codec of list) {
      const cfg = { codec, width, height, framerate: fps, bitrate: Math.min(40e6, Math.max(4e6, width * height * fps * 0.25)), ...(kind === 'mp4' ? { avc: { format: 'avc' } } : {}) };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return cfg; } catch (_) { /* 下一個 */ }
    }
    return null;
  }
  async function encodeVideo({ kind, canvas, fps, frames, drawFrame, progress, cancelled }) {
    const width = canvas.width, height = canvas.height;
    const cfg = await pickCodec(kind, width, height, fps);
    if (!cfg) return null;
    const samples = [];
    let desc = null, err = null;
    const enc = new VideoEncoder({
      output: (c, meta) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); samples.push({ data: b, key: c.type === 'key', ts: c.timestamp }); if (meta && meta.decoderConfig && meta.decoderConfig.description) desc = new Uint8Array(meta.decoderConfig.description); },
      error: e => { err = e; },
    });
    enc.configure(cfg);
    const dur = 1e6 / fps, gop = Math.max(1, Math.round(fps * 2));
    for (let f = 0; f < frames; f++) {
      if (cancelled() || err) break;
      drawFrame(f);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(f * dur), duration: Math.round(dur) });
      enc.encode(vf, { keyFrame: f % gop === 0 });
      vf.close();
      progress((f + 1) / frames * 0.95);
      while (enc.encodeQueueSize > 6) await sleep(1);
    }
    await enc.flush();
    enc.close();
    if (err) throw err;
    if (cancelled()) return null;
    samples.sort((a, b) => a.ts - b.ts);
    progress(1);
    return kind === 'mp4' ? muxMp4(samples, desc, width, height, fps) : muxWebm(samples, width, height, fps, cfg.codec.startsWith('vp8') ? 'V_VP8' : 'V_VP9');
  }
  // MP4（非分段）：ftyp → mdat → moov
  function box(type, ...parts) {
    const flat = parts.flat(Infinity), len = 8 + flat.reduce((a, p) => a + (p.length ?? 1), 0);
    const out = new Uint8Array(len); let o = 0;
    out.set(u32(len), 0); out.set(new TextEncoder().encode(type), 4); o = 8;
    for (const p of flat) { if (typeof p === 'number') out[o++] = p; else { out.set(p, o); o += p.length; } }
    return out;
  }
  const fbox = (type, ver, flags, ...parts) => box(type, [ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
  const bytes = arr => Uint8Array.from(arr);
  function muxMp4(samples, avcC, width, height, fps) {
    const N = samples.length, ftyp = box('ftyp', new TextEncoder().encode('isom'), bytes(u32(512)), new TextEncoder().encode('isomiso2avc1mp41'));
    const mdatLen = 8 + samples.reduce((a, s) => a + s.data.length, 0);
    const mdatHead = bytes([...u32(mdatLen), 109, 100, 97, 116]);
    const chunkOff = ftyp.length + 8;
    const durMs = Math.round(N * 1000 / fps);
    const matrix = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
    const mvhd = fbox('mvhd', 0, 0, bytes([...u32(0), ...u32(0), ...u32(1000), ...u32(durMs), ...u32(0x10000), ...u16(0x100), 0, 0, ...u32(0), ...u32(0), ...matrix, ...new Array(24).fill(0), ...u32(2)]));
    const tkhd = fbox('tkhd', 0, 3, bytes([...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(durMs), ...u32(0), ...u32(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...matrix, ...u32(width << 16), ...u32(height << 16)]));
    const mdhd = fbox('mdhd', 0, 0, bytes([...u32(0), ...u32(0), ...u32(fps), ...u32(N), ...u16(0x55c4), ...u16(0)]));
    const hdlr = fbox('hdlr', 0, 0, bytes([...u32(0)]), new TextEncoder().encode('vide'), bytes(new Array(12).fill(0)), new TextEncoder().encode('Video\0'));
    const vmhd = fbox('vmhd', 0, 1, bytes(new Array(8).fill(0)));
    const dinf = box('dinf', fbox('dref', 0, 0, bytes(u32(1)), fbox('url ', 0, 1)));
    const avc1 = box('avc1', bytes([0, 0, 0, 0, 0, 0, ...u16(1), ...new Array(16).fill(0), ...u16(width), ...u16(height), ...u32(0x480000), ...u32(0x480000), ...u32(0), ...u16(1), ...new Array(32).fill(0), ...u16(0x18), 0xff, 0xff]), box('avcC', avcC || new Uint8Array(0)));
    const stsd = fbox('stsd', 0, 0, bytes(u32(1)), avc1);
    const stts = fbox('stts', 0, 0, bytes([...u32(1), ...u32(N), ...u32(1)]));
    const keys = samples.map((s, i) => s.key ? i + 1 : 0).filter(Boolean);
    const stss = fbox('stss', 0, 0, bytes([...u32(keys.length), ...keys.flatMap(u32)]));
    const stsc = fbox('stsc', 0, 0, bytes([...u32(1), ...u32(1), ...u32(N), ...u32(1)]));
    const stsz = fbox('stsz', 0, 0, bytes([...u32(0), ...u32(N), ...samples.flatMap(s => u32(s.data.length))]));
    const stco = fbox('stco', 0, 0, bytes([...u32(1), ...u32(chunkOff)]));
    const moov = box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, box('stbl', stsd, stts, stss, stsc, stsz, stco)))));
    return new Blob([ftyp, mdatHead, ...samples.map(s => s.data), moov], { type: 'video/mp4' });
  }
  // WebM（Matroska）：每個關鍵格開一個 Cluster
  function ebmlId(id) { const b = []; let v = id; while (v > 0) { b.unshift(v & 255); v = Math.floor(v / 256); } return b; }
  function ebml(id, data) {
    const d = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const size = d.length, head = [...ebmlId(id), 0x01, 0, 0, 0, (size / 2 ** 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255];
    const out = new Uint8Array(head.length + size); out.set(head, 0); out.set(d, head.length); return out;
  }
  const cat = list => { const n = list.reduce((a, b) => a + b.length, 0), o = new Uint8Array(n); let p = 0; for (const b of list) { o.set(b, p); p += b.length; } return o; };
  const uint = v => { const b = []; do { b.unshift(v & 255); v = Math.floor(v / 256); } while (v > 0); return b; };
  const str = s => new TextEncoder().encode(s);
  function f64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; }
  function muxWebm(samples, width, height, fps, codecId) {
    const head = ebml(0x1A45DFA3, cat([ebml(0x4286, uint(1)), ebml(0x42F7, uint(1)), ebml(0x42F2, uint(4)), ebml(0x42F3, uint(8)), ebml(0x4282, str('webm')), ebml(0x4287, uint(4)), ebml(0x4285, uint(2))]));
    const durMs = samples.length * 1000 / fps;
    const info = ebml(0x1549A966, cat([ebml(0x2AD7B1, uint(1000000)), ebml(0x4D80, str('tan-design')), ebml(0x5741, str('tan-design')), ebml(0x4489, f64(durMs))]));
    const tracks = ebml(0x1654AE6B, ebml(0xAE, cat([ebml(0xD7, uint(1)), ebml(0x73C5, uint(1)), ebml(0x83, uint(1)), ebml(0x86, str(codecId)), ebml(0xE0, cat([ebml(0xB0, uint(width)), ebml(0xBA, uint(height))]))])));
    const clusters = [];
    let cur = null, base = 0;
    samples.forEach((s, i) => {
      const ms = Math.round(i * 1000 / fps);
      if (!cur || s.key || ms - base > 30000) { if (cur) clusters.push(ebml(0x1F43B675, cat(cur))); cur = [ebml(0xE7, uint(ms))]; base = ms; }
      const rel = ms - base, blk = new Uint8Array(4 + s.data.length);
      blk[0] = 0x81; blk[1] = (rel >> 8) & 255; blk[2] = rel & 255; blk[3] = s.key ? 0x80 : 0;
      blk.set(s.data, 4);
      cur.push(ebml(0xA3, blk));
    });
    if (cur) clusters.push(ebml(0x1F43B675, cat(cur)));
    const seg = ebml(0x18538067, cat([info, tracks, ...clusters]));
    return new Blob([head, seg], { type: 'video/webm' });
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  return { crc32, medianCut, gifPalette, lutIndex, gif, zip, video, pickMime, download, apng, encodeVideo, canEncode };
})();
