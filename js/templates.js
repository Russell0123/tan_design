// 公版骨架（Q版）：以「頭部橢圓」為基準，套上 軀幹 → 頭 → 側髮 / 後髮 / 呆毛（/ 獸耳）
const Templates = (() => {
  const OPTS = { sideHair: true, backHair: true, ahoge: true, ears: false };
  const OPT_LABELS = { sideHair: '左右側髮', backHair: '左右後髮', ahoge: '呆毛', ears: '獸耳' };

  function guess(b) {
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const ry = bh * 0.3, rx = Math.min(bw * 0.45, ry * 1.25);
    return { cx: b.x0 + bw / 2, cy: b.y0 + ry * 1.02, rx, ry, bottom: b.y1, x0: b.x0, x1: b.x1 };
  }

  function spec(f, opts) {
    const { cx, cy, rx, ry } = f;
    const chin = cy + ry * 0.97;
    const out = [
      { key: 'torso', type: 'torso', name: '軀幹', parent: null, pins: [[cx, f.bottom - 2]],
        poly: [[f.x0 - 4, chin - ry * 0.05], [f.x1 + 4, chin - ry * 0.05], [f.x1 + 4, f.bottom + 4], [f.x0 - 4, f.bottom + 4]], feather: rx * 0.08 },
      { key: 'head', type: 'head', name: '頭', parent: 'torso', pins: [[cx, chin]], ellipse: [cx, cy, rx * 1.05, ry * 1.04], feather: rx * 0.25 },
    ];
    if (opts.sideHair) for (const s of [-1, 1]) out.push({
      type: 'hair', name: s < 0 ? '左側髮' : '右側髮', parent: 'head', mirror: s > 0, delay: s > 0 ? 3 : 0, radius: rx * 0.13,
      pins: [[cx + s * rx * 0.72, cy - ry * 0.1], [cx + s * rx * 0.82, cy + ry * 0.4], [cx + s * rx * 0.86, cy + ry * 0.85], [cx + s * rx * 0.84, cy + ry * 1.12]],
    });
    if (opts.backHair) for (const s of [-1, 1]) out.push({
      type: 'backhair', name: s < 0 ? '左後髮' : '右後髮', parent: 'head', mirror: s > 0, delay: s > 0 ? 2 : 0, radius: rx * 0.13,
      pins: [[cx + s * rx * 0.97, cy + ry * 0.1], [cx + s * rx * 1.03, cy + ry * 0.6], [cx + s * rx * 1.07, cy + ry * 1.1], [cx + s * rx * 1.08, cy + ry * 1.45]],
    });
    if (opts.ahoge) out.push({
      type: 'hair', name: '呆毛', parent: 'head', radius: rx * 0.06, params: { amp: 0.08, lag: 2 },
      pins: [[cx, cy - ry * 0.95], [cx + rx * 0.04, cy - ry * 1.12], [cx + rx * 0.12, cy - ry * 1.28]],
    });
    if (opts.ears) for (const s of [-1, 1]) out.push({
      type: 'ear', name: s < 0 ? '左耳' : '右耳', parent: 'head', mirror: s > 0, delay: s > 0 ? 2 : 0, feather: rx * 0.1,
      pins: [[cx + s * rx * 0.52, cy - ry * 0.72], [cx + s * rx * 0.7, cy - ry * 1.25]],
      poly: [[cx + s * rx * 0.22, cy - ry * 0.8], [cx + s * rx * 0.72, cy - ry * 1.38], [cx + s * rx * 0.9, cy - ry * 0.45]],
    });
    return out;
  }

  // api: { image, addPart(type,name,parentId,pins,extra), paintMask(node,painter) }
  function apply(api, f, opts) {
    const made = {};
    let head = null;
    for (const s of spec(f, opts)) {
      const parent = s.parent ? made[s.parent].id : api.image.id;
      const extra = { mirror: !!s.mirror, delay: s.delay || 0 };
      if (s.params) extra.params = s.params;
      const n = api.addPart(s.type, s.name, parent, s.pins, extra);
      if (s.radius) n.region.radius = Math.round(s.radius);
      if (s.feather) n.region.feather = Math.round(s.feather);
      if (s.ellipse) {
        const [ex, ey, erx, ery] = s.ellipse;
        api.paintMask(n, g => { g.beginPath(); g.ellipse(ex, ey, erx, ery, 0, 0, Math.PI * 2); g.fill(); });
      }
      if (s.poly) api.paintMask(n, g => { g.beginPath(); s.poly.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); });
      if (s.key) made[s.key] = n;
      if (s.type === 'head') head = n;
    }
    return head;
  }

  return { OPTS, OPT_LABELS, guess, spec, apply };
})();
