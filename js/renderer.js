// 原生 WebGL 渲染：多個繪製物件（圖層 / 獨立部位），每個有自己的網格與貼圖（含差分）
// 另有「範圍預覽」著色：依每個頂點的權重，把選取部位的影響範圍疊上顏色。
const Renderer = (() => {
  const VS = `
    attribute vec2 aPos; attribute vec2 aUV; attribute float aW;
    uniform mat3 uM; varying vec2 vUV; varying float vW;
    void main() { vec3 p = uM * vec3(aPos, 1.0); gl_Position = vec4(p.xy, 0.0, 1.0); vUV = aUV; vW = aW; }`;
  const FS_TEX = `
    precision mediump float; uniform sampler2D uTex; uniform float uAlpha; varying vec2 vUV; varying float vW;
    void main() { gl_FragColor = texture2D(uTex, vUV) * uAlpha; }`;
  // 剪裁遮色片：只畫在遮罩畫面（底層圖層變形後的樣子）有 alpha 的地方（Live2D 的做法：遮罩先畫到暫存畫面）
  const FS_CLIP = `
    precision mediump float; uniform sampler2D uTex; uniform sampler2D uMask; uniform vec2 uSize; uniform float uAlpha; varying vec2 vUV; varying float vW;
    void main() { gl_FragColor = texture2D(uTex, vUV) * uAlpha * texture2D(uMask, gl_FragCoord.xy / uSize).a; }`;
  // 進階混合模式：先把目前畫好的內容複製成「底圖」，再用公式算（W3C / Photoshop 的合成公式，預乘 alpha）
  const BLEND_ID = { multiply: 1, screen: 2, add: 3, overlay: 4, softlight: 5, hardlight: 6, colordodge: 7, colorburn: 8, darken: 9, lighten: 10, difference: 11, exclusion: 12, linearburn: 13, linearlight: 14, subtract: 15, divide: 16, vividlight: 17 };
  const FS_ADV = `
    precision highp float;
    uniform sampler2D uTex; uniform sampler2D uBack; uniform sampler2D uMask; uniform vec2 uSize; uniform float uAlpha; uniform int uMode; uniform float uUseMask;
    varying vec2 vUV; varying float vW;
    float ch(float b, float s) {
      if (uMode == 1) return b * s;
      if (uMode == 2) return b + s - b * s;
      if (uMode == 3) return min(1.0, b + s);
      if (uMode == 4) return b <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
      if (uMode == 5) { float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b); return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b); }
      if (uMode == 6) return s <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
      if (uMode == 7) return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s));
      if (uMode == 8) return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s);
      if (uMode == 9) return min(b, s);
      if (uMode == 10) return max(b, s);
      if (uMode == 11) return abs(b - s);
      if (uMode == 12) return b + s - 2.0 * b * s;
      if (uMode == 13) return max(0.0, b + s - 1.0);
      if (uMode == 14) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
      if (uMode == 15) return max(0.0, b - s);
      if (uMode == 16) return s <= 0.0 ? 1.0 : min(1.0, b / s);
      if (uMode == 17) return s <= 0.5 ? (s <= 0.0 ? 0.0 : max(0.0, 1.0 - (1.0 - b) / (2.0 * s))) : (s >= 1.0 ? 1.0 : min(1.0, b / (2.0 * (1.0 - s))));
      return s;
    }
    void main() {
      vec2 sc = gl_FragCoord.xy / uSize;
      vec4 src = texture2D(uTex, vUV) * uAlpha;
      if (uUseMask > 0.5) src *= texture2D(uMask, sc).a;
      vec4 dst = texture2D(uBack, sc);
      float as = src.a, ab = dst.a;
      vec3 cs = as > 0.0 ? src.rgb / as : vec3(0.0), cb = ab > 0.0 ? dst.rgb / ab : vec3(0.0);
      vec3 bl = vec3(ch(cb.r, cs.r), ch(cb.g, cs.g), ch(cb.b, cs.b));
      vec3 co = (1.0 - ab) * cs * as + (1.0 - as) * cb * ab + as * ab * bl;
      gl_FragColor = vec4(co, as + ab - as * ab);
    }`;
  const FS_W = `
    precision mediump float; uniform sampler2D uTex; uniform vec3 uColor; uniform float uAlpha; varying vec2 vUV; varying float vW;
    void main() { float a = texture2D(uTex, vUV).a * vW * uAlpha; gl_FragColor = vec4(uColor * a, a); }`;

  // 外框：把整個角色先畫到暫存畫面，再依 alpha 往外擴張（32 方向 × 4 段距離取最大值），擴出來的部分填外框色、墊在角色底下
  const VS_Q = `attribute vec2 aPos; varying vec2 vUV; void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FS_OL = `
    precision highp float; uniform sampler2D uTex; uniform vec2 uPx; uniform float uR; uniform vec3 uCol; varying vec2 vUV;
    void main() {
      vec4 c = texture2D(uTex, vUV);
      float m = c.a;
      for (int i = 0; i < 32; i++) {
        float a = float(i) * 0.19634954;
        vec2 d = vec2(cos(a), sin(a)) * uR * uPx;
        m = max(m, texture2D(uTex, vUV + d).a);
        m = max(m, texture2D(uTex, vUV + d * 0.75).a);
        m = max(m, texture2D(uTex, vUV + d * 0.5).a);
        m = max(m, texture2D(uTex, vUV + d * 0.25).a);
      }
      m = smoothstep(0.3, 0.6, m);   // 幾乎透明的碎點（灰塵）不描框
      gl_FragColor = c + vec4(uCol * m, m) * (1.0 - c.a);
    }`;
  function create(canvas) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = fs => {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      return {
        p, aPos: gl.getAttribLocation(p, 'aPos'), aUV: gl.getAttribLocation(p, 'aUV'), aW: gl.getAttribLocation(p, 'aW'),
        uM: gl.getUniformLocation(p, 'uM'), uAlpha: gl.getUniformLocation(p, 'uAlpha'), uColor: gl.getUniformLocation(p, 'uColor'),
      };
    };
    const P_TEX = program(FS_TEX), P_W = program(FS_W), P_CLIP = program(FS_CLIP);
    P_CLIP.uMask = gl.getUniformLocation(P_CLIP.p, 'uMask'); P_CLIP.uSize = gl.getUniformLocation(P_CLIP.p, 'uSize'); P_CLIP.uTex = gl.getUniformLocation(P_CLIP.p, 'uTex');
    let curFB = null, maskFb = null, maskTex = null, maskW = 0, maskH = 0, backTex = null, backW = 0, backH = 0;
    const P_ADV = program(FS_ADV);
    for (const k of ['uBack', 'uMask', 'uSize', 'uMode', 'uUseMask', 'uTex']) P_ADV[k] = gl.getUniformLocation(P_ADV.p, k);
    // 混合模式（預乘 alpha）：正常、色彩增值、濾色、加亮（線性加亮）
    function setBlend(mode) {
      if (mode === 'multiply') gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else if (mode === 'screen') gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else if (mode === 'add') gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    // 外框用：全畫面四邊形、暫存畫面（framebuffer + texture）
    const P_OL = (() => {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS_Q)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS_OL)); gl.linkProgram(p);
      return { p, aPos: gl.getAttribLocation(p, 'aPos'), uPx: gl.getUniformLocation(p, 'uPx'), uR: gl.getUniformLocation(p, 'uR'), uCol: gl.getUniformLocation(p, 'uCol') };
    })();
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    let fbo = null, fboTex = null, fboW = 0, fboH = 0;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    function makeTex(source) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return t;
    }
    function bind(P, d, positions, m, cw, ch, alpha, weights) {
      gl.useProgram(P.p);
      const A = 2 * m[0] / cw, B = -2 * m[1] / ch, C = 2 * m[2] / cw, D = -2 * m[3] / ch;
      const E = 2 * m[4] / cw - 1, F = 1 - 2 * m[5] / ch;
      gl.uniformMatrix3fv(P.uM, false, new Float32Array([A, B, 0, C, D, 0, E, F, 1]));
      gl.uniform1f(P.uAlpha, alpha);
      gl.bindBuffer(gl.ARRAY_BUFFER, d.pos);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
      gl.enableVertexAttribArray(P.aPos);
      gl.vertexAttribPointer(P.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, d.uv);
      gl.enableVertexAttribArray(P.aUV);
      gl.vertexAttribPointer(P.aUV, 2, gl.FLOAT, false, 0, 0);
      if (P.aW >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, d.w);
        if (weights) gl.bufferSubData(gl.ARRAY_BUFFER, 0, weights);
        gl.enableVertexAttribArray(P.aW);
        gl.vertexAttribPointer(P.aW, 1, gl.FLOAT, false, 0, 0);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.idx);
    }

    return {
      canvas, maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      createDrawable(canvases, mesh) {
        const d = { tex: canvases.map(makeTex), pos: gl.createBuffer(), uv: gl.createBuffer(), w: gl.createBuffer(), idx: gl.createBuffer(), count: mesh.idx.length };
        gl.bindBuffer(gl.ARRAY_BUFFER, d.uv);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.pos);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.rest.byteLength, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.w);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.rest.byteLength / 2, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.idx);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
        return d;
      },
      free(d) {
        for (const t of d.tex) gl.deleteTexture(t);
        gl.deleteBuffer(d.pos); gl.deleteBuffer(d.uv); gl.deleteBuffer(d.w); gl.deleteBuffer(d.idx);
      },
      begin(w, h) {
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        curFB = null; gl.bindFramebuffer(gl.FRAMEBUFFER, null); setBlend('normal');
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      },
      // 之後的 draw 先畫到暫存畫面（外框用）
      beginLayer() {
        const w = canvas.width, h = canvas.height;
        if (!fbo) { fbo = gl.createFramebuffer(); fboTex = gl.createTexture(); }
        if (fboW !== w || fboH !== h) {
          gl.bindTexture(gl.TEXTURE_2D, fboTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
          fboW = w; fboH = h;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); curFB = fbo;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      },
      // 剪裁用的遮罩：把底層圖層（目前變形的樣子）畫到遮罩畫面
      drawMask(d, positions, m, cw, ch, slot = 0, alpha = 1) {
        const w = canvas.width, h = canvas.height;
        if (!maskFb) { maskFb = gl.createFramebuffer(); maskTex = gl.createTexture(); }
        if (maskW !== w || maskH !== h) {
          gl.bindTexture(gl.TEXTURE_2D, maskTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.bindFramebuffer(gl.FRAMEBUFFER, maskFb);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, maskTex, 0);
          maskW = w; maskH = h;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, maskFb);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        setBlend('normal');
        if (d.count) { bind(P_TEX, d, positions, m, cw, ch, alpha); gl.bindTexture(gl.TEXTURE_2D, d.tex[Math.min(slot, d.tex.length - 1)]); gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0); }
        gl.bindFramebuffer(gl.FRAMEBUFFER, curFB);
      },
      // 把暫存畫面加上外框畫回畫布：color = [r, g, b]（0 … 1），radius = 畫布像素
      endLayer(color, radius) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); curFB = null; setBlend('normal');
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(P_OL.p);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        for (let i = 0; i < 4; i++) if (i !== P_OL.aPos) gl.disableVertexAttribArray(i);
        gl.enableVertexAttribArray(P_OL.aPos);
        gl.vertexAttribPointer(P_OL.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(P_OL.uPx, 1 / fboW, 1 / fboH);
        gl.uniform1f(P_OL.uR, radius);
        gl.uniform3fv(P_OL.uCol, color);
        gl.bindTexture(gl.TEXTURE_2D, fboTex);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      // m：文件座標 → 畫布座標（cw/ch 為畫布座標的寬高）
      // o.blend：混合模式；o.clip：只畫在 drawMask 畫的遮罩裡面
      draw(d, positions, m, cw, ch, slot = 0, alpha = 1, o = null) {
        if (!d.count) return;
        const mode = o && o.blend && BLEND_ID[o.blend];
        if (mode) {
          // 底圖 = 目前畫面（或外框用的暫存畫面）的複本
          const w = canvas.width, h = canvas.height;
          if (!backTex) backTex = gl.createTexture();
          gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, backTex);
          if (backW !== w || backH !== h) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            backW = w; backH = h;
          }
          gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, w, h, 0);
          bind(P_ADV, d, positions, m, cw, ch, alpha);
          gl.uniform1i(P_ADV.uBack, 2);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, o.clip && maskTex ? maskTex : backTex); gl.uniform1i(P_ADV.uMask, 1);
          gl.uniform1f(P_ADV.uUseMask, o.clip && maskTex ? 1 : 0);
          gl.uniform2f(P_ADV.uSize, w, h); gl.uniform1i(P_ADV.uMode, mode);
          gl.activeTexture(gl.TEXTURE0); gl.uniform1i(P_ADV.uTex, 0);
          gl.bindTexture(gl.TEXTURE_2D, d.tex[Math.min(slot, d.tex.length - 1)]);
          gl.disable(gl.BLEND);   // 公式已經包含和底圖的合成
          gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0);
          gl.enable(gl.BLEND);
          return;
        }
        const clip = o && o.clip && maskTex;
        bind(clip ? P_CLIP : P_TEX, d, positions, m, cw, ch, alpha);
        if (clip) {
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(P_CLIP.uMask, 1);
          gl.activeTexture(gl.TEXTURE0); gl.uniform1i(P_CLIP.uTex, 0); gl.uniform2f(P_CLIP.uSize, canvas.width, canvas.height);
        }
        setBlend(o && o.blend);
        gl.bindTexture(gl.TEXTURE_2D, d.tex[Math.min(slot, d.tex.length - 1)]);
        gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0);
        setBlend('normal');
      },
      drawWeights(d, positions, weights, m, cw, ch, color, alpha = 0.55) {
        if (!d.count) return;
        bind(P_W, d, positions, m, cw, ch, alpha, weights);
        gl.uniform3fv(P_W.uColor, color);
        gl.bindTexture(gl.TEXTURE_2D, d.tex[0]);
        gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0);
      },
    };
  }
  return { create };
})();
