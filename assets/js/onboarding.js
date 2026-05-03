(function () {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Shader background ─────────────────────────────────────── */
  function initShader() {
    if (reducedMotion) return;
    const canvas = document.getElementById('shader-bg');
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: false }) ||
               canvas.getContext('experimental-webgl');
    if (!gl) return;

    const vsSrc = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = (a_position + 1.0) * 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    const fsSrc = `
      precision highp float;
      varying vec2 v_uv;
      uniform float u_time;
      uniform vec2  u_resolution;
      uniform vec2  u_pointer; // 0..1, smoothed

      // Hash & value noise (cheap, smooth enough for ambient bg)
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.55;
        for (int i = 0; i < 5; i++) {
          v += a * noise(p);
          p *= 2.05;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec2 uv = v_uv;
        vec2 p = uv * 2.0 - 1.0;
        p.x *= u_resolution.x / u_resolution.y;

        float t = u_time * 0.06;

        // Two flowing aurora layers with slight parallax
        float n1 = fbm(uv * vec2(2.4, 1.6) + vec2(t, t * 0.7));
        float n2 = fbm(uv * vec2(1.8, 2.2) - vec2(t * 0.6, t * 0.4) + 7.13);

        // Brand palette
        vec3 deep  = vec3(0.008, 0.063, 0.122); // near-black blue
        vec3 ocean = vec3(0.027, 0.247, 0.486); // brand mid-deep
        vec3 cyan  = vec3(0.361, 0.784, 1.000); // brand-cyan #5cc8ff
        vec3 violet= vec3(0.439, 0.357, 0.882); // accent

        // Vertical wash from top (lit) to bottom (deep)
        vec3 base = mix(ocean, deep, smoothstep(0.0, 1.0, uv.y * 1.1));

        // Aurora bands — soft contrast, never overwhelming
        float band1 = smoothstep(0.45, 0.85, n1);
        float band2 = smoothstep(0.55, 0.95, n2);

        vec3 col = base;
        col = mix(col, cyan,   band1 * 0.35);
        col = mix(col, violet, band2 * 0.18);

        // Pointer halo: gentle warm spotlight follows cursor (no-op on touch)
        vec2 ptr = u_pointer * 2.0 - 1.0;
        ptr.x *= u_resolution.x / u_resolution.y;
        float d = length(p - ptr);
        col += vec3(0.20, 0.55, 0.95) * smoothstep(0.9, 0.0, d) * 0.10;

        // Subtle film grain to defeat banding
        float grain = (hash(gl_FragCoord.xy + u_time) - 0.5) * 0.018;
        col += grain;

        // Vignette
        float vign = smoothstep(1.4, 0.55, length(p));
        col *= mix(0.78, 1.0, vign);

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('Shader compile error:', gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    }
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('Program link error:', gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    const aPos = gl.getAttribLocation(prog, 'a_position');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uRes  = gl.getUniformLocation(prog, 'u_resolution');
    const uPtr  = gl.getUniformLocation(prog, 'u_pointer');

    let pointer = { x: 0.5, y: 0.4 };
    let smoothed = { x: 0.5, y: 0.4 };

    window.addEventListener('pointermove', (e) => {
      pointer.x = e.clientX / window.innerWidth;
      pointer.y = e.clientY / window.innerHeight;
    }, { passive: true });

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.floor(window.innerWidth * dpr);
      const h = Math.floor(window.innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uRes, w, h);
      }
    }
    window.addEventListener('resize', resize);
    resize();

    const start = performance.now();
    let running = true;
    document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) requestAnimationFrame(render); });

    function render() {
      if (!running) return;
      const t = (performance.now() - start) / 1000;
      smoothed.x += (pointer.x - smoothed.x) * 0.06;
      smoothed.y += (pointer.y - smoothed.y) * 0.06;
      gl.uniform1f(uTime, t);
      gl.uniform2f(uPtr, smoothed.x, 1.0 - smoothed.y);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
  }

  /* ── Magnetic buttons ──────────────────────────────────────── */
  function initMagnetic() {
    if (reducedMotion) return;
    // Skip magnetic on touch-primary devices — feels wrong on mobile
    if (window.matchMedia('(hover: none)').matches) return;

    const STRENGTH = 0.32;       // 0..1, how strongly the button follows cursor
    const RADIUS   = 110;        // px, activation distance from button center
    const els = document.querySelectorAll('[data-magnetic]');

    els.forEach((el) => {
      let raf = 0;
      let target = { x: 0, y: 0 };
      let current = { x: 0, y: 0 };
      const content = el.querySelector('.btn-content') || el;

      function loop() {
        current.x += (target.x - current.x) * 0.18;
        current.y += (target.y - current.y) * 0.18;
        el.style.transform = `translate3d(${current.x * STRENGTH}px, ${current.y * STRENGTH}px, 0)`;
        content.style.transform = `translate3d(${current.x * STRENGTH * 0.5}px, ${current.y * STRENGTH * 0.5}px, 0)`;
        if (Math.abs(target.x - current.x) > 0.1 || Math.abs(target.y - current.y) > 0.1) {
          raf = requestAnimationFrame(loop);
        } else {
          raf = 0;
        }
      }

      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist < RADIUS) {
          target.x = dx;
          target.y = dy;
        } else {
          target.x = 0;
          target.y = 0;
        }
        if (!raf) raf = requestAnimationFrame(loop);
      });

      el.addEventListener('pointerleave', () => {
        target.x = 0;
        target.y = 0;
        if (!raf) raf = requestAnimationFrame(loop);
      });
    });
  }

  /* ── Init ──────────────────────────────────────────────────── */
  function init() {
    initShader();
    initMagnetic();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
