'use strict';
/* Inti penyuntingan peta: spline jalan + penyesuaian tanah.
 * HARUS sama dengan mapedit.py (server memakai versi Python untuk hasil akhir di game;
 * editor memakai versi ini untuk pratinjau langsung). */
(function (root) {
  const CELL = 40, SAMPLE_STEP = 30, FLAT_MARGIN = 18, MIN_FALL = 80, MAX_FALL = 600, FALL_RATIO = 6;

  // pts: [[x, y, z], ...] -> titik halus [[x, y, z], ...]; idx (opsional) diisi indeks sampel tiap titik kontrol
  function spline(pts, step = SAMPLE_STEP, idx = null) {
    const n = pts.length;
    if (n < 2) return pts.map((p) => p.slice());
    const d = [];
    for (let i = 0; i < n - 1; i++) d.push(Math.max(1e-6, Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])));
    const v = [];
    for (let i = 0; i < n; i++) {
      let a, b, den;
      if (i === 0) { a = pts[0]; b = pts[1]; den = d[0]; }
      else if (i === n - 1) { a = pts[n - 2]; b = pts[n - 1]; den = d[n - 2]; }
      else { a = pts[i - 1]; b = pts[i + 1]; den = d[i - 1] + d[i]; }
      v.push([(b[0] - a[0]) / den, (b[1] - a[1]) / den, (b[2] - a[2]) / den]);
    }
    const out = [];
    for (let i = 0; i < n - 1; i++) {
      const steps = Math.max(1, Math.ceil(d[i] / step));
      if (idx) idx.push(out.length);
      for (let s = 0; s < steps; s++) {
        const t = s / steps, t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        const p = [0, 0, 0];
        for (let k = 0; k < 3; k++) p[k] = h00 * pts[i][k] + h10 * d[i] * v[i][k] + h01 * pts[i + 1][k] + h11 * d[i] * v[i + 1][k];
        out.push(p);
      }
    }
    if (idx) idx.push(out.length);
    out.push(pts[n - 1].slice());
    return out;
  }

  const smooth01 = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

  // h: Float32Array/Array grid tinggi (baris demi baris), diubah di tempat.
  // roads: [{w, samples}] (samples = hasil spline)
  function carve(h, nx, ny, roads, cell = CELL) {
    const best = new Map();
    for (const road of roads) {
      const half = road.w / 2 + FLAT_MARGIN, reach = half + MAX_FALL, s = road.samples;
      for (let k = 0; k < s.length - 1; k++) {
        const ax = s[k][0], ay = s[k][1], az = s[k][2], bx = s[k + 1][0], by = s[k + 1][1], bz = s[k + 1][2];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
        const i0 = Math.max(0, Math.trunc((Math.min(ax, bx) - reach) / cell)), i1 = Math.min(nx - 1, Math.trunc((Math.max(ax, bx) + reach) / cell) + 1);
        const j0 = Math.max(0, Math.trunc((Math.min(ay, by) - reach) / cell)), j1 = Math.min(ny - 1, Math.trunc((Math.max(ay, by) + reach) / cell) + 1);
        for (let j = j0; j <= j1; j++) {
          const py = j * cell;
          for (let i = i0; i <= i1; i++) {
            const px = i * cell;
            const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
            const dd = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - half;
            if (dd > MAX_FALL) continue;
            const key = j * nx + i, cur = best.get(key);
            if (!cur || dd < cur[0]) best.set(key, [dd, az + (bz - az) * t]);
          }
        }
      }
    }
    for (const [key, [dd, zc]] of best) {
      const base = h[key], fall = Math.min(MAX_FALL, Math.max(MIN_FALL, Math.abs(zc - base) * FALL_RATIO));
      const t = dd > 0 ? smooth01(dd / fall) : 0;
      h[key] = zc * (1 - t) + base * t;
    }
  }

  // tinggi grid (bilinear) di (x, y); di luar grid = 0
  function heightAt(h, nx, ny, x, y, cell = CELL) {
    const fx = x / cell, fy = y / cell;
    if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) return 0;
    const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy)), tx = fx - i, ty = fy - j;
    return (h[j * nx + i] * (1 - tx) + h[j * nx + i + 1] * tx) * (1 - ty) + (h[(j + 1) * nx + i] * (1 - tx) + h[(j + 1) * nx + i + 1] * tx) * ty;
  }


  // Sederhanakan poligon jalan (Douglas-Peucker) jadi titik kontrol spline.
  // pts: [[x, y], ...]; zs (opsional): tinggi tanah tiap titik, tolZ: toleransi tinggi (px).
  // Titik dipertahankan bila menyimpang > tolXY dari garis lurus atau > tolZ dari tinggi interpolasi.
  function simplify(pts, tolXY = 2.5, zs = null, tolZ = 4) {
    const n = pts.length; if (n < 3) return pts.map((_, i) => i);
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(); let worst = -1, we = 1;
      const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
      let total = 0; const cum = [0];
      for (let i = a + 1; i <= b; i++) { total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); cum.push(total); }
      for (let i = a + 1; i < b; i++) {
        const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2));
        let e = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy)) / tolXY;
        if (zs) e = Math.max(e, Math.abs(zs[i] - (zs[a] + (zs[b] - zs[a]) * (cum[i - a] / (total || 1)))) / tolZ);
        if (e > we) { we = e; worst = i; }
      }
      if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
    }
    const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(i); return out;
  }

  root.MapEditCore = { simplify, CELL, SAMPLE_STEP, FLAT_MARGIN, MIN_FALL, MAX_FALL, FALL_RATIO, spline, carve, heightAt, smooth01 };
})(typeof window !== 'undefined' ? window : module.exports);
