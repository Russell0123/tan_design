// 專案檔：ZIP 內含 project.json、assets/*.png（圖片）、masks/*.png（遮罩，存在 alpha）
// 存檔格式（.彈design.png）：一張真正的 PNG（作品縮圖，檔案總管可直接預覽），ZIP 放在私有區塊 tnDz 裡（看圖軟體會忽略）
// 舊的 .puppet（純 ZIP）照樣可以開
const Project = (() => {
  const FORMAT = 'q-puppet', VERSION = 2;

  function canvasBytes(c) {
    const bin = atob(c.toDataURL('image/png').split(',')[1]), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function maskCanvas(m) {
    const c = document.createElement('canvas');
    c.width = m.w; c.height = m.h;
    const g = c.getContext('2d'), im = g.createImageData(m.w, m.h);
    for (let i = 0; i < m.data.length; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = 255; im.data[i * 4 + 3] = m.data[i]; }
    g.putImageData(im, 0, 0);
    return c;
  }

  // 只存目前資料有用到的圖片與遮罩；回傳 ZIP Blob
  function saveZip(doc) {
    const json = JSON.stringify(doc.data), files = [], masks = {};
    for (const [id, a] of doc.assets) if (json.includes(`"${id}"`)) files.push({ name: `assets/${id}.png`, data: canvasBytes(a.canvas) });
    for (const [id, m] of doc.masks) if (json.includes(`"${id}"`)) { files.push({ name: `masks/${id}.png`, data: canvasBytes(maskCanvas(m)) }); masks[id] = { w: m.w, h: m.h }; }
    const meta = { format: FORMAT, version: VERSION, name: doc.name, data: doc.data, masks };
    files.unshift({ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(meta)) });
    return Exporter.zip(files);
  }

  // 存成 PNG：thumb = 縮圖 canvas；回傳 Promise<Blob>
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10], CHUNK = 'tnDz';
  const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  async function save(doc, thumb) {
    const zip = new Uint8Array(await saveZip(doc).arrayBuffer());
    const base = thumb instanceof Blob ? thumb : await new Promise(res => thumb.toBlob(res, 'image/png'));
    const png = new Uint8Array(await base.arrayBuffer());
    const iend = png.length - 12;   // IEND 固定是最後 12 bytes
    const body = new Uint8Array(4 + zip.length);
    body.set([...CHUNK].map(c => c.charCodeAt(0)), 0); body.set(zip, 4);
    const chunk = [Uint8Array.from(u32(zip.length)), body, Uint8Array.from(u32(Exporter.crc32(body)))];
    return new Blob([png.subarray(0, iend), ...chunk, png.subarray(iend)], { type: thumb instanceof Blob ? thumb.type || 'image/png' : 'image/png' });
  }
  // PNG 裡的專案 ZIP（沒有就回傳 null）
  function zipInPng(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.length < 8 || SIG.some((v, i) => u8[i] !== v)) return null;
    const dv = new DataView(buf);
    for (let p = 8; p + 8 <= u8.length;) {
      const len = dv.getUint32(p), type = String.fromCharCode(...u8.subarray(p + 4, p + 8));
      if (type === CHUNK) return buf.slice(p + 8, p + 8 + len);
      if (type === 'IEND') break;
      p += 12 + len;
    }
    return null;
  }
  const isProject = buf => !!zipInPng(buf);

  // 讀 ZIP（支援未壓縮與 deflate）
  async function unzip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf), out = new Map(), dec = new TextDecoder();
    let e = buf.byteLength - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('不是有效的專案檔');
    const count = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    for (let k = 0; k < count; k++) {
      const method = dv.getUint16(p + 10, true), csz = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      const lp = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      let data = u8.subarray(lp, lp + csz);
      if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else if (method !== 0) throw new Error('不支援的壓縮方式');
      out.set(name, data);
      p += 46 + nl + xl + cl;
    }
    return out;
  }
  function loadImg(bytes) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); res(im); };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('專案內的圖片損毀')); };
      im.src = url;
    });
  }

  // 回傳 { name, data, assets: Map(id → canvas), masks: Map(id → {data,w,h}) }
  async function load(buf) {
    const files = await unzip(zipInPng(buf) || buf);
    const pj = files.get('project.json');
    if (!pj) throw new Error('專案檔缺少 project.json');
    const meta = JSON.parse(new TextDecoder().decode(pj));
    if (meta.format !== FORMAT) throw new Error('不是 彈design 的專案檔');
    if (meta.version > VERSION) throw new Error('這個專案是用較新的版本存的，請更新工具');
    const assets = new Map(), masks = new Map();
    for (const [name, bytes] of files) {
      const m = /^(assets|masks)\/(.+)\.png$/.exec(name);
      if (!m) continue;
      const im = await loadImg(bytes), c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      if (m[1] === 'assets') assets.set(m[2], c);
      else {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, data = new Uint8Array(c.width * c.height);
        for (let i = 0; i < data.length; i++) data[i] = d[i * 4 + 3];
        masks.set(m[2], { data, w: c.width, h: c.height });
      }
    }
    return { name: meta.name, data: Model.migrate(meta.data), assets, masks };
  }

  return { save, load, isProject, VERSION };
})();
