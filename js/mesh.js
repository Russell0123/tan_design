// 網格生成：依透明度找出有內容的格子（外擴 1 格避免邊緣被裁切），切成三角形
const Mesh = (() => {
  function build(alpha, w, h, density) {
    const step = Math.max(w, h) / density;
    const cols = Math.ceil(w / step), rows = Math.ceil(h / step);
    const occ = new Uint8Array(cols * rows);

    for (let y = 0; y < h; y += 2) {
      const cy = Math.min(rows - 1, Math.floor(y / step));
      for (let x = 0; x < w; x += 2) {
        if (alpha[y * w + x] > 8) occ[cy * cols + Math.min(cols - 1, Math.floor(x / step))] = 1;
      }
    }

    // 外擴一格（8 鄰域）
    const dil = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      if (!occ[j * cols + i]) continue;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj;
        if (a >= 0 && b >= 0 && a < cols && b < rows) dil[b * cols + a] = 1;
      }
    }

    const vmap = new Int32Array((cols + 1) * (rows + 1)).fill(-1);
    const pos = [], uv = [], idx = [];
    const vert = (i, j) => {
      const k = j * (cols + 1) + i;
      if (vmap[k] < 0) {
        const x = Math.min(i * step, w), y = Math.min(j * step, h);
        vmap[k] = pos.length / 2;
        pos.push(x, y);
        uv.push(x / w, y / h);
      }
      return vmap[k];
    };

    const edges = new Set();
    const edge = (a, b) => edges.add(a < b ? a * 65536 + b : b * 65536 + a);

    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      if (!dil[j * cols + i]) continue;
      const tl = vert(i, j), tr = vert(i + 1, j), bl = vert(i, j + 1), br = vert(i + 1, j + 1);
      idx.push(tl, tr, bl, tr, br, bl);
      edge(tl, tr); edge(tr, br); edge(br, bl); edge(bl, tl); edge(tr, bl);
    }

    const edgeArr = new Uint16Array(edges.size * 2);
    let e = 0;
    for (const k of edges) { edgeArr[e++] = Math.floor(k / 65536); edgeArr[e++] = k % 65536; }

    return {
      rest: new Float32Array(pos),
      uv: new Float32Array(uv),
      idx: new Uint16Array(idx),
      edges: edgeArr,
      vertexCount: pos.length / 2,
      triCount: idx.length / 3,
    };
  }
  return { build };
})();
