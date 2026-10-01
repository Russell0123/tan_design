// 時間系統：循環模式（cycle / pingpong）、關鍵幀插值與 Easy Ease 緩動
const Anim = (() => {
  const mod = (a, n) => ((a % n) + n) % n;

  // cycle：週期 = span；pingpong：往復，週期 = 2 × span
  function loopT(t, span, mode) {
    if (mode === 'pingpong') {
      const m = mod(t, 2 * span);
      return m <= span ? m : 2 * span - m;
    }
    return mod(t, span);
  }

  // 三次貝茲緩動（與 CSS cubic-bezier 相同定義），用二分法求解，穩定且無外部依賴
  function bezier(x1, y1, x2, y2) {
    const bx = t => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
    const by = t => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
    return x => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let lo = 0, hi = 1;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if (bx(mid) < x) lo = mid; else hi = mid;
      }
      return by((lo + hi) / 2);
    };
  }

  // influence：AE Easy Ease 預設約 33%
  const easeCache = new Map();
  function easeFn(influence) {
    const key = Math.round(influence * 1000) / 1000;
    if (!easeCache.has(key)) {
      easeCache.set(key, key <= 0.001 ? (x => x) : bezier(key, 0, 1 - key, 1));
    }
    return easeCache.get(key);
  }

  // keys: [[u, value], ...]，u 為 0..1 的正規化時間（乘上 span 即為幀數）
  function evalKeys(keys, u, ease) {
    if (u <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [u1, v1] = keys[i];
      if (u <= u1) {
        const [u0, v0] = keys[i - 1];
        return v0 + (v1 - v0) * ease((u - u0) / (u1 - u0));
      }
    }
    return keys[keys.length - 1][1];
  }

  // 預設曲線形狀（值為 -1..1 的倍率）
  const SHAPES = {
    swing:   [[0, 1], [1, -1]],                 // 0 幀與 30 幀相反方向（手臂、頭）
    bounce:  [[0, 1], [2 / 3, -0.35], [1, 1]],  // 0 下壓、20 微抬、30 同 0（耳朵）
    gravity: [[0, 0], [2 / 3, 1], [1, 0]],      // 頭髮縮放 100% → 103% → 100%
    bounceY: [[0, 1], [2 / 3, -1], [1, 1]],     // 整體 Y：0 下、20 上、30 下
  };

  return { mod, loopT, bezier, easeFn, evalKeys, SHAPES };
})();
