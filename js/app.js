(() => {
'use strict';
const { I, aMul, aApply, aInv, aAbout, TYPES } = Model;
const $ = s => document.querySelector(s);
const TAU = Math.PI * 2, DEG = Math.PI / 180;
const MAX_IMAGE = 2048, K = 4, HIT = 10;

const renderer = Renderer.create($('#glCanvas'));
const octx = $('#overlay').getContext('2d');

// ---------- 全域狀態 ----------
const tabs = [];
let D = null;
const view = { cw: 1, ch: 1, dpr: 1 };
const DEPTH_COLOR = '#f59e0b';
const tool = { name: 'select', brush: 30, maskSoft: 0, paintSoft: 0, maskOpacity: 1, paintOpacity: 1, depthSize: 40, depthSoft: 12, depthOpacity: 1, depthMode: 'add', stripHidden: false, maskMode: 'add', lasso: 'add', paintColor: '#3b2a20', paintSize: 6, paintMode: 'draw', linkRig: true, crop: false };
let showPins = true, showMesh = false, showRegion = true, speed = 1, exporting = false;
let maskVer = 0;

// ---------- 小工具 ----------
// append 時略過 null / false（條件式的元件，例如 cond ? el(...) : null，不會變成「null」文字）
{ const ap = Element.prototype.append; Element.prototype.append = function (...k) { return ap.apply(this, k.filter(x => x != null && x !== false)); }; }
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (['checked', 'value', 'selected', 'disabled'].includes(k)) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}
const ico = (name, cls) => Icons.el(name, cls);
function toast(msg, kind = 'info') {
  const t = el('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 2800);
  setTimeout(() => t.remove(), 3200);
}
document.querySelectorAll('[data-ico]').forEach(s => s.replaceWith(ico(s.dataset.ico)));

const node = id => Model.byId(D.data, id);
const sel = () => D && node(D.ui.sel);
// 時間軸總長（幀）= 單一循環 × 循環數
const total = () => Model.totalOf(D.data);
const master = () => Model.master(D.data);
const colorOf = n => (TYPES[n.type] && TYPES[n.type].color) || '#e9557c';
const rgbOf = hex => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
const isPart = n => n && !['root', 'image'].includes(n.type);

// ---------- 文件 ----------
function newDoc(name) {
  return {
    id: Model.uid('doc_'), name,
    data: Model.newData(),
    assets: new Map(),
    masks: new Map(),
    history: { stack: [], idx: -1 },
    ui: { sel: 'root', selPin: null, mode: 'edit', playing: false, frame: 0, zoom: 1, panX: 0, panY: 0, base: 1, fit: null, align: null },
    cache: { drawables: [], sSig: '', iSig: '', alignDr: null },
  };
}

function assetFromCanvas(doc, name, c) {
  const w = c.width, h = c.height;
  const rgba = c.getContext('2d').getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = rgba[i * 4 + 3];
  const id = Model.uid('a_');
  doc.assets.set(id, { canvas: c, rgba, alpha, w, h });
  doc.data.assets[id] = { name, w, h };
  return id;
}
function addAsset(doc, name, source, quiet = false) {
  let w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
  if (w < 1 || h < 1) return null;
  const limit = Math.min(MAX_IMAGE, renderer.maxTexture);
  if (Math.max(w, h) > limit) {
    const k = limit / Math.max(w, h);
    if (!quiet) toast(`「${name}」較大（${w}×${h}），已縮小為 ${Math.round(w * k)}×${Math.round(h * k)}`, 'warn');
    w = Math.round(w * k); h = Math.round(h * k);
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(source, 0, 0, w, h);
  const id = assetFromCanvas(doc, name, c);
  const a = doc.assets.get(id);
  let transparent = 0;
  for (let i = 0; i < w * h; i++) if (a.alpha[i] < 10) transparent++;
  if (!quiet && transparent === w * h) toast(`「${name}」是完全透明的圖片`, 'warn');
  if (!quiet && transparent / (w * h) < 0.01) toast(`「${name}」沒有透明背景，整張圖會一起變形；建議使用去背 PNG`, 'warn');
  if (!doc.data.width) { doc.data.width = w; doc.data.height = h; }
  return id;
}
function nextOrder(doc) { return Math.max(0, ...doc.data.nodes.filter(Model.isDrawable).map(n => n.order)) + 10; }
function addImageNode(doc, assetId, name, parent = 'root', extra = {}) {
  const n = Model.makeNode(doc.data, 'image', parent, { name, order: nextOrder(doc), image: { assetId, x: 0, y: 0, scale: 1, rot: 0, crop: null, variants: [] }, ...extra });
  doc.data.nodes.push(n);
  return n;
}
function layerAffine(img, a) {
  const s = img.scale ?? 1, m = aAbout(a.w / 2, a.h / 2, (img.rot || 0) * DEG, s, s);
  m[4] += img.x; m[5] += img.y;
  return m;
}
function updateRootPivot(doc) {
  const root = Model.byId(doc.data, 'root');
  if (root.pins.length) return;
  const b = opaqueBounds(doc);
  if (b) root.pins = [{ id: Model.uid('pin_'), x: Math.round((b.x0 + b.x1) / 2), y: b.y1, kind: 'fixed' }];
}
function opaqueBounds(doc) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of doc.data.nodes) {
    if (n.type !== 'image' || !Model.isShown(doc.data, n)) continue;
    const a = doc.assets.get(n.image.assetId);
    if (!a) continue;
    const T = layerAffine(n.image, a);
    for (let y = 0; y < a.h; y += 2) for (let x = 0; x < a.w; x += 2) {
      if (a.alpha[y * a.w + x] > 10) {
        const [X, Y] = aApply(T, x, y);
        if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      }
    }
  }
  return x1 < x0 ? null : { x0, y0, x1, y1 };
}
function addPart(doc, type, name, parent, pins = [], extra = {}) {
  const n = Model.makeNode(doc.data, type, parent);
  n.name = Model.uniqueName(doc.data, name || n.name, n);   // 名稱不能重複
  n.pins = pins.map(([x, y], i) => ({ id: Model.uid('pin_'), x: Math.round(x), y: Math.round(y), kind: i === 0 ? 'fixed' : 'move' }));
  if (extra.params) { Object.assign(n.params, extra.params); extra = { ...extra }; delete extra.params; }
  Object.assign(n, extra);
  doc.data.nodes.push(n);
  return n;
}

// ---------- 遮罩（文件座標） ----------
function capsuleRaster(doc, n, radius) {
  const W = doc.data.width, H = doc.data.height;
  return ImgProc.paint(W, H, g => {
    g.lineWidth = radius * 2;
    g.beginPath();
    n.pins.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y));
    if (n.pins.length === 1) g.lineTo(n.pins[0].x + 0.01, n.pins[0].y);
    g.stroke();
  });
}
// 取得可寫入的遮罩（寫入前複製；錨點自動範圍會先轉成遮罩）
function editableMask(doc, n, fresh = false) {
  const W = doc.data.width, H = doc.data.height;
  let id = n.region.maskId;
  const old = n.region.mode === 'mask' && id && doc.masks.get(id);
  let data;
  if (old) data = new Uint8Array(old.data);
  else if (!fresh && n.region.mode === 'auto' && n.pins.length) data = capsuleRaster(doc, n, n.region.radius);
  else data = new Uint8Array(W * H);
  if (!id) { id = Model.uid('m_'); n.region.maskId = id; }
  const obj = { data, w: W, h: H, v: ++maskVer };
  doc.masks.set(id, obj);
  n.region.mode = 'mask';
  return obj;
}
function paintMask(doc, n, painter, erase = false, fresh = false) {
  const obj = editableMask(doc, n, fresh);
  const add = ImgProc.paint(obj.w, obj.h, painter);
  const d = obj.data;
  for (let i = 0; i < d.length; i++) d[i] = erase ? Math.max(0, d[i] - add[i]) : Math.max(d[i], add[i]);
  obj.v = ++maskVer;
}
const fieldCache = new WeakMap();
function maskFields(obj, soft) {
  let c = fieldCache.get(obj);
  if (!c || c.v !== obj.v) { c = { v: obj.v, dist: ImgProc.distanceField(obj.data, obj.w, obj.h), soft: -1, core: null }; fieldCache.set(obj, c); }
  // 柔化只往外：模糊後與原遮罩取最大值，尖角、細線不會被吃掉
  if (c.soft !== soft) { c.core = soft > 0.5 ? ImgProc.outerSoft(obj.data, obj.w, obj.h, soft / 1.8) : obj.data; c.soft = soft; }
  return c;
}
function makeMk(doc) {
  const cache = new Map();
  return n => {
    if (cache.has(n.id)) return cache.get(n.id);
    const obj = n.region.maskId && doc.masks.get(n.region.maskId);
    let r = null;
    if (obj) {
      const f = maskFields(obj, n.region.soft), W = obj.w, H = obj.h;
      const at = (x, y) => Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)));
      r = { core: (x, y) => f.core[at(x, y)] / 255, dist: (x, y) => f.dist[at(x, y)] };
    }
    cache.set(n.id, r);
    return r;
  };
}
// 獨立圖層切割用的範圍（0..1，依硬度調整邊緣）
function detachSampler(doc, n) {
  const soft = (1 - (n.hardness ?? 0.85)) * 16;
  if (n.region.mode === 'mask' && n.region.maskId && doc.masks.get(n.region.maskId)) {
    const obj = doc.masks.get(n.region.maskId), W = obj.w, H = obj.h;
    const core = soft > 0.5 ? maskFields(obj, soft).core : obj.data;
    return (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= W || yi >= H ? 0 : core[yi * W + xi] / 255; };
  }
  if (n.region.mode === 'auto' && n.pins.length) {
    const R = n.region.radius, s = Math.max(0.5, soft);
    return (x, y) => { const d = Model.polyDist(n.pins, x, y) - R; return d <= -s ? 1 : d >= s ? 0 : 0.5 - d / (2 * s); };
  }
  return null;
}

// ---------- 衍生資料：繪製物件 ----------
function structSig(doc) {
  const mv = id => (doc.masks.get(id) || {}).v;
  const parts = doc.data.nodes.filter(n => n.type === 'image' || n.detach).map(n => [
    n.id, n.type, n.parent, n.order, n.detach, n.hardness, n.fillBand,
    n.image && [n.image.assetId, n.image.x, n.image.y, n.image.scale, n.image.rot, n.image.crop, n.image.variants.map(v => v.assetId)],
    n.blink && n.blink.on && blinkSig(doc, n),
    n.detach && [n.region.mode, n.region.maskId && mv(n.region.maskId), n.pins.map(p => [p.x, p.y]), n.region.radius],
    n.detach && Model.imageOf(doc.data, n)?.id,
  ]);
  return JSON.stringify([parts, doc.data.mesh.density]);
}

// 眨眼：用到的設定與素材圖層（位置 / 圖）變了才重算
function blinkSig(doc, n) {
  const B = n.blink, src = id => { const s = id && Model.byId(doc.data, id); return s && s.image ? [s.image.assetId, s.image.x, s.image.y, s.image.scale, s.image.rot] : null; };
  // 自動傾斜：其他眼睛圖層的位置也會影響
  const eyes = B.tilt == null ? eyeLayers(doc, n).map(m => src(m.id)) : null;
  return [src(B.closedId), src(B.lidId), B.lidColor, B.lidAuto && src(n.parent), B.line, B.lash, B.low, B.tilt, src(n.id), eyes];
}
// ---------- 眨眼的方向：垂直於兩眼連線 ----------
const eyeLayers = (doc, n) => doc.data.nodes.filter(m => m !== n && m.type === 'image' && ((m.blink && m.blink.on) || m.role === 'eye'));
// 圖層裡的不透明區塊（依欄分段）：回傳質心，大的在前
function alphaClusters(rgba, w, h) {
  const mass = new Float64Array(w), sy = new Float64Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = rgba[(y * w + x) * 4 + 3]; if (a > 60) { mass[x] += a; sy[x] += a * y; } }
  const gap = Math.max(2, Math.round(w * 0.03)), out = [];
  let cur = null, empty = 0;
  for (let x = 0; x < w; x++) {
    if (mass[x] > 0) {
      if (!cur || empty > gap) { cur = { m: 0, sx: 0, sy: 0 }; out.push(cur); }
      cur.m += mass[x]; cur.sx += mass[x] * x; cur.sy += sy[x]; empty = 0;
    } else empty++;
  }
  return out.map(c => ({ m: c.m, x: c.sx / c.m, y: c.sy / c.m })).sort((a, b) => b.m - a.m);
}
// 兩眼連線的角度（弧度，在這個圖層的像素座標裡）
//   1. 這個圖層裡就有兩隻眼睛：兩個區塊的質心連線
//   2. 左右眼分開兩個圖層：和最近的另一個眼睛圖層的質心連線
//   3. 都沒有：畫面的水平（圖層有旋轉時跟著換算）
function eyeTilt(doc, n) {
  const a = doc.assets.get(n.image.assetId);
  if (!a || !a.rgba) return 0;
  const norm = (vx, vy) => { if (vx < 0) { vx = -vx; vy = -vy; } return Math.max(-Math.PI / 4, Math.min(Math.PI / 4, Math.atan2(vy, vx))); };
  const cl = alphaClusters(a.rgba, a.w, a.h), tot = cl.reduce((s, c) => s + c.m, 0);
  if (cl.length >= 2 && cl[1].m > tot * 0.15) return norm(cl[1].x - cl[0].x, cl[1].y - cl[0].y);
  const L = layerAffine(n.image, a), Li = aInv(L);
  const own = cl.length ? aApply(L, cl[0].x, cl[0].y) : null;
  let dir = [1, 0];
  if (own) {
    let best = null, bd = Infinity;
    for (const m of eyeLayers(doc, n)) {
      const b = doc.assets.get(m.image.assetId);
      if (!b || !b.rgba) continue;
      const c2 = alphaClusters(b.rgba, b.w, b.h)[0];
      if (!c2) continue;
      const p = aApply(layerAffine(m.image, b), c2.x, c2.y), d = Math.hypot(p[0] - own[0], p[1] - own[1]);
      if (d > 1 && d < bd) { bd = d; best = p; }
    }
    if (best) dir = [best[0] - own[0], best[1] - own[1]];
  }
  // 畫面上的方向 → 圖層像素座標（只用線性部分）
  return norm(Li[0] * dir[0] + Li[2] * dir[1], Li[1] * dir[0] + Li[3] * dir[1]);
}
const blinkTilt = (doc, n) => n.blink.tilt != null ? n.blink.tilt * DEG : eyeTilt(doc, n);
// 另一個圖層畫到這個圖層的像素座標（RGBA）
function layerInto(doc, srcNode, n, w, h) {
  const a = srcNode && srcNode.image && doc.assets.get(srcNode.image.assetId), me = doc.assets.get(n.image.assetId);
  if (!a || !me) return null;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), m = aMul(aInv(layerAffine(n.image, me)), layerAffine(srcNode.image, a));
  g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  g.drawImage(a.canvas, 0, 0);
  return g.getImageData(0, 0, w, h).data;
}
function blinkLevels(doc, n, rgba, w, h) {
  const B = n.blink, closed = B.closedId ? layerInto(doc, Model.byId(doc.data, B.closedId), n, w, h) : null;
  let lid = B.lidId ? layerInto(doc, Model.byId(doc.data, B.lidId), n, w, h) : null;
  if (!lid && B.lidColor) {
    const [r, g, b] = rgbOf(B.lidColor).map(v => Math.round(v * 255));
    lid = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { lid[i * 4] = r; lid[i * 4 + 1] = g; lid[i * 4 + 2] = b; lid[i * 4 + 3] = 255; }
  }
  let dil = 0;
  if (!lid && B.lidAuto) { lid = autoSkin(doc, n, rgba, w, h); dil = 2; }
  return Blink.buildTilted(rgba, closed, lid, w, h, B, dil, blinkTilt(doc, n));
}
// 自動補膚色：底下的圖（父層）在眼睛範圍內的像素，用周圍像皮膚的顏色一圈一圈往內補
function autoSkin(doc, n, eyeRGBA, w, h) {
  const par = Model.byId(doc.data, n.parent), base = par && par.type === 'image' ? layerInto(doc, par, n, w, h) : null;
  if (!base) return null;
  const N = w * h, near = new Uint8Array(N), target = new Uint8Array(N), known = new Uint8Array(N);
  const grow = (m, k) => { for (let s = 0; s < k; s++) { const cur = m.slice(); for (let i = 0; i < N; i++) if (!cur[i]) { const x = i % w; if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (i >= w && cur[i - w]) || (i < N - w && cur[i + w])) m[i] = 1; } } return m; };
  const eyeM = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (eyeRGBA[i * 4 + 3] > 8) eyeM[i] = 1;
  // 膚色：眼睛外圍 3 … 6px 一圈的中位數
  const r6 = grow(eyeM.slice(), 6), r3 = grow(eyeM.slice(), 3), ring = [];
  for (let i = 0; i < N; i++) if (r6[i] && !r3[i] && base[i * 4 + 3] > 200) ring.push(i);
  if (!ring.length) return null;
  const med = k => { const v = ring.map(i => base[i * 4 + k]).sort((p, q) => p - q); return v[v.length >> 1]; };
  const sk = [med(0), med(1), med(2)];
  const dist = i => Math.hypot(base[i * 4] - sk[0], base[i * 4 + 1] - sk[1], base[i * 4 + 2] - sk[2]);
  // 要重畫：眼睛本身 + 外圍 4px 裡「不是頭髮」的像素（膚色或眼睛柔邊的中間色；頭髮等差很多的保留）
  near.set(eyeM); grow(near, 4);
  for (let i = 0; i < N; i++) {
    if (eyeM[i] || (near[i] && dist(i) < 90)) target[i] = 1;
    else if (base[i * 4 + 3] > 200 && dist(i) < 40) known[i] = 1;   // 只從像皮膚的地方取色
  }
  const out = new Uint8ClampedArray(base);
  ImgProc.fill(out, w, h, known, target);
  // 補好的地方柔化兩次（去掉一圈一圈的條紋；只用像皮膚的像素）
  const ok = new Uint8Array(N);
  for (let i = 0; i < N; i++) ok[i] = target[i] ? known[i] : base[i * 4 + 3] > 200 && dist(i) < 40 ? 1 : 0;
  for (let pass = 0; pass < 2; pass++) {
    const src = out.slice();
    for (let i = 0; i < N; i++) {
      if (!target[i] || !ok[i]) continue;
      const x = i % w, y = (i / w) | 0;
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (!ok[j]) continue;
        r += src[j * 4]; g += src[j * 4 + 1]; b += src[j * 4 + 2]; c++;
      }
      if (c) { out[i * 4] = r / c; out[i * 4 + 1] = g / c; out[i * 4 + 2] = b / c; }
    }
  }
  for (let i = 0; i < N; i++) {
    if (target[i] && !known[i]) { out[i * 4] = sk[0]; out[i * 4 + 1] = sk[1]; out[i * 4 + 2] = sk[2]; }   // 補不到的（被頭髮包住）用膚色
    out[i * 4 + 3] = target[i] ? base[i * 4 + 3] : 0;
  }
  return out;
}
function rebuildDrawables(doc) {
  for (const d of doc.cache.drawables) renderer.free(d.gl);
  const list = [];
  const dens = doc.data.mesh.density;
  const make = (id, canvases, alpha, w, h, T) => {
    const mesh = Mesh.build(alpha, w, h, dens);
    if (!mesh.vertexCount) return;
    const R = Math.ceil(Math.max(w, h) / dens * 2.5);
    mesh.sample = new Float32Array(mesh.rest.length);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const vx = Math.min(w - 1, Math.round(mesh.rest[v * 2])), vy = Math.min(h - 1, Math.round(mesh.rest[v * 2 + 1]));
      let bx = vx, by = vy;
      if (alpha[vy * w + vx] < 40) {
        let bd = Infinity;
        for (let y = Math.max(0, vy - R); y <= Math.min(h - 1, vy + R); y++) for (let x = Math.max(0, vx - R); x <= Math.min(w - 1, vx + R); x++) {
          if (alpha[y * w + x] < 40) continue;
          const d = (x - vx) ** 2 + (y - vy) ** 2;
          if (d < bd) { bd = d; bx = x; by = y; }
        }
      }
      const s = aApply(T, bx, by);
      mesh.sample[v * 2] = s[0]; mesh.sample[v * 2 + 1] = s[1];
      const r = aApply(T, mesh.rest[v * 2], mesh.rest[v * 2 + 1]);
      mesh.rest[v * 2] = r[0]; mesh.rest[v * 2 + 1] = r[1];
    }
    list.push({ id, mesh, alpha, w, h, T, Tinv: aInv(T), canvas: canvases[0], gl: renderer.createDrawable(canvases, mesh), pos: new Float32Array(mesh.rest.length), wbuf: new Float32Array(mesh.vertexCount), partIds: [], idx: null, wt: null });
  };
  for (const n of doc.data.nodes) {
    if (n.type !== 'image') continue;
    const a = doc.assets.get(n.image.assetId);
    if (!a) continue;
    const { w, h } = a, N = w * h, T = layerAffine(n.image, a);
    let rgba = a.rgba, alpha = a.alpha, canvas = a.canvas;
    const c = n.image.crop;
    if (c) {
      rgba = new Uint8ClampedArray(a.rgba); alpha = new Uint8Array(a.alpha);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < c.x0 || x >= c.x1 || y < c.y0 || y >= c.y1) { alpha[y * w + x] = 0; rgba[(y * w + x) * 4 + 3] = 0; }
      canvas = ImgProc.toCanvas(rgba, w, h);
    }
    // 子部位優先：同一個像素只屬於最深層的獨立部位（父層不會把子部位的像素一起帶走）
    const depthOf = d => { let k = 0; for (let p = d; p && p.parent; p = Model.byId(doc.data, p.parent)) k++; return k; };
    const dets = doc.data.nodes.filter(d => d.detach && Model.isDrawable(d) && d.type !== 'image' && Model.imageOf(doc.data, d) === n)
      .sort((a, b) => depthOf(b) - depthOf(a));
    const pieces = [];
    if (dets.length) {
      const base = new Uint8ClampedArray(rgba), cut = new Float32Array(N);
      const ident = T[0] === 1 && T[1] === 0 && T[2] === 0 && T[3] === 1;
      for (const d of dets) {
        const smp = detachSampler(doc, d);
        if (!smp) continue;
        const prgba = new Uint8ClampedArray(N * 4), pm = new Float32Array(N);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!alpha[i]) continue;
          const X = ident ? x + T[4] : T[0] * x + T[2] * y + T[4], Y = ident ? y + T[5] : T[1] * x + T[3] * y + T[5];
          let m = smp(X, Y);
          if (m <= 0.002) continue;
          // 放在後方的部位：底圖只在確定屬於部位的地方挖空，避免把前面東西的邊緣一起切走
          if (d.order < n.order) { if (m < 0.5) continue; m = 1; }
          m = Math.min(m, 1 - cut[i]);
          if (m <= 0.002) continue;
          pm[i] = m;
          prgba[i * 4] = rgba[i * 4]; prgba[i * 4 + 1] = rgba[i * 4 + 1]; prgba[i * 4 + 2] = rgba[i * 4 + 2]; prgba[i * 4 + 3] = alpha[i] * m;
          cut[i] += m;
        }
        pieces.push({ d, pm, rgba: prgba });
      }
      for (let i = 0; i < N; i++) if (cut[i]) base[i * 4 + 3] = alpha[i] * (1 - cut[i]);
      const M = Math.max(w, h);
      const bandOf = d => Math.max(0, Math.round(d.fillBand ?? M * 0.04));
      // 補色只做在上下層交界的一條帶子：顏色 = 兩邊顏色平均，只在原圖不透明的範圍內，帶子末端漸淡
      const seam = (dst, known, target, R, otherAt) => {
        if (R < 1) return;
        const layer = new Uint16Array(N);
        const tmp = new Uint8ClampedArray(dst);
        ImgProc.fill(tmp, w, h, known, target, R, layer);
        const fade = Math.max(1, R * 0.35);
        for (let i = 0; i < N; i++) {
          if (!layer[i]) continue;
          const o = i * 4, q = otherAt(i);
          dst[o] = (tmp[o] + q[0]) / 2; dst[o + 1] = (tmp[o + 1] + q[1]) / 2; dst[o + 2] = (tmp[o + 2] + q[2]) / 2;
          const k = Math.min(1, (R + 1 - layer[i]) / fade);
          dst[o + 3] = Math.max(dst[o + 3], alpha[i] * k);
        }
      };
      const orig = i => [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
      for (const p of pieces) {
        const kn = new Uint8Array(N), tg = new Uint8Array(N);
        if (p.d.order > n.order) {
          // 部位在前方：從底圖往被挖掉的洞裡補一條帶子（與部位本身的顏色平均）
          for (let i = 0; i < N; i++) { kn[i] = base[i * 4 + 3] > 20 && p.pm[i] < 0.5 ? 1 : 0; tg[i] = p.pm[i] >= 0.5 && alpha[i] ? 1 : 0; }
          seam(base, kn, tg, bandOf(p.d), orig);
        } else {
          // 部位在後方：部位顏色往底圖下方延伸一條帶子（與上層底圖的顏色平均）
          for (let i = 0; i < N; i++) { kn[i] = p.pm[i] > 0.5 ? 1 : 0; tg[i] = !kn[i] && alpha[i] > 0 && cut[i] < 0.5 ? 1 : 0; }
          seam(p.rgba, kn, tg, bandOf(p.d), orig);
        }
      }
      canvas = ImgProc.toCanvas(base, w, h);
      alpha = new Uint8Array(N);
      for (let i = 0; i < N; i++) alpha[i] = base[i * 4 + 3];
    }
    const canvases = [canvas];
    let union = alpha;
    for (const v of n.image.variants) {
      const va = doc.assets.get(v.assetId);
      if (!va) continue;
      let vc = va.canvas, valpha = va.alpha;
      if (va.w !== w || va.h !== h) {
        vc = document.createElement('canvas'); vc.width = w; vc.height = h;
        vc.getContext('2d').drawImage(va.canvas, 0, 0, w, h);
        const dd = vc.getContext('2d').getImageData(0, 0, w, h).data;
        valpha = new Uint8Array(N);
        for (let i = 0; i < N; i++) valpha[i] = dd[i * 4 + 3];
      }
      canvases.push(vc);
      if (union === alpha) union = new Uint8Array(alpha);
      for (let i = 0; i < N; i++) if (valpha[i] > union[i]) union[i] = valpha[i];
    }
    // 眨眼：各閉合程度的圖接在差分後面
    let blinkN = 0;
    if (n.blink && n.blink.on) {
      const lv = blinkLevels(doc, n, canvas.getContext('2d').getImageData(0, 0, w, h).data, w, h);
      if (lv) {
        blinkN = lv.length;
        for (const cv of lv) {
          canvases.push(cv);
          const dd = cv.getContext('2d').getImageData(0, 0, w, h).data;
          if (union === alpha) union = new Uint8Array(alpha);
          for (let i = 0; i < N; i++) if (dd[i * 4 + 3] > union[i]) union[i] = dd[i * 4 + 3];
        }
      }
    }
    make(n.id, canvases, union, w, h, T);
    if (blinkN && list.length && list[list.length - 1].id === n.id) list[list.length - 1].blinkN = blinkN;
    for (const p of pieces) {
      const al = new Uint8Array(N);
      for (let i = 0; i < N; i++) al[i] = p.rgba[i * 4 + 3];
      make(p.d.id, [ImgProc.toCanvas(p.rgba, w, h)], al, w, h, T);
    }
  }
  doc.cache.drawables = list;
  doc.cache.iSig = '';
}

function inflSig(doc) {
  return JSON.stringify([doc.cache.sSig, doc.data.nodes.map(n => [
    n.id, n.parent, n.type, n.detach, n.pins.map(p => [p.x, p.y]),
    n.region && [n.region.mode, n.region.radius, n.region.soft, n.region.feather, n.region.maskId && (doc.masks.get(n.region.maskId) || {}).v],
  ])]);
}
function computeInfluences(doc) {
  const mk = makeMk(doc);
  for (const dr of doc.cache.drawables) {
    const owner = Model.byId(doc.data, dr.id);
    if (!owner) continue;
    const parts = Model.participants(doc.data, owner);
    dr.partIds = [owner.id, ...parts.map(p => p.id)];
    const n = dr.mesh.vertexCount, idx = new Uint16Array(n * K), wt = new Float32Array(n * K);
    const acc = new Float64Array(parts.length + 1);
    for (let v = 0; v < n; v++) {
      Model.allocate(parts, dr.mesh.sample[v * 2], dr.mesh.sample[v * 2 + 1], mk, acc);
      const ord = Array.from(acc.keys()).filter(i => acc[i] > 1e-4).sort((a, b) => acc[b] - acc[a]).slice(0, K);
      let sum = 0;
      for (const o of ord) sum += acc[o];
      ord.forEach((o, k) => { idx[v * K + k] = o; wt[v * K + k] = acc[o] / sum; });
    }
    dr.idx = idx; dr.wt = wt;
    // 交界頂點（受多個部位影響）與鄰接表：每幀在交界處平滑位移，避免擠壓摺疊
    const mixed = new Uint8Array(n);
    for (let v = 0; v < n; v++) if (wt[v * K] < 0.985) mixed[v] = 1;
    const nb = Array.from({ length: n }, () => new Set());
    const ix = dr.mesh.idx;
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i], b = ix[i + 1], c = ix[i + 2];
      nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
    }
    const start = new Uint32Array(n + 1), list = [];
    for (let v = 0; v < n; v++) { start[v] = list.length; if (mixed[v]) for (const u of nb[v]) list.push(u); }
    start[n] = list.length;
    dr.mixed = mixed; dr.nbStart = start; dr.nbList = Uint32Array.from(list);
    dr.disp = new Float32Array(n * 2); dr.disp2 = new Float32Array(n * 2);
  }
}
function relax(dr, out) {
  const n = dr.mesh.vertexCount, rest = dr.mesh.rest, st = dr.nbStart, ls = dr.nbList;
  let a = dr.disp, b = dr.disp2;
  for (let i = 0; i < n * 2; i++) a[i] = out[i] - rest[i];
  for (let it = 0; it < 4; it++) {
    for (let v = 0; v < n; v++) {
      if (!dr.mixed[v] || st[v + 1] === st[v]) { b[v * 2] = a[v * 2]; b[v * 2 + 1] = a[v * 2 + 1]; continue; }
      let sx = 0, sy = 0;
      for (let j = st[v]; j < st[v + 1]; j++) { sx += a[ls[j] * 2]; sy += a[ls[j] * 2 + 1]; }
      const c = st[v + 1] - st[v];
      b[v * 2] = 0.5 * a[v * 2] + 0.5 * sx / c;
      b[v * 2 + 1] = 0.5 * a[v * 2 + 1] + 0.5 * sy / c;
    }
    [a, b] = [b, a];
  }
  for (let i = 0; i < n * 2; i++) out[i] = rest[i] + a[i];
}
function ensureDerived(doc, allowRebuild = true) {
  const s = structSig(doc);
  if (s !== doc.cache.sSig && allowRebuild) { doc.cache.sSig = s; rebuildDrawables(doc); }
  const i = inflSig(doc);
  if (i !== doc.cache.iSig) { doc.cache.iSig = i; computeInfluences(doc); }
}
function orderedDrawables(doc) {
  return doc.cache.drawables.filter(d => Model.byId(doc.data, d.id)).sort((a, b) => Model.byId(doc.data, a.id).order - Model.byId(doc.data, b.id).order);
}
function pickAt(doc, x, y) {
  const mk = makeMk(doc);
  for (const dr of orderedDrawables(doc).reverse()) {
    const owner = Model.byId(doc.data, dr.id);
    if (!Model.isShown(doc.data, owner)) continue;
    const [lx, ly] = aApply(dr.Tinv, x, y).map(Math.round);
    if (lx < 0 || ly < 0 || lx >= dr.w || ly >= dr.h || dr.alpha[ly * dr.w + lx] < 30) continue;
    const parts = Model.participants(doc.data, owner);
    const acc = Model.allocate(parts, x, y, mk, new Float64Array(parts.length + 1));
    let bi = 0;
    for (let i = 1; i < acc.length; i++) if (acc[i] > acc[bi]) bi = i;
    return bi ? parts[bi - 1] : owner;
  }
  return null;
}

// ---------- 歷史紀錄 ----------
function snapshot() { return { json: JSON.stringify(D.data), masks: new Map(D.masks) }; }
function resetHistory(doc = D) { doc.history = { stack: [{ json: JSON.stringify(doc.data), masks: new Map(doc.masks) }], idx: 0 }; if (doc === D) updateUndo(); }
const sameMasks = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
function commit() {
  if (!D) return;
  const H = D.history, s = snapshot(), cur = H.stack[H.idx];
  if (cur && cur.json === s.json && sameMasks(cur.masks, s.masks)) return;
  H.stack.length = H.idx + 1;
  H.stack.push(s);
  if (H.stack.length > 100) H.stack.shift();
  H.idx = H.stack.length - 1;
  updateUndo(); renderTree(); renderOrder();
}
function restore(s) { D.data = JSON.parse(s.json); D.masks = new Map(s.masks); if (!node(D.ui.sel)) D.ui.sel = 'root'; renderAll(); }
function undo() { if (wiz) { wizUndo(); return; } if (D && D.history.idx > 0) { D.history.idx--; restore(D.history.stack[D.history.idx]); updateUndo(); } }
function redo() { if (D && D.history.idx < D.history.stack.length - 1) { D.history.idx++; restore(D.history.stack[D.history.idx]); updateUndo(); } }
function updateUndo() {
  $('#btnUndo').disabled = !D || D.history.idx <= 0;
  $('#btnRedo').disabled = !D || D.history.idx >= D.history.stack.length - 1;
}

// ---------- 分頁 ----------
// 窄螢幕（手機）：開任何檔案都先用簡易模式
const APP_VERSION = '1.0.8';
const isNarrow = () => matchMedia('(max-width: 760px)').matches;
function openDoc(doc) { if (isNarrow()) doc.ui.simple = true; tabs.push(doc); switchTab(doc); hideHome(); }
function switchTab(doc) {
  if (D) { D.ui.playing = false; }
  D = doc;
  if (D) { D.ui.mode = 'edit'; D.ui.playing = false; D.ui.frame = 0; fitView(); }
  $('#dropHint').classList.toggle('hidden', !!D);
  applyModeClass();
  placeLayerPanel();
  renderTabs(); renderAll(); updateUndo();
  resize();
}
function closeTab(doc) {
  const i = tabs.indexOf(doc);
  if (i < 0) return;
  for (const d of doc.cache.drawables) renderer.free(d.gl);
  tabs.splice(i, 1);
  if (D === doc) { D = null; switchTab(tabs[Math.min(i, tabs.length - 1)] || null); }
  else renderTabs();
  if (!tabs.length) showHome();
}
function renderTabs() {
  const bar = $('#tabbar');
  bar.innerHTML = '';
  for (const t of tabs) {
    const name = el('span', { class: 'tname', title: t.name }, t.name);
    const tab = el('div', { class: 'tab' + (t === D ? ' on' : ''), onclick: () => { if (t !== D) switchTab(t); } },
      name, el('span', { class: 'x', title: '關閉', onclick: e => { e.stopPropagation(); closeTab(t); } }, ico('close')));
    name.addEventListener('dblclick', () => {
      const inp = el('input', { type: 'text', value: t.name });
      name.replaceWith(inp); inp.focus(); inp.select();
      inp.addEventListener('blur', () => { t.name = inp.value.trim() || t.name; renderTabs(); });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = t.name; inp.blur(); } });
    });
    bar.append(tab);
  }
  bar.append(el('label', { class: 'tb icon', title: '開啟圖片或 PSD（新分頁）', style: 'margin:0 0 2px 4px' }, ico('plus'),
    el('input', { type: 'file', accept: OPEN_ACCEPT, multiple: 'multiple', hidden: 'hidden', onchange: e => { openFiles([...e.target.files]); e.target.value = ''; } })));
}

// ---------- 滴管 ----------
// 支援 EyeDropper 的瀏覽器：直接在螢幕上吸色，吸完就結束；否則改成「點一下畫面吸色」
function startColorPick() {
  if (window.EyeDropper) {
    new EyeDropper().open().then(r => { setPaintColor(r.sRGBHex); }).catch(() => { /* 取消 */ });
    return;
  }
  tool.picking = !tool.picking;
  renderToolDetail();
}
function setPaintColor(hex) { tool.paintColor = hex; tool.picking = false; renderToolDetail(); }
// 畫面上 (mx, my) 的顏色（預覽畫布，不含疊加的把手）；透明回傳 null
function stageColorAt(mx, my) {
  const gl = renderer.canvas, c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d');
  g.drawImage(gl, Math.round(mx * view.dpr), Math.round(my * view.dpr), 1, 1, 0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  if (d[3] < 8) return null;
  const h = v => v.toString(16).padStart(2, '0');
  return '#' + h(d[0]) + h(d[1]) + h(d[2]);
}

// ---------- 開檔 ----------
// 開檔對話框的檔案類型（用副檔名列出，Windows 的檔案類型篩選才會包含專案檔）
const OPEN_ACCEPT = '.apng,.png,.jpg,.jpeg,.webp,.gif,.psd,.puppet';
function readImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { res(img); URL.revokeObjectURL(url); };
    img.onerror = () => { rej(new Error('無法讀取')); URL.revokeObjectURL(url); };
    img.src = url;
  });
}
const baseName = f => f.name.replace(/\.[^.]+$/, '');
const isPSD = f => /\.psd$/i.test(f.name);

// 把 PSD 的圖層樹放進文件（items：由下往上）
// 匯入 PSD 時，不支援的混合模式要怎麼處理：{ mode: 'keep' | 'skip' }（keep = 用正常模式導入）
let psdSkip = null;
function psdUnsupported(items, out = []) {
  for (const it of items) {
    if (it.type === 'group') psdUnsupported(it.children, out);
    else if (it.blend && !PSD_BLEND[it.blend]) out.push(`${it.name}（${PSD_BLEND_NAME[it.blend] || it.blend}）`);
  }
  return out;
}
function askPSD(list) {
  return new Promise(res => {
    const body = el('div', { class: 'dbody' },
      el('div', { class: 'note' }, '這個 PSD 有些圖層用了目前不支援的混合模式（色相、飽和度、顏色、明度、小光源、實色疊印、溶解等）；其他混合模式與剪裁遮色片都支援：'),
      el('div', { class: 'hint', style: 'max-height:160px;overflow:auto' }, list.join('、')));
    const close = openDialog('匯入 PSD', body, [
      el('button', { class: 'btn', onclick: () => { close(); res('skip'); } }, '忽略這些圖層'),
      el('button', { class: 'btn primary', onclick: () => { close(); res('keep'); } }, '照原樣導入（用正常模式）')]);
  });
}
function addPSDTree(doc, items, parentId, lg, nested) {
  const level = [];
  for (const it of items) {
    if (it.type === 'group') {
      // PSD 的資料夾 → 圖層群組（只綁定前後順序；圖層仍掛在同一個父層底下）
      const g = { id: Model.uid('lg_'), name: it.name, collapsed: false, visible: !it.hidden, opacity: 1, enabled: true };
      (doc.data.lgroups || (doc.data.lgroups = [])).push(g);
      level.push(...addPSDTree(doc, it.children, parentId, g.id, true));
      continue;
    } else {
      if (it.blend && !PSD_BLEND[it.blend] && psdSkip && psdSkip.mode === 'skip') continue;
      const aid = addAsset(doc, it.name, it.canvas, true);
      if (!aid) continue;
      const n = Model.makeNode(doc.data, 'image', parentId, { name: it.name, visible: !it.hidden, order: nextOrder(doc), image: { assetId: aid, x: it.left, y: it.top, scale: 1, rot: 0, crop: null, variants: [] } });
      const bm = PSD_BLEND[it.blend];
      if (bm && bm !== 'normal') n.blend = bm;
      if (it.clip) n.clip = true;

      if (lg) n.lg = lg;
      doc.data.nodes.push(n);
      level.push(n);
    }
  }
  if (nested) return level;   // 資料夾裡的圖層：交給最外層一起排
  // 同層在列表中：上方 = 前方
  for (const n of level) doc.data.nodes.splice(doc.data.nodes.indexOf(n), 1);
  const at = doc.data.nodes.length;
  doc.data.nodes.splice(at, 0, ...level.reverse());
  return level;
}
// 專案縮圖：作品目前（靜止）的樣子，長邊最多 512 px
function projectThumb() {
  const k = Math.min(1, 512 / Math.max(D.data.width, D.data.height)), W = Math.max(1, Math.round(D.data.width * k)), H = Math.max(1, Math.round(D.data.height * k));
  renderer.begin(W, H);
  drawScene(0, false, [k, 0, 0, k, 0, 0], W, H, null);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').drawImage(renderer.canvas, 0, 0);
  return c;
}
// 手機（觸控）：用系統的「分享」（可以存到相簿 / 檔案 / 傳給別人）；不支援或被擋（太久沒點到畫面）時改用下載 / 再點一次分享
const isTouch = () => matchMedia('(pointer: coarse)').matches;
function saveBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (!(isTouch() && navigator.canShare && navigator.canShare({ files: [file] }))) { Exporter.download(blob, name); return; }
  navigator.share({ files: [file], title: name }).catch(err => {
    if (err && err.name === 'AbortError') return;
    // 處理太久，瀏覽器不讓直接跳分享：給一個按鈕再點一次
    const body = el('div', { class: 'dbody' }, el('div', { class: 'note' }, name));
    const close = openDialog('完成', body, [
      el('button', { class: 'btn', onclick: () => { close(); Exporter.download(blob, name); } }, '下載'),
      el('button', { class: 'btn primary', onclick: () => { close(); navigator.share({ files: [file], title: name }).catch(() => {}); } }, '分享 / 儲存')]);
  });
}
// 專案檔名 → 作品名稱（去掉 .彈design.png / .puppet 等副檔名）
const projName = fn => fn.replace(/_tan\.a?png$/i, '').replace(/\.a?png$/i, '').replace(/\.(彈design|puppet)$/i, '').replace(/\.(jpe?g|webp|gif|psd)$/i, '') || fn;
// 專案的動態預覽（APNG）：長邊 240px、每秒 10 格、播一次完整時間軸；看圖軟體 / 瀏覽器直接看得到動作
async function projectAnim() {
  const k = Math.min(1, 240 / Math.max(D.data.width, D.data.height)), W = Math.max(1, Math.round(D.data.width * k)), H = Math.max(1, Math.round(D.data.height * k));
  const fps = 10, Tt = total(), frames = Math.max(2, Math.min(60, Math.round(Tt / D.data.timeline.fps * fps)));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  ensureDerived(D);
  return Exporter.apng({ width: W, height: H, frames, fps, loops: 0, progress: () => {}, cancelled: () => false,
    framePng: f => {
      const t = f * Tt / frames;
      renderer.begin(W, H);
      drawScene(t, true, aMul([k, 0, 0, k, 0, 0], Model.globalAffine(D.data, t)), W, H, null);
      g.clearRect(0, 0, W, H); g.drawImage(renderer.canvas, 0, 0);
      const bin = atob(c.toDataURL('image/png').split(',')[1]), d = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
      return d;
    } });
}
// 儲存：瀏覽器支援時跳出存檔視窗，選的檔名就是作品名稱（分頁跟著改）；之後 Ctrl+S 直接覆寫同一個檔案；另存新檔 = 重新選
async function saveProject(as) {
  if (!D) return;
  const doc = D, fname = `${doc.name.replace(/[\\/:*?"<>|]/g, '_')}_tan.png`;
  try {
    if (window.showSaveFilePicker) {
      let h = as === true ? null : doc.fileHandle;
      if (!h) {
        try { h = await window.showSaveFilePicker({ suggestedName: fname, types: [{ description: '彈design 專案', accept: { 'image/png': ['.png'] } }] }); }
        catch (e) { if (e.name === 'AbortError') return; throw e; }
      }
      doc.fileHandle = h;
      doc.name = projName(h.name);
      renderTabs();
      const blob = await Project.save(doc, projectThumb());
      const w = await h.createWritable();
      await w.write(blob); await w.close();
      rememberRecent(doc, blob);
      toast(`已儲存「${h.name}」`, 'info');
    } else {
      const blob = await Project.save(doc, projectThumb());
      saveBlob(blob, fname);
      rememberRecent(doc, blob);
      toast('已儲存專案', 'info');
    }
  } catch (e) { toast('儲存失敗：' + e.message, 'error'); }
}
async function openProject(f, noRecent) {
  const p = await Project.load(await f.arrayBuffer());
  const doc = newDoc(projName(f.name) || p.name);   // 作品名稱跟著檔名
  doc.data = p.data;
  for (const [id, c] of p.assets) {
    const w = c.width, h = c.height, rgba = c.getContext('2d').getImageData(0, 0, w, h).data, alpha = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = rgba[i * 4 + 3];
    doc.assets.set(id, { canvas: c, rgba, alpha, w, h });
  }
  for (const [id, m] of p.masks) doc.masks.set(id, { ...m, v: ++maskVer });
  const miss = doc.data.nodes.filter(n => n.image && !doc.assets.get(n.image.assetId));
  if (miss.length) toast(`有 ${miss.length} 個圖層的圖片遺失`, 'warn');
  resetHistory(doc);
  openDoc(doc);
  if (!noRecent) rememberRecent(doc, f);
}
async function openFiles(files) {
  for (const f of files) {
    try {
      if (/\.puppet$/i.test(f.name) || (/\.a?png$/i.test(f.name) && Project.isProject(await f.arrayBuffer()))) { await openProject(f); continue; }
      const doc = newDoc(baseName(f));
      if (isPSD(f)) {
        const psd = await PSD.parse(await f.arrayBuffer());
        doc.data.width = psd.width; doc.data.height = psd.height;
        doc.psdFlatten = psd.flatten;   // 單圖層快速建立時用：繪圖軟體存的合併影像（沒有就自己疊）
        // 不支援的混合模式：問要照原樣導入還是忽略（單圖層快速建立會整張壓平，不用問）
        const bad = newFlow === 'single' ? [] : psdUnsupported(psd.children);
        psdSkip = bad.length ? { mode: await askPSD(bad) } : null;
        addPSDTree(doc, psd.children, 'root');
        psdSkip = null;
        if (!doc.data.nodes.some(n => n.type === 'image')) throw new Error('沒有可用的像素圖層');
      } else {
        if (!/^image\//.test(f.type)) throw new Error('不是圖片檔');
        const aid = addAsset(doc, baseName(f), await readImage(f));
        if (!aid) continue;
        doc.ui.sel = addImageNode(doc, aid, baseName(f)).id;
      }
      updateRootPivot(doc);
      resetHistory(doc);
      openDoc(doc);
    } catch (e) { toast(`「${f.name}」${e.message}`, 'error'); }
  }
}
async function addLayers(files) {
  if (!D) { openFiles(files); return; }
  const s = sel();
  const parent = s && s.type !== 'root' ? s.id : 'root';
  let last = null;
  for (const f of files) {
    try {
      if (isPSD(f)) {
        const psd = await PSD.parse(await f.arrayBuffer());
        const g = Model.makeNode(D.data, 'group', parent, { name: baseName(f) });
        D.data.nodes.push(g);
        addPSDTree(D, psd.children, g.id);
        last = g;
      } else {
        const aid = addAsset(D, baseName(f), await readImage(f));
        if (aid) last = addImageNode(D, aid, baseName(f), parent);
      }
    } catch (e) { toast(`「${f.name}」${e.message}`, 'error'); }
  }
  if (last) { D.ui.sel = last.id; updateRootPivot(D); commit(); renderAll(); }
}
const VAR_MODES = { cut: '直接', fade: '淡入', pop: '彈入' };
// 差分出現的時段：v.segs = [[開始幀, 結束幀], …]（舊資料的 from / to 轉成一段）
function segsOf(v) {
  if (!v.segs) { v.segs = v.from != null ? [[v.from, v.to]] : []; delete v.from; delete v.to; }
  return v.segs;
}
function addVarSeg(v, f) {
  const M = Math.round(total()), segs = segsOf(v);
  const hit = segs.findIndex(([a, b]) => f >= a && f < b);
  if (hit >= 0) { segs.splice(hit, 1); return; }   // 播放頭在某一段裡：刪掉那一段
  const next = Math.min(M, ...segs.map(([a]) => a).filter(a => a > f));
  segs.push([f, Math.max(f + 1, Math.min(next, f + 12))]);
  segs.sort((a, b) => a[0] - b[0]);
}
async function addVariant(file) {
  const n = sel();
  if (!n || n.type !== 'image' || !file) return;
  try {
    const aid = addAsset(D, baseName(file), await readImage(file));
    if (!aid) return;
    const T = Math.round(total()), from = Math.min(T - 2, Math.round(D.ui.frame) % T);
    n.image.variants.push({ id: Model.uid('v_'), assetId: aid, name: baseName(file), segs: [[from, Math.min(T, from + 12)]], mode: 'cut' });
    commit(); renderAll();
    if (!timelineOn) toggleTimeline(true);
  } catch (e) { toast(e.message, 'error'); }
}
async function openSample(key) {
  const s = Demo.samples[key];
  if (!s) return;
  const src = await s.source();
  // 專案檔範例：跟開啟專案一樣
  if (s.project) { await openProject(new File([src], s.label + '.彈design.png'), true); return; }
  const doc = newDoc(s.label);
  if (s.psd) {
    const psd = await PSD.parse(src);
    doc.data.width = psd.width; doc.data.height = psd.height;
    addPSDTree(doc, psd.children, 'root');
    updateRootPivot(doc);
    resetHistory(doc);
    openDoc(doc);
    s.build({ data: doc.data, autoBind, createRig });
    resetHistory(doc);
    return;
  }
  const aid = addAsset(doc, s.label, src, true);
  const img = addImageNode(doc, aid, s.label);
  s.build({ data: doc.data, image: img, addPart: (...a) => addPart(doc, ...a), paintMask: (n, p) => paintMask(doc, n, p, false, true) });
  updateRootPivot(doc);
  resetHistory(doc);
  openDoc(doc);
  if (s.rigHost) { const h = doc.data.nodes.find(n => n.name === s.rigHost); if (h) { ensureDerived(doc); createRig(h); resetHistory(doc); renderAll(); } }
}

// ---------- 取代底圖（對齊模式） ----------
let replaceTarget = null;
function startReplace(n) { replaceTarget = n; $('#fileReplace').click(); }
async function replaceFile(file) {
  const n = replaceTarget;
  if (!n || !file) return;
  try {
    const aid = addAsset(D, baseName(file), await readImage(file));
    if (!aid) return;
    const oldA = D.assets.get(n.image.assetId), newA = D.assets.get(aid);
    const Told = layerAffine(n.image, oldA);
    const c = aApply(Told, oldA.w / 2, oldA.h / 2);
    const scale = (n.image.scale ?? 1) * oldA.w / newA.w;
    D.ui.align = { nodeId: n.id, assetId: aid, x: c[0] - newA.w / 2, y: c[1] - newA.h / 2, scale, rot: n.image.rot || 0, opacity: 0.5 };
    buildAlignDrawable();
    setMode('edit');
    setTool('transform');
  } catch (e) { toast(e.message, 'error'); }
}
function buildAlignDrawable() {
  if (D.cache.alignDr) { renderer.free(D.cache.alignDr.gl); D.cache.alignDr = null; }
  const al = D.ui.align;
  if (!al) return;
  const a = D.assets.get(al.assetId);
  const mesh = Mesh.build(a.alpha, a.w, a.h, 24);
  D.cache.alignDr = { gl: renderer.createDrawable([a.canvas], mesh), mesh, pos: new Float32Array(mesh.rest.length) };
}
function finishAlign(ok) {
  const al = D.ui.align;
  if (!al) return;
  if (ok) {
    const n = node(al.nodeId);
    Object.assign(n.image, { assetId: al.assetId, x: al.x, y: al.y, scale: al.scale, rot: al.rot, crop: null });
    D.ui.align = null;
    commit();
  } else D.ui.align = null;
  buildAlignDrawable();
  renderAll();
}

// ---------- 視角 ----------
function fitView() {
  if (!D || !D.data.width) return;
  D.ui.base = Math.min((view.cw - 60) / D.data.width, (view.ch - 60) / D.data.height);
  D.ui.zoom = 1; D.ui.panX = 0; D.ui.panY = 0;
}
function viewAffine() {
  const u = D.ui, s = u.base * u.zoom;
  return [s, 0, 0, s, view.cw / 2 - D.data.width * s / 2 + u.panX, view.ch / 2 - D.data.height * s / 2 + u.panY];
}
function resize() {
  const r = $('#stage').getBoundingClientRect();
  view.cw = Math.max(1, r.width); view.ch = Math.max(1, r.height);
  view.dpr = Math.min(2, window.devicePixelRatio || 1);   // 手機 3 倍螢幕：最多畫 2 倍（省電、不卡）
  const o = $('#overlay'), W = Math.round(view.cw * view.dpr), H = Math.round(view.ch * view.dpr);
  if (o.width !== W || o.height !== H) { o.width = W; o.height = H; }
  if (D && D.ui.zoom === 1 && !D.ui.panX && !D.ui.panY) fitView();
}

// ---------- 繪製 ----------
let last = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!exporting) {
    if (D && D.ui.playing && D.ui.mode === 'preview') {
      D.ui.frame = Anim.mod(D.ui.frame + dt * D.data.timeline.fps * speed, total());
      updatePlaybar();
    }
    draw();
    drawWave();
  }
  requestAnimationFrame(tick);
}

// 畫出所有繪製物件；回傳本幀的求值資料
// ---------- HeadRig（頭部骨架）----------
// 每個 rig 的網格目標：單張圖 = 頭部位本身；分層 = 臉底圖層（baked 五官）
function rigHosts() { return D.data.nodes.filter(n => HeadRig.active(n.rig)); }
function rigTarget(host) { const fb = host.rig.members.find(m => m.role === 'face_base' && m.ref); return fb ? fb.ref : host.id; }
function rigSig(rig) { return JSON.stringify(rig.members.map(m => [m.role, m.side, m.marker, m.size, m.fade, m.ref])); }
// 取得（必要時重算）某張網格上這個 rig 的位移場預算資料
function rigMeshFor(dr, host) {
  const tg = rigTarget(host), k = dr.partIds.indexOf(tg);
  if (k < 0) return null;
  const key = rigSig(host.rig) + '|' + D.cache.iSig;
  dr.rigM = dr.rigM || {};
  const c = dr.rigM[host.id];
  if (c && c.key === key) return c.M;
  const n = dr.mesh.vertexCount;
  const weightOf = v => { let s = 0; for (let j = 0; j < K; j++) if (dr.idx[v * K + j] === k) s += dr.wt[v * K + j]; return s; };
  const M = HeadRig.buildMesh(host.rig, dr.mesh.rest, n, weightOf);
  dr.rigM[host.id] = { key, M };
  return M;
}
// 每幀的 rig 狀態：{ host, F, legacy }
function rigFrames(t) {
  const out = [];
  for (const host of rigHosts()) {
    const F = Model.rigFrame(D.data, host, t);
    if (!F) continue;
    out.push({ host, F });
  }
  return out;
}

function drawScene(t, animate, M, cw, ch, overlaySel) {
  ensureDerived(D, !drag);
  P3D.setMaps(D.masks);
  HeadRig.setBounds(id => { const n = node(id); return n ? rigBounds(n) : null; });
  const evals = Model.buildEvals(D.data, t, animate);
  let drs = orderedDrawables(D);
  const RF = animate ? rigFrames(t) : [];
  // 關鍵影格：前後順序（z）與透明度（只在播放 / 預覽時）
  const keyed = animate && !P3D.probe;
  // 圖層不透明度（靜態） × 關鍵影格的透明度
  const alphaOf = dr => { const o = node(dr.id), gl = o.lg && D.data.lgroups && D.data.lgroups.find(g => g.id === o.lg), base = (o.opacity ?? 1) * (gl ? gl.opacity ?? 1 : 1); if (!keyed) return base; return base * (Model.hasKeys(o) ? Math.max(0, Math.min(1, Model.keyVal(D.data, o, 'op', t))) * Model.zFade(D.data, o, t) : 1); };
  const zOf = dr => { const o = node(dr.id); return o.order + (keyed && Model.hasKeys(o) ? Model.keyVal(D.data, o, 'z', t) : 0); };
  // HeadRig 的前後與透明度（遠側側髮到臉底下、遠側耳淡出）
  const rs = new Map();
  for (const R of RF) for (const [id, st] of HeadRig.drawState(R.F, id => node(id)?.order ?? 0)) rs.set(id, { ...(rs.get(id) || {}), ...st });
  const posOf = new Map(), list = [], later = [];
  for (const dr of drs) {
    const owner = node(dr.id);
    if (!Model.isShown(D.data, owner) || !dr.idx) continue;
    // 從圖上圈出來的眼睛：完全照原圖的變形走（之後再算）
    if (owner.fromHost && node(owner.fromHost)) { later.push(dr); continue; }
    let pos = dr.mesh.rest;
    if (animate) {
      const parts = dr.partIds.map(id => evals.get(id));
      const rest = dr.mesh.rest, out = dr.pos, n = dr.mesh.vertexCount;
      // HeadRig 位移場：加在所有變形之前（頭剛性變換之前）
      let off = null;
      for (const R of RF) {
        const Mr = rigMeshFor(dr, R.host);
        if (!Mr) continue;
        const o = HeadRig.meshOffsets(R.F, Mr, n, rest);
        if (o) { if (!off) off = o; else for (let i = 0; i < o.length; i++) off[i] += o[i]; }
      }
      for (let v = 0; v < n; v++) {
        const x = rest[v * 2] + (off ? off[v * 2] : 0), y = rest[v * 2 + 1] + (off ? off[v * 2 + 1] : 0);
        let sx = 0, sy = 0;
        for (let k = 0; k < K; k++) {
          const w = dr.wt[v * K + k];
          if (!w) continue;
          const o = Model.applyChain(parts[dr.idx[v * K + k]], x, y);
          sx += w * o[0]; sy += w * o[1];
        }
        out[v * 2] = sx; out[v * 2 + 1] = sy;
      }
      if (dr.mixed) relax(dr, out);
      pos = out;
    }
    posOf.set(dr, pos);
    const st = rs.get(dr.id), a = alphaOf(dr) * (st && st.alpha != null ? st.alpha : 1), z = zOf(dr);
    for (const sl of slotsFor(owner, dr, t, animate, pos)) {
      if (st && st.z2 != null) {
        // 交叉淡化：同時畫在原本與後方兩個位置
        list.push({ dr, pos: sl.pos, slot: sl.slot, z: z + (st.z || 0) + sl.dz, a: a * sl.k * (1 - st.f) });
        list.push({ dr, pos: sl.pos, slot: sl.slot, z: z + st.z2 + sl.dz, a: a * sl.k * st.f });
      } else list.push({ dr, pos: sl.pos, slot: sl.slot, z: z + (st && st.z ? st.z : 0) + sl.dz, a: a * sl.k });
    }
  }
  for (const dr of later) {
    const owner = node(dr.id), host = drs.find(d => d.id === owner.fromHost), hp = host && posOf.get(host);
    if (!hp) continue;
    const pos = animate ? followHost(dr, host, hp) : dr.mesh.rest;
    posOf.set(dr, pos);
    const st = rs.get(host.id) || rs.get(dr.id), a = alphaOf(dr) * (st && st.alpha != null ? st.alpha : 1), z = zOf(dr) + (st && st.z ? st.z : 0);
    for (const sl of slotsFor(owner, dr, t, animate, pos)) list.push({ dr, pos: sl.pos, slot: sl.slot, z: z + sl.dz, a: a * sl.k });
  }
  list.sort((p, q) => p.z - q.z);
  // 整體外框：沿著角色實際的邊緣（合成後的 alpha），不是遮罩
  const OL = D.data.outline, useOL = !!(OL && OL.on && OL.width > 0);
  if (useOL) renderer.beginLayer();
  const clipBase = clipBases(), itemOf = new Map();
  for (const it of list) if (!itemOf.has(it.dr.id)) itemOf.set(it.dr.id, it);
  for (const it of list) {
    if (it.a <= 0.002) continue;
    const o = node(it.dr.id), blend = o && o.type === 'image' ? o.blend : null;
    if (o && o.type === 'image' && o.clip) {
      const bi = itemOf.get(clipBase.get(o.id));
      if (!bi) continue;
      renderer.drawMask(bi.dr.gl, bi.pos, M, cw, ch, bi.slot, 1);
      renderer.draw(it.dr.gl, it.pos, M, cw, ch, it.slot, it.a, { blend, clip: true });
    } else renderer.draw(it.dr.gl, it.pos, M, cw, ch, it.slot, it.a, blend ? { blend } : null);
  }
  if (useOL) renderer.endLayer(rgbOf(OL.color || '#ffffff'), OL.width * Math.hypot(M[0], M[1]) * renderer.canvas.width / cw);
  // 範圍預覽（依頂點權重著色）
  if (overlaySel) {
    const S = overlaySel.multi || Model.descendants(D.data, overlaySel.id);
    const color = rgbOf(overlaySel.color || colorOf(overlaySel));
    for (const [dr, pos] of posOf) {
      const w = dr.wbuf, n = dr.mesh.vertexCount;
      let any = false;
      for (let v = 0; v < n; v++) {
        let s = 0;
        for (let k = 0; k < K; k++) { const ww = dr.wt[v * K + k]; if (ww && S.has(dr.partIds[dr.idx[v * K + k]])) s += ww; }
        w[v] = s; if (s > 0.01) any = true;
      }
      if (any) renderer.drawWeights(dr.gl, pos, w, M, cw, ch, color);
    }
  }
  return evals;
}

// 這一幀要畫哪些貼圖：眨眼（優先）→ 差分（直接 / 淡入 / 彈入）→ 原圖
const VAR_FADE = 4, VAR_POP = 6;
function slotsFor(owner, dr, t, animate, pos) {
  if (dr.blinkN) {
    const pk = D.ui.blinkPeek, b = pk && pk.id === owner.id ? pk.b : animate ? Blink.at(D.data, owner, t) : 0;
    if (b >= 0.03) return [{ slot: Blink.slotOf(owner, b), k: 1, pos, dz: 0 }];
  }
  const vs = owner.type === 'image' && animate ? owner.image.variants : null;
  if (vs && vs.length) {
    const tm = Anim.mod(t, total());
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i], sg = segsOf(v).find(([a, b]) => tm >= a && tm < b);
      if (!sg) continue;
      const vf = sg[0], vt = sg[1];
      const mode = v.mode || 'cut', base = { slot: 0, k: 1, pos, dz: 0 };
      if (mode === 'fade') {
        const k = Math.min(1, (tm - vf) / VAR_FADE, (vt - tm) / VAR_FADE);
        return k >= 1 ? [{ slot: i + 1, k: 1, pos, dz: 0 }] : [base, { slot: i + 1, k: Math.max(0, k), pos, dz: 0.001 }];
      }
      if (mode === 'pop') {
        const q = (tm - vf) / VAR_POP;
        if (q >= 1) return [{ slot: i + 1, k: 1, pos, dz: 0 }];
        // 彈入：從小一點彈到稍大再回到原尺寸，同時很快淡入
        const sc = 1 + 0.2 * Math.sin(Math.PI * q * 1.25) * (1 - q) - 0.15 * (1 - q) ** 3, n = pos.length / 2;
        let cx = 0, cy = 0;
        for (let v2 = 0; v2 < n; v2++) { cx += pos[v2 * 2]; cy += pos[v2 * 2 + 1]; }
        cx /= n; cy /= n;
        const p2 = new Float32Array(pos.length);
        for (let v2 = 0; v2 < n; v2++) { p2[v2 * 2] = cx + (pos[v2 * 2] - cx) * sc; p2[v2 * 2 + 1] = cy + (pos[v2 * 2 + 1] - cy) * sc; }
        return [base, { slot: i + 1, k: Math.min(1, q * 3), pos: p2, dz: 0.001 }];
      }
      return [{ slot: i + 1, k: 1, pos, dz: 0 }];
    }
  }
  return [{ slot: 0, k: 1, pos, dz: 0 }];
}
// 跟著原圖變形：每個頂點記住它落在原圖網格的哪個三角形（重心座標），之後照原圖三角形的變形算位置
function followHost(dr, host, hp) {
  if (!dr.hostMap || dr.hostMap.host !== host) {
    const R = host.mesh.rest, T = host.mesh.idx, E = dr.mesh.rest, n = dr.mesh.vertexCount, map = new Float32Array(n * 6);
    for (let v = 0; v < n; v++) {
      const px = E[v * 2], py = E[v * 2 + 1];
      let best = -1, bd = Infinity, bw = null;
      for (let k = 0; k < T.length; k += 3) {
        const a = T[k], b = T[k + 1], c = T[k + 2];
        const ax = R[a * 2], ay = R[a * 2 + 1], bx = R[b * 2], by = R[b * 2 + 1], cx = R[c * 2], cy = R[c * 2 + 1];
        const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(det) < 1e-9) continue;
        const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det, w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det, w2 = 1 - w0 - w1;
        const out = Math.max(0, -w0) + Math.max(0, -w1) + Math.max(0, -w2);   // 0 = 在三角形裡
        if (out < bd) { bd = out; best = k; bw = [w0, w1, w2]; if (!out) break; }
      }
      map[v * 6] = T[best]; map[v * 6 + 1] = T[best + 1]; map[v * 6 + 2] = T[best + 2];
      map[v * 6 + 3] = bw[0]; map[v * 6 + 4] = bw[1]; map[v * 6 + 5] = bw[2];
    }
    dr.hostMap = { host, map };
  }
  const m = dr.hostMap.map, out = dr.pos, n = dr.mesh.vertexCount;
  for (let v = 0; v < n; v++) {
    const a = m[v * 6], b = m[v * 6 + 1], c = m[v * 6 + 2], w0 = m[v * 6 + 3], w1 = m[v * 6 + 4], w2 = m[v * 6 + 5];
    out[v * 2] = w0 * hp[a * 2] + w1 * hp[b * 2] + w2 * hp[c * 2];
    out[v * 2 + 1] = w0 * hp[a * 2 + 1] + w1 * hp[b * 2 + 1] + w2 * hp[c * 2 + 1];
  }
  return out;
}
// 剪裁遮色片的底層：前後順序上，下面最近的一個沒有剪裁的圖層（和 Photoshop 一樣）
function clipBases() {
  const m = new Map(), list = D.data.nodes.filter(n => n.type === 'image').sort((a, b) => a.order - b.order);
  let base = null;
  for (const n of list) { if (n.clip) { if (base) m.set(n.id, base.id); } else base = n; }
  return m;
}
const BLEND_MODES = { normal: '正常', darken: '變暗', multiply: '色彩增值', colorburn: '加深顏色', linearburn: '線性加深', lighten: '變亮', screen: '濾色', colordodge: '加亮顏色', add: '線性加亮（增加）', overlay: '覆蓋', softlight: '柔光', hardlight: '實光', vividlight: '強烈光源', linearlight: '線性光源', difference: '差異化', exclusion: '排除', subtract: '減去', divide: '分割' };
// PSD 的混合模式 → 這裡支援的；不支援的回傳 null
const PSD_BLEND = { norm: 'normal', pass: 'normal', 'mul ': 'multiply', scrn: 'screen', lddg: 'add', dark: 'darken', lite: 'lighten', idiv: 'colorburn', lbrn: 'linearburn', 'div ': 'colordodge', over: 'overlay', sLit: 'softlight', hLit: 'hardlight', vLit: 'vividlight', lLit: 'linearlight', diff: 'difference', smud: 'exclusion', fsub: 'subtract', fdiv: 'divide' };
const PSD_BLEND_NAME = { over: '覆蓋', sLit: '柔光', hLit: '實光', vLit: '強烈光源', lLit: '線性光源', pLit: '小光源', hMix: '實色疊印混合', 'div ': '加亮顏色', idiv: '加深顏色', lbrn: '線性加深', dark: '變暗', lite: '變亮', dkCl: '顏色變暗', lgCl: '顏色變亮', diff: '差異化', smud: '排除', fsub: '減去', fdiv: '分割', 'hue ': '色相', 'sat ': '飽和度', colr: '顏色', 'lum ': '明度', diss: '溶解' };
let lastDraw = null;
// 時間軸開啟時：選取物件的位置把手（拖曳 = 在目前時間建立 / 更新位置關鍵影格，整個部位一起移動）
const tlPivotCache = new Map();
const ROT_R = 46;   // 旋轉把手與支點的距離（螢幕 px）
function tlHandle() {
  if (!timelineOn || !D || D.ui.mode !== 'preview' || !lastDraw) return null;
  const n = sel();
  if (!n || n.type === 'root') return null;
  let piv = n.pins[0] || n.keyPivot;
  if (!piv) {
    let c = tlPivotCache.get(n.id);
    if (!c) { const b = nodeBounds(n); c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; tlPivotCache.set(n.id, c); }
    piv = c;
  }
  const e = lastDraw.evals.get(n.id);
  const o = e ? Model.applyChain(e, piv.x, piv.y).slice() : [piv.x, piv.y];
  const [x, y] = aApply(lastDraw.M, o[0], o[1]);
  return { n, x, y };
}
function draw() {
  renderer.begin(Math.round(view.cw * view.dpr), Math.round(view.ch * view.dpr));
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, octx.canvas.width, octx.canvas.height);
  if (!D || !D.data.width) return;
  const animate = D.ui.mode === 'preview';
  const t = D.ui.frame;
  const G = animate ? Model.globalAffine(D.data, t) : I;
  const M = aMul(viewAffine(), G);
  const s = sel();
  let overlaySel = showRegion && s && s.type !== 'root' && !stroke && tool.name !== 'depth' && !rigEditHost() ? s : null;
  if (D.ui.simple) {
    const g = simpleGroups().find(x => x.key === D.ui.sptab), ids = g ? g.nodes.map(n => n.id) : D.data.nodes.filter(n => isPart(n) && n.type !== 'group').map(n => n.id);
    overlaySel = D.ui.simpleRange && ids.length ? { multi: new Set(ids), color: '#e9557c' } : null;
  }
  // 編輯中「試轉」：固定一個轉向姿勢，只套用立體（不播放、不含動態）
  const pr = D.ui.probe, probing = !animate && D.data.p3d?.enabled && pr && (pr.abs || pr.yaw || pr.pitch);
  if (probing) P3D.setProbe(pr);
  const evals = drawScene(t, animate || !!probing, M, view.cw, view.ch, overlaySel);
  lastDraw = { evals, M, t };
  // 除錯疊圖用：目前姿態下的頭部骨架
  P3D.setProbe(null);
  // 對齊中的新圖（半透明）
  if (D.ui.align && D.cache.alignDr) {
    const al = D.ui.align, a = D.assets.get(al.assetId), dr = D.cache.alignDr;
    renderer.draw(dr.gl, dr.mesh.rest, aMul(M, layerAffine(al, a)), view.cw, view.ch, 0, al.opacity);
  }
  if (showMesh) for (const dr of D.cache.drawables) drawMesh(dr, animate || probing ? dr.pos : dr.mesh.rest, M);
  if (!D.ui.simple) drawOverlay(M, evals, animate);   // 簡易模式：不顯示錨點、範圍等編輯用的東西
  else simpleOverlay(M, evals);
}

function drawMesh(dr, pos, M) {
  const g = octx;
  g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const idx = dr.mesh.idx;
  g.beginPath();
  for (let i = 0; i < idx.length; i += 3) {
    const a = aApply(M, pos[idx[i] * 2], pos[idx[i] * 2 + 1]), b = aApply(M, pos[idx[i + 1] * 2], pos[idx[i + 1] * 2 + 1]), c = aApply(M, pos[idx[i + 2] * 2], pos[idx[i + 2] * 2 + 1]);
    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]);
  }
  g.strokeStyle = 'rgba(120,160,255,.25)'; g.lineWidth = 0.7; g.stroke();
}

const maskCanvases = new WeakMap();
function maskCanvas(obj, color) {
  const c = maskCanvases.get(obj);
  if (c && c.v === obj.v && c.color === color) return c.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = obj.w; canvas.height = obj.h;
  const g = canvas.getContext('2d'), im = g.createImageData(obj.w, obj.h);
  const [r, gg, b] = rgbOf(color).map(v => v * 255);
  for (let i = 0; i < obj.data.length; i++) { im.data[i * 4] = r; im.data[i * 4 + 1] = gg; im.data[i * 4 + 2] = b; im.data[i * 4 + 3] = obj.data[i]; }
  g.putImageData(im, 0, 0);
  maskCanvases.set(obj, { canvas, v: obj.v, color });
  return canvas;
}

function drawOverlay(M, evals, animate) {
  const g = octx, V = viewAffine(), dpr = view.dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 畫布範圍：外面淡淡的陰影
  if (!(D.ui.crop && D.ui.crop.canvas)) {
    const [x0, y0] = aApply(V, 0, 0), [x1, y1] = aApply(V, D.data.width, D.data.height);
    g.beginPath(); g.rect(0, 0, view.cw, view.ch); g.rect(x1, y0, x0 - x1, y1 - y0);
    g.fillStyle = 'rgba(0,0,0,.32)'; g.fill('evenodd');
    g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 1; g.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);
  }
  const s = sel();
  const editing = !animate;

  // 深度圖（深度筆使用中）
  if (editing && s && tool.name === 'depth') {
    const P = P3D.nodeOf(s), obj = P.mapId && D.masks.get(P.mapId);
    const c = stroke && stroke.kind === 'depth' ? stroke.canvas : obj ? maskCanvas(obj, DEPTH_COLOR) : null;
    if (c) { g.save(); g.globalAlpha = stroke ? 0.55 : 0.4; g.setTransform(dpr * V[0], 0, 0, dpr * V[3], dpr * V[4], dpr * V[5]); g.drawImage(c, 0, 0); g.restore(); }
  }
  // 遮罩核心（編輯時）
  if (editing && isPart(s) && tool.name !== 'depth' && (showRegion && !(rigShow && rigEditHost()) || ['mask', 'lasso'].includes(tool.name))) {
    const obj = s.region.mode === 'mask' && s.region.maskId && D.masks.get(s.region.maskId);
    const c = stroke && stroke.kind === 'mask' ? stroke.canvas : obj ? maskCanvas(obj, colorOf(s)) : null;
    if (c) {
      g.save(); g.globalAlpha = stroke ? 0.5 : 0.28;
      g.setTransform(dpr * V[0], 0, 0, dpr * V[3], dpr * V[4], dpr * V[5]);
      g.drawImage(c, 0, 0); g.restore();
    } else if (s.region.mode === 'auto' && s.pins.length) {
      g.beginPath();
      s.pins.forEach((p, i) => { const [x, y] = aApply(V, p.x, p.y); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      if (s.pins.length === 1) { const [x, y] = aApply(V, s.pins[0].x, s.pins[0].y); g.lineTo(x + 0.01, y); }
      g.strokeStyle = colorOf(s); g.globalAlpha = 0.5; g.lineWidth = 1; g.lineCap = 'round'; g.lineJoin = 'round';
      g.save(); g.lineWidth = s.region.radius * 2 * V[0]; g.globalAlpha = 0.18; g.stroke(); g.restore();
      g.globalAlpha = 1;
    }
  }
  // 像素繪圖進行中
  if (stroke && stroke.kind === 'paint') {
    const T = aMul(V, stroke.T);
    g.save(); g.setTransform(dpr * T[0], dpr * T[1], dpr * T[2], dpr * T[3], dpr * T[4], dpr * T[5]);
    g.drawImage(stroke.canvas, 0, 0); g.restore();
  }

  // 錨點：選取部位（含子部位）清楚顯示，其他淡顯
  if ((showPins || editing) && !(rigShow && rigEditHost())) {   // 編輯頭部定位時隱藏錨點，避免和定位點混在一起
    const focus = s ? Model.descendants(D.data, s.id) : new Set();
    for (const n of D.data.nodes) {
      if (!n.pins.length) continue;
      const inFocus = focus.has(n.id);
      if (n.type === 'root') { if (s && s.type === 'root' && editing) drawRootPivot(g, aApply(M, n.pins[0].x, n.pins[0].y)); continue; }
      if (!inFocus && (animate || !showPins)) continue;
      const e = evals.get(n.id);
      const pts = n.pins.map(p => {
        const o = animate ? Model.applyChain(e, p.x, p.y) : [p.x, p.y];
        const q = aApply(M, o[0], o[1]);
        return { p, x: q[0], y: q[1] };
      });
      const main = s && n.id === s.id;
      g.globalAlpha = inFocus ? 1 : 0.3;
      if (pts.length > 1) {
        g.beginPath();
        pts.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y));
        g.strokeStyle = colorOf(n); g.lineWidth = main ? 1.8 : 1.2; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);
      }
      pts.forEach((q, i) => {
        const fixed = i === 0, r = main ? 6 : 4.5;
        g.beginPath();
        if (fixed) g.rect(q.x - r, q.y - r, r * 2, r * 2); else g.arc(q.x, q.y, r, 0, TAU);
        g.fillStyle = fixed ? '#ef4444' : '#38bdf8'; g.fill();
        g.lineWidth = D.ui.selPin === q.p.id ? 2.5 : 1.5;
        g.strokeStyle = D.ui.selPin === q.p.id ? '#fff' : 'rgba(0,0,0,.6)'; g.stroke();
        if (main && editing && i > 0) { g.fillStyle = '#fff'; g.font = '600 10px system-ui'; g.fillText(String(i), q.x + 7, q.y - 6); }
      });
    }
    g.globalAlpha = 1;
  }

  if (editing && tool.name === 'transform') {
    const gs = lgById(D.ui.selLg) || sel();
    if (gs && (gs.type === 'group' || lgById(D.ui.selLg))) {
      const b = lgById(D.ui.selLg) ? lgBounds(gs) : groupBounds(gs);
      if (b) { const p0 = aApply(V, b.x0, b.y0), p1 = aApply(V, b.x1, b.y1); g.setLineDash([6, 4]); g.strokeStyle = '#facc15'; g.lineWidth = 1.5; g.strokeRect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]); g.setLineDash([]); g.font = '600 11px system-ui'; g.fillStyle = '#facc15'; g.fillText(`${gs.name}：拖曳整組移動`, p0[0] + 4, p0[1] - 6); }
    } else drawXform(g, V);
  }
  if (editing && tool.name === 'crop') drawCrop(g);
  if (editing) drawFaceGuide(g, V);
  if (editing) drawRigGuide(g, V, evals);
  drawWizard(g, V);
  const th = tlHandle();
  if (th) {
    g.save(); g.translate(th.x, th.y); g.rotate(Math.PI / 4);
    g.fillStyle = '#facc15'; g.strokeStyle = '#1a1a1a'; g.lineWidth = 1.5; g.fillRect(-7, -7, 14, 14); g.strokeRect(-7, -7, 14, 14);
    g.restore();
    g.font = '600 11px system-ui'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText('拖曳移動', th.x + 12, th.y + 4); g.fillStyle = '#fff'; g.fillText('拖曳移動', th.x + 12, th.y + 4);
    // 旋轉把手：支點上方的圓點
    const rx = th.x, ry = th.y - ROT_R, rot = Model.keyVal(D.data, th.n, 'rot', D.ui.frame);
    g.beginPath(); g.moveTo(th.x, th.y - 8); g.lineTo(rx, ry + 6); g.strokeStyle = 'rgba(250,204,21,.8)'; g.lineWidth = 1.5; g.stroke();
    if (drag && drag.type === 'tlrot') { g.beginPath(); g.arc(th.x, th.y, ROT_R, -Math.PI / 2, -Math.PI / 2 + rot * DEG, rot < 0); g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]); }
    g.beginPath(); g.arc(rx, ry, 6, 0, TAU); g.fillStyle = '#facc15'; g.fill(); g.strokeStyle = '#1a1a1a'; g.lineWidth = 1.5; g.stroke();
    const rl = `旋轉 ${Math.round(rot)}°`;
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(rl, rx + 10, ry + 4); g.fillStyle = '#fff'; g.fillText(rl, rx + 10, ry + 4);
  }
  // 魔術棒的選取（青色）
  if (wandSel && wandSel.prev && tool.name === 'wand') {
    const wn = node(wandSel.id), wa = wn && D.assets.get(wn.image.assetId);
    if (wa) { const T = aMul(V, layerAffine(wn.image, wa)); g.save(); g.setTransform(dpr * T[0], dpr * T[1], dpr * T[2], dpr * T[3], dpr * T[4], dpr * T[5]); g.drawImage(wandSel.prev, 0, 0); g.restore(); }
  }
  // 圈眼睛：範圍（淡白）＋ 會變成眼睛的部分（紫）
  if (eyePick) {
    g.save();
    g.setTransform(dpr * V[0], dpr * V[1], dpr * V[2], dpr * V[3], dpr * V[4], dpr * V[5]);
    g.globalAlpha = 0.18; g.drawImage(eyePick.mask, 0, 0); g.globalAlpha = 1;
    if (eyePick.prev) { const T = aMul(V, eyePick.prev.T); g.setTransform(dpr * T[0], dpr * T[1], dpr * T[2], dpr * T[3], dpr * T[4], dpr * T[5]); g.drawImage(eyePick.prev.canvas, 0, 0); }
    g.restore();
  }
  if (lasso && lasso.pts.length) {
    g.beginPath();
    lasso.pts.forEach(([x, y], i) => { const q = aApply(V, x, y); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); });
    if (lasso.hover) { const q = aApply(V, lasso.hover[0], lasso.hover[1]); g.lineTo(q[0], q[1]); }
    g.strokeStyle = lasso.mode === 'sub' ? '#f06a6a' : '#fff'; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.stroke(); g.setLineDash([]);
    const f = aApply(V, lasso.pts[0][0], lasso.pts[0][1]);
    const snap = cursor && lassoNearStart(cursor.x, cursor.y);
    g.beginPath(); g.arc(f[0], f[1], snap ? 8 : 5, 0, TAU); g.fillStyle = snap ? '#4ade80' : '#fff'; g.fill();
    if (snap) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
  }
  if (cursor && editing && (tool.name === 'mask' || tool.name === 'paint' || tool.name === 'depth')) {
    const size = tool.name === 'mask' ? tool.brush : tool.name === 'depth' ? tool.depthSize : tool.paintSize * (xformTarget()?.p.scale ?? 1);
    g.beginPath(); g.arc(cursor.x, cursor.y, Math.max(2, size * V[0] / 2), 0, TAU);
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1; g.stroke();
    const soft = (tool.name === 'mask' ? tool.maskSoft : tool.name === 'depth' ? tool.depthSoft : tool.paintSoft * (xformTarget()?.p.scale ?? 1)) * V[0] / 2;
    if (soft > 1) {
      g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,255,255,.5)';
      for (const rr of [size * V[0] / 2 - soft, size * V[0] / 2 + soft]) if (rr > 1) { g.beginPath(); g.arc(cursor.x, cursor.y, rr, 0, TAU); g.stroke(); }
      g.setLineDash([]);
    }
  }
  if (D.ui.fit) drawFit(V);
}
// 臉部精細模式的導引：中線（白點兩端）、中心（黃點）、圓柱左右邊界
const faceSel = () => { const n = sel(); return D && D.ui.ptab === 'p3d' && n && !HeadRig.active(n.rig) && n.p3d && n.p3d.face && n.p3d.face.on ? n.p3d.face : null; };
function faceAxes(F) {
  let ax = F.chin.x - F.top.x, ay = F.chin.y - F.top.y;
  const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l;
  return { ax, ay, nx: ay, ny: -ax, l };
}
function faceHandles(F) {
  const { ax, ay, nx, ny } = faceAxes(F);
  return [['top', F.top.x, F.top.y], ['chin', F.chin.x, F.chin.y], ['center', F.cx, F.cy],
    ['R', F.cx + nx * F.R, F.cy + ny * F.R], ['Fw', F.cx + nx * (F.Fw ?? F.R * 0.72), F.cy + ny * (F.Fw ?? F.R * 0.72)], ['Rv', F.cx - ax * F.Rv, F.cy - ay * F.Rv]];
}
function drawFaceGuide(g, V) {
  const F = faceSel();
  if (!F) return;
  P3D.faceNorm(F);
  const { ax, ay, nx, ny } = faceAxes(F);
  // 臉邊緣：與中線平行的兩條白色虛線
  for (const sg of [-1, 1]) {
    const bx = F.cx + nx * F.Fw * sg, by = F.cy + ny * F.Fw * sg;
    const p0 = aApply(V, bx - ax * F.Rv, by - ay * F.Rv), p1 = aApply(V, bx + ax * F.Rv, by + ay * F.Rv);
    g.beginPath(); g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]); g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]);
  }
  // 圓柱範圍：以中心為圓心、半寬 × 半高的橢圓（沿中線方向）
  g.beginPath();
  for (let i = 0; i <= 64; i++) {
    const a = i / 64 * TAU, u = Math.cos(a) * F.R, v = Math.sin(a) * F.Rv;
    const q = aApply(V, F.cx + nx * u + ax * v, F.cy + ny * u + ay * v);
    i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]);
  }
  g.strokeStyle = 'rgba(250,204,21,.7)'; g.lineWidth = 1; g.setLineDash([5, 4]); g.stroke(); g.setLineDash([]);
  const a = aApply(V, F.top.x, F.top.y), b = aApply(V, F.chin.x, F.chin.y);
  g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
  const label = { top: '中線上端', chin: '中線下端', center: '中心', R: '頭寬', Fw: '臉寬', Rv: '半高' };
  g.font = '600 11px system-ui'; g.textBaseline = 'middle';
  for (const [k, x, y] of faceHandles(F)) {
    const q = aApply(V, x, y);
    g.beginPath();
    if (k === 'R' || k === 'Rv' || k === 'Fw') g.rect(q[0] - 5, q[1] - 5, 10, 10); else g.arc(q[0], q[1], 5.5, 0, TAU);
    g.fillStyle = k === 'center' || k === 'R' || k === 'Rv' ? '#facc15' : '#fff'; g.fill();
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1; g.stroke();
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(label[k], q[0] + 9, q[1]);
    g.fillStyle = '#fff'; g.fillText(label[k], q[0] + 9, q[1]);
  }
  g.textBaseline = 'alphabetic';
}
function drawRootPivot(g, [x, y]) {
  g.beginPath(); g.arc(x, y, 8, 0, TAU); g.moveTo(x - 13, y); g.lineTo(x + 13, y); g.moveTo(x, y - 13); g.lineTo(x, y + 13);
  g.strokeStyle = '#e9557c'; g.lineWidth = 2; g.stroke();
}

// ---------- 變形工具（圖層移動 / 縮放 / 旋轉 / 裁切） ----------
function xformTarget() {
  if (!D) return null;
  if (D.ui.align) { const a = D.assets.get(D.ui.align.assetId); return a ? { p: D.ui.align, a, align: true } : null; }
  const s = sel();
  const n = s && (s.type === 'image' ? s : Model.imageOf(D.data, s));
  if (!n) return null;
  const a = D.assets.get(n.image.assetId);
  return a ? { n, p: n.image, a } : null;
}
function xformHandles() {
  const tg = xformTarget();
  if (!tg) return null;
  const { p, a } = tg, T = layerAffine(p, a), V = viewAffine();
  const c = !tg.align && p.crop ? p.crop : { x0: 0, y0: 0, x1: a.w, y1: a.h };
  const corners = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]].map(([x, y]) => aApply(V, ...aApply(T, x, y)));
  const center = aApply(V, ...aApply(T, (c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2));
  const topMid = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
  const up = [topMid[0] - center[0], topMid[1] - center[1]], ul = Math.hypot(...up) || 1;
  const rot = [topMid[0] + up[0] / ul * 26, topMid[1] + up[1] / ul * 26];
  const edges = [0, 1, 2, 3].map(i => [(corners[i][0] + corners[(i + 1) % 4][0]) / 2, (corners[i][1] + corners[(i + 1) % 4][1]) / 2]);
  return { tg, T, corners, center, topMid, rot, edges, c };
}
function drawXform(g) {
  const h = xformHandles();
  if (!h) return;
  g.beginPath();
  h.corners.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
  g.closePath();
  g.strokeStyle = h.tg.align ? '#f0b24a' : '#5b8cff'; g.lineWidth = 1.5; g.setLineDash(tool.crop ? [6, 4] : []); g.stroke(); g.setLineDash([]);
  const sq = ([x, y], fill = '#fff') => { g.beginPath(); g.rect(x - 5, y - 5, 10, 10); g.fillStyle = fill; g.fill(); g.strokeStyle = '#222'; g.lineWidth = 1; g.stroke(); };
  if (tool.crop && !h.tg.align) { h.edges.forEach(e => sq(e, '#f0b24a')); return; }
  h.corners.forEach(c => sq(c));
  g.beginPath(); g.moveTo(...h.topMid); g.lineTo(...h.rot); g.strokeStyle = '#fff'; g.stroke();
  g.beginPath(); g.arc(h.rot[0], h.rot[1], 6, 0, TAU); g.fillStyle = '#5b8cff'; g.fill(); g.strokeStyle = '#fff'; g.stroke();
}
// 圖層變形後，讓綁在上面的錨點與遮罩一起移動
function moveRigWith(n, before, after) {
  const delta = aMul(after, aInv(before)), inv = aInv(delta);
  for (const m of D.data.nodes) {
    if (m.type === 'image' || Model.imageOf(D.data, m) !== n) continue;
    for (const p of m.pins) { const [x, y] = aApply(delta, p.x, p.y); p.x = Math.round(x); p.y = Math.round(y); }
    const obj = m.region.maskId && D.masks.get(m.region.maskId);
    if (obj) D.masks.set(m.region.maskId, { data: ImgProc.resample(obj.data, obj.w, obj.h, inv), w: obj.w, h: obj.h, v: ++maskVer });
  }
}

// ---------- 公版對位 ----------
function drawFit(V) {
  const g = octx, f = D.ui.fit;
  for (const s of Templates.spec(f, f.opts)) {
    const color = (TYPES[s.type] || {}).color || '#fff';
    g.strokeStyle = color; g.lineWidth = 1.5;
    if (s.ellipse) {
      const [cx, cy, rx, ry] = s.ellipse, c = aApply(V, cx, cy);
      g.beginPath(); g.ellipse(c[0], c[1], rx * V[0], ry * V[0], 0, 0, TAU);
      g.fillStyle = 'rgba(96,165,250,.16)'; g.fill(); g.stroke();
    }
    if (s.poly) {
      g.beginPath(); s.poly.forEach(([x, y], i) => { const q = aApply(V, x, y); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.closePath();
      g.fillStyle = s.type === 'torso' ? 'rgba(248,113,113,.12)' : 'rgba(244,114,182,.2)'; g.fill(); g.stroke();
    }
    if (s.pins.length > 1) {
      g.beginPath(); s.pins.forEach(([x, y], i) => { const q = aApply(V, x, y); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); });
      g.globalAlpha = 0.25; g.lineWidth = (s.radius || 10) * 2 * V[0]; g.lineCap = 'round'; g.stroke();
      g.globalAlpha = 1; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);
    }
    s.pins.forEach(([x, y], i) => {
      const q = aApply(V, x, y);
      g.beginPath(); if (i === 0) g.rect(q[0] - 5, q[1] - 5, 10, 10); else g.arc(q[0], q[1], 4, 0, TAU);
      g.fillStyle = i === 0 ? '#ef4444' : '#38bdf8'; g.fill();
    });
  }
  for (const h of fitHandles()) {
    const q = aApply(V, h.x, h.y);
    g.beginPath(); g.rect(q[0] - 6, q[1] - 6, 12, 12);
    g.fillStyle = h.k === 'bottom' ? '#f87171' : '#fff'; g.fill(); g.strokeStyle = '#222'; g.lineWidth = 1.5; g.stroke();
  }
}
function fitHandles() {
  const f = D.ui.fit;
  return [
    { k: 'c', x: f.cx, y: f.cy }, { k: 'r', x: f.cx + f.rx, y: f.cy }, { k: 'l', x: f.cx - f.rx, y: f.cy },
    { k: 't', x: f.cx, y: f.cy - f.ry }, { k: 'b', x: f.cx, y: f.cy + f.ry }, { k: 'bottom', x: f.cx, y: f.bottom },
  ];
}
function startTemplate() {
  if (!D || !D.data.nodes.some(n => n.type === 'image')) { toast('請先開啟圖片', 'warn'); return; }
  D.ui.fit = { opts: { ...Templates.OPTS }, ...Templates.guess(opaqueBounds(D)) };
  setMode('edit'); setTool('select');
  renderToolDetail(); renderStatus();
}
function applyTemplate() {
  const f = D.ui.fit, s = sel();
  let img = s && (s.type === 'image' ? s : Model.imageOf(D.data, s));
  if (!img) img = D.data.nodes.find(n => n.type === 'image');
  const head = Templates.apply({ image: img, addPart: (...a) => addPart(D, ...a), paintMask: (n, p) => paintMask(D, n, p, false, true) }, f, f.opts);
  D.ui.fit = null;
  D.ui.sel = head ? head.id : img.id;
  commit(); renderAll();
  setMode('preview');
}

// ---------- 波形與緩動曲線 ----------
function drawWave() {
  const c = document.getElementById('wave');
  if (!c || !D) return;
  const w = c.clientWidth, h = c.clientHeight, dpr = view.dpr;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const Mf = master(), pad = 8, N = 150;
  const X = f => pad + (w - pad * 2) * f / Mf, Y = v => h / 2 + v * (h / 2 - pad);
  g.strokeStyle = '#333'; g.lineWidth = 1; g.beginPath();
  g.moveTo(pad, h / 2); g.lineTo(w - pad, h / 2);
  for (let f = 0; f <= Mf + 1e-6; f += Mf / 2) { g.moveTo(X(f), pad); g.lineTo(X(f), h - pad); }
  g.stroke();
  for (const [key, color] of [['xk', '#5b8cff'], ['yk', '#f0b24a']]) {
    g.beginPath();
    for (let i = 0; i <= N; i++) { const f = Mf * i / N, v = Model.globalCurves(D.data, f)[key]; i ? g.lineTo(X(f), Y(v)) : g.moveTo(X(f), Y(v)); }
    g.strokeStyle = color; g.lineWidth = 1.8; g.stroke();
  }
  g.beginPath(); g.moveTo(X(D.ui.frame), 2); g.lineTo(X(D.ui.frame), h - 2); g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
}
function drawCurve() {
  const c = document.getElementById('curve');
  if (!c || !D) return;
  const w = c.clientWidth, h = c.clientHeight, dpr = view.dpr;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pad = 10, k = D.data.timeline.ease, f = Anim.easeFn(k);
  const X = u => pad + (w - pad * 2) * u, Y = v => h - pad - (h - pad * 2) * v;
  g.strokeStyle = '#555'; g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(k), Y(0)); g.moveTo(X(1), Y(1)); g.lineTo(X(1 - k), Y(1)); g.stroke();
  g.fillStyle = '#aaa';
  for (const [u, v] of [[k, 0], [1 - k, 1]]) { g.beginPath(); g.arc(X(u), Y(v), 3, 0, TAU); g.fill(); }
  g.beginPath();
  for (let i = 0; i <= 60; i++) { const u = i / 60; i ? g.lineTo(X(u), Y(f(u))) : g.moveTo(X(u), Y(f(u))); }
  g.strokeStyle = '#e9557c'; g.lineWidth = 2; g.stroke();
}

// ---------- 模式與播放 ----------
function setMode(m) {
  if (!D) return;
  D.ui.mode = m;
  D.ui.playing = m === 'preview';
  if (m === 'edit') D.ui.frame = 0;
  lasso = null;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  updatePlaybar(); renderStatus();
}
function updatePlaybar() {
  if (!D) return;
  const Mf = total(), sc = $('#scrub');
  sc.max = Mf;
  if (document.activeElement !== sc) sc.value = D.ui.frame;
  $('#frameLabel').textContent = `${Math.floor(D.ui.frame)} / ${Math.round(Mf)}`;
  const b = $('#btnPlay'), want = D.ui.playing ? 'pause' : 'play';
  if (b.dataset.icon !== want) { b.innerHTML = ''; b.append(ico(want)); b.dataset.icon = want; }
  updateTimelineHead();
}
function togglePlay() {
  if (!D) return;
  if (D.ui.mode !== 'preview') { setMode('preview'); return; }
  D.ui.playing = !D.ui.playing;
  updatePlaybar();
}
function stepFrame(d) {
  if (!D) return;
  if (D.ui.mode !== 'preview') setMode('preview');
  D.ui.playing = false;
  D.ui.frame = Anim.mod(Math.round(D.ui.frame) + d, total());
  updatePlaybar();
}
// 調整動作參數時自動切到預覽（使用編輯工具中除外）
function liveChanged() { if (D && D.ui.mode === 'edit' && tool.name === 'select' && !D.ui.fit && !D.ui.align) setMode('preview'); }

// ---------- 工具 ----------
const TOOLS = [
  ['select', 'cursor', '選取 (V)', 'v'],
  ['transform', 'transform', '圖層變形：移動 / 縮放 / 旋轉 (T)', 't'],
  ['crop', 'crop', '裁切 / 畫布 (C)', 'c'],
  ['pin', 'pin', '錨點 (A)', 'a'],
  ['mask', 'pen', '遮罩筆 (B)', 'b'],
  ['lasso', 'lasso', '多邊形遮罩 (L)', 'l'],
  ['depth', 'depthpen', '深度筆 (G)', 'g'],
  ['paint', 'brush', '圖層繪圖 (D)', 'd'],
  ['wand', 'auto', '魔術棒選取 (W)', 'w'],
];
// ---------- 快捷鍵（可在「彈design」選單 → 快捷鍵設定 修改，存在這台電腦的瀏覽器）----------
// [id, 群組, 名稱, 預設按鍵]；按鍵格式：Ctrl+Shift+Alt+鍵（鍵 = 大寫字母 / Space / ArrowLeft / [ …）
const KEY_DEFS = [
  ['open', '檔案', '開啟檔案', 'Ctrl+O'],
  ['save', '檔案', '儲存專案', 'Ctrl+S'],
  ['saveAs', '檔案', '另存新檔', 'Ctrl+Shift+S'],
  ['export', '檔案', '輸出動畫', 'Ctrl+E'],
  ['undo', '編輯', '復原', 'Ctrl+Z'],
  ['redo', '編輯', '重做', 'Ctrl+Y'],
  ['play', '播放', '播放 / 暫停', 'Space'],
  ['prev', '播放', '上一格', 'ArrowLeft'],
  ['next', '播放', '下一格', 'ArrowRight'],
  ...TOOLS.map(([name, , title, k]) => ['tool.' + name, '工具', title.replace(/\s*\(.\)$/, ''), k.toUpperCase()]),
  ['brushDown', '筆刷', '筆刷縮小', '['],
  ['brushUp', '筆刷', '筆刷放大', ']'],
  ['maskMode', '筆刷', '遮罩筆：加 / 減 切換', 'X'],
];
// 固定的操作（不能改，列在說明與快捷鍵設定裡）
const FIXED_KEYS = [
  ['Ctrl+Shift+Z', '重做（另一組）'],
  ['Enter', '完成多邊形 / 套用裁切'],
  ['Esc', '取消（裁切、多邊形、對齊）/ 關閉選單'],
  ['Delete / Backspace', '刪除選取的部位、錨點、關鍵影格；多邊形中刪上一點'],
  ['Alt + 塗抹', '遮罩筆、深度筆反向（擦除）'],
  ['Alt + 點擊', '圖層繪圖時吸取畫面顏色'],
  ['Shift + 旋轉', '變形工具鎖定 15°'],
  ['滾輪', '以游標為中心縮放畫面'],
  ['中鍵拖曳 / 按住空白鍵拖曳', '平移畫面（空白鍵在非選取工具時）'],
  ['雙擊', '錨點：刪除；名稱：重新命名；拉桿：恢復預設'],
  ['右鍵', '部位 / 圖層選單'],
];
let keyMap = {};
function loadKeys() {
  let user = {};
  try { user = JSON.parse(localStorage.getItem('tan.keys') || '{}'); } catch (_) { /* 沒有就用預設 */ }
  keyMap = Object.fromEntries(KEY_DEFS.map(([id, , , k]) => [id, id in user ? user[id] : k]));
}
function saveKeys() {
  const user = {};
  for (const [id, , , k] of KEY_DEFS) if (keyMap[id] !== k) user[id] = keyMap[id];
  try { localStorage.setItem('tan.keys', JSON.stringify(user)); } catch (_) { /* 私密瀏覽等無法儲存 */ }
  updateKeyTitles();
}
const KEY_NAMES = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: '空白鍵', Escape: 'Esc' };
const keyLabel = k => k ? k.split('+').map(p => KEY_NAMES[p] || p).join(' + ') : '';
const keyOf = id => keyMap[id] || '';
const keyHint = id => keyOf(id) ? `（${keyLabel(keyOf(id))}）` : '';
// 鍵盤事件 → 按鍵字串（純修飾鍵回傳 null）
function comboOf(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const k = e.code === 'Space' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && e.key.length > 1 && 'Shift', k].filter(Boolean).join('+');
}
function updateKeyTitles() {
  const set = (sel, t) => { const b = $(sel); if (b) b.title = t; };
  set('#btnSave', '儲存專案' + keyHint('save'));
  set('#btnUndo', '復原' + keyHint('undo'));
  set('#btnRedo', '重做' + keyHint('redo'));
  set('#btnExport', '輸出動畫' + keyHint('export'));
  const o = $('#fileOpen'); if (o && o.parentElement) o.parentElement.title = '開啟圖片 / PSD / 專案（新分頁）' + keyHint('open');
  if (D) renderTools();
}
loadKeys();
// 圖層變形 / 繪圖只作用在影像圖層
const toolUsable = name => name === 'depth' ? !!D && !!D.data.p3d?.enabled && !!sel() && !['root', 'group'].includes(sel().type)
    : name === 'crop' ? !!D
  : !['transform', 'paint', 'wand'].includes(name) || !!D && (sel()?.type === 'image' || (name === 'transform' && (!!D.ui.align || sel()?.type === 'group' || !!lgById(D.ui.selLg))));
function setTool(name) {
  if (!toolUsable(name)) return;
  if (tool.name === 'crop' && name !== 'crop' && D && D.ui.crop) endCrop(true);
  tool.name = name;
  if (name === 'crop' && D) startCrop();
  lasso = null;
  if (tool.stripHidden) { tool.stripHidden = false; renderStrip(); resize(); }
  if (D && name !== 'select' && D.ui.mode !== 'edit') setMode('edit');
  renderTools(); renderToolDetail(); renderStatus();
}
function renderTools() {
  const box = $('#tools');
  box.innerHTML = '';
  if (!toolUsable(tool.name)) { if (tool.name === 'crop' && D && D.ui.crop) endCrop(true); tool.name = 'select'; lasso = null; renderStatus(); }
  for (const [name, icon, title0] of TOOLS) { const title = title0.replace(/\s*\(.\)$/, '') + keyHint('tool.' + name); box.append(el('button', { class: 'tb icon' + (tool.name === name ? ' on' : ''), title: toolUsable(name) ? title : title + (name === 'depth' ? '（先啟用立體並選取部位 / 圖層）' : '（先選取影像圖層）'), disabled: toolUsable(name) ? null : 'disabled', onclick: () => setTool(name) }, ico(icon))); }
  $('#toolName').textContent = (TOOLS.find(t => t[0] === tool.name) || [])[2]?.replace(/\s*\(.\)$/, '') || '';
}
function renderStatus() {
  const s = $('#status');
  if (!D) { s.textContent = ''; return; }
  const n = sel();
  const map = {
    select: '點擊選取部位 · 右鍵開啟選單',
    transform: '拖曳移動 · 角落縮放 · 上方圓點旋轉（Shift 鎖定 15°）',
    crop: '拖曳白色把手調整範圍 · 框內拖曳移動 · Enter 套用 · Esc 取消（選取圖片圖層時可切換「圖層 / 畫布」）',
    pin: !isPart(n) && !(n && n.type === 'image') ? (n && n.type === 'root' ? '拖曳整體支點' : '先選擇一個部位') : !n.pins.length ? '點擊放置支點（紅）' : '點擊加運動點（依順序連接）· 拖曳移動 · 雙擊或右鍵刪除',
    mask: '塗抹範圍 · Alt 反向 · [ ] 調整大小',
    lasso: '點擊描直線 · 按住拖曳自由描邊 · 點回起點或 Enter 完成 · Backspace 刪上一點 · Esc 取消',
    paint: '在圖層上繪製 · [ ] 調整大小',
  };
  s.textContent = D.ui.fit ? '拖曳白色控制點讓橢圓框住頭部（含頭髮），紅點對齊軀幹底部' : D.ui.align ? '拖曳新圖對齊舊圖，完成後按「確定取代」' : '';
  $('#toolName').title = map[tool.name] || '';
}

// ---------- 指標事件 ----------
let drag = null, stroke = null, lasso = null, cursor = null, spaceDown = false;
const toDoc = (mx, my) => aApply(aInv(viewAffine()), mx, my);
function alphaAtDoc(x, y) {
  for (const dr of D.cache.drawables) {
    const [lx, ly] = aApply(dr.Tinv, x, y).map(Math.round);
    if (lx >= 0 && ly >= 0 && lx < dr.w && ly < dr.h && dr.alpha[ly * dr.w + lx] > 16) return true;
  }
  return false;
}
function hitPin(mx, my, only) {
  const V = viewAffine();
  let best = null, bd = HIT;
  for (const n of only ? [only] : D.data.nodes) for (const p of n.pins) {
    const [x, y] = aApply(V, p.x, p.y), d = Math.hypot(x - mx, y - my);
    if (d < bd) { bd = d; best = { n, p }; }
  }
  return best;
}
function selectNode(id, toEdit = true) {
  D.ui.sel = id; D.ui.selPin = null; D.ui.selLg = null;
  let n = node(id);
  while (n && n.parent) { const p = node(n.parent); if (p) p.collapsed = false; n = p; }
  if (toEdit && D.ui.mode !== 'edit' && !timelineOn) setMode('edit');
  renderTree(); renderOrder(); renderRight(); renderStatus();
}

// 筆刷：每筆畫累積一層覆蓋率（取最大值，同一筆重疊不會越疊越深），再與原本內容合成
// 柔化 = 邊緣模糊寬度（px），以筆刷邊緣為中心往內外各半
function startMaskStroke(n, erase) {
  const W = D.data.width, H = D.data.height, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const obj = n.region.mode === 'mask' && n.region.maskId && D.masks.get(n.region.maskId);
  const base = obj ? obj.data.slice() : n.region.mode === 'auto' && n.pins.length ? capsuleRaster(D, n, n.region.radius) : new Uint8Array(W * H);
  g.drawImage(maskCanvas({ data: base, w: W, h: H, v: -1 }, colorOf(n)), 0, 0);
  const out = base.slice(), [r, gg, b] = rgbOf(colorOf(n)).map(v => v * 255);
  return {
    kind: 'mask', node: n, canvas: c, g, last: null, T: I, size: tool.brush, soft: tool.maskSoft, opacity: tool.maskOpacity ?? 1, cov: new Uint8Array(W * H), out,
    apply: (i, v) => { out[i] = erase ? Math.round(base[i] * (255 - v) / 255) : base[i] + Math.round((255 - base[i]) * v / 255); },
    pixel: (d, o, i) => { d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = out[i]; },
  };
}
function startPaintStroke(n) {
  const a = D.assets.get(n.image.assetId), T0 = layerAffine(n.image, a);
  // 可畫到原圖外：畫布 = 原圖 ∪ 整張文件範圍（圖層本地座標），結束時裁到有內容的範圍
  let ox = 0, oy = 0, cw = a.w, ch = a.h;
  if (!n.image.variants.length) {
    const Ti = aInv(T0), W = D.data.width, H = D.data.height;
    const cs = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => aApply(Ti, x, y));
    const x0 = Math.floor(Math.min(0, ...cs.map(p => p[0]))), y0 = Math.floor(Math.min(0, ...cs.map(p => p[1])));
    const x1 = Math.ceil(Math.max(a.w, ...cs.map(p => p[0]))), y1 = Math.ceil(Math.max(a.h, ...cs.map(p => p[1])));
    const lim = Math.min(MAX_IMAGE, renderer.maxTexture);
    if (x1 - x0 <= lim && y1 - y0 <= lim) { ox = -x0; oy = -y0; cw = x1 - x0; ch = y1 - y0; }
  }
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  g.drawImage(a.canvas, ox, oy);
  const base = g.getImageData(0, 0, cw, ch).data, out = new Uint8ClampedArray(base);
  const erase = tool.paintMode === 'erase', hex = tool.paintColor;
  const cr = parseInt(hex.slice(1, 3), 16), cg = parseInt(hex.slice(3, 5), 16), cb = parseInt(hex.slice(5, 7), 16);
  const T = aMul(T0, [1, 0, 0, 1, -ox, -oy]);
  return {
    kind: 'paint', node: n, canvas: c, g, last: null, T, Tinv: aInv(T), ox, oy, size: tool.paintSize, soft: tool.paintSoft, opacity: tool.paintOpacity ?? 1, cov: new Uint8Array(cw * ch),
    apply: (i, v) => {
      const o = i * 4, s = v / 255, ba = base[o + 3] / 255;
      if (erase) { out[o + 3] = base[o + 3] * (1 - s); return; }
      const oa = s + ba * (1 - s);
      if (oa <= 0) return;
      out[o] = (cr * s + base[o] * ba * (1 - s)) / oa;
      out[o + 1] = (cg * s + base[o + 1] * ba * (1 - s)) / oa;
      out[o + 2] = (cb * s + base[o + 2] * ba * (1 - s)) / oa;
      out[o + 3] = oa * 255;
    },
    pixel: (d, o, i) => { const q = i * 4; d[o] = out[q]; d[o + 1] = out[q + 1]; d[o + 2] = out[q + 2]; d[o + 3] = out[q + 3]; },
  };
}
// 深度筆：塗在部位自己的深度圖上（有塗 = 淺、無塗 = 深）
function startDepthStroke(n, erase) {
  const W = D.data.width, H = D.data.height, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const P = P3D.nodeOf(n), obj = P.mapId && D.masks.get(P.mapId);
  const base = obj ? obj.data.slice() : new Uint8Array(W * H);
  g.drawImage(maskCanvas({ data: base, w: W, h: H, v: -1 }, DEPTH_COLOR), 0, 0);
  const out = base.slice(), [r, gg, b] = rgbOf(DEPTH_COLOR).map(v => v * 255);
  return {
    kind: 'depth', node: n, canvas: c, g, last: null, T: I, size: tool.depthSize, soft: tool.depthSoft, opacity: tool.depthOpacity ?? 1, cov: new Uint8Array(W * H), out,
    apply: (i, v) => { out[i] = erase ? Math.round(base[i] * (255 - v) / 255) : base[i] + Math.round((255 - base[i]) * v / 255); },
    pixel: (d, o, i) => { d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = out[i]; },
  };
}
function dab(st, cx, cy) {
  const W = st.canvas.width, H = st.canvas.height, r = st.size / 2;
  const w = Math.max(1, st.soft), reach = r + w / 2, smooth = st.soft > 1;
  const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(W - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(H - 1, Math.ceil(cy + reach));
  if (x1 < x0 || y1 < y0) return null;
  const cov = st.cov;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    let a = (reach - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)) / w;
    if (a <= 0) continue;
    if (a > 1) a = 1; else if (smooth) a = a * a * (3 - 2 * a);
    const i = y * W + x, v = Math.round(a * 255 * st.opacity);
    if (v <= cov[i]) continue;
    cov[i] = v;
    st.apply(i, v);
  }
  return [x0, y0, x1, y1];
}
function flushStroke(st, [x0, y0, x1, y1]) {
  const W = st.canvas.width, w = x1 - x0 + 1, h = y1 - y0 + 1, im = st.g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) st.pixel(im.data, (y * w + x) * 4, (y0 + y) * W + x0 + x);
  st.g.putImageData(im, x0, y0);
}
// 手感：輕微防手震（位置往目標平滑靠近）、筆觸間距隨筆刷大小，畫面更新合併到每一幀一次
function strokeTo(x, y, final = false) {
  const st = stroke;
  if (st.kind === 'paint') [x, y] = aApply(st.Tinv, x, y);
  if (st.last && !final) { const k = 0.45; x = st.last[0] + (x - st.last[0]) * k; y = st.last[1] + (y - st.last[1]) * k; }
  const [lx, ly] = st.last || [x, y], dist = Math.hypot(x - lx, y - ly);
  const step = Math.max(0.35, Math.min(st.size * 0.06 + st.soft * 0.06, 4)), n = Math.max(1, Math.ceil(dist / step));
  for (let k = st.last ? 1 : 0; k <= n; k++) {
    const b = dab(st, lx + (x - lx) * k / n, ly + (y - ly) * k / n);
    if (b) st.box = st.box ? [Math.min(st.box[0], b[0]), Math.min(st.box[1], b[1]), Math.max(st.box[2], b[2]), Math.max(st.box[3], b[3])] : b;
  }
  st.last = [x, y];
  if (st.box && !st.raf) st.raf = requestAnimationFrame(() => { st.raf = 0; if (st.box) { flushStroke(st, st.box); st.box = null; } });
}
// 繪圖結束：畫布裁到「原圖範圍 ∪ 有內容的像素」，並調整圖層位置讓畫面不動
function trimPaintCanvas(n, st) {
  const c = st.canvas, W = c.width, H = c.height, a = D.assets.get(n.image.assetId);
  if (!st.ox && !st.oy && W === a.w && H === a.h) return c;
  const px = st.g.getImageData(0, 0, W, H).data;
  let x0 = st.ox, y0 = st.oy, x1 = st.ox + a.w - 1, y1 = st.oy + a.h - 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] > 2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const w2 = x1 - x0 + 1, h2 = y1 - y0 + 1, o = document.createElement('canvas');
  o.width = w2; o.height = h2;
  o.getContext('2d').drawImage(c, -x0, -y0);
  // 新圖的 (0,0) = 舊圖本地的 d；旋轉縮放以圖中心為軸 → 修正位置
  const dx = x0 - st.ox, dy = y0 - st.oy, im = n.image, s = im.scale ?? 1, r = (im.rot || 0) * DEG, co = Math.cos(r) * s, si = Math.sin(r) * s;
  const qx = w2 / 2 - a.w / 2 + dx, qy = h2 / 2 - a.h / 2 + dy;
  im.x += a.w / 2 - w2 / 2 + co * qx - si * qy;
  im.y += a.h / 2 - h2 / 2 + si * qx + co * qy;
  if (im.crop) im.crop = { x0: im.crop.x0 - dx, y0: im.crop.y0 - dy, x1: im.crop.x1 - dx, y1: im.crop.y1 - dy };
  return o;
}
function endStroke() {
  const st = stroke;
  if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
  if (st.box) { flushStroke(st, st.box); st.box = null; }
  stroke = null;
  if (st.kind === 'depth') {
    const P = P3D.nodeOf(st.node), W = D.data.width, H = D.data.height;
    if (!P.mapId) { P.mapId = Model.uid('dm_'); if (P.depthFar === undefined || P.depthFar === null) P.depthFar = P3D.depthOf(st.node, D.data); if (P.depth === null || P.depth === undefined) P.depth = P.depthFar; }
    D.masks.set(P.mapId, { data: st.out, w: W, h: H, v: ++maskVer });
    commit(); renderTree(); renderRight();
    return;
  }
  if (st.kind === 'mask') {
    const obj = editableMask(D, st.node);
    obj.data.set(st.out);
    obj.v = ++maskVer;
  } else {
    const n = st.node, old = D.data.assets[n.image.assetId];
    n.image.assetId = assetFromCanvas(D, old ? old.name : n.name, trimPaintCanvas(n, st));
  }
  commit(); renderRight();
}
// ---------- 魔術棒 ----------
// wandSel = { id: 圖層, ops: [{ lx, ly, sub }], inv, mask: Float32Array（圖層像素）, prev: 預覽 canvas }
let wandSel = null;
Object.assign(tool, { wandTol: 32, wandSoft: 1, wandGrow: 0, wandContig: true });
function wandRegion(a, lx, ly) {
  const { w, h, rgba } = a, N = w * h, out = new Uint8Array(N), s = (ly * w + lx) * 4, tol = tool.wandTol;
  const same = i => { const o = i * 4; return Math.max(Math.abs(rgba[o] - rgba[s]), Math.abs(rgba[o + 1] - rgba[s + 1]), Math.abs(rgba[o + 2] - rgba[s + 2]), Math.abs(rgba[o + 3] - rgba[s + 3])) <= tol; };
  if (!tool.wandContig) { for (let i = 0; i < N; i++) if (same(i)) out[i] = 1; return out; }
  const q = new Int32Array(N); let qh = 0, qt = 0;
  q[qt++] = ly * w + lx; out[ly * w + lx] = 1;
  while (qh < qt) {
    const i = q[qh++], x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < N && !out[j] && same(j)) { out[j] = 1; q[qt++] = j; }
  }
  return out;
}
function wandCompute() {
  const n = node(wandSel.id), a = n && D.assets.get(n.image.assetId);
  if (!a) { wandSel = null; return; }
  const { w, h } = a, N = w * h;
  let m = new Uint8Array(N);
  for (const op of wandSel.ops) { const r = wandRegion(a, op.lx, op.ly); for (let i = 0; i < N; i++) if (r[i]) m[i] = op.sub ? 0 : 1; }
  if (wandSel.inv) for (let i = 0; i < N; i++) m[i] = 1 - m[i];
  // 擴張 / 收縮：一次一格
  for (let k = 0; k < Math.abs(tool.wandGrow); k++) {
    const grow = tool.wandGrow > 0, src = m.slice();
    for (let i = 0; i < N; i++) {
      if (src[i] === (grow ? 1 : 0)) continue;
      const x = i % w, nb = [x > 0 ? src[i - 1] : 0, x < w - 1 ? src[i + 1] : 0, i >= w ? src[i - w] : 0, i < N - w ? src[i + w] : 0];
      if (grow ? nb.some(v => v) : nb.some(v => !v)) m[i] = grow ? 1 : 0;
    }
  }
  // 柔邊：方框模糊兩次
  let f = Float32Array.from(m);
  const r = tool.wandSoft;
  if (r > 0) for (let pass = 0; pass < 2; pass++) {
    const t2 = new Float32Array(N);
    for (let y = 0; y < h; y++) { let acc = 0; for (let x = -r; x < w + r; x++) { if (x + r < w) acc += f[y * w + Math.min(w - 1, x + r)]; if (x - r - 1 >= 0) acc -= f[y * w + x - r - 1]; if (x >= 0 && x < w) t2[y * w + x] = acc / (2 * r + 1); } }
    const t3 = new Float32Array(N);
    for (let x = 0; x < w; x++) { let acc = 0; for (let y = -r; y < h + r; y++) { if (y + r < h) acc += t2[Math.min(h - 1, y + r) * w + x]; if (y - r - 1 >= 0) acc -= t2[(y - r - 1) * w + x]; if (y >= 0 && y < h) t3[y * w + x] = acc / (2 * r + 1); } }
    f = t3;
  }
  wandSel.mask = f;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const img = new ImageData(w, h);
  for (let i = 0; i < N; i++) if (f[i] > 0.01) { img.data[i * 4] = 40; img.data[i * 4 + 1] = 200; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = Math.round(f[i] * 150); }
  c.getContext('2d').putImageData(img, 0, 0);
  wandSel.prev = c;
}
// 刪除選取的區塊：圖層換成挖掉那塊的新圖（可以 Ctrl+Z 復原）
function wandDelete() {
  if (!wandSel || !wandSel.mask) return;
  const n = node(wandSel.id), a = n && D.assets.get(n.image.assetId);
  if (!a) return;
  const c = document.createElement('canvas'); c.width = a.w; c.height = a.h;
  const g = c.getContext('2d'), img = new ImageData(new Uint8ClampedArray(a.rgba), a.w, a.h), m = wandSel.mask;
  for (let i = 0; i < a.w * a.h; i++) if (m[i] > 0) img.data[i * 4 + 3] = Math.round(img.data[i * 4 + 3] * (1 - m[i]));
  g.putImageData(img, 0, 0);
  const old = D.data.assets[n.image.assetId];
  n.image.assetId = assetFromCanvas(D, old ? old.name : n.name, c);
  wandSel = null;
  commit(); renderAll();
}
const lassoNearStart = (mx, my) => {
  if (!lasso || lasso.pts.length < 3) return false;
  const f = aApply(viewAffine(), lasso.pts[0][0], lasso.pts[0][1]);
  return Math.hypot(f[0] - mx, f[1] - my) < 10;
};
function finishLasso() {
  if (!lasso || lasso.pts.length < 3) { lasso = null; return; }
  if (eyePick) { const pts = lasso.pts, sub = lasso.mode === 'sub'; lasso = null; eyePickPaint(g => { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); }, sub); eyePickChanged(); return; }
  const n = sel(), pts = lasso.pts, sub = lasso.mode === 'sub';
  lasso = null;
  paintMask(D, n, g => { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); }, sub);
  commit(); renderRight();
}

function addPinAt(n, x, y) {
  if (x < 0 || y < 0 || x >= D.data.width || y >= D.data.height) return;
  if (!alphaAtDoc(x, y)) { toast('錨點要放在圖片內容上（目前點在透明處）', 'warn'); return; }
  for (const m of D.data.nodes) for (const p of m.pins) if (Math.hypot(p.x - x, p.y - y) < 4) { toast('太靠近既有的錨點', 'warn'); return; }
  const p = { id: Model.uid('pin_'), x: Math.round(x), y: Math.round(y), kind: n.pins.length ? 'move' : 'fixed' };
  n.pins.push(p);
  D.ui.selPin = p.id;
  commit(); renderRight(); renderStatus();
}
function deletePin(n, p) {
  n.pins = n.pins.filter(q => q !== p);
  if (n.pins[0]) n.pins[0].kind = 'fixed';
  if (D.ui.selPin === p.id) D.ui.selPin = null;
  commit(); renderRight(); renderStatus();
}

function setupPointer() {
  const ov = $('#overlay');
  const pos = e => { const r = ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  ov.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!D || D.ui.simple) return;
    if (lasso) { lasso = null; return; }
    const [mx, my] = pos(e);
    if (tool.name === 'pin' && D.ui.mode === 'edit') {
      const h = hitPin(mx, my, sel());
      if (h && h.n.type !== 'root') { deletePin(h.n, h.p); return; }
    }
    const [x, y] = toDoc(mx, my);
    const n = pickAt(D, x, y) || sel();
    if (n) { selectNode(n.id); showMenu(e.clientX, e.clientY, nodeMenu(n)); }
  });
  ov.addEventListener('dblclick', e => {
    if (!D) return;
    if (lasso) return;
    if (D.ui.mode === 'edit') {
      const [mx, my] = pos(e), h = hitPin(mx, my, tool.name === 'select' ? null : sel());
      if (h && h.n.type !== 'root') deletePin(h.n, h.p);
    }
  });
  ov.addEventListener('pointerdown', e => {
    if (!D) return;
    hideMenu();
    const [mx, my] = pos(e), [x, y] = toDoc(mx, my);
    // 簡易模式：畫面只能平移（中鍵 / 空白鍵），不能選部位、放錨點
    if (D.ui.simple && !wiz && e.button === 0 && !spaceDown && D.ui.simplePins) {
      // 拖曳錨點（照畫面上的位置移動同樣的距離；拖的時候先暫停）
      let best = null, bd = 12;
      for (const h of simplePins) { const d = Math.hypot(h.x - mx, h.y - my); if (d < bd) { bd = d; best = h; } }
      if (best) { holdPlay(); drag = { type: 'spin', p: best.p, lx: x, ly: y, moved: false }; cap(); return; }
    }
    if (D.ui.simple && !wiz && e.pointerType === 'touch') { drag = { type: 'pan', sx: mx, sy: my, px: D.ui.panX, py: D.ui.panY }; ov.setPointerCapture(e.pointerId); return; }
    if (D.ui.simple && !wiz && !(e.button === 1 || (e.button === 0 && spaceDown))) return;
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      drag = { type: 'pan', sx: mx, sy: my, px: D.ui.panX, py: D.ui.panY };
      ov.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    if (e.button !== 0) return;
    const cap = () => ov.setPointerCapture(e.pointerId);
    const th = tlHandle();
    if (th && Math.hypot(th.x - mx, th.y - my) < 12) {
      const n = th.n, Mi = aInv(lastDraw.M);
      drag = { type: 'tlmove', n, Mi, sx: mx, sy: my, tx: Model.keyVal(D.data, n, 'tx', D.ui.frame), ty: Model.keyVal(D.data, n, 'ty', D.ui.frame) };
      holdPlay(); cap(); return;
    }
    if (th && Math.hypot(th.x - mx, th.y - ROT_R - my) < 10) {
      drag = { type: 'tlrot', n: th.n, cx: th.x, cy: th.y, a: Math.atan2(my - th.y, mx - th.x), acc: 0, rot: Model.keyVal(D.data, th.n, 'rot', D.ui.frame) };
      holdPlay(); cap(); return;
    }
    if (D.ui.fit) {
      const V = viewAffine();
      const h = fitHandles().find(h => { const q = aApply(V, h.x, h.y); return Math.hypot(q[0] - mx, q[1] - my) < 10; });
      if (h) { drag = { type: 'fit', k: h.k }; cap(); }
      return;
    }
    const n = sel();
    if (wiz && D.ui.mode === 'edit') {
      const h = wizHit(mx, my);
      if (h) { drag = { type: 'wiz', h, moved: false }; cap(); return; }
      if (wiz.step && e.pointerType === 'touch') { drag = { type: 'wiztap', sx: mx, sy: my, x0: x, y0: y, x, y }; cap(); return; }
      if (wiz.step) {
        if (WIZ_SEGS[wiz.step] && !wiz.pend) { wiz.pend = [Math.round(x), Math.round(y)]; wiz.mouse = [x, y]; drag = { type: 'wizhair', sx: mx, sy: my, moved: false }; cap(); renderWizard(); return; }
        wizardClick(x, y); return;
      }
    }
    { const rd = rigPointerDown(mx, my, x, y); if (rd) { drag = rd; cap(); return; } }
    const F = D.ui.mode === 'edit' && faceSel();
    if (F) {
      const V = viewAffine(), h = faceHandles(F).find(([, hx, hy]) => { const q = aApply(V, hx, hy); return Math.hypot(q[0] - mx, q[1] - my) < 9; });
      if (h) { drag = { type: 'face', k: h[0], F, sx: x, sy: y, base: JSON.parse(JSON.stringify(F)) }; cap(); return; }
    }
    if (tool.name === 'select') {
      const h = hitPin(mx, my);
      if (h && D.ui.mode === 'edit' && h.n.type !== 'root') {
        if (h.n.id !== D.ui.sel) selectNode(h.n.id);
        D.ui.selPin = h.p.id;
        drag = { type: 'pin', n: h.n, p: h.p, ox: h.p.x, oy: h.p.y, moved: false }; cap();
        return;
      }
      const p = pickAt(D, x, y);
      selectNode(p ? p.id : 'root');
      return;
    }
    if (D.ui.mode !== 'edit') setMode('edit');
    if (tool.name === 'crop') { const cd = cropPointerDown(mx, my); if (cd) { drag = cd; cap(); } return; }
    // 群組：變形工具拖曳 = 整組一起移動
    if (tool.name === 'transform' && lgById(D.ui.selLg)) {
      drag = { type: 'gmove', ids: lgIds(lgById(D.ui.selLg)), lx: Math.round(x), ly: Math.round(y), tx: 0, ty: 0 };
      cap(); return;
    }
    if (tool.name === 'transform' && n && n.type === 'group') {
      drag = { type: 'gmove', g: n, ids: [...Model.descendants(D.data, n.id)], lx: Math.round(x), ly: Math.round(y), tx: 0, ty: 0 };
      cap(); return;
    }
    if (tool.name === 'transform') {
      const hs = xformHandles();
      if (!hs) { toast('請先選擇一個圖層（或圖層底下的部位）', 'warn'); return; }
      const near = (q, r = 10) => Math.hypot(q[0] - mx, q[1] - my) < r;
      const p = hs.tg.p, before = layerAffine(p, hs.tg.a);
      const base = { x: p.x, y: p.y, scale: p.scale ?? 1, rot: p.rot || 0, crop: p.crop ? { ...p.crop } : null };
      const cdoc = aApply(before, hs.tg.a.w / 2, hs.tg.a.h / 2);
      let k = null;
      if (tool.crop && !hs.tg.align) { const i = hs.edges.findIndex(q => near(q)); if (i >= 0) k = 'crop' + i; }
      else if (near(hs.rot)) k = 'rot';
      else if (hs.corners.some(q => near(q))) k = 'scale';
      if (!k) {
        const [lx, ly] = aApply(aInv(before), x, y);
        if (lx >= hs.c.x0 && ly >= hs.c.y0 && lx <= hs.c.x1 && ly <= hs.c.y1) k = 'move';
      }
      if (!k) return;
      drag = { type: 'xform', k, tg: hs.tg, base, before, cdoc, sx: x, sy: y }; cap();
      return;
    }
    if (tool.name === 'pin') {
      if (n && n.type === 'root') {
        const h = hitPin(mx, my, n);
        if (h) { drag = { type: 'pin', n, p: h.p, ox: h.p.x, oy: h.p.y, moved: false }; cap(); }
        return;
      }
      if (!isPart(n) && n.type !== 'image') { toast('請先在左側選擇一個部位或圖層', 'warn'); return; }
      // 圖層沒有部位屬性 → 不能編輯錨點；先問是什麼，選了才放這一點
      if (n.type === 'image' && !(n.role && TYPES[n.role])) {
        if (!alphaAtDoc(x, y)) { toast('錨點要放在圖片內容上（目前點在透明處）', 'warn'); return; }
        const r = ov.getBoundingClientRect();
        toast('一般圖層不能放錨點：先指定物件屬性', 'warn');
        typeMenu(r.left + mx + 12, r.top + my, v => { if (!v) return; setLayerRole(n, v); addPinAt(n, x, y); renderAll(); toast(`「${n.name}」設為${TYPES[v].label}：繼續點就是擺動鏈`, 'info'); }, { title: '這個圖層是什麼？（選了才能放錨點）', parentId: n.parent });
        return;
      }
      const h = hitPin(mx, my, n);
      if (h) { D.ui.selPin = h.p.id; drag = { type: 'pin', n, p: h.p, ox: h.p.x, oy: h.p.y, moved: false }; cap(); return; }
      addPinAt(n, x, y);
      return;
    }
    if (tool.name === 'paint' && (e.altKey || tool.picking)) {
      const c = stageColorAt(mx, my);
      if (c) setPaintColor(c); else { tool.picking = false; renderToolDetail(); }
      return;
    }
    if (tool.name === 'paint') {
      const tg = xformTarget();
      if (!tg || tg.align) { toast('請先選擇一個圖層', 'warn'); return; }
      stroke = startPaintStroke(tg.n); strokeTo(x, y); drag = { type: 'stroke' }; cap();
      return;
    }
    if (tool.name === 'wand') {
      if (!n || n.type !== 'image') { toast('請先選擇一個圖層', 'warn'); return; }
      const a = D.assets.get(n.image.assetId), [lx, ly] = aApply(aInv(layerAffine(n.image, a)), x, y).map(Math.floor);
      if (lx < 0 || ly < 0 || lx >= a.w || ly >= a.h) return;
      const add = e.shiftKey, sub = e.altKey;
      if (!wandSel || wandSel.id !== n.id || (!add && !sub)) wandSel = { id: n.id, ops: [], inv: false };
      wandSel.ops.push({ lx, ly, sub });
      wandCompute(); renderToolDetail();
      return;
    }
    if (tool.name === 'depth') {
      if (!n || n.type === 'root' || n.type === 'group') { toast('請先選擇一個部位或圖層', 'warn'); return; }
      stroke = startDepthStroke(n, (tool.depthMode === 'erase') !== e.altKey);
      strokeTo(x, y); drag = { type: 'stroke' }; cap();
      return;
    }
    if (eyePick && tool.name === 'mask') { const er = (tool.maskMode === 'erase') !== e.altKey; eyeBrushTo(x, y, er, true); drag = { type: 'eyebrush', er }; cap(); return; }
    if (!isPart(n) && !(eyePick && tool.name === 'lasso')) { toast('請先選擇一個部位（圖層本身不需要遮罩）', 'warn'); return; }
    if (tool.name === 'mask') {
      stroke = startMaskStroke(n, (tool.maskMode === 'erase') !== e.altKey);
      strokeTo(x, y); drag = { type: 'stroke' }; cap();
      return;
    }
    if (tool.name === 'lasso') {
      if (!lasso) lasso = { pts: [], mode: e.altKey ? (tool.lasso === 'add' ? 'sub' : 'add') : tool.lasso };
      if (lassoNearStart(mx, my)) { finishLasso(); return; }
      lasso.pts.push([x, y]);
      drag = { type: 'lasso', lx: mx, ly: my }; cap();
    }
  });
  ov.addEventListener('pointermove', e => {
    if (!D) return;
    const [mx, my] = pos(e), [x, y] = toDoc(mx, my);
    cursor = { x: mx, y: my };
    if (lasso) lasso.hover = [x, y];
    if (wiz) wiz.mouse = [x, y];
    if (!drag) {
      { const th = tlHandle(); if (th && Math.hypot(th.x - mx, th.y - my) < 12) { ov.style.cursor = 'move'; return; } if (th && Math.hypot(th.x - mx, th.y - ROT_R - my) < 10) { ov.style.cursor = 'grab'; return; } }
      const brushy = tool.name === 'mask' || tool.name === 'paint' || tool.name === 'depth';
      ov.style.cursor = spaceDown ? 'grab' : D.ui.mode === 'edit' && hitPin(mx, my, tool.name === 'select' ? null : sel()) ? 'move' : brushy ? 'none' : tool.name === 'select' ? 'default' : 'crosshair';
      return;
    }
    if (drag.type === 'pan') { D.ui.panX = drag.px + mx - drag.sx; D.ui.panY = drag.py + my - drag.sy; return; }
    if (drag.type === 'stroke') { stroke.target = [x, y]; strokeTo(x, y); return; }
    if (drag.type === 'eyebrush') { eyeBrushTo(x, y, drag.er); return; }
    if (drag.type === 'wiz') { drag.h.set([Math.round(x), Math.round(y)]); drag.moved = true; return; }
    if (drag.type === 'spin') { drag.p.x = Math.round(drag.p.x + x - drag.lx); drag.p.y = Math.round(drag.p.y + y - drag.ly); drag.lx = x; drag.ly = y; drag.moved = true; return; }
    if (drag.type === 'wizhair') { if (Math.hypot(mx - drag.sx, my - drag.sy) > 6) drag.moved = true; return; }
    if (drag.type === 'wiztap') {
      drag.x = x; drag.y = y;
      // 單指拖一段距離（頭髮、獸耳、尾巴）：預覽一筆
      if (WIZ_SEGS[wiz.step] && !wiz.pend && Math.hypot(mx - drag.sx, my - drag.sy) > 12) { drag.seg = true; wiz.mouse = [x, y]; }
      return;
    }
    if (drag.type === 'crop') { cropPointerMove(drag, mx, my); return; }
    if (drag.type === 'rig') { rigPointerMove(drag, x, y); return; }
    if (drag.type === 'gmove') {
      const dx = Math.round(x) - drag.lx, dy = Math.round(y) - drag.ly;
      if (dx || dy) { shiftNodes(drag.ids, dx, dy, 'live'); drag.lx += dx; drag.ly += dy; drag.tx += dx; drag.ty += dy; }
      return;
    }
    if (drag.type === 'tlrot') {
      // 累積角度（跨過 ±180° 不會跳），Shift 吸附 15°
      const a = Math.atan2(my - drag.cy, mx - drag.cx);
      let d = a - drag.a; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU;
      drag.acc += d; drag.a = a;
      let r = drag.rot + drag.acc / DEG;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      setKey(drag.n, 'rot', curU(), Math.round(r * 10) / 10);
      drag.moved = true; updateTimelineHead(); return;
    }
    if (drag.type === 'tlmove') {
      const M = drag.Mi, dx = M[0] * (mx - drag.sx) + M[2] * (my - drag.sy), dy = M[1] * (mx - drag.sx) + M[3] * (my - drag.sy);
      setKey(drag.n, 'tx', curU(), Math.round(drag.tx + dx)); setKey(drag.n, 'ty', curU(), Math.round(drag.ty + dy));
      drag.moved = true; updateTimelineHead(); return;
    }
    if (drag.type === 'face') {
      const F = drag.F, b = drag.base, dx = Math.round(x - drag.sx), dy = Math.round(y - drag.sy);
      const { ax, ay, nx, ny } = faceAxes(F);
      if (drag.k === 'center') { F.cx = b.cx + dx; F.cy = b.cy + dy; }
      else if (drag.k === 'R') F.R = Math.max(10, Math.round(Math.abs((x - F.cx) * nx + (y - F.cy) * ny)));
      else if (drag.k === 'Fw') F.Fw = Math.max(5, Math.min(F.R - 2, Math.round(Math.abs((x - F.cx) * nx + (y - F.cy) * ny))));
      else if (drag.k === 'Rv') F.Rv = Math.max(10, Math.round(Math.abs((x - F.cx) * ax + (y - F.cy) * ay)));
      else { F[drag.k].x = b[drag.k].x + dx; F[drag.k].y = b[drag.k].y + dy; }
      return;
    }
    // 按住拖曳 = 自由描邊（每隔幾個螢幕像素記一點）
    if (drag.type === 'lasso') { if (lasso && Math.hypot(mx - drag.lx, my - drag.ly) >= 4) { lasso.pts.push([x, y]); drag.lx = mx; drag.ly = my; } return; }
    if (drag.type === 'fit') {
      const f = D.ui.fit;
      if (drag.k === 'c') { f.cx = x; f.cy = y; }
      else if (drag.k === 'r' || drag.k === 'l') f.rx = Math.max(10, Math.abs(x - f.cx));
      else if (drag.k === 'bottom') f.bottom = Math.max(f.cy, y);
      else f.ry = Math.max(10, Math.abs(y - f.cy));
      return;
    }
    if (drag.type === 'xform') {
      const { k, tg, base, cdoc } = drag, p = tg.p;
      if (k === 'move') { p.x = base.x + x - drag.sx; p.y = base.y + y - drag.sy; }
      else if (k === 'scale') {
        const r = Math.hypot(x - cdoc[0], y - cdoc[1]) / (Math.hypot(drag.sx - cdoc[0], drag.sy - cdoc[1]) || 1);
        const ns = Math.max(0.05, base.scale * r);
        // 以中心為基準縮放：中心位置不變
        p.scale = ns;
      } else if (k === 'rot') {
        let a = base.rot + (Math.atan2(y - cdoc[1], x - cdoc[0]) - Math.atan2(drag.sy - cdoc[1], drag.sx - cdoc[0])) / DEG;
        if (e.shiftKey) a = Math.round(a / 15) * 15;
        p.rot = ((a + 540) % 360) - 180;
      } else if (k.startsWith('crop')) {
        const [lx, ly] = aApply(aInv(drag.before), x, y).map(Math.round);
        const c = p.crop || { x0: 0, y0: 0, x1: tg.a.w, y1: tg.a.h };
        const i = +k.slice(4);
        if (i === 0) c.y0 = Math.max(0, Math.min(c.y1 - 4, ly));
        if (i === 1) c.x1 = Math.min(tg.a.w, Math.max(c.x0 + 4, lx));
        if (i === 2) c.y1 = Math.min(tg.a.h, Math.max(c.y0 + 4, ly));
        if (i === 3) c.x0 = Math.max(0, Math.min(c.x1 - 4, lx));
        p.crop = c;
      }
      if (!tg.align) renderToolDetailValues();
      return;
    }
    if (drag.type === 'pin') {
      drag.p.x = Math.round(Math.max(0, Math.min(D.data.width - 1, x)));
      drag.p.y = Math.round(Math.max(0, Math.min(D.data.height - 1, y)));
      drag.moved = true;
    }
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.type === 'stroke' && stroke) { if (stroke.target) strokeTo(stroke.target[0], stroke.target[1], true); endStroke(); }
    if (d.type === 'face') { commit(); renderParams(); }
    if (d.type === 'eyebrush' && eyePick) { eyePick.last = null; eyePickChanged(); }
    if (d.type === 'wiz') renderWizard();
    if (d.type === 'spin') { if (d.moved) commit(); releasePlay(); }
    // 頭髮：按住拖到髮尾放開 = 直接建立；只點一下 = 線跟著滑鼠，再點一下建立
    if (d.type === 'wizhair' && wiz && d.moved && wiz.mouse) wizardClick(wiz.mouse[0], wiz.mouse[1]);
    // 觸控：沒被兩指縮放取消才算數
    if (d.type === 'wiztap' && wiz && !d.cancel) {
      if (d.seg && WIZ_SEGS[wiz.step] && !wiz.pend) { wizardClick(d.x0, d.y0); wizardClick(d.x, d.y); }
      else if (Math.hypot(d.x - d.x0, d.y - d.y0) * view.base * D.ui.zoom < 14 || !WIZ_SEGS[wiz.step]) wizardClick(d.x0, d.y0);
    }
    if (d.type === 'rig') { commit(); renderParams(); }
    if (d.type === 'gmove' && (d.tx || d.ty)) { shiftNodes(d.ids, d.tx, d.ty, 'masks'); commit(); renderAll(); }   // 遮罩只在放開時平移一次
    if ((d.type === 'tlmove' || d.type === 'tlrot') && d.moved) { commit(); renderTimeline(); }
    if (d.type === 'tlmove' || d.type === 'tlrot') releasePlay();
    if (d.type === 'pin' && d.moved) {
      if (d.n.type !== 'root' && !alphaAtDoc(d.p.x, d.p.y)) { d.p.x = d.ox; d.p.y = d.oy; toast('錨點不能拖到透明處，已放回原位', 'warn'); }
      commit(); renderRight();
    }
    if (d.type === 'xform') {
      if (!d.tg.align && tool.linkRig && !d.k.startsWith('crop')) moveRigWith(d.tg.n, d.before, layerAffine(d.tg.p, d.tg.a));
      if (!d.tg.align) commit();
      renderToolDetail();
    }
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);
  ov.addEventListener('pointerleave', () => { cursor = null; });
  // 兩指縮放 / 平移（只在預覽畫面；網頁本身不會被縮放）
  const touches = new Map();
  let pinch = null;
  ov.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || !D) return;
    touches.set(e.pointerId, pos(e));
    if (touches.size === 2) {
      const [a, b] = [...touches.values()], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z0: D.ui.zoom, doc: toDoc(mid[0], mid[1]) };
      if (drag && drag.type === 'wiztap') drag.cancel = true;
      drag = null; stroke = null; lasso = null;
      if (wiz) { wiz.pend = wiz.pend && wiz.pendTouch ? null : wiz.pend; renderWizard(); }
      e.stopImmediatePropagation();
    }
  }, true);
  ov.addEventListener('pointermove', e => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, pos(e));
    if (!pinch || touches.size < 2) return;
    e.stopImmediatePropagation();
    const [a, b] = [...touches.values()], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], u = D.ui;
    u.zoom = Math.max(0.2, Math.min(10, pinch.z0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d0));
    const sc = u.base * u.zoom;
    u.panX = mid[0] - pinch.doc[0] * sc - (view.cw / 2 - D.data.width * sc / 2);
    u.panY = mid[1] - pinch.doc[1] * sc - (view.ch / 2 - D.data.height * sc / 2);
  }, true);
  const untouch = e => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
  ov.addEventListener('pointerup', untouch, true);
  ov.addEventListener('pointercancel', untouch, true);
  ov.addEventListener('wheel', e => {
    if (!D) return;
    e.preventDefault();
    const [mx, my] = pos(e), [ix, iy] = toDoc(mx, my), u = D.ui;
    u.zoom = Math.max(0.2, Math.min(10, u.zoom * Math.exp(-e.deltaY * 0.0015)));
    const s = u.base * u.zoom;
    u.panX = mx - ix * s - (view.cw / 2 - D.data.width * s / 2);
    u.panY = my - iy * s - (view.ch / 2 - D.data.height * s / 2);
  }, { passive: false });
}

// ---------- 選單 ----------
// ---------- 軟體選單（左上角「彈design」）----------
function appMenu() {
  const b = $('#brand').getBoundingClientRect();
  const doc = !!D;
  showMenu(b.left, b.bottom + 2, [
    { label: '主頁', run: showHome },
    { label: D && D.ui.simple ? '切換到完整模式' : '切換到簡易模式', disabled: !doc, run: () => setSimple(!D.ui.simple) },
    '-',
    { label: '開啟檔案…', icon: 'open', hint: keyLabel(keyOf('open')), run: () => $('#fileOpen').click() },
    { label: '儲存專案', icon: 'save', hint: keyLabel(keyOf('save')), disabled: !doc, run: () => saveProject() },
    { label: '另存新檔…', hint: keyLabel(keyOf('saveAs')), disabled: !doc, run: () => saveProject(true) },
    { label: '輸出動畫…', icon: 'export', hint: keyLabel(keyOf('export')), disabled: !doc, run: openExport },
    '-',
    { label: doc && hasRigging() ? '重新建模' : '快速建模', icon: 'auto', disabled: !doc, run: startQuickBuild },
    '-',
    { label: '範例' },
    ...Object.entries(Demo.samples).map(([k, s]) => ({ label: s.label, run: () => openSample(k) })),
    '-',
    { label: '復原', icon: 'undo', hint: keyLabel(keyOf('undo')), disabled: !doc, run: undo },
    { label: '重做', icon: 'redo', hint: keyLabel(keyOf('redo')), disabled: !doc, run: redo },
    '-',
    { label: '設定…', disabled: !doc, run: openSettings },
    { label: '快捷鍵設定…', run: openKeySettings },
    { label: `彈design v${APP_VERSION}`, disabled: true, run: () => {} },
    { label: '說明…', run: openHelp },
  ]);
}
function openDialog(title, body, foot, wide) {
  const m = $('#modal');
  m.innerHTML = '';
  m.append(el('div', { class: 'dialog' + (wide ? ' wide' : '') }, el('h2', {}, title), body, el('div', { class: 'dfoot' }, ...foot)));
  m.classList.remove('hidden');
  return () => m.classList.add('hidden');
}
// 設定：FPS（預設 30；只影響時間軸每一格的長度與輸出幀數，動作的位置以循環比例保存）
function openSettings() {
  if (!D) return;
  const TL = D.data.timeline;
  const body = el('div', { class: 'dbody' },
    selectField('FPS', [[24, '24'], [30, '30（預設）'], [60, '60']], () => TL.fps, v => {
      const r = +v / TL.fps; TL.fps = +v; D.ui.frame *= r;
      for (const n of D.data.nodes) if (n.image) for (const va of n.image.variants || []) va.segs = segsOf(va).map(([a, b]) => [Math.round(a * r), Math.round(b * r)]);
      renderAll(); updatePlaybar();
    }, null, '只影響畫面流暢度、時間軸每一格的長度與輸出幀數，不影響速度'));
  const close = openDialog('設定', body, [el('button', { class: 'btn primary', onclick: () => close() }, '完成')]);
}
// 快捷鍵設定：點按鍵欄位後按下新的組合（Esc 取消、Backspace 清除）
let keyCapture = null;
function openKeySettings() {
  const body = el('div', { class: 'dbody keys' });
  const draw = () => {
    body.innerHTML = '';
    let grp = '';
    for (const [id, g, name] of KEY_DEFS) {
      if (g !== grp) { grp = g; body.append(el('div', { class: 'khead' }, g)); }
      const on = keyCapture === id;
      body.append(el('div', { class: 'krow' }, el('span', {}, name),
        el('button', { class: 'kbtn' + (on ? ' on' : ''), onclick: () => { keyCapture = on ? null : id; draw(); } }, on ? '請按下按鍵…' : keyLabel(keyOf(id)) || '（無）')));
    }
    body.append(el('div', { class: 'khead' }, '固定操作'));
    for (const [k, d] of FIXED_KEYS) body.append(el('div', { class: 'krow' }, el('span', {}, d), el('span', { class: 'kfix' }, k)));
  };
  keyCapture = null;
  draw();
  openKeySettings.redraw = draw;
  const close = openDialog('快捷鍵設定', body, [
    el('button', { class: 'btn', onclick: () => { if (confirm('全部恢復成預設的快捷鍵？')) { keyMap = Object.fromEntries(KEY_DEFS.map(([id, , , k]) => [id, k])); saveKeys(); draw(); } } }, '恢復預設'),
    el('button', { class: 'btn primary', onclick: () => { keyCapture = null; close(); } }, '完成')], true);
}
// 快捷鍵設定中：攔下按鍵（回傳 true = 已處理）
function captureKey(e) {
  if (!keyCapture) return false;
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape') { keyCapture = null; openKeySettings.redraw(); return true; }
  const c = e.key === 'Backspace' || e.key === 'Delete' ? '' : comboOf(e);
  if (c === null) return true;
  const other = c && KEY_DEFS.find(([id]) => id !== keyCapture && keyMap[id] === c);
  if (other) { keyMap[other[0]] = ''; toast(`「${other[2]}」原本的 ${keyLabel(c)} 已移除`, 'warn'); }
  keyMap[keyCapture] = c;
  keyCapture = null;
  saveKeys();
  openKeySettings.redraw();
  return true;
}
function openHelp() {
  const sec = (t, ...rows) => [el('div', { class: 'khead' }, t), ...rows.map(r => Array.isArray(r) ? el('div', { class: 'krow' }, el('span', {}, r[1]), el('span', { class: 'kfix' }, r[0])) : el('p', { class: 'hp' }, r))];
  const body = el('div', { class: 'dbody keys' },
    ...sec('基本流程',
      '1. 開啟圖片、PSD 或專案（也可以直接拖進視窗）。',
      '2. 左側「部位」建立頭、身體、頭髮等部位：錨點工具放支點與運動點，遮罩筆畫範圍；分層檔可按「自動綁定」。',
      '3. 右側調整動作參數；「立體」分頁設定轉頭與深度，選「頭」可在畫面上定位五官（頭部定位）。',
      '4. 上方切到「預覽」看動畫，時間軸可加關鍵影格。',
      '5. 「輸出」存成 MP4 / WebM / APNG / GIF / PNG 序列。'),
    ...sec('工具', ...TOOLS.map(([name, , title]) => [keyLabel(keyOf('tool.' + name)) || '—', title.replace(/\s*\(.\)$/, '')])),
    ...sec('檔案與播放', ...KEY_DEFS.filter(d => ['檔案', '編輯', '播放', '筆刷'].includes(d[1])).map(([id, , name]) => [keyLabel(keyOf(id)) || '—', name])),
    ...sec('滑鼠與固定按鍵', ...FIXED_KEYS),
    ...sec('專案檔',
      '「儲存專案」存成 .彈design.png：本身是一張作品縮圖（檔案總管可直接預覽），專案資料藏在圖檔裡；拖回來或用「開啟檔案」即可繼續編輯。舊的 .puppet 也能開。'));
  const close = openDialog('說明', body, [el('button', { class: 'btn primary', onclick: () => close() }, '關閉')], true);
}
let menuShownAt = 0;
function showMenu(x, y, items) {
  menuShownAt = performance.now();
  const m = $('#popmenu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.append(el('div', { class: 'msep' })); continue; }
    if (it.label && !it.run) { m.append(el('div', { class: 'mlabel' }, it.label)); continue; }
    // it.dim：灰色不能選，但滑過去能看到 it.tip（disabled 的按鈕不會顯示提示）
    m.append(el('button', { disabled: it.disabled, class: it.dim ? 'mdis' : null, title: it.tip || null, onclick: e => { e.stopPropagation(); if (it.dim) return; hideMenu(); it.run(); } }, it.icon ? ico(it.icon) : el('span', { class: 'ico' }), it.label, it.hint ? el('span', { class: 'mkey' }, it.hint) : null));
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
}
function hideMenu() { $('#popmenu').classList.add('hidden'); }
// 五官（臉、眼睛、鼻子、口、眉毛）只能放在「頭」底下（頭部件，或物件屬性是頭的圖層）
const FEATURES = new Set(Model.TYPE_MENU.find(c => c[0] === '五官')[1]);
const isHeadNode = p => !!p && (Model.baseType(p.type) === 'head' || (p.type === 'image' && !!p.role && Model.baseType(p.role) === 'head'));
const isFeatureNode = n => FEATURES.has(n.type) || (n.type === 'image' && !!n.role && FEATURES.has(n.role));
// 父層要求：頭部物件（頭以外）、五官 → 父層要是頭；上半身物件（軀幹以外）→ 父層要是軀幹。下半身、其他不限制
// 頭部 / 上半身可以隔著同一類的物件（例如小臂掛在上臂底下、髮尾掛在頭髮底下）或群組；五官要直接放在頭底下
const nodeRole = p => !p ? null : p.type === 'image' ? (p.role && TYPES[p.role] ? p.role : null) : p.type;
const catOf = t => (Model.TYPE_MENU.find(c => c[1] && c[1].includes(t)) || [])[0];
const PARENT_REQ = { '頭部': ['head', '頭'], '五官': ['head', '頭'], '上半身': ['torso', '軀幹'] };
const parentReq = t => t === 'head' || t === 'torso' ? null : PARENT_REQ[catOf(t)] || null;
const parentReqText = t => { const r = parentReq(t); return r ? `${TYPES[t].label}要放在「${r[1]}」底下${catOf(t) === '五官' ? '' : `（父層是${r[1]}，或${r[1]}底下的同類物件）`}` : ''; };
function parentOk(t, p) {
  const r = parentReq(t);
  if (!r) return true;
  const c = catOf(t);
  for (let q = p, i = 0; q && i < 64; q = node(q.parent), i++) {
    const rq = nodeRole(q);
    if (rq === r[0]) return true;
    if (c === '五官') return false;
    if (q.type !== 'group' && !(rq && catOf(rq) === c)) return false;
  }
  return false;
}
// 名稱不能重複：改名時檢查
function setNodeName(n, v) {
  v = (v || '').trim();
  if (!v || v === n.name) return false;
  if (D.data.nodes.some(m => m !== n && m.name === v)) { toast(`「${v}」這個名稱已經有了：名稱不能重複`, 'warn'); return false; }
  n.name = v;
  return true;
}
// 類型分類選單：頭部 / 五官 / 上半身 / 下半身 / 其他，點分類再展開；o.none = 最上面加「不指定」、o.group = 加「群組」、o.title = 標題
// o.parentId：新部位 / 這個圖層的父層；不是頭時五官整類灰掉
function typeMenu(x, y, pick, o = {}) {
  const items = [];
  if (o.title) items.push({ label: o.title });
  if (o.none) items.push({ label: (o.current ? '' : '✓ ') + o.none, run: () => pick('') }, '-');
  for (const [label, list, direct] of Model.TYPE_MENU) {
    if (direct) { items.push({ label: (o.current === direct ? '✓ ' : '') + label, icon: TYPES[direct].icon, run: () => pick(direct) }); continue; }
    const cur = list.includes(o.current) ? `（${TYPES[o.current].label}）` : '';
    items.push({ label: `${label} ›${cur}`, run: () => setTimeout(() => showMenu(x, y, [
      { label: '‹ ' + label, run: () => setTimeout(() => typeMenu(x, y, pick, o), 0) }, '-',
      ...list.map(t => {
        // 父層不符合要求 → 灰色，滑過去顯示要求
        const bad = 'parentId' in o && !parentOk(t, node(o.parentId));
        return { label: (o.current === t ? '✓ ' : '') + TYPES[t].label, icon: TYPES[t].icon, dim: bad, tip: bad ? parentReqText(t) : '', run: () => pick(t) };
      })]), 0) });
  }
  if (o.group) items.push('-', { label: TYPES.group.label, icon: TYPES.group.icon, run: () => pick('group') });
  showMenu(x, y, items);
}
// 圖層當部位：指定類型 → 套用該類型的動作預設（錨點 = 支點 + 擺動鏈）
function setLayerRole(n, v) {
  n.role = v || null;
  n.params = typeDefaults(v || 'image');
  if (!n.region) n.region = Model.defaultRegion(D.data, v || 'image');
}
function typeItems(parentFn) {
  return Model.ADD_TYPES.map(t => ({ label: TYPES[t].label, icon: TYPES[t].icon, run: () => createPart(t, parentFn()) }));
}
function nodeMenu(n) {
  const items = [];
  const drawable = Model.isDrawable(n);
  items.push({ label: '新增子部位…', icon: 'plus', run: () => { const par = n.type === 'root' ? defaultParent() : n.id; setTimeout(() => typeMenu(menuPos.x, menuPos.y, t => createPart(t, par), { group: true, parentId: par }), 0); } });
  if (n.type === 'root') return items;
  items.push({ label: '重新命名', run: () => renameInTree(n) });
  items.push({ label: '複製', run: () => duplicate(n) });
  items.push('-');
  if (drawable || n.type === 'group') items.push({ label: n.visible === false ? '顯示' : '隱藏', icon: n.visible === false ? 'eye' : 'eyeOff', run: () => { n.visible = n.visible === false; commit(); renderAll(); } });
  if (n.type !== 'image') items.push({ label: n.enabled ? '停用動作' : '啟用動作', run: () => { n.enabled = !n.enabled; commit(); renderAll(); } });
  if (isPart(n) && n.type !== 'group') {
    items.push({ label: n.detach ? '取消獨立圖層' : '切成獨立圖層', icon: 'cut', run: () => toggleDetach(n) });
    if (n.region.mode === 'auto') items.push({ label: '範圍轉成可編輯遮罩', icon: 'mask', run: () => { editableMask(D, n); commit(); renderAll(); } });
    else items.push({ label: '依錨點重建範圍', run: () => { n.region.mode = 'auto'; commit(); renderAll(); } });
    items.push({ label: '參數重設為預設', run: () => { n.params = JSON.parse(JSON.stringify(TYPES[n.type].defaults)); commit(); renderAll(); } });
  }
  if (n.type === 'image') {
    items.push({ label: '取代圖片（對齊後繼承動態）…', icon: 'image', run: () => startReplace(n) });
    items.push({ label: '匯出 PNG', icon: 'export', run: () => exportLayerPNG(n) });
  }
  if (n.detach && n.type !== 'image') {
    items.push({ label: '匯出 PNG', icon: 'export', run: () => exportLayerPNG(n) });
    items.push({ label: '轉成圖片圖層（可繪圖 / 取代）', icon: 'image', run: () => bakeDetached(n) });
  }
  items.push('-');
  items.push({ label: '刪除', icon: 'trash', run: () => deleteNode(n) });
  return items;
}
const menuPos = { x: 0, y: 0 };
document.addEventListener('contextmenu', e => { menuPos.x = e.clientX; menuPos.y = e.clientY; }, true);

function defaultParent() {
  const s = sel();
  if (s && s.type !== 'root') return s.id;
  const img = D.data.nodes.find(n => n.type === 'image');
  return img ? img.id : 'root';
}
function createPart(t, parent) {
  if (!parentOk(t, node(parent))) { toast(parentReqText(t) + '：請先選取正確的父層再新增', 'warn'); return; }
  const n = addPart(D, t, null, parent);
  if (t !== 'group') n.params = typeDefaults(t);
  const same = D.data.nodes.filter(x => x.type === t && x.parent === parent).length;
  if ((t === 'arm' || t === 'ear' || t === 'hair' || t === 'backhair') && same % 2 === 0) { n.mirror = true; n.delay = t === 'hair' ? 3 : 2; }
  const p = node(parent); if (p) p.collapsed = false;
  D.ui.sel = n.id;
  commit(); renderAll();
  setTool('pin');
}
// 刪除：圖層 / 群組連同底下一起刪；部位只刪自己，底下的圖層與子部位接回上一層
function deleteNode(n) {
  if (!n || n.type === 'root') return;
  if (!Model.isDrawable(n) && n.type !== 'group') {
    for (const c of D.data.nodes) if (c.parent === n.id) c.parent = n.parent;
    D.data.nodes = D.data.nodes.filter(x => x !== n);
  } else {
    const ids = Model.descendants(D.data, n.id);
    D.data.nodes = D.data.nodes.filter(x => !ids.has(x.id));
  }
  D.ui.sel = n.parent && node(n.parent) ? n.parent : 'root';
  D.ui.selPin = null;
  commit(); renderAll();
}
function duplicate(n) {
  const ids = [...Model.descendants(D.data, n.id)];
  const map = new Map(ids.map(id => [id, Model.uid('n_')]));
  const copies = ids.map(id => {
    const c = JSON.parse(JSON.stringify(node(id)));
    c.id = map.get(id);
    c.parent = id === n.id ? n.parent : map.get(c.parent);
    c.pins.forEach(p => { p.id = Model.uid('pin_'); });
    if (c.region && c.region.maskId && D.masks.get(c.region.maskId)) { const nid = Model.uid('m_'); D.masks.set(nid, D.masks.get(c.region.maskId)); c.region.maskId = nid; }
    if (id === n.id) c.name += ' 複製';
    if (Model.isDrawable(c)) c.order = nextOrder(D) + ids.indexOf(id);
    return c;
  });
  const i = D.data.nodes.indexOf(n);
  D.data.nodes.splice(i + 1, 0, ...copies);
  for (const c of copies) c.name = Model.uniqueName(D.data, c.name, c);
  D.ui.sel = copies[0].id;
  commit(); renderAll();
}
function toggleDetach(n) {
  n.detach = !n.detach;
  const img = Model.imageOf(D.data, n);
  if (n.detach && img && !n.order) n.order = img.order + 1;
  commit(); renderAll();
}
function exportLayerPNG(n) {
  ensureDerived(D);
  const dr = D.cache.drawables.find(d => d.id === n.id);
  const c = n.type === 'image' ? D.assets.get(n.image.assetId).canvas : dr && dr.canvas;
  if (!c) { toast('這個部位目前沒有像素可匯出', 'warn'); return; }
  c.toBlob(b => saveBlob(b, `${n.name}.png`), 'image/png');
}
// 把獨立部位的像素烘焙成真正的圖層（之後可繪圖、匯出、取代）
function bakeDetached(n) {
  ensureDerived(D);
  const img = Model.imageOf(D.data, n);
  const pieceDr = D.cache.drawables.find(d => d.id === n.id), baseDr = D.cache.drawables.find(d => d.id === img.id);
  if (!pieceDr || !baseDr) return;
  const baseId = assetFromCanvas(D, D.data.assets[img.image.assetId].name, baseDr.canvas);
  const pieceId = assetFromCanvas(D, n.name, pieceDr.canvas);
  img.image.assetId = baseId;
  img.image.crop = null;
  const layer = Model.makeNode(D.data, 'image', n.id, { name: n.name + ' 圖層', order: n.order, image: { ...JSON.parse(JSON.stringify(img.image)), assetId: pieceId, variants: [] } });
  n.detach = false;
  n.region.mode = 'none';
  D.data.nodes.push(layer);
  D.ui.sel = layer.id;
  commit(); renderAll();
  toast('已轉成圖片圖層：可用繪圖工具修改，或右鍵匯出 / 取代', 'info');
}

// ---------- 快速建模精靈（不看圖層名稱，由使用者指定；從左上角選單叫出）----------
// 分層：每個圖層選物件屬性（和「物件屬性」選單同一套類型）→ 依手動調好的範例建立層次：
//   身體圖層 → 軀幹部位（脊椎鏈，支點在脖子）→ 頭圖層 → 頭部位（支點在下巴、延遲）→ 頭髮 / 五官 / 耳朵圖層
//   頭髮圖層：沿形狀垂下的鏈；尾巴 / 觸手 / 飾品：每一條分支各一條鏈（從靠近身體的一端開始）
// 單張圖：在畫面上依序點「軀幹」（胸口中心）「下巴」、（可選）每撮頭髮的髮根 → 髮尾
const WIZ_EXTRA = [['eyeclosed', '閉眼差分'], ['eyelid', '眼皮（遮擋用）']];
const wizBase = r => r && TYPES[r] ? Model.baseType(r) : r;
// 軀幹：支點在腰（胸口偏下），整個上半身微微彈跳旋轉，不做鏈的擺動（參考手動調整的範例 0917）
const WIZ_TORSO = { angle: -2, amp: 0, inertia: 0, gravity: 0.005, curve: { shape: 'bounce', freq: 1, phase: 0.25 } };
// 層次間的自然延遲（用「延遲」）：鬆的東西（尾巴、腿、飾品）+2；成對的第二個錯開；硬連接（頭、手臂）0
const WIZ_DELAY = { tail: 2, leg: 2, accessory: 2, ribbon: 2, hem: 0, figure: 2 };
const WIZ_HEADKIDS = new Set(['feature', 'eye', 'nose', 'mouth', 'brow', 'fronthair', 'hair', 'backhair', 'ear', 'eyeclosed', 'eyelid']);
// 深度：參考「白髮女孩（分層）」範例調好的數值（頭 0.15）
const WIZ_DEPTH = { head: 0.15, feature: 0.3, eye: 0.32, nose: 0.34, mouth: 0.32, brow: 0.33, eyeclosed: 0.32, eyelid: 0.32, fronthair: 0.45, hair: 0.4, backhair: 0, ear: 0.1, torso: 0, arm: 0.4, leg: -0.3, tail: -0.4, accessory: 0.2 };
const WIZ_RIG = { feature: 'face_base', head: 'face_base', fronthair: 'hair_front', hair: 'hair_side', backhair: 'hair_back', ear: 'ear', accessory: 'accessory' };
// 動作參數：取自手動調過的範例（觸手範本、白髮女孩）
const WIZ_PARAMS = {
  torso: { amp: 0.03, swayFreq: 1, gravity: 0.005, round: 0.2, taper: 1, lag: 2 },
  head: { angle: 4, gravity: 0.005 },
  fronthair: { amp: 0.08, swayFreq: 1, lag: 1, inertia: 0.7, gravity: 0.035, taper: 1, round: 0.3 },
  hair: { amp: 0.1, swayFreq: 1, lag: 2, inertia: 0.4, gravity: 0.02, taper: 0.8, round: 0.2 },
  backhair: { amp: 0.13, swayFreq: 1, lag: 4, inertia: 0.22, gravity: 0.012, taper: 0.6, round: 0.12 },
  tail: { angle: 4, amp: 0.16, swayFreq: 1, lag: 3, inertia: 0.19, taper: 1.15, round: 0.05 },
  // 腿（坐姿等）：短鏈微動
  leg: { angle: 0, amp: 0.03, swayFreq: 1, lag: 2, taper: 1, round: 0.25, inertia: 0.29 },
  accessory: { amp: 0.06, swayFreq: 1, lag: 2, inertia: 0.4, gravity: 0.015, taper: 1, round: 0.3 },
  arm: { angle: 1, amp: 0.05, swayFreq: 1, lag: 1, taper: 0.3, round: 0.15 },
};
let wiz = null;
function openWizard(opt0 = {}) {
  if (!D) { toast('請先開啟圖片或 PSD', 'warn'); return; }
  const images = D.data.nodes.filter(n => n.type === 'image');
  if (images.length >= 2) wizardLayered(images, opt0);
  else if (images.length === 1) wizardSingle(images[0], opt0);
}
// 已經建過（有部位或錨點）→「重新建模」：整個從頭來（部位刪掉、圖層的錨點清掉、圖層都掛回整體；圖層的類型留著當預設）
const hasRigging = () => !!D && D.data.nodes.some(n => (isPart(n) && n.type !== 'group') || (n.type === 'image' && n.pins.length));
function startQuickBuild() {
  if (!D) return;
  if (hasRigging()) {
    D.data.nodes = D.data.nodes.filter(n => n.type === 'root' || n.type === 'image' || n.type === 'group');
    for (const n of D.data.nodes) {
      if (n.type !== 'image') continue;
      n.pins = []; n.parent = 'root'; n.enabled = true; delete n.simpleBase; delete n.follow; delete n.fromHost;
      if (n.role && TYPES[n.role]) n.params = typeDefaults(n.role);
    }
    for (const n of D.data.nodes) if (n.type === 'group' && !D.data.nodes.some(c => c.parent === n.id)) n.parent = 'root';
    commit(); renderAll();
  }
  openWizard(D.ui.simple ? { toSimple: true } : {});
}
const wizOptions = opt => [
  'profile' in opt ? field('畫風', seg([['chibi', 'Q 版'], ['normal', '正常比例']], () => opt.profile, v => { opt.profile = v; opt.preset = WIZ_PROFILES[v].preset; const s2 = document.querySelector('#modal select.wpreset'); if (s2) s2.value = opt.preset; }), 'Q 版：頭大、動作彈；正常比例：動作小、比較穩') : null,
  el('div', { class: 'khead' }, '要建立的東西'),
  el('div', { class: 'wopts' },
    ...[['rig', '頭部定位與轉頭（立體：自動找五官，轉頭時五官跟著臉走）'], ['hair', '頭髮擺動'], ['arm', '尾巴 / 觸手 / 飾品 / 手臂擺動'], ['depth', '立體深度（轉頭時前後視差）']]
      .filter(([k]) => k in opt).map(([k, t]) => { const i = el('input', { type: 'checkbox', checked: !!opt[k] }); i.addEventListener('change', () => { opt[k] = i.checked; }); return el('label', { class: 'chk' }, i, t); })),
  field('動作組', (() => { const s = el('select', { class: 'wpreset' }, ...Object.entries(Model.PRESETS).map(([k, p]) => el('option', { value: k, selected: opt.preset === k }, p.label))); s.addEventListener('change', () => { opt.preset = s.value; }); return s; })()),
  'bpm' in opt ? slider('BPM', () => opt.bpm, v => { opt.bpm = v; }, { min: 10, max: 240, step: 1, noLive: true, noCommit: true, tip: '每分鐘幾個完整循環；60 = 一秒一個循環' }) : null,
  'eyeCover' in opt ? field('眨眼遮擋', (() => {
    const s = el('select', {}, ...[['none', '不用（底下沒有畫眼睛）'], ['auto', '自動補膚色'], ['color', '用底色（自動取色）']].map(([v, t]) => el('option', { value: v, selected: opt.eyeCover === v }, t)));
    s.addEventListener('change', () => { opt.eyeCover = s.value; });
    return s;
  })(), '眼睛閉起來後空出來的地方要不要蓋住；有指定「眼皮（遮擋用）」圖層時用那個圖層。閉眼差分、眼皮在「眨眼素材」分類') : null,
];
// 精靈開著時：其他工作區變暗（畫面保留，看得到標出的圖層 / 點的位置）
function wizDim(on) { document.body.classList.toggle('wizdim', on); }
// 讓面板可以拖曳（按住標題）
function makeDraggable(box, handle) {
  handle.style.cursor = 'move';
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button, input, select')) return;
    e.preventDefault();
    const r = box.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    box.style.position = 'fixed'; box.style.margin = '0'; box.style.right = 'auto'; box.style.bottom = 'auto';
    const move = ev => { box.style.left = Math.max(0, Math.min(innerWidth - 60, ev.clientX - x0)) + 'px'; box.style.top = Math.max(0, Math.min(innerHeight - 30, ev.clientY - y0)) + 'px'; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
}

// ---- 分層 ----
// 圖層的類型選單：和「物件屬性」同一套（分類），另外加閉眼差分、眼皮、背景
function wizRoleSelect(cur, onChange) {
  // 和部位的類型選單一樣：深色彈出選單，點分類再展開
  const labelOf = v => !v ? '不動' : v === 'background' ? '背景（隱藏）' : (WIZ_EXTRA.find(e => e[0] === v) || [])[1] || (TYPES[v] ? TYPES[v].label + (v === 'eye' ? '（會眨眼）' : '') : v);
  const btn = el('button', { class: 'btn wrole' }, labelOf(cur) + ' ▾');
  const pick = v => { cur = v; btn.textContent = labelOf(v) + ' ▾'; onChange(v); };
  const open = () => {
    const r = btn.getBoundingClientRect(), x = r.left, y = r.bottom + 2, mark = v => (cur === v ? '✓ ' : '');
    const items = [{ label: mark('') + '不動', run: () => pick('') }, '-'];
    for (const [label, list, direct] of Model.TYPE_MENU) {
      if (direct) { items.push({ label: mark(direct) + label, icon: TYPES[direct].icon, run: () => pick(direct) }); continue; }
      const sub = list.map(t => [t, TYPES[t].label + (t === 'eye' ? '（會眨眼）' : ''), TYPES[t].icon]);
      const curIn = sub.find(([v]) => v === cur);
      items.push({ label: `${label} ›${curIn ? `（${curIn[1]}）` : ''}`, run: () => setTimeout(() => showMenu(x, y, [
        { label: '‹ ' + label, run: () => setTimeout(open, 0) }, '-',
        ...sub.map(([v, t, ic]) => ({ label: mark(v) + t, icon: ic, run: () => pick(v) }))]), 0) });
    }
    // 眨眼素材：閉眼差分、眼皮（遮擋用）— 會自動配給最近的眼睛
    const ex = WIZ_EXTRA.find(([v]) => v === cur);
    items.push('-', { label: `眨眼素材 ›${ex ? `（${ex[1]}）` : ''}`, run: () => setTimeout(() => showMenu(x, y, [
      { label: '‹ 眨眼素材', run: () => setTimeout(open, 0) }, '-',
      ...WIZ_EXTRA.map(([v, t]) => ({ label: mark(v) + t, icon: 'eye', run: () => pick(v) }))]), 0) });
    items.push('-', { label: mark('background') + '背景（隱藏）', run: () => pick('background') });
    showMenu(x, y, items);
  };
  btn.addEventListener('click', e => { e.stopPropagation(); open(); });
  return btn;
}
function wizardLayered(images, opt0 = {}) {
  const known = n => n.role && (TYPES[n.role] || n.role === 'background') ? n.role : '';   // 之前設過物件屬性的沿用
  const pick = new Map(images.map(n => [n.id, known(n)]));
  const opt = { rig: false, hair: true, arm: true, depth: false, profile: 'chibi', preset: WIZ_PROFILES.chibi.preset, bpm: Model.bpmOf(D.data), eyeCover: 'none', ...opt0 };   // 立體（轉頭、深度）預設不套用
  const list = el('div', { class: 'wlist' });
  for (const n of images.slice().sort((a, b) => b.order - a.order)) {
    const a = D.assets.get(n.image.assetId), th = el('canvas', { width: 40, height: 40, class: 'wthumb' });
    if (a) { const k = Math.min(40 / a.w, 40 / a.h), g = th.getContext('2d'); g.drawImage(a.canvas, (40 - a.w * k) / 2, (40 - a.h * k) / 2, a.w * k, a.h * k); }
    const row = el('div', { class: 'wrow' + (pick.get(n.id) ? ' set' : ''), title: '滑過去會在畫面上標出這個圖層' }, th, el('span', { class: 'wname' }, n.name),
      wizRoleSelect(pick.get(n.id), v => { pick.set(n.id, v); row.classList.toggle('set', !!v); }));
    row.addEventListener('mouseenter', () => { D.ui.sel = n.id; });
    list.append(row);
  }
  const body = el('div', { class: 'dbody keys' },
    el('div', { class: 'khead' }, '每個圖層是什麼？（滑過去會在畫面上標出來）'), list, ...wizOptions(opt));
  const cancel = el('button', { class: 'btn wcancel', onclick: () => { close(); if (opt.quick && D) { closeTab(D); showHome(); } } }, '取消');
  const build = el('button', { class: 'btn primary', onclick: () => {
    if (![...pick.values()].some(Boolean)) { toast('至少指定一個圖層', 'warn'); return; }
    close(); wizardBuildLayered(pick, opt);
  } }, '建立');
  let close;
  if (D.ui.simple) { close = wizDockOpen('快速建模（多圖層）', body, [build]); $('#wizDock .whead').append(cancel); }
  else {
    const close0 = openDialog('快速建模（多圖層）', body, [build], true);
    $('#modal .dialog h2').append(cancel);   // 取消在右上角
    close = () => { close0(); wizDim(false); $('#modal').classList.remove('side'); };
    $('#modal').classList.add('side');   // 對話框靠右，畫面上看得到標出的圖層
    wizDim(true);
    const dlg = $('#modal .dialog');
    makeDraggable(dlg, dlg.querySelector('h2'));
  }
}
// 圖層 alpha 當遮罩（部位範圍 = 整個圖層）
function maskFromLayer(part, img) {
  const a = D.assets.get(img.image.assetId), T = layerAffine(img.image, a);
  paintMask(D, part, g => { g.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]); g.drawImage(a.canvas, 0, 0); }, false, true);
}
// 形狀的分支（觸手、尾巴、飾品）：從 root 附近開始，每個末端一條鏈（沿形狀中間走），回傳 [[x, y], …] 的陣列
function branchChains(S, root, maxN = 6) {
  const b = S.b, M = Math.max(b.x1 - b.x0, b.y1 - b.y0), c = Math.max(2, Math.round(M / 110));
  const gw = Math.ceil((b.x1 - b.x0) / c) + 1, gh = Math.ceil((b.y1 - b.y0) / c) + 1, N = gw * gh;
  const occ = new Uint8Array(N);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (S.at(b.x0 + x * c, b.y0 + y * c) > 60) occ[y * gw + x] = 1;
  // 離邊緣的距離（格）
  const edt = new Float32Array(N).fill(1e9), q0 = [];
  for (let i = 0; i < N; i++) if (!occ[i]) { edt[i] = 0; q0.push(i); }
  for (let h = 0; h < q0.length; h++) { const i = q0[h], x = i % gw, y = (i / gw) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue; const j = Y * gw + X; if (edt[j] > edt[i] + 1) { edt[j] = edt[i] + 1; q0.push(j); } } }
  // 分開的每一塊各自處理（被身體擋住的觸手常常是好幾塊）；太小的碎片（線條、雜點）不算
  const comp = new Int32Array(N).fill(-1), sizes = [];
  for (let i = 0; i < N; i++) {
    if (!occ[i] || comp[i] >= 0) continue;
    const id = sizes.length, st = [i]; comp[i] = id; let k = 0;
    while (st.length) { const j = st.pop(); k++; const x = j % gw, y = (j / gw) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue; const q = Y * gw + X; if (occ[q] && comp[q] < 0) { comp[q] = id; st.push(q); } } }
    sizes.push(k);
  }
  const total = sizes.reduce((a, v) => a + v, 0), out = [];
  const big = sizes.map((v, id) => [v, id]).filter(([v]) => v >= Math.max(12, total * 0.04)).sort((p, q) => q[0] - p[0]);
  for (const [, id] of big) {
    if (out.length >= maxN) break;
    for (let i = 0; i < N; i++) if (comp[i] !== id) occ[i] = occ[i] ? 2 : 0;   // 暫時當成別塊
    const one = branchOne(id);
    for (let i = 0; i < N; i++) if (occ[i] === 2) occ[i] = 1;
    out.push(...one.slice(0, maxN - out.length));
  }
  return out;
  function branchOne(id) {
  const isOcc = i => occ[i] === 1 && comp[i] === id;
  // 起點：這一塊最靠近 root 的格子
  let s0 = -1, bd = Infinity;
  for (let i = 0; i < N; i++) if (isOcc(i)) { const d = (b.x0 + (i % gw) * c - root[0]) ** 2 + (b.y0 + ((i / gw) | 0) * c - root[1]) ** 2; if (d < bd) { bd = d; s0 = i; } }
  if (s0 < 0) return [];
  // Dijkstra：走形狀中間（離邊越遠越便宜）；geo = 實際步數長度
  const cost = new Float64Array(N).fill(Infinity), geo = new Float64Array(N), par = new Int32Array(N).fill(-1);   // 64 位元：和堆積裡的值比較時不會因為捨入而跳過
  cost[s0] = 0;
  const heap = [[0, s0]];
  const push = it => { heap.push(it); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  while (heap.length) {
    const [d, i] = pop();
    if (d > cost[i]) continue;
    const x = i % gw, y = (i / gw) | 0;
    for (const [dx, dy, L] of [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]]) {
      const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
      const j = Y * gw + X; if (!isOcc(j)) continue;
      const nd = d + L * (1 + 4 / (1 + edt[j]));
      if (nd < cost[j]) { cost[j] = nd; geo[j] = geo[i] + L; par[j] = i; push([nd, j]); }
    }
  }
  let gmax = 0;
  for (let i = 0; i < N; i++) if (isOcc(i) && cost[i] < Infinity && geo[i] > gmax) gmax = geo[i];
  if (gmax < 4) return [];
  // 末端：由遠到近挑，已經被前面路徑蓋到的不再算（同一條分支只要一個末端）
  const order = [...Array(N).keys()].filter(i => isOcc(i) && cost[i] < Infinity && geo[i] > gmax * 0.3).sort((p, q) => geo[q] - geo[p]);
  const covered = new Uint8Array(N), onPath = new Uint8Array(N), R = Math.max(3, Math.round(gmax * 0.35)), out = [];
  for (const tip of order) {
    if (out.length >= maxN) break;
    if (covered[tip]) continue;
    const path = [];
    for (let i = tip; i >= 0; i = par[i]) path.push(i);
    path.reverse();   // root → tip
    // 鏈的起點：離開前面路徑（主幹）的地方
    let st = 0;
    for (let k = 0; k < path.length; k++) if (onPath[path[k]]) st = k;
    const seg = path.slice(st);
    const len = geo[tip] - geo[path[st]];
    for (const i of path) { onPath[i] = 1; }
    // 末端附近的格子都算蓋到（只標分支的後 70%）
    for (let k = Math.floor(seg.length * 0.3); k < seg.length; k++) {
      const i = seg[k], x = i % gw, y = (i / gw) | 0;
      for (let yy = Math.max(0, y - R); yy <= Math.min(gh - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(gw - 1, x + R); xx++) covered[yy * gw + xx] = 1;
    }
    if (len < gmax * 0.25 || seg.length < 4) continue;
    const cnt = Math.max(3, Math.min(5, Math.round(len * c / (M * 0.18)) + 2));
    const pts = [];
    for (let k = 0; k < cnt; k++) { const i = seg[Math.round(k / (cnt - 1) * (seg.length - 1))]; pts.push([Math.round(b.x0 + (i % gw) * c), Math.round(b.y0 + ((i / gw) | 0) * c)]); }
    out.push(pts);
  }
  return out;
  }
}
// 下巴：頭圖層下緣的輪廓，從重心往兩邊走到「跳一大段」（側髮、髮束）為止，中間最低的點 = 下巴
function neckOf(headImg) {
  const H = layerSampler(headImg), hb = H.b, st = Math.max(2, Math.round((hb.x1 - hb.x0) / 150));
  let sx = 0, sy = 0, n = 0, top = Infinity;
  for (let y = hb.y0; y <= hb.y1; y += st) for (let x = hb.x0; x <= hb.x1; x += st) if (H.at(x, y) > 120) { sx += x; sy += y; n++; if (y < top) top = y; }
  if (!n) return [Math.round((hb.x0 + hb.x1) / 2), Math.round(hb.y1)];
  const cx = sx / n, cy = sy / n, hh = Math.max(1, (cy - top) * 2);
  const bottomAt = x => { for (let y = hb.y1; y > hb.y0; y -= 2) if (H.at(x, y) > 120) return y; return null; };
  const step = Math.max(2, Math.round(hh / 60)), jump = hh * 0.05;
  let best = [cx, bottomAt(cx) ?? cy];
  for (const dir of [1, -1]) {
    let prev = bottomAt(cx);
    for (let x = cx + dir * step; Math.abs(x - cx) < hh * 0.6; x += dir * step) {
      const b = bottomAt(x);
      if (b == null || prev == null || Math.abs(b - prev) > jump) break;
      if (b > best[1]) best = [x, b];
      prev = b;
    }
  }
  return [Math.round(best[0]), Math.round(best[1] - hh * 0.02), hh];
}
// 脊椎：從脖子往下，每一段取「靠近上一點」那一帶的中心（不會被手臂拉歪）
function spinePins(S, top, botY, count) {
  const b = S.b, w = b.x1 - b.x0, band = Math.max(2, Math.round((b.y1 - b.y0) * 0.03)), reach = w * 0.12;
  const pts = [top];
  let px = top[0];
  for (let k = 1; k < count; k++) {
    const y = Math.round(top[1] + (botY - top[1]) * k / (count - 1));
    let sx = 0, n = 0;
    for (let yy = y - band; yy <= y + band; yy += 2) for (let x = Math.round(px - reach); x <= px + reach; x += 2) if (S.at(x, yy) > 60) { sx += x; n++; }
    if (!n) break;
    px = sx / n;
    pts.push([Math.round(px), y]);
  }
  return pts;
}
function wizardBuildLayered(pick, opt) {
  const data = D.data, P3 = P3D.settings(data), R = n => pick.get(n.id) || '', B = n => wizBase(R(n)), PF = WIZ_PROFILES[opt.profile || 'chibi'];
  const AMP = P => ({ ...P, amp: (P.amp || 0) * PF.amp });
  if (opt.bpm) data.timeline.bpm = opt.bpm;
  const imgs = data.nodes.filter(n => n.type === 'image');
  for (const n of imgs) {
    const r = R(n);
    if (r === 'background') { n.visible = false; n.role = null; }
    else n.role = r && TYPES[r] ? r : null;
    if (r && TYPES[r]) n.params = typeDefaults(r);
  }
  let made = 0;
  const M = Math.max(data.width, data.height);
  const ofB = b => imgs.filter(n => B(n) === b);
  // 同一張圖有好幾個人物：每個身體圖層各建一組，頭依脖子壓在哪個身體上配對，其他東西配給最近的頭 / 身體
  const torsos = ofB('torso');
  let heads = ofB('head');
  // 範圍一律用圖層自己的（掛上子層後 nodeBounds 會把子層算進去，配對會錯）
  const OB = new Map(imgs.map(n => [n, ownBounds(n)])), obOf = n => OB.get(n) || ownBounds(n);
  const rectDist = (b, x, y) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
  const ctrOf = n => { const b = obOf(n); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]; };
  const nearestOf = (list, n) => { const [x, y] = ctrOf(n); let best = null, bd = Infinity; for (const m of list) { const b = obOf(m), d = rectDist(b, x, y) * 4 + Math.hypot((b.x0 + b.x1) / 2 - x, (b.y0 + b.y1) / 2 - y); if (d < bd) { bd = d; best = m; } } return best; };
  // 沒有「頭」圖層的人物：用最靠近那個身體的臉圖層當頭（五官要在頭底下，所以它自己改成頭）
  const faces = ofB('feature');
  if (torsos.length) {
    for (const t of torsos) {
      if (heads.some(h => nearestOf(torsos, h) === t)) continue;
      const f = faces.filter(f => !heads.includes(f) && nearestOf(torsos, f) === t).sort((a, b) => { const A = obOf(a), Bb = obOf(b); return (Bb.x1 - Bb.x0) * (Bb.y1 - Bb.y0) - (A.x1 - A.x0) * (A.y1 - A.y0); })[0];
      if (f) { f.role = 'head'; heads.push(f); }
    }
  } else if (!heads.length && faces[0]) { faces[0].role = 'head'; heads = [faces[0]]; }
  const necks = new Map(heads.map(h => [h, neckOf(h)]));
  // 頭 → 身體：脖子點落在哪個身體的不透明處；都沒有就取最近的
  const torsoOfHead = new Map();
  for (const h of heads) {
    const nk = necks.get(h);
    let best = null, bd = Infinity;
    for (const t of torsos) { const d = layerSampler(t).at(nk[0], nk[1] + nk[2] * 0.06) > 60 ? -1 : rectDist(obOf(t), nk[0], nk[1]); if (d < bd) { bd = d; best = t; } }
    if (best) torsoOfHead.set(h, best);
  }
  // 1. 軀幹：支點在腰（胸口偏下），往上到脖子；第二個以後的人物錯開延遲
  const torsoNodes = new Map();   // 身體圖層 → 掛東西用的節點（軀幹部位，沒建成就是圖層本身）
  torsos.forEach((torsoImg, fi) => {
    const tb = obOf(torsoImg), S = layerSampler(torsoImg);
    const h = heads.find(x => torsoOfHead.get(x) === torsoImg), neck = h && necks.get(h);
    const nk = neck && [neck[0], Math.round(neck[1] + neck[2] * 0.06)];
    const top = nk && nk[1] >= tb.y0 && nk[1] < tb.y1 && S.at(nk[0], nk[1]) > 60 ? nk : [Math.round((tb.x0 + tb.x1) / 2), Math.round(tb.y0 + (tb.y1 - tb.y0) * 0.08)];
    const waist = Math.round(top[1] + (tb.y0 + (tb.y1 - tb.y0) * 0.62 - top[1]) * 0.55);
    const pins = spinePins(S, top, waist, 3).reverse();   // 支點（腰）在第一個
    let node = torsoImg;
    if (pins.length >= 2) {
      node = addPart(D, 'torso', torsos.length > 1 ? `軀幹 ${fi + 1}` : '軀幹', torsoImg.id, pins, { delay: fi ? WIZ_DELAY.figure * fi : 0, params: { ...typeDefaults('torso'), ...WIZ_PARAMS.torso, ...WIZ_TORSO, curve: { ...WIZ_TORSO.curve } } });
      maskFromLayer(node, torsoImg);
      made++;
    }
    torsoNodes.set(torsoImg, node);
  });
  const torsoNodeFor = n => { const t = nearestOf(torsos, n); return t ? torsoNodes.get(t) : null; };
  // 2. 頭：頭圖層掛在自己的身體底下；頭部位（支點在下巴）掛在頭圖層底下，其他頭部的圖層再掛在最近的頭部位底下
  const headParts = new Map();
  heads.forEach((headImg, hi) => {
    const tn = torsoOfHead.get(headImg) ? torsoNodes.get(torsoOfHead.get(headImg)) : null;
    if (tn && !Model.descendants(data, headImg.id).has(tn.id)) headImg.parent = tn.id;
    let hp = data.nodes.find(n => n.type === 'head' && n.parent === headImg.id);
    if (!hp) {
      hp = addPart(D, 'head', heads.length > 1 ? `頭 ${hi + 1}` : '頭', headImg.id, [necks.get(headImg).slice(0, 2)], { delay: 4, params: { ...typeDefaults('head'), ...WIZ_PARAMS.head, ...PF.head } });
      maskFromLayer(hp, headImg);
      made++;
    }
    headParts.set(headImg, hp);
  });
  for (const n of imgs) {
    if (heads.includes(n) || !WIZ_HEADKIDS.has(B(n))) continue;
    const h = nearestOf(heads, n), hp = h && headParts.get(h);
    if (hp && !Model.descendants(data, n.id).has(hp.id)) n.parent = hp.id;
  }
  // 手臂、飾品、布料：掛在最近的軀幹底下；腿掛在最近的身體圖層（不跟著上半身轉，腳才不會滑）；尾巴掛在整體
  for (const n of imgs) {
    const b = B(n), r = R(n);
    // 固定物件（裝飾、背景小物）：只有一個人物時才跟著軀幹；好幾個人物時留在整體（不會被其中一個人帶著轉）
    if ((['arm', 'accessory', 'accflip', 'custom'].includes(b) && r !== 'fixed' || (r === 'fixed' && torsos.length === 1)) && n.parent === 'root' && !torsos.includes(n)) {
      const tn = torsoNodeFor(n);
      if (tn && !Model.descendants(data, n.id).has(tn.id)) n.parent = tn.id;
    }
    if (b === 'leg' && n.parent === 'root') {
      const t = nearestOf(torsos, n);
      if (t && !Model.descendants(data, n.id).has(t.id)) n.parent = t.id;
    }
    void r;
  }
  const headPart = headParts.get(heads[0]) || null, headImg = heads[0] || null;
  // 3. 眨眼：眼睛圖層 + 閉眼差分 / 眼皮
  const eyes = imgs.filter(n => R(n) === 'eye');
  if (eyes.length) {
    // 左右眼分開時：每隻眼睛配最近的閉眼差分 / 眼皮
    const ctr = n => { const b = nodeBounds(n); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]; };
    const nearest = (n, role) => { const c = ctr(n); let best = null, bd = Infinity; for (const m of imgs) if (R(m) === role) { const q = ctr(m), d = Math.hypot(q[0] - c[0], q[1] - c[1]); if (d < bd) { bd = d; best = m; } } return best; };
    for (const n of eyes) {
      const closed = nearest(n, 'eyeclosed'), lid = nearest(n, 'eyelid');
      const cover = lid ? { lidId: lid.id } : opt.eyeCover === 'auto' ? { lidAuto: true } : opt.eyeCover === 'color' ? { lidColor: skinAround(n) } : {};
      enableBlink(n, { closedId: closed ? closed.id : null, ...cover });
      made++;
    }
  }
  // 4. 擺動鏈
  // 身體的重心（手臂、尾巴從最靠近它的一端開始長）；好幾個人物時用最近的身體
  const centerOf = torsoImg => {
    if (!torsoImg) return [data.width / 2, data.height / 2];
    const tb = obOf(torsoImg), S = layerSampler(torsoImg), st = Math.max(2, Math.round((tb.x1 - tb.x0) / 120));
    let sx = 0, sy = 0, k = 0;
    for (let y = tb.y0; y <= tb.y1; y += st) for (let x = tb.x0; x <= tb.x1; x += st) if (S.at(x, y) > 120) { sx += x; sy += y; k++; }
    return k ? [sx / k, sy / k] : [(tb.x0 + tb.x1) / 2, (tb.y0 + tb.y1) / 2];
  };
  const centers = new Map(torsos.map(t => [t, centerOf(t)]));
  const centerFor = n => { const t = nearestOf(torsos, n); return t ? centers.get(t) : centerOf(null); };
  for (const n of imgs) {
    const b = B(n);
    if (data.nodes.some(c => c.parent === n.id && c.type !== 'image')) continue;   // 已經有部位的不動
    const S = layerSampler(n);
    if (['fronthair', 'hair', 'backhair'].includes(b) && opt.hair) {
      const chains = hairChains(S);
      chains.forEach((pins, i) => {
        const p = addPart(D, b === 'backhair' ? 'backhair' : b === 'fronthair' ? 'fronthair' : 'hair', n.name + (chains.length > 1 ? (i ? '・右' : '・左') : ''), n.id, pins,
          { delay: b === 'backhair' ? (i ? 1 : 2) : 0, params: AMP({ ...typeDefaults(b), ...WIZ_PARAMS[b] }) });
        p.region.radius = Math.round(M * 0.035);
        made++;
      });
    } else if ((['tail', 'accessory', 'accflip', 'arm', 'leg'].includes(b) || ['hem', 'ribbon'].includes(R(n))) && opt.arm) {
      // 從最靠近身體的地方開始；腿 / 手臂一條、衣襬左右各一條
      const ref = centerFor(n), t = ['hem', 'ribbon'].includes(R(n)) ? R(n) : b === 'accflip' ? 'accessory' : b;
      const chains = t === 'arm' || t === 'leg' ? branchChains(S, ref, 1) : t === 'hem' ? branchChains(S, ref, 2) : branchChains(S, ref, 6);
      chains.forEach((pins, i) => {
        // 延遲：鬆的東西（尾巴、腿、飾品、緞帶）+2；成對的第二個再錯開（衣襬 1）
        const dl = (WIZ_DELAY[t] || 0) + (i % 2 ? (t === 'hem' ? 1 : 2) : 0);
        const p = addPart(D, t, `${n.name}・${i + 1}`, n.id, t === 'leg' ? pins.slice(0, 3) : pins,
          { mirror: i % 2 === 1, delay: t === 'arm' ? 0 : dl, params: AMP({ ...typeDefaults(t), ...(WIZ_PARAMS[t] || {}) }) });
        p.region.radius = Math.round(M * 0.05);
        made++;
      });
    }
  }
  // 5. 立體深度 / 頭部定位
  if (opt.depth) {
    for (const hp of headParts.values()) if ((P3D.nodeOf(hp).depth ?? null) === null) P3D.nodeOf(hp).depth = WIZ_DEPTH.head;
    for (const n of imgs) { const P = P3D.nodeOf(n), b = B(n) || R(n); if (b && (P.depth === null || P.depth === undefined)) P.depth = WIZ_DEPTH[b] ?? 0; }
  }
  if (opt.rig && headParts.size) {
    ensureDerived(D);
    for (const [hImg, hp] of headParts) {
      const roles = {};
      for (const n of imgs) if (n.parent === hp.id || n === hImg) roles[n.id] = WIZ_RIG[B(n)] || 'accessory';
      createRig(hp, { roles });
      made++;
    }
  }
  void headPart; void headImg;
  wizardFinish(opt, made);
}
function wizardFinish(opt, made) {
  Model.applyPreset(D.data, opt.preset);
  // 畫風（Q 版 / 正常比例）的頭部參數蓋在動作組之後
  if (opt.profile) for (const n of D.data.nodes) if (n.type === 'head') Object.assign(n.params, WIZ_PROFILES[opt.profile].head);
  if (opt.rig || opt.depth) P3D.settings(D.data).enabled = true;
  updateRootPivot(D);
  commit(); renderAll();
  setMode('preview'); D.ui.playing = true; updatePlaybar();
  if (opt.toSimple) { simpleInit(opt.profile); setSimple(true); }
  toast(`建立完成（${made} 項）：可以直接播放；不滿意按 Ctrl+Z 整個復原`, 'info');
}

// ---- 單張圖 ----
// 步驟：軀幹、下巴（必要）；頭髮、肚臍、獸耳、尾巴（選配）。頭髮 / 獸耳 / 尾巴：點根部再點末端，或按住從根部拖到末端
const WIZ_SEGS = { hair: { key: 'hair', label: '頭髮', color: '110,231,183' }, ear: { key: 'ears', label: '獸耳', color: '244,114,182' }, tail: { key: 'tails', label: '尾巴', color: '167,139,250' } };
function wizardSingle(img, opt0 = {}) {
  wiz = { img, step: 'torso', torso: null, neck: null, navel: null, hair: [], ears: [], tails: [], pend: null, hist: [], opt: { hair: true, other: true, preset: 'bounce', profile: 'chibi', ...opt0 } };
  wiz.opt.preset = WIZ_PROFILES[wiz.opt.profile].preset;
  setMode('edit'); setTool('select'); D.ui.playing = false;
  wizDim(true);
  renderWizard();
}
const WIZ_STEP = {
  torso: '點「軀幹」：點在胸口中心；之後以「下巴」切開頭部、「肚臍」切開下半身',
  neck: '點「下巴 / 脖子」：頭和身體從這條線分開',
  navel: '點「肚臍」：這條線以下用下半身的動法',
  hair: '頭髮：點髮根再點髮尾（或按住從髮根拖到髮尾）',
  ear: '獸耳：點耳根再點耳尖（或按住拖）',
  tail: '尾巴：點尾根再點尾巴尖（或按住拖）',
};
// 復原一步：最後點的點 / 最後完成的步驟
function wizUndo() {
  if (!wiz) return;
  if (wiz.pend) { wiz.pend = null; renderWizard(); return; }
  const h = wiz.hist.pop();
  if (!h) return;
  if (WIZ_SEGS[h]) wiz[WIZ_SEGS[h].key].pop();
  else { wiz[h] = null; wiz.step = h; }
  renderWizard();
}
function closeWizard() { wiz = null; wizDim(false); renderWizard(); }
// 已經放的點：可以拖曳（螢幕 10px 內）
function wizHit(mx, my) {
  if (!wiz) return null;
  const V = viewAffine(), near = p => { const q = aApply(V, p[0], p[1]); return Math.hypot(q[0] - mx, q[1] - my) < 10; };
  for (const { key } of Object.values(WIZ_SEGS)) for (const seg of wiz[key]) for (let k = 0; k < 2; k++) if (near(seg[k])) return { set: v => { seg[k] = v; } };
  for (const k of ['neck', 'navel', 'torso']) if (wiz[k] && near(wiz[k])) return { set: v => { wiz[k] = v; } };
  return null;
}
// 頭髮：髮根往上、髮尾往下各延長一點（範圍蓋住整撮），三個節點
const hairExt = ([r, t]) => { const dx = t[0] - r[0], dy = t[1] - r[1]; return [[r[0] - dx * 0.12, r[1] - dy * 0.12], [t[0] + dx * 0.15, t[1] + dy * 0.15]]; };
// 頭髮鏈的範圍（核心半徑、羽化）：預覽與建立用同一組
const wizHairR = () => { const M = Math.max(D.data.width, D.data.height); return { core: Math.round(M * 0.04), feather: Math.round(M * 0.07) }; };
// 步驟順序：必填（軀幹、下巴）設定完自動跳下一步；其他的有「跳過 / 完成」
const WIZ_ORDER = ['torso', 'neck', 'hair', 'navel', 'ear', 'tail'], WIZ_REQ = new Set(['torso', 'neck']);
const wizHas = k => WIZ_SEGS[k] ? wiz[WIZ_SEGS[k].key].length > 0 : !!wiz[k];
// 清掉某一步放的東西（點 / 線），步驟切回那一步
function wizClearStep(k) {
  if (WIZ_SEGS[k]) wiz[WIZ_SEGS[k].key] = [];
  else wiz[k] = null;
  wiz.hist = wiz.hist.filter(h => h !== k);
  wiz.pend = null;
  wiz.step = k;
  renderWizard();
}
function wizNext() {
  const i = WIZ_ORDER.indexOf(wiz.step);
  wiz.step = i < 0 ? null : WIZ_ORDER[i + 1] || null;
  wiz.pend = null;
  renderWizard();
}
// 取消：從「新增 → 快速建立」來的，直接回主頁（不保留這個作品）
function cancelWizard() {
  const quick = wiz && wiz.opt.quick;
  closeWizard();
  if (quick && D) { const doc = D; closeTab(doc); showHome(); }
}
// 簡易模式：精靈放在右側邊欄（電腦）/ 下方欄位（手機），不擋畫面；完整模式：浮在畫面上、可以拖曳
function wizHost() {
  const docked = !!(D && D.ui.simple);
  document.body.classList.toggle('wizon', docked && !!wiz);
  return docked ? $('#wizDock') : $('#stage');
}
function renderWizard() {
  let box = $('#wizard');
  if (!wiz) { if (box) box.remove(); document.body.classList.remove('wizon'); return; }
  const host = wizHost(), docked = host.id === 'wizDock';
  if (!box || box.parentElement !== host) { if (box) box.remove(); box = el('div', { id: 'wizard', class: 'wizard' }); host.append(box); }
  box.classList.toggle('docked', docked);
  box.innerHTML = '';
  const reqDone = wiz.torso && wiz.neck;
  const steps = [['torso', '軀幹'], ['neck', '下巴'], ['hair', '頭髮'], ['navel', '肚臍'], ['ear', '獸耳'], ['tail', '尾巴']].map(([k, t]) => {
    const n = WIZ_SEGS[k] ? wiz[WIZ_SEGS[k].key].length : 0;
    const note = WIZ_REQ.has(k) ? '必填' : n ? `${n} ${k === 'hair' ? '撮' : k === 'tail' ? '條' : '個'}` : k === 'navel' && wiz.navel ? '以下為下半身' : '';
    return el('div', { class: 'wstep' + (wizHas(k) ? ' done' : '') + (wiz.step === k ? ' cur' : ''), onclick: () => { wiz.step = k; wiz.pend = null; renderWizard(); } },
      el('i', { class: 'wdot' }), el('b', {}, t), note ? el('span', { class: 'note' + (WIZ_REQ.has(k) ? ' req' : '') }, note) : null,
      wizHas(k) ? el('button', { class: 'tb icon wtrash', title: '清掉這一步', onclick: e => { e.stopPropagation(); wizClearStep(k); } }, ico('trash')) : null);
  });
  const head = el('div', { class: 'whead' }, '快速建模（單圖層）', el('span', { class: 'grow' }),
    el('button', { class: 'tb', title: '復原一步（Delete / Backspace / Ctrl+Z）', disabled: wiz.pend || wiz.hist.length ? null : 'disabled', onclick: wizUndo }, '↶'),
    docked ? null : el('button', { class: 'tb wmin', title: wiz.min ? '展開' : '收起（只留目前步驟）', onclick: () => { wiz.min = !wiz.min; renderWizard(); } }, wiz.min ? '▢' : '─'),
    el('button', { class: 'btn wcancel', onclick: cancelWizard }, '取消'));
  const O = wiz.opt, chk = (k, t) => { const i = el('input', { type: 'checkbox', checked: !!O[k] }); i.addEventListener('change', () => { O[k] = i.checked; }); return el('label', { class: 'chk' }, i, t); };
  // 右下：選配步驟 = 跳過 / 完成；必填都完成後 = 建立
  const opt = wiz.step && !WIZ_REQ.has(wiz.step);
  const right = el('div', { class: 'wright' },
    opt ? el('button', { class: 'btn', onclick: wizNext }, wizHas(wiz.step) ? '完成' : '跳過') : null,
    reqDone ? el('button', { class: 'btn primary', onclick: wizardBuildSingle }, '建立') : null);
  box.classList.toggle('min', !!wiz.min && !docked);
  box.append(head,
    el('div', { class: 'wnow' }, wiz.step ? (wiz.pend ? '再點末端（Delete / Ctrl+Z 取消）' : WIZ_STEP[wiz.step]) : reqDone ? '都設定好了：按「建立」；已放的點可以拖曳調整' : '選一個步驟'),
    el('div', { class: 'wtabs', title: 'Q 版：頭大、動作彈；正常比例：動作小、比較穩' }, ...[['chibi', 'Q 版'], ['normal', '正常比例']].map(([v, t]) => el('button', { class: O.profile === v ? 'on' : '', onclick: () => { O.profile = v; O.preset = WIZ_PROFILES[v].preset; renderWizard(); } }, t))),
    el('div', { class: 'wstepper' }, ...steps),
    el('div', { class: 'wopts' }, chk('hair', '頭髮擺動'), chk('other', '其他東西擺動（獸耳、尾巴、下半身）')),
    field('動作組', (() => { const s = el('select', {}, ...Object.entries(Model.PRESETS).map(([k, p]) => el('option', { value: k, selected: O.preset === k }, p.label))); s.addEventListener('change', () => { O.preset = s.value; }); return s; })()),
    el('div', { class: 'wfoot' }, right));
  if (!docked) makeDraggable(box, head);
}
// 分層精靈：簡易模式時放進側邊欄；完整模式是對話框
function wizDockOpen(title, body, foot) {
  const dock = $('#wizDock');
  dock.innerHTML = '';
  dock.append(el('div', { class: 'wizard docked' }, el('div', { class: 'whead' }, el('span', { class: 'grow' }, title)), body, el('div', { class: 'wfoot' }, ...foot)));
  document.body.classList.add('wizon');
  return () => { dock.innerHTML = ''; document.body.classList.remove('wizon'); };
}
function wizardClick(x, y) {
  const p = [Math.round(x), Math.round(y)];
  // 依序自動進入下一步：軀幹 → 下巴 → 頭髮
  if (wiz.step === 'torso') { wiz.torso = p; wiz.hist.push('torso'); wiz.step = wiz.neck ? 'hair' : 'neck'; }
  else if (wiz.step === 'neck') { wiz.neck = p; wiz.hist.push('neck'); wiz.step = 'hair'; }
  else if (wiz.step === 'navel') { if (!wiz.navel) wiz.hist.push('navel'); wiz.navel = p; }   // 選配：設好後按「完成」到下一步
  else if (WIZ_SEGS[wiz.step]) { if (wiz.pend) { wiz[WIZ_SEGS[wiz.step].key].push([wiz.pend, p]); wiz.hist.push(wiz.step); wiz.pend = null; } else wiz.pend = p; }
  renderWizard();
}
function drawWizard(g, V) {
  if (!wiz) return;
  const S = (x, y) => aApply(V, x, y), dot = (p, c) => { const q = S(...p); g.beginPath(); g.arc(q[0], q[1], 5, 0, TAU); g.fillStyle = c; g.fill(); g.strokeStyle = '#111'; g.lineWidth = 1; g.stroke(); };
  const label = (p, t) => { const q = S(...p); g.font = '600 11px system-ui'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(t, q[0] + 10, q[1] - 8); g.fillStyle = '#fff'; g.fillText(t, q[0] + 10, q[1] - 8); };
  const hline = (p, c, t) => {
    const a = S(0, p[1]), b = S(D.data.width, p[1]);
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.setLineDash([6, 4]); g.strokeStyle = c; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]);
    dot(p, c); label(p, t);
  };
  if (wiz.neck) hline(wiz.neck, '#facc15', '上 = 頭 · 下 = 身體');
  if (wiz.navel) hline(wiz.navel, '#fb923c', '下 = 下半身');
  // 頭髮 / 獸耳 / 尾巴：粗的羽化帶 = 會跟著動的範圍
  const HR = wizHairR(), sc = Math.hypot(V[0], V[1]);
  const band = (a, b, col, alpha) => {
    g.save(); g.lineCap = 'round';
    g.strokeStyle = `rgba(${col},${0.12 * alpha})`; g.lineWidth = (HR.core + HR.feather) * 2 * sc; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    g.strokeStyle = `rgba(${col},${0.22 * alpha})`; g.lineWidth = HR.core * 2 * sc; g.stroke();
    g.strokeStyle = `rgb(${col})`; g.lineWidth = 2; g.setLineDash(alpha < 1 ? [6, 4] : []); g.stroke();
    g.restore();
  };
  for (const { key, color } of Object.values(WIZ_SEGS)) for (const sg of wiz[key]) { const [r, t] = sg, [er, et] = key === 'hair' ? hairExt(sg) : sg; band(S(...er), S(...et), color, 1); dot(r, `rgb(${color})`); dot(t, '#fff'); }
  if (wiz.pend && wiz.mouse && WIZ_SEGS[wiz.step]) band(S(...wiz.pend), S(...wiz.mouse), WIZ_SEGS[wiz.step].color, 0.7);
  if (wiz.torso) { dot(wiz.torso, '#f472b6'); label(wiz.torso, '軀幹'); }
  if (wiz.pend) dot(wiz.pend, WIZ_SEGS[wiz.step] ? `rgb(${WIZ_SEGS[wiz.step].color})` : '#fff');
}
function wizardBuildSingle() {
  const { img, neck, navel, opt } = wiz, data = D.data, W = data.width, H = data.height, PF = WIZ_PROFILES[opt.profile];
  const a = D.assets.get(img.image.assetId), T = layerAffine(img.image, a);
  // 範圍 = 圖片本身的 alpha，在下巴線（與肚臍線）上下切開
  const drawBand = (g, y0, y1) => { g.save(); g.beginPath(); g.rect(0, y0, W, y1 - y0); g.clip(); g.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]); g.drawImage(a.canvas, 0, 0); g.restore(); };
  let made = 0;
  const useNavel = navel && navel[1] > neck[1];
  const torso = addPart(D, 'torso', '上半身', img.id, [wiz.torso], { params: { ...typeDefaults('torso'), ...WIZ_TORSO, curve: { ...WIZ_TORSO.curve } } });
  paintMask(D, torso, g => drawBand(g, neck[1], useNavel ? navel[1] : H), false, true); made++;
  const head = addPart(D, 'head', '頭', torso.id, [neck], { delay: 4, params: { ...typeDefaults('head'), ...WIZ_PARAMS.head, ...PF.head } });
  paintMask(D, head, g => drawBand(g, 0, neck[1]), false, true); made++;
  // 下半身：掛在圖層底下（不跟著上半身擺），支點在肚臍，輕微反向擺動
  let hip = null;
  if (useNavel) {
    hip = addPart(D, 'hip', '下半身', img.id, [navel], { params: { ...typeDefaults('hip'), ...(opt.other ? { angle: PF.hipAngle, curve: { shape: 'sine', freq: 1, phase: 0.5 } } : {}) } });
    paintMask(D, hip, g => drawBand(g, navel[1], H), false, true); made++;
  }
  const line = ([r, t], k = 4) => [...Array(k)].map((_, i) => [r[0] + (t[0] - r[0]) * i / (k - 1), r[1] + (t[1] - r[1]) * i / (k - 1)]);
  const HR = wizHairR(), amp = P => ({ ...P, amp: (P.amp || 0) * PF.amp });
  if (opt.hair) wiz.hair.forEach((s, i) => { const p = addPart(D, 'hair', `頭髮 ${i + 1}`, head.id, line(hairExt(s), 3), { delay: i % 2 ? 2 : 0, params: amp({ ...typeDefaults('hair'), ...WIZ_PARAMS.hair }) }); p.region.radius = HR.core; p.region.feather = HR.feather; made++; });
  if (opt.other) {
    // 獸耳：兩隻同方向擺、第二隻延遲 2；尾巴延遲 2（成對再錯開 2）
    wiz.ears.forEach((s, i) => { const p = addPart(D, 'ear', `獸耳 ${i + 1}`, head.id, line(s, 3), { delay: i % 2 ? 2 : 0, params: amp({ ...typeDefaults('ear') }) }); p.region.radius = HR.core; p.region.feather = HR.feather; made++; });
    wiz.tails.forEach((s, i) => { const p = addPart(D, 'tail', `尾巴 ${i + 1}`, hip ? hip.id : torso.id, line(s, 6), { mirror: i % 2 === 1, delay: WIZ_DELAY.tail + (i % 2 ? 2 : 0), params: amp({ ...typeDefaults('tail'), ...WIZ_PARAMS.tail }) }); p.region.radius = HR.core; p.region.feather = HR.feather; made++; });
  }
  wiz = null; renderWizard(); wizDim(false);
  wizardFinish({ ...opt, rig: false, depth: false }, made);
}

// ---------- 自動綁定（範例用：依圖層名稱）----------
// 多圖層：依圖層名稱判斷類型 → 頭部圖層收進「頭」群組（臉部精細 + 點頭）、頭髮 / 手臂自動加鏈、給深度起點
// 單張圖：已指定類型與範圍、但還沒有錨點的部位 → 依範圍形狀自動放支點與運動點；頭開啟臉部精細
const ROLE_WORDS = [
  ['background', ['紙張', '背景', 'background', 'paper', 'bg']],
  ['fronthair', ['前髮', '前髪', '瀏海', '浏海', 'bang', 'fringe', 'front hair']],
  ['backhair', ['後髮', '後髪', '后发', 'back hair', 'backhair']],
  ['ear', ['耳', 'ear']],
  ['eye', ['眼', 'eye']],
  ['feature', ['五官', '嘴', '口', '鼻', 'mouth', 'nose', 'face', '臉', '脸']],
  ['hair', ['髮', '髪', '发', 'hair', '呆毛']],
  ['arm', ['手', '臂', 'arm', 'hand']],
  ['leg', ['腿', '腳', '脚', 'leg', 'foot']],
  ['tail', ['尾', 'tail']],
  ['accessory', ['飾', '帽', '蝴蝶結', '緞帶', 'ribbon', 'hat', 'accessory']],
  ['head', ['頭', '头', 'head']],
  ['torso', ['身', '軀', '躯', 'body', 'torso', '衣']],
];
const HEAD_ROLES = new Set(['fronthair', 'backhair', 'ear', 'eye', 'feature', 'hair', 'head']);
// 臉部精細底下的凹凸（相對頭的深度差）
const FACE_REL = { feature: 0, eye: -0.1, fronthair: 0.15, hair: 0.08, backhair: -0.3, ear: -0.15, accessory: 0.15, head: 0 };
function roleOf(name) {
  const s = (name || '').toLowerCase();
  for (const [role, words] of ROLE_WORDS) if (words.some(w => s.includes(w))) return role;
  return null;
}
// 圖層在文件座標的取樣器與範圍
function layerSampler(n) {
  const a = D.assets.get(n.image.assetId), T = layerAffine(n.image, a), Ti = aInv(T);
  const at = (x, y) => { const [lx, ly] = aApply(Ti, x, y).map(Math.round); return lx < 0 || ly < 0 || lx >= a.w || ly >= a.h ? 0 : a.alpha[ly * a.w + lx]; };
  return { at, b: nodeBounds(n) };
}
function maskSampler(n) {
  const W = D.data.width, H = D.data.height;
  const obj = n.region.mode === 'mask' && n.region.maskId && D.masks.get(n.region.maskId);
  if (!obj) return null;
  const at = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= W || yi >= H ? 0 : obj.data[yi * W + xi] > 128 && alphaAtDoc(xi, yi) ? 255 : 0; };
  return { at, b: nodeBounds(n) };
}
// 形狀主軸（PCA）→ 兩端點
function shapeAxis(S) {
  const { b } = S, step = Math.max(2, Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) / 90));
  let n = 0, mx = 0, my = 0; const pts = [];
  for (let y = b.y0; y <= b.y1; y += step) for (let x = b.x0; x <= b.x1; x += step) if (S.at(x, y) > 40) { pts.push(x, y); mx += x; my += y; n++; }
  if (!n) return null;
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < pts.length; i += 2) { const dx = pts[i] - mx, dy = pts[i + 1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(ang), uy = Math.sin(ang);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { const t = (pts[i] - mx) * ux + (pts[i + 1] - my) * uy; if (t < lo) lo = t; if (t > hi) hi = t; }
  return { mx, my, ux, uy, a: [mx + ux * lo, my + uy * lo], z: [mx + ux * hi, my + uy * hi] };
}
// 把點沿法線方向移到形狀的中間（落在不透明處）
function snapMid(S, x, y, nx, ny, reach) {
  let best = null;
  for (let d = 0; d <= reach; d += 2) for (const sg of d ? [1, -1] : [1]) {
    const px = x + nx * d * sg, py = y + ny * d * sg;
    if (S.at(px, py) > 40) { best = [px, py]; d = reach + 1; break; }
  }
  if (!best) return null;
  let l = 0, r = 0;
  while (l < reach && S.at(best[0] - nx * (l + 2), best[1] - ny * (l + 2)) > 40) l += 2;
  while (r < reach && S.at(best[0] + nx * (r + 2), best[1] + ny * (r + 2)) > 40) r += 2;
  return [Math.round(best[0] + nx * (r - l) / 2), Math.round(best[1] + ny * (r - l) / 2)];
}
// 從 root 端沿主軸放 count 個點（第一個 = 支點）
function chainAlong(S, from, to, count) {
  const dx = to[0] - from[0], dy = to[1] - from[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
  const out = [];
  for (let i = 0; i < count; i++) {
    const f = 0.06 + 0.88 * i / (count - 1);
    const p = snapMid(S, from[0] + dx * f, from[1] + dy * f, nx, ny, L * 0.5);
    if (p) out.push(p);
  }
  return out;
}
// 髮帽狀（寬大於高）的頭髮圖層：左右各一條從中段垂下的鏈
function hairChains(S) {
  const { b } = S, w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (w < h * 0.8) {
    const ax = shapeAxis(S); if (!ax) return [];
    const top = ax.a[1] < ax.z[1] ? ax.a : ax.z, bot = top === ax.a ? ax.z : ax.a;
    return [chainAlong(S, top, bot, 4)];
  }
  const out = [];
  for (const f of [0.14, 0.86]) {
    const x = b.x0 + w * f, pts = [];
    for (const g of [0.45, 0.65, 0.82, 0.97]) {
      const p = snapMid(S, x, b.y0 + h * g, 1, 0, w * 0.2);
      if (p) pts.push(p);
    }
    if (pts.length >= 3) out.push(pts);
  }
  return out;
}

function autoBind() {
  if (!D) return;
  const data = D.data, P3 = P3D.settings(data);
  const images = data.nodes.filter(n => n.type === 'image' && n.role !== 'backdrop');
  let made = 0;
  if (images.length >= 2) {
    // ---- 多圖層 ----
    for (const n of images) if (!n.role) n.role = roleOf(n.name) || 'custom';
    for (const n of images) if (n.role === 'background') n.visible = false;
    const headLayers = images.filter(n => HEAD_ROLES.has(n.role) && n.parent === 'root');
    let head = data.nodes.find(n => n.type === 'head' || n.role === 'head' && n.type === 'group');
    if (headLayers.length && !head) {
      const hb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const n of headLayers) { const b = nodeBounds(n); hb.x0 = Math.min(hb.x0, b.x0); hb.y0 = Math.min(hb.y0, b.y0); hb.x1 = Math.max(hb.x1, b.x1); hb.y1 = Math.max(hb.y1, b.y1); }
      const faceL = headLayers.find(n => n.role === 'feature') || headLayers[0], fb = nodeBounds(faceL);
      const chin = { x: Math.round((fb.x0 + fb.x1) / 2), y: Math.round(fb.y1 - (fb.y1 - fb.y0) * 0.04) };
      // 頭 = 頭部件（和單張圖同一種），底下的圖層都跟著它動；範圍設為「無」，只當父層帶動子圖層
      head = Model.makeNode(data, 'head', 'root', { name: '頭', role: 'head' });
      head.pins = [{ id: Model.uid('pin_'), x: chin.x, y: chin.y, kind: 'fixed' }];
      head.params = { ...head.params, angle: 3 };
      head.region = { ...head.region, mode: 'none', hinge: 0 };
      data.nodes.splice(data.nodes.indexOf(headLayers[0]), 0, head);
      for (const n of headLayers) n.parent = head.id;
      const F = P3D.faceFromBounds(hb, chin);
      F.Fw = Math.round(Math.max(10, Math.min(F.R * 0.72, (fb.x1 - fb.x0) / 2)));
      F.top = { x: chin.x, y: Math.round(fb.y0 + (fb.y1 - fb.y0) * 0.1) };
      P3D.nodeOf(head).face = F;
      made++;
    }
    // 深度起點
    if (head && (P3D.nodeOf(head).depth ?? null) === null) P3D.nodeOf(head).depth = P3D.BODY.head;
    for (const n of images) {
      const P = P3D.nodeOf(n);
      if (P.depth !== null && P.depth !== undefined) continue;
      if (n.parent === head?.id) P.depth = +(P3D.BODY.head + (FACE_REL[n.role] ?? 0)).toFixed(2);
      else P.depth = P3D.BODY[n.role] ?? (n.role === 'accessory' ? 0.4 : 0);
    }
    // 頭髮、手臂、尾巴自動加鏈
    for (const n of images) {
      if (!['hair', 'fronthair', 'backhair', 'arm', 'tail'].includes(n.role)) continue;
      if (data.nodes.some(c => c.parent === n.id)) continue;
      const S = layerSampler(n);
      if (n.role === 'arm' || n.role === 'tail') {
        const ax = shapeAxis(S); if (!ax) continue;
        // 靠近身體中心的一端當支點
        const body = images.find(x => x.role === 'torso'), bb = body ? nodeBounds(body) : { x0: 0, x1: data.width, y0: 0, y1: data.height };
        const bc = [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2];
        const [root, tip] = Math.hypot(ax.a[0] - bc[0], ax.a[1] - bc[1]) < Math.hypot(ax.z[0] - bc[0], ax.z[1] - bc[1]) ? [ax.a, ax.z] : [ax.z, ax.a];
        const pins = chainAlong(S, root, tip, 4);
        if (pins.length >= 2) { const p = addPart(D, n.role, n.role === 'arm' ? n.name + '（擺動）' : n.name, n.id, pins, { params: n.role === 'arm' ? { angle: 3 } : {} }); p.region.radius = Math.round(Math.max(data.width, data.height) * 0.05); made++; }
      } else {
        const chains = hairChains(S);
        chains.forEach((pins, i) => {
          const p = addPart(D, 'hair', n.name + (chains.length > 1 ? (i ? '・右' : '・左') : ''), n.id, pins, { mirror: i === 1, delay: i === 1 ? 3 : 0 });
          p.region.radius = Math.round(Math.max(data.width, data.height) * 0.035);
          made++;
        });
      }
    }
  } else {
    // ---- 單張圖：替沒有錨點的部位放錨點 ----
    for (const n of data.nodes) {
      if (!isPart(n) || n.type === 'group' || n.pins.length) continue;
      const S = maskSampler(n);
      if (!S) continue;
      const ax = shapeAxis(S); if (!ax) continue;
      const par = node(n.parent), pb = par && isPart(par) ? nodeBounds(par) : null;
      const pc = par && par.pins[0] ? [par.pins[0].x, par.pins[0].y] : pb ? [(pb.x0 + pb.x1) / 2, (pb.y0 + pb.y1) / 2] : [data.width / 2, data.height];
      let [root, tip] = Math.hypot(ax.a[0] - pc[0], ax.a[1] - pc[1]) < Math.hypot(ax.z[0] - pc[0], ax.z[1] - pc[1]) ? [ax.a, ax.z] : [ax.z, ax.a];
      // 頭髮類：從上往下垂（寬扁的瀏海也是由上而下）
      if (['hair', 'fronthair', 'backhair'].includes(n.type)) {
        const b = S.b;
        if (b.x1 - b.x0 > (b.y1 - b.y0) * 0.8) { const cx = (b.x0 + b.x1) / 2; root = [cx, b.y0]; tip = [cx, b.y1]; }
        else if (root[1] > tip[1]) [root, tip] = [tip, root];
      }
      const chainy = ['hair', 'fronthair', 'backhair', 'arm', 'tail', 'accessory', 'ear', 'leg'].includes(n.type);
      const pts = chainy ? chainAlong(S, root, tip, n.type === 'ear' ? 2 : 4) : [n.type === 'head' || n.type === 'torso' ? [Math.round(root[0]), Math.round(root[1])] : [Math.round(ax.mx), Math.round(ax.my)]];
      const ok = pts.filter(([x, y]) => alphaAtDoc(x, y));
      if (!ok.length) continue;
      n.pins = ok.map(([x, y], i) => ({ id: Model.uid('pin_'), x, y, kind: i ? 'move' : 'fixed' }));
      made++;
    }
    for (const n of data.nodes) {
      if (!isPart(n) || n.type === 'group') continue;
      const P = P3D.nodeOf(n);
      if (P.depth === null || P.depth === undefined) P.depth = P3D.typeDepth(data, n);
      if (n.type === 'head' && !(n.p3d.face && n.p3d.face.on)) { n.p3d.face = P3D.faceFromBounds(nodeBounds(n), n.pins[0]); made++; }
    }
  }
  P3.enabled = true;
  updateRootPivot(D);
  commit(); renderAll();
  toast(made ? `自動綁定完成：新增 / 更新 ${made} 項（可再逐一微調）` : '沒有需要自動綁定的項目（部位要先指定類型與範圍，或使用有命名的多圖層）', made ? 'info' : 'warn');
}

// ---------- 樹狀列表 ----------
// 樹狀圖示：圖片 = 圖片；頭 = 頭；有編輯遮罩 = 紅色圈；只有錨點鏈 = 綠色鏈；群組 = 資料夾
function iconFor(n) {
  const k = n.type === 'image' ? ['image', 'img'] : n.type === 'group' ? ['folder', 'folder'] : n.type === 'root' ? ['root', 'root']
    : n.type === 'head' ? ['head', 'head'] : n.region && n.region.mode === 'mask' ? ['maskring', 'mask'] : ['chain', 'chain'];
  return ico(k[0], 'ticon ic-' + k[1]);
}
// 圖層區上方固定的兩條拉桿：不透明度（圖層）、深度（沒啟用立體時灰掉）
function renderDepthBar() {
  const box = $('#depthBar');
  box.innerHTML = '';
  const n = D && sel();
  if (!D) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden', 'range');
  const LG = lgById(D.ui.selLg);
  if (LG) {
    box.append(slider('不透明', () => LG.opacity ?? 1, v => { LG.opacity = v; }, { min: 0, max: 1, step: 0.01, scale: 100, dec: 0, noLive: true, after: renderOrder, tip: '%；整個群組的不透明度（乘上各圖層自己的不透明度）' }));
    return;
  }
  const drawable = n && Model.isDrawable(n);
  // 圖層的混合模式、剪裁遮色片：圖示按鈕（說明在滑過去的提示）
  if (n && n.type === 'image') {
    const bm = n.blend || 'normal';
    const bb = el('button', { class: 'tb icon' + (bm !== 'normal' ? ' on' : ''), title: `混合模式：${BLEND_MODES[bm]}` }, ico('blend'));
    bb.addEventListener('click', () => { const r = bb.getBoundingClientRect(); showMenu(r.left, r.bottom + 2, Object.entries(BLEND_MODES).map(([k, t]) => ({ label: (bm === k ? '✓ ' : '') + t, run: () => { if (k === 'normal') delete n.blend; else n.blend = k; commit(); renderOrder(); renderDepthBar(); } }))); });
    const cb = el('button', { class: 'tb icon' + (n.clip ? ' on' : ''), title: n.clip ? '剪裁遮色片：開（只顯示在下面那個圖層的範圍內）' : '剪裁遮色片：關' }, ico('clip'));
    cb.addEventListener('click', () => { if (n.clip) delete n.clip; else n.clip = true; commit(); renderOrder(); renderDepthBar(); });
    box.append(el('div', { class: 'lbtns' }, bb, cb));
  }
  const op = slider('不透明', () => drawable ? n.opacity ?? 1 : 1, v => { if (drawable) n.opacity = v; }, { min: 0, max: 1, step: 0.01, scale: 100, dec: 0, noLive: true, tip: drawable ? '%；這個圖層的不透明度（預覽與輸出都會套用）' : '選取圖層才能調' });
  if (!drawable) op.classList.add('dis');
  box.append(op);
  const on = !!D.data.p3d?.enabled && n && n.type !== 'root';
  if (!n || n.type === 'root') {
    const d = slider('深度', () => 0, () => {}, { min: -1, max: 1, step: 0.05, dec: 2, tip: '選取部位或圖層' });
    d.classList.add('dis'); box.append(d); return;
  }
  const P = P3D.nodeOf(n);
  const hasMap = !!(P.mapId && D.masks.get(P.mapId));
  const bar = hasMap ? rangeSlider('深度', () => [P.depthFar ?? P.depth ?? 0, P.depth ?? 0], (a, b) => { P.depthFar = a; P.depth = b; }, { min: -1, max: 1, step: 0.05, tip: '左端 = 無塗處（最深）、右端 = 有塗處（最淺）' })
    : slider('深度', () => P3D.depthOf(n, D.data), v => { P.depth = v; }, { noLive: true, mute: [P, 'depth'], min: -1, max: 1, step: 0.05, dec: 2, tip: on ? '選取部位 / 圖層的深度：-1 最後方 … +1 最前方' : '要先在「立體」分頁啟用立體' });
  if (hasMap) box.classList.add('range');
  if (!on) bar.classList.add('dis');
  box.append(bar);
}

let dragNode = null;
function renderTree() {
  const box = $('#tree');
  box.innerHTML = '';
  if (!D) return;
  const walk = (n, depth) => {
    const kids = Model.children(D.data, n.id);
    const warns = Model.warnings(D.data, n);
    const drawable = Model.isDrawable(n);
    const canMove = n.type === 'root' || isPart(n) && n.type !== 'group' || n.type === 'image' && (n.pins.length > 0 || !!(n.role && TYPES[n.role]));
    const off = n.type === 'root' ? !n.params.enabled : canMove ? !n.enabled : !Model.isShown(D.data, n);
    const name = el('span', { class: 'tname' }, n.name);
    const row = el('div', {
      class: 'trow' + (n.id === D.ui.sel ? ' sel' : '') + (off ? ' off' : ''),
      'data-id': n.id,
      draggable: n.type !== 'root' ? 'true' : null,
      onclick: () => selectNode(n.id),
      oncontextmenu: e => { e.preventDefault(); selectNode(n.id); showMenu(e.clientX, e.clientY, nodeMenu(n)); },
    },
      drawable ? toggleBtn('eye', () => n.visible !== false, v => { n.visible = v; }, ['eye', 'eyeOff'], '顯示 / 隱藏') : el('span', { class: 'teye' }),
      el('span', { style: `width:${depth * 14}px; flex:none` }),
      el('span', { class: 'chev', onclick: e => { e.stopPropagation(); n.collapsed = !n.collapsed; renderTree(); } }, kids.length ? ico(n.collapsed ? 'chevR' : 'chevD') : null),
      iconFor(n), name,
      warns.length ? el('span', { class: 'twarn', title: warns.join('\n') }, ico('warn')) : null,
      n.detach && n.type !== 'image' ? el('span', { class: 'twarn', style: 'color:#9aa4b5', title: '獨立圖層' }, ico('cut')) : null,
      canMove ? toggleBtn('dot', () => n.type === 'root' ? !!n.params.enabled : !!n.enabled, v => { if (n.type === 'root') n.params.enabled = v; else n.enabled = v; }, ['dot', 'dotOff'], '動 / 不動') : el('span', { class: 'teye' }));
    name.addEventListener('dblclick', e => { e.stopPropagation(); renameInTree(n); });
    row.addEventListener('dragstart', e => { dragNode = n; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', n.id); });
    row.addEventListener('dragend', () => { dragNode = null; box.querySelectorAll('.trow').forEach(r => r.classList.remove('drop-in', 'drop-before', 'drop-after')); });
    row.addEventListener('dragover', e => {
      if (!dragNode || Model.descendants(D.data, dragNode.id).has(n.id)) return;
      e.preventDefault();
      const r = row.getBoundingClientRect(), f = (e.clientY - r.top) / r.height;
      const zone = n.type === 'root' ? 'in' : f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'in';
      row.classList.toggle('drop-in', zone === 'in');
      row.classList.toggle('drop-before', zone === 'before');
      row.classList.toggle('drop-after', zone === 'after');
      row.dataset.zone = zone;
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-in', 'drop-before', 'drop-after'));
    row.addEventListener('drop', e => { e.preventDefault(); if (dragNode) moveNode(dragNode, n, row.dataset.zone || 'in'); });
    box.append(row);
    if (!n.collapsed) for (const c of kids) walk(c, depth + 1);
  };
  walk(node('root'), 0);
  renderDepthBar();
}
function renameInTree(n) {
  const row = $(`#tree .trow[data-id="${n.id}"] .tname`);
  if (!row) return;
  const inp = el('input', { type: 'text', value: n.name });
  row.innerHTML = ''; row.append(inp); inp.focus(); inp.select();
  inp.addEventListener('click', ev => ev.stopPropagation());
  inp.addEventListener('blur', () => { if (setNodeName(n, inp.value)) commit(); renderAll(); });
  inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = n.name; inp.blur(); } });
}
function moveNode(n, target, zone) {
  if (n === target || Model.descendants(D.data, n.id).has(target.id)) return;
  { const t = nodeRole(n); if (t && !parentOk(t, zone === 'in' ? target : node(target.parent))) { toast(parentReqText(t), 'warn'); return; } }
  const nodes = D.data.nodes;
  nodes.splice(nodes.indexOf(n), 1);
  if (zone === 'in') { n.parent = target.id; target.collapsed = false; nodes.push(n); }
  else { n.parent = target.parent; const i = nodes.indexOf(target); nodes.splice(zone === 'before' ? i : i + 1, 0, n); }
  commit(); renderAll();
}

// ---------- 眼睛 / 動靜圓點：按住往下（或往上）拖，經過的都切成同一個狀態 ----------
let togglePaint = null;
function toggleBtn(kind, get, set, icons, title) {
  const b = el('button', { class: 'teye' + (kind === 'dot' ? ' tdot' : ''), title: title + '（按住拖曳可一次切換一整排）' });
  const show = () => { b.innerHTML = ''; b.append(ico(get() ? icons[0] : icons[1])); };
  b.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    const v = !get();
    set(v); show();
    togglePaint = { kind, v };
    const up = () => { window.removeEventListener('mouseup', up); togglePaint = null; commit(); renderTree(); renderOrder(); renderRight(); liveChanged(); };
    window.addEventListener('mouseup', up);
  });
  b.addEventListener('mouseenter', () => { if (togglePaint && togglePaint.kind === kind && get() !== togglePaint.v) { set(togglePaint.v); show(); } });
  b.addEventListener('click', e => e.stopPropagation());
  show();
  return b;
}

// ---------- 圖層順序 ----------
// ---------- 圖層（上面 = 前方）----------
// 每列：眼睛、縮圖、「深度 · 類型」、名稱；Ctrl / Shift 點選多個 → 群組；群組底下的圖層縮排
// ---------- 圖層群組（只在圖層區：綁定前後順序，和部位樹的父子關係無關）----------
// data.lgroups = [{ id, name, collapsed, visible, opacity, enabled }]；圖層的 n.lg = 群組 id
// 群組裡的圖層在前後順序上一定相鄰（不會夾著外面的圖層）；整組可以拖曳、摺疊、切換顯示 / 透明度 / 動態
const lgroups = () => D.data.lgroups || (D.data.lgroups = []);
const lgById = id => id && lgroups().find(g => g.id === id);
const lgMembers = g => D.data.nodes.filter(n => Model.isDrawable(n) && n.lg === g.id);
function groupOf(n) { return lgById(n.lg) || null; }
// 目前的圖層順序（上 = 前方），群組成員整理成相鄰
function layerStack() {
  const list = D.data.nodes.filter(Model.isDrawable).sort((a, b) => b.order - a.order), out = [], done = new Set();
  for (const n of list) {
    if (done.has(n)) continue;
    const g = lgById(n.lg);
    if (!g) { if (n.lg) delete n.lg; out.push(n); done.add(n); continue; }
    for (const m of list) if (m.lg === g.id && !done.has(m)) { out.push(m); done.add(m); }
  }
  return out;
}
function applyStack(stack) {
  stack.slice().reverse().forEach((x, k) => { x.order = (k + 1) * 10; });
  D.data.lgroups = lgroups().filter(g => stack.some(n => n.lg === g.id));   // 空的群組拿掉
}
function selectLg(id) {
  D.ui.selLg = id; D.ui.sel = 'root'; D.ui.selPin = null;
  if (D.ui.multi) D.ui.multi.clear();
  renderTree(); renderOrder(); renderRight(); renderStatus();
}
let dragOrder = null;
const layerThumbs = new WeakMap();
function layerThumb(n) {
  const a = n.image && D.assets.get(n.image.assetId), c = el('canvas', { class: 'othumb', width: 34, height: 34 });
  if (!a) return c;
  const k = Math.min(34 / a.w, 34 / a.h), g = c.getContext('2d');
  g.drawImage(a.canvas, (34 - a.w * k) / 2, (34 - a.h * k) / 2, a.w * k, a.h * k);
  return c;
}
// 拖放：圖層拖到圖層上 / 下 = 放在那裡（加入那個圖層的群組）；拖到群組標題上半 = 放在群組上方、下半 = 放進群組最上面
//       群組標題可以整組拖：放在目標（或目標所在群組）的上方 / 下方
function dropOrder(target, zone) {
  const d = dragOrder;
  if (!d) return;
  let stack = layerStack();
  const block = g => stack.filter(n => n.lg === g.id);
  if (d.g) {
    const moving = block(d.g);
    if (target.g === d.g || moving.includes(target.n)) return;
    stack = stack.filter(n => !moving.includes(n));
    const tg = target.g || lgById(target.n.lg), ref = tg ? block(tg).filter(n => !moving.includes(n)) : [target.n];
    const i = zone === 'before' ? stack.indexOf(ref[0]) : stack.indexOf(ref[ref.length - 1]) + 1;
    stack.splice(i, 0, ...moving);
  } else {
    const n = d.n;
    if (target.n === n) return;
    stack = stack.filter(x => x !== n);
    if (target.g) {
      const b = block(target.g).filter(x => x !== n);
      stack.splice(b.length ? stack.indexOf(b[0]) : stack.length, 0, n);
      if (zone === 'before') delete n.lg; else n.lg = target.g.id;
    } else if (target.end) {
      stack.push(n); delete n.lg;
    } else {
      const i = stack.indexOf(target.n);
      stack.splice(zone === 'before' ? i : i + 1, 0, n);
      if (target.n.lg) n.lg = target.n.lg; else delete n.lg;
    }
  }
  applyStack(stack);
  commit(); renderAll();
}
function dropZones(row, target) {
  row.addEventListener('dragover', e => {
    if (!dragOrder) return;
    e.preventDefault();
    const r = row.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2;
    row.classList.toggle('drop-before', before); row.classList.toggle('drop-after', !before);
    row.dataset.zone = before ? 'before' : 'after';
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); row.classList.remove('drop-before', 'drop-after'); dropOrder(target, row.dataset.zone); });
}
function renderOrder() {
  const box = $('#orderList');
  box.innerHTML = '';
  if (!D) return;
  const multi = D.ui.multi || (D.ui.multi = new Set());
  const stack = layerStack();
  const shown = new Set();
  const endDrag = () => { dragOrder = null; box.querySelectorAll('.orow').forEach(r => r.classList.remove('drop-before', 'drop-after')); };
  for (const n of stack) {
    const g = groupOf(n);
    if (g && !shown.has(g.id)) {
      shown.add(g.id);
      const name = el('span', { class: 'tname', title: '雙擊改名' }, g.name);
      name.addEventListener('dblclick', e => {
        e.stopPropagation();
        const inp = el('input', { type: 'text', value: g.name });
        name.innerHTML = ''; name.append(inp); inp.focus(); inp.select();
        inp.addEventListener('click', ev => ev.stopPropagation());
        inp.addEventListener('blur', () => { g.name = inp.value.trim() || g.name; commit(); renderOrder(); });
        inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = g.name; inp.blur(); } });
      });
      const mem = lgMembers(g);
      const head = el('div', { class: 'orow ghead' + (D.ui.selLg === g.id ? ' sel' : '') + (g.visible === false ? ' off' : ''), draggable: 'true', title: '群組：拖曳整組調整前後；選取後用變形工具（T）一起移動，右側可以整組縮放',
        onclick: () => selectLg(g.id),
        oncontextmenu: e => { e.preventDefault(); selectLg(g.id); showMenu(e.clientX, e.clientY, [
          { label: '解散群組', run: () => { for (const m of mem) delete m.lg; D.data.lgroups = lgroups().filter(x => x !== g); D.ui.selLg = null; commit(); renderAll(); } }]); } },
        toggleBtn('eye', () => g.visible !== false, v => { g.visible = v; }, ['eye', 'eyeOff'], '整組顯示 / 隱藏'),
        el('button', { class: 'teye gcol', title: g.collapsed ? '展開' : '摺疊', onmousedown: e => { e.preventDefault(); e.stopPropagation(); g.collapsed = !g.collapsed; renderOrder(); } }, ico(g.collapsed ? 'chevR' : 'chevD')),
        ico('folder', 'ticon ic-folder'), name,
        el('span', { class: 'ometa' }, `${mem.length} 層${(g.opacity ?? 1) < 1 ? ` · ${Math.round((g.opacity ?? 1) * 100)}%` : ''}`),
        toggleBtn('dot', () => g.enabled !== false, v => { g.enabled = v; for (const m of mem) for (const id of Model.descendants(D.data, m.id)) { const x = node(id); if (x) x.enabled = v; } }, ['dot', 'dotOff'], '整組的動態開 / 關'));
      head.addEventListener('dragstart', e => { dragOrder = { g }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', g.id); });
      head.addEventListener('dragend', endDrag);
      dropZones(head, { g });
      box.append(head);
    }
    if (g && g.collapsed) continue;
    const P = P3D.nodeOf(n), depth = P3D.depthOf(n, D.data);
    const kind = n.role && TYPES[n.role] ? TYPES[n.role].label : '一般圖層';
    const op = Math.round((n.opacity ?? 1) * 100);
    const row = el('div', {
      class: 'orow' + (n.id === D.ui.sel && !D.ui.selLg ? ' sel' : '') + (multi.has(n.id) ? ' multi' : '') + (g ? ' gmember' : '') + (n.clip ? ' clipped' : '') + (Model.isShown(D.data, n) ? '' : ' off'), draggable: 'true',
      onclick: e => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) { if (!multi.size && D.ui.sel && D.ui.sel !== n.id && node(D.ui.sel) && Model.isDrawable(node(D.ui.sel))) multi.add(D.ui.sel); multi.has(n.id) ? multi.delete(n.id) : multi.add(n.id); renderOrder(); return; }
        multi.clear(); selectNode(n.id);
      },
      oncontextmenu: e => { e.preventDefault(); selectNode(n.id); showMenu(e.clientX, e.clientY, [{ label: (n.clip ? '✓ ' : '') + '剪裁遮色片', run: () => { if (n.clip) delete n.clip; else n.clip = true; commit(); renderAll(); } }, '-', ...(n.lg ? [{ label: '移出群組', run: () => { const s = layerStack(); delete n.lg; const i = s.indexOf(n); s.splice(i, 1); const gi = s.findIndex(x => x.lg === (g && g.id)); s.splice(gi < 0 ? i : gi, 0, n); applyStack(s); commit(); renderAll(); } }, '-'] : []), ...nodeMenu(n)]); },
    },
      toggleBtn('eye', () => n.visible !== false, v => { n.visible = v; }, ['eye', 'eyeOff'], '顯示 / 隱藏'),
      layerThumb(n),
      el('div', { class: 'otext' },
        el('span', { class: 'ometa' }, `${n.clip ? '↳ 剪裁 · ' : ''}${n.blend && BLEND_MODES[n.blend] ? BLEND_MODES[n.blend] + ' · ' : ''}${op < 100 ? op + '% · ' : ''}深度 ${depth.toFixed(2)} · ${kind}`),
        el('span', { class: 'tname' }, n.name)));
    row.addEventListener('dragstart', e => { dragOrder = { n }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', n.id); });
    row.addEventListener('dragend', endDrag);
    dropZones(row, { n });
    box.append(row);
  }
  // 拖到清單最下面的空白 = 放到最後方（不在群組裡）
  box.ondragover = e => { if (dragOrder && dragOrder.n && e.target === box) e.preventDefault(); };
  box.ondrop = e => { if (e.target === box && dragOrder && dragOrder.n) { e.preventDefault(); dropOrder({ end: true }, 'after'); } };
}
// 群組：多選的圖層（或目前選取的一個）組起來；父層不需要相同，也不改變父子關係，只綁定前後順序
function makeGroup() {
  if (!D) return;
  const picked = [...(D.ui.multi && D.ui.multi.size ? D.ui.multi : [D.ui.sel])].map(id => node(id)).filter(n => n && Model.isDrawable(n));
  if (!picked.length) { toast('先在圖層區選取圖層（Ctrl / Shift 可多選）', 'warn'); return; }
  const g = { id: Model.uid('lg_'), name: '群組' + (lgroups().length + 1), collapsed: false, visible: true, opacity: 1, enabled: true };
  lgroups().push(g);
  const stack = layerStack(), top = stack.find(n => picked.includes(n)), rest = stack.filter(n => !picked.includes(n));
  const at = rest.indexOf(stack[stack.indexOf(top) - 1]) + 1;   // 放在最上面那一層原本的位置
  for (const n of picked) n.lg = g.id;
  rest.splice(at, 0, ...stack.filter(n => picked.includes(n)));
  applyStack(rest);
  D.ui.multi.clear();
  commit(); selectLg(g.id);
  toast(`已組成「${g.name}」：整組拖曳調整前後、選取後用變形工具（T）一起移動`, 'info');
}
// 群組的屬性面板：名稱、整組縮放、解散
function renderLgInspector(box, g) {
  const nm = el('input', { type: 'text', value: g.name });
  nm.addEventListener('change', () => { g.name = nm.value.trim() || g.name; commit(); renderOrder(); });
  const mem = lgMembers(g);
  const pct = el('input', { type: 'number', value: 100, min: 10, max: 400, step: 5, style: 'width:70px' });
  box.append(field('群組', nm), field('圖層', el('span', {}, `${mem.length} 層`)),
    field('整組縮放', el('div', { class: 'btnrow' }, pct, el('span', {}, '%'), el('button', { class: 'btn', onclick: () => {
      const s = (+pct.value || 100) / 100, b = lgBounds(g);
      if (!b || s === 1) return;
      scaleNodes(lgIds(g), (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, s);
      commit(); renderAll();
    } }, '套用')), '以整組的中心縮放：圖層、錨點、遮罩一起'),
    el('div', { class: 'hint' }, '移動：選取群組後用變形工具（T）拖曳。透明度：圖層區上方的「不透明」拉桿。'),
    el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => { for (const m of mem) delete m.lg; D.data.lgroups = lgroups().filter(x => x !== g); D.ui.selLg = null; commit(); renderAll(); } }, '解散群組')));
}
const lgIds = g => { const s = new Set(); for (const m of lgMembers(g)) for (const id of Model.descendants(D.data, m.id)) s.add(id); return [...s]; };
function lgBounds(g) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const n of lgMembers(g)) if (n.type === 'image') { const q = nodeBounds(n); b.x0 = Math.min(b.x0, q.x0); b.y0 = Math.min(b.y0, q.y0); b.x1 = Math.max(b.x1, q.x1); b.y1 = Math.max(b.y1, q.y1); }
  return isFinite(b.x0) ? b : null;
}
// 整組縮放：圖層（位置與大小）、錨點、遮罩、範圍、頭部定位一起以 (cx, cy) 為中心縮放
function scaleNodes(ids, cx, cy, s) {
  const W = D.data.width, H = D.data.height, P = p => { p.x = Math.round(cx + (p.x - cx) * s); p.y = Math.round(cy + (p.y - cy) * s); };
  for (const id of ids) {
    const n = node(id);
    if (!n) continue;
    if (n.image) {
      const a = D.assets.get(n.image.assetId);
      if (a) { const ox = n.image.x + a.w / 2, oy = n.image.y + a.h / 2; n.image.x = cx + (ox - cx) * s - a.w / 2; n.image.y = cy + (oy - cy) * s - a.h / 2; }
      n.image.scale = (n.image.scale ?? 1) * s;
    }
    for (const p of n.pins) P(p);
    if (n.keyPivot) P(n.keyPivot);
    if (n.region) { if (n.region.radius) n.region.radius = Math.max(2, Math.round(n.region.radius * s)); if (n.region.feather) n.region.feather = Math.round(n.region.feather * s); }
    if (n.rig && n.rig.version === 2) {
      if (n.rig.axis) { const q = { x: n.rig.axis.cx, y: n.rig.axis.cy }; P(q); n.rig.axis.cx = q.x; n.rig.axis.cy = q.y; }
      for (const m of n.rig.members) if (m.marker) { const q = { x: m.marker[0], y: m.marker[1] }; P(q); m.marker[0] = q.x; m.marker[1] = q.y; }
    }
    if (n.region && n.region.mode === 'mask' && n.region.maskId) {
      const obj = D.masks.get(n.region.maskId);
      if (obj) {
        const src = maskCanvasOf(obj), c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d'); g.setTransform(s, 0, 0, s, cx - cx * s, cy - cy * s); g.drawImage(src, 0, 0);
        const d = g.getImageData(0, 0, W, H).data, out = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) out[i] = d[i * 4 + 3];
        obj.data = out; obj.v = ++maskVer;
      }
    }
  }
}
function maskCanvasOf(obj) {
  const c = document.createElement('canvas'); c.width = obj.w; c.height = obj.h;
  const img = new ImageData(obj.w, obj.h);
  for (let i = 0; i < obj.w * obj.h; i++) { img.data[i * 4 + 3] = obj.data[i]; }
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
// 一起移動：群組底下的圖層位置、部位的錨點與遮罩、頭部定位都跟著平移
//   mode：'live' = 拖曳中（不動遮罩，比較快）、'masks' = 放開時只平移遮罩
function shiftNodes(ids, dx, dy, mode) {
  const W = D.data.width, H = D.data.height;
  for (const id of ids) {
    const n = node(id);
    if (!n) continue;
    if (mode !== 'masks') {
    if (n.image) { n.image.x += dx; n.image.y += dy; }
    for (const p of n.pins) { p.x += dx; p.y += dy; }
    if (n.keyPivot) { n.keyPivot.x += dx; n.keyPivot.y += dy; }
    if (n.rig && n.rig.version === 2) {
      if (n.rig.axis) { n.rig.axis.cx += dx; n.rig.axis.cy += dy; }
      for (const m of n.rig.members) if (m.marker) { m.marker[0] += dx; m.marker[1] += dy; }
    }
    }
    if (mode === 'masks' && n.region && n.region.mode === 'mask' && n.region.maskId) {
      const obj = D.masks.get(n.region.maskId);
      if (obj && (dx || dy)) {
        const out = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) { const sy = y - dy; if (sy < 0 || sy >= H) continue; for (let x = 0; x < W; x++) { const sx = x - dx; if (sx >= 0 && sx < W) out[y * W + x] = obj.data[sy * W + sx]; } }
        obj.data = out; obj.v = ++maskVer;
      }
    }
  }
}
function groupBounds(g) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const id of Model.descendants(D.data, g.id)) { const n = node(id); if (n && n.type === 'image') { const q = nodeBounds(n); b.x0 = Math.min(b.x0, q.x0); b.y0 = Math.min(b.y0, q.y0); b.x1 = Math.max(b.x1, q.x1); b.y1 = Math.max(b.y1, q.y1); } }
  return isFinite(b.x0) ? b : null;
}

// ---------- 右側：UI 元件 ----------
// o.knee = [位置, 值]：拉桿前段（0 → 位置）對應 min → 值，後段對應 值 → max（小數值區更細）
// o.mute = [參數物件, key]：左側圓點可單獨關閉這個數值的影響
function slider(label, get, set, o) {
  // 部位參數（mute = [n.params, 參數名]）：預覽（動畫）模式下有影格時，顯示 / 修改的是播放頭上的值
  let kInfo = null;
  if (o.mute && D) {
    const [obj, key] = o.mute, owner = typeof obj[key] === 'number' && D.data.nodes.find(q => q.params === obj);
    if (owner) {
      const tr = 'p.' + key, g0 = get, s0 = set;
      const live = () => D.ui.mode === 'preview' && !!owner.keys?.[tr]?.length;
      kInfo = { n: owner, tr, g0 };
      get = () => live() ? g0() + Model.keyVal(D.data, owner, tr, D.ui.frame) : g0();
      set = v => { if (live()) setKey(owner, tr, curU(), v - g0()); else s0(v); };
    }
  }
  const scale = o.scale || 1, bip = o.min < 0 && o.max > 0;
  const knee = o.knee, RES = 1000;
  const snap = v => { const st = o.fine && v < knee[1] ? o.fine : o.step; return Math.round(v / st) * st; };
  const toPos = v => {
    if (!knee) return v;
    const [kp, kv] = knee;
    const f = v <= kv ? kp * (v - o.min) / (kv - o.min) : kp + (1 - kp) * (v - kv) / (o.max - kv);
    return Math.round(Math.max(0, Math.min(1, f)) * RES);
  };
  const fromPos = x => {
    if (!knee) return x;
    const [kp, kv] = knee, f = x / RES;
    return snap(f <= kp ? o.min + (kv - o.min) * f / kp : kv + (o.max - kv) * (f - kp) / (1 - kp));
  };
  const fill = el('i', { class: 'fill' });
  const inp = el('input', knee ? { type: 'range', min: 0, max: RES, step: 1, value: toPos(get()) } : { type: 'range', min: o.min, max: o.max, step: o.step, value: get() });
  const wrap = el('div', { class: 'sl' }, el('i', { class: 'end l' }), el('i', { class: 'end r' }),
    bip ? el('i', { class: 'mid', style: `left:calc(6px + (100% - 12px) * ${(0 - o.min) / (o.max - o.min)})` }) : null, fill, inp);
  const dec = o.dec ?? ((o.fine || o.step) * scale < 1 ? 1 : 0);
  const num = el('input', { type: 'number', class: 'num', step: (o.fine || o.step) * scale, value: (get() * scale).toFixed(dec) });
  const frac = v => knee ? toPos(v) / RES : (v - o.min) / (o.max - o.min);
  const paint = () => {
    const p = frac(get()), c = bip ? frac(0) : 0;
    fill.style.left = `calc(6px + (100% - 12px) * ${Math.min(p, c)})`;
    fill.style.width = `calc((100% - 12px) * ${Math.abs(p - c)})`;
  };
  paint();
  inp.addEventListener('repaint', () => { if (knee) inp.value = toPos(get()); paint(); });
  inp.addEventListener('input', () => { set(fromPos(parseFloat(inp.value))); num.value = (get() * scale).toFixed(dec); paint(); if (!o.noLive) liveChanged(); o.after && o.after(); });
  inp.addEventListener('change', () => { if (!o.noCommit) commit(); if (o.hold || kInfo) releasePlay(); });
  if (o.hold || kInfo) inp.addEventListener('pointerdown', holdPlay);
  num.addEventListener('change', () => {
    const v = Math.max(o.min, Math.min(o.max, (parseFloat(num.value) || 0) / scale));
    set(v); inp.value = toPos(v); num.value = (v * scale).toFixed(dec); paint(); if (!o.noCommit) commit(); if (!o.noLive) liveChanged(); o.after && o.after();
  });
  const row = el('div', { class: 'prow', title: o.tip || '' });
  let dot = el('span');
  if (o.mute) {
    const [obj, key] = o.mute, isOff = () => !!(obj.off && obj.off[key]);
    dot = el('button', { class: 'pdot', title: '單獨開啟 / 關閉這個數值的影響' });
    const upd = () => { row.classList.toggle('muted', isOff()); dot.innerHTML = ''; dot.append(ico(isOff() ? 'dotOff' : 'dot')); };
    dot.addEventListener('mousedown', e => e.preventDefault());
    dot.addEventListener('click', () => { obj.off = obj.off || {}; obj.off[key] = !isOff(); if (!obj.off[key]) delete obj.off[key]; upd(); commit(); liveChanged(); });
    upd();
  }
  row.append(dot, el('label', {}, label), wrap, num);
  if (kInfo) {
    const { n: owner, tr, g0 } = kInfo;
    PARAM_META[tr.slice(2)] = { label, min: o.min, max: o.max, step: o.fine || o.step, dec };
    const kb = el('button', { class: 'kdia', title: '關鍵影格：◇ 沒有動畫（按一下在播放頭打第一格）· ◈ 有動畫 · ◆ 播放頭在影格上（再按刪除）' });
    const upd = () => {
      const ks = owner.keys?.[tr], on = keyAt(ks, curU()) >= 0;
      kb.className = 'kdia' + (ks?.length ? (on ? ' on' : ' track') : '');
      kb.textContent = ks?.length ? (on ? '◆' : '◈') : '◇';
    };
    kb.addEventListener('mousedown', e => e.preventDefault());
    kb.addEventListener('click', () => {
      if (D.ui.mode !== 'preview') setMode('preview');
      const i = keyAt(owner.keys?.[tr], curU());
      if (i >= 0) delKey(owner, tr, i); else setKey(owner, tr, curU(), get() - g0());
      commit(); upd(); renderTimeline();
    });
    row.classList.add('haskey');
    row.dataset.pk = owner.id + '|' + tr;
    row._kupd = () => {
      upd();
      if (!owner.keys?.[tr]?.length) return;
      if (document.activeElement !== inp) inp.value = toPos(get());
      if (document.activeElement !== num) num.value = (get() * scale).toFixed(dec);
      paint();
    };
    upd();
    row.append(kb);
  }
  return row;
}
function field(label, input, tip) { return el('div', { class: 'frow', title: tip || '' }, el('label', {}, label), input); }
function selectField(label, options, get, set, after, tip) {
  const s = el('select', {});
  for (const [v, t, dis, why] of options) s.append(el('option', { value: v, selected: String(get()) === String(v), disabled: dis ? 'disabled' : null, title: dis && why ? why : null }, t));
  s.addEventListener('change', () => { set(s.value); commit(); liveChanged(); after && after(); });
  return field(label, s, tip);
}
function checkbox(label, get, set, after) {
  const i = el('input', { type: 'checkbox', checked: !!get() });
  i.addEventListener('change', () => { set(i.checked); commit(); liveChanged(); after && after(); });
  return el('label', { class: 'chk' }, i, label);
}
function seg(options, get, set) {
  const box = el('div', { class: 'segsmall' });
  for (const [v, t] of options) box.append(el('button', { class: get() === v ? 'on' : '', onclick: () => { set(v); box.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', options[i][0] === get())); } }, t));
  return box;
}
const group = (text, note) => [el('div', { class: 'group', title: note || '' }, text)];
// ---------- 曲線面板（頻率旁的小扳手）----------
// spec 是即時修改的物件（整體的 xCurve / yCurve、部位的 params.curve）；預覽畫兩個循環，中間的線是循環接點
let curvePop = null;
function closeCurveEditor(refresh = true) { if (curvePop) { curvePop.remove(); curvePop = null; if (refresh && D) renderParams(); } }
function curveEditor(btn, spec, title, after) {
  closeCurveEditor(false);
  const pop = el('div', { class: 'cpop' });
  curvePop = pop;
  const cv = el('canvas', { class: 'cprev' });
  const redraw = () => {
    const w = cv.clientWidth || 280, h = cv.clientHeight || 110, dpr = view.dpr;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d'), M = master(), pad = 8, N = 240;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const X = f => pad + (w - pad * 2) * f / (2 * M), Y = v => h / 2 - v * (h / 2 - pad - 4);
    g.strokeStyle = '#3a3a3a'; g.lineWidth = 1; g.beginPath();
    for (const v of [-1, 0, 1]) { g.moveTo(pad, Y(v)); g.lineTo(w - pad, Y(v)); }
    g.stroke();
    g.setLineDash([4, 3]); g.strokeStyle = '#777'; g.beginPath(); g.moveTo(X(M), 2); g.lineTo(X(M), h - 2); g.stroke(); g.setLineDash([]);
    g.beginPath();
    for (let i = 0; i <= N; i++) { const f = 2 * M * i / N, v = Model.curveAt(D.data, spec, f); i ? g.lineTo(X(f), Y(v)) : g.moveTo(X(f), Y(v)); }
    g.strokeStyle = '#e9557c'; g.lineWidth = 2; g.stroke();
    // 循環接點：頭尾值不同 = 斷開
    const jump = Math.abs(Model.curveAt(D.data, spec, M - 1e-3) - Model.curveAt(D.data, spec, 0));
    g.font = '11px system-ui'; g.fillStyle = jump > 0.02 ? '#f87171' : '#9aa4b5';
    g.fillText(jump > 0.02 ? '循環接點會斷開' : '一個循環', X(M) + 4, 12);
  };
  const change = () => { redraw(); after && after(); };
  const body = el('div', { class: 'cbody' });
  const build = () => {
    body.innerHTML = '';
    const S = (label, k, min, max, step, dec, def, tip) => slider(label, () => spec[k] ?? def, v => { spec[k] = v; change(); }, { min, max, step, dec, noLive: true, tip });
    body.append(
      field('形狀', seg(Object.entries(Model.CURVE_SHAPES), () => spec.shape || 'swing', v => { spec.shape = v; build(); change(); commit(); })),
      S('頻率', 'freq', 0.5, 6, 0.5, 1, 1, '每個循環幾次；不是整數時，循環接點會斷開'),
      spec.shape === 'linear' || spec.shape === 'sine' ? null : S('緩動', 'ease', 0, 0.9, 0.01, 2, 0.33, '越大，兩端越慢、中間越快'),
      S('兩端停頓', 'hold', 0, 0.8, 0.01, 2, 0, '到達兩端後停住的比例'),
      S('去回快慢', 'skew', -0.8, 0.8, 0.01, 2, 0, '負 = 去程快、回程慢；正 = 相反'),
      S('衝過頭', 'over', 0, 0.5, 0.01, 2, 0, '到達後多衝一點再回來（彈性感）'),
      S('相位', 'phase', 0, 1, 1 / 32, 3, 0, '整條曲線往後錯開（1/32 循環為單位）'),
      spec.shape === 'bounce' ? S('下壓深度', 'dip', -1, 0, 0.01, 2, -1, '彈跳往下壓到多少（-1 = 最低）') : null,
      el('div', { class: 'frow' }, el('label', {}, ''), checkbox('來回鏡像', () => !!spec.pp, v => { spec.pp = v; change(); })),
    );
  };
  build();
  pop.append(el('div', { class: 'chead' }, el('b', {}, title), el('span', { class: 'grow' }),
    el('button', { class: 'tb icon', title: '關閉', onclick: closeCurveEditor }, ico('close'))), cv, body);
  document.body.append(pop);
  const r = btn.getBoundingClientRect(), pw = 320;
  pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, r.left - pw - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(innerHeight - pop.offsetHeight - 8, r.top - 40)) + 'px';
  redraw();
}
// 頻率拉桿 + 小扳手：getSpec() 取得（必要時建立）曲線設定物件
function freqSlider(label, getSpec, title, tip, onSet) {
  const row = slider(label, () => getSpec().freq ?? 1, v => { getSpec().freq = v; onSet && onSet(v); drawWave(); }, { min: onSet ? 0 : 0.5, max: 6, step: 0.5, dec: 1, noLive: true, tip: tip || '每個循環幾次（0.5 為單位）；不是整數時，輸出會自動多播幾次讓它接回起點' });
  const b = el('button', { class: 'wrench', title: '曲線設定：形狀、緩動、停頓、快慢、衝過頭、相位…' }, ico('wrench'));
  b.addEventListener('mousedown', e => e.preventDefault());
  b.addEventListener('click', () => curveEditor(b, getSpec(), title, () => drawWave()));
  row.classList.add('haswrench');
  row.append(b);
  return row;
}

function renderRight() { renderToolDetail(); renderInspector(); renderParams(); renderTimeline(); renderProbe(); }

// 工具詳細（固定視窗）
const BRUSH_MAX = 120, SOFT_MAX = 60;
function brushSliders(sizeKey, softKey, opKey) {
  return [
    ...(opKey ? [slider('不透明度', () => tool[opKey] ?? 1, v => { tool[opKey] = v; }, { min: 0.05, max: 1, step: 0.05, scale: 100, dec: 0, noLive: true, noCommit: true, tip: '%；一筆最多塗到多少（同一筆來回不會疊加）' })] : []),
    slider('筆刷大小', () => tool[sizeKey], v => { tool[sizeKey] = v; }, { min: 1, max: BRUSH_MAX, step: 1, knee: [0.5, 15], noLive: true, noCommit: true, tip: 'px' }),
    slider('柔化', () => tool[softKey], v => { tool[softKey] = v; }, { min: 0, max: SOFT_MAX, step: 1, fine: 0.25, knee: [0.5, 10], dec: 2, noLive: true, noCommit: true, tip: '邊緣模糊寬度（px），以筆刷邊緣為中心往內外各半' }),
  ];
}
function renderToolDetail() {
  const box = $('#toolDetail');
  box.innerHTML = '';
  renderTools();
  if (!D) return;
  if (D.ui.fit) {
    const f = D.ui.fit;
    box.append(
      el('div', { class: 'note' }, '公版：Q版（軀幹、頭、側髮、後髮、呆毛；手臂之後自行加入）'),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 14px;margin:4px 0' },
        ...Object.keys(Templates.OPT_LABELS).map(k => el('label', { class: 'chk' },
          el('input', { type: 'checkbox', checked: !!f.opts[k], onchange: e => { f.opts[k] = e.target.checked; } }), Templates.OPT_LABELS[k]))),
      el('div', { class: 'btnrow' },
        el('button', { class: 'btn primary', onclick: applyTemplate }, '套用'),
        el('button', { class: 'btn', onclick: () => { D.ui.fit = null; renderToolDetail(); renderStatus(); } }, '取消')));
    return;
  }
  const t = tool.name;
  if (t === 'mask') {
    box.append(field('模式', seg([['add', '＋'], ['erase', '－']], () => tool.maskMode, v => { tool.maskMode = v; }), '＋ 加入範圍、－ 擦除（Alt 反向，X 切換）'),
      ...brushSliders('brush', 'maskSoft', 'maskOpacity'));
  }
  if (t === 'lasso') box.append(field('模式', seg([['add', '加入範圍'], ['sub', '減去範圍']], () => tool.lasso, v => { tool.lasso = v; })));
  if (t === 'paint') {
    const color = el('input', { type: 'color', value: tool.paintColor, oninput: e => { tool.paintColor = e.target.value; } });
    const pick = el('button', { class: 'tb icon' + (tool.picking ? ' on' : ''), title: '滴管：吸取顏色，吸完自動結束（也可以按住 Alt 點畫面）', onclick: startColorPick }, ico('dropper'));
    box.append(field('模式', seg([['draw', '繪製'], ['erase', '擦除']], () => tool.paintMode, v => { tool.paintMode = v; })),
      field('顏色', el('div', { class: 'inline' }, color, pick)),
      ...brushSliders('paintSize', 'paintSoft', 'paintOpacity'));
  }
  if (t === 'depth') {
    const n = sel(), P = n && P3D.nodeOf(n);
    box.append(field('模式', seg([['add', '＋'], ['erase', '－']], () => tool.depthMode, v => { tool.depthMode = v; }), '＋ 塗（變淺）、－ 擦（變深）；兩端深度在左側深度條設定'),
      ...brushSliders('depthSize', 'depthSoft', 'depthOpacity'),
      el('div', { class: 'btnrow' }, el('button', { class: 'btn', disabled: !(P && P.mapId) ? 'disabled' : null, onclick: () => { P.mapId = null; P.depth = P3D.depthOf(n, D.data); commit(); renderAll(); } }, '清除深度圖')));
  }
  if (t === 'wand') {
    const re = () => { if (wandSel) wandCompute(); };
    box.append(
      slider('容許度', () => tool.wandTol, v => { tool.wandTol = v; }, { min: 0, max: 160, step: 1, noLive: true, noCommit: true, after: re, tip: '顏色差多少以內算同一塊（0 = 完全同色）' }),
      slider('柔邊', () => tool.wandSoft, v => { tool.wandSoft = v; }, { min: 0, max: 12, step: 1, noLive: true, noCommit: true, after: re, tip: 'px；選取邊緣的柔和寬度' }),
      slider('擴張 / 收縮', () => tool.wandGrow, v => { tool.wandGrow = v; }, { min: -12, max: 12, step: 1, noLive: true, noCommit: true, after: re, tip: 'px；正 = 往外擴、負 = 往內縮' }),
      el('div', { class: 'frow' }, el('label', {}, ''), checkbox('只選相連的', () => tool.wandContig, v => { tool.wandContig = v; re(); })),
      el('div', { class: 'hint' }, '點圖層選取顏色相近的區塊；Shift + 點 = 加選、Alt + 點 = 減選；Delete = 刪除選取的區塊。'),
      el('div', { class: 'btnrow' },
        el('button', { class: 'btn primary', disabled: wandSel ? null : 'disabled', onclick: wandDelete }, '刪除選取'),
        el('button', { class: 'btn', disabled: wandSel ? null : 'disabled', onclick: () => { wandSel.inv = !wandSel.inv; wandCompute(); } }, '反轉'),
        el('button', { class: 'btn', disabled: wandSel ? null : 'disabled', onclick: () => { wandSel = null; renderToolDetail(); } }, '取消選取')));
  }
  if (t === 'transform') renderTransformDetail(box);
  if (t === 'crop') renderCropDetail(box);
}
function renderTransformDetail(box) {
  const tg = xformTarget();
  if (!tg) return;
  const p = tg.p;
  const num = (get, set, step = 1) => {
    const i = el('input', { type: 'number', step, value: +get().toFixed(2), 'data-x': '1' });
    i.addEventListener('change', () => {
      const before = layerAffine(p, tg.a);
      set(+i.value || 0);
      if (!tg.align && tool.linkRig) moveRigWith(tg.n, before, layerAffine(p, tg.a));
      if (!tg.align) commit();
    });
    i._get = get;
    return i;
  };
  box.append(
    tg.align ? el('div', { class: 'note' }, '拖曳新圖對齊舊圖') : null,
    field('位置', el('div', { class: 'inline' }, num(() => p.x, v => { p.x = v; }), num(() => p.y, v => { p.y = v; }))),
    field('縮放 / 旋轉', el('div', { class: 'inline' }, num(() => (p.scale ?? 1) * 100, v => { p.scale = Math.max(1, v) / 100; }), num(() => p.rot || 0, v => { p.rot = v; }))),
  );
  if (tg.align) {
    box.append(slider('透明度', () => p.opacity, v => { p.opacity = v; }, { min: 0.1, max: 1, step: 0.05, dec: 2, noLive: true, noCommit: true }),
      el('div', { class: 'btnrow' }, el('button', { class: 'btn primary', onclick: () => finishAlign(true) }, '確定取代'), el('button', { class: 'btn', onclick: () => finishAlign(false) }, '取消')));
    return;
  }
  box.append(
    el('div', { style: 'display:flex;gap:14px;margin:4px 0' },
      el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: tool.linkRig, onchange: e => { tool.linkRig = e.target.checked; } }), '錨點與遮罩一起移動'),
),
    el('div', { class: 'btnrow' },
      el('button', { class: 'btn', onclick: () => { const before = layerAffine(p, tg.a); Object.assign(p, { scale: 1, rot: 0 }); if (tool.linkRig) moveRigWith(tg.n, before, layerAffine(p, tg.a)); commit(); renderToolDetail(); } }, '重設縮放旋轉')));
}
function renderToolDetailValues() {
  document.querySelectorAll('#toolDetail input[data-x]').forEach(i => { if (document.activeElement !== i) i.value = +i._get().toFixed(2); });
}

// ---------- 眨眼（眼睛圖層）----------
// 眼睛圖層 + 閉眼差分（選用）+ 遮擋（選用：圖層或底色）→ 自動產生閉合過程；眨眼的時間點在時間軸「眨眼」列
function blinkDefaults(n) {
  return { on: true, closedId: null, lidId: null, lidColor: null, line: 0.62, lash: 0.4, low: 0.7 };
}
function enableBlink(n, opts = {}) {
  n.blink = { ...blinkDefaults(n), ...(n.blink || {}), ...opts, on: true };
  for (const id of [n.blink.closedId, n.blink.lidId]) { const s = id && node(id); if (s) s.visible = false; }   // 素材圖層本身不畫
  if (!(n.keys && n.keys.blink && n.keys.blink.length)) { n.keys = n.keys || {}; n.keys.blink = [[0.7, 1, 'slow', Blink.STYLES.slow.def]]; }
}
// 眼睛周圍（底下的圖層）的顏色：眼睛外圍一圈的中位數
function skinAround(n) {
  const a = D.assets.get(n.image.assetId);
  if (!a) return '#f4d9cf';
  const T = layerAffine(n.image, a), w = a.w, h = a.h, below = D.data.nodes.filter(x => x.type === 'image' && x !== n && x.order < n.order && Model.isShown(D.data, x) && !(n.blink && [n.blink.closedId, n.blink.lidId].includes(x.id))).sort((p, q) => q.order - p.order);
  const px = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (a.alpha[y * w + x] > 10) continue;
    let near = false;
    for (let d = 3; d <= 6 && !near; d += 3) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h && a.alpha[Y * w + X] > 120) { near = true; break; } }
    if (!near) continue;
    const [X, Y] = aApply(T, x, y);
    for (const b of below) {
      const ba = D.assets.get(b.image.assetId); if (!ba) continue;
      const [u, v] = aApply(aInv(layerAffine(b.image, ba)), X, Y), ui = Math.round(u), vi = Math.round(v);
      if (ui < 0 || vi < 0 || ui >= ba.w || vi >= ba.h) continue;
      const i = vi * ba.w + ui;
      if (ba.alpha[i] < 200) continue;
      px.push([ba.rgba[i * 4], ba.rgba[i * 4 + 1], ba.rgba[i * 4 + 2]]);
      break;
    }
  }
  if (!px.length) return '#f4d9cf';
  const med = k => px.map(p => p[k]).sort((p, q) => p - q)[px.length >> 1];
  return '#' + [0, 1, 2].map(k => med(k).toString(16).padStart(2, '0')).join('');
}
// 眨眼：只在「眼睛」圖層（設定眨眼）與「頭」（圈出眼睛）出現
function eyeHostOf(n) {
  if (n.type === 'image') return n;
  // 頭部件：底下物件屬性是臉的圖層（五官畫在上面），否則頭所在的圖片
  const kids = D.data.nodes.filter(c => c.parent === n.id && c.type === 'image');
  return kids.find(c => c.role === 'feature') || kids[0] || Model.imageOf(D.data, n);
}
function renderBlinkUI(box, n) {
  const isEye = n.type === 'image' && n.role === 'eye';
  const isHead = isHeadNode(n) || (n.type === 'image' && n.role === 'feature' && isHeadNode(node(n.parent)));
  if (!isEye && !isHead) return;
  box.append(el('div', { class: 'subgroup' }, '眨眼'));
  if (!isEye) {
    // 頭：從圖上圈出眼睛（眼睛畫在圖上、沒有單獨圖層時）
    if (eyePick && eyePick.headId === n.id) {
      const mode = tool.name === 'mask' ? 'brush' : 'lasso';
      box.append(el('div', { class: 'hint' }, mode === 'lasso' ? '用套索圈出兩隻眼睛（可以圈好幾次）；紫色 = 會變成眼睛的部分。' : '用筆刷微調範圍：塗 = 加入、Alt 或切換成擦除 = 移除。紫色 = 會變成眼睛的部分。'),
        field('工具', seg([['lasso', '套索'], ['brush', '筆刷']], () => mode, v => { setTool(v === 'brush' ? 'mask' : 'lasso'); renderInspector(); })),
        el('div', { class: 'btnrow' },
          el('button', { class: 'btn primary', disabled: eyePick.any ? null : 'disabled', onclick: () => finishEyePick() }, '確定，分成眼睛圖層'),
          el('button', { class: 'btn', onclick: () => { eyePick = null; setTool('select'); renderInspector(); } }, '取消')));
      return;
    }
    const host = eyeHostOf(n);
    box.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn', disabled: host ? null : 'disabled', title: '眼睛畫在圖上（沒有單獨的眼睛圖層）時：圈出來、微調範圍，再分成「眼睛」圖層', onclick: () => startEyePick(n, host) }, '圈出眼睛')));
    return;
  }
  const B = n.blink;
  if (!B || !B.on) {
    box.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn primary', onclick: () => {
      enableBlink(n); commit(); renderAll();
      if (!timelineOn) toggleTimeline(true);
      toast('已設定眨眼：在時間軸的「眨眼」列雙擊加一次眨眼，拖右端調長短', 'info');
    } }, '設定眨眼')));
    return;
  }
  const others = D.data.nodes.filter(x => x.type === 'image' && x !== n).map(x => [x.id, x.name]);
  const pickLayer = (label, key, tip) => selectField(label, [['', '（無）'], ...others], () => B[key] || '', v => {
    const old = B[key] && node(B[key]);
    if (old && old.id !== v) old.visible = true;   // 不再當素材：顯示回來
    B[key] = v || null;
    if (v) { node(v).visible = false; if (key === 'lidId') B.lidColor = null; }
  }, () => renderAll(), tip);
  box.append(
    pickLayer('閉眼差分', 'closedId', '閉上眼睛的圖（例如一條弧線）：閉到最後換成它；沒有的話把上睫毛壓成一條線'),
    selectField('遮擋', [['none', '不用（底下沒有畫眼睛）'], ['auto', '自動補膚色'], ['layer', '用圖層'], ['color', '用底色']], () => B.lidId ? 'layer' : B.lidColor ? 'color' : B.lidAuto ? 'auto' : 'none', v => {
      const o = B.lidId && node(B.lidId);
      if (v !== 'layer') { if (o) o.visible = true; B.lidId = null; }
      B.lidAuto = v === 'auto';
      if (v === 'none' || v === 'auto') B.lidColor = null;
      if (v === 'color') B.lidColor = skinAround(n);
      if (v === 'layer' && !B.lidId) { B.lidColor = null; B.lidId = others[0]?.[0] || null; if (B.lidId) node(B.lidId).visible = false; }
    }, () => renderAll(), '眼睛閉起來後空出來的地方：底下的圖如果也畫著眼睛，要蓋住。自動補膚色 = 從眼睛周圍的皮膚往內補（圈出來的眼睛預設用這個）'));
  if (B.lidId) box.append(pickLayer('眼皮圖層', 'lidId', '膚色的眼皮（只會出現在眼睛原本的範圍）'));
  if (B.lidColor) {
    const ci = el('input', { type: 'color', value: B.lidColor });
    ci.addEventListener('input', () => { B.lidColor = ci.value; D.cache.sSig = ''; });
    ci.addEventListener('change', () => { B.lidColor = ci.value; commit(); });
    box.append(field('底色', el('div', { class: 'btnrow' }, ci,
      el('button', { class: 'btn', title: '重新從眼睛周圍取色', onclick: () => { B.lidColor = skinAround(n); commit(); renderInspector(); } }, '自動取色')), '眼睛周圍的膚色'));
  }
  const S = (label, k, min, max, step, tip) => slider(label, () => B[k], v => { B[k] = v; }, { min, max, step, dec: 2, noLive: true, tip });
  if (!B.closedId) box.append(S('閉合線', 'line', 0.3, 0.9, 0.01, '沒有閉眼圖時：上下眼瞼在眼睛高度的哪裡合起來（0 上 … 1 下）'));
  box.append(
    S('上睫毛厚度', 'lash', 0.1, 0.8, 0.01, '往下移動的上睫毛帶有多厚（佔上半部的比例）；太薄睫毛會被切掉，太厚眼珠會跟著移動'),
    S('下眼瞼', 'low', 0, 1, 0.01, '閉眼時下半部往上收多少'),
    // 傾斜：兩眼連線的角度，閉合方向垂直於它；預設自動偵測
    slider('傾斜', () => B.tilt ?? Math.round(eyeTilt(D, n) / DEG * 10) / 10, v => { B.tilt = v; }, { min: -45, max: 45, step: 0.5, dec: 1, noLive: true, tip: `度；兩眼連線的角度，眼睛沿著垂直於它的方向閉上。${B.tilt == null ? '目前：自動偵測' : '目前：手動（按「自動」改回偵測）'}` }),
    ...(B.tilt != null ? [el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => { B.tilt = null; commit(); renderInspector(); } }, '傾斜改回自動'))] : []));
  // 試閉：拖曳時畫面直接顯示這個閉合程度
  const peek = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0 });
  peek.addEventListener('input', () => { D.ui.blinkPeek = { id: n.id, b: +peek.value }; });
  const unpeek = () => { D.ui.blinkPeek = null; peek.value = 0; };
  peek.addEventListener('change', unpeek); peek.addEventListener('pointerup', unpeek);
  box.append(field('試閉', peek, '拖曳看閉合過程（放開回到張開）'),
    el('div', { class: 'btnrow' },
      el('button', { class: 'tb icon', title: '時間軸：在「眨眼」列雙擊加一次眨眼，拖右端調長短，右鍵換樣式', onclick: () => { if (!timelineOn) toggleTimeline(true); else renderTimeline(); } }, ico('timeline')),
      el('button', { class: 'tb icon', title: '關閉眨眼（刪掉時間軸上的眨眼）', onclick: () => {
        for (const id of [B.closedId, B.lidId]) { const s2 = id && node(id); if (s2) s2.visible = true; }
        n.blink = { ...B, on: false }; if (n.keys) delete n.keys.blink; commit(); renderAll();
      } }, ico('eyeOff'))));
}
// ---------- 圈出眼睛：套索圈 + 筆刷微調 → 確定後才分成眼睛圖層 ----------
// 範圍（文件座標的遮罩）裡跟膚色差很多的（睫毛、眼珠）與偏冷的亮色（眼白）算眼睛；每一欄取最長的一段
// 新圖層放在「頭」底下（五官規則），但變形完全照原圖；遮擋用「自動補膚色」
let eyePick = null;
function startEyePick(head, host) {
  const c = document.createElement('canvas'); c.width = D.data.width; c.height = D.data.height;
  eyePick = { headId: head.id, hostId: host.id, mask: c, any: false, prev: null, last: null };
  setTool('lasso'); renderInspector();
  toast('用套索圈出眼睛（點回起點完成，可以圈好幾次）；需要時切換成筆刷微調，最後按「確定」', 'info');
}
function eyePickPaint(fn, erase) {
  const g = eyePick.mask.getContext('2d');
  g.save(); g.globalCompositeOperation = erase ? 'destination-out' : 'source-over'; g.fillStyle = g.strokeStyle = '#fff';
  fn(g); g.restore();
}
function eyeBrushTo(x, y, erase, first) {
  const r = Math.max(1, tool.brush / 2), p = eyePick.last;
  eyePickPaint(g => { g.lineCap = 'round'; g.lineWidth = r * 2; g.beginPath(); if (first || !p) { g.arc(x, y, r, 0, TAU); g.fill(); } else { g.moveTo(p[0], p[1]); g.lineTo(x, y); g.stroke(); } }, erase);
  eyePick.last = [x, y];
}
// 範圍改了：重新算哪些像素會變成眼睛（紫色預覽）
function eyePickChanged() {
  const host = node(eyePick.hostId), seg = host && segmentEye(host, eyePick.mask);
  eyePick.any = !!seg;
  eyePick.prev = null;
  if (seg) {
    const { w, h, alpha } = seg, c = document.createElement('canvas'); c.width = w; c.height = h;
    const img = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) if (alpha[i]) { img.data[i * 4] = 167; img.data[i * 4 + 1] = 139; img.data[i * 4 + 2] = 250; img.data[i * 4 + 3] = Math.min(200, alpha[i]); }
    c.getContext('2d').putImageData(img, 0, 0);
    eyePick.prev = { canvas: c, T: layerAffine(host.image, D.assets.get(host.image.assetId)) };
  }
  renderInspector();
}
function finishEyePick() {
  const host = eyePick && node(eyePick.hostId), head = eyePick && node(eyePick.headId), mask = eyePick && eyePick.mask;
  eyePick = null; setTool('select');
  if (!host || !mask) { renderInspector(); return; }
  const eye = makeEyeLayer(host, mask, head || host);
  if (!eye) { toast('範圍裡找不到跟膚色不同的眼睛，請再圈一次（範圍要包住整個眼睛）', 'warn'); renderAll(); return; }
  enableBlink(eye, { lidAuto: true });
  D.ui.sel = eye.id;
  commit(); renderAll();
  toast('已分成「眼睛」圖層並設定眨眼：底下原本的眼睛會自動用周圍膚色蓋住；可以用「試閉」檢查', 'info');
}
function segmentEye(host, mask) {
  const a = D.assets.get(host.image.assetId);
  if (!a) return null;
  const w = a.w, h = a.h, Ti = aInv(layerAffine(host.image, a));
  const mc = document.createElement('canvas'); mc.width = w; mc.height = h;
  const g = mc.getContext('2d');
  g.setTransform(Ti[0], Ti[1], Ti[2], Ti[3], Ti[4], Ti[5]);
  g.drawImage(mask, 0, 0);
  const md = g.getImageData(0, 0, w, h).data, N = w * h, inM = new Uint8Array(N);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < N; i++) if (md[i * 4 + 3] > 127 && a.alpha[i] > 30) { inM[i] = 1; const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const R = a.rgba;
  // 膚色：範圍邊緣（3px 內）像素的中位數
  const ring = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x;
    if (!inM[i]) continue;
    let edge = false;
    for (let d = 1; d <= 3 && !edge; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h || !inM[Y * w + X]) { edge = true; break; } }
    if (edge) ring.push(i);
  }
  if (!ring.length) return null;
  const med = k => { const v = ring.map(i => R[i * 4 + k]).sort((p, q) => p - q); return v[v.length >> 1]; };
  const skin = [med(0), med(1), med(2)];
  const dist = i => { const dr = R[i * 4] - skin[0], dg = R[i * 4 + 1] - skin[1], db = R[i * 4 + 2] - skin[2]; return Math.sqrt(0.3 * dr * dr + 0.45 * dg * dg + 0.25 * db * db) * 1.4; };
  // 眼白：亮而且偏冷（皮膚偏暖：紅 − 藍明顯比較大）
  const skinRB = skin[0] - skin[2];
  const eyeish = i => { if (dist(i) >= 42) return true; const r = R[i * 4], gg = R[i * 4 + 1], b = R[i * 4 + 2]; return r + gg + b > 480 && r - b < skinRB - 10; };
  // 每一欄：找最長的一段（容許空隙），段內全部算眼睛
  const alpha = new Uint8Array(N);
  const bh = y1 - y0 + 1, gap = Math.max(3, Math.round(bh * 0.3));
  let cnt = 0;
  for (let x = x0; x <= x1; x++) {
    const runs = [];
    let st = -1, e = -1, last = -999;
    for (let y = y0; y <= y1; y++) {
      const i = y * w + x;
      if (!inM[i] || !eyeish(i)) continue;
      if (y - last > gap) { if (st >= 0) runs.push([st, e]); st = y; }
      e = y; last = y;
    }
    if (st >= 0) runs.push([st, e]);
    if (!runs.length) continue;
    const [rs, re] = runs.reduce((p, q) => (q[1] - q[0] > p[1] - p[0] ? q : p));
    if (re - rs < 2) continue;
    // 段的上下端 2px 用顏色差當柔邊
    for (let y = Math.max(y0, rs - 2); y <= Math.min(y1, re + 2); y++) {
      const i = y * w + x;
      if (!inM[i]) continue;
      const inside = y >= rs && y <= re;
      const soft = Math.max(0, Math.min(1, (dist(i) - 14) / 28));
      alpha[i] = Math.round(a.alpha[i] * (inside ? 1 : soft));
      if (alpha[i]) cnt++;
    }
  }
  if (cnt < 20) return null;
  // 橫向去雜點：太窄的欄群（寬 < 3）拿掉
  const colHas = X => { for (let y = y0; y <= y1; y++) if (alpha[y * w + X]) return true; return false; };
  for (let x = x0; x <= x1; x++) {
    if (!colHas(x)) continue;
    let Rr = x;
    while (Rr < x1 && colHas(Rr + 1)) Rr++;
    if (Rr - x < 3) for (let X = x; X <= Rr; X++) for (let y = y0; y <= y1; y++) alpha[y * w + X] = 0;
    x = Rr;
  }
  return { w, h, alpha, x0, y0, x1, y1, a };
}
function makeEyeLayer(host, mask, head) {
  const seg = segmentEye(host, mask);
  if (!seg) return null;
  const { w, h, alpha, x0, y0, x1, y1, a } = seg, R = a.rgba;
  // 新圖層：只取眼睛那一塊（外加邊界，補膚色時看得到周圍）；原圖有旋轉 / 縮放時用整張大小
  const pad = 10, ident = !(host.image.rot) && (host.image.scale ?? 1) === 1;
  const cx0 = ident ? Math.max(0, x0 - pad) : 0, cy0 = ident ? Math.max(0, y0 - pad) : 0;
  const cw = ident ? Math.min(w, x1 + pad + 1) - cx0 : w, ch = ident ? Math.min(h, y1 + pad + 1) - cy0 : h;
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const img = new ImageData(cw, ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = (y + cy0) * w + x + cx0, o = (y * cw + x) * 4;
    img.data[o] = R[i * 4]; img.data[o + 1] = R[i * 4 + 1]; img.data[o + 2] = R[i * 4 + 2]; img.data[o + 3] = alpha[i];
  }
  c.getContext('2d').putImageData(img, 0, 0);
  const aid = assetFromCanvas(D, host.name + ' 眼睛', c);
  for (const m of D.data.nodes) if (Model.isDrawable(m) && m.order > host.order) m.order += 10;
  const n = Model.makeNode(D.data, 'image', head.id, { name: '眼睛', order: host.order + 5, image: { assetId: aid, x: host.image.x + cx0, y: host.image.y + cy0, scale: host.image.scale ?? 1, rot: host.image.rot || 0, crop: null, variants: [] } });
  n.role = 'eye';
  n.fromHost = host.id;   // 變形完全照原圖
  D.data.nodes.splice(D.data.nodes.indexOf(host) + 1, 0, n);
  return n;
}
function addBlinkAt(n, u) {
  n.keys = n.keys || {};
  const ks = n.keys.blink || (n.keys.blink = []);
  const i = keyAt(ks, u);
  if (i >= 0) ks.splice(i, 1); else ks.push([qU(u), 1, 'slow', Blink.STYLES.slow.def]);
  ks.sort((a, b) => a[0] - b[0]);
  if (!ks.length) delete n.keys.blink;
  commit(); renderTimeline();
}
function renderInspector() {
  const box = $('#inspector');
  box.innerHTML = '';
  if (!D) return;
  if (lgById(D.ui.selLg)) { renderLgInspector(box, lgById(D.ui.selLg)); return; }
  const n = sel();
  if (!n) return;
  const nameInp = el('input', { type: 'text', value: n.name });
  nameInp.addEventListener('change', () => { if (setNodeName(n, nameInp.value)) { commit(); renderTree(); renderOrder(); } else nameInp.value = n.name; });
  box.append(field('名稱', nameInp));
  if (n.type === 'root') {
    return;
  }
  if (isPart(n) && n.type !== 'group') box.append(selectField('類型', Model.ADD_TYPES.filter(t => t !== 'group').map(t => [t, TYPES[t].label, !parentOk(t, node(n.parent)), parentReqText(t)]), () => n.type, v => {
    n.type = v; n.params = typeDefaults(v); n.p3d = { ...P3D.nodeDefaults(v), off: n.p3d?.off };
  }, () => renderAll(), '換類型會套用該類型的動態與立體預設'));
  else if (n.type !== 'image') box.append(field('類型', el('span', {}, TYPES[n.type].label)));
  for (const w of Model.warnings(D.data, n)) box.append(el('div', { class: 'warnbox' }, ico('warn'), w));
  // 父層（圖層也可以放到其他圖層 / 部位底下，跟著父層一起動）
  const parentOpts = D.data.nodes.filter(x => !Model.descendants(D.data, n.id).has(x.id)).map(x => [x.id, x.name, !!nodeRole(n) && !parentOk(nodeRole(n), x), parentReqText(nodeRole(n) || 'image')]);
  box.append(selectField('父層', parentOpts, () => n.parent, v => { n.parent = v; }, () => renderAll()));
  // 依循父層：整體（跟著父層在那裡的變形）或父層的某個錨點（只跟著那一點平移）
  { const par = n.parent && node(n.parent);
    if (par && par.type !== 'root' && par.pins.length) box.append(selectField('依循父層', [['', '整體（跟著父層的變形）'], ...par.pins.map((p, i) => [p.id, `錨點 ${i + 1}${i ? '' : '（支點）'} 的位移`])], () => par.pins.some(p => p.id === n.follow) ? n.follow : '', v => { n.follow = v || null; }, null, '父層自己也有動畫時：選錨點 = 整個子層只跟著那一點平移，不會被父層的擺動或旋轉扭曲')); }

  if (n.type === 'image') {
    // 圖層的物件屬性：指定後就像部位一樣有動作參數，可以放錨點（支點 + 鏈），也能當其他圖層的父層帶著它們動
    const cur = n.role && TYPES[n.role] ? n.role : '';
    const tb = el('button', { class: 'btn', style: 'justify-self:start; white-space:nowrap', onclick: () => {
      const r = tb.getBoundingClientRect();
      typeMenu(r.left, r.bottom + 2, v => { setLayerRole(n, v); commit(); renderAll(); if (v && !n.pins.length) toast('用錨點工具（A）在這個圖層上放支點，就會以支點為中心動；再放幾個點就是擺動鏈', 'info'); }, { none: '一般圖層（不動）', current: cur, parentId: n.parent });
    } }, (cur ? TYPES[cur].label : '一般圖層（不動）') + ' ▾');
    box.append(field('物件屬性', tb, '指定後套用該類型的動作預設；用錨點工具放支點與運動點'));
    const a = D.data.assets[n.image.assetId];
    box.append(
      field('尺寸', el('span', {}, a ? `${a.w} × ${a.h}` : '—')),
      el('div', { class: 'btnrow' },
        el('button', { class: 'btn', onclick: () => startReplace(n) }, '取代圖片'),
        el('button', { class: 'btn', onclick: () => exportLayerPNG(n) }, '匯出 PNG')),
      ...group('差分', '換成另一張圖（例如張嘴、表情）；出現的時間在時間軸上用橫條調整，拖兩端改長度。'));
    const list = el('div', { class: 'vlist' });
    n.image.variants.forEach((v, i) => {
      const a = D.assets.get(v.assetId), th = el('canvas', { class: 'othumb', width: 34, height: 34 });
      if (a) { const k = Math.min(34 / a.w, 34 / a.h); th.getContext('2d').drawImage(a.canvas, (34 - a.w * k) / 2, (34 - a.h * k) / 2, a.w * k, a.h * k); }
      const nm = el('input', { type: 'text', value: v.name, title: '名稱' });
      nm.addEventListener('change', () => { v.name = nm.value; commit(); renderTimeline(); });
      const md = el('select', { title: '切換方式' }, ...Object.entries(VAR_MODES).map(([k, t]) => el('option', { value: k, selected: (v.mode || 'cut') === k }, t)));
      md.addEventListener('change', () => { v.mode = md.value; commit(); });
      list.append(el('div', { class: 'vitem' }, th, nm, md,
        el('button', { class: 'tb icon', title: '在時間軸上調整出現時間', onclick: () => { if (!timelineOn) toggleTimeline(true); else renderTimeline(); } }, ico('timeline')),
        el('button', { class: 'tb icon', title: '刪除差分', onclick: () => { n.image.variants.splice(i, 1); commit(); renderAll(); } }, ico('trash'))));
    });
    box.append(list, el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => $('#fileVariant').click() }, '＋ 加入差分')));
    renderBlinkUI(box, n);
    return;
  }

  if (n.type === 'group') return;
  if (Model.baseType(n.type) === 'head') renderBlinkUI(box, n);

  const R = n.region;
  box.append(...group('範圍', '核心 = 完全跟著動的區域；牽連範圍 = 核心外越遠越小的影響。'));
  box.append(selectField('方式', [['auto', '錨點周圍（自動）'], ['mask', '遮罩（可編輯）'], ['none', '無']], () => R.mode, v => {
    if (v === 'mask' && R.mode === 'auto') { R.mode = 'auto'; editableMask(D, n); }
    else R.mode = v;
  }, () => renderAll()));
  const M = Math.max(D.data.width, D.data.height);
  if (R.mode === 'auto') box.append(slider('核心粗細', () => R.radius, v => { R.radius = v; }, { min: 2, max: Math.round(M * 0.3), step: 1, noLive: true, tip: '錨點連線兩側完全跟著動的寬度（px）' }));
  box.append(
    slider('邊緣柔化', () => R.soft, v => { R.soft = v; }, { min: 0, max: 40, step: 1, noLive: true, tip: '與其他部位交界處的柔和寬度（px）' }),
    slider('牽連範圍', () => R.feather, v => { R.feather = v; }, { min: 0, max: Math.round(M * 0.5), step: 1, noLive: true, tip: '核心外還會被帶動的距離（px），越遠影響越小' }),
    slider('支點柔化', () => R.hinge ?? 0, v => { R.hinge = v; }, { min: 0, max: Math.round(M * 0.4), step: 1, tip: '旋轉 / 縮放從支點往外多遠才完全作用（px），消除支點周圍的分界' }),
    el('div', { class: 'btnrow' },
      R.mode === 'auto' ? el('button', { class: 'btn', onclick: () => { editableMask(D, n); commit(); renderAll(); setTool('mask'); } }, '轉成遮罩並編輯') :
        R.mode === 'mask' ? el('button', { class: 'btn', onclick: () => { R.mode = 'auto'; commit(); renderAll(); } }, '依錨點重建') : null,
      el('button', { class: 'btn', onclick: () => { showRegion = !showRegion; $('#tglRegion').classList.toggle('on', showRegion); } }, showRegion ? '隱藏範圍預覽' : '顯示範圍預覽')),
  );
  box.append(el('div', { class: 'frow' }, el('label', {}, '獨立圖層'), checkbox('從圖片切出，可調前後', () => n.detach, v => {
    n.detach = v;
    const img = Model.imageOf(D.data, n);
    if (v && img && !n.order) n.order = img.order + 1;
  }, renderAll)));
  if (n.detach) {
    const img = Model.imageOf(D.data, n);
    box.append(
      slider('邊緣硬度', () => n.hardness ?? 0.85, v => { n.hardness = v; }, { min: 0, max: 1, step: 0.05, dec: 2, noLive: true, tip: '切出來的邊緣：1 = 銳利，越低越柔和' }),
      slider('補色寬度', () => n.fillBand ?? Math.round(M * 0.04), v => { n.fillBand = v; }, { min: 0, max: Math.round(M * 0.2), step: 1, noLive: true, tip: '上下層交界處補色的寬度（px）：只補這條帶子，顏色取兩邊平均，不超出原圖範圍' }),
      el('div', { class: 'btnrow' },
        img && el('button', { class: 'btn', onclick: () => { n.order = img.order - 1; commit(); renderAll(); } }, '放到圖層後方'),
        img && el('button', { class: 'btn', onclick: () => { n.order = img.order + 1; commit(); renderAll(); } }, '放到圖層前方'),
        el('button', { class: 'btn', onclick: () => exportLayerPNG(n) }, '匯出 PNG'),
        el('button', { class: 'btn', onclick: () => bakeDetached(n) }, '轉成圖片圖層')));
  }
}

function renderParams() {
  const box = $('#params');
  box.innerHTML = '';
  box.classList.remove('p3doff');
  if (!D) return;
  if (lgById(D.ui.selLg)) { box.append(el('div', { class: 'hint' }, '群組只綁定圖層的前後順序；動作參數在各個圖層 / 部位上設定。')); return; }
  const n = sel();
  if (!n) return;
  // 動態 / 立體 分頁：共用部位、錨點與範圍，參數分開
  const tab = D.ui.ptab || 'motion';
  box.append(el('div', { class: 'ptabs' }, ...[['motion', '動態'], ['p3d', '立體']].map(([k, t]) =>
    el('button', { class: tab === k ? 'on' : '', onmousedown: e => e.preventDefault(), onclick: () => { D.ui.ptab = k; renderParams(); } }, t))));
  if (tab === 'p3d') {
    renderP3D(box, n);
    if (!P3D.settings(D.data).enabled) {
      box.classList.add('p3doff');
      if (n.type !== 'root') box.insertBefore(el('div', { class: 'hint p3don' }, '立體還沒啟用：到「整體」的立體分頁勾選「啟用立體」'), box.children[1]);
      box.querySelectorAll('input, select, button').forEach(e => { if (!e.closest('.ptabs') && !e.closest('.p3don')) e.disabled = true; });
    }
    return;
  }
  if (n.type === 'root') { renderRootParams(box, n); return; }
  if (n.type === 'group') return;
  const P = n.params;
  const adv = !!D.ui.advOpen;
  box.append(
    el('div', { class: 'frow' }, el('label', {}, ''), checkbox('左右鏡像', () => n.mirror, v => { n.mirror = v; })),
    groupToggle('總體', P, MAIN_KEYS, '整個部位以支點（紅）為中心的動作；越靠近支點越柔和。左邊圓點 = 整組開關'),
    slider('相位', () => n.phase || 0, v => { n.phase = v; }, { mute: [P, 'phase'], min: 0, max: 32, step: 0.25, dec: 2, tip: '單位 1/32 循環（最小 0.25 = 1/128 循環）；整個部位晚多少：自己的動作、跟著父層的移動、底下的子層全部一起晚（16 = 半個循環）' }),
    slider('延遲', () => n.delay || 0, v => { n.delay = v; }, { mute: [P, 'delay'], min: -16, max: 16, step: 1, tip: '單位 1/32 循環；只有這個部位自己的動作晚多少（負值 = 提早），跟著父層的移動不變；16 = 半個循環' }),
    freqSlider('頻率', () => P.curve || (P.curve = { ...Model.partCurve(D.data, P) }), `${n.name}：總體動作的曲線`, '旋轉、位移、壓扁拉伸每個循環來回幾次（0.5 為單位）；小扳手調曲線形狀'),
    slider('旋轉角度', () => P.angle, v => { P.angle = v; }, { mute: [P, 'angle'], min: -45, max: 45, step: 0.5, dec: 1, tip: '度' }),
    slider('縮放', () => P.gravity, v => { P.gravity = v; }, { mute: [P, 'gravity'], min: 0, max: 0.1, step: 0.005, scale: 100, dec: 1, tip: '% 自然縮放：100 → 100+x → 100（每半個循環一次）' }),
    el('div', { class: 'advhead' + (adv ? ' open' : ''), onclick: () => { D.ui.advOpen = !adv; renderParams(); } }, ico(adv ? 'chevD' : 'chevR'), '進階'),
    adv ? el('div', { class: 'advbody' },
      slider('位移距離', () => P.move || 0, v => { P.move = v; }, { mute: [P, 'move'], min: 0, max: 0.08, step: 0.001, scale: 100, dec: 1, tip: '% 畫面高度；跟著頻率來回' }),
      slider('位移角度', () => P.moveAng || 0, v => { P.moveAng = v; }, { mute: [P, 'moveAng'], min: -180, max: 180, step: 5, tip: '度；0 = 上下、90 = 左右' }),
      slider('壓扁拉伸', () => P.squash || 0, v => { P.squash = v; }, { mute: [P, 'squash'], min: 0, max: 0.2, step: 0.005, scale: 100, dec: 1, tip: '% ；沿拉伸方向拉長時，垂直方向變窄（以支點為中心）' }),
      slider('拉伸角度', () => P.squashAng || 0, v => { P.squashAng = v; }, { mute: [P, 'squashAng'], min: -90, max: 90, step: 5, tip: '度；0 = 上下拉長、90 = 左右拉長' }),
      slider('轉軸角度', () => P.flipAng || 0, v => { P.flipAng = v; }, { mute: [P, 'flipAng'], min: -90, max: 90, step: 5, tip: '度；翻轉（像翻書頁）的轉軸：0 = 直軸（左右翻）、90 = 橫軸（上下翻）。時間軸的「翻轉」影格也用這個轉軸' }),
      slider('轉動頻率', () => P.flipFreq || 0, v => { P.flipFreq = v; }, { mute: [P, 'flipFreq'], min: 0, max: 4, step: 0.5, dec: 1, tip: '每個循環繞轉軸翻幾圈；0 = 不翻' })) : null,

    groupToggle('鍊', P, CHAIN_KEYS, '支點之後依序連接的運動點；每個節點左右擺，越往末端擺越大。左邊圓點 = 整組開關'),
    slider('節點間延遲', () => P.lag, v => { P.lag = v; }, { mute: [P, 'lag'], min: 0, max: 8, step: 1, tip: '單位 1/32 循環；相鄰節點晚多少，擺動與慣性共用' }),
    slider('擺動距離', () => P.amp, v => { P.amp = v; }, { mute: [P, 'amp'], min: 0, max: 0.25, step: 0.005, scale: 100, dec: 1, tip: '% ；節點到支點的鏈長 × 這個比例' }),
    slider('鬆度', () => P.taper ?? 1, v => { P.taper = v; }, { mute: [P, 'taper'], min: 0, max: 2, step: 0.05, dec: 2, tip: '鬆度：擺幅隨節點往外累積的程度。0 = 每個節點擺幅相同（整塊一起動、較硬），1 = 與距離成正比，2 = 累積加倍（末端甩更大、較鬆）' }),
    freqSlider('頻率', () => P.swayCurve || (P.swayCurve = { shape: 'sine', freq: P.swayFreq, phase: 0.75 }), `${n.name}：鍊的擺動曲線`, '每個循環來回幾次（0.5 為單位）；0 = 只靠慣性；小扳手調曲線形狀', v => { P.swayFreq = v; }),
    slider('圓度', () => P.round, v => { P.round = v; }, { mute: [P, 'round'], min: 0, max: 1, step: 0.05, dec: 2, tip: '0 = 左右直線來回，越大越接近圓形軌跡' }),
    slider('慣性', () => P.inertia, v => { P.inertia = v; }, { mute: [P, 'inertia'], min: 0, max: 1, step: 0.01, dec: 2, tip: '父層或整體移動時，節點依距離延遲地跟著擺的幅度' }),
    el('div', { class: 'btnrow' },
      el('button', { class: 'btn', title: '回到這個類型的預設（有「設為預設」過就用那一組）', onclick: () => { n.params = typeDefaults(typeKeyOf(n)); commit(); renderParams(); } }, '重設'),
      el('button', { class: 'btn', title: '把目前的參數存成這個類型的預設（存在這台電腦的瀏覽器）；之後新增同類型的部位就用這組', onclick: () => saveTypeDefaults(n) }, '設為預設')),
  );
}
// 參數群組標題 + 左側圓點：整組開關（用各參數的單獨關閉）
const MAIN_KEYS = ['delay', 'angle', 'gravity', 'move', 'squash', 'flipFreq'];
const CHAIN_KEYS = ['lag', 'amp', 'taper', 'swayFreq', 'round', 'inertia'];
function groupToggle(text, P, keys, note) {
  const on = () => keys.some(k => !(P.off && P.off[k]));
  const dot = el('button', { class: 'pdot gdot', title: '整組開啟 / 關閉' }, ico(on() ? 'dot' : 'dotOff'));
  dot.addEventListener('mousedown', e => e.preventDefault());
  dot.addEventListener('click', () => {
    const was = on();
    P.off = P.off || {};
    for (const k of keys) { if (was) P.off[k] = true; else delete P.off[k]; }
    commit(); liveChanged(); renderParams();
  });
  return el('div', { class: 'group gtog' + (on() ? '' : ' muted'), title: note || '' }, dot, text);
}
// 類型預設：內建值 ＋「設為預設」存下來的（localStorage）
const typeKeyOf = n => n.type === 'image' ? (n.role && TYPES[n.role] ? n.role : 'image') : n.type;
function loadTypeDefaults() { try { return JSON.parse(localStorage.getItem('tan.defaults') || '{}'); } catch (_) { return {}; } }
function typeDefaults(t) {
  const base = JSON.parse(JSON.stringify((TYPES[t] || TYPES.custom).defaults || {}));
  const saved = loadTypeDefaults()[t];
  return saved ? { ...base, ...JSON.parse(JSON.stringify(saved)) } : base;
}
function saveTypeDefaults(n) {
  const t = typeKeyOf(n), all = loadTypeDefaults(), P = JSON.parse(JSON.stringify(n.params));
  delete P.off;
  all[t] = P;
  try { localStorage.setItem('tan.defaults', JSON.stringify(all)); toast(`已設為「${(TYPES[t] || TYPES.custom).label}」的預設：之後新增這個類型會用這組參數`, 'info'); }
  catch (e) { toast('無法儲存預設：' + e.message, 'error'); }
}
// 部位 / 圖層 / 群組在文件座標中的範圍（臉部精細模式初始化用）
// 只算圖層自己（不含子層）的範圍
function ownBounds(n) {
  const a = n.image && D.assets.get(n.image.assetId);
  if (!a) return nodeBounds(n);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const T = layerAffine(n.image, a);
  for (let y = 0; y < a.h; y += 2) for (let x = 0; x < a.w; x += 2) if (a.alpha[y * a.w + x] > 20) { const [X, Y] = aApply(T, x, y); if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; }
  return x1 < x0 ? nodeBounds(n) : { x0, y0, x1, y1 };
}
function nodeBounds(n) {
  const W = D.data.width, H = D.data.height;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  if (isPart(n) && n.region) {
    const obj = n.region.mode === 'mask' && n.region.maskId && D.masks.get(n.region.maskId);
    const data = obj ? obj.data : n.pins.length ? capsuleRaster(D, n, n.region.radius) : null;
    if (data) for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (data[y * W + x] > 128) add(x, y);
  }
  if (x1 < x0) for (const c of [n, ...Model.descendants(D.data, n.id)].map(id => typeof id === 'string' ? node(id) : id)) {
    if (!c || c.type !== 'image') continue;
    const a = D.assets.get(c.image.assetId);
    if (!a) continue;
    const T = layerAffine(c.image, a);
    for (let y = 0; y < a.h; y += 2) for (let x = 0; x < a.w; x += 2) if (a.alpha[y * a.w + x] > 20) add(...aApply(T, x, y));
  }
  return x1 < x0 ? { x0: 0, y0: 0, x1: W, y1: H } : { x0, y0, x1, y1 };
}
// 雙端拉桿：拉兩端設定範圍（get → [lo, hi]）
function rangeSlider(label, get, set, o) {
  const span = o.max - o.min, bip = o.min < 0 && o.max > 0, dec = o.dec ?? 2;
  const fill = el('i', { class: 'fill' }), hL = el('i', { class: 'rh' }), hR = el('i', { class: 'rh' });
  const track = el('div', { class: 'sl rsl' }, el('i', { class: 'end l' }), el('i', { class: 'end r' }),
    bip ? el('i', { class: 'mid', style: `left:calc(6px + (100% - 12px) * ${(0 - o.min) / span})` }) : null, fill, hL, hR);
  const txt = el('span', { class: 'num rnum' });
  const pos = v => `calc(6px + (100% - 12px) * ${(v - o.min) / span})`;
  const paint = () => {
    const [lo, hi] = get();
    hL.style.left = pos(lo); hR.style.left = pos(hi);
    fill.style.left = pos(lo); fill.style.width = `calc((100% - 12px) * ${(hi - lo) / span})`;
    txt.textContent = `${lo.toFixed(dec)} ~ ${hi.toFixed(dec)}`;
  };
  paint();
  const valAt = e => { const r = track.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (e.clientX - r.left - 6) / (r.width - 12))); return Math.round((o.min + f * span) / o.step) * o.step; };
  track.addEventListener('pointerdown', e => {
    e.preventDefault();
    const v = valAt(e), [lo, hi] = get();
    const which = Math.abs(v - lo) <= Math.abs(v - hi) && !(lo === hi && v > hi) ? 0 : 1;
    const move = ev => { const x = valAt(ev), [a, b] = get(); if (which === 0) set(Math.min(x, b), b); else set(a, Math.max(x, a)); paint(); o.after && o.after(); };
    move(e);
    track.setPointerCapture(e.pointerId);
    const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); if (!o.noCommit) commit(); };
    track.addEventListener('pointermove', move); track.addEventListener('pointerup', up);
  });
  track.addEventListener('dblclick', () => { if (o.reset) { set(...o.reset); paint(); commit(); o.after && o.after(); } });
  return el('div', { class: 'prow', title: o.tip || '' }, el('span'), el('label', {}, label), track, txt);
}
function renderP3D(box, n) {
  const S = P3D.settings(D.data);
  if (n.type === 'root') {
    box.append(
      ...group('立體轉向', '一個轉向驅動全身：前方往轉向方向移、後方反向。深度在左側「部位」上方的深度條調整；預覽畫面下方 / 右方的拉桿可以直接試轉。'),
      el('div', { class: 'frow p3don' }, el('label', {}, ''), checkbox('啟用立體', () => S.enabled, v => { S.enabled = v; }, () => {
        // 深度工具、深度條、樹、試轉拉桿都要跟著更新（之前只更新一部分，看起來像沒反應）
        renderAll(); renderTools();
        if (S.enabled) { if (!D.ui.playing) { D.ui.playing = true; updatePlaybar(); } toast('已啟用立體：播放中會左右轉向；也可以拖預覽下方 / 右方的拉桿試轉', 'info'); }
      })),
      slider('深度感', () => S.depth, v => { S.depth = v; }, { noLive: true, mute: [S, 'depth'], min: 0, max: 2, step: 0.05, dec: 2, tip: '所有部位視差位移與臉部變化的整體倍率' }),
      ...group('左右轉向'),
      slider('角度', () => S.yaw, v => { S.yaw = v; }, { noLive: true, mute: [S, 'yaw'], min: 0, max: 40, step: 0.5, dec: 1, tip: '度；最大轉向角' }),
      slider('次數', () => S.yawFreq, v => { S.yawFreq = v; }, { noLive: true, min: 1, max: 4, step: 1, tip: '每個循環轉幾次（整數才能首尾無縫）' }),
      slider('相位', () => S.yawPhase, v => { S.yawPhase = v; }, { noLive: true, mute: [S, 'yawPhase'], min: -16, max: 16, step: 1, tip: '單位 1/32 循環；相對整體擺動提早 / 延後' }),
      ...group('上下俯仰', '次數與轉向相同、相位差 8 = 繞圈；次數為轉向 2 倍 = 點頭。'),
      slider('角度', () => S.pitch, v => { S.pitch = v; }, { noLive: true, mute: [S, 'pitch'], min: 0, max: 30, step: 0.5, dec: 1, tip: '度；最大俯仰角' }),
      slider('次數', () => S.pitchFreq, v => { S.pitchFreq = v; }, { noLive: true, min: 1, max: 4, step: 1, tip: '每個循環點幾次（整數才能首尾無縫）' }),
      slider('相位', () => S.pitchPhase, v => { S.pitchPhase = v; }, { noLive: true, mute: [S, 'pitchPhase'], min: -16, max: 16, step: 1, tip: '單位 1/32 循環' }),
      el('div', { class: 'btnrow' },
        el('button', { class: 'btn', title: '多圖層（PSD）：越上層越靠前，當作起點再各自調整', onclick: () => { P3D.depthByOrder(D.data); commit(); renderAll(); } }, '依圖層順序產生深度')),
    );
    return;
  }
  if (rigHostOf(n)) renderRigPanel(box, n);
  const P = P3D.nodeOf(n);
  const onFace = !!P3D.faceAncestor(D.data, n);
  const rel = (P3D.depthOf(n, D.data) - P3D.parentDepth(D.data, n)).toFixed(2);
  box.append(el('div', { class: 'note', title: onFace ? '正 = 凸出（鼻、嘴、前髮），負 = 凹進（眼窩）' : '正值轉向時往同方向移，負值反向' }, (onFace ? `相對臉部凹凸 ${rel}` : `與父層深度差 ${rel}`) + (S.enabled ? '' : '（立體未啟用）')));
  // 轉動範圍：整體 -1 … 1 對應到這個物件的範圍（靜止時都是 0）
  const RG = P.range || (P.range = {});
  box.append(...group('轉動範圍', '整體轉到底時，這個物件轉到多少；拉兩端設定。1 = 跟整體一樣，靜止時都是 0。雙擊恢復 -1 ~ 1。'),
    rangeSlider('左右', () => [RG.yawNeg ?? -1, RG.yawPos ?? 1], (a, b) => { RG.yawNeg = a; RG.yawPos = b; }, { min: -1, max: 1, step: 0.05, reset: [-1, 1], tip: '左端 = 整體轉到最左時；右端 = 整體轉到最右時' }),
    rangeSlider('上下', () => [RG.pitchNeg ?? -1, RG.pitchPos ?? 1], (a, b) => { RG.pitchNeg = a; RG.pitchPos = b; }, { min: -1, max: 1, step: 0.05, reset: [-1, 1], tip: '左端 = 整體轉到最上時；右端 = 整體轉到最下時' }));
  // 有頭部定位時，轉向變形（臉型）由上面的定位控制
  if (HeadRig.active(n.rig)) return;
  // 轉向變形：大略（壓縮）或臉部精細（頭側面展開 / 壓縮）
  const F = P.face && P3D.faceNorm(P.face);
  const faceOn = !!(F && F.on);
  box.append(...group('轉向變形'),
    field('處理方式', seg([['rough', '大略'], ['fine', '臉部精細']], () => faceOn ? 'fine' : 'rough', v => {
      if (v === 'fine') { if (!P.face) P.face = P3D.faceFromBounds(nodeBounds(n), n.pins && n.pins[0]); P.face.on = true; }
      else if (P.face) P.face.on = false;
      commit(); renderParams();
    }), '大略 = 以支點壓縮；臉部精細 = 頭側面展開 / 壓縮、臉部曲度。畫面上可拖曳中線兩端、中心、頭寬、臉寬、半高'));
  if (faceOn) {
    const M = Math.max(D.data.width, D.data.height);
    box.append(
      slider('側面壓縮', () => F.side, v => { F.side = v; }, { noLive: true, mute: [F, 'side'], min: 0, max: 1, step: 0.05, dec: 2, tip: '頭側面一側展開、一側壓縮的程度（以轉 30° 為基準：1 = 遠側幾乎壓平）' }),
      slider('臉部曲度', () => F.curve, v => { F.curve = v; }, { noLive: true, mute: [F, 'curve'], min: 0, max: 1, step: 0.05, dec: 2, tip: '臉本身的弧度：中間比邊緣多移一點，近側半邊略寬、遠側半邊略窄；俯仰時上下同理' }),
      slider('遠近大小', () => F.persp, v => { F.persp = v; }, { noLive: true, mute: [F, 'persp'], min: 0, max: 0.5, step: 0.05, dec: 2, tip: '近側略放大、遠側略縮小' }),
      slider('頭半寬', () => F.R, v => { F.R = v; }, { noLive: true, min: 10, max: Math.round(M * 0.6), step: 1, tip: 'px；轉軸到頭邊緣（含頭髮）' }),
      slider('臉半寬', () => F.Fw, v => { F.Fw = v; }, { noLive: true, min: 5, max: Math.round(M * 0.6), step: 1, tip: 'px；轉軸到臉頰邊緣；要比頭半寬小' }),
      slider('半高', () => F.Rv, v => { F.Rv = v; }, { noLive: true, min: 10, max: Math.round(M * 0.6), step: 1, tip: 'px；中心到頭頂，只影響上下俯仰' }),
      el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => { P.face = P3D.faceFromBounds(nodeBounds(n), n.pins && n.pins[0]); commit(); renderParams(); } }, '依範圍重新估計')));
  } else {
    box.append(
      slider('水平壓縮', () => P.squashX, v => { P.squashX = v; }, { noLive: true, mute: [P, 'squashX'], min: 0, max: 1, step: 0.05, dec: 2, tip: '轉向時以支點為軸變窄' }),
      slider('垂直壓縮', () => P.squashY, v => { P.squashY = v; }, { noLive: true, mute: [P, 'squashY'], min: 0, max: 1, step: 0.05, dec: 2, tip: '俯仰時以支點為軸變扁' }));
  }
  box.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => { n.p3d = { ...P3D.nodeDefaults(n.type), depth: P.depth, depthFar: P.depthFar, mapId: P.mapId, off: P.off }; commit(); renderParams(); } }, '恢復預設')));
}
// 算 BPM：跟著節奏點按鈕，用最近四次點擊的間隔平均（隔 2 秒沒點就重新開始）；測到數字後可套用或重測
function bpmTapper(apply) {
  const taps = [];
  let bpm = 0;
  const out = el('span', { class: 'bpmval' }), ok = el('button', { class: 'btn primary', style: 'display:none', onclick: () => { if (bpm) apply(bpm); } }, '套用');
  const again = el('button', { class: 'tb icon', title: '重測', style: 'display:none', onclick: () => { taps.length = 0; bpm = 0; show(); } }, '↻');
  const show = () => { out.textContent = bpm ? `${bpm} BPM` : taps.length ? `再點 ${Math.max(1, 2 - taps.length)} 下以上…` : ''; ok.style.display = again.style.display = bpm ? '' : 'none'; };
  const tap = el('button', { class: 'btn', title: '跟著音樂或節奏點這個按鈕（至少兩下），取最近四次間隔的平均', onclick: () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 2) { const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); bpm = Math.max(10, Math.min(240, Math.round(60000 / iv))); }
    show();
  } }, '算 BPM');
  show();
  return el('div', { class: 'frow' }, el('label', {}, ''), el('div', { class: 'inline', style: 'align-items:center; gap:6px' }, tap, out, ok, again));
}
function renderRootParams(box, root) {
  const G = root.params, TL = D.data.timeline;
  const cycText = () => `一個循環 ${(60 / Model.bpmOf(D.data)).toFixed(2)} 秒 · ${Math.round(master())} 幀`;
  const cyc = el('div', { class: 'note', style: 'text-align:right' }, cycText());
  const presetSeg = el('div', { class: 'segsmall' });
  const curPreset = D.data.preset === 'breath' ? 'idle' : D.data.preset;   // 舊存檔的「自然呼吸」= 待機
  for (const [k, pr] of Object.entries(Model.PRESETS)) presetSeg.append(el('button', {
    class: curPreset === k ? 'on' : '', style: 'flex:1 1 0; white-space:nowrap',
    onclick: () => { Model.applyPreset(D.data, k); commit(); renderParams(); setMode('preview'); },
  }, pr.label));
  const levels = [['輕微', 0.5], ['標準', 1], ['誇張', 1.8]];
  const lvl = el('div', { class: 'segsmall' });
  const paintLvl = () => lvl.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', Math.abs(levels[i][1] - D.data.intensity) < 1e-6));
  for (const [t, v] of levels) lvl.append(el('button', { onclick: () => { D.data.intensity = v; paintLvl(); commit(); renderParams(); setMode('preview'); } }, t));
  paintLvl();
  box.append(
    ...group('整體動作', '動作組會調整頭、軀幹與整體的設定；強度是整體倍率。'),
    field('動作組', presetSeg),
    field('強度', lvl),
    slider('倍率', () => D.data.intensity, v => { D.data.intensity = v; paintLvl(); }, { min: 0, max: 2.5, step: 0.05, dec: 2 }),
    ...group('整體運動'),
    el('div', { class: 'frow' }, el('label', {}, ''), checkbox('啟用', () => G.enabled, v => { G.enabled = v; }, renderTree)),
    slider('上下彈跳', () => G.bounce, v => { G.bounce = v; }, { mute: [G, 'bounce'], min: 0, max: 0.06, step: 0.001, scale: 100, dec: 1, tip: '% 圖高' }),
    slider('左右擺動', () => G.sway, v => { G.sway = v; }, { mute: [G, 'sway'], min: 0, max: 0.05, step: 0.001, scale: 100, dec: 1, tip: '% 圖寬' }),
    slider('旋轉', () => G.rot, v => { G.rot = v; }, { mute: [G, 'rot'], min: 0, max: 10, step: 0.1, dec: 1, tip: '度' }),
    slider('壓扁拉伸', () => G.squash, v => { G.squash = v; }, { mute: [G, 'squash'], min: 0, max: 0.1, step: 0.005, scale: 100, dec: 1, tip: '%' }),
    freqSlider('左右 / 旋轉', () => G.xCurve || (G.xCurve = { ...Model.globalCurveSpecs(D.data, G).x }), '左右擺動 / 旋轉的曲線', '左右擺動與旋轉：每個循環幾次（0.5 為單位）'),
    freqSlider('上下 / 壓扁', () => G.yCurve || (G.yCurve = { ...Model.globalCurveSpecs(D.data, G).y }), '上下彈跳 / 壓扁拉伸的曲線', '上下彈跳與壓扁拉伸：每個循環幾次（0.5 為單位）'),
    el('canvas', { id: 'wave', class: 'mini' }),
    el('div', { class: 'legend' }, el('span', {}, el('i', { style: 'background:#5b8cff' }), 'X 左右 / 旋轉'), el('span', {}, el('i', { style: 'background:#f0b24a' }), 'Y 上下 / 壓扁')),
    ...group('時間軸'),
    slider('BPM', () => Model.bpmOf(D.data), v => { const ph = D.ui.frame / total(); TL.bpm = v; D.ui.frame = ph * total(); cyc.textContent = cycText(); updatePlaybar(); }, { min: 10, max: 240, step: 1, tip: '每分鐘幾個完整循環；60 = 一秒一個循環' }),
    cyc,
    ...group('緩動'),
    el('canvas', { id: 'curve', class: 'mini', style: 'height:90px' }),
    slider('影響度', () => TL.ease, v => { TL.ease = v; drawCurve(); }, { min: 0, max: 0.9, step: 0.01, scale: 100, dec: 0, tip: '% ；33 ≈ AE Easy Ease' }),
    ...group('外框', '沿著角色實際的邊緣描一圈（不是遮罩範圍）；預覽與輸出都會帶框'),
    ...(() => {
      const O = D.data.outline || (D.data.outline = { on: false, width: 6, color: '#ffffff' });
      const color = el('input', { type: 'color', value: O.color, oninput: e => { O.color = e.target.value; }, onchange: () => commit() });
      return [
        el('div', { class: 'frow' }, el('label', {}, ''), checkbox('顯示外框', () => O.on, v => { O.on = v; commit(); })),
        slider('粗細', () => O.width, v => { O.width = v; }, { min: 0.5, max: 40, step: 0.5, dec: 1, noLive: true, tip: 'px（原圖尺寸）' }),
        field('顏色', color),
      ];
    })(),
    ...group('網格'),
    slider('密度', () => D.data.mesh.density, v => { D.data.mesh.density = v; }, { min: 16, max: 96, step: 1, noLive: true }),
    slider('擺動柔軟度', () => D.data.mesh.rigidity, v => { D.data.mesh.rigidity = v; }, { min: 0.6, max: 2.5, step: 0.05, dec: 2, tip: '越高，擺動時每個錨點只影響自己附近' }),
  );
  requestAnimationFrame(drawCurve);
}

function renderAll() {
  renderTree(); renderOrder(); renderRight(); renderStatus(); updatePlaybar(); renderSimple();
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', D && b.dataset.mode === D.ui.mode));
}

// ---------- 輸出 ----------
function openExport() {
  if (!D) { toast('請先開啟圖片', 'warn'); return; }
  const m = $('#modal');
  const st = { fmt: 'mp4', gifFps: 25, bg: 'black', loops: 1, infinite: true, scale: 1, margin: 0.06 };
  const BG = { transparent: '透明', black: '黑', white: '白', green: '綠幕' };
  const bgFor = f => f === 'mp4' || f === 'webm' ? ['black', 'white', 'green'] : f === 'png' ? ['transparent'] : ['transparent', 'black', 'white', 'green'];
  const body = el('div', { class: 'dbody' });
  const prog = el('div', { class: 'progress' }, el('i'));
  const info = el('div', { class: 'note' });
  let running = false, cancel = false;
  const draw = () => {
    body.innerHTML = '';
    if (!bgFor(st.fmt).includes(st.bg)) st.bg = bgFor(st.fmt)[0];
    // 頻率不是整數：輸出時繼續往下播（不是重複同一段），播到所有動作剛好接回起點
    const mul = Model.loopMul(D.data);
    if (mul > 1) body.append(el('div', { class: 'note' }, `有非整數頻率：輸出時自動延長為 ${mul} 段時間軸（${(total() * mul / D.data.timeline.fps).toFixed(2)} 秒），動作才會完整接回起點`));
    const N = Math.round(total() * mul), fps = D.data.timeline.fps;
    const W = Math.round(D.data.width * (1 + st.margin * 2) * st.scale), H = Math.round(D.data.height * (1 + st.margin * 2) * st.scale);
    info.textContent = `${W} × ${H} px · 一次循環 ${N} 幀（${(N / fps).toFixed(2)} 秒）` + (st.fmt === 'gif' ? '' : ` · 檔案長度 ${(N * st.loops / fps).toFixed(2)} 秒`) + (['mp4', 'webm'].includes(st.fmt) ? (Exporter.canEncode() ? ' · 逐格編碼（不需即時錄製）' : ' · 此瀏覽器不支援逐格編碼，改用即時錄製') : st.fmt === 'apng' ? ' · 全彩、半透明邊緣平滑，檔案比 GIF 大' : st.fmt === 'gif' ? ' · 256 色；要最順、最清楚請用 APNG 或 MP4' : '');
    const sel2 = (label, opts, key, after) => {
      const s = el('select', {});
      for (const [v, t] of opts) s.append(el('option', { value: v, selected: String(st[key]) === String(v) }, t));
      s.addEventListener('change', () => { st[key] = isNaN(+s.value) ? s.value : +s.value; draw(); after && after(); });
      return field(label, s);
    };
    const loops = el('input', { type: 'number', min: 1, max: 99, value: st.loops });
    loops.addEventListener('change', () => { st.loops = Math.max(1, Math.round(+loops.value || 1)); draw(); });
    body.append(
      sel2('格式', [['mp4', 'MP4（H.264）'], ['webm', 'WebM（VP9）'], ['apng', 'APNG（全彩動畫 PNG，可透明）'], ['gif', 'GIF'], ['png', 'PNG 序列（ZIP）']], 'fmt'),
      sel2('背景', bgFor(st.fmt).map(k => [k, BG[k]]), 'bg'),
      field('循環次數', loops, '檔案本身包含幾次完整循環（最少 1）'),
      st.fmt === 'gif' || st.fmt === 'apng' ? el('div', { class: 'frow' }, el('label', {}, ''), el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: st.infinite, onchange: e => { st.infinite = e.target.checked; } }), '播完後持續重播（無限循環）')) : null,
      st.fmt === 'gif' ? sel2('GIF 幀率', [[25, '25 fps（每格 0.04 秒，均勻）'], [50, '50 fps（每格 0.02 秒，最順、檔案大）'], [20, '20 fps（每格 0.05 秒，檔案小）']], 'gifFps') : null,
      sel2('尺寸', [[0.5, '50%'], [1, '100%'], [2, '200%']], 'scale'),
      sel2('邊距', [[0, '無'], [0.06, '6%（保留彈跳空間）'], [0.12, '12%']], 'margin'),
      info, prog,
    );
  };
  const start = el('button', { class: 'btn primary' }, '開始輸出');
  const close = el('button', { class: 'btn' }, '關閉');
  close.onclick = () => { if (running) cancel = true; else m.classList.add('hidden'); };
  start.onclick = async () => {
    if (running) return;
    running = true; cancel = false; start.disabled = true; close.textContent = '取消';
    try { await runExport(st, p => { prog.firstChild.style.width = (p * 100).toFixed(1) + '%'; }, () => cancel); }
    catch (e) { toast('輸出失敗：' + e.message, 'error'); }
    running = false; start.disabled = false; close.textContent = '關閉';
  };
  m.innerHTML = '';
  m.append(el('div', { class: 'dialog' }, el('h2', {}, '輸出動畫'), body, el('div', { class: 'dfoot' }, close, start)));
  m.classList.remove('hidden');
  draw();
}

async function runExport(st, progress, cancelled) {
  const Mf = total() * Model.loopMul(D.data), N = Math.max(1, Math.round(Mf)), fps = D.data.timeline.fps;
  const s = st.scale, mg = st.margin;
  let W = Math.round(D.data.width * (1 + mg * 2) * s), H = Math.round(D.data.height * (1 + mg * 2) * s);
  if (st.fmt === 'mp4' || st.fmt === 'webm') { W += W % 2; H += H % 2; }   // 影片編碼需要偶數尺寸
  const V = [s, 0, 0, s, D.data.width * mg * s, D.data.height * mg * s];
  const bgColor = { black: '#000', white: '#fff', green: '#00b140' }[st.bg];
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const og = out.getContext('2d', { willReadFrequently: true });
  const render = f => {
    const t = (f % N) * Mf / N;
    renderer.begin(W, H);
    drawScene(t, true, aMul(V, Model.globalAffine(D.data, t)), W, H, null);
    og.clearRect(0, 0, W, H);
    if (bgColor) { og.fillStyle = bgColor; og.fillRect(0, 0, W, H); }
    og.drawImage(renderer.canvas, 0, 0);
  };
  const name = D.name.replace(/[\\/:*?"<>|]/g, '_');
  exporting = true;
  try {
    ensureDerived(D);
    if (st.fmt === 'gif') {
      // GIF 的每格時間以 1/100 秒為單位：用能整除的幀率（25 / 50 / 20），每格時間一致才不會一頓一頓
      const gf = st.gifFps || 25, Ng = Math.max(1, Math.round(N / fps * gf));
      const renderG = f => { const t = (f % Ng) * Mf / Ng; renderer.begin(W, H); drawScene(t, true, aMul(V, Model.globalAffine(D.data, t)), W, H, null); og.clearRect(0, 0, W, H); if (bgColor) { og.fillStyle = bgColor; og.fillRect(0, 0, W, H); } og.drawImage(renderer.canvas, 0, 0); };
      const blob = await Exporter.gif({
        width: W, height: H, frames: Ng * (st.infinite ? 1 : st.loops), fps: gf, loops: st.infinite ? 0 : 1, transparent: !bgColor,
        frameAt: f => { renderG(f); return og.getImageData(0, 0, W, H); }, progress, cancelled,
      });
      if (blob) saveBlob(blob, `${name}.gif`);
    } else if (st.fmt === 'png') {
      const files = [];
      for (let f = 0; f < N * st.loops; f++) {
        if (cancelled()) return;
        render(f);
        const bin = atob(out.toDataURL('image/png').split(',')[1]), data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        files.push({ name: `${name}_${String(f + 1).padStart(4, '0')}.png`, data });
        progress((f + 1) / (N * st.loops));
        if (f % 6 === 5) await new Promise(r => setTimeout(r, 0));
      }
      saveBlob(Exporter.zip(files), `${name}_png.zip`);
    } else if (st.fmt === 'apng') {
      const blob = await Exporter.apng({
        width: W, height: H, frames: N * (st.infinite ? 1 : st.loops), fps, loops: st.infinite ? 0 : 1,
        framePng: f => { render(f); const bin = atob(out.toDataURL('image/png').split(',')[1]), d = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i); return d; },
        progress, cancelled,
      });
      if (blob) saveBlob(blob, `${name}.png`);
    } else if (Exporter.canEncode()) {
      const blob = await Exporter.encodeVideo({ kind: st.fmt, canvas: out, fps, frames: N * st.loops, drawFrame: render, progress, cancelled });
      if (blob) saveBlob(blob, `${name}.${st.fmt}`);
      else if (!cancelled()) throw new Error('這個瀏覽器無法編碼此格式，請改用另一種格式');
    } else {
      const mime = Exporter.pickMime(st.fmt);
      if (!mime) throw new Error(st.fmt === 'mp4' ? '這個瀏覽器不支援錄製 MP4，請改用 WebM 或最新版 Chrome / Edge' : '這個瀏覽器不支援錄製 WebM');
      const blob = await Exporter.video({ canvas: out, fps, frames: N * st.loops, mime, drawFrame: render, progress, cancelled });
      if (blob) saveBlob(blob, `${name}.${st.fmt}`);
    }
  } finally {
    exporting = false;
    resize();
  }
}

// ---------- 可拖曳的分隔線 ----------
function setupSplitters() {
  const layout = $('#layout');
  const saved = JSON.parse(localStorage.getItem('puppet.layout') || '{}');
  for (const k in saved) layout.style.setProperty(k, saved[k]);
  document.querySelectorAll('.vsplit, .hsplit').forEach(sp => {
    sp.addEventListener('pointerdown', e => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
      const v = sp.dataset.var, dir = +sp.dataset.dir, vert = sp.classList.contains('vsplit');
      const start = vert ? e.clientX : e.clientY;
      // 左右面板從實際寬度起算（視窗窄時寬度會被自動縮小）
      const pn = v === '--lw' ? $('.panel.left') : v === '--rw' ? (document.body.classList.contains('simplemode') ? $('#simpleR') : $('.panel.right')) : null;
      const cur = pn ? pn.getBoundingClientRect().width : parseFloat(getComputedStyle(layout).getPropertyValue(v)) || 200;
      const move = ev => {
        const d = ((vert ? ev.clientX : ev.clientY) - start) * dir;
        const val = Math.max(vert ? 180 : 60, Math.min(vert ? 600 : 600, cur + d));
        layout.style.setProperty(v, val + 'px');
      };
      const up = () => {
        sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); sp.classList.remove('drag');
        const s = JSON.parse(localStorage.getItem('puppet.layout') || '{}');
        s[v] = layout.style.getPropertyValue(v);
        try { localStorage.setItem('puppet.layout', JSON.stringify(s)); } catch (_) { /* ignore */ }
        resize();
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
  });
}

// ---------- 畫布大小 ----------
function resizeCanvas(W2, H2, anchor = 'center', ox = null, oy = null) {
  W2 = Math.round(Math.max(16, Math.min(8192, W2 || 0))); H2 = Math.round(Math.max(16, Math.min(8192, H2 || 0)));
  const data = D.data, W = data.width, H = data.height;
  if (W2 === W && H2 === H && ox === null) return;
  const dx = ox !== null ? ox : anchor === 'tl' ? 0 : Math.round((W2 - W) / 2);
  const dy = oy !== null ? oy : anchor === 'tl' ? 0 : anchor === 'bottom' ? H2 - H : Math.round((H2 - H) / 2);
  for (const n of data.nodes) {
    if (n.image) { n.image.x += dx; n.image.y += dy; }
    for (const p of n.pins) { p.x += dx; p.y += dy; }
    const F = n.p3d && n.p3d.face;
    if (F) { F.cx += dx; F.cy += dy; F.top.x += dx; F.top.y += dy; F.chin.x += dx; F.chin.y += dy; }
  }
  // 遮罩 / 深度圖都是整張畫布大小：搬到新畫布
  for (const [id, m] of D.masks) {
    const out = new Uint8Array(W2 * H2);
    for (let y = 0; y < m.h; y++) {
      const ny = y + dy; if (ny < 0 || ny >= H2) continue;
      for (let x = 0; x < m.w; x++) { const nx = x + dx; if (nx >= 0 && nx < W2) out[ny * W2 + nx] = m.data[y * m.w + x]; }
    }
    D.masks.set(id, { data: out, w: W2, h: H2, v: ++maskVer });
  }
  data.width = W2; data.height = H2;
  tlPivotCache.clear();
  fitView(); commit(); renderAll();
}
function fitCanvasToContent() {
  const b = opaqueBounds(D);
  if (!b) return;
  const pad = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.04);
  resizeCanvas(b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2, 'tl', Math.round(pad - b.x0), Math.round(pad - b.y0));
}

// ---------- HeadRig：建立、面板、畫面編輯 ----------
const rigBoundsCache = new Map();
let rigBoundsSig = '';
function rigBounds(n) {
  if (rigBoundsSig !== D.cache.sSig) { rigBoundsCache.clear(); rigBoundsSig = D.cache.sSig; }
  if (!rigBoundsCache.has(n.id)) rigBoundsCache.set(n.id, nodeBounds(n));
  return rigBoundsCache.get(n.id);
}
// 某個圖層在文件座標的顏色取樣（null = 透明）
function pxSampler(imgNode) {
  const a = D.assets.get(imgNode.image.assetId), Ti = aInv(layerAffine(imgNode.image, a));
  return (x, y) => {
    const [lx, ly] = aApply(Ti, x, y).map(Math.round);
    if (lx < 0 || ly < 0 || lx >= a.w || ly >= a.h) return null;
    const i = (ly * a.w + lx) * 4;
    return a.rgba[i + 3] < 128 ? null : [a.rgba[i], a.rgba[i + 1], a.rgba[i + 2]];
  };
}
// 某個圖層在文件座標的亮度取樣（-1 = 透明）
function lumSampler(imgNode) {
  const a = D.assets.get(imgNode.image.assetId), Ti = aInv(layerAffine(imgNode.image, a));
  return (x, y) => {
    const [lx, ly] = aApply(Ti, x, y).map(Math.round);
    if (lx < 0 || ly < 0 || lx >= a.w || ly >= a.h) return -1;
    const i = (ly * a.w + lx) * 4;
    if (a.rgba[i + 3] < 128) return -1;
    return 0.3 * a.rgba[i] + 0.59 * a.rgba[i + 1] + 0.11 * a.rgba[i + 2];
  };
}
// 自動定位頭部：找五官 → 兩眼中點與中線 → 頭 / 臉範圍（有舊的臉部精細就換算過來）
// opts.roles：圖層 id → 頭部角色（face_base / hair_front / hair_side / hair_back / ear / accessory），由精靈指定、不看圖層名稱
function createRig(host, opts = {}) {
  const selfImage = host.type === 'image';   // 圖片圖層本身就是頭（五官畫在這張圖上）
  const layered = !selfImage && (host.type === 'group' || !Model.imageOf(D.data, host));
  const rig = HeadRig.defaults();
  let alphaAt, px, box, layers = [];
  if (selfImage) {
    px = pxSampler(host);
    alphaAt = (x, y) => !!px(x, y);
    box = nodeBounds(host);
  } else if (layered) {
    layers = [...Model.descendants(D.data, host.id)].map(id => node(id)).filter(n => n && n.type === 'image' && n.visible !== false).map(n => ({ id: n.id, name: n.name, b: nodeBounds(n), n, ...(opts.roles ? { role: opts.roles[n.id] || null } : {}) }));
    const S = layers.map(L => ({ b: L.b, px: pxSampler(L.n) }));
    const anyPx = (x, y) => { for (const q of S) if (x >= q.b.x0 && x <= q.b.x1 && y >= q.b.y0 && y <= q.b.y1) { const c = q.px(x, y); if (c) return c; } return null; };
    alphaAt = (x, y) => !!anyPx(x, y);
    const fbL = opts.roles ? layers.find(L => L.role === 'face_base') : layers.find(L => HeadRig.guessRole(L.name) === 'face_base');
    px = fbL ? pxSampler(fbL.n) : anyPx;
    box = fbL ? fbL.b : layers.reduce((a, L) => ({ x0: Math.min(a.x0, L.b.x0), y0: Math.min(a.y0, L.b.y0), x1: Math.max(a.x1, L.b.x1), y1: Math.max(a.y1, L.b.y1) }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
  } else {
    const img = Model.imageOf(D.data, host), W = D.data.width, H = D.data.height;
    const obj = host.region.mode === 'mask' && host.region.maskId && D.masks.get(host.region.maskId);
    const px0 = pxSampler(img);
    px = (x, y) => { const xi = Math.round(x), yi = Math.round(y); if (xi < 0 || yi < 0 || xi >= W || yi >= H) return null; if (obj && obj.data[yi * W + xi] < 128) return null; return px0(x, y); };
    alphaAt = (x, y) => !!px(x, y);
    box = nodeBounds(host);
  }
  const af = HeadRig.autoFeatures(box, px);
  rig.members.push(...af.members);
  if (layered) HeadRig.autoLayers(rig, layers, HeadRig.frameOf(rig).cx);
  else rig.members.push(HeadRig.member('face_base'));
  const old = host.p3d && host.p3d.face && host.p3d.face.R ? P3D.faceNorm(host.p3d.face) : null;
  HeadRig.measure(rig, alphaAt, af.face, af.ipd, old);
  host.rig = rig;
  P3D.settings(D.data).enabled = true;
  return rig;
}
// 頭：頭部件、頭群組（舊）、或「物件屬性」設為頭的圖片圖層
const rigHostOf = n => n && (n.type === 'head' || (n.role === 'head' && (n.type === 'group' || n.type === 'image'))) ? n : null;
// 測試姿態：以目前的轉頭幅度（左右）與俯仰幅度（上下，最少 8°）為準
const POSES = [['正面', 0, 0], ['左', -1, 0], ['右', 1, 0], ['上', 0, -1], ['下', 0, 1], ['左上', -1, -1], ['右上', 1, -1], ['左下', -1, 1], ['右下', 1, 1]];
const poseDeg = () => { const S = P3D.settings(D.data); return [S.yaw || 0, Math.max(8, S.pitch || 0)]; };
function setPose(y, p) {
  const S = P3D.settings(D.data);
  D.ui.probe = y || p ? { abs: true, yawDeg: y, pitchDeg: p, yaw: Math.max(-1, Math.min(1, y / (S.yaw || 25))), pitch: Math.max(-1, Math.min(1, p / (S.pitch || 20))) } : { yaw: 0, pitch: 0 };
  if (D.ui.mode !== 'edit') setMode('edit');
  renderProbe();
}
let rigShow = true;
const featName = m => (m.side === 'L' ? '左' : m.side === 'R' ? '右' : '') + (HeadRig.ROLES[m.role]?.label || m.role);
const featPartner = (rig, m) => m.side !== 'C' && rig.members.find(x => x !== m && x.role === m.role && x.marker && x.side === (m.side === 'L' ? 'R' : 'L'));
function renderRigPanel(box, host) {
  const rig = host.rig;
  box.append(...group('頭部定位', '拖曳畫面上的點：中心（轉軸）、頭頂（也決定中線方向）、頭寬、臉寬、下巴、五官（位置、範圍）。'));
  if (!rig || rig.version !== 2) {
    if (rig) box.append(el('div', { class: 'note' }, '這是舊版的頭部骨架，已停用；請重新定位。'));
    box.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn primary', onclick: () => { createRig(host); commit(); renderAll(); } }, rig ? '重新定位' : '自動定位頭部')));
    return;
  }
  const S = P3D.settings(D.data);
  box.append(
    el('div', { class: 'frow' }, el('label', {}, ''), el('div', { style: 'display:flex;gap:14px' },
      checkbox('啟用', () => rig.enabled, v => { rig.enabled = v; commit(); renderAll(); }),
      checkbox('顯示定位', () => rigShow, v => { rigShow = v; }))),
    slider('轉頭幅度', () => S.yaw, v => { S.yaw = v; }, { noLive: true, min: 0, max: 30, step: 0.5, dec: 1, tip: '度；播放時的最大轉頭角度（也是試轉拉桿的範圍）' }),
    slider('側面壓縮', () => rig.side, v => { rig.side = v; }, { noLive: true, min: 0, max: 1, step: 0.05, dec: 2, tip: '臉邊緣到頭邊緣之間：轉過來的一側展開、轉過去的一側壓縮（以轉 30° 為基準：1 = 遠側幾乎壓平）' }),
    slider('臉部曲度', () => rig.curve, v => { rig.curve = v; }, { noLive: true, min: 0, max: 1, step: 0.05, dec: 2, tip: '臉本身的弧度：中線附近比臉邊緣多移一點' }),
    slider('遠近大小', () => rig.persp, v => { rig.persp = v; }, { noLive: true, min: 0, max: 0.5, step: 0.05, dec: 2, tip: '近側略放大、遠側略縮小（以下巴為錨）' }),
    slider('五官立體', () => rig.relief, v => { rig.relief = v; }, { noLive: true, min: 0, max: 1, step: 0.05, dec: 2, tip: '五官相對臉面的凹凸：鼻子往轉向側多移一點、眼睛略凹；0 = 五官完全貼著臉面' }),
    el('div', { class: 'btnrow' }, el('button', { class: 'btn', title: '中心移到兩眼中點的中線上、方向與兩眼連線垂直；頭 / 臉邊緣位置不動', onclick: () => { if (HeadRig.alignToFeatures(rig)) { commit(); renderParams(); } else toast('需要左右眼', 'warn'); } }, '依兩眼對齊中線')),
    field('測試姿態', el('div', { class: 'posebtns' }, ...POSES.map(([t, y, p]) => { const [Y, P] = poseDeg(), l = y && p ? t : y ? `${t} ${Y}°` : p ? `${t} ${P}°` : t; return el('button', { class: 'btn', onclick: () => { const [Y2, P2] = poseDeg(); setPose(y * Y2, p * P2); } }, l); }))),
  );
  // 五官
  box.append(...group('五官', '點選後拖中心移動、拖白色方塊調整範圍；範圍內整塊跟著臉走、不變形，外圈虛線是淡出。'));
  const feats = rig.members.filter(m => HeadRig.ROLES[m.role]?.feature);
  const list = el('div', { class: 'rigmembers' });
  feats.forEach(m => list.append(el('div', { class: 'rmrow' + (D.ui.rigSel === m.id ? ' on' : ''), onclick: () => { D.ui.rigSel = m.id; renderParams(); } },
    el('span', {}, featName(m)), el('span', { class: 'rmrole' }, m.size ? `${m.size[0]}×${m.size[1]}` : ''),
    el('button', { class: 'tb icon', title: '移除', onclick: e => { e.stopPropagation(); rig.members = rig.members.filter(x => x !== m); commit(); renderParams(); } }, ico('trash')))));
  box.append(list);
  const E = HeadRig.frameOf(rig), ipd = Math.max(20, (rig.face.l + rig.face.r) / 2);
  const cand = [['eye', 'L', -0.45, 0], ['eye', 'R', 0.45, 0], ['brow', 'L', -0.45, -0.45], ['brow', 'R', 0.45, -0.45], ['nose', 'C', 0, 0.5], ['mouth', 'C', 0, 0.9]].filter(([r, s]) => !feats.some(m => m.role === r && m.side === s));
  if (cand.length) {
    const addSel = el('select', {}, el('option', { value: '' }, '＋ 新增五官…'), ...cand.map(([r, s], i) => el('option', { value: i }, featName({ role: r, side: s }))));
    addSel.addEventListener('change', () => {
      const c = cand[+addSel.value]; if (!c) return;
      const [r, s, fx, fy] = c, sz = { eye: [0.3, 0.3], brow: [0.28, 0.08], nose: [0.1, 0.1], mouth: [0.22, 0.12] }[r];
      const m = HeadRig.member(r, { side: s, marker: HeadRig.fromLocal(E, fx * ipd, fy * ipd).map(Math.round), size: sz.map(v => Math.round(v * ipd)) });
      rig.members.push(m); D.ui.rigSel = m.id; commit(); renderParams();
    });
    box.append(field('', addSel));
  }
  const m = feats.find(x => x.id === D.ui.rigSel);
  if (m) {
    const pt = featPartner(rig, m);
    const setSize = (i, v) => { m.size = m.size || [20, 20]; m.size[i] = Math.round(v); if (rig.sync && pt) { pt.size = pt.size || [20, 20]; pt.size[i] = m.size[i]; } };
    box.append(
      slider('範圍寬', () => HeadRig.sizeOf(m)[0], v => setSize(0, v), { noLive: true, min: 3, max: 300, step: 1, tip: 'px；中心到左右邊緣' }),
      slider('範圍高', () => HeadRig.sizeOf(m)[1], v => setSize(1, v), { noLive: true, min: 3, max: 300, step: 1, tip: 'px；中心到上下邊緣' }),
      slider('淡出', () => m.fade ?? 1.4, v => { m.fade = v; if (rig.sync && pt) pt.fade = v; }, { noLive: true, min: 1.05, max: 3, step: 0.05, dec: 2, tip: '淡出範圍 = 範圍 × 倍率' }),
      slider('凸出', () => m.h || 0, v => { m.h = v; if (rig.sync && pt) pt.h = v; }, { noLive: true, min: -0.3, max: 0.5, step: 0.01, dec: 2, tip: '相對臉面：正 = 凸出（鼻）、負 = 凹進（眼）；乘上「五官立體」' }),
      el('div', { class: 'frow' }, el('label', {}, ''), checkbox('左右同步大小', () => rig.sync, v => { rig.sync = v; })));
  }
  // 範圍數值
  const det = el('details', { class: 'rigadv' });
  if (D.ui.rigAdv) det.open = true;
  det.addEventListener('toggle', () => { D.ui.rigAdv = det.open; });
  const Mx = Math.round(Math.max(D.data.width, D.data.height) * 0.6), Hh = rig.head, Fc = rig.face;
  det.append(el('summary', { title: '從中線量起（px）。頭寬到頭髮最外側，臉寬到臉頰邊緣；兩者之間是轉向時展開 / 壓縮的頭側面。' }, '範圍數值'),
    slider('頭寬（左）', () => Hh.l, v => { Hh.l = Math.max(Math.round(v), Fc.l + 4); }, { noLive: true, min: 10, max: Mx, step: 1 }),
    slider('頭寬（右）', () => Hh.r, v => { Hh.r = Math.max(Math.round(v), Fc.r + 4); }, { noLive: true, min: 10, max: Mx, step: 1 }),
    slider('頭頂', () => Hh.t, v => { Hh.t = Math.round(v); }, { noLive: true, min: 10, max: Mx, step: 1, tip: '中心到頭頂；只影響上下俯仰' }),
    slider('臉寬（左）', () => Fc.l, v => { Fc.l = Math.min(Math.round(v), Hh.l - 4); }, { noLive: true, min: 4, max: Mx, step: 1 }),
    slider('臉寬（右）', () => Fc.r, v => { Fc.r = Math.min(Math.round(v), Hh.r - 4); }, { noLive: true, min: 4, max: Mx, step: 1 }),
    slider('下巴', () => Fc.chin, v => { Fc.chin = Math.round(v); }, { noLive: true, min: 10, max: Mx, step: 1, tip: '中心到下巴；以下往脖子漸弱' }));
  // 分層：圖層遮擋 / 遠側淡出
  const refs = rig.members.filter(x => x.ref && node(x.ref));
  if (refs.length) {
    const refOpts = refs.map(x => [x.id, node(x.ref).name]);
    det.append(...group('圖層遮擋', '轉向量越過門檻時 A 換到 B 之下（交叉淡化）；耳朵等可設遠側淡出。'));
    (rig.occlusion || []).forEach((r, i) => {
      const pick = (get, set) => { const s = el('select', {}); for (const [v, t] of refOpts) s.append(el('option', { value: v, selected: get() === v }, t)); s.addEventListener('change', () => { set(s.value); commit(); }); return s; };
      det.append(el('div', { class: 'occrow' }, pick(() => r.a, v => { r.a = v; }), el('span', {}, '到'), pick(() => r.b, v => { r.b = v; }), el('span', {}, '之下'),
        el('button', { class: 'tb icon', title: '刪除', onclick: () => { rig.occlusion.splice(i, 1); commit(); renderParams(); } }, ico('trash'))),
        slider('門檻', () => r.threshold ?? 0.15, v => { r.threshold = v; }, { noLive: true, min: -1, max: 1, step: 0.01, dec: 2, tip: '轉向量（-1 左 … 1 右）' }),
        slider('淡化寬', () => r.fade ?? 0.1, v => { r.fade = v; }, { noLive: true, min: 0.01, max: 0.4, step: 0.01, dec: 2 }));
    });
    if (refOpts.length >= 2) det.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => { rig.occlusion.push({ id: Model.uid('oc_'), a: refOpts[0][0], b: refOpts[1][0], threshold: 0.15, fade: 0.1 }); commit(); renderParams(); } }, '＋ 遮擋規則')));
    for (const x of refs.filter(x => x.side !== 'C')) det.append(slider(`${node(x.ref).name} 遠側淡出`, () => x.hideAt ?? 1.01, v => { x.hideAt = v > 1 ? null : v; }, { noLive: true, min: 0.2, max: 1.01, step: 0.01, dec: 2, tip: '遠側轉到多少時淡出（> 1 = 不淡出）' }));
  }
  det.append(el('div', { class: 'btnrow' },
    el('button', { class: 'btn', onclick: () => { if (confirm('重新自動定位會覆蓋目前的五官與範圍，確定嗎？')) { createRig(host); commit(); renderAll(); } } }, '重新自動定位'),
    el('button', { class: 'btn', onclick: () => { host.rig = null; commit(); renderAll(); } }, '移除定位')));
  box.append(det);
}

// ---------- 畫面上的頭部定位 ----------
function rigEditHost() { const n = sel(); return D && D.ui.ptab === 'p3d' && n && rigHostOf(n) && HeadRig.active(n.rig) ? n : null; }
function rigHandles(host) {
  const rig = host.rig, E = HeadRig.frameOf(rig), L = (x, y) => HeadRig.fromLocal(E, x, y), H = rig.head, C = rig.face, out = [];
  out.push({ k: 'c', p: L(0, 0) }, { k: 'hl', p: L(-H.l, 0) }, { k: 'hr', p: L(H.r, 0) }, { k: 'ht', p: L(0, -H.t) },
    { k: 'fl', p: L(-C.l, C.chin * 0.5) }, { k: 'fr', p: L(C.r, C.chin * 0.5) }, { k: 'fc', p: L(0, C.chin) });
  for (const m of rig.members) {
    if (!m.marker || !HeadRig.ROLES[m.role]?.feature) continue;
    out.push({ k: 'mk', m, p: m.marker });
    if (D.ui.rigSel === m.id) {
      const [cx, cy] = HeadRig.toLocal(E, ...m.marker), s = HeadRig.sizeOf(m);
      out.push({ k: 'sw', m, p: L(cx + s[0], cy) }, { k: 'sh', m, p: L(cx, cy + s[1]) });
    }
  }
  return out;
}
// 文件座標（靜止）→ 畫面上目前的位置（試轉 / 預覽時跟著變形；五官另加凹凸的位移）
function rigDisplay(host, evals) {
  const e = evals && evals.get(host.id), M = lastDraw ? lastDraw.M : viewAffine();
  const pr = D.ui.probe, moving = D.ui.mode === 'preview' || (pr && (pr.abs || pr.yaw || pr.pitch));
  if (moving && pr) P3D.setProbe(D.ui.mode === 'preview' ? null : pr);
  const F = e && moving ? Model.rigFrame(D.data, host, D.ui.frame) : null;
  P3D.setProbe(null);
  const pose = new Map();
  if (F) for (const p of F.poses.values()) { const J = p.J; pose.set(p.m.id, HeadRig.dirToDoc(F.E, p.dx - J.dx, p.dy - J.dy)); }
  return (x, y, m) => {
    const d = m && pose.get(m.id), x0 = x + (d ? d[0] : 0), y0 = y + (d ? d[1] : 0);
    const o = e ? Model.applyChain(e, x0, y0) : [x0, y0];
    return aApply(M, o[0], o[1]);
  };
}
function drawRigGuide(g, V, evals) {
  const host = rigEditHost();
  if (!host || !rigShow) return;
  const rig = host.rig, E = HeadRig.frameOf(rig), H = rig.head, C = rig.face, S = rigDisplay(host, evals);
  const SL = (lx, ly, m) => S(...HeadRig.fromLocal(E, lx, ly), m);
  const path = (pts, dash, color, w = 1) => { g.beginPath(); pts.forEach((q, i) => i ? g.lineTo(...q) : g.moveTo(...q)); g.setLineDash(dash); g.strokeStyle = color; g.lineWidth = w; g.stroke(); g.setLineDash([]); };
  const vt = -H.t, vc = C.chin, N = 72;
  // 頭範圍（黃虛線，左右寬可不同）
  path([...Array(N + 1)].map((_, i) => { const a = i / N * TAU, c = Math.cos(a); return SL(c * (c < 0 ? H.l : H.r), Math.sin(a) * H.t); }), [6, 4], 'rgba(250,204,21,.85)', 1.5);
  // 臉範圍（白虛線）：兩側臉邊緣往下繞過下巴
  const top = vt * 0.45, face = [SL(-C.l, top)];
  for (let i = 0; i <= 36; i++) { const a = Math.PI - i / 36 * Math.PI, c = Math.cos(a); face.push(SL(c * (c < 0 ? C.l : C.r), Math.max(0, Math.sin(a) * C.chin))); }
  face.push(SL(C.r, top));
  path(face, [4, 3], 'rgba(255,255,255,.8)', 1.2);
  // 中線（頭頂 → 下巴）與眼線
  path([...Array(21)].map((_, i) => SL(0, vt + (vc - vt) * i / 20)), [], 'rgba(255,255,255,.9)', 1.5);
  const eL = HeadRig.feature(rig, 'eye', 'L'), eR = HeadRig.feature(rig, 'eye', 'R');
  if (eL && eR) path([S(...eL.marker, eL), S(...eR.marker, eR)], [2, 3], 'rgba(255,255,255,.6)');
  // 五官範圍
  for (const m of rig.members) if (m.marker && HeadRig.ROLES[m.role]?.feature) {
    const [cx, cy] = HeadRig.toLocal(E, ...m.marker), I = HeadRig.sizeOf(m), O = HeadRig.outerOf(m), on = D.ui.rigSel === m.id;
    const ell = R => [...Array(49)].map((_, i) => { const a = i / 48 * TAU; return SL(cx + Math.cos(a) * R[0], cy + Math.sin(a) * R[1], m); });
    path(ell(I), [], on ? '#fff' : 'rgba(244,114,182,.8)', on ? 1.5 : 1);
    path(ell(O), [3, 3], on ? 'rgba(255,255,255,.7)' : 'rgba(244,114,182,.35)');
  }
  const LAB = { c: '中心', hl: '頭寬', hr: '頭寬', ht: '頭頂', fl: '臉寬', fr: '臉寬', fc: '下巴', sw: '寬', sh: '高' };
  g.font = '600 11px system-ui'; g.textBaseline = 'middle';
  for (const h of rigHandles(host)) {
    const q = S(...h.p, h.m), on = h.m && D.ui.rigSel === h.m.id;
    g.beginPath();
    if (h.k === 'mk') g.arc(q[0], q[1], on ? 6 : 5, 0, TAU); else g.rect(q[0] - 5, q[1] - 5, 10, 10);
    g.fillStyle = h.k === 'mk' ? (on ? '#fff' : '#f472b6') : h.k[0] === 'h' || h.k === 'c' ? '#facc15' : '#fff';
    g.fill(); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1; g.stroke();
    const lab = h.k === 'mk' ? featName(h.m) : LAB[h.k];
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(lab, q[0] + 9, q[1]); g.fillStyle = '#fff'; g.fillText(lab, q[0] + 9, q[1]);
  }
  g.textBaseline = 'alphabetic';
}
// 拖曳：畫面上的位移直接加到靜止位置（試轉中也能正確調整）
function rigPointerDown(mx, my, x, y) {
  const host = rigEditHost();
  if (!host || D.ui.mode !== 'edit' || !rigShow) return null;
  const S = rigDisplay(host, lastDraw && lastDraw.evals), hs = rigHandles(host);
  // 後畫的在上面：範圍把手 > 五官 > 頭 / 臉
  const h = hs.slice().reverse().find(h => { const q = S(...h.p, h.m); return Math.hypot(q[0] - mx, q[1] - my) < 9; });
  if (!h) return null;
  if (h.m && D.ui.rigSel !== h.m.id) { D.ui.rigSel = h.m.id; renderParams(); }
  return { type: 'rig', h, host, sx: x, sy: y, axis: { ...host.rig.axis } };
}
function rigPointerMove(d, x, y) {
  const rig = d.host.rig, h = d.h, E = HeadRig.frameOf(rig), H = rig.head, C = rig.face;
  const p = [h.p[0] + x - d.sx, h.p[1] + y - d.sy], [lx, ly] = HeadRig.toLocal(E, ...p);
  const m = h.m && rig.members.find(q => q.id === h.m.id);
  if (h.k === 'c') rig.axis = { ...d.axis, cx: Math.round(d.axis.cx + x - d.sx), cy: Math.round(d.axis.cy + y - d.sy) };
  else if (h.k === 'ht') {
    // 頭頂：距離 = 頭頂高度，方向 = 中線方向（歪頭）
    const vx = p[0] - rig.axis.cx, vy = p[1] - rig.axis.cy;
    H.t = Math.max(10, Math.round(Math.hypot(vx, vy)));
    rig.axis = { ...rig.axis, tilt: +Math.max(-45, Math.min(45, Math.atan2(vx, -vy) / DEG)).toFixed(1) };
  }
  else if (h.k === 'mk') m.marker = p.map(Math.round);
  else if (h.k === 'sw' || h.k === 'sh') {
    const [cx, cy] = HeadRig.toLocal(E, ...m.marker), i = h.k === 'sw' ? 0 : 1, v = Math.max(3, Math.round(Math.abs(i ? ly - cy : lx - cx)));
    m.size = m.size || [20, 20]; m.size[i] = v;
    const pt = rig.sync && featPartner(rig, m);
    if (pt) { pt.size = pt.size || [20, 20]; pt.size[i] = v; }
  }
  else if (h.k === 'hl') H.l = Math.max(C.l + 4, Math.round(-lx));
  else if (h.k === 'hr') H.r = Math.max(C.r + 4, Math.round(lx));
  else if (h.k === 'fl') C.l = Math.max(4, Math.min(H.l - 4, Math.round(-lx)));
  else if (h.k === 'fr') C.r = Math.max(4, Math.min(H.r - 4, Math.round(lx)));
  else if (h.k === 'fc') C.chin = Math.max(10, Math.round(ly));
}

// ---------- 裁切工具 ----------
// 進入時顯示整張圖（暫時取消裁切），裁切框外變暗；拖曳 8 個把手調整、框內拖曳移動；Enter / 套用 確定，Esc / 取消 還原
function startCrop() {
  const n = sel();
  if (!n || n.type !== 'image' || tool.cropTarget === 'canvas') {
    D.ui.crop = { canvas: true, r: { x0: 0, y0: 0, x1: D.data.width, y1: D.data.height } };
    return;
  }
  const a = D.assets.get(n.image.assetId);
  const r = n.image.crop ? { ...n.image.crop } : { x0: 0, y0: 0, x1: a.w, y1: a.h };
  D.ui.crop = { id: n.id, orig: n.image.crop ? { ...n.image.crop } : null, r };
  n.image.crop = null;
}
function endCrop(apply) {
  const c = D && D.ui.crop;
  if (!c) return;
  D.ui.crop = null;
  if (c.canvas) {
    const r = c.r;
    if (apply) resizeCanvas(Math.round(r.x1 - r.x0), Math.round(r.y1 - r.y0), 'tl', -Math.round(r.x0), -Math.round(r.y0));
    renderToolDetail(); renderStatus();
    return;
  }
  const n = node(c.id);
  if (n) {
    const a = D.assets.get(n.image.assetId), r = c.r;
    const full = r.x0 <= 0 && r.y0 <= 0 && r.x1 >= a.w && r.y1 >= a.h;
    n.image.crop = apply ? (full ? null : { x0: Math.round(r.x0), y0: Math.round(r.y0), x1: Math.round(r.x1), y1: Math.round(r.y1) }) : c.orig;
    if (apply) commit();
  }
  renderToolDetail(); renderStatus();
}
function cropGeom() {
  const c = D && D.ui.crop;
  if (!c) return null;
  const n = c.canvas ? null : node(c.id);
  if (!c.canvas && !n) return null;
  const a = c.canvas ? null : D.assets.get(n.image.assetId), T = c.canvas ? viewAffine() : aMul(viewAffine(), layerAffine(n.image, a)), r = c.r;
  const P = (x, y) => aApply(T, x, y);
  const mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2;
  const handles = [['nw', r.x0, r.y0], ['n', mx, r.y0], ['ne', r.x1, r.y0], ['e', r.x1, my], ['se', r.x1, r.y1], ['s', mx, r.y1], ['sw', r.x0, r.y1], ['w', r.x0, my]].map(([k, x, y]) => [k, ...P(x, y)]);
  return { n, a, T, r, P, handles };
}
function drawCrop(g) {
  const G = cropGeom();
  if (!G) return;
  const { a, P, r, handles } = G, dpr = view.dpr;
  // 框外變暗（圖層：整張圖範圍內；畫布：整個預覽區）
  const full = a ? [P(0, 0), P(a.w, 0), P(a.w, a.h), P(0, a.h)] : [[0, 0], [view.cw, 0], [view.cw, view.ch], [0, view.ch]], box = [P(r.x0, r.y0), P(r.x1, r.y0), P(r.x1, r.y1), P(r.x0, r.y1)];
  g.beginPath();
  full.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath();
  box.slice().reverse().forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath();
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fill();
  // 框與三等分線
  g.beginPath(); box.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath();
  g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
  g.beginPath();
  for (const f of [1 / 3, 2 / 3]) {
    const xa = P(r.x0 + (r.x1 - r.x0) * f, r.y0), xb = P(r.x0 + (r.x1 - r.x0) * f, r.y1);
    const ya = P(r.x0, r.y0 + (r.y1 - r.y0) * f), yb = P(r.x1, r.y0 + (r.y1 - r.y0) * f);
    g.moveTo(...xa); g.lineTo(...xb); g.moveTo(...ya); g.lineTo(...yb);
  }
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.stroke();
  for (const [k, x, y] of handles) {
    g.beginPath();
    if (k.length === 2) g.rect(x - 5, y - 5, 10, 10); else g.rect(x - 4, y - 4, 8, 8);
    g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#1a1a1a'; g.lineWidth = 1; g.stroke();
  }
  void dpr;
}
function cropPointerDown(mx, my) {
  const G = cropGeom();
  if (!G) return null;
  const h = G.handles.find(([, x, y]) => Math.hypot(x - mx, y - my) < 10);
  const Ti = aInv(G.T), [lx, ly] = aApply(Ti, mx, my), r = G.r;
  if (h) return { type: 'crop', k: h[0], Ti, r0: { ...r }, sx: lx, sy: ly, a: G.a };
  if (lx >= r.x0 && lx <= r.x1 && ly >= r.y0 && ly <= r.y1) return { type: 'crop', k: 'move', Ti, r0: { ...r }, sx: lx, sy: ly, a: G.a };
  // 框外拖曳 = 直接框選新範圍（圖層裁切會限制在圖內）
  return { type: 'crop', k: 'new', Ti, r0: { ...r }, sx: lx, sy: ly, a: G.a };
}
function cropPointerMove(d, mx, my) {
  const c = D.ui.crop, [lx, ly] = aApply(d.Ti, mx, my), dx = lx - d.sx, dy = ly - d.sy, r0 = d.r0, r = { ...r0 };
  // 畫布可以往外拉（加大）；圖層裁切限制在圖內
  const a = d.a || { w: Infinity, h: Infinity }, lo = d.a ? 0 : -Infinity, MIN = d.a ? 4 : 16;
  if (d.k === 'new') {
    const cl = (v, m) => d.a ? Math.max(0, Math.min(m, v)) : v;
    const xa = cl(d.sx, a.w), xb = cl(lx, a.w), ya = cl(d.sy, a.h), yb = cl(ly, a.h);
    if (Math.abs(xb - xa) < MIN || Math.abs(yb - ya) < MIN) return;
    r.x0 = Math.round(Math.min(xa, xb)); r.x1 = Math.round(Math.max(xa, xb)); r.y0 = Math.round(Math.min(ya, yb)); r.y1 = Math.round(Math.max(ya, yb));
  } else if (d.k === 'move' && !d.a) {
    const w = r0.x1 - r0.x0, h = r0.y1 - r0.y0;
    r.x0 = Math.round(r0.x0 + dx); r.y0 = Math.round(r0.y0 + dy); r.x1 = r.x0 + w; r.y1 = r.y0 + h;
  } else if (d.k === 'move') {
    const w = r0.x1 - r0.x0, h = r0.y1 - r0.y0;
    r.x0 = Math.max(0, Math.min(a.w - w, r0.x0 + dx)); r.y0 = Math.max(0, Math.min(a.h - h, r0.y0 + dy));
    r.x1 = r.x0 + w; r.y1 = r.y0 + h;
  } else {
    if (d.k.includes('w')) r.x0 = Math.round(Math.max(lo, Math.min(r0.x1 - MIN, r0.x0 + dx)));
    if (d.k.includes('e')) r.x1 = Math.round(Math.min(a.w, Math.max(r0.x0 + MIN, r0.x1 + dx)));
    if (d.k.includes('n')) r.y0 = Math.round(Math.max(lo, Math.min(r0.y1 - MIN, r0.y0 + dy)));
    if (d.k.includes('s')) r.y1 = Math.round(Math.min(a.h, Math.max(r0.y0 + MIN, r0.y1 + dy)));
  }
  c.r = r;
  renderCropValues();
}
function renderCropDetail(box) {
  const c = D.ui.crop;
  if (!c) return;
  const img = sel() && sel().type === 'image';
  if (img) box.append(field('對象', seg([['layer', '圖層'], ['canvas', '畫布']], () => c.canvas ? 'canvas' : 'layer', v => {
    endCrop(false); tool.cropTarget = v; startCrop(); renderToolDetail();
  })));
  else box.append(el('span', { class: 'note', style: 'flex:none' }, '畫布'));
  box.append(el('span', { class: 'note', id: 'cropInfo' }),
    el('div', { class: 'btnrow' },
      el('button', { class: 'btn primary', onclick: () => { endCrop(true); setTool('select'); } }, '套用 (Enter)'),
      el('button', { class: 'btn', onclick: () => { endCrop(false); setTool('select'); } }, '取消 (Esc)'),
      el('button', { class: 'btn', onclick: () => {
        if (c.canvas) { const b = opaqueBounds(D); if (b) { const pad = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.04); c.r = { x0: Math.floor(b.x0 - pad), y0: Math.floor(b.y0 - pad), x1: Math.ceil(b.x1 + pad), y1: Math.ceil(b.y1 + pad) }; } }
        else { const a = D.assets.get(node(c.id).image.assetId); c.r = { x0: 0, y0: 0, x1: a.w, y1: a.h }; }
        renderCropValues();
      } }, c.canvas ? '貼齊內容' : '重設為整張')));
  renderCropValues();
}
function renderCropValues() {
  const i = $('#cropInfo'), c = D && D.ui.crop;
  if (i && c) i.textContent = `${Math.round(c.r.x1 - c.r.x0)} × ${Math.round(c.r.y1 - c.r.y0)} px` + (c.canvas ? '' : `（左上 ${Math.round(c.r.x0)}, ${Math.round(c.r.y0)}）`);
}

// ---------- 工具詳細橫條 ----------
function renderStrip() {
  $('#toolStrip').classList.toggle('hidden', !!tool.stripHidden);
}

// ---------- 試轉拉桿（預覽畫面下方 / 右方）----------
function renderProbe() {
  const on = !!(D && D.data.p3d?.enabled);
  const pr = D ? (D.ui.probe || (D.ui.probe = { yaw: 0, pitch: 0 })) : null;
  for (const [id, k] of [['#probeH', 'yaw'], ['#probeV', 'pitch']]) {
    const box = $(id), inp = box.querySelector('input');
    box.classList.toggle('hidden', !on);
    if (pr && document.activeElement !== inp) inp.value = pr[k];
    box.classList.toggle('on', !!(pr && pr[k]));
  }
}
function setupProbe() {
  for (const [id, k] of [['#probeH', 'yaw'], ['#probeV', 'pitch']]) {
    const box = $(id), inp = box.querySelector('input');
    inp.addEventListener('input', () => {
      if (!D) return;
      const pr = D.ui.probe || (D.ui.probe = { yaw: 0, pitch: 0 });
      delete pr.abs;
      pr[k] = Math.abs(+inp.value) < 0.03 ? 0 : +inp.value;
      if (D.ui.mode !== 'edit') setMode('edit');
      box.classList.toggle('on', !!pr[k]);
    });
    inp.addEventListener('dblclick', () => { if (!D) return; D.ui.probe[k] = 0; inp.value = 0; box.classList.remove('on'); });
  }
}

// ---------- 時間軸（關鍵影格）----------
// 變換軌道（每個部位 / 圖層都有）；參數軌道 p.<參數> 由右側拉桿旁的 ◆ 建立
// 預覽（動畫）模式：改數值 = 在播放頭打影格；編輯（設置）模式：改的是靜止值
const TRACKS = [
  ['tx', '位移 X', 'px'], ['ty', '位移 Y', 'px'], ['rot', '旋轉', '度，以支點為軸；可超過一圈'],
  ['sc', '縮放', '%，以支點為軸（上下左右一起）'], ['op', '透明度', '0 … 1'],
  ['flip', '翻轉', '度，以支點為軸（像翻書頁）'], ['z', '前後', '圖層順序加減；例如 -15 = 往後移到下一層後面'],
];
const CURVE_LABEL = { smooth: '平滑（經過影格不停頓）', ease: '緩動（每格都停一下）', linear: '線性', in: '緩入（慢 → 快）', out: '緩出（快 → 慢）', hold: '保持（跳到下一格）' };
const PARAM_META = {};   // 右側參數拉桿登記：參數名 → { label, min, max, step, dec }
let timelineOn = false, tlDrag = null;
const curU = () => D ? Anim.mod(D.ui.frame, total()) / total() : 0;
// 影格位置存成循環的 1/64 格（qU）；顯示與判斷都對齊到最近的一幀（fU）
const qU = u => { const g = 64 * Model.cyclesOf(D.data); return (Math.round(u * g) % g + g) % g / g; };
const fOf = u => Math.round(u * total()) % Math.max(1, Math.round(total()));
const fU = u => Model.snapU(D.data, u);
const keyAt = (ks, u) => ks ? ks.findIndex(k => fOf(k[0]) === fOf(u)) : -1;
// 連動：位移 X / Y 與旋轉一起加、一起刪、一起移動；縮放 X / Y 也綁在一起
const KEY_LINKS = { tx: ['tx', 'ty', 'rot'], ty: ['tx', 'ty', 'rot'], rot: ['tx', 'ty', 'rot'], sx: ['sx', 'sy'], sy: ['sx', 'sy'] };
const TRACK_SCALE = { sc: 100 };   // 顯示倍數（縮放用百分比）
function setKey(n, tr, u, v) {
  n.keys = n.keys || {};
  u = qU(u);
  // 連動的軌道在同一時間沒有影格：用那一刻的值補一格（動作不變）
  for (const t2 of KEY_LINKS[tr] || []) {
    if (t2 === tr || keyAt(n.keys[t2], u) >= 0) continue;
    const val = Model.keyVal(D.data, n, t2, u * total());
    (n.keys[t2] || (n.keys[t2] = [])).push([u, val, 'smooth']);
    n.keys[t2].sort((a, b) => a[0] - b[0]);
  }
  const ks = n.keys[tr] || (n.keys[tr] = []);
  const i = keyAt(ks, u);
  if (i >= 0) ks[i][1] = v; else ks.push([u, v, 'smooth']);
  ks.sort((a, b) => a[0] - b[0]);
  // 沒有支點的圖層：旋轉 / 縮放 / 翻轉以第一次打影格時的圖層中心為軸
  if (['rot', 'sc', 'sx', 'sy', 'flip'].includes(tr) && !n.pins.length && !n.keyPivot) n.keyPivot = keyPivotOf(n);
}
function delKey(n, tr, i) {
  const ks = n.keys && n.keys[tr];
  if (!ks || !ks[i]) return;
  const u = ks[i][0];
  ks.splice(i, 1);
  if (!ks.length) delete n.keys[tr];
  for (const t2 of KEY_LINKS[tr] || []) {
    const j = keyAt(n.keys[t2], u);
    if (t2 !== tr && j >= 0) { n.keys[t2].splice(j, 1); if (!n.keys[t2].length) delete n.keys[t2]; }
  }
}
function keyPivotOf(n) {
  if (n.pins[0]) return n.pins[0];
  if (n.keyPivot) return n.keyPivot;
  const b = nodeBounds(n);
  return { x: Math.round((b.x0 + b.x1) / 2), y: Math.round((b.y0 + b.y1) / 2) };
}
// 拖拉桿 / 把手時先暫停、放開後繼續播放：影格落在按下的那一刻，不會一路打一串
let holdResume = false;
function holdPlay() { if (D && D.ui.playing) { D.ui.playing = false; holdResume = true; updatePlaybar(); } }
function releasePlay() { if (holdResume && D) { D.ui.playing = true; updatePlaybar(); } holdResume = false; }
// 有影格的參數拉桿：跟著播放頭更新數值與 ◆
function refreshKeyedRows() { document.querySelectorAll('.prow[data-pk]').forEach(r => r._kupd && r._kupd()); }

// 循環數：增加時把最後一個循環裡的影格照原節奏複製到新的循環；減少時刪掉最後一個循環裡的影格（其餘時間不變）
function setCycles(nc) {
  const C = Model.cyclesOf(D.data);
  nc = Math.max(1, Math.min(16, nc));
  if (nc === C) return;
  for (const n of D.data.nodes) {
    if (!n.keys) continue;
    for (const tr in n.keys) {
      const abs = n.keys[tr].map(k => [k[0] * C, ...k.slice(1)]);   // 以「循環」為單位的時間（其他欄位照舊：曲線、眨眼樣式與長度）
      let out;
      if (nc > C) {
        const last = abs.filter(k => k[0] >= C - 1);
        out = [...abs];
        for (let c = C; c < nc; c++) for (const k of last) out.push([k[0] + (c - C + 1), ...k.slice(1)]);
      } else out = abs.filter(k => k[0] < nc - 1e-9);
      n.keys[tr] = out.map(k => [k[0] / nc, ...k.slice(1)]).sort((a, b) => a[0] - b[0]);
      if (!n.keys[tr].length) delete n.keys[tr];
    }
  }
  const ph = D.ui.frame / Model.master(D.data);
  D.data.timeline.cycles = nc;
  D.ui.frame = Math.min(ph, nc - 1e-6) * Model.master(D.data);
  tlSel = [];
  commit(); renderTimeline(); updatePlaybar();
}
function toggleTimeline(on = !timelineOn) {
  timelineOn = on;
  try { const w = localStorage.getItem('tan.tlL'); if (w) $('#timeline').style.setProperty('--tlL', w); } catch (_) { /* ignore */ }
  if (D) $('#timeline').style.setProperty('--tlZ', D.data.timeline.zoom || 1);
  $('#timeline').classList.toggle('hidden', !on);
  $('#layout').classList.toggle('tlon', on);
  $('#btnTimeline').classList.toggle('on', on);
  if (on && D && D.ui.mode !== 'preview') setMode('preview');
  resize();
  renderTimeline();
}
function trackRange(n, tr) {
  const W = D.data.width, H = D.data.height;
  const R = { tx: [-Math.round(W / 2), Math.round(W / 2), 1, 0], ty: [-Math.round(H / 2), Math.round(H / 2), 1, 0], rot: [-360, 360, 1, 0], sc: [0.2, 3, 0.01, 0], sx: [0.2, 3, 0.01, 2], sy: [0.2, 3, 0.01, 2], flip: [-180, 180, 1, 0], z: [-50, 50, 1, 0], op: [0, 1, 0.01, 2] };
  if (R[tr]) return R[tr];
  const m = PARAM_META[tr.slice(2)] || {}, rest = n.params[tr.slice(2)] || 0;
  return [m.min ?? rest - 1, m.max ?? rest + 1, m.step ?? 0.01, m.dec ?? 2];
}
// 縮放拉桿：中間 = 剛好放滿；左半邊縮小到 0.5 倍、右半邊放大到 8 倍
const zToS = z => z < 1 ? Math.log2(z) : Math.log(z) / Math.log(8);
const sToZ = s => s < 0 ? Math.pow(2, s) : Math.pow(8, s);
// 選取的影格（可框選多個；拖曳一起移動、Delete 一起刪）：[{ tr, k }]
let tlSel = [], tlSelId = null;
const tlKeyEls = new Map();
const inSel = k => tlSel.some(s => s.k === k);
// 這一格 ＋ 同一時間的連動影格
function linkedAt(n, tr, k) {
  const out = [{ tr, k }];
  for (const t2 of KEY_LINKS[tr] || []) { const j = t2 === tr ? -1 : keyAt(n.keys?.[t2], k[0]); if (j >= 0) out.push({ tr: t2, k: n.keys[t2][j] }); }
  return out;
}
function deleteTlSel() {
  const n = node(tlSelId);
  if (!n || !n.keys) return;
  for (const { tr, k } of tlSel) { const ks = n.keys[tr], i = ks ? ks.indexOf(k) : -1; if (i >= 0) { ks.splice(i, 1); if (!ks.length) delete n.keys[tr]; } }
  tlSel = [];
  commit(); renderTimeline(); refreshKeyedRows();
}
function renderTimeline() {
  const box = $('#timeline');
  if (!timelineOn) return;
  box.innerHTML = '';
  if (!D) return;
  const n = sel();
  if (!n || n.id !== tlSelId) { tlSel = []; tlSelId = n ? n.id : null; }
  const TL0 = D.data.timeline, cyc = Model.cyclesOf(D.data);
  const applyZoom = () => { $('#timeline').style.setProperty('--tlZ', TL0.zoom || 1); updateTimelineHead(); };
  const zoom = el('input', { type: 'range', class: 'tlzoom', min: -1, max: 1, step: 0.01, value: zToS(TL0.zoom || 1), title: '橫向縮放：中間 = 剛好放滿（雙擊回到中間；也可以按住 Ctrl 滾輪）' });
  zoom.addEventListener('input', () => { TL0.zoom = sToZ(+zoom.value); applyZoom(); });
  zoom.addEventListener('dblclick', () => { TL0.zoom = 1; zoom.value = 0; applyZoom(); });
  const head = el('div', { class: 'tlhead' },
    el('span', { class: 'tlcyc', title: '時間軸長度：加一個循環時，最後一個循環的影格照原節奏複製過去' },
      el('button', { class: 'tb', disabled: cyc > 1 ? null : 'disabled', onclick: () => setCycles(cyc - 1) }, '−'),
      el('span', {}, `${cyc} 個循環`),
      el('button', { class: 'tb', onclick: () => setCycles(cyc + 1) }, '+')));
  if (n && n.type !== 'root') {
    const curveAll = el('select', { title: '這個部位所有影格的曲線' }, el('option', { value: '' }, '全部曲線…'), ...Model.CURVES.map(c => el('option', { value: c }, CURVE_LABEL[c].replace(/（.*/, ''))));
    curveAll.addEventListener('change', () => { const c = curveAll.value; if (!c) return; for (const tr in n.keys || {}) if (tr !== 'blink') for (const k of n.keys[tr]) k[2] = c; commit(); renderTimeline(); });
    head.append(curveAll);
  }
  head.append(...D.data.nodes.filter(Model.hasKeys).map(k => el('span', { class: 'chip' + (n && k.id === n.id ? ' on' : ''), title: '有關鍵影格的部位 / 圖層', onclick: () => selectNode(k.id, false) }, k.name)), el('span', { class: 'grow' }));
  if (n) head.append(el('button', { class: 'btn', title: '刪除這個部位 / 圖層的所有關鍵影格（含眨眼）', onclick: () => { n.keys = {}; tlSel = []; commit(); renderTimeline(); renderParams(); } }, '全部清除'));
  box.append(head);
  if (!n) { box.append(el('div', { class: 'tlempty' }, '選取部位或圖層'), zoom); return; }
  const body = el('div', { class: 'tlbody' });
  // 刻度：每個循環 32 格（= 延遲單位 1/32 循環），每 8 格一條粗線，循環交界最粗
  const ticks = lane => { for (let i = 0; i <= 32 * cyc; i++) lane.append(el('i', { class: 'tick' + (i % 32 === 0 && i ? ' cycle' : i % 8 ? '' : ' major'), style: `left:${i / (32 * cyc) * 100}%` })); };
  const ruler = el('div', { class: 'tllane', title: '拖曳移動播放頭' });
  ticks(ruler);
  for (let c = 0; c < cyc; c++) {
    ruler.append(el('span', { class: 'tlabel' + (c ? ' cyc' : ''), style: `left:${c / cyc * 100}%` }, cyc > 1 ? `循環 ${c + 1}` : '0'));
    if (cyc === 1) for (const [i, t] of [[8, '1/4'], [16, '1/2'], [24, '3/4']]) ruler.append(el('span', { class: 'tlabel', style: `left:${i / 32 * 100}%` }, t));
  }
  // 時間尺：按住左右拖 = 拉播放頭
  ruler.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { ruler.setPointerCapture(e.pointerId); } catch (_) { /* 沒有實體指標時略過 */ }
    laneSeek(e, ruler);
    const mv = ev => laneSeek(ev, ruler), up = () => { ruler.removeEventListener('pointermove', mv); ruler.removeEventListener('pointerup', up); };
    ruler.addEventListener('pointermove', mv); ruler.addEventListener('pointerup', up);
  });
  // 左欄寬度：拖曳時間尺左邊的分隔線調整（記住）
  const grip = el('div', { class: 'tlgrip', title: '拖曳調整左欄寬度' });
  grip.addEventListener('pointerdown', e => {
    e.preventDefault(); try { grip.setPointerCapture(e.pointerId); } catch (_) { /* 沒有實體指標時略過 */ }
    const tl = $('#timeline'), x0 = e.clientX, w0 = body.querySelector('.tlcell').getBoundingClientRect().width;
    const move = ev => { const w = Math.max(140, Math.min(tl.getBoundingClientRect().width - 160, w0 + ev.clientX - x0)); tl.style.setProperty('--tlL', w + 'px'); updateTimelineHead(); };
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); try { localStorage.setItem('tan.tlL', tl.style.getPropertyValue('--tlL')); } catch (_) { /* ignore */ } };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
  });
  body.append(el('div', { class: 'tlrow ruler' }, el('div', { class: 'tlcell' }, grip), ruler));
  // 列：差分（橫條）→ 眨眼（橫條）→ 變換軌道 → 參數軌道
  const drawable = Model.isDrawable(n), rows = [];
  if (n.type === 'image') for (const v of n.image.variants) rows.push(['v:' + v.id, v.name, '差分：◆ 或雙擊空白加一段；拖曳移動、拖兩端調長度、雙擊刪除、右鍵換切換方式']);
  if (n.type === 'image' && n.blink && n.blink.on) rows.push(['blink', '眨眼', '◆ 或雙擊空白加一次眨眼（慢眨）；拖曳移動、拖右端調長短、雙擊刪除、右鍵換樣式']);
  if (n.type !== 'root') for (const [tr, label, tip] of TRACKS) if (drawable || (tr !== 'z' && tr !== 'op')) rows.push([tr, label, tip]);
  for (const [tr, label] of [['sx', '縮放 X'], ['sy', '縮放 Y']]) if (n.keys?.[tr]?.length) rows.push([tr, label, '舊檔的單軸縮放（倍率）']);
  for (const tr of Object.keys(n.keys || {}).filter(t => t.startsWith('p.')).sort()) rows.push([tr, PARAM_META[tr.slice(2)]?.label || tr.slice(2), '參數：靜止值 + 影格差量']);
  if (!rows.length) body.append(el('div', { class: 'tlempty' }, '整體沒有變換軌道；在右側參數拉桿旁按 ◆ 就能替參數打影格。'));
  for (const [tr, label, tip] of rows) {
    const lane = el('div', { class: 'tllane', 'data-lane': tr, title: tr.startsWith('v:') || tr === 'blink' ? tip : '雙擊新增 / 刪除影格；在空白處拖曳可以框選多個' });
    ticks(lane);
    lane.addEventListener('pointerdown', e => tlLaneDown(e, lane, n));

    if (tr.startsWith('v:') || tr === 'blink') {
      const has = tr === 'blink' ? !!n.keys?.blink?.length : true;
      const v = tr !== 'blink' && n.image.variants.find(x => 'v:' + x.id === tr);
      const kb = el('button', { class: 'tlkey', 'data-kb': tr, title: tr === 'blink' ? '在播放頭加一次眨眼（慢眨）；播放頭在眨眼上 = 刪除' : '在播放頭加一段差分；播放頭在某一段裡 = 刪除那一段' }, '◆');
      kb.addEventListener('click', () => {
        if (tr === 'blink') { addBlinkAt(n, curU()); return; }
        addVarSeg(v, fOf(curU())); commit(); renderTimeline();
      });
      body.append(el('div', { class: 'tlrow barrow' + (has ? ' has' : '') }, el('div', { class: 'tlcell', title: tip }, el('div', { class: 'prow' }, el('label', {}, label)), kb), lane));
      continue;
    }
    const isP = tr.startsWith('p.'), pk = tr.slice(2), rest = () => isP ? n.params[pk] || 0 : 0;
    const kb = el('button', { class: 'tlkey', 'data-kb': tr, title: '加入 / 刪除這個時間點的關鍵影格' }, '◆');
    kb.addEventListener('click', () => {
      const i = keyAt(n.keys?.[tr], curU());
      if (i >= 0) delKey(n, tr, i); else setKey(n, tr, curU(), Model.keyVal(D.data, n, tr, D.ui.frame));
      commit(); renderTimeline(); refreshKeyedRows();
    });
    const [mn, mx, st, dec] = trackRange(n, tr);
    const bar = slider(label, () => rest() + Model.keyVal(D.data, n, tr, D.ui.frame), v => { setKey(n, tr, curU(), v - rest()); kb.classList.add('on'); },
      { min: mn, max: mx, step: st, dec, scale: TRACK_SCALE[tr] || 1, noLive: true, hold: true, after: () => { renderTimelineKeys(n); refreshKeyedRows(); }, tip });
    bar.dataset.tr = tr;
    body.append(el('div', { class: 'tlrow' + (n.keys?.[tr]?.length ? ' has' : '') }, el('div', { class: 'tlcell' }, bar, kb), lane));
  }
  body.append(el('div', { class: 'tlhead-line', id: 'tlHead' }));
  body.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    TL0.zoom = Math.max(0.5, Math.min(8, (TL0.zoom || 1) * Math.exp(-e.deltaY * 0.002)));
    zoom.value = zToS(TL0.zoom); applyZoom();
  }, { passive: false });
  body.addEventListener('scroll', updateTimelineHead);
  box.append(body, zoom);
  renderTimelineKeys(n);
  updateTimelineHead();
}
const laneU = (e, lane) => { const r = lane.getBoundingClientRect(), M = Math.round(total()); return Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * M) % M / M; };
// 空白處：點 = 移動播放頭；拖 = 框選影格
function tlLaneDown(e, lane, n) {
  if (e.button !== 0 || e.target.closest('.kf, .kbar')) return;
  { const key = lane.dataset.lane + '@' + fOf(laneU(e, lane)); if (tlDouble(key)) { tlLaneDbl(e, lane, lane.dataset.lane, n); return; } }
  const body = lane.closest('.tlbody'), x0 = e.clientX, y0 = e.clientY;
  let box = null;
  const move = ev => {
    if (!box && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    const br = body.getBoundingClientRect();
    if (!box) { box = el('div', { class: 'tlmarq' }); body.append(box); }
    const l = Math.min(x0, ev.clientX), t = Math.min(y0, ev.clientY);
    box.style.left = `${l - br.left + body.scrollLeft}px`; box.style.top = `${t - br.top + body.scrollTop}px`;
    box.style.width = `${Math.abs(ev.clientX - x0)}px`; box.style.height = `${Math.abs(ev.clientY - y0)}px`;
  };
  const up = ev => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (!box) { tlSel = []; laneSeek(ev, lane); renderTimelineKeys(n); return; }
    const r = box.getBoundingClientRect();
    box.remove();
    const picked = [];
    for (const [k, info] of tlKeyEls) {
      const q = info.el.getBoundingClientRect();
      if (q.right >= r.left && q.left <= r.right && q.bottom >= r.top && q.top <= r.bottom) picked.push(...(info.tr === 'blink' ? [{ tr: 'blink', k }] : linkedAt(n, info.tr, k)));
    }
    tlSel = picked.filter((p, i) => picked.findIndex(q => q.k === p.k) === i);
    renderTimelineKeys(n);
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
// 雙擊空白：在那個時間加影格（眨眼列 = 加一次眨眼）
function tlLaneDbl(e, lane, tr, n) {
  if (e.target.closest('.kf, .kbar')) return;
  const u = laneU(e, lane);
  if (tr.startsWith('v:')) {
    const v = n.image.variants.find(x => 'v:' + x.id === tr);
    if (v) addVarSeg(v, fOf(u));
  } else if (tr === 'blink') {
    n.keys = n.keys || {};
    (n.keys.blink || (n.keys.blink = [])).push([qU(u), 1, 'slow', Blink.STYLES.slow.def]);
    n.keys.blink.sort((a, b) => a[0] - b[0]);
  } else if (keyAt(n.keys?.[tr], u) < 0) setKey(n, tr, u, Model.keyVal(D.data, n, tr, u * total()));
  tlSel = [];
  commit(); renderTimeline(); refreshKeyedRows();
}
let tlLastDown = null;
function tlDouble(obj) {
  const now = performance.now(), hit = tlLastDown && tlLastDown.obj === obj && now - tlLastDown.t < 400;
  tlLastDown = hit ? null : { obj, t: now };
  return hit;
}
// 拖曳選取的影格（一起左右移動）；沒移動 = 播放頭跳到這一格
function tlSelDrag(e, lane, n, k) {
  e.stopPropagation(); e.preventDefault();
  if (D.ui.mode !== 'preview') setMode('preview');
  const M = Math.round(total()), r = lane.getBoundingClientRect(), x0 = e.clientX;
  const items = tlSel.map(s => ({ ...s, f0: Math.round(s.k[0] * M) }));
  let moved = false;
  tlDrag = { n };
  const move = ev => {
    const dF = Math.round((ev.clientX - x0) / r.width * M);
    if (!dF && !moved) return;
    moved = true;
    for (const it of items) {
      it.k[0] = qU(Math.max(0, Math.min(M - 1, it.f0 + dF)) / M);
      const info = tlKeyEls.get(it.k); if (info) info.el.style.left = `${fU(it.k[0]) * 100}%`;
    }
    if (!D.ui.playing) { D.ui.frame = fOf(k[0]); updatePlaybar(); }
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    tlDrag = null;
    if (moved) { for (const tr of new Set(items.map(i => i.tr))) n.keys[tr].sort((a, b) => a[0] - b[0]); commit(); renderTimeline(); }
    else { if (!D.ui.playing) { D.ui.frame = fOf(k[0]); updatePlaybar(); } renderSelMarks(); updateTimelineHead(); }
    refreshKeyedRows();
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
// 各列上的影格 / 橫條
function renderTimelineKeys(n) {
  tlKeyEls.clear();
  const T = total(), M = Math.round(T);
  document.querySelectorAll('#timeline .tllane[data-lane]').forEach(lane => {
    lane.querySelectorAll('.kf, .kbar').forEach(k => k.remove());
    const tr = lane.dataset.lane;
    // ---- 差分：每一段一條橫條，拖曳移動、拖兩端調長度、雙擊刪除 ----
    if (tr.startsWith('v:')) {
      const v = n.image && n.image.variants.find(x => 'v:' + x.id === tr);
      if (!v) return;
      const segs = segsOf(v);
      segs.forEach(sg => {
        const lab = `${v.name} · ${VAR_MODES[v.mode || 'cut']}`;
        const bar = el('i', { class: 'kbar kvar m-' + (v.mode || 'cut'), style: `left:${sg[0] / T * 100}%;width:${Math.max(0.3, (sg[1] - sg[0]) / T * 100)}%`, title: `${lab}：第 ${sg[0]} – ${sg[1]} 幀（拖曳移動、拖兩端調長度、雙擊刪除、右鍵換切換方式）` },
          el('b', { class: 'h l' }), el('span', {}, lab), el('b', { class: 'h r' }));
        bar.addEventListener('pointerdown', e => {
          if (e.button !== 0) return;
          e.stopPropagation(); e.preventDefault();
          if (tlDouble(sg)) { segs.splice(segs.indexOf(sg), 1); commit(); renderTimelineKeys(n); return; }
          const r = lane.getBoundingClientRect(), x0 = e.clientX, f0 = sg[0], t0 = sg[1], which = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'm';
          // 不能跟前後的段重疊
          const others = segs.filter(x => x !== sg), lo = Math.max(0, ...others.map(x => x[1]).filter(b => b <= f0)), hi = Math.min(M, ...others.map(x => x[0]).filter(a => a >= t0));
          let moved = false;
          const move = ev => {
            const dF = Math.round((ev.clientX - x0) / r.width * M);
            if (which === 'l') sg[0] = Math.max(lo, Math.min(t0 - 1, f0 + dF));
            else if (which === 'r') sg[1] = Math.max(f0 + 1, Math.min(hi, t0 + dF));
            else { const d = Math.max(lo - f0, Math.min(hi - t0, dF)); sg[0] = f0 + d; sg[1] = t0 + d; }
            moved = moved || !!dF;
            bar.style.left = `${sg[0] / T * 100}%`; bar.style.width = `${(sg[1] - sg[0]) / T * 100}%`;
            if (!D.ui.playing) { D.ui.frame = which === 'r' ? sg[1] - 1 : sg[0]; updatePlaybar(); }
          };
          const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) { commit(); renderTimelineKeys(n); } };
          window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
        });
        bar.addEventListener('dblclick', e => e.stopPropagation());
        bar.addEventListener('contextmenu', e => {
          e.preventDefault(); e.stopPropagation();
          showMenu(e.clientX, e.clientY, [{ label: '切換方式' }, ...Object.entries(VAR_MODES).map(([m, t]) => ({ label: ((v.mode || 'cut') === m ? '✓ ' : '') + t, run: () => { v.mode = m; commit(); renderTimelineKeys(n); renderInspector(); } })),
            '-', { label: '刪除這一段', icon: 'trash', run: () => { segs.splice(segs.indexOf(sg), 1); commit(); renderTimelineKeys(n); } },
            { label: '刪除整個差分', icon: 'trash', run: () => { n.image.variants = n.image.variants.filter(x => x !== v); commit(); renderAll(); } }]);
        });
        lane.append(bar);
      });
      return;
    }
    const ks = n.keys && n.keys[tr];
    (ks || []).forEach(k => {
      // ---- 眨眼：橫條（長度 = 幀數，可在樣式範圍內拉長縮短）----
      if (tr === 'blink') {
        const st = Blink.styleOf(k[2]), S = Blink.STYLES[st], dur = Blink.clampDur(st, k[3]);
        const bar = el('i', { class: 'kbar kblink s-' + st + (inSel(k) ? ' sel' : ''), style: `left:${fU(k[0]) * 100}%;width:${dur / T * 100}%`, title: `眨眼 · ${S.label} · ${dur} 幀（${S.min} – ${S.max}）：拖曳移動、拖右端調長短、雙擊刪除、右鍵換樣式` },
          el('b', { class: 'h r' }));
        bar.addEventListener('pointerdown', e => {
          if (e.button !== 0) return;
          if (tlDouble(k)) { e.stopPropagation(); e.preventDefault(); ks.splice(ks.indexOf(k), 1); if (!ks.length) delete n.keys.blink; tlSel = []; commit(); renderTimeline(); return; }
          if (e.target.classList.contains('r')) {
            e.stopPropagation(); e.preventDefault();
            const r = lane.getBoundingClientRect(), x0 = e.clientX, d0 = dur;
            const move = ev => { k[3] = Blink.clampDur(st, d0 + Math.round((ev.clientX - x0) / r.width * M)); bar.style.width = `${k[3] / T * 100}%`; };
            const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); commit(); renderTimelineKeys(n); };
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
            return;
          }
          if (!inSel(k)) tlSel = [{ tr, k }];
          tlSelDrag(e, lane, n, k);
        });
        bar.addEventListener('dblclick', e => e.stopPropagation());
        bar.addEventListener('contextmenu', e => {
          e.preventDefault(); e.stopPropagation();
          showMenu(e.clientX, e.clientY, [{ label: '這次眨眼的樣式' },
            ...Object.entries(Blink.STYLES).map(([c, v]) => ({ label: (st === c ? '✓ ' : '') + `${v.label}（預設 ${v.def} 幀）`, run: () => { k[2] = c; k[3] = v.def; commit(); renderTimelineKeys(n); } })),
            '-', { label: '刪除這次眨眼', icon: 'trash', run: () => { ks.splice(ks.indexOf(k), 1); if (!ks.length) delete n.keys.blink; commit(); renderTimeline(); } }]);
        });
        tlKeyEls.set(k, { el: bar, tr });
        lane.append(bar);
        return;
      }
      // ---- 關鍵影格（◆ 平滑、■ 保持、▲ 其他）----
      const cv = tr === 'z' ? 'hold' : k[2] || 'ease';
      const kf = el('i', { class: `kf c-${cv}` + (inSel(k) ? ' sel' : ''), style: `left:${fU(k[0]) * 100}%`, title: `${+k[1].toFixed(3)} · ${CURVE_LABEL[cv].replace(/（.*/, '')}（拖曳移動、雙擊刪除、右鍵選曲線）` });
      kf.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        if (tlDouble(k)) { e.stopPropagation(); e.preventDefault(); delKey(n, tr, n.keys[tr].indexOf(k)); tlSel = []; commit(); renderTimeline(); refreshKeyedRows(); return; }
        if (!inSel(k)) tlSel = linkedAt(n, tr, k);
        renderSelMarks();
        tlSelDrag(e, lane, n, k);
      });
      kf.addEventListener('dblclick', e => e.stopPropagation());
      kf.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        if (tr === 'z') return;
        const grp = linkedAt(n, tr, k);
        showMenu(e.clientX, e.clientY, [
          { label: '這一段的曲線（到下一格）' },
          ...Model.CURVES.map(c => ({ label: (cv === c ? '✓ ' : '') + CURVE_LABEL[c], run: () => { for (const g of grp) g.k[2] = c; commit(); renderTimeline(); } })),
          '-',
          { label: '整條軌道都用這一段的曲線', run: () => { for (const q of n.keys[tr]) q[2] = cv; commit(); renderTimeline(); } },
          { label: '刪除這個影格', icon: 'trash', run: () => { delKey(n, tr, n.keys[tr].indexOf(k)); commit(); renderTimeline(); refreshKeyedRows(); } },
        ]);
      });
      tlKeyEls.set(k, { el: kf, tr });
      lane.append(kf);
    });
  });
}
function renderSelMarks() { for (const [k, info] of tlKeyEls) info.el.classList.toggle('sel', inSel(k)); }
// 移動播放頭（播放中照樣播放，從點的位置繼續）
function laneSeek(e, lane) {
  const r = lane.getBoundingClientRect(), M = total();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  if (D.ui.mode !== 'preview') setMode('preview');
  D.ui.frame = Math.round(f * M) % Math.round(M);
  updatePlaybar(); updateTimelineHead();
}
// 播放頭與數值跟著目前時間
function updateTimelineHead() {
  if (!D) return;
  refreshKeyedRows();
  if (!timelineOn) return;
  const line = $('#tlHead'), lane = document.querySelector('#timeline .tlrow.ruler .tllane');
  if (!line || !lane) return;
  const body = line.parentElement, rb = body.getBoundingClientRect(), lr = lane.getBoundingClientRect();
  line.style.left = `${lr.left - rb.left + body.scrollLeft + curU() * lr.width}px`;
  const n = sel();
  if (!n || tlDrag) return;
  const u = curU();
  document.querySelectorAll('#timeline .prow[data-tr]').forEach(row => {
    const tr = row.dataset.tr, v = (tr.startsWith('p.') ? n.params[tr.slice(2)] || 0 : 0) + Model.keyVal(D.data, n, tr, D.ui.frame);
    const r = row.querySelector('input[type=range]'), num = row.querySelector('.num');
    if (document.activeElement !== r) { r.value = v; r.dispatchEvent(new Event('repaint')); }
    if (document.activeElement !== num) num.value = (v * (TRACK_SCALE[tr] || 1)).toFixed(trackRange(n, tr)[3]);
  });
  document.querySelectorAll('#timeline [data-kb]').forEach(b => b.classList.toggle('on', keyAt(n.keys?.[b.dataset.kb], u) >= 0));
}

// ---------- 畫風預設（快速建模）：Q 版 / 正常比例只差在預設參數 ----------
const WIZ_PROFILES = {
  chibi:  { label: 'Q 版', head: { angle: 5, gravity: 0.01 }, amp: 1.2, hipAngle: 2, preset: 'bounce' },
  normal: { label: '正常比例', head: { angle: 2.5, gravity: 0.004 }, amp: 0.8, hipAngle: 1, preset: 'sway' },
};

// ---------- 近期存取（存在這台電腦的瀏覽器：IndexedDB）----------
const Recent = (() => {
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('tan-design', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('recent', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const run = (mode, fn) => open().then(db => new Promise((res, rej) => { const t = db.transaction('recent', mode), q = fn(t.objectStore('recent')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }));
  const list = () => run('readonly', st => st.getAll()).then(a => (a || []).sort((p, q) => q.time - p.time)).catch(() => []);
  return {
    list,
    async put(rec) { try { await run('readwrite', st => st.put(rec)); for (const r of (await list()).slice(16)) await run('readwrite', st => st.delete(r.id)); } catch (_) { /* 瀏覽器不給存就算了 */ } },
    remove: id => run('readwrite', st => st.delete(id)).catch(() => {}),
  };
})();
async function rememberRecent(doc, blob) {
  if (!doc || !blob) return;
  // 同名的作品沿用同一格（同一個檔案開兩次不會出現兩筆）
  if (!doc.recentId) { const same = (await Recent.list()).find(r => r.name === doc.name); doc.recentId = same ? same.id : Model.uid('r_'); }
  Recent.put({ id: doc.recentId, name: doc.name, time: Date.now(), blob });
}

// ---------- 主頁：新增 ＋ 近期存取 ＋ 範例 ----------
let newFlow = null;   // 新增時選的流程：'full' | 'single' | 'layered'
async function showHome() {
  newFlow = null;
  document.body.classList.add('onhome');
  let h = $('#home');
  if (!h) { h = el('div', { id: 'home', class: 'home' }); document.body.prepend(h); }
  h.classList.remove('hidden');
  const recents = await Recent.list();
  h.innerHTML = '';
  const fmt = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const grid = el('div', { class: 'hgrid' });
  const newTile = el('button', { class: 'htile hnew', title: '新增', onclick: openNewDialog }, el('div', { class: 'hthumb' }, el('span', { class: 'hplus' }, '+')));
  for (const r of recents) {
    const url = URL.createObjectURL(r.blob);
    grid.append(el('div', { class: 'htile', title: '開啟', onclick: async () => {
      await openProject(new File([r.blob], r.name + '_tan.png'));
      if (D) { D.recentId = r.id; rememberRecent(D, r.blob); }
    } },
      el('div', { class: 'hthumb' }, el('img', { src: url, alt: '' })),
      el('div', { class: 'hname' }, r.name), el('div', { class: 'hdate' }, fmt(r.time)),
      el('button', { class: 'tb icon hdel', title: '從清單移除（不會刪掉檔案）', onclick: e => { e.stopPropagation(); Recent.remove(r.id).then(showHome); } }, ico('close'))));
  }
  // 範例：接在近期存取後面
  const SAMPLE_THUMB = { girl: 'assets/sample-girl.png', whitePsd: 'assets/sample-white.png', blink: typeof SAMPLE_BLINK_PROJECT === 'string' ? 'data:image/png;base64,' + SAMPLE_BLINK_PROJECT : '' };
  for (const [k, sm] of Object.entries(Demo.samples)) grid.append(el('div', { class: 'htile', title: '開啟範例', onclick: () => openSample(k) },
    el('div', { class: 'hthumb' }, SAMPLE_THUMB[k] ? el('img', { src: SAMPLE_THUMB[k], alt: '' }) : null),
    el('span', { class: 'htag' }, '範例'),
    el('div', { class: 'hname' }, sm.label), el('div', { class: 'hdate' }, '範例')));
  h.append(
    el('div', { class: 'hhead' }, el('b', {}, '彈design'), el('span', { class: 'grow' }),
      tabs.length ? el('button', { class: 'btn', onclick: hideHome }, '回到編輯') : null),
    el('div', { class: 'hbody' },
      el('div', { class: 'hcol' }, el('div', { class: 'hsec' }, ' '), newTile),
      el('div', { class: 'hdiv' }),
      el('div', { class: 'hcol grow' }, el('div', { class: 'hsec' }, '近期存取'), grid)));
}
function hideHome() { const h = $('#home'); if (h) h.classList.add('hidden'); document.body.classList.remove('onhome'); navTrap(); }
// 新增：完整模式（A）或快速建立（B 單張 / C 分層）
function openNewDialog() {
  const pick = (kind, accept) => () => {
    close();
    newFlow = kind;
    const inp = $('#fileOpen');
    inp.accept = accept;
    inp.click();
    setTimeout(() => { inp.accept = OPEN_ACCEPT; }, 0);
  };
  // 方形大圖示的區塊；點對話框外面就關掉
  const tile = (icon, title, run, cls = '') => el('button', { class: 'ntile ' + cls, onclick: run }, ico(icon), el('b', {}, title));
  const m = $('#modal');
  const close = () => { m.classList.add('hidden'); m.onclick = null; };
  m.innerHTML = '';
  m.append(el('div', { class: 'dialog newd' },
    el('div', { class: 'nsec' }, '完整模式'),
    el('div', { class: 'nrow' }, tile('plus', '開啟檔案', pick('full', OPEN_ACCEPT), 'wide')),
    el('div', { class: 'nsec' }, '快速建立'),
    el('div', { class: 'nrow' },
      tile('image', '單圖層', pick('single', '.png,.jpg,.jpeg,.webp,.gif')),
      tile('layers', '多圖層', pick('layered', '.psd')))));
  m.classList.remove('hidden');
  m.onclick = e => { if (e.target === m) close(); };
}
// 開完檔案之後：依新增時選的流程繼續
function afterOpen() {
  const kind = newFlow;
  newFlow = null;
  if (!kind || !D) return;
  hideHome();
  if (kind === 'full') { setSimple(false); return; }
  const images = D.data.nodes.filter(n => n.type === 'image');
  setSimple(true);
  if (kind === 'layered' && images.length >= 2) wizardLayered(images, { toSimple: true, quick: true });
  else if (kind === 'single' && images.length >= 2) wizardSingle(flattenDoc(), { toSimple: true, quick: true });
  else if (images.length) wizardSingle(images[0], { toSimple: true, quick: true });
}

// 單圖層快速建立選了多圖層的檔案：壓成一張圖再編輯
//   PSD：用檔案裡的合併影像（含混合模式、剪裁、資料夾、效果）；沒有合併影像就自己疊（隱藏、不透明度、混合模式、剪裁）
//   其他（例如多張圖）：用目前畫面（靜止）的樣子
function flattenDoc() {
  const W = D.data.width, H = D.data.height;
  let c = null;
  try { c = D.psdFlatten && D.psdFlatten(); } catch (_) { c = null; }
  if (!c) {
    renderer.begin(W, H);
    drawScene(0, false, [1, 0, 0, 1, 0, 0], W, H, null);
    c = document.createElement('canvas'); c.width = W; c.height = H;
    c.getContext('2d').drawImage(renderer.canvas, 0, 0);
  }
  const name = D.name;
  D.data.nodes = D.data.nodes.filter(n => n.type === 'root');
  D.data.lgroups = [];
  const aid = assetFromCanvas(D, name, c);
  const img = addImageNode(D, aid, name);
  delete D.psdFlatten;
  D.cache.sSig = '';
  resetHistory(D);
  renderAll();
  return img;
}
// ---------- 簡易模式 ----------
// 不能選部位、加錨點、改範圍；只依圖上「有的類型」分頁，每個類型三個參數：幅度、頻率、延遲（其餘保留預設，慣性 0.2）
// 版面：電腦 = 右側上方圖層、下方類型分頁；手機（窄）= 畫面在上、分頁在下，圖層從畫面右上角的按鈕叫出
const SIMPLE_GROUPS = [
  ['head', '頭', ['head']],
  ['hair', '頭髮', ['hair', 'fronthair', 'backhair', 'bangs', 'hairflip', 'ahoge']],
  ['ear', '耳朵', ['ear']],
  ['face', '五官', ['feature', 'eye', 'nose', 'mouth', 'brow']],
  ['torso', '上半身', ['torso']],
  ['lower', '下半身', ['hip', 'leg', 'thigh', 'shin', 'hem']],
  ['arm', '手臂', ['arm', 'upperarm', 'forearm', 'hand']],
  ['tail', '尾巴', ['tail']],
  ['acc', '飾品', ['accessory', 'accflip', 'ribbon', 'custom', 'fixed']],
];
const simpleTypeOf = n => n.type === 'root' || n.type === 'group' ? null : n.type === 'image' ? (n.role && TYPES[n.role] ? n.role : null) : n.type;
function simpleGroups() {
  const out = [];
  for (const [key, label, types] of SIMPLE_GROUPS) {
    const nodes = D.data.nodes.filter(n => { const t = simpleTypeOf(n); return t && types.includes(t); });
    if (nodes.length) out.push({ key, label, nodes });
  }
  return out;
}
const isChain = n => n.pins && n.pins.length > 1;
// 幅度 0 … 1（快速建立完 = 40%）：鏈 = 擺動距離 0 → 最大值（Q 版 25%、正常比例 18%）、鬆度 0 → 1、圓度 0 → 8%
//   沒有鏈的（例如頭）= 旋轉角度：40% = 建立時的角度，100% = 2.5 倍
const simpleAmpMax = () => (D.data.simpleProfile === 'normal' ? 0.18 : 0.25);
function simpleBaseOf(n) {
  const P = n.params;
  if (!n.simpleBase) n.simpleBase = {};
  const b = n.simpleBase;
  if (b.angle == null) b.angle = P.angle || (TYPES[simpleTypeOf(n)] || TYPES.custom).defaults.angle || 3;
  if (b.radius == null && n.region) { b.radius = n.region.radius; b.feather = n.region.feather; }
  return b;
}
function simpleAmpOf(n) {
  const P = n.params;
  if (isChain(n)) return Math.max(0, Math.min(1, (P.amp || 0) / simpleAmpMax()));
  const b = simpleBaseOf(n);
  return b.angle ? Math.max(0, Math.min(1, (P.angle || 0) / b.angle * 0.4)) : 0.4;
}
function simpleSetAmp(n, s) {
  const P = n.params, b = simpleBaseOf(n);
  if (isChain(n)) { P.amp = simpleAmpMax() * s; P.taper = s; P.round = 0.08 * s; if (!P.inertia) P.inertia = 0.2; }
  if (!isChain(n) || P.angle) P.angle = b.angle * s / 0.4;
}
// 範圍 50 … 200%：錨點周圍的粗細、牽連範圍一起放大縮小；遮罩 = 遮罩本身往外 / 往內長（從原本遮罩的複本算，100% 就回到原樣）
const simpleRangeOf = n => (n.simpleBase && n.simpleBase.range) || 1;
const maskSD = new Map();   // 原本遮罩的有號距離場（快取）：負 = 裡面
function maskSignedDist(id) {
  if (maskSD.has(id)) return maskSD.get(id);
  const obj = D.masks.get(id), W = obj.w, H = obj.h, N = W * H, inside = new Uint8Array(N);
  for (let i = 0; i < N; i++) inside[i] = obj.data[i] > 127 ? 1 : 0;
  // 兩次掃描的 3-4 倒角距離：到「另一邊」最近的距離
  const dist = target => {
    const d = new Float32Array(N);
    for (let i = 0; i < N; i++) d[i] = inside[i] === target ? 0 : 1e9;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; let v = d[i]; if (x > 0) v = Math.min(v, d[i - 1] + 3); if (y > 0) { v = Math.min(v, d[i - W] + 3); if (x > 0) v = Math.min(v, d[i - W - 1] + 4); if (x < W - 1) v = Math.min(v, d[i - W + 1] + 4); } d[i] = v; }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; let v = d[i]; if (x < W - 1) v = Math.min(v, d[i + 1] + 3); if (y < H - 1) { v = Math.min(v, d[i + W] + 3); if (x < W - 1) v = Math.min(v, d[i + W + 1] + 4); if (x > 0) v = Math.min(v, d[i + W - 1] + 4); } d[i] = v; }
    for (let i = 0; i < N; i++) d[i] /= 3;
    return d;
  };
  const toIn = dist(1), toOut = dist(0), sd = new Float32Array(N);   // toIn：外面的點到遮罩的距離；toOut：裡面的點到外面的距離
  let area = 0;
  for (let i = 0; i < N; i++) { sd[i] = inside[i] ? -toOut[i] : toIn[i]; area += inside[i]; }
  const r = { sd, W, H, r0: Math.max(8, Math.sqrt(area / Math.PI) * 0.3) };
  maskSD.set(id, r);
  return r;
}
function simpleSetRange(n, s) {
  if (!n.region) return;
  const b = simpleBaseOf(n);
  b.range = s;
  if (n.region.mode === 'auto' && b.radius) n.region.radius = Math.max(2, Math.round(b.radius * s));
  if (b.feather != null) n.region.feather = Math.round((b.feather || 0) * s);
  if (n.region.mode === 'mask' && n.region.maskId && D.masks.get(n.region.maskId)) {
    // 第一次調整時把原本的遮罩複製一份（跟著專案存檔），之後都從這份算
    if (!b.maskBase || !D.masks.get(b.maskBase)) { const o = D.masks.get(n.region.maskId), id = Model.uid('m_'); D.masks.set(id, { ...o, data: o.data.slice(), v: ++maskVer }); b.maskBase = id; }
    const { sd, r0 } = maskSignedDist(b.maskBase), obj = D.masks.get(n.region.maskId), delta = (s - 1) * r0;
    for (let i = 0; i < sd.length; i++) { const v = (delta - sd[i]) + 0.5; obj.data[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255); }
    obj.v = ++maskVer;
  }
}
// 快速建立完：每個類型的幅度設成 40%（左右都有調整空間）
function simpleInit(profile) {
  D.data.simpleProfile = profile || 'chibi';
  for (const g of simpleGroups()) for (const n of g.nodes) { simpleBaseOf(n); simpleSetAmp(n, 0.4); }
}
const simpleFreqOf = n => isChain(n) ? (n.params.swayCurve ? n.params.swayCurve.freq : n.params.swayFreq) : Model.partCurve(D.data, n.params).freq ?? 1;
function simpleSetFreq(n, v) {
  const P = n.params;
  P.curve = { ...Model.partCurve(D.data, P), freq: v };
  P.swayCurve = { ...(P.swayCurve || { shape: 'sine', phase: 0.75 }), freq: v };
  P.swayFreq = v;
}
function simpleToggles() {
  const pb = $('#sPins'), rb = $('#sRange');
  if (pb) pb.classList.toggle('on', !!(D && D.ui.simplePins));
  if (rb) rb.classList.toggle('on', !!(D && D.ui.simpleRange));
}
function setSimple(on) {
  if (D) D.ui.simple = !!on;
  if (!on && isNarrow() && matchMedia('(pointer: coarse)').matches) {
    const el0 = document.documentElement;
    Promise.resolve(el0.requestFullscreen ? el0.requestFullscreen() : null).then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape')).catch(() => {});
  }
  applyModeClass();
  if (on) { setTool('select'); setMode('preview'); if (D) { D.ui.playing = true; updatePlaybar(); } }
  placeLayerPanel();
  renderSimple();
  simpleToggles();
  resize();
}
function applyModeClass() {
  const on = !!(D && D.ui.simple);
  document.body.classList.toggle('simplemode', on);
  document.body.classList.toggle('fullmode', !!D && !on);
  if (!on) document.body.classList.remove('slayers');
  const b = $('#btnMode');
  if (b) { b.textContent = on ? '完整模式' : '簡易模式'; b.title = on ? '切換到完整模式（全部的工具與參數）' : '切換到簡易模式'; b.disabled = !D; }
}
// 圖層區（標題、不透明 / 深度拉桿、圖層列表）：簡易模式時搬到右側上方，回到完整模式時放回左側
function layerBoxGrip() {
  const box = $('#simpleLayers');
  if (!box || box.querySelector('.sgrip')) return;
  try { const h = localStorage.getItem('tan.sLH'); if (h) box.style.setProperty('--sLH', h); } catch (_) { /* ignore */ }
  const grip = el('div', { class: 'sgrip', title: '拖曳調整圖層區高度' });
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    const y0 = e.clientY, h0 = box.getBoundingClientRect().height;
    const move = ev => box.style.setProperty('--sLH', Math.max(140, Math.min(innerHeight * 0.7, h0 + ev.clientY - y0)) + 'px');
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); try { localStorage.setItem('tan.sLH', box.style.getPropertyValue('--sLH')); } catch (_) { /* ignore */ } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  box.append(grip);
}
function placeLayerPanel() {
  layerBoxGrip();
  const on = !!(D && D.ui.simple), home = $('.panel.left'), box = $('#simpleLayers');
  const parts = [$('#orderHead'), $('#depthBar'), $('#orderList')];
  if (!home || !box || parts.some(p => !p)) return;
  if (on && parts[0].parentElement !== box) box.insertBefore(parts[0], box.querySelector('.sgrip')), box.insertBefore(parts[1], box.querySelector('.sgrip')), box.insertBefore(parts[2], box.querySelector('.sgrip'));
  if (!on && parts[0].parentElement !== home) home.append(...parts);
}
function renderSimple() {
  const R = $('#simpleR');
  if (!R) return;
  const body = $('#simpleBody');
  if (!body) return;
  body.innerHTML = '';
  if (!D || !D.ui.simple) return;
  const groups = simpleGroups(), tab = groups.some(g => g.key === D.ui.sptab) ? D.ui.sptab : 'root';
  const tabs = el('div', { class: 'stabs' },
    el('button', { class: tab === 'root' ? 'on' : '', onclick: () => { D.ui.sptab = 'root'; renderSimple(); } }, '整體'),
    ...groups.map(g => el('button', { class: tab === g.key ? 'on' : '', onclick: () => { D.ui.sptab = g.key; renderSimple(); } }, g.label)));
  const pane = el('div', { class: 'spane' });
  const build = el('div', { class: 'sbuild' }, el('button', { class: 'btn', onclick: startQuickBuild }, ico('auto'), hasRigging() ? '重新建模' : '快速建模'));
  body.append(build, tabs, pane);
  if (tab === 'root') { renderSimpleRoot(pane); return; }
  const g = groups.find(x => x.key === tab), nodes = g.nodes, first = nodes.find(isChain) || nodes[0];
  const on = nodes.some(n => n.enabled !== false);
  pane.append(
    el('div', { class: 'frow' }, el('label', {}, ''), el('div', { class: 'inline', style: 'gap:16px' },
      checkbox('動態', () => on, v => { for (const n of nodes) n.enabled = v; }, renderSimple))),
    slider('幅度', () => simpleAmpOf(first), v => { for (const n of nodes) simpleSetAmp(n, v); }, { min: 0, max: 1, step: 0.01, scale: 100, dec: 0, noLive: true, tip: '%；擺動距離、鬆度、圓度一起調（快速建立完是 40）' }),
    slider('頻率', () => simpleFreqOf(first), v => { for (const n of nodes) simpleSetFreq(n, v); }, { min: 0.5, max: 4, step: 0.5, dec: 1, noLive: true, tip: '每個循環來回幾次（整個部位與鍊一起）' }),
    slider('延遲', () => first.delay || 0, v => { for (const n of nodes) { n.delay = v; n.params.lag = v; } }, { min: 0, max: 8, step: 1, noLive: true, tip: '單位 1/32 循環；整個部位與鍊的節點間延遲一起' }),
    slider('範圍', () => simpleRangeOf(first), v => { for (const n of nodes) simpleSetRange(n, v); }, { min: 0.5, max: 2, step: 0.05, scale: 100, dec: 0, noLive: true, tip: '%；會跟著動的範圍放大 / 縮小' }),
    el('div', { class: 'hint' }, `${nodes.length} 個部位：${nodes.map(n => n.name).join('、')}`));
  if (!on) pane.classList.add('soff');
}
// 簡易模式的疊圖：快速建模的點；勾「顯示節點與範圍」時畫目前分頁類型的節點
let simplePins = [];
function simpleOverlay(M, evals) {
  const g = octx, dpr = view.dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (wiz) drawWizard(g, viewAffine());
  simplePins = [];
  if (!D.ui.simplePins) return;
  for (const n of D.data.nodes) {
    if (n.type === 'root' || !n.pins || !n.pins.length) continue;
    const e = evals && evals.get(n.id), pts = n.pins.map(p => { const o = e ? Model.applyChain(e, p.x, p.y) : [p.x, p.y]; return aApply(M, o[0], o[1]); });
    pts.forEach((q, i) => simplePins.push({ p: n.pins[i], x: q[0], y: q[1] }));
    if (pts.length > 1) { g.beginPath(); pts.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.5; g.stroke(); }
    pts.forEach((q, i) => { g.beginPath(); g.arc(q[0], q[1], i ? 4 : 5.5, 0, TAU); g.fillStyle = i ? '#38bdf8' : '#ef4444'; g.fill(); g.strokeStyle = '#111'; g.lineWidth = 1; g.stroke(); });
  }
}
// 整體：整體動作、時間軸、外框（不分區塊；整體運動、緩動、網格不顯示）；往下是立體（多圖層才有）
function renderSimpleRoot(pane) {
  renderRootParams(pane, node('root'));
  { const G = node('root').params; pane.prepend(el('div', { class: 'frow' }, el('label', {}, ''), checkbox('動態', () => G.enabled !== false, v => { G.enabled = v; }, renderSimple))); }
  const kids = [...pane.children];
  let drop = false;
  for (const c of kids) {
    if (c.classList.contains('group')) { drop = ['整體運動', '緩動', '網格'].includes(c.textContent.trim()); c.remove(); continue; }
    if (drop) c.remove();
  }
  if (D.data.nodes.filter(n => n.type === 'image').length < 2) return;   // 單圖層：沒有立體
  const S = P3D.settings(D.data);
  pane.append(...group('立體'), el('div', { class: 'frow' }, el('label', {}, ''), checkbox('啟用立體', () => S.enabled, v => { S.enabled = v; }, renderSimple)));
  if (S.enabled) pane.append(
    slider('深度感', () => S.depth, v => { S.depth = v; }, { min: 0, max: 2, step: 0.05, dec: 2, noLive: true, tip: '所有部位視差位移的整體倍率' }),
    slider('左右角度', () => S.yaw, v => { S.yaw = v; }, { min: 0, max: 40, step: 0.5, dec: 1, noLive: true, tip: '度；最大轉向角' }),
    el('div', { class: 'btnrow' }, el('button', { class: 'btn', title: '越上層越靠前', onclick: () => { P3D.depthByOrder(D.data); commit(); renderAll(); } }, '產生深度')));
}

// ---------- 觸控：長按 = 右鍵選單 ----------
let longPress = null;
document.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  clearTimeout(longPress && longPress.timer);
  const t = e.target, x = e.clientX, y = e.clientY;
  longPress = { x, y, timer: setTimeout(() => {
    if (!longPress) return;
    longPress.fired = true;
    t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    if (navigator.vibrate) navigator.vibrate(12);
  }, 500) };
}, true);
document.addEventListener('pointermove', e => { if (longPress && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > 10) { clearTimeout(longPress.timer); longPress = null; } }, true);
const endLong = () => {
  if (!longPress) return;
  clearTimeout(longPress.timer);
  if (longPress.fired) document.addEventListener('click', ev => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });   // 長按放開不算點
  longPress = null;
};
document.addEventListener('pointerup', endLong, true);
document.addEventListener('pointercancel', () => { if (longPress) { clearTimeout(longPress.timer); longPress = null; } }, true);
// 系統自己的長按選單（Android）已經跳出時，不要再補一次
document.addEventListener('contextmenu', e => { if (longPress && !longPress.fired && e.isTrusted) { clearTimeout(longPress.timer); longPress = null; } }, true);

// ---------- 返回鍵：回上一頁（先關選單 / 對話框 / 快速建模 / 圖層面板，沒有東西開著就回主頁），不會直接離開網站 ----------
// 做法：在編輯畫面時，歷史紀錄裡固定留一筆「陷阱」；按返回 = 處理最上層，還在編輯畫面就再補一筆
function navTrap() { if (!(history.state && history.state.tan === 'app')) { try { history.pushState({ tan: 'app' }, ''); } catch (_) { /* ignore */ } } }
window.addEventListener('popstate', () => {
  const m = $('#modal'), body = document.body;
  let handled = true;
  if (!$('#popmenu').classList.contains('hidden')) hideMenu();
  else if (!m.classList.contains('hidden')) { m.classList.add('hidden'); m.onclick = null; }
  else if (wiz) cancelWizard();
  else if (body.classList.contains('wizon')) { const c = $('#wizDock .wfoot button'); if (c) c.click(); }
  else if (body.classList.contains('slayers')) body.classList.remove('slayers');
  else handled = false;
  if (!body.classList.contains('onhome')) { if (handled) navTrap(); else showHome(); }
});

// ---------- 初始化 ----------
function init() {
  if (!renderer) {
    $('#dropHint .drop-inner').innerHTML = '<div class="big">此瀏覽器不支援 WebGL</div><div>請改用最新版 Chrome / Edge / Firefox / Safari</div>';
    return;
  }
  renderTools();
  // 按鈕不搶焦點：避免空白鍵同時觸發按鈕與播放快捷鍵
  document.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  $('#fileOpen').onchange = e => { openFiles([...e.target.files]).then(afterOpen); e.target.value = ''; };
  $('#btnMode').onclick = () => { if (D) setSimple(!D.ui.simple); };
  $('#btnSLayers').onclick = () => document.body.classList.toggle('slayers');
  $('#btnBackSimple').onclick = () => { if (D) setSimple(true); };
  $('#sPins').onclick = () => { if (D) { D.ui.simplePins = !D.ui.simplePins; simpleToggles(); } };
  $('#sRange').onclick = () => { if (D) { D.ui.simpleRange = !D.ui.simpleRange; simpleToggles(); } };
  $('#demoSel').onchange = e => { openSample(e.target.value); e.target.value = ''; e.target.blur(); };
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnExport').onclick = openExport;
  $('#brand').onclick = e => { e.stopPropagation(); if ($('#popmenu').classList.contains('hidden')) appMenu(); else hideMenu(); };
  updateKeyTitles();
  $('#btnSave').onclick = () => saveProject();
  $('#btnTimeline').onclick = () => toggleTimeline();
  // 左右面板收合（記住狀態）
  const setPanels = () => {
    const L = localStorage.getItem('puppet.noleft') === '1', Rr = localStorage.getItem('puppet.noright') === '1';
    $('#layout').classList.toggle('noleft', L); $('#layout').classList.toggle('noright', Rr);
    // 按鈕位置固定，只換方向與提示
    Object.assign($('#btnHideLeft'), { textContent: L ? '»' : '«', title: L ? '展開左側' : '收起左側' });
    Object.assign($('#btnHideRight'), { textContent: Rr ? '«' : '»', title: Rr ? '展開右側' : '收起右側' });
    resize();
  };
  const flip = k => { try { localStorage.setItem(k, localStorage.getItem(k) === '1' ? '0' : '1'); } catch (_) { /* ignore */ } setPanels(); };
  $('#btnHideLeft').onclick = () => flip('puppet.noleft');
  $('#btnHideRight').onclick = () => flip('puppet.noright');
  try { setPanels(); } catch (_) { /* ignore */ }
  // 預覽區大小一變（工具條換行、時間軸開關、面板收合）就重新配置畫布，避免畫面與游標錯位
  if (window.ResizeObserver) new ResizeObserver(() => resize()).observe($('#stage'));
  $('#btnStripClose').onclick = () => { tool.stripHidden = true; renderStrip(); resize(); };
  setupProbe();
  $('#btnAddPart').onclick = e => {
    e.stopPropagation();
    if (!D) { toast('請先開啟圖片', 'warn'); return; }
    const r = e.currentTarget.getBoundingClientRect();
    { const par = defaultParent(); typeMenu(r.left, r.bottom + 2, t => createPart(t, par), { group: true, parentId: par }); }
  };
  $('#btnAddLayer').onclick = () => $('#fileLayer').click();
  $('#fileLayer').onchange = e => { addLayers([...e.target.files]); e.target.value = ''; };
  $('#fileVariant').onchange = e => { addVariant(e.target.files[0]); e.target.value = ''; };
  $('#fileReplace').onchange = e => { replaceFile(e.target.files[0]); e.target.value = ''; };
  $('#btnDelete').onclick = () => { if (D) deleteNode(sel()); };
  $('#btnGroup').onclick = makeGroup;
  // 選單剛彈出時（例如在畫面上放錨點後問類型），同一次點擊不要把它關掉
  document.addEventListener('click', e => { if (!e.target.closest('#popmenu') && performance.now() - menuShownAt > 300) hideMenu(); });
  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('#btnPlay').onclick = togglePlay;
  $('#btnPrev').onclick = () => stepFrame(-1);
  $('#btnNext').onclick = () => stepFrame(1);
  $('#btnFit').onclick = () => { if (D) fitView(); };
  $('#tglPins').onclick = e => { showPins = !showPins; e.currentTarget.classList.toggle('on', showPins); };
  $('#tglMesh').onclick = e => { showMesh = !showMesh; e.currentTarget.classList.toggle('on', showMesh); };
  // 背景網格：深色 / 白色（記住選擇）
  { let light = false; try { light = localStorage.getItem('tan.bgLight') === '1'; } catch (_) { /* ignore */ }
    const setBg = v => { light = v; $('#stage').classList.toggle('light', v); $('#tglBg').classList.toggle('on', v); try { localStorage.setItem('tan.bgLight', v ? '1' : '0'); } catch (_) { /* ignore */ } };
    setBg(light); $('#tglBg').onclick = () => setBg(!light); }
  $('#tglRegion').onclick = e => { showRegion = !showRegion; e.currentTarget.classList.toggle('on', showRegion); renderInspector(); };
  $('#scrub').addEventListener('input', e => {
    if (!D) return;
    if (D.ui.mode !== 'preview') setMode('preview');
    D.ui.playing = false; D.ui.frame = +e.target.value; updatePlaybar();
  });
  $('#speedSel').onchange = e => { speed = +e.target.value; };

  const stage = $('#stage');
  stage.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); stage.classList.add('dragover'); } });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', e => {
    e.preventDefault(); stage.classList.remove('dragover');
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    if (D && e.shiftKey) addLayers(files); else openFiles(files);
  });

  window.addEventListener('keydown', e => {
    if (captureKey(e)) return;
    const t = e.target, tag = (t.tagName || '').toLowerCase();
    const typing = (tag === 'input' && !['range', 'checkbox'].includes(t.type)) || tag === 'select' || tag === 'textarea';
    const c = comboOf(e), act = c && KEY_DEFS.find(([id]) => keyMap[id] === c)?.[0];
    const ctrl = e.ctrlKey || e.metaKey;
    // 帶 Ctrl 的（開啟、儲存、輸出、復原、重做）在輸入框裡也有效
    if (act && (ctrl || !typing)) {
      const run = {
        open: () => $('#fileOpen').click(), save: () => saveProject(), saveAs: () => saveProject(true), export: openExport, undo, redo,
        prev: () => D && stepFrame(-1), next: () => D && stepFrame(1),
        brushDown: () => { if (tool.name === 'paint') tool.paintSize = Math.max(1, Math.round(tool.paintSize / 1.2)); else tool.brush = Math.max(1, Math.round(tool.brush / 1.2)); renderToolDetail(); },
        brushUp: () => { if (tool.name === 'paint') tool.paintSize = Math.min(BRUSH_MAX, Math.round(tool.paintSize * 1.2 + 1)); else tool.brush = Math.min(BRUSH_MAX, Math.round(tool.brush * 1.2 + 1)); renderToolDetail(); },
        maskMode: () => { if (tool.name === 'mask') { tool.maskMode = tool.maskMode === 'add' ? 'erase' : 'add'; renderToolDetail(); } },
        play: () => {
          if (!D || e.repeat) return;
          if (c === 'Space' && D.ui.mode === 'edit' && tool.name !== 'select') { spaceDown = true; return; }
          togglePlay();
        },
      }[act] || (act.startsWith('tool.') && D ? () => setTool(act.slice(5)) : null);
      if (run) { e.preventDefault(); run(); return; }
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); redo(); return; }
    if (typing || !D) return;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat && D.ui.mode === 'edit' && tool.name !== 'select') spaceDown = true; return; }
    if (e.key === 'Enter' && lasso) finishLasso();
    else if (e.key === 'Enter' && D.ui.crop) { endCrop(true); setTool('select'); }
    else if (e.key === 'Escape') {
      hideMenu();
      if (D.ui.crop) { endCrop(false); setTool('select'); }
      else if (lasso) lasso = null;
      else if (D.ui.fit) { D.ui.fit = null; renderToolDetail(); renderStatus(); }
      else if (D.ui.align) finishAlign(false);
    }
    else if ((e.key === 'Backspace' || e.key === 'Delete') && wiz) wizUndo();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && tool.name === 'wand' && wandSel) wandDelete();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && lasso) { lasso.pts.pop(); if (!lasso.pts.length) lasso = null; }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && timelineOn && tlSel.length) deleteTlSel();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !D.ui.simple) {
      const n = sel(), p = n && D.ui.selPin && n.pins.find(q => q.id === D.ui.selPin);
      if (p && n.type !== 'root') deletePin(n, p);
      else if (n && n.type !== 'root') deleteNode(n);
    }
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; e.preventDefault(); } });

  setupSplitters();
  setupPointer();
  new ResizeObserver(resize).observe(stage);
  resize();
  renderTabs(); renderAll(); updateUndo();
  requestAnimationFrame(tick);
  showHome();
}

init();
// 除錯用
window.__puppet = { rigDisplay: h => rigDisplay(h, lastDraw && lastDraw.evals), get doc() { return D; }, get renderer() { return renderer; }, ensureDerived, tabs, tool, draw, switchTab, viewAffine, drawScene, get lasso() { return lasso; }, setMode, selectNode, runExport, openFiles, enableBlink, commit, renderAll, saveProject, projName, toggleTimeline, eyePickTest: (hostId, polys) => { eyePick = { hostId, polys }; finishEyePick(); }, openSample, assetFromCanvas, renderTools, branchChains, layerSampler, wizardBuildLayered, openWizard, get wiz() { return wiz; }, showHome, setSimple, openNewDialog, newWith: (kind, files) => { newFlow = kind; return openFiles(files).then(afterOpen); } };
})();
