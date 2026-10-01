// 偽 3D（立體）：與動態參數分開存放與計算
// 整體：data.p3d = { enabled, camera, yaw°, yawFreq, yawPhase, pitch°, pitchFreq, pitchPhase, depth(深度感) }
// 部位 / 圖層 / 群組：n.p3d = { depth(-1 後 … +1 前), squashX, squashY, face?, off{} }
// 轉向時：前方往轉向方向移、後方反向（依與父層的深度差）；
// 臉部精細模式：頭當成圓柱曲面繞中線轉，遠側變窄變小、近側變寬變大，中線與下巴保持一致
const P3D = (() => {
  // 頭內部的相對深度（與鏡頭方向無關）
  const HEAD_REL = { fronthair: 0.35, hair: 0.2, feature: 0.1, eye: -0.1, backhair: -0.5, ear: -0.2, accessory: 0.3 };
  // 頭以外的類型預設深度（只在自動綁定時當起點，之後各自調整）
  const BODY = { head: 0.3, torso: 0, arm: 0.15, leg: -0.3, tail: -0.4 };
  const TYPE_SQUASH = { head: 0.5, torso: 0.3 };
  const DEFAULT = { enabled: false, yaw: 12, yawFreq: 1, yawPhase: 0, pitch: 0, pitchFreq: 1, pitchPhase: 8, depth: 1 };

  function settings(data) {
    const S = Object.assign({}, DEFAULT, data.p3d || {});
    // 舊欄位換算：freq / phase / pitchMode
    if (S.freq !== undefined) {
      S.yawFreq = S.freq; S.yawPhase = S.phase || 0;
      S.pitchFreq = S.pitchMode === 'nod' ? S.freq * 2 : S.freq;
      S.pitchPhase = S.pitchMode === 'nod' ? S.yawPhase : S.yawPhase + 8;
      delete S.freq; delete S.phase; delete S.pitchMode;
    }
    delete S.camera;
    data.p3d = S;
    return S;
  }
  const has3d = n => n.type !== 'root';
  const nodeDefaults = type => ({ depth: null, squashX: TYPE_SQUASH[type] ?? 0, squashY: TYPE_SQUASH[type] ?? 0 });
  function nodeOf(n) {
    if (!n.p3d) n.p3d = nodeDefaults(n.type);
    return n.p3d;
  }
  const val = (p, k) => (p.off && p.off[k] ? 0 : p[k] || 0);

  // 驅動器：轉向 / 俯仰角（弧度），曲線與整體擺動相同（往復 + 緩動），各自的次數與相位
  // 編輯時的「試轉」：固定一個轉向姿勢預覽（不播放、不含動態）
  let probe = null;
  const setProbe = p => { probe = p; };
  function driver(data, t) {
    const S = data.p3d;
    if (!S || !S.enabled) return null;
    if (probe) return probe.abs ? { yaw: probe.yawDeg * Math.PI / 180, pitch: probe.pitchDeg * Math.PI / 180 } : { yaw: probe.yaw * val(S, 'yaw') * Math.PI / 180, pitch: probe.pitch * val(S, 'pitch') * Math.PI / 180 };
    const M = Model.master(data), U = M / 32;
    const at = (f, ph) => Model.globalCurves(data, Anim.mod(t * Math.max(1, Math.round(f || 1)) + ph * U, M)).xk;
    return {
      yaw: val(S, 'yaw') * at(S.yawFreq, val(S, 'yawPhase')) * Math.PI / 180,
      pitch: val(S, 'pitch') * at(S.pitchFreq, val(S, 'pitchPhase')) * Math.PI / 180,
    };
  }

  // depth 為 null = 沿用父層深度（新加的部位預設跟著所在圖層）
  function depthOf(n, data) {
    if (!has3d(n)) return 0;
    const P = nodeOf(n);
    if (P.depth === null || P.depth === undefined) return data ? parentDepth(data, n) : 0;
    return val(P, 'depth');
  }
  function parentDepth(data, n) {
    for (let p = n.parent && Model.byId(data, n.parent); p; p = p.parent && Model.byId(data, p.parent)) if (has3d(p)) return depthOf(p, data);
    return 0;
  }

  // 最近的臉部精細祖先
  // 頭部定位（HeadRig）有啟用時，臉型由定位組出；否則用舊的臉部精細
  const faceOfNode = n => HeadRig.active(n.rig) ? HeadRig.faceOf(n.rig) : n.p3d && n.p3d.face && n.p3d.face.on ? faceNorm(n.p3d.face) : null;
  function faceAncestor(data, n) {
    for (let p = n.parent && Model.byId(data, n.parent); p; p = p.parent && Model.byId(data, p.parent)) { const F = faceOfNode(p); if (F) return F; }
    return null;
  }
  // 這個節點在時間 t 的立體位移：{ dx, dy, sx, sy, face }
  // 物件的轉動範圍：整體轉向 -1 … 1 對應到這個物件的 neg … pos（靜止時一律是 0）
  // 平滑對應（二次曲線）：-1 → neg、0 → 0、1 → pos，經過 0 時速度連續，不會在中間卡一下
  const mapRange = (v, neg = -1, pos = 1) => { const a = (pos - neg) / 2, b = (pos + neg) / 2; return a * v + b * v * v; };
  // 深度圖（每個部位 / 圖層各一張，文件座標）：有塗 = depth（淺），無塗 = depthFar（深）；由 app 提供遮罩
  let maps = null;
  const setMaps = m => { maps = m; };
  function depthMap(n) {
    const P = n.p3d;
    if (!P || !P.mapId || !maps) return null;
    const obj = maps.get(P.mapId);
    if (!obj) return null;
    const near = val(P, 'depth'), far = P.depthFar ?? near;
    return { obj, near, far };
  }
  function offset(data, n, t, drv0) {
    if (!drv0 || !has3d(n)) return null;
    const P = nodeOf(n), S0 = data.p3d;
    const my = val(S0, 'yaw') * Math.PI / 180, mp = val(S0, 'pitch') * Math.PI / 180;
    const yn0 = my ? drv0.yaw / my : 0, pn0 = mp ? drv0.pitch / mp : 0;
    const R0 = P.range || {};
    const yn1 = mapRange(yn0, R0.yawNeg, R0.yawPos), pn1 = mapRange(pn0, R0.pitchNeg, R0.pitchPos);
    const drv = { yaw: yn1 * my, pitch: pn1 * mp };
    const pd = parentDepth(data, n), rel = depthOf(n, data) - pd;
    const L = Math.max(data.width, data.height) * 0.12 * val(data.p3d, 'depth');
    // 每單位深度差的位移（cx, cy）；在臉部精細的頭底下 = 相對臉部曲面的凹凸，沿臉的橫軸位移
    let cx = L * Math.sin(drv.yaw), cy = L * Math.sin(drv.pitch);
    const FA = faceAncestor(data, n);
    if (FA) {
      let ax = FA.chin.x - FA.top.x, ay = FA.chin.y - FA.top.y;
      const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l;
      const B = FA.R * 0.5 * val(data.p3d, 'depth'), su = B * Math.sin(drv.yaw), sv = B * Math.sin(drv.pitch);
      cx = ay * su + ax * sv; cy = -ax * su + ay * sv;
    }
    const map = depthMap(n);
    const face = faceOfNode(n);
    const sx = face ? 1 : 1 - val(P, 'squashX') * (1 - Math.cos(drv.yaw)) * 1.5;
    const sy = face ? 1 : 1 - val(P, 'squashY') * (1 - Math.cos(drv.pitch)) * 1.5;
    const k = val(data.p3d, 'depth');
    if (!face && !map && Math.abs(rel * cx) < 1e-3 && Math.abs(rel * cy) < 1e-3 && sx === 1 && sy === 1) return null;
    return { dx: rel * cx, dy: rel * cy, cx, cy, pd, map, sx, sy, face, drv, k, yn: yn1 };
  }


  // 臉部精細：中線 top → chin 為轉軸方向；cx, cy 為轉軸中心；R = 頭半寬（頭邊緣）、Fw = 臉半寬（臉邊緣）、Rv = 半高
  //   side（側面壓縮）：臉邊緣到頭邊緣之間的頭側面，轉過來的一側展開、轉過去的一側壓縮；頭的外緣不動
  //   curve（臉部曲度）：臉本身像曲面，中間比邊緣多移一點（近側半邊略寬、遠側半邊略窄）
  //   chinIn（下巴內收）：從臉中段往下巴，上面兩項漸減 → 下巴轉得比中線少
  //   以 30° 為基準：轉 30° 時側面壓縮 1 = 遠側幾乎壓平
  function faceNorm(F) {
    if (F.side === undefined) { F.side = 0.35; F.curve = 0.3; F.persp = Math.min(F.persp ?? 0.05, 0.1); delete F.round; delete F.depth; }
    if (F.Fw === undefined) F.Fw = Math.round(F.R * 0.65);
    return F;
  }
  const S30 = Math.sin(Math.PI / 6);
  function faceMap(F, o, x, y, out) {
    let ax = F.chin.x - F.top.x, ay = F.chin.y - F.top.y;
    const len = Math.hypot(ax, ay) || 1; ax /= len; ay /= len;
    const nx = ay, ny = -ax;
    const px = x - F.cx, py = y - F.cy;
    const u = px * nx + py * ny, v = px * ax + py * ay;
    // 左右可以不對稱（頭部定位）：RL / RR = 中線到左 / 右頭邊緣，FwL / FwR = 到左 / 右臉邊緣
    const RL = Math.max(2, F.RL ?? F.R), RR = Math.max(2, F.RR ?? F.R), Rv = Math.max(1, F.Rv);
    const FL = Math.min(Math.max(1, F.FwL ?? F.Fw), RL - 1), FR = Math.min(Math.max(1, F.FwR ?? F.Fw), RR - 1);
    const vt = (F.top.x - F.cx) * ax + (F.top.y - F.cy) * ay, vc = (F.chin.x - F.cx) * ax + (F.chin.y - F.cy) * ay;
    const tv = (v - vt) / ((vc - vt) || 1), g = Math.max(0, Math.min(1, (tv - 0.5) / 0.5));
    const vf = 1 - val(F, 'chinIn') * g * g * (3 - 2 * g);
    const k = o.k, st = Math.sin(o.drv.yaw) / S30, sp = Math.sin(o.drv.pitch) / S30;
    // 橫向
    const gap = ((RL - FL) + (RR - FR)) / 2, gmin = Math.min(RL - FL, RR - FR);
    const E = Math.max(-0.92 * gmin, Math.min(0.92 * gmin, val(F, 'side') * k * st * gap)) * vf;
    const C = Math.max(-0.4, Math.min(0.4, val(F, 'curve') * k * st * 0.25)) * (FL + FR) / 2 * vf;
    let u2;
    if (u >= RR || u <= -RL) u2 = u;
    else if (u > FR) u2 = RR - (RR - u) * (RR - FR - E) / (RR - FR);
    else if (u < -FL) u2 = -RL + (u + RL) * (RL - FL + E) / (RL - FL);
    else { const fw = u < 0 ? FL : FR; u2 = u + E + C * (1 - (u / fw) * (u / fw)); }
    // 縱向（俯仰）：臉的上下曲度
    const Cv = Math.max(-0.4, Math.min(0.4, val(F, 'curve') * k * sp * 0.25)) * Rv;
    const v2 = Math.abs(v) < Rv ? v + Cv * (1 - (v / Rv) * (v / Rv)) : v;
    // 遠近：近側略放大、遠側略縮小（以下巴為錨）
    const kk = 1 - val(F, 'persp') * (u / (u < 0 ? RL : RR)) * st * 0.5;
    const v3 = vc + (v2 - vc) * kk;
    out[0] = F.cx + nx * u2 + ax * v3;
    out[1] = F.cy + ny * u2 + ay * v3;
    return out;
  }

  // 從範圍估出臉部精細設定的初始值
  function faceFromBounds(b, pivot) {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, R = (b.x1 - b.x0) / 2, Rv = (b.y1 - b.y0) / 2;
    const chin = pivot ? { x: Math.round(pivot.x), y: Math.round(pivot.y) } : { x: Math.round(cx), y: Math.round(b.y1) };
    return { on: true, cx: Math.round(cx), cy: Math.round(cy), R: Math.round(R), Fw: Math.round(R * 0.65), Rv: Math.round(Rv), top: { x: chin.x, y: Math.round(b.y0 + Rv * 0.3) }, chin, side: 0.35, curve: 0.3, persp: 0.05 };
  }

  // 依部位類型給深度起點（頭內部 = 頭的深度 + 相對深度）
  function typeDepth(data, n, type = n.type) {
    type = Model.baseType(type);   // 細分類型（瀏海、上臂…）用基底的深度
    let inHead = false;
    for (let p = n.parent && Model.byId(data, n.parent); p; p = p.parent && Model.byId(data, p.parent)) if (p.type === 'head' || p.role === 'head') inHead = true;
    const d = type in HEAD_REL ? (inHead ? 0 : BODY.head) + HEAD_REL[type] : BODY[type] ?? 0;
    return Math.max(-1, Math.min(1, +d.toFixed(2)));
  }
  // 圖層模式：依繪製順序（後 → 前）平均分配 -0.6 … +0.6
  function depthByOrder(data) {
    const list = data.nodes.filter(n => Model.isDrawable(n)).sort((a, b) => a.order - b.order);
    list.forEach((n, i) => { nodeOf(n).depth = list.length > 1 ? +(-0.6 + 1.2 * i / (list.length - 1)).toFixed(2) : 0; });
  }

  return { faceOfNode, HEAD_REL, BODY, typeDepth, DEFAULT, setProbe, get probe() { return probe; }, faceAncestor, settings, nodeOf, nodeDefaults, driver, depthOf, parentDepth, offset, faceMap, faceNorm, faceFromBounds, has3d, depthByOrder, setMaps, depthMap };
})();
