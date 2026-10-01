// HeadRig：頭部定位（偽 3D 轉頭）
// 掛在「頭」部位（單張圖）或「頭」群組（分層）上：node.rig（version 2）
//   唯一的基準：轉軸中心 axis { cx, cy, tilt }（= 舊版臉部精細的中心與中線方向）；自動建立時由兩眼決定
//   頭範圍：左寬 / 右寬（從中線量）、頭頂；臉範圍：左臉寬 / 右臉寬、下巴 → 決定兩側壓縮（臉部精細）
//   五官：位置 + 範圍（整塊跟著臉走、不被曲面扭曲）
const HeadRig = (() => {
  const DEG = Math.PI / 180;
  const ROLES = {
    face_base:   { label: '臉底' },
    eye:         { label: '眼', feature: true, h: -0.04 },
    brow:        { label: '眉', feature: true, h: 0 },
    nose:        { label: '鼻', feature: true, h: 0.2 },
    mouth:       { label: '嘴', feature: true, h: 0.05 },
    ear:         { label: '耳', hideAt: 0.6 },
    hair_front:  { label: '前髮' },
    hair_side_l: { label: '側髮（左）' },
    hair_side_r: { label: '側髮（右）' },
    hair_back:   { label: '後髮' },
    hair_ahoge:  { label: '呆毛' },
    accessory:   { label: '飾品' },
  };
  const FEATURE_ORDER = { nose: 4, mouth: 3, eye: 2, brow: 1 };   // 重疊時的優先順序
  const uid = p => p + Math.random().toString(36).slice(2, 9);
  const active = rig => !!(rig && rig.enabled && rig.version === 2);

  function defaults() {
    return {
      version: 2, enabled: true, axis: { cx: 0, cy: 0, tilt: 0 },
      head: { l: 150, r: 150, t: 150 }, face: { l: 100, r: 100, chin: 120 },
      side: 0.35, curve: 0.3, persp: 0.05, relief: 0.35, yawRef: 25,
      sync: true, members: [], occlusion: [],
    };
  }
  function member(role, extra = {}) {
    const R = ROLES[role] || ROLES.accessory;
    return { id: uid('mb_'), role, side: 'C', ref: null, marker: null, size: null, fade: 1.4, h: R.h ?? 0, hideAt: R.hideAt ?? null, ...extra };
  }
  const feature = (rig, role, side) => rig.members.find(m => m.role === role && m.marker && (!side || m.side === side));

  // ---------- 座標：原點 = 轉軸中心，x = 與中線垂直（往右），y = 沿中線往下巴 ----------
  const frameOf = rig => rig.axis || eyeFrame(rig);
  // 由五官推的中線：過兩眼中點、與兩眼連線垂直（3/4 側臉的嘴本來就偏一側，不拿來定方向）
  function eyeFrame(rig) {
    const eL = feature(rig, 'eye', 'L'), eR = feature(rig, 'eye', 'R');
    if (!eL || !eR) return rig.axis || { cx: 0, cy: 0, tilt: 0 };
    const cx = (eL.marker[0] + eR.marker[0]) / 2, cy = (eL.marker[1] + eR.marker[1]) / 2;
    const tilt = Math.atan2(eR.marker[1] - eL.marker[1], eR.marker[0] - eL.marker[0]) / DEG;
    return { cx, cy, tilt: Math.max(-30, Math.min(30, tilt)) };
  }
  function toLocal(E, x, y) {
    const t = -(E.tilt || 0) * DEG, dx = x - E.cx, dy = y - E.cy;
    return [dx * Math.cos(t) - dy * Math.sin(t), dx * Math.sin(t) + dy * Math.cos(t)];
  }
  function dirToDoc(E, lx, ly) {
    const t = (E.tilt || 0) * DEG;
    return [lx * Math.cos(t) - ly * Math.sin(t), lx * Math.sin(t) + ly * Math.cos(t)];
  }
  const fromLocal = (E, lx, ly) => { const [dx, dy] = dirToDoc(E, lx, ly); return [E.cx + dx, E.cy + dy]; };
  const sizeOf = m => m.size || [20, 20];
  const outerOf = m => { const s = sizeOf(m), k = Math.max(1.05, m.fade || 1.4); return [s[0] * k, s[1] * k]; };

  // ---------- 臉型（給 P3D.faceMap）：中心 = 轉軸中心，半高 = 頭頂距離 ----------
  const faceCache = new WeakMap();
  function faceOf(rig) {
    const E = frameOf(rig), H = rig.head, C = rig.face;
    const key = [E.cx, E.cy, E.tilt, H.l, H.r, H.t, C.l, C.r, C.chin, rig.side, rig.curve, rig.persp].join();
    const c = faceCache.get(rig);
    if (c && c.key === key) return c.F;
    const [tx, ty] = fromLocal(E, 0, -H.t), [bx, by] = fromLocal(E, 0, C.chin), cx = E.cx, cy = E.cy;
    const RL = Math.max(4, H.l), RR = Math.max(4, H.r);
    const F = {
      on: true, cx, cy, R: (RL + RR) / 2, RL, RR,   // R（平均）給子圖層視差與脖子漸弱用，與舊版相同
      FwL: Math.max(2, Math.min(C.l, RL - 1)), FwR: Math.max(2, Math.min(C.r, RR - 1)), Rv: Math.max(10, H.t),
      top: { x: tx, y: ty }, chin: { x: bx, y: by }, side: rig.side, curve: rig.curve, persp: rig.persp,
    };
    F.Fw = Math.max(F.FwL, F.FwR);
    faceCache.set(rig, { key, F });
    return F;
  }
  // 臉型的位移（本地座標）：與 model.js 相同，下巴以下往脖子漸弱
  //   回傳 { mesh(lx, ly) → [dx, dy], jac(lx, ly) → { dx, dy, a, b, c, d }（J − I） }
  function faceFns(rig, host, A, k) {
    const E = frameOf(rig), F3 = faceOf(rig), o = { drv: { yaw: A.th, pitch: A.ps }, k: k ?? 1 }, O = [0, 0];
    let ax = F3.chin.x - F3.top.x, ay = F3.chin.y - F3.top.y; const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l;
    const hg = host && host.pins && host.pins.length && host.region ? host.region.hinge ?? 0 : 0, Hf = hg > 0 ? hg : F3.R * 0.3;
    const sm = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
    const mapL = (lx, ly) => {
      const [x, y] = fromLocal(E, lx, ly);
      P3D.faceMap(F3, o, x, y, O);
      const wf = 1 - sm(((x - F3.chin.x) * ax + (y - F3.chin.y) * ay) / Hf + 0.5);
      return toLocal(E, x + (O[0] - x) * wf, y + (O[1] - y) * wf);
    };
    return {
      mesh: (lx, ly) => { const q = mapL(lx, ly); return [q[0] - lx, q[1] - ly]; },
      jac: (lx, ly) => {
        const q = mapL(lx, ly), e = Math.max(2, F3.R * 0.03), xa = mapL(lx + e, ly), xb = mapL(lx - e, ly), ya = mapL(lx, ly + e), yb = mapL(lx, ly - e);
        return { dx: q[0] - lx, dy: q[1] - ly, a: (xa[0] - xb[0]) / (2 * e) - 1, c: (xa[1] - xb[1]) / (2 * e), b: (ya[0] - yb[0]) / (2 * e), d: (ya[1] - yb[1]) / (2 * e) - 1 };
      },
    };
  }

  // 目前的轉角（弧度）；turn = 轉向量（以 yawRef 為 1，給遮擋 / 淡出用）
  function angles(rig, drv) {
    if (!drv) return null;
    const th = drv.yaw, ps = drv.pitch;
    if (Math.abs(th) < 1e-6 && Math.abs(ps) < 1e-6) return null;
    return { th, ps, turn: Math.max(-1.5, Math.min(1.5, th / ((rig.yawRef || 25) * DEG))) };
  }
  // 成員的參考點（本地）：標記 → 圖層範圍中心
  function refPoint(E, m, boundsOf) {
    if (m.marker) return toLocal(E, m.marker[0], m.marker[1]);
    const b = m.ref && boundsOf ? boundsOf(m.ref) : null;
    if (b) return toLocal(E, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    return [0, 0];
  }
  // 每幀：每個五官的姿態 { m, lx, ly, dx, dy, J }（本地）＝ 臉型在中心的位移 + 局部線性變形 + 相對臉面的凹凸
  function frame(rig, drv, boundsOf, host, k) {
    if (!active(rig)) return null;
    const A = angles(rig, drv);
    if (!A) return null;
    const E = frameOf(rig), lg = faceFns(rig, host, A, k), out = new Map();
    const Rz = (rig.head.l + rig.head.r) / 2 * (rig.relief ?? 0.35);
    for (const m of rig.members) {
      if (!ROLES[m.role]?.feature || !m.marker) continue;
      const [lx, ly] = refPoint(E, m, boundsOf), J = lg.jac(lx, ly), z = Rz * (m.h || 0);
      out.set(m.id, { m, lx, ly, dx: J.dx + z * Math.sin(A.th), dy: J.dy - z * Math.sin(A.ps), J });
    }
    return { A, rig, E, poses: out, lg };
  }

  // ---------- 網格位移場（在臉型之前）----------
  // 預先計算：目標節點的核心頂點（權重 ≥ 0.9 漸入到 0.985），各五官的淡出權重
  function buildMesh(rig, rest, n, weightOf) {
    const E = frameOf(rig), feats = rig.members.filter(m => ROLES[m.role]?.feature && m.marker);
    const fc = feats.map(m => ({ c: toLocal(E, m.marker[0], m.marker[1]), I: sizeOf(m), O: outerOf(m), pr: FEATURE_ORDER[m.role] || 0 }));
    const sw = (a, b, q) => { const t = Math.max(0, Math.min(1, (q - a) / (b - a))); return t * t * (3 - 2 * t); };
    const idx = [], fi = [], fw = [];
    for (let v = 0; v < n; v++) {
      const w = weightOf(v);
      if (w < 0.9) continue;
      const [lx, ly] = toLocal(E, rest[v * 2], rest[v * 2 + 1]), mk = sw(0.9, 0.985, w);
      let best = -1, bw = 0, bp = -1;
      fc.forEach((f, k) => {
        const di = Math.hypot((lx - f.c[0]) / f.I[0], (ly - f.c[1]) / f.I[1]), dO = Math.hypot((lx - f.c[0]) / f.O[0], (ly - f.c[1]) / f.O[1]);
        let ww;
        if (di <= 1) ww = 1; else if (dO >= 1) ww = 0; else { const s = (di - 1) / Math.max(1e-6, (di - 1) + (1 - dO)); ww = 1 - s * s * (3 - 2 * s); }
        if (ww > bw + 1e-6 || (Math.abs(ww - bw) <= 1e-6 && ww > 0 && f.pr > bp)) { best = k; bw = ww; bp = f.pr; }
      });
      if (best < 0 || bw * mk <= 0) continue;
      idx.push(v); fi.push(best); fw.push(bw * mk);
    }
    return { idx: Int32Array.from(idx), fi: Int16Array.from(fi), fw: Float32Array.from(fw), feats };
  }
  // 每幀：補上「整塊五官 − 臉型」的差（文件座標），回傳 Float32Array(n*2) 或 null
  function meshOffsets(F, M, n, rest) {
    if (!F || !M || !M.idx.length) return null;
    const E = F.E, out = new Float32Array(n * 2), fp = M.feats.map(m => F.poses.get(m.id));
    let any = false;
    for (let k = 0; k < M.idx.length; k++) {
      const p = fp[M.fi[k]];
      if (!p) continue;
      const v = M.idx[k], w = M.fw[k], [lx, ly] = toLocal(E, rest[v * 2], rest[v * 2 + 1]), J = p.J, qx = lx - p.lx, qy = ly - p.ly;
      const L = F.lg.mesh(lx, ly);
      const [dx, dy] = dirToDoc(E, (p.dx + J.a * qx + J.b * qy - L[0]) * w, (p.dy + J.c * qx + J.d * qy - L[1]) * w);
      out[v * 2] = dx; out[v * 2 + 1] = dy; any = true;
    }
    return any ? out : null;
  }

  // ---------- 前後與透明度（分層：遠側側髮到臉底下、遠側耳淡出）----------
  const sideSign = m => m.side === 'L' ? -1 : m.side === 'R' ? 1 : 0;
  function isFar(m, turn) { const s = sideSign(m); return s !== 0 && Math.sign(turn) === s; }
  function drawState(F, orderOf) {
    const out = new Map(), { rig, A } = F, turn = A.turn;
    for (const m of rig.members) {
      if (!m.ref) continue;
      if (m.hideAt != null && isFar(m, turn)) {
        const a = Math.abs(turn), h = m.hideAt, w = 0.12;
        const al = a <= h - w ? 1 : a >= h + w ? 0 : 1 - (a - (h - w)) / (2 * w);
        if (al < 1) out.set(m.ref, { ...(out.get(m.ref) || {}), alpha: al });
      }
    }
    for (const r of rig.occlusion || []) {
      const a = rig.members.find(m => m.id === r.a), b = rig.members.find(m => m.id === r.b);
      if (!a || !b || !a.ref || !b.ref || r.off) continue;
      const th = r.threshold ?? 0.15, fade = Math.max(0.01, r.fade ?? 0.1);
      const past = th >= 0 ? turn > th : turn < th;
      const behind = orderOf(b.ref) - 0.5 - orderOf(a.ref);
      const d = Math.abs(turn - th);
      const st = out.get(a.ref) || {};
      if (d < fade) {
        const f = past ? 0.5 + 0.5 * (d / fade) : 0.5 - 0.5 * (d / fade);
        out.set(a.ref, { ...st, z: 0, z2: behind, f });
      } else if (past) out.set(a.ref, { ...st, z: behind });
    }
    return out;
  }

  // ---------- 自動建立 ----------
  const ROLE_WORDS = [
    ['hair_back', ['後髮', '後髪', '后发', 'back hair', 'backhair', 'ushiro']],
    ['hair_front', ['前髮', '前髪', '瀏海', '浏海', 'bang', 'fringe', 'front hair', 'maegami']],
    ['hair_side', ['橫髮', '横髪', '側髮', '側髪', '侧发', 'side hair', 'sidehair']],
    ['hair_ahoge', ['呆毛', 'ahoge']],
    ['ear', ['耳', 'ear']],
    ['face_base', ['五官', '臉', '脸', '顔', '顏', 'face', 'skin', '肌']],
    ['accessory', ['飾', '帽', '緞帶', '蝴蝶結', 'ribbon', 'hat', 'accessory']],
  ];
  function guessRole(name) {
    const s = (name || '').toLowerCase();
    for (const [role, ws] of ROLE_WORDS) if (ws.some(w => s.includes(w))) return role;
    return null;
  }
  const isSkin = c => c && c[0] > 150 && c[0] >= c[1] && c[1] >= c[2] - 6 && c[0] - c[2] > 14 && c[0] - c[2] < 110;
  const lumOf = c => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  // 皮膚的最大連通區 → 臉的範圍
  function findFace(px, box, step) {
    const W = Math.ceil((box.x1 - box.x0) / step) + 1, H = Math.ceil((box.y1 - box.y0) / step) + 1, g = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (isSkin(px(box.x0 + i * step, box.y0 + j * step))) g[j * W + i] = 1;
    const lab = new Int32Array(W * H).fill(-1); let best = null;
    for (let s0 = 0; s0 < W * H; s0++) {
      if (!g[s0] || lab[s0] >= 0) continue;
      const q = [s0], cells = []; lab[s0] = s0;
      while (q.length) { const c = q.pop(); cells.push(c); const x = c % W, y = (c / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy, k = ny * W + nx; if (nx >= 0 && ny >= 0 && nx < W && ny < H && g[k] && lab[k] < 0) { lab[k] = s0; q.push(k); } } }
      if (!best || cells.length > best.length) best = cells;
    }
    if (!best || best.length < 20) return null;
    const xs = best.map(c => c % W).sort((a, b) => a - b), ys = best.map(c => (c / W) | 0).sort((a, b) => a - b), q = (a, f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
    return { x0: box.x0 + q(xs, 0.03) * step, x1: box.x0 + q(xs, 0.97) * step, y0: box.y0 + q(ys, 0.02) * step, y1: box.y0 + q(ys, 0.98) * step };
  }
  function darkCenter(px, x0, y0, x1, y1, frac = 0.2, maxLum = 255) {
    const pts = [];
    for (let y = Math.round(y0); y <= y1; y += 2) for (let x = Math.round(x0); x <= x1; x += 2) { const c = px(x, y); if (c && !isSkin(c)) pts.push([lumOf(c), x, y]); }
    if (pts.length < 6) return null;
    pts.sort((a, b) => a[0] - b[0]);
    const k = Math.max(4, Math.round(pts.length * frac)), sel = pts.slice(0, k);
    if (sel[k - 1][0] > maxLum) return null;
    let sx = 0, sy = 0; for (const [, x, y] of sel) { sx += x; sy += y; }
    return [Math.round(sx / k), Math.round(sy / k)];
  }
  // 眼睛：深色（睫毛、瞳孔）與白色（眼白、反光）同時密集的地方；回傳深色像素的重心或 null
  function eyeFind(px, x0, y0, x1, y1, win) {
    const st = Math.max(1, Math.round(win / 10)), W = Math.ceil((x1 - x0) / st) + 1, H = Math.ceil((y1 - y0) / st) + 1;
    const dk = new Float32Array((W + 1) * (H + 1)), wh = new Float32Array((W + 1) * (H + 1));
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = px(x0 + i * st, y0 + j * st), k = (j + 1) * (W + 1) + i + 1;
      const d = c && !isSkin(c) && lumOf(c) < 90 ? 1 : 0, w = c && !isSkin(c) && Math.min(c[0], c[1], c[2]) > 215 ? 1 : 0;
      dk[k] = d + dk[k - 1] + dk[k - W - 1] - dk[k - W - 2]; wh[k] = w + wh[k - 1] + wh[k - W - 1] - wh[k - W - 2];
    }
    const sum = (A, i0, j0, i1, j1) => A[j1 * (W + 1) + i1] - A[j0 * (W + 1) + i1] - A[j1 * (W + 1) + i0] + A[j0 * (W + 1) + i0];
    const r = Math.max(1, Math.round(win / 2 / st));
    let best = 0, bi = -1, bj = -1;
    for (let j = r; j < H - r; j++) for (let i = r; i < W - r; i++) {
      const d = sum(dk, i - r, j - r, i + r + 1, j + r + 1), w = sum(wh, i - r, j - r, i + r + 1, j + r + 1);
      if (d < 3 || w < 2) continue;
      const sc = Math.sqrt(d * w) * Math.min(d, w * 4);
      if (sc > best) { best = sc; bi = i; bj = j; }
    }
    if (bi < 0) return null;
    let sx = 0, sy = 0, n = 0;
    for (let j = bj - r; j <= bj + r; j++) for (let i = bi - r; i <= bi + r; i++) {
      const x = x0 + i * st, y = y0 + j * st, c = px(x, y);
      if (c && !isSkin(c) && lumOf(c) < 90) { sx += x; sy += y; n++; }
    }
    return n ? [Math.round(sx / n), Math.round(sy / n)] : null;
  }
  // 嘴：比皮膚明顯更紅（口內、唇）的像素最密集的地方（深色線條到處都有，不拿來找）
  function mouthFind(px, x0, y0, x1, y1, win) {
    const st = Math.max(1, Math.round(win / 10)), W = Math.ceil((x1 - x0) / st) + 1, H = Math.ceil((y1 - y0) / st) + 1;
    const A = new Float32Array((W + 1) * (H + 1));
    const hit = c => c && c[0] > 110 && c[0] - c[1] > 70 && c[0] - c[2] > 45 && lumOf(c) > 60;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const k = (j + 1) * (W + 1) + i + 1; A[k] = (hit(px(x0 + i * st, y0 + j * st)) ? 1 : 0) + A[k - 1] + A[k - W - 1] - A[k - W - 2]; }
    const r = Math.max(1, Math.round(win / 2 / st));
    let best = 3, bi = -1, bj = -1;
    for (let j = r; j < H - r; j++) for (let i = r; i < W - r; i++) {
      const v = A[(j + r + 1) * (W + 1) + i + r + 1] - A[(j - r) * (W + 1) + i + r + 1] - A[(j + r + 1) * (W + 1) + i - r] + A[(j - r) * (W + 1) + i - r];
      if (v > best) { best = v; bi = i; bj = j; }
    }
    if (bi < 0) return null;
    let sx = 0, sy = 0, n = 0;
    for (let j = bj - r; j <= bj + r; j++) for (let i = bi - r; i <= bi + r; i++) { const x = x0 + i * st, y = y0 + j * st; if (hit(px(x, y))) { sx += x; sy += y; n++; } }
    return [Math.round(sx / n), Math.round(sy / n)];
  }
  // 在 box 內找臉（皮膚最大連通區）→ 左右眼、眉、鼻、嘴；回傳 { members, face, ipd }
  function autoFeatures(box, px) {
    const fb = (px && findFace(px, box, Math.max(2, Math.round((box.x1 - box.x0) / 90)))) || null;
    const b = fb || { x0: box.x0 + (box.x1 - box.x0) * 0.2, x1: box.x1 - (box.x1 - box.x0) * 0.2, y0: box.y0 + (box.y1 - box.y0) * 0.35, y1: box.y1 - (box.y1 - box.y0) * 0.05 };
    const w = b.x1 - b.x0, h = b.y1 - b.y0, mx = (b.x0 + b.x1) / 2;
    const win = w * 0.16;
    let eL = px && (eyeFind(px, b.x0, b.y0 + h * 0.05, mx - w * 0.02, b.y0 + h * 0.7, win) || darkCenter(px, b.x0 + w * 0.05, b.y0 + h * 0.1, mx - w * 0.04, b.y0 + h * 0.62));
    let eR = px && (eyeFind(px, mx + w * 0.02, b.y0 + h * 0.05, b.x1, b.y0 + h * 0.7, win) || darkCenter(px, mx + w * 0.04, b.y0 + h * 0.1, b.x1 - w * 0.05, b.y0 + h * 0.62));
    eL = eL || [b.x0 + w * 0.28, b.y0 + h * 0.38]; eR = eR || [b.x0 + w * 0.72, b.y0 + h * 0.38];
    const ey = (eL[1] + eR[1]) / 2, emx = (eL[0] + eR[0]) / 2;
    const ipd0 = Math.max(w * 0.25, Math.abs(eR[0] - eL[0]));
    let mo = px && (mouthFind(px, emx - ipd0 * 0.45, ey + ipd0 * 0.3, emx + ipd0 * 0.45, Math.min(b.y1, ey + ipd0 * 1.2), ipd0 * 0.2) || darkCenter(px, emx - w * 0.2, ey + h * 0.25, emx + w * 0.2, b.y1 - h * 0.04, 0.15));
    mo = mo || [emx, b.y0 + h * 0.82];
    const ipd = Math.max(w * 0.25, Math.abs(eR[0] - eL[0]));
    // 最暗的像素偏向上睫毛：中心往下修正
    eL = [eL[0], eL[1] + ipd * 0.08]; eR = [eR[0], eR[1] + ipd * 0.08];
    const no = [emx + (mo[0] - emx) * 0.55, ey + (mo[1] - ey) * 0.55];
    const out = [];
    const add = (role, side, p, s) => out.push(member(role, { side, marker: [Math.round(p[0]), Math.round(p[1])], size: s.map(Math.round) }));
    add('eye', 'L', eL, [ipd * 0.3, ipd * 0.3]); add('eye', 'R', eR, [ipd * 0.3, ipd * 0.3]);
    for (const [side, e] of [['L', eL], ['R', eR]]) {
      const br = px && darkCenter(px, e[0] - ipd * 0.3, e[1] - ipd * 0.8, e[0] + ipd * 0.3, e[1] - ipd * 0.42, 0.15, 110);
      if (br) add('brow', side, br, [ipd * 0.28, ipd * 0.08]);
    }
    add('nose', 'C', no, [ipd * 0.1, ipd * 0.1]); add('mouth', 'C', mo, [ipd * 0.22, ipd * 0.12]);
    return { members: out, face: fb, ipd };
  }
  // 頭 / 臉範圍：old = 舊的臉部精細設定（有就原樣沿用：中心、中線方向、寬度都不變），否則由兩眼定中線、從 alpha 與皮膚範圍量
  function measure(rig, alphaAt, fb, ipd, old) {
    if (old) {
      const ax = old.chin.x - old.top.x, ay = old.chin.y - old.top.y;
      rig.axis = { cx: old.cx, cy: old.cy, tilt: +(Math.atan2(-ax, ay) / DEG).toFixed(2) };
      const Fw = old.Fw ?? old.R * 0.65;
      rig.head = { l: old.R, r: old.R, t: old.Rv };
      rig.face = { l: Fw, r: Fw, chin: Math.round(toLocal(rig.axis, old.chin.x, old.chin.y)[1]) };
      Object.assign(rig, { side: old.side ?? 0.35, curve: old.curve ?? 0.3, persp: old.persp ?? 0.05 });
      return;
    }
    const E = eyeFrame(rig), mo = feature(rig, 'mouth'), my = mo ? toLocal(E, ...mo.marker)[1] : ipd * 0.9;
    const st = Math.max(1, Math.round(ipd / 40)), far = ipd * 5;
    const scan = (x0, y0, ux, uy) => {   // 從 (x0, y0) 沿 (ux, uy) 往外，連續 8 格透明就停
      let last = 0, miss = 0;
      for (let d = 0; d < far; d += st) {
        const [x, y] = fromLocal(E, x0 + ux * d, y0 + uy * d);
        if (alphaAt(x, y)) { last = d; miss = 0; } else if (++miss >= 8) break;
      }
      return last;
    };
    let l = 0, r = 0, t = 0;
    for (let y = -ipd * 0.2; y <= my; y += Math.max(2, ipd / 12)) { l = Math.max(l, scan(0, y, -1, 0)); r = Math.max(r, scan(0, y, 1, 0)); }
    for (const x of [-ipd * 0.25, 0, ipd * 0.25]) t = Math.max(t, scan(x, 0, 0, -1));
    t = Math.max(ipd * 0.8, t);
    let fl = ipd, fr = ipd, chin = my + ipd * 0.5;
    if (fb) {
      fl = -toLocal(E, fb.x0, E.cy)[0]; fr = toLocal(E, fb.x1, E.cy)[0];
      chin = Math.max(my + ipd * 0.25, Math.min(my + ipd * 0.8, toLocal(E, E.cx, fb.y1)[1]));
    }
    // 轉軸中心：中線上、頭頂與下巴的中點
    const mid = (chin - t) / 2, [cx, cy] = fromLocal(E, 0, mid);
    rig.axis = { cx: Math.round(cx), cy: Math.round(cy), tilt: +E.tilt.toFixed(2) };
    rig.head = { l: Math.round(Math.max(ipd * 0.8, l)), r: Math.round(Math.max(ipd * 0.8, r)), t: Math.round(t + mid) };
    rig.face = { l: Math.round(Math.max(ipd * 0.4, Math.min(fl, rig.head.l - 4))), r: Math.round(Math.max(ipd * 0.4, Math.min(fr, rig.head.r - 4))), chin: Math.round(chin - mid) };
    clampRanges(rig);
  }
  function clampRanges(rig) {
    rig.face.l = Math.max(4, rig.face.l); rig.face.r = Math.max(4, rig.face.r);
    rig.head.l = Math.max(rig.head.l, rig.face.l + 4); rig.head.r = Math.max(rig.head.r, rig.face.r + 4);
    rig.face.chin = Math.max(10, rig.face.chin); rig.head.t = Math.max(10, rig.head.t);
  }
  // 依兩眼對齊中線：中心移到兩眼中點的中線上、方向改成五官的中線；頭 / 臉邊緣的實際位置盡量不動
  function alignToFeatures(rig) {
    const E0 = frameOf(rig), E = eyeFrame(rig);
    if (!feature(rig, 'eye', 'L') || !feature(rig, 'eye', 'R')) return false;
    const [, ly] = toLocal(E, E0.cx, E0.cy), [cx, cy] = fromLocal(E, 0, ly), ux = toLocal(E0, cx, cy)[0];
    rig.head.l = Math.round(rig.head.l + ux); rig.head.r = Math.round(rig.head.r - ux);
    rig.face.l = Math.round(rig.face.l + ux); rig.face.r = Math.round(rig.face.r - ux);
    rig.axis = { cx: Math.round(cx), cy: Math.round(cy), tilt: +E.tilt.toFixed(2) };
    clampRanges(rig);
    return true;
  }
  // 分層：依圖層名稱建立圖層成員（遮擋 / 淡出用）；layers = [{ id, name, b }]，cx = 中線 x
  function autoLayers(rig, layers, cx) {
    for (const L of layers) {
      let role = L.role !== undefined ? L.role : guessRole(L.name);   // 精靈指定的角色優先（不看名稱）
      if (!role) continue;
      const lcx = (L.b.x0 + L.b.x1) / 2;
      let side = 'C';
      if (role === 'hair_side' || role === 'ear') side = lcx < cx ? 'L' : 'R';
      if (role === 'hair_side') role = side === 'L' ? 'hair_side_l' : 'hair_side_r';
      rig.members.push(member(role, { ref: L.id, side }));
    }
    const face = rig.members.find(m => m.role === 'face_base' && m.ref);
    if (face) for (const m of rig.members) if (m.role === 'hair_side_l' || m.role === 'hair_side_r')
      rig.occlusion.push({ id: uid('oc_'), a: m.id, b: face.id, threshold: m.role === 'hair_side_l' ? -0.15 : 0.15, fade: 0.1 });
  }

  let boundsFn = null;
  const setBounds = f => { boundsFn = f; };
  const boundsOf = id => boundsFn ? boundsFn(id) : null;
  const hostOf = (data, id) => data.nodes.find(n => active(n.rig) && n.rig.members.some(m => m.ref === id));

  return { ROLES, active, defaults, member, feature, frameOf, eyeFrame, alignToFeatures, toLocal, fromLocal, dirToDoc, sizeOf, outerOf, faceOf, faceFns, angles, frame, buildMesh, meshOffsets, drawState, guessRole, autoFeatures, measure, autoLayers, setBounds, boundsOf, hostOf };
})();
