// 資料模型與動作求值
// 樹：整體(root) → 圖層(image) → 部位 → 子部位 …
// 權重：每個部位有「核心」（遮罩或錨點周圍）與「牽連範圍」（核心外越遠越小）。
//   第一輪先分核心（子部位優先），第二輪剩下的像素再依牽連範圍分配，最後剩餘歸圖層本身。
// 變形：子部位 = 先套自己的變形，再套父層的變形。
// 部位動作分兩塊：
//   總體：總體延遲、旋轉（以支點為中心，支點附近柔化）、旋轉曲線、縮放
//   鍊：節點間延遲、擺動（每個節點左右擺，可呈 S 形）、慣性（跟著父層 / 整體的移動延遲擺動）
const Model = (() => {
  const { loopT, easeFn, evalKeys } = Anim;
  const TAU = Math.PI * 2, DEG = Math.PI / 180;

  // ---------- 仿射矩陣 [a,b,c,d,e,f] ----------
  const I = [1, 0, 0, 1, 0, 0];
  const aMul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const aApply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const aInv = m => {
    const det = m[0] * m[3] - m[1] * m[2];
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  };
  function aAbout(cx, cy, rad, sx, sy) {
    const c = Math.cos(rad), s = Math.sin(rad);
    const m = [c * sx, s * sx, -s * sy, c * sy, 0, 0];
    m[4] = cx - (m[0] * cx + m[2] * cy);
    m[5] = cy - (m[1] * cx + m[3] * cy);
    return m;
  }
  const smooth = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);

  // ---------- 旋轉曲線 ----------
  // 往復類：pingpong 來回；彈動：cycle（0 下壓、20 微抬、30 回到 0）
  const SHAPES = {
    swing: '往復・標準（Easy Ease）',
    'swing-sine': '往復・平滑',
    'swing-hold': '往復・兩端停頓',
    'swing-linear': '往復・等速',
    bounce: '彈動（0 / 20 / 30 幀）',
  };
  const loopOf = P => P.shape === 'bounce' ? 'cycle' : 'pingpong';
  function shapeValue(data, P, u) {
    switch (P.shape) {
      case 'bounce': return evalKeys([[0, 1], [2 / 3, -0.35], [1, 1]], u, easeFn(data.timeline.ease));
      case 'swing-sine': return Math.cos(Math.PI * u);
      case 'swing-hold': return evalKeys([[0, 1], [1, -1]], u, easeFn(0.75));
      case 'swing-linear': return 1 - 2 * u;
      default: return evalKeys([[0, 1], [1, -1]], u, easeFn(data.timeline.ease));
    }
  }

  // ---------- 曲線設定（小扳手）----------
  // spec = { shape, freq, ease, hold, skew, over, phase, pp, dip }
  //   shape：swing 往復（緩動）、sine 平滑、linear 等速、bounce 彈跳（下壓後彈回）
  //   freq：每個循環幾次（0.5 為單位；非整數時整段動畫自動變成兩個循環長，才接得回去）
  //   ease：緩動強度；hold：兩端停頓比例；skew：去回快慢（-0.8 … 0.8）；over：衝過頭；phase：相位（0 … 1）
  //   pp：來回鏡像（彈跳一去一回）；dip：彈跳的下壓深度（-1 … 0）
  const CURVE_SHAPES = { swing: '往復', sine: '平滑（正弦）', linear: '等速', bounce: '彈跳' };
  // 舊設定換算成曲線設定（輸出與原本一致）
  function partCurve(data, P) {
    if (P.curve) return P.curve;
    const e = data.timeline.ease;
    switch (P.shape) {
      case 'bounce': return { shape: 'bounce', freq: 2, ease: e, dip: -0.35 };
      case 'swing-sine': return { shape: 'sine', freq: 1 };
      case 'swing-hold': return { shape: 'swing', freq: 1, ease: 0.75 };
      case 'swing-linear': return { shape: 'linear', freq: 1 };
      default: return { shape: 'swing', freq: 1, ease: e };
    }
  }
  function globalCurveSpecs(data, G) {
    const e = data.timeline.ease;
    return {
      x: G.xCurve || { shape: 'swing', freq: 1, ease: e },
      y: G.yCurve || (G.yMode === 'pingpong' ? { shape: 'bounce', freq: 1, ease: e, dip: -1, pp: true } : { shape: 'bounce', freq: 2, ease: e, dip: -1 }),
    };
  }
  // 一段 0 → 1 的進度：停頓 → 緩動 → 衝過頭
  function curveProgress(c, s) {
    const h = Math.max(0, Math.min(0.9, c.hold || 0));
    const q = h ? Math.max(0, Math.min(1, (s - h / 2) / (1 - h))) : s;
    const e = c.shape === 'linear' ? q : c.shape === 'sine' ? 0.5 - 0.5 * Math.cos(Math.PI * q) : easeFn(c.ease ?? 0.33)(q);
    return e + (c.over || 0) * Math.sin(Math.PI * Math.pow(q, 1.5));
  }
  // 曲線在時間 t（幀）的值（約 -1 … 1）；tLoop = 以循環為單位的時間
  function curveAt(data, c, t) {
    let p = t / master(data) * (c.freq ?? 1) + (c.phase || 0);
    p -= Math.floor(p);
    if (c.pp) p = p < 0.5 ? p * 2 : 2 - p * 2;
    const k = Math.max(-0.8, Math.min(0.8, c.skew || 0));
    if (c.shape === 'bounce') {
      const a = Math.max(0.1, Math.min(0.9, 2 / 3 + k / 3)), d = c.dip ?? -1;
      return p < a ? 1 + (d - 1) * curveProgress(c, p / a) : d + (1 - d) * curveProgress(c, (p - a) / (1 - a));
    }
    const a = 0.5 + k * 0.5;
    return p < a ? 1 - 2 * curveProgress(c, p / a) : 1 - 2 * curveProgress(c, 1 - (p - a) / (1 - a));
  }
  // 無法首尾循環的設定（頻率不是整數）：回傳 [{ node, what }]，給輸出時提醒用（不會自動延長）
  function loopIssues(data) {
    const C = cyclesOf(data), odd = f => Math.abs((f ?? 1) * C - Math.round((f ?? 1) * C)) > 1e-6, out = [];
    for (const n of data.nodes) {
      if (n.type === 'root') {
        const g = globalCurveSpecs(data, n.params);
        if (odd(g.x.freq)) out.push({ node: n, what: `左右 / 旋轉頻率 ${g.x.freq}` });
        if (odd(g.y.freq)) out.push({ node: n, what: `上下 / 壓扁頻率 ${g.y.freq}` });
        continue;
      }
      if (!n.params || !n.enabled) continue;
      if (n.params.angle && n.params.curve && odd(n.params.curve.freq)) out.push({ node: n, what: `旋轉頻率 ${n.params.curve.freq}` });
      if (n.params.amp && n.pins && n.pins.length > 1 && odd(n.params.swayFreq)) out.push({ node: n, what: `擺動頻率 ${n.params.swayFreq}` });
    }
    return out;
  }

  // 輸出時需要幾個整段時間軸，所有週期性動作才會剛好接回起點（非整數頻率靠多播幾次來循環）
  function loopMul(data) {
    const C = cyclesOf(data), fs = [];
    for (const n of data.nodes) {
      if (n.type === 'root') { const G = n.params; if (G.enabled) { const g = globalCurveSpecs(data, G); fs.push(g.x.freq ?? 1, g.y.freq ?? 1); } continue; }
      if (!n.params || !n.enabled) continue;
      const P = eff(n.params);
      if (P.angle || P.move || P.squash) fs.push(partCurve(data, P).freq ?? 1);
      if (P.amp && n.pins && n.pins.length > 1) fs.push(P.swayCurve ? P.swayCurve.freq : P.swayFreq);
      if (P.flipFreq) fs.push(P.flipFreq);
      if (P.breath) fs.push(0.5);
    }
    const S = data.p3d;
    if (S && S.enabled) fs.push(S.yawFreq || 1, S.pitchFreq || 1);
    for (let m = 1; m <= 64; m++) if (fs.every(f => !f || Math.abs(f * C * m - Math.round(f * C * m)) < 1e-6)) return m;
    return 1;
  }

  // ---------- 類型 ----------
  const STILL = {
    angle: 0, shape: 'swing', gravity: 0,
    amp: 0, taper: 1, round: 0.25, swayFreq: 2, lag: 2, inertia: 0,
    move: 0, moveAng: 0,         // 位移：距離（畫面高度的比例）、方向（度；0 = 上下）
    squash: 0, squashAng: 0,     // 壓扁拉伸：幅度、拉伸方向（度；0 = 上下拉長）
    flipAng: 0, flipFreq: 0,     // 翻轉：轉軸角度（度；0 = 直軸，像翻書頁）、每個循環翻幾圈（0 = 不翻）
    breath: 0,   // 只給動作組使用，不顯示在部位參數
  };
  // 預設參數參考「白髮女孩（分層）」範例調好的數值：頭髮鏈同一組、頭與手臂 3°
  const HAIR_TUNED = { ...STILL, angle: 0, shape: 'swing', gravity: 0.015, lag: 2, amp: 0.035, taper: 0, swayFreq: 2, round: 0.15, inertia: 0.2 };
  const TYPES = {
    root:      { label: '整體', icon: 'root' },
    image:     { label: '圖層', icon: 'image', color: '#9aa4b5', defaults: STILL },
    group:     { label: '群組', icon: 'folder', color: '#9aa4b5', defaults: STILL, region: 'none' },
    torso:     { label: '軀幹', icon: 'lock', color: '#f87171', defaults: STILL },
    head:      { label: '頭', icon: 'rotate', color: '#60a5fa', defaults: { ...STILL, angle: 3 } },
    hair:      { label: '頭髮', icon: 'wave', color: '#ffb347', defaults: HAIR_TUNED },
    fronthair: { label: '前髮', icon: 'wave', color: '#fde68a', defaults: HAIR_TUNED },
    backhair:  { label: '後髮', icon: 'wave', color: '#d69a5a', defaults: HAIR_TUNED },
    ear:       { label: '獸耳 / 耳朵', icon: 'rotate', color: '#f472b6', defaults: { ...STILL, angle: -6, shape: 'bounce', amp: 0.02, swayFreq: 2, lag: 1, inertia: 0.2 } },
    feature:   { label: '臉', icon: 'eye', color: '#fb923c', defaults: STILL },
    eye:       { label: '眼睛', icon: 'eye', color: '#fdba74', defaults: STILL },
    arm:       { label: '手臂', icon: 'rotate', color: '#6ee7b7', defaults: { ...STILL, angle: 3 } },
    leg:       { label: '腿', icon: 'rotate', color: '#86efac', defaults: STILL },
    tail:      { label: '尾巴', icon: 'wave', color: '#c084fc', defaults: { ...STILL, angle: 4, amp: 0.06, round: 0.3, swayFreq: 1, lag: 2, inertia: 0.25 } },
    accessory: { label: '飾品（垂墜）', icon: 'wave', color: '#facc15', defaults: { ...STILL, amp: 0.05, round: 0.3, swayFreq: 2, lag: 2, inertia: 0.4, gravity: 0.015 } },
    custom:    { label: '自訂', icon: 'wave', color: '#94a3b8', defaults: { ...STILL, amp: 0.04, swayFreq: 1, lag: 2 } },
    // 細分類型：base = 行為沿用哪一種（深度預設、鏈、圖示），只換名稱與動作預設
    bangs:     { label: '瀏海', base: 'fronthair', icon: 'wave', color: '#fde68a', defaults: HAIR_TUNED },
    hairflip:  { label: '髮翹', base: 'hair', icon: 'wave', color: '#ffb347', defaults: HAIR_TUNED },
    ahoge:     { label: '呆毛', base: 'hair', icon: 'wave', color: '#ffb347', defaults: { ...STILL, angle: 5, shape: 'bounce', amp: 0.05, round: 0.3, swayFreq: 2, lag: 1, inertia: 0.3 } },
    nose:      { label: '鼻子', base: 'feature', icon: 'eye', color: '#fb923c', defaults: STILL },
    mouth:     { label: '口', base: 'feature', icon: 'eye', color: '#fb923c', defaults: STILL },
    brow:      { label: '眉毛', base: 'feature', icon: 'eye', color: '#fb923c', defaults: STILL },
    upperarm:  { label: '上臂', base: 'arm', icon: 'rotate', color: '#6ee7b7', defaults: { ...STILL, angle: 3 } },
    forearm:   { label: '小臂', base: 'arm', icon: 'rotate', color: '#6ee7b7', defaults: { ...STILL, angle: 3 } },
    hand:      { label: '手腕 + 手', base: 'arm', icon: 'rotate', color: '#6ee7b7', defaults: { ...STILL, angle: 3 } },
    hip:       { label: '腰臀', base: 'torso', icon: 'rotate', color: '#f87171', defaults: { ...STILL, angle: 2 } },
    thigh:     { label: '大腿', base: 'leg', icon: 'rotate', color: '#86efac', defaults: { ...STILL, angle: 2 } },
    shin:      { label: '小腿', base: 'leg', icon: 'rotate', color: '#86efac', defaults: { ...STILL, angle: 3 } },
    accflip:   { label: '飾品（翻轉）', base: 'accessory', icon: 'rotate', color: '#facc15', defaults: { ...STILL, angle: 8, shape: 'swing-sine' } },
    fixed:     { label: '固定物件', base: 'custom', icon: 'lock', color: '#94a3b8', defaults: STILL },
  };
  const baseType = t => (TYPES[t] && TYPES[t].base) || t;
  // 物件屬性 / 新增部位的分類選單（null = 直接選，不再展開）
  const TYPE_MENU = [
    ['頭部', ['head', 'fronthair', 'bangs', 'hair', 'backhair', 'hairflip', 'ahoge', 'ear']],
    ['五官', ['feature', 'eye', 'nose', 'mouth', 'brow']],
    ['上半身', ['torso', 'arm', 'upperarm', 'forearm', 'hand']],
    ['下半身', ['hip', 'leg', 'thigh', 'shin']],
    ['其他', ['tail', 'accflip', 'accessory', 'fixed', 'custom']],
  ];
  const ADD_TYPES = ['torso', 'head', 'fronthair', 'hair', 'backhair', 'feature', 'eye', 'ear', 'arm', 'leg', 'tail', 'accessory', 'custom', 'group'];

  const uid = p => p + Math.random().toString(36).slice(2, 9);

  function newData() {
    return {
      version: 5,
      width: 0, height: 0,
      timeline: { fps: 30, bpm: 30, ease: 0.33 },
      intensity: 1,
      preset: 'bounce',
      mesh: { density: 64, rigidity: 1.2 },
      assets: {},
      nodes: [{
        id: 'root', type: 'root', name: '整體', parent: null, collapsed: false, enabled: true,
        params: { enabled: true, bounce: 0.012, sway: 0.01, rot: 1.2, squash: 0.02, yMode: 'cycle' },
        pins: [],
      }],
    };
  }

  function defaultRegion(data, type) {
    const M = Math.max(data.width, data.height) || 800, base = baseType(type);
    return {
      mode: (TYPES[type] && TYPES[type].region) || 'auto',
      maskId: null,
      radius: Math.round(Math.max(['feature', 'eye'].includes(base) ? 4 : 8, M * (['feature', 'eye'].includes(base) ? 0.015 : 0.035))),
      soft: Math.round(Math.max(3, M * 0.025)),
      feather: Math.round(M * (base === 'torso' ? 0.02 : ['feature', 'eye'].includes(base) ? 0.012 : 0.05)),
      hinge: Math.round(M * 0.06),
    };
  }

  function makeNode(data, type, parent, extra = {}) {
    const T = TYPES[type];
    const same = data.nodes.filter(n => n.type === type).length;
    const n = {
      id: uid('n_'), type, name: T.label.replace(/（.*）/, '') + (same ? ' ' + (same + 1) : ''),
      parent, collapsed: false, enabled: true, visible: true,
      mirror: false, delay: 0,
      params: JSON.parse(JSON.stringify(T.defaults || STILL)),
      pins: [],
      region: defaultRegion(data, type),
      detach: false, hardness: 0.85,
      order: 0,
    };
    Object.assign(n, extra);
    n.name = uniqueName(data, n.name, n);
    return n;
  }
  // 名稱不重複：重複時在後面加編號（「後髮」→「後髮 2」）
  function uniqueName(data, name, self) {
    const taken = nm => data.nodes.some(m => m !== self && m.name === nm);
    if (!taken(name)) return name;
    const base = name.replace(/ \d+$/, '');
    for (let k = 2; ; k++) if (!taken(`${base} ${k}`)) return `${base} ${k}`;
  }

  // 舊資料補齊新欄位
  function migrate(data) {
    bpmOf(data);
    P3D.settings(data);
    for (const n of data.nodes) {
      if (n.type === 'root') continue;
      // 舊版多圖層的「頭」群組 → 頭部件（範圍無，當父層帶動子圖層）
      if (n.type === 'group' && n.role === 'head') { n.type = 'head'; n.region = { ...defaultRegion(data, 'head'), mode: 'none' }; }
      const T = TYPES[n.type] || TYPES.custom;
      n.params = { ...JSON.parse(JSON.stringify(T.defaults || STILL)), ...(n.params || {}) };
      if (n.region) n.region = { ...defaultRegion(data, n.type), ...n.region };
      if (n.enabled === undefined) n.enabled = true;
      if (n.visible === undefined) n.visible = true;
      if (n.params.bobY) { n.params.move = n.params.move || n.params.bobY; n.params.moveAng = 0; }
      delete n.params.bobY;
      if (n.keysAxis === 'h' && !n.params.flipAng) n.params.flipAng = 90;
      const K = n.keys;
      if (K && K.sx && K.sy && !K.sc && JSON.stringify(K.sx) === JSON.stringify(K.sy)) { K.sc = K.sx; delete K.sx; delete K.sy; }
      delete n.keysAxis;
    }
    // 舊版的群組（部位樹裡的資料夾，底下只有圖層）→ 圖層群組：只綁定前後順序，圖層改掛回資料夾的父層
    data.lgroups = data.lgroups || [];
    for (let again = true; again;) {
      again = false;
      for (const g of data.nodes) {
        if (g.type !== 'group' || g.role) continue;
        const kids = data.nodes.filter(c => c.parent === g.id);
        if (!kids.length || !kids.every(c => c.type === 'image' || (c.type === 'group' && !c.role))) continue;
        if (kids.some(c => c.type === 'group')) continue;   // 先處理最裡面的
        data.lgroups.push({ id: g.id, name: g.name, collapsed: !!g.collapsed, visible: g.visible !== false, opacity: 1, enabled: true });
        for (const c of kids) { c.parent = g.parent; if (!c.lg) c.lg = g.id; }
        data.nodes = data.nodes.filter(x => x !== g);
        again = true;
        break;
      }
    }
    const seen = new Set();
    for (const n of data.nodes) { if (seen.has(n.name)) n.name = uniqueName(data, n.name, n); seen.add(n.name); }
    data.version = 5;
    return data;
  }

  // ---------- 樹工具 ----------
  const byId = (data, id) => data.nodes.find(n => n.id === id);
  const children = (data, id) => data.nodes.filter(n => n.parent === id);
  function descendants(data, id) {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of data.nodes) if (n.parent && out.has(n.parent) && !out.has(n.id)) { out.add(n.id); grew = true; }
    }
    return out;
  }
  const isDrawable = n => n.type === 'image' || (n.detach && n.type !== 'root' && n.type !== 'group');
  function ancestor(data, n, pred) {
    let p = n.parent && byId(data, n.parent);
    while (p) { if (pred(p)) return p; p = p.parent && byId(data, p.parent); }
    return null;
  }
  const imageOf = (data, n) => ancestor(data, n, p => p.type === 'image');
  // 顯示：自己隱藏就隱藏；父層只有「群組」隱藏時才一起隱藏（父層圖片隱藏不影響底下的圖層）
  function isShown(data, n) {
    if (n.visible === false) return false;
    if (n.lg && data.lgroups) { const g = data.lgroups.find(x => x.id === n.lg); if (g && g.visible === false) return false; }
    for (let p = n.parent && byId(data, n.parent); p; p = p.parent && byId(data, p.parent)) if (p.type === 'group' && p.visible === false) return false;
    return true;
  }
  function participants(data, owner) {
    const out = [];
    const visit = id => {
      for (const c of children(data, id)) {
        if (isDrawable(c)) continue;
        visit(c.id);
        out.push(c);
      }
    };
    visit(owner.id);
    return out;
  }

  // 錨點依放置順序連成一條鏈：第一個 = 支點
  const pivotOf = n => n.pins[0];
  const movers = n => n.pins.slice(1);
  // 時間：一個完整循環 = 1 拍（60 BPM = 1 秒），與 FPS 無關；內部以「幀」計時
  // 延遲類參數以 1/32 循環為單位
  function bpmOf(data) {
    const tl = data.timeline;
    if (!tl.bpm) tl.bpm = tl.span ? Math.round(tl.fps * 30 / tl.span) : 30;
    delete tl.span;
    return tl.bpm;
  }
  const master = data => data.timeline.fps * 60 / bpmOf(data);
  // 時間軸總長 = 單一循環 × 循環數（「增加一次循環」）；程序動作仍以單一循環為週期，關鍵影格以總長為準
  const cyclesOf = data => Math.max(1, Math.round(data.timeline.cycles || 1));
  const totalOf = data => master(data) * cyclesOf(data);
  const spanOf = data => master(data) / 2;
  const unitOf = data => master(data) / 32;

  // ---------- 範圍 ----------
  function polyDist(pts, x, y) {
    if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y);
    let d = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, ay = pts[i].y, vx = pts[i + 1].x - ax, vy = pts[i + 1].y - ay, l2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2));
      d = Math.min(d, Math.hypot(x - ax - vx * t, y - ay - vy * t));
    }
    return d;
  }
  const RF = new Float64Array(2);
  function regionFields(n, x, y, mk) {
    RF[0] = 0; RF[1] = 0;
    const R = n.region;
    if (!R || R.mode === 'none') return RF;
    let core, d;
    if (R.mode === 'mask') {
      const m = mk(n);
      if (!m) return RF;
      core = m.core(x, y);
      d = m.dist(x, y);
    } else {
      if (!n.pins.length) return RF;
      const dd = polyDist(n.pins, x, y) - R.radius;
      const s = Math.max(0.5, R.soft);
      core = 1 - smooth((dd + s) / (2 * s));
      d = Math.max(0, dd);
    }
    RF[0] = core;
    RF[1] = d <= 0 ? 1 : R.feather > 0 ? 1 - smooth(d / R.feather) : 0;
    return RF;
  }
  function allocate(parts, x, y, mk, acc) {
    acc.fill(0);
    const cores = new Float64Array(parts.length), falls = new Float64Array(parts.length);
    for (let i = 0; i < parts.length; i++) { const f = regionFields(parts[i], x, y, mk); cores[i] = f[0]; falls[i] = f[1]; }
    let rem = 1;
    for (let i = 0; i < parts.length && rem > 1e-4; i++) if (cores[i] > 0) { const w = cores[i] * rem; acc[i + 1] += w; rem -= w; }
    for (let i = 0; i < parts.length && rem > 1e-4; i++) if (falls[i] > 0) { const w = falls[i] * rem; acc[i + 1] += w; rem -= w; }
    acc[0] += rem;
    return acc;
  }

  // ---------- 動作求值 ----------
  // 單獨關閉的參數（params.off[key]）以中性值代入
  const NEUTRAL = { taper: 1, swayFreq: 1, enabled: true };
  function eff(P) {
    if (!P.off) return P;
    const keys = Object.keys(P.off).filter(k => P.off[k]);
    if (!keys.length) return P;
    const E = { ...P };
    for (const k of keys) if (k in E) E[k] = k in NEUTRAL ? NEUTRAL[k] : typeof E[k] === 'number' ? 0 : E[k];
    return E;
  }
  const delayOf = n => n.params && n.params.off && n.params.off.delay ? 0 : n.delay || 0;
  const localT = (data, n, t) => t - delayOf(n) * unitOf(data);
  // 總體：旋轉角（弧度）、縮放、動作組用的上下位移
  function overall(data, n, t) {
    const P = effT(data, n, t), span = spanOf(data), k = data.intensity, tt = localT(data, n, t);
    let ang = 0, sc = 1, sy = 1, tx = 0, ty = 0, sq = 0;
    const sqA = (P.squashAng || 0) * DEG;
    if (!n.enabled) return { ang, sc, sy, tx, ty, sq, sqA };
    const v = P.angle || P.move || P.squash ? curveAt(data, partCurve(data, P), tt) : 0;
    if (P.angle) ang = P.angle * k * (n.mirror ? -1 : 1) * v * DEG;
    if (P.move) { const a = (P.moveAng || 0) * DEG * (n.mirror ? -1 : 1), d = P.move * k * data.height * v; tx = Math.sin(a) * d; ty = Math.cos(a) * d; }
    if (P.squash) sq = P.squash * k * v;
    if (P.gravity) sc = 1 + P.gravity * k * evalKeys([[0, 0], [2 / 3, 1], [1, 0]], loopT(tt, span, 'cycle') / span, easeFn(data.timeline.ease));
    if (P.breath) sy = 1 + P.breath * k * (0.5 - 0.5 * Math.cos(TAU * loopT(tt, span * 2, 'cycle') / (span * 2)));
    return { ang, sc, sy, tx, ty, sq, sqA };
  }
  // 以支點為中心的旋轉 / 縮放；越靠近支點作用越小（支點柔化），避免出現圓形分界
  function softPose(piv, o, H) {
    return (x, y, out) => {
      const dx = x - piv.x, dy = y - piv.y;
      const s = H > 0 ? smooth(Math.hypot(dx, dy) / H) : 1;
      const a = o.ang * s, c = Math.cos(a), sn = Math.sin(a);
      const kx = 1 + (o.sc - 1) * s, ky = 1 + (o.sc * o.sy - 1) * s;
      let ex = dx * kx, ey = dy * ky;
      if (o.sq) {
        // 壓扁拉伸：沿拉伸方向放大、垂直方向縮小（體積大致不變）
        const ax = Math.sin(o.sqA), ay = Math.cos(o.sqA), q = 1 + o.sq * s;
        const pa = ex * ax + ey * ay, pp = -ex * ay + ey * ax;
        const A = pa * q, B = pp / q;
        ex = A * ax - B * ay; ey = A * ay + B * ax;
      }
      out[0] = piv.x + c * ex - sn * ey + o.tx * s;
      out[1] = piv.y + sn * ex + c * ey + o.ty * s;
    };
  }

  const OUT = new Float64Array(2);
  const TMP = new Float64Array(2);

  // ctx：同一幀內共用；可求父層在其他時間點的位置（慣性用）
  function makeCtx(data) {
    const cache = new Map();
    const drvCache = new Map();
    const ctx = {
      data,
      drv(t) { const k = t.toFixed(3); if (!drvCache.has(k)) drvCache.set(k, P3D.driver(data, t)); return drvCache.get(k); },
      evalsAt(t, depth) {
        const key = t.toFixed(3) + '|' + depth;
        if (!cache.has(key)) cache.set(key, buildEvalsInner(data, t, true, ctx, depth));
        return cache.get(key);
      },
      // 某節點（含整體）在時間 t 會把點 (x,y) 帶到哪裡
      worldPoint(id, t, x, y, depth) {
        const o = applyChain(ctx.evalsAt(t, depth).get(id), x, y);
        const g = globalAffine(data, t);
        return aApply(g, o[0], o[1]);
      },
    };
    return ctx;
  }

  // 動態位移之後疊上立體位移（兩者資料分開）
  // ---------- 關鍵影格（時間軸）----------
  // n.keys = { 軌道: [[u, v, 曲線?], …] }；u = 循環中的位置（0 … 1），與 FPS / BPM 無關；整條軌道跟著循環（最後一格接回第一格）
  //   變換：tx / ty（px）、rot（度，可超過一圈）、sx / sy（倍率）、flip（度）、z（圖層順序偏移）、op（透明度）
  //   參數：p.<參數名>（相對靜止值的差量，例如 p.angle）
  //   曲線（第三欄，屬於「從這格到下一格」這一段）：smooth 平滑（經過影格不停頓）、ease 緩動（舊影格沒有第三欄時）、linear、in、out、hold
  const KEY_TRACKS = { tx: 0, ty: 0, rot: 0, sc: 1, sx: 1, sy: 1, flip: 0, z: 0, op: 1 };
  const STEP_TRACKS = new Set(['z']);
  const trackDefault = tr => tr in KEY_TRACKS ? KEY_TRACKS[tr] : 0;
  const CURVES = ['smooth', 'ease', 'linear', 'in', 'out', 'hold'];
  // 循環上的時間差（a → b，0 < d ≤ 1）
  const cyc = (a, b) => { let d = b - a; while (d <= 0) d += 1; return d; };
  // 影格位置：存的是循環的 1/64 格；實際對齊到最近的一幀（改 BPM 時位置跟著循環走，不會跑掉）
  const snapU = (data, u) => { const T = totalOf(data); return Math.round(u * T) / T; };
  function keyVal(data, n, track, t) {
    const ks0 = n.keys && n.keys[track];
    if (!ks0 || !ks0.length) return trackDefault(track);
    if (ks0.length === 1) return ks0[0][1];
    const ks = ks0.map(k => [snapU(data, k[0]), k[1], k[2]]);
    const N = ks.length, u = Anim.mod(t, totalOf(data)) / totalOf(data);
    let i = N - 1;
    for (let k = 0; k < N; k++) if (ks[k][0] <= u) i = k;
    if (ks[0][0] > u) i = N - 1;
    const a = ks[i], b = ks[(i + 1) % N], type = a[2] || 'ease';
    if (STEP_TRACKS.has(track) || type === 'hold') return a[1];
    const span = cyc(a[0], b[0]);
    let d = u - a[0];
    if (d < 0) d += 1;
    const s = Math.max(0, Math.min(1, d / span));
    if (type === 'smooth') {
      // Hermite：每格的切線 = 前後兩格的斜率（循環），經過影格時速度連續、不會一格一格停頓
      const p = ks[(i - 1 + N) % N], q = ks[(i + 2) % N];
      const m0 = N > 2 ? (b[1] - p[1]) / cyc(p[0], b[0]) * span : 0, m1 = N > 2 ? (q[1] - a[1]) / cyc(a[0], q[0]) * span : 0;
      const s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * a[1] + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * b[1] + (s3 - s2) * m1;
    }
    const f = type === 'linear' ? s : type === 'in' ? s * s * s : type === 'out' ? 1 - (1 - s) ** 3 : easeFn(data.timeline.ease)(s);
    return a[1] + (b[1] - a[1]) * f;
  }
  // 參數的關鍵影格：靜止值 + 差量（單獨關閉的參數不疊加）
  function effT(data, n, t) {
    const E0 = eff(n.params);
    if (P3D.probe || !n.keys) return E0;
    let E = null;
    for (const tr in n.keys) {
      if (!tr.startsWith('p.') || !n.keys[tr].length) continue;
      const k = tr.slice(2);
      if (typeof E0[k] !== 'number' || (n.params.off && n.params.off[k])) continue;
      E = E || { ...E0 };
      E[k] = E0[k] + keyVal(data, n, tr, t);
    }
    return E || E0;
  }
  // 前後順序切換時自動短暫淡出（換順序的瞬間透明，不會跳一下）
  function zFade(data, n, t) {
    const ks = n.keys && n.keys.z;
    if (!ks || ks.length < 2) return 1;
    const u = Anim.mod(t, totalOf(data)) / totalOf(data), w = 1 / 40 / cyclesOf(data);
    let a = 1;
    for (let k = 0; k < ks.length; k++) {
      const prev = ks[(k - 1 + ks.length) % ks.length];
      if (prev[1] === ks[k][1]) continue;
      let d = Math.abs(u - snapU(data, ks[k][0])); d = Math.min(d, 1 - d);
      if (d < w) { const q = d / w; a = Math.min(a, q * q * (3 - 2 * q)); }
    }
    return a;
  }
  // HeadRig 的一幀：與頭的立體位移用同一個時間（含頭的延遲）
  function rigFrame(data, host, t) {
    const tt = t - delayOf(host) * unitOf(data);
    return HeadRig.frame(host.rig, P3D.driver(data, tt), HeadRig.boundsOf, host, P3D.settings(data).depth);
  }
  const hasKeys = n => !!n.keys && Object.values(n.keys).some(k => k && k.length);

  function makeDeformer(data, n, t, ctx, depth) {
    const motion = P3D.probe ? null : makeMotion(data, n, t, ctx, depth);
    const o3 = P3D.offset(data, n, t - delayOf(n) * unitOf(data), ctx.drv(t - delayOf(n) * unitOf(data)));
    const keyed = !P3D.probe && hasKeys(n);
    const kx = keyed ? keyVal(data, n, 'tx', t) : 0, ky = keyed ? keyVal(data, n, 'ty', t) : 0, kf = keyed ? keyVal(data, n, 'flip', t) : 0;
    const ksc = keyed ? keyVal(data, n, 'sc', t) : 1, kr = keyed ? keyVal(data, n, 'rot', t) : 0, ksx = keyed ? keyVal(data, n, 'sx', t) * ksc : 1, ksy = keyed ? keyVal(data, n, 'sy', t) * ksc : 1;
    const kxf = kr || ksx !== 1 || ksy !== 1;
    const PF = eff(n.params), flipDeg = kf + (!P3D.probe && n.enabled && PF.flipFreq ? 360 * PF.flipFreq * localT(data, n, t) / master(data) : 0);
    if (!o3 && !kx && !ky && !flipDeg && !kxf) return motion;
    const own = pivotOf(n), piv = own || root3dAxis(data);
    // 關鍵影格的旋轉 / 縮放 / 翻轉軸：部位的支點；沒有支點的圖層用建立影格時記下的中心
    const kp = own || n.keyPivot || piv, kc = Math.cos(kr * DEG), ks = Math.sin(kr * DEG);
    // 支點附近位移漸弱（與「支點柔化」相同距離），部位根部不會和父層撕開
    const Hh = own && n.region ? n.region.hinge ?? 0 : 0;
    const F = o3 && o3.face, FO = [0, 0];
    const FA = F ? (() => { const ax = F.chin.x - F.top.x, ay = F.chin.y - F.top.y, l = Math.hypot(ax, ay) || 1; return [ax / l, ay / l]; })() : null;
    const Hf = F ? (Hh > 0 ? Hh : F.R * 0.3) : 0;
    // 深度圖：每個點依塗抹程度取深度（有塗 = 淺、無塗 = 深）
    const map = o3 && o3.map, MW = data.width, MH = data.height;
    const relAt = map ? (x, y) => {
      const xi = Math.min(MW - 1, Math.max(0, Math.round(x))), yi = Math.min(MH - 1, Math.max(0, Math.round(y)));
      const m = map.obj.data[yi * MW + xi] / 255;
      return map.far + (map.near - map.far) * m - o3.pd;
    } : null;
    const fc = Math.cos(flipDeg * DEG), fa = (PF.flipAng || 0) * DEG, fux = Math.cos(fa), fuy = Math.sin(fa);
    return (x, y) => {
      if (motion) motion(x, y); else { OUT[0] = x; OUT[1] = y; }
      if (o3) {
        const w = Hh > 0 ? smooth(Math.hypot(x - piv.x, y - piv.y) / Hh) : 1;
        const dx = relAt ? relAt(x, y) * o3.cx : o3.dx, dy = relAt ? relAt(x, y) * o3.cy : o3.dy;
        if (F) {
          // 臉部：中線下端以上整片一致，往脖子漸弱
          const vv = (x - F.chin.x) * FA[0] + (y - F.chin.y) * FA[1];
          const wf = 1 - smooth(vv / Hf + 0.5);
          P3D.faceMap(F, o3, OUT[0], OUT[1], FO);
          OUT[0] += (FO[0] - OUT[0]) * wf + dx * wf;
          OUT[1] += (FO[1] - OUT[1]) * wf + dy * wf;
        } else {
          const sx = 1 + (o3.sx - 1) * w, sy = 1 + (o3.sy - 1) * w;
          OUT[0] = piv.x + (OUT[0] - piv.x) * sx + dx * w;
          OUT[1] = piv.y + (OUT[1] - piv.y) * sy + dy * w;
        }
      }
      // 關鍵影格：翻轉（以支點為軸，像翻書頁）→ 位移
      if (flipDeg) { const d = (OUT[0] - kp.x) * fux + (OUT[1] - kp.y) * fuy, e = d * (fc - 1); OUT[0] += e * fux; OUT[1] += e * fuy; }
      if (kxf) { const X = (OUT[0] - kp.x) * ksx, Y = (OUT[1] - kp.y) * ksy; OUT[0] = kp.x + X * kc - Y * ks; OUT[1] = kp.y + X * ks + Y * kc; }
      OUT[0] += kx; OUT[1] += ky;
      return OUT;
    };
  }
  const root3dAxis = data => byId(data, 'root').pins[0] || { x: data.width / 2, y: data.height / 2 };
  function makeMotion(data, n, t, ctx, depth) {
    const piv = pivotOf(n);
    if (!piv || !n.enabled) return null;
    const P = effT(data, n, t), o = overall(data, n, t);
    const hasPose = o.ang || o.sc !== 1 || o.sy !== 1 || o.tx || o.ty || o.sq;
    const pose = softPose(piv, o, n.region ? n.region.hinge ?? 0 : 0);
    const pts = n.pins, m = pts.length;
    const swing = m > 1 && (P.swayCurve ? P.swayCurve.freq : P.swayFreq) > 0 && P.amp > 0;
    const inertia = m > 1 && P.inertia > 0 && depth < 2 && n.parent;
    if (!swing && !inertia) {
      if (!hasPose) return null;
      return (x, y) => pose(x, y, OUT);
    }
    // 鏈：每個節點依序左右擺（垂直於鏈的方向），越往末端擺越大，相鄰節點延遲 → 可呈 S 形
    const k = data.intensity, sg = n.mirror ? -1 : 1, tt = localT(data, n, t), U = unitOf(data);
    const w = TAU * P.swayFreq / master(data);
    // 有曲線設定時：擺動用曲線（sin = 相位 0.75 的平滑曲線，圓度用再錯開 1/4 的曲線）
    const SC = P.swayCurve, SC2 = SC && { ...SC, phase: (SC.phase || 0) + 0.25 };
    const p = new Float64Array(m * 2), q = new Float64Array(m * 2);
    let total = 0;
    for (let i = 1; i < m; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const avg = total / Math.max(1, m - 1);
    const taper = Math.max(0, P.taper ?? 1);
    let arc = 0;
    for (let i = 0; i < m; i++) {
      const x = pts[i].x, y = pts[i].y;
      p[i * 2] = x; p[i * 2 + 1] = y;
      if (i === 0) { q[0] = x; q[1] = y; continue; }
      arc += Math.hypot(x - pts[i - 1].x, y - pts[i - 1].y);
      // 節點方向：前後兩段的平均
      const nx = i < m - 1 ? pts[i + 1].x - pts[i - 1].x : x - pts[i - 1].x;
      const ny = i < m - 1 ? pts[i + 1].y - pts[i - 1].y : y - pts[i - 1].y;
      const len = Math.hypot(nx, ny) || 1, ux = nx / len, uy = ny / len, px = -uy * sg, py = ux * sg;
      let dx = 0, dy = 0;
      if (swing) {
        const ph = w * (tt - P.lag * U * i);
        // 遠端增幅：擺幅隨節點往外累積的程度。0 = 各節點擺幅相同（整塊一起動），1 = 與距離成正比，2 = 累積加倍（末端更大）
        const a = arc > 0 ? P.amp * k * Math.max(0, avg + taper * (arc - avg)) : 0, tc = tt - P.lag * U * i;
        const s = (SC ? curveAt(data, SC, tc) : Math.sin(ph)) * a, c = (SC ? curveAt(data, SC2, tc) : Math.cos(ph)) * a * P.round;
        dx += px * s + ux * c; dy += py * s + uy * c;
      }
      // 自己的旋轉 / 縮放
      pose(x + dx, y + dy, TMP);
      let qx = TMP[0], qy = TMP[1];
      // 慣性：父層（含整體）在較早時間的移動，依節點距離延遲地帶動
      if (inertia) {
        const lagT = t - delayOf(n) * U - P.lag * U * i;
        const now = ctx.worldPoint(n.parent, t, x, y, depth + 1);
        const then = ctx.worldPoint(n.parent, lagT, x, y, depth + 1);
        qx += (then[0] - now[0]) * P.inertia * 0.5;
        qy += (then[1] - now[1]) * P.inertia * 0.5;
      }
      q[i * 2] = qx; q[i * 2 + 1] = qy;
    }
    const alpha = data.mesh.rigidity, H = Math.max(1, n.region ? n.region.hinge ?? 0 : 0), px0 = pts[0].x, py0 = pts[0].y;
    // 支點附近不跟著轉：位移量從支點往外逐漸增加
    return (x, y) => {
      mlsEval(p, q, m, alpha, x, y);
      const s = smooth(Math.hypot(x - px0, y - py0) / H);
      if (s < 1) { OUT[0] = x + (OUT[0] - x) * s; OUT[1] = y + (OUT[1] - y) * s; }
    };
  }

  const MW = new Float64Array(256);
  function mlsEval(p, q, m, alpha, x, y) {
    let sw = 0, px = 0, py = 0, qx = 0, qy = 0;
    for (let i = 0; i < m; i++) {
      const dx = p[i * 2] - x, dy = p[i * 2 + 1] - y;
      const wi = 1 / Math.pow(dx * dx + dy * dy + 1, alpha);
      MW[i] = wi; sw += wi;
      px += wi * p[i * 2]; py += wi * p[i * 2 + 1];
      qx += wi * q[i * 2]; qy += wi * q[i * 2 + 1];
    }
    px /= sw; py /= sw; qx /= sw; qy /= sw;
    const dx = x - px, dy = y - py;
    let fx = 0, fy = 0;
    for (let i = 0; i < m; i++) {
      const hx = p[i * 2] - px, hy = p[i * 2 + 1] - py;
      const a = MW[i] * (hx * dx + hy * dy), b = MW[i] * (hx * dy - hy * dx);
      const gx = q[i * 2] - qx, gy = q[i * 2 + 1] - qy;
      fx += gx * a - gy * b; fy += gx * b + gy * a;
    }
    const len = Math.hypot(fx, fy), dl = Math.hypot(dx, dy);
    if (len > 1e-9) { OUT[0] = qx + fx * dl / len; OUT[1] = qy + fy * dl / len; }
    else { OUT[0] = qx + dx; OUT[1] = qy + dy; }
  }

  // 變形函式延遲建立（慣性求父層位置時只建需要的部分）
  function buildEvalsInner(data, t, animate, ctx, depth) {
    const evals = new Map();
    for (const n of data.nodes) {
      evals.set(n.id, {
        parent: null, _D: undefined,
        get D() {
          if (this._D === undefined) this._D = animate && n.type !== 'root' ? makeDeformer(data, n, t, ctx, depth) : null;
          return this._D;
        },
      });
    }
    for (const n of data.nodes) evals.get(n.id).parent = n.parent ? evals.get(n.parent) || null : null;
    // 依循父層的指定錨點（n.follow = 父層錨點 id）：整個子層只跟著那個錨點的位移平移，不被父層的變形拉扯
    for (const n of data.nodes) {
      if (!n.follow || !animate) continue;
      const par = n.parent && byId(data, n.parent), pin = par && par.pins.find(p => p.id === n.follow), pe = par && evals.get(par.id);
      if (!pin || !pe) continue;
      let dx = null, dy = 0;
      evals.get(n.id).parent = {
        parent: null,
        D: (x, y) => {
          if (dx === null) { const o = applyChain(pe, pin.x, pin.y); dx = o[0] - pin.x; dy = o[1] - pin.y; }
          OUT[0] = x + dx; OUT[1] = y + dy;
          return OUT;
        },
      };
    }
    return evals;
  }
  function buildEvals(data, t, animate) {
    const ctx = makeCtx(data);
    return buildEvalsInner(data, t, animate, ctx, 0);
  }
  function applyChain(e, x, y) {
    let cx = x, cy = y;
    while (e) {
      const D = e.D;
      if (D) { D(cx, cy); cx = OUT[0]; cy = OUT[1]; }
      e = e.parent;
    }
    OUT[0] = cx; OUT[1] = cy;
    return OUT;
  }

  // ---------- 整體節點 ----------
  function globalCurves(data, t) {
    const G = effT(data, byId(data, 'root'), t), C = globalCurveSpecs(data, G);
    return {
      xk: curveAt(data, C.x, t),
      yk: curveAt(data, C.y, t),
    };
  }
  function globalAffine(data, t) {
    const root = byId(data, 'root'), G = effT(data, root, t), piv = root.pins[0];
    if (!G.enabled || !piv) return I;
    const k = data.intensity, { xk, yk } = globalCurves(data, t);
    const m = aAbout(piv.x, piv.y, G.rot * k * xk * DEG, 1 + G.squash * k * yk, 1 - G.squash * k * yk);
    m[4] += G.sway * k * data.width * xk;
    m[5] += G.bounce * k * data.height * yk;
    return m;
  }

  function variantAt(n, t) {
    const vs = (n.image && n.image.variants) || [];
    for (let i = 0; i < vs.length; i++) if (t >= vs[i].from && t < vs[i].to) return i + 1;
    return 0;
  }

  function warnings(data, n) {
    const w = [];
    if (['root', 'image', 'group'].includes(n.type)) return w;
    const leads = [...descendants(data, n.id)].some(id => { const c = byId(data, id); return c && c.type === 'image'; });
    if (!pivotOf(n)) w.push('尚未放置支點（錨點工具點第一下）');
    if (n.region.mode === 'auto' && !n.pins.length && !leads) w.push('沒有範圍：請放錨點或畫遮罩');
    if (!imageOf(data, n) && !leads) w.push('不在任何圖層底下，也沒有帶動任何圖層');
    const P = n.params;
    if (((P.swayFreq > 0 && P.amp > 0) || P.inertia > 0) && n.pins.length < 3) w.push('鍊的擺動建議至少 1 個支點＋2 個運動點');
    return w;
  }

  // ---------- 整體動作組（套用到頭、軀幹與整體） ----------
  const PRESETS = {
    bounce: { label: 'Q彈', global: { enabled: true, bounce: 0.012, sway: 0.01, rot: 1.2, squash: 0.02, yMode: 'cycle' }, head: { angle: 4, shape: 'swing', move: 0 }, torso: { breath: 0 } },
    nod:    { label: '點頭', global: { enabled: true, bounce: 0.004, sway: 0, rot: 0, squash: 0.008, yMode: 'cycle' }, head: { angle: 2, shape: 'bounce', move: 0.012, moveAng: 0 }, torso: { breath: 0.006 } },
    sway:   { label: '搖擺', global: { enabled: true, bounce: 0.003, sway: 0.015, rot: 2.5, squash: 0.005, yMode: 'cycle' }, head: { angle: 6, shape: 'swing-sine', move: 0 }, torso: { breath: 0.004 } },
    // 待機：原本的「自然呼吸」（舊的「靜止待機」幾乎一樣，併進來）
    idle:   { label: '待機', global: { enabled: false, bounce: 0, sway: 0, rot: 0, squash: 0, yMode: 'cycle' }, head: { angle: 1.5, shape: 'swing-sine', move: 0 }, torso: { breath: 0.012 } },
  };
  function applyPreset(data, key) {
    const pr = PRESETS[key];
    if (!pr) return;
    data.preset = key;
    Object.assign(byId(data, 'root').params, pr.global);
    delete byId(data, 'root').params.xCurve; delete byId(data, 'root').params.yCurve;
    for (const n of data.nodes) {
      if (n.type === 'head') { Object.assign(n.params, pr.head); delete n.params.curve; }   // 動作組用它自己的旋轉曲線
      if (n.type === 'torso') Object.assign(n.params, pr.torso);
    }
  }

  return {
    I, aMul, aApply, aInv, aAbout, SHAPES, TYPES, ADD_TYPES, PRESETS, uid, newData, makeNode, defaultRegion,
    byId, children, descendants, isDrawable, imageOf, isShown, participants,
    pivotOf, movers, master, regionFields, allocate, polyDist,
    buildEvals, applyChain, migrate, keyVal, zFade, hasKeys, KEY_TRACKS, spanOf, unitOf, bpmOf, globalCurves, globalAffine, variantAt, warnings, applyPreset, cyclesOf, totalOf, rigFrame, CURVES, trackDefault, baseType, TYPE_MENU, CURVE_SHAPES, partCurve, globalCurveSpecs, curveAt, loopIssues, loopMul, uniqueName, snapU,
  };
})();
