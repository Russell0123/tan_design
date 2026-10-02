// 範例：紫髮女孩（使用者提供）、貓耳角色（程式繪製）
const Demo = (() => {
  const W = 800, H = 820;
  const OUT = '#3b2a20', HAIR = '#7a4a2c', HAIR_HI = '#9a6340', SKIN = '#ffe3c8', CLOTH = '#7c9cff', CLOTH_HI = '#a9bdff';
  const TAIL_PATH = g => { g.beginPath(); g.moveTo(520, 650); g.bezierCurveTo(650, 670, 680, 520, 615, 440); };

  function drawCat() {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.lineJoin = 'round'; g.lineCap = 'round';
    const stroke = (w = 6) => { g.lineWidth = w; g.strokeStyle = OUT; g.stroke(); };

    TAIL_PATH(g);
    g.lineWidth = 42; g.strokeStyle = OUT; g.stroke();
    g.lineWidth = 30; g.strokeStyle = HAIR; g.stroke();

    for (const x of [330, 415]) { g.beginPath(); g.roundRect(x, 690, 56, 100, 22); g.fillStyle = SKIN; g.fill(); stroke(); }
    g.beginPath(); g.ellipse(400, 610, 140, 150, 0, 0, Math.PI * 2); g.fillStyle = CLOTH; g.fill(); stroke();
    g.beginPath(); g.ellipse(400, 640, 72, 82, 0, 0, Math.PI * 2); g.fillStyle = CLOTH_HI; g.fill();

    for (const s of [-1, 1]) {
      const x0 = 400 + s * 100, x1 = 400 + s * 195;
      g.beginPath(); g.moveTo(x0, 530); g.lineTo(x1, 635);
      g.lineWidth = 58; g.strokeStyle = OUT; g.stroke();
      g.lineWidth = 46; g.strokeStyle = SKIN; g.stroke();
      g.beginPath(); g.arc(x1 - s * 5, 640, 30, 0, Math.PI * 2); g.fillStyle = SKIN; g.fill(); stroke();
    }
    for (const s of [-1, 1]) {
      const X = x => 400 + s * (x - 400);
      g.beginPath(); g.moveTo(X(265), 235); g.lineTo(X(245), 70); g.lineTo(X(372), 172); g.closePath();
      g.fillStyle = HAIR; g.fill(); stroke();
      g.beginPath(); g.moveTo(X(282), 210); g.lineTo(X(265), 110); g.lineTo(X(345), 178); g.closePath();
      g.fillStyle = '#ffb3c7'; g.fill();
    }
    g.beginPath(); g.arc(400, 330, 165, 0, Math.PI * 2); g.fillStyle = SKIN; g.fill();
    g.save();
    g.beginPath(); g.arc(400, 330, 165, 0, Math.PI * 2); g.clip();
    g.beginPath(); g.moveTo(200, 120); g.lineTo(600, 120); g.lineTo(600, 280);
    for (const [x, y] of [[565, 300], [530, 250], [490, 290], [450, 245], [400, 285], [350, 245], [310, 290], [270, 250], [235, 300], [200, 280]]) g.lineTo(x, y);
    g.closePath(); g.fillStyle = HAIR; g.fill();
    g.restore();
    g.beginPath(); g.arc(400, 330, 165, 0, Math.PI * 2); stroke();

    g.beginPath(); g.moveTo(400, 172); g.bezierCurveTo(390, 110, 470, 100, 440, 60);
    g.lineWidth = 20; g.strokeStyle = OUT; g.stroke();
    g.lineWidth = 11; g.strokeStyle = HAIR; g.stroke();

    for (const s of [-1, 1]) {
      const X = x => 400 + s * (x - 400);
      g.beginPath(); g.moveTo(X(236), 245);
      g.quadraticCurveTo(X(190), 400, X(212), 540);
      g.quadraticCurveTo(X(230), 420, X(285), 270);
      g.closePath(); g.fillStyle = HAIR; g.fill(); stroke(5);
      g.beginPath(); g.moveTo(X(240), 300); g.quadraticCurveTo(X(214), 400, X(214), 480);
      g.lineWidth = 4; g.strokeStyle = HAIR_HI; g.stroke();
    }
    for (const s of [-1, 1]) {
      g.beginPath(); g.ellipse(400 + s * 60, 362, 17, 25, 0, 0, Math.PI * 2); g.fillStyle = '#2b1d16'; g.fill();
      g.beginPath(); g.arc(400 + s * 60 + 6, 352, 6, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
      g.beginPath(); g.ellipse(400 + s * 100, 405, 24, 13, 0, 0, Math.PI * 2); g.fillStyle = 'rgba(255,120,140,.45)'; g.fill();
    }
    g.beginPath(); g.moveTo(382, 402); g.quadraticCurveTo(391, 414, 400, 403); g.quadraticCurveTo(409, 414, 418, 402);
    g.lineWidth = 4; g.strokeStyle = OUT; g.stroke();
    return c;
  }

  function buildCat(api) {
    const img = api.image;
    img.name = '貓耳角色';
    const torso = api.addPart('torso', '軀幹', img.id, [[400, 780]]);
    api.paintMask(torso, g => {
      g.beginPath(); g.ellipse(400, 610, 142, 152, 0, 0, Math.PI * 2); g.fill();
      g.fillRect(325, 680, 150, 118);
    });
    torso.region.feather = 12;
    const head = api.addPart('head', '頭', torso.id, [[400, 490]]);
    api.paintMask(head, g => { g.beginPath(); g.arc(400, 330, 172, 0, Math.PI * 2); g.fill(); });
    head.region.feather = 40;
    // 耳朵：三角形遮罩
    const ear = (name, pins, s, mirror) => {
      const n = api.addPart('ear', name, head.id, pins, { mirror, delay: mirror ? 2 : 0 });
      const X = x => 400 + s * (x - 400);
      api.paintMask(n, g => {
        g.beginPath(); g.moveTo(X(262), 245); g.lineTo(X(240), 58); g.lineTo(X(382), 170); g.closePath();
        g.lineWidth = 14; g.fill(); g.stroke();
      });
      n.region.feather = 16;
    };
    ear('左耳', [[318, 205], [262, 100]], 1, false);
    ear('右耳', [[482, 205], [538, 100]], -1, true);
    const ah = api.addPart('hair', '呆毛', head.id, [[400, 170], [406, 134], [427, 108], [445, 86], [440, 62]], { params: { amp: 0.07, lag: 2 } });
    api.paintMask(ah, g => {
      g.beginPath(); g.moveTo(400, 172); g.bezierCurveTo(390, 110, 470, 100, 440, 60);
      g.lineWidth = 30; g.stroke();
      g.globalCompositeOperation = 'destination-out';
      g.beginPath(); g.arc(400, 330, 158, 0, Math.PI * 2); g.fill();
    });
    ah.region.feather = 6;
    const lock = (name, pins, mirror) => {
      const n = api.addPart('hair', name, head.id, pins, { mirror, delay: mirror ? 2 : 0 });
      n.region.radius = 26; n.region.feather = 24;
    };
    lock('左髮束', [[252, 290], [225, 390], [214, 470], [211, 528]], false);
    lock('右髮束', [[548, 290], [575, 390], [586, 470], [589, 528]], true);
    const arm = (name, pins, mirror) => {
      const n = api.addPart('arm', name, torso.id, pins, { mirror, params: { angle: 6 } });
      n.region.radius = 34; n.region.feather = 20;
    };
    arm('左手', [[300, 530], [250, 588], [203, 640]], false);
    arm('右手', [[500, 530], [550, 588], [597, 640]], true);
    // 尾巴：遮罩切成獨立圖層，放在身體後方
    const tail = api.addPart('tail', '尾巴', torso.id, [[528, 652], [620, 619], [648, 524], [615, 442]], { detach: true, order: img.order - 0.5 });
    api.paintMask(tail, g => {
      TAIL_PATH(g); g.lineWidth = 46; g.stroke();
      g.globalCompositeOperation = 'destination-out';
      g.beginPath(); g.ellipse(400, 610, 138, 148, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(500, 530); g.lineTo(595, 635); g.lineWidth = 62; g.stroke();
      g.beginPath(); g.arc(590, 640, 36, 0, Math.PI * 2); g.fill();
      // 右髮束也在尾巴前面
      g.beginPath(); g.moveTo(564, 245); g.quadraticCurveTo(610, 400, 588, 540); g.quadraticCurveTo(570, 420, 515, 270); g.closePath();
      g.lineWidth = 12; g.fill(); g.stroke();
    });
    tail.region.feather = 0;
  }

  function buildGirl(api) {
    const img = api.image;
    img.name = '紫髮女孩';
    const torso = api.addPart('torso', '軀幹與平板', img.id, [[250, 452]]);
    api.paintMask(torso, g => { g.beginPath(); g.moveTo(170, 336); g.lineTo(330, 336); g.lineTo(400, 400); g.lineTo(400, 470); g.lineTo(120, 470); g.lineTo(120, 380); g.closePath(); g.fill(); });
    torso.region.feather = 8;
    const head = api.addPart('head', '頭', torso.id, [[238, 338]]);
    api.paintMask(head, g => {
      g.beginPath();
      const pts = [[92, 250], [108, 160], [160, 92], [235, 66], [308, 76], [368, 122], [396, 196], [386, 245], [372, 300], [336, 320], [292, 322], [240, 340], [192, 324], [150, 306], [100, 300]];
      pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
      g.closePath(); g.fill();
    });
    head.region.feather = 30;
    const side = (name, pins, radius, mirror) => {
      const n = api.addPart('hair', name, head.id, pins, { mirror, delay: mirror ? 3 : 0 });
      n.region.radius = radius; n.region.feather = 34;
      return n;
    };
    side('左側髮', [[130, 215], [100, 262], [80, 300], [100, 338]], 34, false);
    side('右側髮', [[345, 230], [355, 280], [345, 330], [330, 365]], 30, true);
    const flip = api.addPart('hair', '右上髮翹', head.id, [[365, 190], [374, 208], [382, 228]], { delay: 3, params: { amp: 0.06, gravity: 0 } });
    flip.region.radius = 16; flip.region.feather = 18;
    const hand = api.addPart('arm', '拿筆的手', torso.id, [[160, 425], [155, 385], [162, 350]], { params: { angle: 6 } });
    hand.region.radius = 28; hand.region.feather = 14;
    Object.assign(api.data.nodes.find(n => n.id === 'root').params, { bounce: 0.01, sway: 0.008, rot: 1, squash: 0.015 });
  }

  // 立體範例：俯視角，頭最近、腿最遠
  function buildWhite(api) {
    const img = api.image, poly = pts => g => { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); };
    img.name = '白髮女孩';
    const set3d = (n, depth, squash = 0) => { n.p3d = { depth, squashX: squash, squashY: squash }; };
    const torso = api.addPart('torso', '軀幹', img.id, [[290, 690]]);
    api.paintMask(torso, poly([[30, 380], [130, 335], [330, 335], [490, 345], [475, 490], [390, 600], [400, 705], [150, 715], [60, 500]]));
    torso.region.feather = 20; set3d(torso, 0, 0.3);
    // 下垂的手（放在腿前面先分配，袖子不會被腿搶走）
    const armL = api.addPart('arm', '垂下的手', torso.id, [[110, 470], [190, 700], [250, 900]], { params: { angle: 2 } });
    armL.region.radius = 40; armL.region.feather = 20; set3d(armL, 0.15);
    const legs = api.addPart('leg', '腿', torso.id, [[290, 720], [285, 860], [275, 990]]);
    api.paintMask(legs, poly([[150, 700], [400, 690], [395, 850], [360, 1027], [220, 1027], [170, 850]]));
    legs.region.feather = 30; set3d(legs, -0.6);
    const head = api.addPart('head', '頭', torso.id, [[274, 348]], { params: { angle: 0 } });
    // 舉起的手貼在頭上：掛在頭底下跟著臉部曲面走；肩膀在下巴以下，不受頭影響
    const armR = api.addPart('arm', '扶頭的手', head.id, [[450, 430], [595, 450], [490, 200], [395, 90]], { params: { angle: 0 } });
    api.paintMask(armR, poly([[335, 50], [420, 42], [470, 95], [472, 150], [530, 245], [600, 355], [634, 420], [612, 492], [540, 498], [470, 475], [430, 425], [440, 365], [468, 330], [452, 250], [428, 192], [380, 150], [335, 122]]));
    armR.region.feather = 16; set3d(armR, 0.5);
    api.paintMask(head, g => { g.beginPath(); g.ellipse(250, 190, 215, 175, 0, 0, Math.PI * 2); g.fill(); });
    head.region.feather = 26; set3d(head, 0.5, 0.5);
    // 臉部精細：中線從額頭到下巴
    head.p3d.face = { on: true, cx: 264, cy: 194, R: 278, Fw: 171, Rv: 175, top: { x: 282, y: 122 }, chin: { x: 276, y: 351 }, side: 0.35, curve: 0.3, persp: 0 };
    const bangs = api.addPart('fronthair', '瀏海', head.id, [[265, 65], [262, 140], [270, 205]]);
    api.paintMask(bangs, poly([[150, 70], [380, 60], [425, 160], [405, 240], [300, 190], [250, 205], [175, 245], [140, 160]]));
    bangs.region.feather = 22; set3d(bangs, 0.65);
    const lockL = api.addPart('hair', '左側髮', head.id, [[130, 130], [92, 210], [68, 290]]);
    lockL.region.radius = 34; lockL.region.feather = 24; set3d(lockL, 0.55);
    const lockR = api.addPart('hair', '右側髮', head.id, [[400, 175], [410, 240], [398, 292]], { mirror: true, delay: 2 });
    lockR.region.radius = 26; lockR.region.feather = 20; set3d(lockR, 0.55);
    Object.assign(api.data.nodes.find(n => n.id === 'root').params, { bounce: 0.008, sway: 0.006, rot: 0.8, squash: 0.012 });
    api.data.p3d = { ...P3D.DEFAULT, enabled: true, yaw: 13.5, pitch: 2, pitchPhase: 8, depth: 0.8 };
  }

  // 分層範例：自動綁定後再微調
  function buildWhitePsd(api) {
    api.autoBind();
    const nodes = api.data.nodes, by = name => nodes.find(n => n.name === name);
    // 扶頭的手：收進頭群組，手掌跟著臉部曲面走（肩膀在下巴以下，不受頭影響）
    const head = nodes.find(n => n.role === 'head'), arm = by('手臂'), armPart = by('手臂（擺動）');
    if (head && arm) arm.parent = head.id;
    if (armPart) armPart.params.angle = 0;
    // 調整過的深度與臉部設定
    const depth = { 手臂: 0.4, 前髮: 0.45, 後髪: 0, 五官: 0.3, 身體: 0, 腿: -0.3 };
    for (const [k, v] of Object.entries(depth)) { const n = nodes.find(x => x.name === k && x.type === 'image'); if (n) n.p3d.depth = v; }
    if (head) {
      head.p3d.depth = 0.15;
      head.pins = [{ id: 'pin_headgrp', x: 446, y: 447, kind: 'fixed' }];
      head.p3d.face = { on: true, cx: 408, cy: 275, R: 221, Fw: 146, Rv: 418, top: { x: 439, y: 238 }, chin: { x: 434, y: 488 }, side: 0.35, curve: 0.3, persp: 0.05 };
    }
    const S = api.data.p3d;
    Object.assign(S, { enabled: true, yaw: 11.5, pitch: 3, pitchPhase: 8, depth: 0.6 });
    // 頭部骨架（HeadRig）：五官畫在臉圖層上（baked）
    if (head) api.createRig(head);
    Object.assign(api.data.nodes.find(n => n.id === 'root').params, { bounce: 0.008, sway: 0.006, rot: 0.8, squash: 0.012 });
  }

  function loadImage(src) {
    return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = src; });
  }

  const samples = {
    girl: { label: '紫髮女孩（單層 Q 版）', source: () => loadImage(SAMPLE_GIRL_PNG), build: buildGirl },
    whitePsd: { label: '白髮女孩（分層・立體）', psd: true, source: async () => Uint8Array.from(atob(SAMPLE_WHITE_PSD), c => c.charCodeAt(0)).buffer, build: buildWhitePsd },
    blink: { label: '棕髮女孩（眨眼）', project: true, source: async () => Uint8Array.from(atob(SAMPLE_BLINK_PROJECT), c => c.charCodeAt(0)).buffer },
  };
  return { samples };
})();
