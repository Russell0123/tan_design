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
    const P_TEX = program(FS_TEX), P_W = program(FS_W);
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
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      },
      // 把暫存畫面加上外框畫回畫布：color = [r, g, b]（0 … 1），radius = 畫布像素
      endLayer(color, radius) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
      draw(d, positions, m, cw, ch, slot = 0, alpha = 1) {
        if (!d.count) return;
        bind(P_TEX, d, positions, m, cw, ch, alpha);
        gl.bindTexture(gl.TEXTURE_2D, d.tex[Math.min(slot, d.tex.length - 1)]);
        gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0);
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
