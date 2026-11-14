'use strict';
/* =========================================================================
 * render3d.js — renderer 3D untuk halaman /3d. WebGL2 murni, tanpa library.
 *
 * game.js tetap memegang SEMUA logika (fisika, misi, input, simpanan). File ini hanya
 * menggambar keadaan yang sama dalam 3D: dunia statis dibangun sekali dari data level
 * (jalan, rumah, pohon, SPBU, pabrik, jalan tol layang…), kendaraan/trailer/sopir digambar
 * tiap frame, bayangan memakai shadow map, label teks digambar di kanvas 2D overlay.
 *
 * Satuan = px dunia game (10 px = 1 m). Sumbu: x = timur, y = atas, z = selatan (= sumbu y di game 2D).
 * Sudut game `ang` (dari +x ke arah +y game) = rotasi `yaw` di sini: lokal +x -> (cos, 0, sin).
 * ========================================================================= */
const Render3D = (() => {
  const DEG = Math.PI / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const R = { ready: false, camYaw: -Math.PI / 2 };
  let gl = null, glc = null, L = null, S0 = null;
  let progMain, progShadow, progSky, vaoEmpty;
  const SH = { tex: null, fb: null, size: 2048 };
  const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const IDENT3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  /* ------------------------------ matematika ------------------------------ */
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function persp(fovy, asp, n, f) {
    const t = 1 / Math.tan(fovy / 2);
    return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]);
  }
  function ortho(l, r, b, t, n, f) {
    return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0,
      -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]);
  }
  function lookAt(e, t, up = [0, 1, 0]) {
    let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  }
  function inv(m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7],
      a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
      b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
      b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let d = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    d = 1 / (d || 1);
    return new Float32Array([
      (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
      (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
      (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
      (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d]);
  }
  // T * Ry(yaw) * Rz(rz) * S  (kolom-mayor)
  function trs(tx, ty, tz, yaw, rz, sx, sy, sz) {
    const cy = Math.cos(yaw), sy_ = Math.sin(yaw), cz = Math.cos(rz), sz_ = Math.sin(rz);
    return new Float32Array([
      cz * cy * sx, sz_ * sx, cz * sy_ * sx, 0,
      -sz_ * cy * sy, cz * sy, -sz_ * sy_ * sy, 0,
      -sy_ * sz, 0, cy * sz, 0,
      tx, ty, tz, 1]);
  }
  function rotX(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  }
  function norm3(m) {              // n' = sum(n_i * kolom_i / |kolom_i|^2)  (benar untuk skala tak seragam)
    const o = new Float32Array(9);
    for (let c = 0; c < 3; c++) {
      const x = m[c * 4], y = m[c * 4 + 1], z = m[c * 4 + 2], s = 1 / (x * x + y * y + z * z || 1);
      o[c * 3] = x * s; o[c * 3 + 1] = y * s; o[c * 3 + 2] = z * s;
    }
    return o;
  }

  /* ------------------------------ warna ------------------------------------ */
  const colCache = {};
  function C(h) {          // hex sRGB -> linear
    if (colCache[h]) return colCache[h];
    const n = parseInt(h.slice(1, 7), 16);
    return (colCache[h] = [Math.pow(((n >> 16) & 255) / 255, 2.2), Math.pow(((n >> 8) & 255) / 255, 2.2), Math.pow((n & 255) / 255, 2.2)]);
  }
  const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const hash = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };

  /* ------------------------------ kontur tanah (naik-turun) ---------------- */
  // L.terrain: grid tinggi (px) di wilayah barat (Kopeng). Di luar grid tanah datar (0).
  let TER = null;
  const ROAD_BUMP_CELL = 120;
  let roadBumpGrid = new Map();
  function TH(x, z) {
    const T = TER; if (!T) return 0;
    const fx = (x - T.x0) / T.cell, fz = (z - T.y0) / T.cell;
    if (fx < 0 || fz < 0 || fx > T.nx - 1 || fz > T.ny - 1) return 0;
    const n = T.nx, i = Math.min(n - 2, Math.floor(fx)), j = Math.min(T.ny - 2, Math.floor(fz)), tx = fx - i, tz = fz - j, h = T.h;
    const a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  // Beda tinggi minimum jembatan/terowongan: 5 m. Satuan tinggi = 0,1 m (10 px = 1 m) -> 50.
  // Harus sama dengan BRIDGE_HEIGHT_THRESHOLD di mapedit.py.
  const BRIDGE_MIN_DIFF = 50;
  function bridgeGroundHeight(x, z, heading, fallback = TH(x, z)) {
    let height = fallback;
    for (const bridge of L.bridges || []) {
      const co = Math.cos(bridge.angle), si = Math.sin(bridge.angle);
      const lco = Math.cos(bridge.lowerAngle ?? (bridge.angle + Math.PI / 2)), lsi = Math.sin(bridge.lowerAngle ?? (bridge.angle + Math.PI / 2));
      const dx = x - bridge.x, dz = z - bridge.y;
      const halfW = (bridge.width || 100) / 2 + 10;
      const halfL = (bridge.length || 200) / 2;
      const halfLowW = ((bridge.lowerWidth || bridge.width || 100) / 2) + 10;

      const alongUp = Math.abs(dx * co + dz * si), acrossUp = Math.abs(-dx * si + dz * co);
      const inUpperZone = alongUp <= halfL && acrossUp <= halfW;

      const alongLow = Math.abs(dx * lco + dz * lsi), acrossLow = Math.abs(-dx * lsi + dz * lco);
      const inLowerZone = alongLow <= halfL && acrossLow <= halfLowW;

      if (!inUpperZone && !inLowerZone) continue;

      if (heading != null) {
        const upperAlignment = Math.abs(Math.cos(heading - bridge.angle));
        const lowerAlignment = Math.abs(Math.cos(heading - (bridge.lowerAngle ?? (bridge.angle + Math.PI / 2))));
        if (inUpperZone && upperAlignment >= 0.55 && upperAlignment >= lowerAlignment) {
          // Kendaraan berjalan di JALAN ATAS → naikkan ke upperZ
          height = Math.max(height, bridge.upperZ + 1.8);
        } else if (inLowerZone && lowerAlignment >= 0.55 && lowerAlignment >= upperAlignment) {
          // Kendaraan berjalan di JALAN BAWAH (terowongan) → kunci ke lowerZ (jangan naik ikut bukit)
          const lowerZ = bridge.lowerZ ?? 0;
          if (height > lowerZ + 1.5) height = lowerZ + 1.5;
        } else if (inUpperZone) {
          height = Math.max(height, bridge.upperZ + 1.8);
        }
      } else {
        // Tidak ada heading (mis. render mesh) → gunakan jalan atas
        height = Math.max(height, bridge.upperZ + 1.8);
      }
    }
    return height;
  }
  function buildRoadBumpGrid(bumps) {
    roadBumpGrid = new Map();
    for (const bump of bumps || []) {
      const radius = bump.width / 2 + bump.halfLength;
      for (let gx = Math.floor((bump.x - radius) / ROAD_BUMP_CELL); gx <= Math.floor((bump.x + radius) / ROAD_BUMP_CELL); gx++) {
        for (let gy = Math.floor((bump.y - radius) / ROAD_BUMP_CELL); gy <= Math.floor((bump.y + radius) / ROAD_BUMP_CELL); gy++) {
          const key = `${gx},${gy}`;
          if (!roadBumpGrid.has(key)) roadBumpGrid.set(key, []);
          roadBumpGrid.get(key).push(bump);
        }
      }
    }
  }
  function roadSurfaceHeight(x, z) {
    let height = 0;
    const gx = Math.floor(x / ROAD_BUMP_CELL), gy = Math.floor(z / ROAD_BUMP_CELL);
    for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
      for (const bump of roadBumpGrid.get(`${ix},${iy}`) || []) {
        const dx = x - bump.x, dz = z - bump.y, co = Math.cos(bump.angle), si = Math.sin(bump.angle);
        const along = dx * co + dz * si, across = -dx * si + dz * co;
        if (Math.abs(along) >= bump.halfLength || Math.abs(across) >= bump.width / 2) continue;
        height = Math.max(height, bump.height * (0.5 + 0.5 * Math.cos(Math.PI * along / bump.halfLength)));
      }
    }
    return height;
  }
  // tinggi termasuk "bahu" di luar peta: makin ke barat/utara makin tinggi (kaki Merbabu)
  function THX(x, z) {
    const T = TER, X1 = T.x0 + (T.nx - 1) * T.cell, Z1 = T.y0 + (T.ny - 1) * T.cell;
    const cx = clamp(x, T.x0, X1), cz = clamp(z, T.y0, Z1);
    let h = TH(cx, cz);
    if (x < T.x0) h += (T.x0 - x) * 0.22;
    if (z < T.y0) h += (T.y0 - z) * 0.12 * clamp(1 - (cx - T.x0) / (X1 - T.x0), 0, 1) * 1.3;
    if (z > Z1) h *= clamp(1 - (z - Z1) / 2000, 0, 1);
    return h;
  }
  // pitch (angguk) kendaraan dari selisih tinggi depan-belakang
  function pitchOf(x, z, ang, f, r) {
    if (!TER) return 0;
    const co = Math.cos(ang), si = Math.sin(ang);
    return Math.atan2(bridgeGroundHeight(x + co * f, z + si * f, ang)
      - bridgeGroundHeight(x + co * r, z + si * r, ang), f - r);
  }
  function roadAttitude(V) {
    const co = Math.cos(V.ang), si = Math.sin(V.ang), hw = Math.max(2, V.spec.hw * 0.75);
    const front = Math.max(2, V.spec.front * 0.8), rear = Math.min(-2, V.spec.rear * 0.8);
    const sample = (x, z) => {
      const wx = V.x + co * x - si * z, wz = V.y + si * x + co * z;
      return bridgeGroundHeight(wx, wz, V.ang) + roadSurfaceHeight(wx, wz);
    };
    const frontLeft = sample(front, -hw), frontRight = sample(front, hw);
    const rearLeft = sample(rear, -hw), rearRight = sample(rear, hw);
    const centerHeight = (frontLeft + frontRight + rearLeft + rearRight) / 4;
    const frontHeight = (frontLeft + frontRight) / 2, rearHeight = (rearLeft + rearRight) / 2;
    const leftHeight = (frontLeft + rearLeft) / 2, rightHeight = (frontRight + rearRight) / 2;
    return {
      height: centerHeight,
      pitch: Math.atan2(frontHeight - rearHeight, front - rear),
      roll: Math.atan2(leftHeight - rightHeight, hw * 2)
    };
  }
  function drapeMesh(m) {                               // naikkan tiap verteks mengikuti kontur tanah
    if (!TER) return;
    const a = m.a, X1 = TER.x0 + (TER.nx - 1) * TER.cell;
    const isRoad = m.isRoadMesh;
    for (let i = 0; i < a.length; i += 9) if (a[i] <= X1) {
      let h = TH(a[i], a[i + 2]);
      if (isRoad && L.bridges && L.bridges.length) {
        for (const b of L.bridges) {
          if (b.upperZ - b.lowerZ >= BRIDGE_MIN_DIFF) {
            const lco = Math.cos(b.lowerAngle ?? (b.angle + Math.PI / 2)), lsi = Math.sin(b.lowerAngle ?? (b.angle + Math.PI / 2));
            const dx = a[i] - b.x, dz = a[i + 2] - b.y;
            const alongLow = Math.abs(dx * lco + dz * lsi), acrossLow = Math.abs(-dx * lsi + dz * lco);
            const halfL = (b.length || 200) / 2 + 10;
            const halfLowW = ((b.lowerWidth || b.width || 100) / 2) + 12;
            if (alongLow <= halfL && acrossLow <= halfLowW) {
              if (h > b.lowerZ + 1.5) h = b.lowerZ + 1.5;
              break;
            }
          }
        }
      }
      if (h) a[i + 1] += h;
    }
  }

  /* ------------------------------ mesh & primitif -------------------------- */
  // catat satu segitiga (9 angka) agar urutan titiknya berlawanan jarum jam terhadap normal `n` -> normal bisa dihitung ulang dari titik
  function recTri(v, n) {
    const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2], wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) return [v[0], v[1], v[2], v[6], v[7], v[8], v[3], v[4], v[5]];
    return v;
  }
  // putar mengitari sumbu `ax` (satuan) yang melalui titik `p` sebesar `ang` rad; hasil matriks 4x4 kolom-mayor
  function rotAbout(p, ax, ang) {
    const c = Math.cos(ang), sn = Math.sin(ang), t = 1 - c, x = ax[0], y = ax[1], z = ax[2];
    const m00 = t * x * x + c, m01 = t * x * y - sn * z, m02 = t * x * z + sn * y, m10 = t * x * y + sn * z, m11 = t * y * y + c, m12 = t * y * z - sn * x;
    const m20 = t * x * z - sn * y, m21 = t * y * z + sn * x, m22 = t * z * z + c;
    return [m00, m10, m20, 0, m01, m11, m21, 0, m02, m12, m22, 0,
      p[0] - (m00 * p[0] + m01 * p[1] + m02 * p[2]), p[1] - (m10 * p[0] + m11 * p[1] + m12 * p[2]), p[2] - (m20 * p[0] + m21 * p[1] + m22 * p[2]), 1];
  }
  let REC = null;           // perekam: bila array, setiap Mesh.add/quad/tri dicatat (dipakai exportModel untuk editor kendaraan)
  const REC_BASIC = new Set(['box', 'boxC', 'cylY', 'cylYlo', 'cylZ', 'cylX', 'cone', 'coneLo', 'sph', 'sphLo', 'cylY16', 'cone16', 'sph12']);
  class Mesh {
    constructor() { this.a = []; this.vao = null; this.n = 0; }
    add(prim, m, c, ao = 0) {
      if (REC) {
        if (prim.key && REC_BASIC.has(prim.key)) REC.push({ k: prim.key, m: Array.from(m), c: Array.from(c), ao });
        else {                                       // bentuk lain (atap pelana, cincin, ...): catat segitiga hasil transformasi
          const out = [], d = prim.d, P = (i) => [m[0] * d[i] + m[4] * d[i + 1] + m[8] * d[i + 2] + m[12], m[1] * d[i] + m[5] * d[i + 1] + m[9] * d[i + 2] + m[13], m[2] * d[i] + m[6] * d[i + 1] + m[10] * d[i + 2] + m[14]];
          for (let i = 0; i + 17 < d.length; i += 18) out.push(...recTri([...P(i), ...P(i + 6), ...P(i + 12)], [d[i + 3] + d[i + 9] + d[i + 15], d[i + 4] + d[i + 10] + d[i + 16], d[i + 5] + d[i + 11] + d[i + 17]]));
          REC.push({ k: 'tris', v: out, c: Array.from(c) });
        }
      }
      const p = prim.d, a = this.a;
      const s0 = 1 / (m[0] * m[0] + m[1] * m[1] + m[2] * m[2] || 1), s1 = 1 / (m[4] * m[4] + m[5] * m[5] + m[6] * m[6] || 1),
        s2 = 1 / (m[8] * m[8] + m[9] * m[9] + m[10] * m[10] || 1);
      for (let i = 0; i < p.length; i += 6) {
        const x = p[i], y = p[i + 1], z = p[i + 2], nx = p[i + 3], ny = p[i + 4], nz = p[i + 5];
        let tx = nx * m[0] * s0 + ny * m[4] * s1 + nz * m[8] * s2, ty = nx * m[1] * s0 + ny * m[5] * s1 + nz * m[9] * s2,
          tz = nx * m[2] * s0 + ny * m[6] * s1 + nz * m[10] * s2;
        const l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
        const k = ao ? 1 - ao * (1 - clamp(y, 0, 1)) : 1;
        a.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14],
          tx, ty, tz, c[0] * k, c[1] * k, c[2] * k);
      }
    }
    quad(p0, p1, p2, p3, n, c) {            // empat titik dunia (urutan keliling) + normal
      const a = this.a;
      if (REC) REC.push({ k: 'tris', v: [...recTri([...p0, ...p1, ...p2], n), ...recTri([...p0, ...p2, ...p3], n)], c: Array.from(c) });
      for (const p of [p0, p1, p2, p0, p2, p3]) a.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2]);
    }
    tri(p0, p1, p2, n, c) {
      const a = this.a;
      if (REC) REC.push({ k: 'tris', v: recTri([...p0, ...p1, ...p2], n), c: Array.from(c) });
      for (const p of [p0, p1, p2]) a.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2]);
    }
    upload() {
      if (!gl) return this;                // mode ekspor (tanpa WebGL): mesh tidak diunggah
      if (!this.a.length) { this.n = 0; return this; }
      const f = new Float32Array(this.a); this.a = [];
      this.n = f.length / 9;
      this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, f, gl.STATIC_DRAW);
      for (let i = 0; i < 3; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 36, i * 12); }
      gl.bindVertexArray(null);
      return this;
    }
  }

  const PR = {};      // primitif: {d: Float32Array(pos+normal)}
  function makePrims() {
    const quadF = (o, a, b, c, d, n) => { for (const p of [a, b, c, a, c, d]) o.push(p[0], p[1], p[2], n[0], n[1], n[2]); };
    const box = (y0) => {
      const o = [], x0 = -0.5, x1 = 0.5, z0 = -0.5, z1 = 0.5, y1 = y0 + 1;
      quadF(o, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]);
      quadF(o, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
      quadF(o, [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0]);
      quadF(o, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
      quadF(o, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]);
      quadF(o, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
      return { d: new Float32Array(o) };
    };
    PR.box = box(0); PR.boxC = box(-0.5);
    const cyl = (seg, axis) => {
      const o = [], map = (x, y, z) => (axis === 'y' ? [x, y + (axis === 'y' ? 0.5 : 0), z] : axis === 'z' ? [x, z, y] : [y, x, z]);
      const nmap = (x, y, z) => (axis === 'y' ? [x, y, z] : axis === 'z' ? [x, z, y] : [y, x, z]);
      const push = (p, n) => { const q = map(p[0], p[1], p[2]), m = nmap(n[0], n[1], n[2]); o.push(q[0], q[1], q[2], m[0], m[1], m[2]); };
      for (let i = 0; i < seg; i++) {
        const a0 = i / seg * 2 * Math.PI, a1 = (i + 1) / seg * 2 * Math.PI;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const P00 = [c0 * 0.5, -0.5, s0 * 0.5], P01 = [c0 * 0.5, 0.5, s0 * 0.5], P10 = [c1 * 0.5, -0.5, s1 * 0.5], P11 = [c1 * 0.5, 0.5, s1 * 0.5];
        const n0 = [c0, 0, s0], n1 = [c1, 0, s1];
        push(P00, n0); push(P01, n0); push(P11, n1); push(P00, n0); push(P11, n1); push(P10, n1);
        push([0, 0.5, 0], [0, 1, 0]); push(P01, [0, 1, 0]); push(P11, [0, 1, 0]);
        push([0, -0.5, 0], [0, -1, 0]); push(P10, [0, -1, 0]); push(P00, [0, -1, 0]);
      }
      return { d: new Float32Array(o) };
    };
    PR.cylY = cyl(10, 'y'); PR.cylZ = cyl(14, 'z'); PR.cylX = cyl(10, 'x'); PR.cylYlo = cyl(7, 'y');
    const cone = (seg) => {
      const o = [];
      for (let i = 0; i < seg; i++) {
        const a0 = i / seg * 2 * Math.PI, a1 = (i + 1) / seg * 2 * Math.PI, am = (a0 + a1) / 2;
        const l = Math.hypot(1, 0.5);
        o.push(Math.cos(a0) * 0.5, 0, Math.sin(a0) * 0.5, Math.cos(a0) / l, 0.5 / l, Math.sin(a0) / l);
        o.push(Math.cos(a1) * 0.5, 0, Math.sin(a1) * 0.5, Math.cos(a1) / l, 0.5 / l, Math.sin(a1) / l);
        o.push(0, 1, 0, Math.cos(am) / l, 0.5 / l, Math.sin(am) / l);
      }
      return { d: new Float32Array(o) };
    };
    PR.cone = cone(10); PR.coneLo = cone(7);
    const sph = (lat, lon) => {
      const o = [], pt = (i, j) => {
        const th = i / lat * Math.PI, ph = j / lon * 2 * Math.PI;
        const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
        return [x * 0.5, y * 0.5, z * 0.5, x, y, z];
      };
      for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
        const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
        for (const p of [a, b, c, a, c, d]) o.push(...p);
      }
      return { d: new Float32Array(o) };
    };
    PR.sph = sph(6, 10); PR.sphLo = sph(4, 7); PR.sph12 = sph(8, 14); PR.cylY16 = cyl(16, 'y'); PR.cone16 = cone(16);
    { // atap pelana: bubungan sepanjang x, y 0..1
      const o = [], q = (a, b, c, d, n) => quadF(o, a, b, c, d, n), l = Math.hypot(0.5, 1);
      q([-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0], [-0.5, 1, 0], [0, 0.5 / l, 1 / l]);
      q([0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 1, 0], [0, 0.5 / l, -1 / l]);
      for (const p of [[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, 0]]) o.push(p[0], p[1], p[2], 1, 0, 0);
      for (const p of [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0]]) o.push(p[0], p[1], p[2], -1, 0, 0);
      PR.gable = { d: new Float32Array(o) };
    }
    { // cincin & panah datar (penanda di tanah)
      const o = [], seg = 32;
      for (let i = 0; i < seg; i++) {
        const a0 = i / seg * 2 * Math.PI, a1 = (i + 1) / seg * 2 * Math.PI;
        quadF(o, [Math.cos(a0) * 0.5, 0, Math.sin(a0) * 0.5], [Math.cos(a1) * 0.5, 0, Math.sin(a1) * 0.5],
          [Math.cos(a1) * 0.45, 0, Math.sin(a1) * 0.45], [Math.cos(a0) * 0.45, 0, Math.sin(a0) * 0.45], [0, 1, 0]);
      }
      PR.ring = { d: new Float32Array(o) };
      const od = [];
      for (let i = 0; i < seg; i++) {
        const a0 = i / seg * 2 * Math.PI, a1 = (i + 1) / seg * 2 * Math.PI;
        od.push(0, 0, 0, 0, 1, 0, Math.cos(a1) * 0.5, 0, Math.sin(a1) * 0.5, 0, 1, 0, Math.cos(a0) * 0.5, 0, Math.sin(a0) * 0.5, 0, 1, 0);
      }
      PR.disc = { d: new Float32Array(od) };
      PR.tri = { d: new Float32Array([0.5, 0, 0, 0, 1, 0, -0.5, 0, -0.5, 0, 1, 0, -0.5, 0, 0.5, 0, 1, 0]) };
    }
    for (const k of Object.keys(PR)) PR[k].key = k;
    for (const k of Object.keys(PR)) {            // versi VBO (putih) untuk gambar dinamis
      const m = new Mesh(); m.add(PR[k], IDENT, [1, 1, 1]); PR[k].mesh = m.upload();
    }
  }

  // pembantu bentuk (koordinat dunia, kotak min..maks)
  const bx = (m, x0, y0, z0, x1, y1, z1, c, ao = 0, yaw = 0) => m.add(PR.box, trs((x0 + x1) / 2, y0, (z0 + z1) / 2, yaw, 0, x1 - x0, y1 - y0, z1 - z0), c, ao);
  const cylY = (m, cx, y0, cz, r, h, c, ao = 0) => m.add(PR.cylY, trs(cx, y0, cz, 0, 0, 2 * r, h, 2 * r), c, ao);
  const sphere = (m, cx, cy, cz, r, c, sy = 1, lo = false) => m.add(lo ? PR.sphLo : PR.sph, trs(cx, cy, cz, 0, 0, 2 * r, 2 * r * sy, 2 * r), c);
  const flat = (m, x0, z0, x1, z1, y, c) => m.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 1, 0], c);
  const flatRot = (m, cx, cz, w, d, yaw, y, c) => {        // persegi datar berputar (yaw) di sekitar (cx,cz)
    const co = Math.cos(yaw), si = Math.sin(yaw), pt = (lx, lz) => [cx + lx * co - lz * si, y, cz + lx * si + lz * co];
    m.quad(pt(-w / 2, -d / 2), pt(w / 2, -d / 2), pt(w / 2, d / 2), pt(-w / 2, d / 2), [0, 1, 0], c);
  };

  /* ------------------------------ shader ------------------------------------ */
  const VS_MAIN = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec3 aCol;
uniform mat4 uVP, uModel, uLightVP; uniform mat3 uNorm; uniform float uNormOff;
out vec3 vCol; out vec3 vNor; out vec3 vWorld; out vec4 vLS;
void main(){
  vec4 w = uModel*vec4(aPos,1.0);
  vec3 n = normalize(uNorm*aNor);
  vWorld = w.xyz; vNor = n; vCol = aCol;
  vLS = uLightVP*vec4(w.xyz + n*uNormOff, 1.0);
  gl_Position = uVP*w;
}`;
  const FS_MAIN = `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 vCol; in vec3 vNor; in vec3 vWorld; in vec4 vLS; out vec4 oCol;
uniform vec3 uTint; uniform float uEmis, uAlpha, uShadowOn, uTexel, uBias;
uniform vec3 uSunDir, uSunCol, uSkyCol, uGndCol, uCam, uFogCol; uniform vec2 uFog;
uniform sampler2DShadow uShadow;
void main(){
  vec3 n = normalize(vNor);
  float ndl = max(dot(n, uSunDir), 0.0);
  float sh = 1.0;
  if (uShadowOn > 0.5) {
    vec3 sc = vLS.xyz / vLS.w * 0.5 + 0.5;
    if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0) {
      sh = 0.0;
      for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++)
        sh += texture(uShadow, vec3(sc.xy + vec2(float(i), float(j)) * uTexel, sc.z - uBias));
      sh /= 9.0;
    }
  }
  vec3 amb = mix(uGndCol, uSkyCol, n.y * 0.5 + 0.5);
  vec3 base = vCol * uTint;
  vec3 col = base * (amb + uSunCol * ndl * sh);
  col = mix(col, base * 1.25, uEmis);
  float d = length(vWorld - uCam);
  float f = clamp((d - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0);
  col = mix(col, uFogCol, f * f * (3.0 - 2.0 * f));
  oCol = vec4(pow(col, vec3(1.0 / 2.2)), uAlpha);
}`;
  const VS_SHADOW = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uLightVP, uModel;
void main(){ gl_Position = uLightVP*uModel*vec4(aPos,1.0); }`;
  const FS_SHADOW = `#version 300 es
precision mediump float; out vec4 o; void main(){ o = vec4(1.0); }`;
  const VS_SKY = `#version 300 es
out vec2 vN;
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vN = p * 2.0 - 1.0; gl_Position = vec4(vN, 1.0, 1.0); }`;
  const FS_SKY = `#version 300 es
precision highp float; in vec2 vN; out vec4 o;
uniform mat4 uInvVP; uniform vec3 uCam, uSun, uHor, uZen; uniform float uTime, uNight;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
void main(){
  vec4 wp = uInvVP * vec4(vN, 1.0, 1.0);
  vec3 dir = normalize(wp.xyz / wp.w - uCam);
  float h = dir.y;
  vec3 col = mix(uHor, uZen, pow(clamp(h, 0.0, 1.0), 0.55));
  if (h < 0.0) col = uHor * 0.92;
  float s = max(dot(dir, uSun), 0.0);
  vec3 sc = mix(vec3(1.0, 0.85, 0.6), vec3(0.8, 0.86, 1.0), uNight);      // matahari / bulan
  col += sc * (pow(s, mix(900.0, 2500.0, uNight)) * 3.0 + pow(s, 14.0) * 0.12 * (1.0 - uNight));
  if (h > 0.0 && uNight > 0.01) {                                            // bintang
    vec2 g = floor(dir.xz / (h + 0.25) * 240.0);
    float st = step(0.9962, h21(g)) * smoothstep(0.02, 0.3, h) * uNight;
    col += vec3(st) * (0.6 + 0.4 * sin(uTime * 3.0 + h21(g + 7.0) * 40.0));
  }
  if (h > 0.015) {
    vec2 uv = dir.xz / (h + 0.12) * 1.3 + vec2(uTime * 0.004, 0.0);
    float n = vn(uv) * 0.55 + vn(uv * 2.1) * 0.3 + vn(uv * 4.3) * 0.15;
    float c = smoothstep(0.52, 0.78, n) * smoothstep(0.015, 0.2, h);
    col = mix(col, vec3(mix(1.0, 0.07, uNight)) * mix(vec3(1.0), uHor * 2.2, 0.25), c * 0.75);
  }
  o = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;
  function program(vs, fs, names) {
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    p.u = {}; for (const n of names) p.u[n] = gl.getUniformLocation(p, n);
    return p;
  }

  /* ------------------------------ lingkungan ------------------------------- */
  const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const ENV_OUT = { sun: nrm([-0.5, 0.78, 0.42]), sunCol: [1.0, 0.9, 0.76], sky: [0.34, 0.46, 0.64], gnd: [0.2, 0.23, 0.16],
    fog: C('#b9d4e6'), fogNear: 2600, fogFar: 17000, hor: C('#bcd8ea'), zen: C('#3f7fc4') };
  // palet langit siang / senja / malam; envAt() mencampurnya berdasarkan jam game
  const PAL = {
    day: { sunCol: [1.0, 0.9, 0.76], sky: [0.34, 0.46, 0.64], gnd: [0.2, 0.23, 0.16], fog: C('#b9d4e6'), hor: C('#bcd8ea'), zen: C('#3f7fc4') },
    dusk: { sunCol: [1.0, 0.52, 0.26], sky: [0.3, 0.26, 0.36], gnd: [0.15, 0.12, 0.1], fog: C('#c99073'), hor: C('#f0a062'), zen: C('#3d4c8f') },
    night: { sunCol: [0.13, 0.17, 0.3], sky: [0.05, 0.065, 0.13], gnd: [0.02, 0.025, 0.035], fog: C('#0a1020'), hor: C('#152139'), zen: C('#03060f') },
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const envCache = {};
  function envAt(clock, night) {
    const key = Math.round(clock * 60);
    if (envCache.key === key) return envCache.env;
    const t = (clock - 6) / 12 * Math.PI, el = Math.sin(t);                 // ketinggian matahari (-1..1)
    const dayK = smooth(0.02, 0.4, el);
    const base = {};
    for (const k of ['sunCol', 'sky', 'gnd', 'fog', 'hor', 'zen']) base[k] = lerp3(lerp3(PAL.dusk[k], PAL.day[k], dayK), PAL.night[k], night);
    let sun;
    if (el > -0.05 && night < 0.6) sun = nrm([Math.cos(t) * 0.9, Math.max(el, 0.06) + 0.04, 0.38]);
    else { const tm = ((clock - 18 + 24) % 24) / 12 * Math.PI; sun = nrm([Math.cos(tm) * 0.7, Math.max(Math.sin(tm), 0.2) + 0.2, -0.32]); }
    const env = { ...base, sun, night, fogNear: lerp(2600, 900, night), fogFar: lerp(17000, 5600, night) };
    envCache.key = key; envCache.env = env;
    return env;
  }
  const ENV_IN = { sun: nrm([-0.32, 0.86, 0.4]), sunCol: [1.0, 0.9, 0.74], sky: [0.5, 0.46, 0.42], gnd: [0.3, 0.26, 0.22],
    fog: [0.02, 0.015, 0.01], fogNear: 99999, fogFar: 199999, hor: C('#17120d'), zen: C('#17120d') };

  /* ------------------------------ geometri jalan --------------------------- */
  function segDist(px, pz, a, b) {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = dx * dx + dz * dz;
    const t = l ? clamp(((px - a[0]) * dx + (pz - a[1]) * dz) / l, 0, 1) : 0;
    return Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
  }
  function polyDist(px, pz, pts) {
    let d = Infinity;
    for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(px, pz, pts[i], pts[i + 1]));
    return d;
  }
  function offsetLine(pts, off) {
    const n = pts.length, out = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      out.push([pts[i][0] - tz * off, pts[i][1] + tx * off]);
    }
    return out;
  }
  function ribbon(m, pts, w, y, c) {
    const l = offsetLine(pts, w / 2), r = offsetLine(pts, -w / 2);
    for (let i = 0; i < pts.length - 1; i++) m.quad([l[i][0], y, l[i][1]], [l[i + 1][0], y, l[i + 1][1]], [r[i + 1][0], y, r[i + 1][1]], [r[i][0], y, r[i][1]], [0, 1, 0], c);
  }
  function stripSegs(m, pts, w, y, c, skip) {            // garis tipis per ruas; skip(x,z) = lewati (persimpangan)
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (skip && skip((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) continue;
      ribbon(m, [a, b], w, y, c);
    }
  }
  function dashed(m, pts, dash, gap, w, y, c, skip) {
    let draw = true, remain = dash;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
      let pos = 0;
      while (pos < len - 1e-6) {
        const st = Math.min(remain, len - pos);
        if (draw) {
          const p0 = [a[0] + ux * pos, a[1] + uz * pos], p1 = [a[0] + ux * (pos + st), a[1] + uz * (pos + st)];
          if (!skip || !skip((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)) ribbon(m, [p0, p1], w, y, c);
        }
        pos += st; remain -= st;
        if (remain <= 1e-6) { draw = !draw; remain = draw ? dash : gap; }
      }
    }
  }

  function prim0disc(m, cx, cz, r, y, c) {                    // cakram datar (lantai melingkar)
    const n = 28;
    for (let i = 0; i < n; i++) {
      const a0 = i / n * 2 * Math.PI, a1 = (i + 1) / n * 2 * Math.PI;
      m.tri([cx, y, cz], [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r], [0, 1, 0], c);
    }
  }

  /* ------------------------------ dunia statis ----------------------------- */
  const WHITE3 = [1, 1, 1];
  const WALLS = ['#f1e6d0', '#e8d5b5', '#d9e2e8', '#f3efe6', '#e7c9a9', '#d7e3d2', '#f0d9d0'];
  const GREENS = ['#2f6b33', '#3f8a43', '#4a7c2a', '#35793a'];

  function buildWorld() {
    const Wd = L.world.w, Hd = L.world.h;
    const ground = new Mesh(), grass = new Mesh(), sawah = new Mesh(), pads = new Mesh(), roads = new Mesh(), bridges = new Mesh(), marks = new Mesh(), solid = new Mesh(), glass = new Mesh(), lit = new Mesh();
    roads.isRoadMesh = true; marks.isRoadMesh = true;
    const LAB = [];
    const yL = (k) => k * 0.45;

    // tanah + bercak rumput. Wilayah berkontur (barat) memakai mesh grid tersendiri.
    const terr = new Mesh();
    let TX1 = -Infinity;
    if (TER) {
      const T = TER, SK = 2400; TX1 = T.x0 + (T.nx - 1) * T.cell;
      const gc = C('#5b8c3a');
      flat(ground, -12000, -12000, T.x0 - SK, Hd + 12000, 0, gc);
      flat(ground, TX1, -12000, Wd + 12000, Hd + 12000, 0, gc);
      flat(ground, T.x0 - SK, -12000, TX1, -SK, 0, gc);
      flat(ground, T.x0 - SK, Hd + SK, TX1, Hd + 12000, 0, gc);
      const xs = [], zs = [];
      for (let x = T.x0 - SK; x < T.x0; x += 120) xs.push(x);
      for (let i = 0; i < T.nx; i++) xs.push(T.x0 + i * T.cell);
      for (let z = -SK; z < 0; z += 120) zs.push(z);
      for (let j = 0; j < T.ny; j++) zs.push(T.y0 + j * T.cell);
      for (let z = Hd + 120; z <= Hd + SK; z += 120) zs.push(z);
      const hv = zs.map((z) => xs.map((x) => THX(x, z)));
      const nrm = (x, z) => { const e = 20, dx = THX(x + e, z) - THX(x - e, z), dz = THX(x, z + e) - THX(x, z - e); const l = Math.hypot(dx, 2 * e, dz); return [-dx / l, 2 * e / l, -dz / l]; };
      const colAt = (x, z, h, ny) => {
        const nz = hash(Math.floor(x / 90), Math.floor(z / 90)), steep = 1 - ny;
        let c = lerp3(C('#5b8c3a'), C('#3f6e30'), clamp(h / 380, 0, 1));
        if (nz < 0.3 && h > 60) c = shade(c, 0.88);
        if (steep > 0.08) c = lerp3(c, C('#8a7650'), clamp((steep - 0.08) * 5, 0, 0.7));
        return shade(c, 0.94 + nz * 0.12);
      };
      const V = zs.map((z, j) => xs.map((x, i) => { const n = nrm(x, z); return { p: [x, hv[j][i] + 0.05, z], n, c: colAt(x, z, hv[j][i], n[1]) }; }));
      const a = terr.a;
      for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
        const q = [V[j][i], V[j][i + 1], V[j + 1][i + 1], V[j + 1][i]];
        for (const k of [0, 1, 2, 0, 2, 3]) { const v = q[k]; a.push(v.p[0], v.p[1], v.p[2], v.n[0], v.n[1], v.n[2], v.c[0], v.c[1], v.c[2]); }
      }
    } else flat(ground, -12000, -12000, Wd + 12000, Hd + 12000, 0, C('#5b8c3a'));
    for (let i = 0; i < 700; i++) {
      const x = hash(i, 1) * (Wd + 900) - 450, z = hash(i, 2) * (Hd + 900) - 450, s = 60 + hash(i, 3) * 230;
      if (x < TX1 + s) continue;                            // wilayah berkontur punya warna sendiri
      flatRot(grass, x, z, s, s * (0.5 + hash(i, 5)), hash(i, 6) * 3.14, yL(1), C(hash(i, 4) < 0.5 ? '#4f8035' : '#6c9d44'));
    }
    // sawah
    for (const s of L.sawah) {
      flat(sawah, s.x, s.y, s.x + s.w, s.y + s.h, yL(2), C('#8bbb48'));
      for (let z = s.y + 8; z < s.y + s.h - 8; z += 14) flat(sawah, s.x + 6, z, s.x + s.w - 6, z + 6, yL(2) + 0.2, C('#76a83b'));
      const bc = C('#8a7440');
      bx(solid, s.x, 0, s.y, s.x + s.w, 2.4, s.y + 4, bc); bx(solid, s.x, 0, s.y + s.h - 4, s.x + s.w, 2.4, s.y + s.h, bc);
      bx(solid, s.x, 0, s.y, s.x + 4, 2.4, s.y + s.h, bc); bx(solid, s.x + s.w - 4, 0, s.y, s.x + s.w, 2.4, s.y + s.h, bc);
    }
    // arena pacuan kuda, jalan layang, kanopi: lihat bawah. Area beralas:
    const PADC = { yard: '#555b63', spbu: '#5f656d', driveway: '#9a9083', warung: '#9a9083', market: '#8f8579', parking: '#555b63',
      paving: '#9a9083', showroom: '#5b6168', resort: '#a39889', school: '#7d8590', tollplaza: '#4a4f57', plaza: '#a8a093', bengkel: '#4b5057', amp: '#6b6458' };
    for (const p of L.pads) {
      flat(pads, p.x, p.y, p.x + p.w, p.y + p.h, yL(3), C(PADC[p.kind] || '#555b63'));
      if (p.kind === 'driveway' || p.kind === 'warung' || p.kind === 'market' || p.kind === 'paving' || p.kind === 'resort' || p.kind === 'plaza') {          // pola paving
        const lc = C('#847a6e');
        for (let x = p.x + 20; x < p.x + p.w; x += 20) flat(pads, x - 0.4, p.y, x + 0.4, p.y + p.h, yL(3) + 0.1, lc);
        for (let z = p.y + 20; z < p.y + p.h; z += 20) flat(pads, p.x, z - 0.4, p.x + p.w, z + 0.4, yL(3) + 0.1, lc);
      }
    }
    // jalan
    const asph = C('#40454c'), white = C('#e9ecef'), yellow = C('#f2c230');
    const nearOther = (road, x, z, extra) => {
      for (const Q of L.roads) if (Q !== road && polyDist(x, z, Q.pts) < Q.w / 2 + extra) return true;
      return false;
    };
    for (const r of L.roads) if (r.kind === 'toll') ribbon(pads, r.pts, r.w + 16, yL(3.5), C('#b8bec7'));      // bahu beton tol
    for (const r of L.roads) ribbon(roads, r.pts, r.w, yL(4) + (r.kind === 'main' ? 0.15 : r.kind === 'toll' ? 0.1 : 0), asph);
    const bumpStations = [-1, -0.5, 0, 0.5, 1], bumpProfile = [0, 0.55, 1, 0.55, 0];
    for (const bump of L.roadBumps || []) {
      const co = Math.cos(bump.angle), si = Math.sin(bump.angle), nx = -si, nz = co;
      const baseY = yL(4), halves = [];
      for (let i = 0; i < bumpStations.length; i++) {
        const along = bumpStations[i] * bump.halfLength;
        const cx = bump.x + co * along, cz = bump.y + si * along;
        const height = baseY + bump.height * bumpProfile[i];
        halves.push([
          [cx + nx * bump.width / 2, height, cz + nz * bump.width / 2],
          [cx - nx * bump.width / 2, height, cz - nz * bump.width / 2]
        ]);
      }
      for (let i = 0; i < halves.length - 1; i++) {
        const color = i === 1 || i === 2 ? C('#aa9142') : C('#4a5058');
        roads.quad(halves[i][0], halves[i + 1][0], halves[i + 1][1], halves[i][1], [0, 1, 0], color);
      }
    }
    for (const r of L.roads) {
      const skip = (x, z) => nearOther(r, x, z, 3);
      for (const sgn of [1, -1]) stripSegs(marks, offsetLine(r.pts, sgn * (r.w / 2 - 5)), 1.8, yL(5), white, skip);
      if (r.kind === 'toll') {
        for (const sgn of [1, -1]) {
          stripSegs(marks, offsetLine(r.pts, sgn * 4), 1.8, yL(5), yellow, skip);
          dashed(marks, offsetLine(r.pts, sgn * r.w / 4), 30, 30, 2.2, yL(5), white, skip);
          // guard rail: pagar baja bergelombang di kedua tepi jalan tol
          const rail = offsetLine(r.pts, sgn * (r.w / 2 + 7));
          for (let i = 0; i < rail.length - 1; i++) {
            const a = rail[i], b = rail[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]), yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
            if (L.tollGates && L.tollGates.some((g) => Math.hypot(a[0] - g.x, a[1] - g.y) < 170)) continue;
            solid.add(PR.box, trs((a[0] + b[0]) / 2, 5, (a[1] + b[1]) / 2, yaw, 0, len + 0.5, 3.2, 1.2), C('#cfd5dc'));
            if (i % 3 === 0) cylY(solid, a[0], 0, a[1], 0.8, 6, C('#6b7280'));
          }
        }
        continue;
      }
      if (r.w >= 100 && r.kind !== 'access') dashed(marks, r.pts, 28, 24, 2.2, yL(5), yellow, skip);
    }
    for (const bridge of L.bridges || []) {
      const co = Math.cos(bridge.angle), si = Math.sin(bridge.angle), nx = -si, nz = co;
      const halfL = bridge.length / 2, halfW = bridge.width / 2, deckY = bridge.upperZ + yL(4);
      const point = (along, across, y) => [bridge.x + co * along + nx * across, y, bridge.y + si * along + nz * across];
      bridges.quad(point(-halfL, -halfW, deckY), point(halfL, -halfW, deckY),
        point(halfL, halfW, deckY), point(-halfL, halfW, deckY), [0, 1, 0], asph);
      bridges.quad(point(-halfL, -1.2, deckY + 0.2), point(halfL, -1.2, deckY + 0.2),
        point(halfL, 1.2, deckY + 0.2), point(-halfL, 1.2, deckY + 0.2), [0, 1, 0], yellow);
      for (const side of [-1, 1]) {
        bridges.add(PR.boxC, trs(bridge.x + nx * side * (halfW - 2), deckY + 8, bridge.y + nz * side * (halfW - 2),
          bridge.angle, 0, bridge.length, 13, 3), C('#cbd5e1'));
        bridges.add(PR.boxC, trs(bridge.x + nx * side * (halfW - 8), deckY - 5, bridge.y + nz * side * (halfW - 8),
          bridge.angle, 0, bridge.length, 10, 5), C('#64748b'));
      }
      const pierHeight = Math.max(0, deckY - bridge.lowerZ);
      for (const along of [-halfL + 12, halfL - 12]) {
        for (const side of [-1, 1]) {
          const px = bridge.x + co * along + nx * side * Math.max(12, halfW - 14);
          const pz = bridge.y + si * along + nz * side * Math.max(12, halfW - 14);
          bridges.add(PR.boxC, trs(px, bridge.lowerZ + pierHeight / 2, pz, bridge.angle, 0, 16, pierHeight, 16), C('#7c858e'));
        }
      }

      // ---- Render terowongan (underpass) untuk jalan bawah ----
      // Hanya render jika beda ketinggian cukup besar untuk membentuk terowongan
      const heightDiff = bridge.upperZ - bridge.lowerZ;
      if (heightDiff >= BRIDGE_MIN_DIFF) {
        // Jalan bawah mengikuti sudut lowerAngle
        const lco = Math.cos(bridge.lowerAngle), lsi = Math.sin(bridge.lowerAngle);
        const lnx = -lsi, lnz = lco;
        const lowerRoad = (L.roads || []).find(r => r.id === bridge.lowerRoad);
        const tunnelW = (lowerRoad ? lowerRoad.w : 80) / 2 + 4;
        const tunnelH = Math.min(heightDiff - 1, 28); // tinggi terowongan (maks 28 unit)
        const tunnelFloor = bridge.lowerZ + 1.5;       // lantai terowongan
        const tunnelCeil  = tunnelFloor + tunnelH;     // langit-langit terowongan
        const tlen = halfL + 10;                       // panjang terowongan (sedikit lebih dari setengah bridge)
        const tpt = (along, across, y) =>
          [bridge.x + lco * along + lnx * across, y, bridge.y + lsi * along + lnz * across];

        const tunColor = C('#2a2a2a');   // dinding gelap terowongan
        const ceilColor = C('#1a1a1a'); // langit-langit lebih gelap

        // Langit-langit (atap terowongan)
        solid.quad(tpt(-tlen, -tunnelW, tunnelCeil), tpt(tlen, -tunnelW, tunnelCeil),
          tpt(tlen, tunnelW, tunnelCeil), tpt(-tlen, tunnelW, tunnelCeil), [0, -1, 0], ceilColor);

        // Dinding kiri & kanan terowongan
        for (const side of [-1, 1]) {
          solid.quad(
            tpt(-tlen, side * tunnelW, tunnelFloor),
            tpt( tlen, side * tunnelW, tunnelFloor),
            tpt( tlen, side * tunnelW, tunnelCeil),
            tpt(-tlen, side * tunnelW, tunnelCeil),
            [lnx * side, 0, lnz * side], tunColor
          );
        }

        // Portal / dinding penahan di atas mulut terowongan (dari langit-langit ke deck atas)
        for (const end of [-1, 1]) {
          const portalTop = Math.max(tunnelCeil + 3, bridge.upperZ);
          solid.quad(
            tpt(end * tlen, -tunnelW - 4, tunnelCeil),
            tpt(end * tlen,  tunnelW + 4, tunnelCeil),
            tpt(end * tlen,  tunnelW + 4, portalTop),
            tpt(end * tlen, -tunnelW - 4, portalTop),
            [lco * end, 0, lsi * end], tunColor
          );
        }
      }
    }
    // marka dock gudang
    const DEGR = Math.PI / 180;
    for (const b of L.bays) {
      const co = Math.cos(b.angle * DEGR), si = Math.sin(b.angle * DEGR);
      const pt = (lx, ly) => [b.x + lx * co - ly * si, b.y + lx * si + ly * co];
      for (const sy of [-70, 70]) ribbon(marks, [pt(L.TR.rear - 6, sy), pt(L.TR.rear + 190, sy)], 2.4, yL(5), white);
    }

    // ------- benda-benda (rintangan)
    const doorQuad = (x0, x1, z, y0, y1, c, n = [0, 0, 1]) => solid.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], n, c);
    const faceQuad = (face, a0, a1, y0, y1, o, c, off = 0.6, mm = solid) => {          // kotak datar menempel di dinding
      const x = o.x, z = o.y, w = o.w, d = o.h, solid = mm;
      if (face === 'S') solid.quad([a0, y0, z + d + off], [a1, y0, z + d + off], [a1, y1, z + d + off], [a0, y1, z + d + off], [0, 0, 1], c);
      else if (face === 'N') solid.quad([a1, y0, z - off], [a0, y0, z - off], [a0, y1, z - off], [a1, y1, z - off], [0, 0, -1], c);
      else if (face === 'E') solid.quad([x + w + off, y0, a1], [x + w + off, y0, a0], [x + w + off, y1, a0], [x + w + off, y1, a1], [1, 0, 0], c);
      else solid.quad([x - off, y0, a0], [x - off, y0, a1], [x - off, y1, a1], [x - off, y1, a0], [-1, 0, 0], c);
    };
    const addHouse = (o) => {
      const x = o.x, z = o.y, w = o.w, d = o.h, hs = hash(x * 0.37, z * 0.71), special = !!o.home;
      const big = w * d >= 3200;
      const floors = special ? 1 : big ? (hs > 0.15 ? 2 : 1) : (hs > 0.82 ? 2 : 1);
      const wallH = special ? 36 : floors === 2 ? 56 : 30;
      const wallC = special ? C(o.home === 'rumah-puri' ? '#e5e7eb' : '#f1e0c0') : C(WALLS[Math.floor(hs * 97) % WALLS.length]);
      const roofC = shade(C(o.color || '#9a3412'), 0.85 + hs * 0.25);
      bx(solid, x - 0.7, 0, z - 0.7, x + w + 0.7, 3, z + d + 0.7, shade(wallC, 0.7));
      bx(solid, x, 0, z, x + w, wallH, z + d, wallC, 0.3);
      const ov = 5, rh = special ? 20 : floors === 2 ? 15 : 13, alongX = w >= d;
      solid.add(PR.gable, trs(x + w / 2, wallH, z + d / 2, alongX ? 0 : Math.PI / 2, 0, (alongX ? w : d) + 2 * ov, rh, (alongX ? d : w) + 2 * ov), roofC);
      // pintu (sisi selatan) & jendela
      const dw = special ? 13 : 8, dh = special ? 25 : 17, dcx = special ? x + w / 2 : x + w * (0.3 + hs * 0.4);
      doorQuad(dcx - dw / 2, dcx + dw / 2, z + d + 0.7, 0, dh, C(special ? '#5b3a1e' : '#6b4423'));
      const win = C('#5f86a8'), fr = shade(wallC, 0.62), per = wallH / floors;
      for (const face of ['S', 'N', 'E', 'W']) {
        const a0 = face === 'S' || face === 'N' ? x : z, len = face === 'S' || face === 'N' ? w : d;
        const n = Math.max(1, Math.floor((len - 8) / 22)), sp = len / n;
        for (let i = 0; i < n; i++) {
          const c = a0 + sp * (i + 0.5);
          for (let f = 0; f < floors; f++) {
            if (face === 'S' && f === 0 && Math.abs(c - dcx) < dw / 2 + 8) continue;
            const y0 = f * per + per * 0.34;
            faceQuad(face, c - 5.2, c + 5.2, y0 - 1.2, y0 + 10.2, o, fr, 0.5);
            if (hash(c * 0.31 + f, z * 0.17 + x * 0.05) < 0.58) faceQuad(face, c - 4.2, c + 4.2, y0, y0 + 9, o, WHITE3, 0.9, lit);   // jendela menyala malam
            else faceQuad(face, c - 4.2, c + 4.2, y0, y0 + 9, o, win, 0.9);
          }
        }
      }
      if (special) {                    // teras berpilar di depan pintu
        bx(solid, x + w / 2 - 24, 0, z + d, x + w / 2 + 24, 1.6, z + d + 14, C('#bdb7ab'));
        cylY(solid, x + w / 2 - 20, 1.6, z + d + 11, 1.7, 26, C('#f8fafc'));
        cylY(solid, x + w / 2 + 20, 1.6, z + d + 11, 1.7, 26, C('#f8fafc'));
        bx(solid, x + w / 2 - 26, 27.5, z + d - 1, x + w / 2 + 26, 30, z + d + 15, roofC);
        bx(solid, x + w / 2 - 8, 0.2, z + d + 14, x + w / 2 + 8, 0.5, z + d + 20, C('#292524'));
      }
      if (o.label) LAB.push({ text: o.label, x: x + w / 2, z: z + d / 2, h: wallH + rh + 8, size: 17, max: 1100, col: '#ffffff' });
    };

    const treeAt = (o) => {
      const cx = o.x + o.w / 2, cz = o.y + o.h / 2, hs = hash(cx * 0.13, cz * 0.29);
      const th = 11 + hs * 7, r = 12 + hs * 6, g = C(GREENS[Math.floor(hs * 40) % GREENS.length]);
      cylY(solid, cx, 0, cz, 2.2, th + 4, C('#6b4423'));
      sphere(solid, cx, th + r * 0.55, cz, r, g, 0.85, true);
      sphere(solid, cx + r * 0.35, th + r * 0.95, cz - r * 0.2, r * 0.62, shade(g, 1.2), 0.9, true);
    };
    const fenceAt = (o) => {
      const c = C('#8e98a5'), alongX = o.w > o.h, len = alongX ? o.w : o.h;
      const mx = alongX ? o.x : o.x + o.w / 2, mz = alongX ? o.y + o.h / 2 : o.y;
      for (let t = 0; t <= len; t += 40) {
        const px = alongX ? mx + t : mx, pz = alongX ? mz : mz + t;
        bx(solid, px - 1.5, 0, pz - 1.5, px + 1.5, 17, pz + 1.5, c);
      }
      if (alongX) { bx(solid, mx, 5, mz - 0.6, mx + len, 6.2, mz + 0.6, c); bx(solid, mx, 13.5, mz - 0.6, mx + len, 14.7, mz + 0.6, c); }
      else { bx(solid, mx - 0.6, 5, mz, mx + 0.6, 6.2, mz + len, c); bx(solid, mx - 0.6, 13.5, mz, mx + 0.6, 14.7, mz + len, c); }
    };
    const awning = (x, z, w, h0, depth) => {        // kanopi belang merah-kuning di sisi selatan
      for (let i = 0, xx = x; xx < x + w; i++, xx += 25) {
        const e = Math.min(xx + 25, x + w), c = C(i % 2 ? '#fde68a' : '#ef4444');
        solid.quad([xx, h0, z], [e, h0, z], [e, h0 - 4, z + depth], [xx, h0 - 4, z + depth], [0, 0.97, 0.24], c);
      }
    };

    const winGrid = (o, floors, wallH, spacing = 22, ww = 8, wh = 10, faces = ['S', 'N', 'E', 'W'], litK = 0.75) => {
      const per = wallH / floors, fr = C('#475569');
      for (const face of faces) {
        const a0 = face === 'S' || face === 'N' ? o.x : o.y, len = face === 'S' || face === 'N' ? o.w : o.h;
        const n = Math.max(1, Math.floor((len - 8) / spacing)), sp = len / n;
        for (let i = 0; i < n; i++) for (let f = 0; f < floors; f++) {
          const c = a0 + sp * (i + 0.5), y0 = f * per + per * 0.3;
          faceQuad(face, c - ww / 2 - 1, c + ww / 2 + 1, y0 - 1, y0 + wh + 1, o, fr, 0.5);
          if (hash(c * 0.7 + f, a0 * 0.3) < litK) faceQuad(face, c - ww / 2, c + ww / 2, y0, y0 + wh, o, WHITE3, 0.9, lit);
          else faceQuad(face, c - ww / 2, c + ww / 2, y0, y0 + wh, o, C('#5f86a8'), 0.9);
        }
      }
    };
    for (const o of L.obstacles) {
      const x = o.x, z = o.y, w = o.w, d = o.h, cx = x + w / 2, cz = z + d / 2;
      switch (o.kind) {
        case 'displaycar': break;                           // digambar sebagai kendaraan
        case 'lamp': {                                      // tiang lampu jalan
          const lp = (L.lamps || []).find((q) => Math.abs(q.x - cx) < 1 && Math.abs(q.y - cz) < 1);
          const ang = lp ? lp.ang : 0;
          cylY(solid, cx, 0, cz, 1.6, 52, C('#6b7280'));
          solid.add(PR.box, trs(cx + Math.cos(ang) * 11, 50, cz + Math.sin(ang) * 11, ang, 0, 24, 1.6, 1.6), C('#6b7280'));
          solid.add(PR.box, trs(cx + Math.cos(ang) * 22, 51.5, cz + Math.sin(ang) * 22, ang, 0, 11, 2.2, 6), C('#374151'));
          break;
        }
        case 'store': {                                     // Toko Luwes: 2 lantai, papan hijau, etalase kaca
          bx(solid, x, 0, z, x + w, 46, z + d, C('#f8fafc'), 0.25);
          bx(solid, x - 1, 22, z + d - 1, x + w + 1, 30, z + d + 1.5, C(o.color || '#15803d'));
          bx(solid, x - 3, 46, z - 3, x + w + 3, 49, z + d + 3, C('#166534'));
          faceQuad('S', x + 10, x + w - 10, 2, 20, o, WHITE3, 0.8, lit);
          winGrid(o, 1, 46, 26, 10, 9, ['N', 'E', 'W'], 0.6);
          for (let t = x + 16; t < x + w - 10; t += 34) faceQuad('S', t, t + 18, 32, 42, o, WHITE3, 0.8, lit);
          if (o.label) LAB.push({ text: o.label, x: cx, z: z + d + 4, h: 26, size: 17, max: 1000, col: '#bbf7d0' });
          break;
        }
        case 'showroom': {                                  // dealer Mitsubishi: kotak kaca + pilar merah logo
          bx(solid, x, 0, z, x + w, 2, z + d, C('#d1d5db'));
          bx(solid, x - 2, 40, z - 2, x + w + 2, 45, z + d + 2, C('#e5e7eb'));
          for (const [px, pz] of [[x + 2, z + 2], [x + w - 2, z + 2], [x + 2, z + d - 2], [x + w - 2, z + d - 2]]) bx(solid, px - 2, 2, pz - 2, px + 2, 40, pz + 2, C('#9ca3af'));
          bx(glass, x + 1, 2, z + 1, x + w - 1, 40, z + d - 1, C('#9fc3df'));
          faceQuad('W', z + 8, z + d - 8, 4, 36, o, WHITE3, 0.4, lit);
          bx(solid, x + w - 26, 0, z + 10, x + w - 4, 70, z + 40, C('#dc2626'), 0.2);
          for (const a of [0, 2.094, 4.189]) {             // logo tiga berlian di pilar
            const ox = Math.sin(a) * 4.5, oy = Math.cos(a) * 4.5;
            solid.add(PR.box, trs(x + w - 26.6, 54 + oy, z + 25 + ox, 0, 0, 0.6, 5, 3.2), C('#ffffff'));
          }
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 82, size: 18, max: 1200, col: '#fecaca' });
          break;
        }
        case 'hotel': {                                     // Hotel Laras Asri: 3 lantai + atap joglo bertingkat
          bx(solid, x, 0, z, x + w, 66, z + d, C('#f3e8d2'), 0.3);
          for (const yy of [22, 44]) bx(solid, x - 1.5, yy, z - 1.5, x + w + 1.5, yy + 2.5, z + d + 1.5, C('#a16207'));
          winGrid(o, 3, 66, 20, 9, 11, ['S', 'N', 'E', 'W'], 0.7);
          solid.add(PR.gable, trs(cx, 66, cz, 0, 0, w + 16, 18, d + 16), C(o.color || '#7c2d12'));
          bx(solid, cx - w * 0.22, 80, cz - d * 0.18, cx + w * 0.22, 84, cz + d * 0.18, C('#9a3412'));
          solid.add(PR.gable, trs(cx, 84, cz, 0, 0, w * 0.5, 16, d * 0.42), C('#7c2d12'));
          bx(solid, cx - 26, 0, z + d, cx + 26, 2, z + d + 18, C('#d6d3d1'));                 // lobi
          for (const px of [cx - 22, cx + 22]) cylY(solid, px, 2, z + d + 15, 2, 24, C('#78350f'));
          bx(solid, cx - 28, 26, z + d - 1, cx + 28, 29, z + d + 19, C('#7c2d12'));
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 110, size: 19, max: 1300, col: '#fde68a' });
          break;
        }
        case 'school': {                                    // gedung sekolah 2 lantai, atap hijau
          bx(solid, x, 0, z, x + w, 50, z + d, C('#f5f0e1'), 0.3);
          bx(solid, x - 1.5, 24, z - 1.5, x + w + 1.5, 26.5, z + d + 1.5, C('#166534'));
          winGrid(o, 2, 50, 20, 10, 11, ['S', 'N', 'E', 'W'], 0.35);
          solid.add(PR.gable, trs(cx, 50, cz, w >= d ? 0 : Math.PI / 2, 0, (w >= d ? w : d) + 10, 15, (w >= d ? d : w) + 10), C(o.color || '#166534'));
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 78, size: 18, max: 1200, col: '#bbf7d0' });
          break;
        }
        case 'mosque': {                                    // masjid: kubah hijau + menara
          bx(solid, x, 0, z, x + w, 34, z + d, C('#f8fafc'), 0.25);
          winGrid(o, 1, 34, 18, 7, 14, ['S', 'N', 'E', 'W'], 0.8);
          cylY(solid, cx, 34, cz, w * 0.3, 6, C('#e5e7eb'));
          sphere(solid, cx, 40, cz, w * 0.3, C('#15803d'), 0.95);
          cylY(solid, cx, 66, cz, 0.8, 10, C('#fde047'));
          cylY(solid, x + w - 8, 0, z + 8, 5, 78, C('#f1f5f9'));
          solid.add(PR.cone, trs(x + w - 8, 78, z + 8, 0, 0, 12, 14, 12), C('#15803d'));
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 96, size: 15, max: 900, col: '#ffffff' });
          break;
        }
        case 'terminal': {
          bx(solid, x, 0, z, x + w, 2, z + d, C('#64748b'));
          for (const [px, pz] of [[x + 5, z + 5], [x + w - 5, z + 5], [x + 5, z + d - 5], [x + w - 5, z + d - 5]])
            bx(solid, px - 1.5, 2, pz - 1.5, px + 1.5, 22, pz + 1.5, C('#e5e7eb'));
          bx(solid, x - 3, 22, z - 3, x + w + 3, 27, z + d + 3, C('#1d4ed8'));
          bx(solid, x + w / 2 - 30, 27, z - 2, x + w / 2 + 30, 36, z + 1, C('#facc15'));
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 44, size: 15, max: 900, col: '#fef08a' });
          break;
        }
        case 'bus': {
          const body = C(o.color || '#facc15');
          bx(solid, x + 4, 0, z + 2, x + w - 4, 3, z + d - 2, C('#1f2937'));
          bx(solid, x + 2, 3, z + 1, x + w - 2, 25, z + d - 1, body, 0.2);
          bx(solid, x + 7, 15, z + 0.4, x + w - 18, 22, z + 1.2, C('#1e3a5f'));
          bx(solid, x + 7, 15, z + d - 1.2, x + w - 18, 22, z + d - 0.4, C('#1e3a5f'));
          bx(solid, x + w - 15, 11, z + 2, x + w - 4, 24, z + d - 2, C('#bfdbfe'));
          bx(solid, x + 3, 5, z + 2, x + 5, 11, z + d - 2, C('#f8fafc'));
          for (const wx of [x + 26, x + w - 32]) for (const wz of [z - 1, z + d - 3])
            bx(solid, wx, 2, wz, wx + 12, 8, wz + 4, C('#111827'));
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 37, size: 13, max: 700, col: '#fef08a' });
          break;
        }
        case 'tree': treeAt(o); break;
        case 'pine': {                                      // pinus Kopeng: batang tinggi + kerucut bertingkat
          const hs = hash(cx * 0.21, cz * 0.17), th = 34 + hs * 26, g = C(hs < 0.5 ? '#1f4d2b' : '#2a5e34');
          cylY(solid, cx, 0, cz, 1.6, th * 0.5, C('#5b3a1f'));
          for (let k = 0; k < 3; k++) solid.add(PR.coneLo, trs(cx, th * (0.28 + k * 0.2), cz, hs * 6, 0, 22 - k * 5, th * 0.38, 22 - k * 5), shade(g, 1 + k * 0.08));
          break;
        }
        case 'amp': {                                       // Asphalt Mixing Plant: drum pengering, menara, tangki aspal, cerobong
          bx(solid, x, 0, z, x + w, 2, z + d, C('#6b7280'));
          solid.add(PR.cylX, trs(x + 70, 26, z + 70, 0.25, 0, 110, 26, 26), C('#9ca3af'));        // drum
          for (const px of [x + 25, x + 115]) bx(solid, px - 3, 0, z + 62, px + 3, 26, z + 78, C('#4b5563'));
          bx(solid, x + w - 70, 0, z + 10, x + w - 10, 96, z + 70, C('#facc15'), 0.2);            // menara pencampur
          bx(solid, x + w - 74, 96, z + 6, x + w - 6, 102, z + 74, C('#1f2937'));
          for (let yy = 12; yy < 96; yy += 14) bx(solid, x + w - 71, yy, z + 9, x + w - 9, yy + 1.2, z + 71, C('#ca8a04'));
          for (const [tx, tz] of [[x + 30, z + 105], [x + 62, z + 105], [x + 94, z + 105]]) {   // tangki aspal & solar
            solid.add(PR.cylX, trs(tx, 9, tz, Math.PI / 2, 0, 28, 16, 16), C('#e5e7eb'));
          }
          cylY(solid, x + 20, 0, z + 20, 5, 120, C('#cbd5e1')); cylY(solid, x + 20, 112, z + 20, 6, 4, C('#dc2626'));     // cerobong
          for (let i = 0; i < 4; i++) bx(solid, x + 120 + i * 12, 0, z + 2, x + 128 + i * 12, 22, z + 26, C('#16a34a'));   // bin agregat
          solid.add(PR.box, trs(x + 150, 18, z + 45, 0.5, 0.35, 90, 2, 6), C('#374151'));           // konveyor miring
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 128, size: 18, max: 1500, col: '#fde047' });
          break;
        }
        case 'stockpile': {                                 // gunungan pasir / batu split
          solid.add(PR.coneLo, trs(cx, 0, cz, hash(cx, cz) * 6, 0, w * 1.05, 26 + hash(cz, cx) * 10, d * 1.05), C(o.color || '#9ca3af'));
          break;
        }
        case 'fence': fenceAt(o); break;
        case 'house': addHouse(o); break;
        case 'pump': {
          bx(solid, x, 0, z, x + w, 2, z + d, C('#9ca3af'));
          for (const px of [x + 21, x + w - 21]) {
            bx(solid, px - 6, 2, z + 4, px + 6, 18, z + d - 4, C('#e5e7eb'), 0.2);
            bx(solid, px - 7, 18, z + 3, px + 7, 21, z + d - 3, C('#dc2626'));
            bx(solid, px - 4, 9, z + d - 3.6, px + 4, 15, z + d - 3, C('#0b1220'));
          }
          break;
        }
        case 'shop': {
          bx(solid, x, 0, z, x + w, 32, z + d, C('#f1f5f9'), 0.2);
          bx(solid, x - 0.8, 24, z - 0.8, x + w + 0.8, 30, z + d + 0.8, C('#dc2626'));
          bx(solid, x - 3, 32, z - 3, x + w + 3, 35, z + d + 3, C('#7f1d1d'));
          doorQuad(x + 8, x + w - 8, z + d + 0.8, 3, 19, C('#7fb0d6'));
          doorQuad(cx - 6, cx + 6, z + d + 1.1, 3, 18, C('#314a63'));
          break;
        }
        case 'warung': {
          bx(solid, x, 0, z, x + w, 28, z + d, C('#0f766e'), 0.25);
          bx(solid, x - 4, 28, z - 4, x + w + 4, 31, z + d + 4, C('#94a3b8'));
          awning(x, z + d, w, 24, 16);
          for (const px of [x + 4, x + w - 4]) cylY(solid, px, 0, z + d + 14, 1.3, 22, C('#f8fafc'));
          doorQuad(x + 20, x + w - 20, z + d + 0.8, 6, 18, C('#1f2937'));
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 38, size: 15, max: 800, col: '#ffffff' });
          break;
        }
        case 'market': {
          bx(solid, x, 0, z, x + w, 40, z + d, C('#c2701f'), 0.25);
          solid.add(PR.gable, trs(cx, 40, cz, 0, 0, w + 14, 22, d + 14), C('#9a3412'));
          awning(x + 10, z + d, w - 20, 34, 20);
          for (let px = x + 14; px <= x + w - 14; px += 60) cylY(solid, px, 0, z + d + 18, 1.5, 32, C('#f8fafc'));
          doorQuad(x + 40, x + w - 40, z + d + 0.8, 4, 24, C('#3b2a1a'));
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 70, size: 18, max: 1000, col: '#ffffff' });
          break;
        }
        case 'monument': {                                  // Patung Tiga Pahlawan: alas bertingkat + 3 sosok
          bx(solid, x, 0, z, x + w, 6, z + d, C('#e7e5e4'), 0.2);
          bx(solid, x + 6, 6, z + 6, x + w - 6, 22, z + d - 6, C('#a8a29e'), 0.2);
          for (const [dx, dz, hh] of [[-9, 4, 26], [0, -5, 30], [9, 4, 26]]) {
            const px = cx + dx, pz = cz + dz;
            cylY(solid, px, 22, pz, 3.2, hh * 0.6, C('#57534e'));
            sphere(solid, px, 22 + hh * 0.6 + 3, pz, 3, C('#57534e'));
          }
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 64, size: 14, max: 700, col: '#ffffff' });
          break;
        }
        case 'cart': {                                      // gerobak wedang ronde
          bx(solid, x, 6, z, x + w, 18, z + d, C(o.color || '#b45309'), 0.2);
          bx(solid, x - 2, 30, z - 2, x + w + 2, 32, z + d + 2, C('#fef3c7'));
          for (const [px, pz] of [[x + 2, z + 2], [x + w - 2, z + 2], [x + 2, z + d - 2], [x + w - 2, z + d - 2]]) cylY(solid, px, 18, pz, 0.7, 12, C('#78350f'));
          for (const px of [x + 6, x + w - 6]) solid.add(PR.cylZ, trs(px, 5, z + d / 2, 0, 0, 10, 10, d + 2), C('#111827'));
          cylY(solid, x + 8, 18, z + d / 2, 3, 6, C('#9ca3af'));
          break;
        }
        case 'kumon': {                                     // gedung les Kumon Sukowati: 2 lantai, papan biru
          bx(solid, x, 0, z, x + w, 48, z + d, C('#e0f2fe'), 0.25);
          bx(solid, x - 1.5, 22, z - 1.5, x + w + 1.5, 24.5, z + d + 1.5, C(o.color || '#0369a1'));
          bx(solid, x - 3, 48, z - 3, x + w + 3, 51, z + d + 3, C('#0c4a6e'));
          bx(solid, x + 20, 30, z - 2.5, x + w - 20, 44, z - 0.5, C(o.color || '#0369a1'));
          faceQuad('N', x + 10, x + w - 10, 4, 18, o, WHITE3, 0.8, lit);
          doorQuad(x + w / 2 - 10, x + w / 2 + 10, z - 0.8, 0, 20, C('#1e3a5f'), [0, 0, -1]);
          if (o.label) LAB.push({ text: o.label, x: cx, z: z - 4, h: 37, size: 17, max: 1000, col: '#e0f2fe' });
          break;
        }
        case 'signal': break;
        case 'bengkel': {                                   // bengkel: gudang atap seng, 3 pintu garasi di sisi barat
          bx(solid, x, 0, z, x + w, 52, z + d, C('#e5e7eb'), 0.3);
          solid.add(PR.gable, trs(cx, 52, cz, Math.PI / 2, 0, d + 10, 16, w + 10), C(o.color || '#ea580c'));
          for (let k = 0; k < 3; k++) {
            const z0 = z + 20 + k * 70;
            solid.quad([x - 0.7, 0, z0 + 50], [x - 0.7, 0, z0], [x - 0.7, 36, z0], [x - 0.7, 36, z0 + 50], [-1, 0, 0], C('#374151'));
            for (let yy = 5; yy < 36; yy += 5) solid.quad([x - 0.9, yy, z0 + 50], [x - 0.9, yy, z0], [x - 0.9, yy + 0.7, z0], [x - 0.9, yy + 0.7, z0 + 50], [-1, 0, 0], C('#4b5563'));
          }
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 84, size: 18, max: 1100, col: '#fed7aa' });
          break;
        }
        case 'partsrack': {                                 // rak suku cadang: tumpukan ban & blok mesin
          bx(solid, x, 0, z, x + w, 3, z + d, C('#6b7280'));
          for (let xx = x + 12; xx < x + w - 6; xx += 18) for (let k = 0; k < 3; k++) solid.add(PR.cylY, trs(xx, 3 + k * 4.2, z + 16, 0, 0, 14, 4, 14), C('#111827'));
          for (let xx = x + 8; xx < x + w - 16; xx += 26) bx(solid, xx, 3, z + 36, xx + 18, 15, z + 58, C('#9ca3af'), 0.2);
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 26, size: 13, max: 700, col: '#e5e7eb' });
          break;
        }                               // tiang lampu lalu lintas: lihat di bawah
        case 'tollbooth': {
          bx(solid, x, 0, z, x + w, 26, z + d, C('#fbbf24'), 0.2);
          bx(solid, x - 3, 26, z - 3, x + w + 3, 29, z + d + 3, C('#374151'));
          break;
        }
        case 'factory': {
          bx(solid, x, 0, z, x + w, 90, z + d, C('#6f7d93'), 0.35);
          for (const yy of [18, 38, 58, 78]) bx(solid, x - 0.6, yy, z - 0.6, x + w + 0.6, yy + 3, z + d + 0.6, C('#596679'));
          bx(solid, x - 2, 90, z - 2, x + w + 2, 94, z + d + 2, C('#8b97a8'));
          for (let t = 0; t < 3; t++) bx(solid, x + 25 + t * 40, 94, cz - 12, x + 45 + t * 40, 104, cz + 12, C('#a9b3c1'));
          for (const zn of L.zones) {            // pintu rolling di sisi barat, sejajar zona parkir
            if (zn.y < z || zn.y > z + d) continue;
            solid.quad([x - 0.7, 0, zn.y - 27], [x - 0.7, 0, zn.y + 27], [x - 0.7, 48, zn.y + 27], [x - 0.7, 48, zn.y - 27], [-1, 0, 0], C('#3b4658'));
            for (let yy = 6; yy < 48; yy += 6) solid.quad([x - 0.9, yy, zn.y - 27], [x - 0.9, yy, zn.y + 27], [x - 0.9, yy + 0.8, zn.y + 27], [x - 0.9, yy + 0.8, zn.y - 27], [-1, 0, 0], C('#556178'));
            bx(solid, x - 7, 0, zn.y - 25, x - 0.5, 6, zn.y + 25, C('#facc15'));
            LAB.push({ text: zn.id, x: x - 30, z: zn.y, h: 62, size: 15, max: 650, col: '#bbf7d0' });
          }
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 112, size: 19, max: 1100, col: '#ffffff' });
          break;
        }
        case 'dock': {
          bx(solid, x, 0, z, x + w, 70, z + d, C('#8a94a3'), 0.35);
          bx(solid, x - 2, 70, z - 2, x + w + 2, 74, z + d + 2, C('#a1abb9'));
          for (const b of L.bays) {
            solid.quad([x - 0.7, 0, b.y - 31], [x - 0.7, 0, b.y + 31], [x - 0.7, 50, b.y + 31], [x - 0.7, 50, b.y - 31], [-1, 0, 0], C('#334155'));
            for (let yy = 6; yy < 50; yy += 6) solid.quad([x - 0.9, yy, b.y - 31], [x - 0.9, yy, b.y + 31], [x - 0.9, yy + 0.8, b.y + 31], [x - 0.9, yy + 0.8, b.y - 31], [-1, 0, 0], C('#4b5a70'));
            bx(solid, x - 7, 0, b.y - 29, x - 0.5, 6, b.y + 29, C('#facc15'));
            bx(solid, x - 0.5, 52, b.y - 33, x + 0.5, 56, b.y + 33, C('#1f2937'));
            LAB.push({ text: b.id, x: x - 4, z: b.y, h: 62, size: 14, max: 650, col: '#fde68a' });
          }
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 96, size: 19, max: 1100, col: '#ffffff' });
          break;
        }
        case 'building': {
          bx(solid, x, 0, z, x + w, 40, z + d, C('#e8edf2'), 0.25);
          bx(solid, x - 2, 40, z - 2, x + w + 2, 43, z + d + 2, C('#475569'));
          for (let t = x + 10; t < x + w - 8; t += 22) { doorQuad(t, t + 12, z + d + 0.6, 12, 30, C('#5f86a8')); doorQuad(t, t + 12, z - 0.6, 12, 30, C('#5f86a8'), [0, 0, -1]); }
          if (o.label) LAB.push({ text: o.label, x: cx, z: cz, h: 56, size: 16, max: 800, col: '#ffffff' });
          break;
        }
        default: bx(solid, x, 0, z, x + w, 20, z + d, C('#59606b'), 0.25);
      }
    }

    // ------- lampu lalu lintas (tiang & kepala lampu; bola lampu digambar dinamis di drawSignals)
    for (const sg of L.signals || []) for (const a of sg.arms) {
      const lx = a.uy, ly = -a.ux, yaw = Math.atan2(a.uy, a.ux);
      ribbon(marks, [[a.sx + lx * 3, a.sy + ly * 3], [a.sx + lx * (a.w / 2 - 8), a.sy + ly * (a.w / 2 - 8)]], 4, yL(5) + 0.15, white);
      cylY(solid, a.px, 0, a.py, 1.3, 50, C('#374151'));
      solid.add(PR.boxC, trs(a.px, 42, a.py, yaw, 0, 5, 20, 9), C('#111827'));
      solid.add(PR.boxC, trs(a.px - a.ux * 2.6, 52.5, a.py - a.uy * 2.6, yaw, 0, 2, 1.2, 10), C('#111827'));   // pelindung atas
      solid.add(PR.boxC, trs(a.px - a.ux * 2.6, 56.5, a.py - a.uy * 2.6, yaw, 0, 2.5, 6, 8), C('#0f172a'));    // kotak display countdown digital
    }

    // ------- dekorasi
    for (const dc of L.decor) {
      if (dc.kind === 'pool') {
        flat(pads, dc.x - 6, dc.y - 6, dc.x + dc.w + 6, dc.y + dc.h + 6, yL(3) + 0.3, C('#e7e5e4'));
        flat(pads, dc.x, dc.y, dc.x + dc.w, dc.y + dc.h, yL(3) + 0.5, C('#38bdf8'));
        for (let k = 0; k < 4; k++) bx(solid, dc.x + 12 + k * 26, 0, dc.y + dc.h + 12, dc.x + 30 + k * 26, 3, dc.y + dc.h + 22, C('#f8fafc'));
        continue;
      }
      if (dc.kind === 'field') {
        flat(pads, dc.x, dc.y, dc.x + dc.w, dc.y + dc.h, yL(3) + 0.3, C('#4d7c0f'));
        flat(pads, dc.x + 3, dc.y + dc.h / 2 - 0.8, dc.x + dc.w - 3, dc.y + dc.h / 2 + 0.8, yL(3) + 0.5, C('#f8fafc'));
        cylY(solid, dc.x + dc.w / 2, 0, dc.y - 30, 0.9, 60, C('#e5e7eb'));                 // tiang bendera
        bx(solid, dc.x + dc.w / 2 + 0.9, 50, dc.y - 30.3, dc.x + dc.w / 2 + 16, 55, dc.y - 29.7, C('#dc2626'));
        bx(solid, dc.x + dc.w / 2 + 0.9, 45, dc.y - 30.3, dc.x + dc.w / 2 + 16, 50, dc.y - 29.7, C('#f8fafc'));
        continue;
      }
      if (dc.kind === 'schoolzone') {
        const mainR = L.roads.find((r) => r.kind === 'main');
        for (const yy of [dc.y0, dc.y1 - 70]) {
          const seg = mainR.pts.filter((q) => q[1] >= yy - 40 && q[1] <= yy + 110);
          if (seg.length >= 2) ribbon(marks, seg.map((q) => [q[0], Math.min(Math.max(q[1], yy), yy + 70)]), mainR.w - 16, yL(5) + 0.1, C('#b91c1c'));
          const mx = seg.length ? seg[0][0] : 0;
          LAB.push({ text: dc.label, x: mx, z: yy + 35, h: 4, size: 14, max: 700, col: '#fee2e2' });
        }
        continue;
      }
      if (dc.kind === 'alun') {                       // Alun-alun Pancasila: lapangan rumput + jalur silang + bangku
        flat(pads, dc.x + 16, dc.y + 16, dc.x + dc.w - 16, dc.y + dc.h - 16, yL(3) + 0.2, C('#4f8a3a'));
        for (let xx = dc.x + 30; xx < dc.x + dc.w - 20; xx += 48) flat(pads, xx, dc.y + 16, xx + 12, dc.y + dc.h - 16, yL(3) + 0.3, C('#5a9642'));
        const pv = C('#d6cfc2');
        flat(pads, dc.x + dc.w / 2 - 9, dc.y + 16, dc.x + dc.w / 2 + 9, dc.y + dc.h - 16, yL(3) + 0.4, pv);
        flat(pads, dc.x + 16, dc.y + dc.h / 2 - 9, dc.x + dc.w - 16, dc.y + dc.h / 2 + 9, yL(3) + 0.4, pv);
        prim0disc(pads, dc.x + dc.w / 2, dc.y + dc.h / 2, 46, yL(3) + 0.45, pv);
        for (const [bx0, bz0] of [[dc.x + 60, dc.y + dc.h / 2 + 14], [dc.x + dc.w - 100, dc.y + dc.h / 2 + 14], [dc.x + 60, dc.y + dc.h / 2 - 22], [dc.x + dc.w - 100, dc.y + dc.h / 2 - 22]]) {
          bx(solid, bx0, 4, bz0, bx0 + 40, 5.5, bz0 + 8, C('#7c4a21'));
          for (const px of [bx0 + 3, bx0 + 37]) bx(solid, px - 1, 0, bz0 + 1, px + 1, 4, bz0 + 7, C('#374151'));
        }
        LAB.push({ text: dc.label, x: dc.x + dc.w / 2, z: dc.y + 40, h: 14, size: 20, max: 1400, col: '#fef3c7' });
        continue;
      }
      if (dc.kind === 'tollgate') {                   // kanopi gerbang tol di atas gardu
        const hw = dc.w / 2, y0 = 42, cw = 50, hz = dc.horizontal;
        const B = (a0, a1, y1, y2, b0, b1, c) => hz ? bx(solid, dc.x + b0, y1, dc.y + a0, dc.x + b1, y2, dc.y + a1, c) : bx(solid, dc.x + a0, y1, dc.y + b0, dc.x + a1, y2, dc.y + b1, c);
        for (const a of [-hw + 4, hw - 4]) B(a - 3, a + 3, 0, y0, -3, 3, C('#e5e7eb'));
        B(-hw, hw, y0, y0 + 5, -cw / 2, cw / 2, C('#1e40af'));
        B(-hw, hw, y0 + 5, y0 + 6.5, -cw / 2, cw / 2, C('#facc15'));
        LAB.push({ text: dc.label, x: dc.x, z: dc.y, h: y0 + 16, size: 16, max: 1200, col: '#ffffff' });
        continue;
      }
      if (dc.kind === 'canopy') {                     // atap SPBU
        const y0 = 50;
        for (const [px, pz] of [[dc.x + 12, dc.y + 12], [dc.x + dc.w - 12, dc.y + 12], [dc.x + 12, dc.y + dc.h - 12], [dc.x + dc.w - 12, dc.y + dc.h - 12]])
          cylY(solid, px, 0, pz, 3, y0, C('#e5e7eb'));
        bx(glass, dc.x, y0, dc.y, dc.x + dc.w, y0 + 4, dc.y + dc.h, C('#f3f4f6'));      // atap tembus pandang agar pompa tetap terlihat dari atas
        bx(solid, dc.x - 0.5, y0 + 0.5, dc.y - 0.5, dc.x + dc.w + 0.5, y0 + 3.5, dc.y + 2, C('#dc2626'));
        bx(solid, dc.x - 0.5, y0 + 0.5, dc.y + dc.h - 2, dc.x + dc.w + 0.5, y0 + 3.5, dc.y + dc.h + 0.5, C('#dc2626'));
        LAB.push({ text: dc.label, x: dc.x + dc.w / 2, z: dc.y + dc.h, h: y0 + 10, size: 17, max: 900, col: '#fecaca' });
      } else if (dc.kind === 'arena') {               // arena pacuan kuda: lintasan tanah, lapangan, pagar, tribun
        const seg = 56;
        for (let i = 0; i < seg; i++) {
          const a0 = i / seg * 2 * Math.PI, a1 = (i + 1) / seg * 2 * Math.PI;
          const P3 = (a, rx, rz, y) => [dc.x + Math.cos(a) * rx, y, dc.y + Math.sin(a) * rz];
          pads.quad(P3(a0, dc.rx, dc.ry, yL(3) - 0.1), P3(a1, dc.rx, dc.ry, yL(3) - 0.1), P3(a1, dc.rx - 50, dc.ry - 50, yL(3) - 0.1), P3(a0, dc.rx - 50, dc.ry - 50, yL(3) - 0.1), [0, 1, 0], C('#a9742a'));
          for (const k of [0, 50]) {
            const rx = dc.rx - k, rz = dc.ry - k, px0 = dc.x + Math.cos(a0) * rx, pz0 = dc.y + Math.sin(a0) * rz;
            const px1 = dc.x + Math.cos(a1) * rx, pz1 = dc.y + Math.sin(a1) * rz;
            bx(solid, (px0 + px1) / 2 - Math.hypot(px1 - px0, pz1 - pz0) / 2, 0, (pz0 + pz1) / 2 - 0.6, (px0 + px1) / 2 + Math.hypot(px1 - px0, pz1 - pz0) / 2, 7, (pz0 + pz1) / 2 + 0.6, C('#f8fafc'), 0, 0);
          }
        }
        // lapangan dalam: kipas segitiga
        for (let i = 0; i < seg; i++) {
          const a0 = i / seg * 2 * Math.PI, a1 = (i + 1) / seg * 2 * Math.PI;
          pads.tri([dc.x, yL(3), dc.y], [dc.x + Math.cos(a0) * (dc.rx - 50), yL(3), dc.y + Math.sin(a0) * (dc.ry - 50)],
            [dc.x + Math.cos(a1) * (dc.rx - 50), yL(3), dc.y + Math.sin(a1) * (dc.ry - 50)], [0, 1, 0], C('#6a9a3c'));
        }
        const tz = dc.y - dc.ry - 46;                  // tribun di sisi utara
        for (let k = 0; k < 3; k++) bx(solid, dc.x - 110 + k * 8, k * 7, tz + k * 9, dc.x + 110 - k * 8, k * 7 + 7, tz + 40, C(k % 2 ? '#cbd5e1' : '#94a3b8'), 0.2);
        bx(solid, dc.x - 116, 30, tz - 4, dc.x + 116, 33, tz + 44, C('#b45309'));
        for (const px of [dc.x - 108, dc.x + 108]) cylY(solid, px, 0, tz + 38, 2, 30, C('#e5e7eb'));
        LAB.push({ text: dc.label, x: dc.x, z: dc.y, h: 18, size: 17, max: 1100, col: '#ffffff' });
      } else if (dc.kind === 'toll') {                // jalan tol layang
        const deckY = 80, pts = dc.pts, deckC = C('#4a4f58'), side = C('#9ca3af');
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]), yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
          const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
          solid.add(PR.box, trs(mx, deckY - 6, mz, yaw, 0, len + 2, 6, dc.w), side);
          solid.add(PR.box, trs(mx, deckY, mz, yaw, 0, len + 2, 0.6, dc.w - 4), deckC);
          for (const sg of [-1, 1]) solid.add(PR.box, trs(mx - Math.sin(yaw) * sg * (dc.w / 2 - 1.2), deckY, mz + Math.cos(yaw) * sg * (dc.w / 2 - 1.2), yaw, 0, len + 2, 8, 2.4), C('#c5cad3'));
          // marka putus-putus di atas dek
          const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
          for (let t = 0; t < len; t += 44) solid.add(PR.box, trs(a[0] + ux * (t + 12), deckY + 0.6, a[1] + uz * (t + 12), yaw, 0, 24, 0.2, 1.8), C('#f8fafc'));
          for (let t = 40; t < len; t += 190) {        // tiang penyangga (hindari badan jalan di bawahnya)
            const px = a[0] + ux * t, pz = a[1] + uz * t;
            if (L.roads.some((r) => polyDist(px, pz, r.pts) < r.w / 2 + 14)) continue;
            cylY(solid, px, 0, pz, 7, deckY - 6, C('#b6bcc6'));
            solid.add(PR.box, trs(px, deckY - 12, pz, yaw + Math.PI / 2, 0, 18, 6, dc.w - 20), C('#a3aab5'));
          }
        }
        const m = pts[2];
        LAB.push({ text: dc.label + ' (jalan layang)', x: m[0], z: m[1], h: deckY + 18, size: 16, max: 1500, col: '#e5e7eb' });
      } else if (dc.kind === 'ampsilo') {                  // silo hotmix berkaki 4 di atas jalur dump truck
        const x0 = dc.x - 6, x1 = dc.x + dc.w + 6, z0 = dc.y + 20, z1 = dc.y + dc.h - 20;
        for (const px of [x0, x1]) for (const pz of [z0, z1]) bx(solid, px - 2.5, 0, pz - 2.5, px + 2.5, 52, pz + 2.5, C('#4b5563'));
        bx(solid, x0 - 2, 52, z0 - 4, x1 + 2, 56, z1 + 4, C('#374151'));
        cylY(solid, (x0 + x1) / 2, 56, (z0 + z1) / 2, dc.w * 0.42, 50, C('#e5e7eb'));
        solid.add(PR.cone, trs((x0 + x1) / 2, 56, (z0 + z1) / 2, 0, 0, dc.w * 0.84, -12, dc.w * 0.84), C('#9ca3af'));
        bx(solid, (x0 + x1) / 2 - 4, 40, (z0 + z1) / 2 - 4, (x0 + x1) / 2 + 4, 52, (z0 + z1) / 2 + 4, C('#1f2937'));
        LAB.push({ text: dc.label, x: (x0 + x1) / 2, z: (z0 + z1) / 2, h: 116, size: 15, max: 900, col: '#e5e7eb' });
        flatRot(marks, dc.x + dc.w / 2, dc.y + dc.h / 2, dc.w, dc.h, 0, yL(5), C('#facc15'));
        flatRot(marks, dc.x + dc.w / 2, dc.y + dc.h / 2, dc.w - 4, dc.h - 4, 0, yL(5) + 0.05, C('#4b5057'));
      } else if (dc.kind === 'gapura') {
        const hw = dc.w / 2;
        for (const px of [dc.x - hw - 1, dc.x + hw + 1]) {
          bx(solid, px - 13, 0, dc.y - 11, px + 13, 62, dc.y + 11, C('#8a3a14'), 0.2);
          solid.add(PR.coneLo, trs(px, 62, dc.y, Math.PI / 4, 0, 34, 16, 34), C('#b45309'));
        }
        bx(solid, dc.x - hw - 14, 52, dc.y - 9, dc.x + hw + 14, 66, dc.y + 9, C('#b45309'));
        bx(solid, dc.x - hw + 6, 66, dc.y - 6, dc.x + hw - 6, 73, dc.y + 6, C('#7c2d12'));
        LAB.push({ text: dc.title || 'SRUWEN', x: dc.x, z: dc.y + 10, h: 59, size: 15, max: 900, col: '#fef3c7' });
        LAB.push({ text: dc.label, x: dc.x + hw + 90, z: dc.y, h: 28, size: 14, max: 800, col: '#fde68a' });
      }
    }
    for (const lb of L.labels) LAB.push({ text: lb.text, x: lb.x, z: lb.y, h: 24, size: Math.max(12, (lb.size || 16) * 0.9), max: 1300, col: '#fde68a' });
    for (const zn of L.zones) LAB.push({ text: zn.id, x: zn.x, z: zn.y, h: 8, size: 13, max: 500, col: '#86efac', zone: zn.id });

    if (TER) {                                          // Gunung Merbabu & Telomoyo di barat laut
      ground.add(PR.coneLo, trs(-3400, THX(-2400, -1800) - 60, -2600, 0.3, 0, 7200, 3000, 6400), C('#56795c'));
      ground.add(PR.coneLo, trs(-2600, THX(-2400, 900) - 40, 1400, 1.1, 0, 4200, 1500, 3800), C('#62865f'));
      LAB.push({ text: 'GUNUNG MERBABU', x: -3400, z: -2600, h: 3200, size: 60, max: 12000, col: '#e2e8f0' });
    }
    // gunung di cakrawala
    const cx0 = Wd / 2, cz0 = Hd / 2;
    for (let i = 0; i < 26; i++) {
      const a = i / 26 * 2 * Math.PI + hash(i, 9) * 0.2, k = 1 + hash(i, 10) * 0.5;
      const dist = 1.0 + hash(i, 11) * 0.45, px = cx0 + Math.cos(a) * (Wd / 2 + 4200 * dist), pz = cz0 + Math.sin(a) * (Hd / 2 + 3600 * dist);
      const r = 1500 + hash(i, 12) * 1600, h = (1500 + hash(i, 13) * 2400) * k;
      ground.add(PR.coneLo, trs(px, -20, pz, hash(i, 14) * 6, 0, r * 2, h, r * 2), C(hash(i, 15) < 0.5 ? '#5f8466' : '#6d8f78'));
    }
    return { layers: [ground, terr, grass, sawah, pads, roads, bridges, marks], drape: [sawah, pads, roads, marks, solid, glass, lit], solid, glass, lit, labels: LAB };
  }

  /* ------------------------------ model kendaraan -------------------------- */
  // Model = badan (mesh dibakar, warna per-vertex) + roda (berputar/menyetir) + lampu (emisif).
  const models = {};
  const LPG_PLANET = { x: 1450, altitude: 19000, z: 5400 };
  let lpgPlanet = null;
  const lampH = (s, x, y, z) => ({ x, y, z, sx: 0.9, sy: 1.8, sz: 3.6, kind: 'head' });
  function bakeTractor(V) {
    const s = V.spec, hw = s.hw, c = C(V.color), dark = C('#2d3748'), glass = C('#1e3a5f'), m = new Mesh();
    bx(m, s.rear, 8, -hw * 0.7, 34, 11, hw * 0.7, dark);
    cylY(m, s.fifth, 11, 0, 11, 2.5, C('#6b7280'));
    bx(m, 24, 10, -(hw - 1.5), 48, 37, hw - 1.5, c, 0.2);
    bx(m, 24, 37, -(hw - 3), 38, 43, hw - 3, shade(c, 1.12));
    bx(m, 48, 10, -(hw - 3), s.front, 21, hw - 3, c, 0.2);
    bx(m, 47.8, 24, -(hw - 6), 48.6, 35, hw - 6, glass);
    for (const sg of [-1, 1]) {
      bx(m, 30, 24, sg > 0 ? hw - 1.7 : -(hw - 1.1), 44, 34, sg > 0 ? hw - 1.1 : -(hw - 1.7), glass);
      m.add(PR.cylY, trs(22, 10, sg * (hw - 3), 0, 0, 3.2, 36, 3.2), C('#b8c0cc'));
      m.add(PR.cylX, trs(21, 8.5, sg * (hw - 3.5), 0, 0, 18, 9, 9), C('#cbd5e1'));
      bx(m, 45, 27, sg * (hw + 0.4) - 0.6, 47, 34, sg * (hw + 0.4) + 0.6, C('#111827'));
    }
    bx(m, s.front - 0.6, 11, -8, s.front + 0.4, 19, 8, C('#111827'));
    bx(m, s.front - 2, 6, -(hw - 1), s.front + 2, 10, hw - 1, C('#4b5563'));
    const wheels = [];
    for (const sg of [-1, 1]) {
      wheels.push({ x: 0, y: 5.5, z: sg * (hw - 2), r: 5.5, w: 5.5 }, { x: -11, y: 5.5, z: sg * (hw - 2), r: 5.5, w: 5.5 },
        { x: s.wb, y: 5.5, z: sg * (hw - 2), r: 5.5, w: 5.5, steer: true });
    }
    const lamps = [];
    for (const sg of [-1, 1]) {
      lamps.push({ x: s.front, y: 15.5, z: sg * (hw - 6), sx: 1, sy: 3, sz: 4.5, kind: 'head' }, { x: s.rear, y: 9.5, z: sg * 12, sx: 1, sy: 2.4, sz: 4, kind: 'tail' });
    }
    return { body: m.upload(), wheels, lamps, movers: wiperPair(48.65, 24.8, hw - 6) };
  }
  function bakeBus(V) {
    const s = V.spec, hw = s.hw, rear = s.rear, front = s.front, c = C(V.color), m = new Mesh();
    bx(m, rear + 6, 3, -(hw - 3), front - 6, 6, hw - 3, C('#1f2937'));                 // sasis
    bx(m, rear, 6, -hw, front, 30, hw, c, 0.25);                                       // bodi
    bx(m, rear + 8, 17, -hw - 0.3, front - 24, 25, hw + 0.3, C('#1e3a5f'));            // jendela samping kiri-kanan
    bx(m, front - 1, 14, -(hw - 3), front + 0.4, 28, hw - 3, C('#bfdbfe'));            // kaca depan
    bx(m, rear - 0.4, 14, -(hw - 4), rear + 0.2, 26, hw - 4, C('#1e3a5f'));            // kaca belakang
    bx(m, rear + 6, 6, -hw - 0.4, front - 6, 9, -hw + 1, C('#f8fafc'));                // list putih
    bx(m, rear + 6, 6, hw - 1, front - 6, 9, hw + 0.4, C('#f8fafc'));
    bx(m, rear + 2, 30, -hw + 4, front - 4, 31.2, hw - 4, shade(c, 1.15));             // atap
    bx(m, front - 20, 17, hw - 0.4, front - 8, 26, hw + 0.4, C('#0f172a'));            // pintu penumpang
    bx(m, front - 1.4, 5, -(hw - 1), front + 0.2, 9, hw - 1, C('#2a2f36'));            // bumper
    bx(m, rear - 0.2, 5, -(hw - 1), rear + 1.4, 9, hw - 1, C('#2a2f36'));
    const wheels = [], lamps = [];
    for (const sg of [-1, 1]) {
      wheels.push({ x: 0, y: 5.5, z: sg * (hw - 2), r: 5.5, w: 5.5 }, { x: s.wb, y: 5.5, z: sg * (hw - 2), r: 5.5, w: 5.5, steer: true });
      lamps.push({ x: front, y: 11, z: sg * (hw - 5), sx: 1, sy: 2.4, sz: 4.5, kind: 'head' }, { x: rear, y: 11, z: sg * (hw - 5), sx: 1, sy: 2.4, sz: 4.5, kind: 'tail' });
    }
    return { body: m.upload(), wheels, lamps, movers: wiperPair(front + 0.45, 15, hw - 3) };
  }
  function bakeCar(V) {
    const s = V.spec, hw = s.hw, rear = s.rear, front = s.front, len = front - rear, c = C(V.color), model = s.model, m = new Mesh();
    const pf = model === 'hatch' ? { a0: 0.06, a1: 0.6, h: 13.5 } : model === 'mpv' ? { a0: 0.04, a1: 0.76, h: 17.5 }
      : model === 'suv' ? { a0: 0.05, a1: 0.7, h: 19 } : model === 'pickup' ? { a0: 0.5, a1: 0.78, h: 17.5 } : { a0: 0.2, a1: 0.62, h: 14.2 };
    const g0 = rear + len * pf.a0, g1 = rear + len * pf.a1, gh = pf.h, gz = hw - 1.3;
    bx(m, rear, 2.8, -hw, front, 8.6, hw, c, 0.3);
    bx(m, g0, 8.6, -gz, g1, gh, gz, C('#1b2a3d'));
    for (const x of [g0, g1 - 0.9, (g0 + g1) / 2 - 0.4]) for (const sg of [-1, 1]) bx(m, x, 8.6, sg * gz - 0.5, x + 0.9, gh, sg * gz + 0.5, c);
    bx(m, g0 - 0.5, gh, -(hw - 0.8), g1 + 0.5, gh + 0.9, hw - 0.8, c);
    if (model === 'mpv' || model === 'suv') for (const sg of [-1, 1]) bx(m, g0 + 1.5, gh + 0.9, sg * (hw - 2) - 0.4, g1 - 1.5, gh + 1.6, sg * (hw - 2) + 0.4, C(model === 'suv' ? '#1f2937' : '#cbd5e1'));
    if (model === 'suv') { bx(m, rear - 1.5, 4, -4, rear, 11, 4, C('#1f2937')); bx(m, front - 1, 3, -(hw - 1), front + 1.2, 9.5, hw - 1, C('#111827')); }
    if (model === 'pickup') {                       // bak belakang terbuka
      const bed1 = g0 - 0.6, dk = shade(c, 0.7);
      bx(m, rear + 0.5, 8.6, -(hw - 1.2), bed1, 9, hw - 1.2, C('#27272a'));
      for (const sg of [-1, 1]) bx(m, rear, 8.6, sg * hw - (sg > 0 ? 1.2 : 0), bed1, 13.5, sg * hw + (sg > 0 ? 0 : 1.2), dk);
      bx(m, rear, 8.6, -hw, rear + 1.2, 13, hw, dk);
      bx(m, bed1 - 0.8, 8.6, -hw + 1, bed1 + 0.4, gh + 2, hw - 1, C('#1f2937'));
    }
    bx(m, front - 1.4, 2.4, -(hw - 0.6), front + 0.2, 5.6, hw - 0.6, C('#2a2f36'));
    bx(m, rear - 0.2, 2.4, -(hw - 0.6), rear + 1.4, 5.6, hw - 0.6, C('#2a2f36'));
    for (const sg of [-1, 1]) bx(m, g1 - 1, 9.2, sg * (hw + 0.8) - 0.8, g1 + 1.6, 10.8, sg * (hw + 0.8) + 0.8, c);
    const wheels = [], lamps = [];
    for (const sg of [-1, 1]) {
      wheels.push({ x: 0, y: 3.5, z: sg * (hw - 1.2), r: 3.5, w: 3.6 }, { x: s.wb, y: 3.5, z: sg * (hw - 1.2), r: 3.5, w: 3.6, steer: true });
      lamps.push({ x: front, y: 6.9, z: sg * (hw - 3.2), sx: 0.9, sy: 1.6, sz: 3.4, kind: 'head' }, { x: rear, y: 6.9, z: sg * (hw - 3.2), sx: 0.9, sy: 1.6, sz: 3.4, kind: 'tail' });
    }
    return { body: m.upload(), wheels, lamps, movers: wiperPair(g1 + 0.05, 9.4, gz) };
  }
  function bakeBoxTruck(V) {
    const s = V.spec, hw = s.hw, c = C(V.color), m = new Mesh(), cabX = s.rear + 62;
    bx(m, s.rear, 4, -(hw - 3), s.front, 7, hw - 3, C('#1f2937'));
    bx(m, s.rear, 7, -hw, cabX, 38, hw, c, 0.2);
    bx(m, s.rear - 0.3, 14, -0.5, s.rear + 0.3, 36, 0.5, C('#1f2937'));
    bx(m, s.rear + 1, 20, -hw - 0.3, cabX - 1, 24, hw + 0.3, shade(c, 0.7));
    bx(m, cabX, 7, -(hw - 1), s.front, 27, hw - 1, C('#334155'), 0.2);
    bx(m, s.front - 0.8, 14, -(hw - 4), s.front + 0.2, 25, hw - 4, C('#1e3a5f'));
    bx(m, s.front - 2, 4, -(hw - 1), s.front + 1, 8, hw - 1, C('#4b5563'));
    const wheels = [], lamps = [];
    for (const sg of [-1, 1]) {
      wheels.push({ x: 0, y: 4.5, z: sg * (hw - 1), r: 4.5, w: 5 }, { x: s.wb, y: 4.5, z: sg * (hw - 1), r: 4.5, w: 5, steer: true });
      lamps.push({ x: s.front, y: 10, z: sg * (hw - 3), sx: 1, sy: 2, sz: 3.6, kind: 'head' }, { x: s.rear, y: 9, z: sg * (hw - 3), sx: 1, sy: 2.4, sz: 3.6, kind: 'tail' });
    }
    return { body: m.upload(), wheels, lamps, movers: wiperPair(s.front + 0.25, 15, hw - 4) };
  }
  function bakeManHx8x8(V) {
    const s = V.spec, hw = s.hw, c = C(V.color || '#3f6212'), dark = C('#374151'), glass = C('#1e3a5f'), m = new Mesh();
    bx(m, s.rear, 7, -(hw - 5), s.front, 12, hw - 5, dark);
    bx(m, s.rear + 2, 12, -9, s.fifth + 8, 15, 9, dark);
    bx(m, s.fifth - 7, 15, -12, s.fifth + 7, 18, 12, C('#1f2937'));
    cylY(m, s.fifth, 19, 0, 3.4, 2.2, C('#111827'));
    bx(m, 13, 11, -hw, s.front, 29, hw, c, 0.2);
    bx(m, 22, 29, -hw + 1, 56, 35, hw - 1, shade(c, 1.12));
    bx(m, 58, 22, -hw + 3, 64, 34, hw - 3, glass);
    bx(m, 45, 12, -hw + 1, s.front - 1, 21, hw - 1, c);
    bx(m, s.front - 1, 7, -hw - 2, s.front + 5, 14, hw + 2, dark);
    bx(m, s.front + 1, 14, -10, s.front + 2, 23, 10, dark);
    bx(m, s.front + 2, 16, -8, s.front + 3, 17, 8, C('#9ca3af'));
    const wheels = [], lamps = [];
    for (const [x, steer] of [[s.wb, 1], [16, 0.65], [-12, 0], [s.rear + 18, 0]]) {
      for (const side of [-1, 1]) wheels.push({ x, y: 8, z: side * (hw - 1), r: 8, w: 6, steer });
    }
    for (const side of [-1, 1]) {
      lamps.push({ x: s.front, y: 16, z: side * (hw - 6), sx: 1.2, sy: 2.8, sz: 4.2, kind: 'head' });
      lamps.push({ x: s.rear, y: 13, z: side * (hw - 7), sx: 1, sy: 2.6, sz: 3.8, kind: 'tail' });
    }
    return { body: m.upload(), wheels, lamps, movers: wiperPair(64.25, 23.2, hw - 3) };
  }
  function bakeMiniTruck(V) {
    const s = V.spec, hw = s.hw, c = C(V.color), m = new Mesh(), cab = s.front - 18;
    bx(m, s.rear, 4, -(hw - 3), s.front, 7, hw - 3, C('#1f2937'));                    // sasis
    bx(m, s.rear, 7, -hw, cab - 2, 9, hw, C('#7c4a21'));                                // lantai bak
    const wood = C('#a16207'), wd = C('#8b5a2b');
    for (const sg of [-1, 1]) bx(m, s.rear, 9, sg > 0 ? hw - 1.4 : -hw, cab - 2, 19, sg > 0 ? hw : -hw + 1.4, wood);   // dinding bak
    bx(m, s.rear, 9, -hw, s.rear + 1.4, 19, hw, wd);
    bx(m, cab - 3.4, 9, -hw, cab - 2, 24, hw, wd);
    for (let x = s.rear + 6; x < cab - 4; x += 8) for (const sg of [-1, 1]) bx(m, x, 9, sg * hw - 0.6, x + 1, 19, sg * hw + 0.6, wd);
    bx(m, cab, 6, -(hw - 0.5), s.front, 26, hw - 0.5, c, 0.2);                         // kabin
    bx(m, s.front - 0.6, 15, -(hw - 3), s.front + 0.2, 24, hw - 3, C('#1e3a5f'));       // kaca depan
    for (const sg of [-1, 1]) bx(m, cab + 3, 15, sg > 0 ? hw - 0.8 : -hw + 0.3, s.front - 5, 23, sg > 0 ? hw - 0.3 : -hw + 0.8, C('#1e3a5f'));
    bx(m, s.front - 1.5, 4, -(hw - 1), s.front + 1, 8, hw - 1, C('#4b5563'));
    const wheels = [], lamps = [];
    for (const sg of [-1, 1]) {
      wheels.push({ x: 0, y: 4.5, z: sg * (hw - 1.5), r: 4.5, w: 4.6 }, { x: s.wb, y: 4.5, z: sg * (hw - 1.5), r: 4.5, w: 4.6, steer: true });
      lamps.push({ x: s.front, y: 10, z: sg * (hw - 3), sx: 1, sy: 2, sz: 3.6, kind: 'head' }, { x: s.rear, y: 9, z: sg * (hw - 3), sx: 1, sy: 2.4, sz: 3.6, kind: 'tail' });
    }
    return { body: m.upload(), wheels, lamps, movers: wiperPair(s.front + 0.25, 15.8, hw - 3) };
  }
  function bakeCustom(V) {            // kendaraan rakitan bengkel: dirakit dari blok seperti di layar rakit
    const s = V.spec, G = s.geom, p = s.parts, hw = G.hw, c = C(V.color), m = new Mesh(), r = G.wheelR;
    const deck = r * 2 + 1.5;                                             // tinggi atas rel sasis
    bx(m, G.rear, r * 1.4, -hw * 0.45, G.front - 1, deck, hw * 0.45, C('#374151'));          // sasis
    const c0 = G.rear, c1 = G.cab0 - 2;
    if (p.muatan === 'bak') {
      bx(m, c0, deck, -hw, c1, deck + 1.5, hw, C('#6b4423'));
      const wd = C('#a16207');
      for (const sg of [-1, 1]) bx(m, c0, deck, sg > 0 ? hw - 1.3 : -hw, c1, deck + 9, sg > 0 ? hw : -hw + 1.3, wd);
      bx(m, c0, deck, -hw, c0 + 1.3, deck + 9, hw, wd);
    } else if (p.muatan === 'boks') {
      bx(m, c0, deck, -hw, c1, deck + 27, hw, C('#e5e7eb'), 0.2);
      bx(m, c0 - 0.2, deck + 25, -hw - 0.2, c1 + 0.2, deck + 27.3, hw + 0.2, c);
      bx(m, c0 - 0.5, deck + 3, -0.4, c0 + 0.1, deck + 24, 0.4, C('#6b7280'));
    } else if (p.muatan === 'tangki') {
      m.add(PR.cylX, trs((c0 + c1) / 2, deck + hw * 0.85, 0, 0, 0, c1 - c0, hw * 1.7, hw * 1.7), C('#cbd5e1'));
      bx(m, (c0 + c1) / 2 - 3, deck + hw * 1.7, -3, (c0 + c1) / 2 + 3, deck + hw * 1.7 + 2, 3, C('#64748b'));
    } else if (p.muatan === 'fifth') {
      cylY(m, s.fifth, deck, 0, Math.min(11, hw * 0.7), 2.4, C('#6b7280'));
    }
    const k0 = G.cab0, k1 = G.front, car = p.kabin === 'mobil', ch = G.cabH;
    if (car) {                                                           // kabin mobil: badan bawah + kaca + atap
      bx(m, k0, deck - 1, -hw, k1, deck + 6, hw, c, 0.25);
      bx(m, k0 + G.cabLen * 0.12, deck + 6, -(hw - 1.3), k0 + G.cabLen * 0.78, deck + ch * 0.75, hw - 1.3, C('#1b2a3d'));
      bx(m, k0 + G.cabLen * 0.1, deck + ch * 0.75, -(hw - 0.8), k0 + G.cabLen * 0.8, deck + ch * 0.75 + 1, hw - 0.8, c);
    } else {                                                             // kabin truk: kotak tinggi + kaca depan
      bx(m, k0, deck - 1, -(hw - 0.5), k1, deck + ch, hw - 0.5, c, 0.2);
      bx(m, k1 - 0.6, deck + ch * 0.45, -(hw - 3), k1 + 0.2, deck + ch * 0.9, hw - 3, C('#1e3a5f'));
      for (const sg of [-1, 1]) bx(m, k1 - 12, deck + ch * 0.45, sg > 0 ? hw - 0.8 : -hw + 0.3, k1 - 4, deck + ch * 0.85, sg > 0 ? hw - 0.3 : -hw + 0.8, C('#1e3a5f'));
      if (p.kabin === 'sleeper') bx(m, k0, deck + ch, -(hw - 2.5), k0 + 14, deck + ch + 5, hw - 2.5, shade(c, 1.12));
    }
    bx(m, k1 - 1.5, r, -(hw - 1), k1 + 1, r + 4, hw - 1, C('#4b5563'));           // bumper
    const wheels = [], lamps = [], axles = [0, G.wb]; if (G.tandem != null) axles.push(G.tandem);
    for (const ax of axles) for (const sg of [-1, 1]) wheels.push({ x: ax, y: r, z: sg * (hw - 1.5), r, w: r * 0.9, steer: ax === G.wb });
    for (const sg of [-1, 1]) {
      lamps.push({ x: k1, y: deck + 2.5, z: sg * (hw - 3), sx: 1, sy: 2, sz: 3.6, kind: 'head' }, { x: G.rear, y: deck + 1, z: sg * (hw - 3), sx: 1, sy: 2.4, sz: 3.6, kind: 'tail' });
    }
    return { body: m.upload(), wheels, lamps };
  }
  // bak dump truck: berengsel di belakang, terangkat saat menuang (V.tip 0..1); muatan hotmix hitam
  function drawDumpBed(V, base, tint) {
    const s = V.spec, hw = s.hw, cab = s.model === 'manhx8x8' ? 12 : s.front - 22, len = cab - s.rear, c = C(V.color), tc = tint || WHITE;
    const tip = clamp(V.tip || 0, 0, 1) * 0.75;
    const bb = mul(base, trs(s.rear, 8, 0, 0, tip, 1, 1, 1));                // putar di engsel belakang (x = rear)
    const part = (lx, ly, lz, sx, sy, sz, col) => prim('box', mul(bb, trs(lx, ly, lz, 0, 0, sx, sy, sz)), [col[0] * tc[0], col[1] * tc[1], col[2] * tc[2]], 0, 1);
    part(len / 2, 0, 0, len, 1.6, hw * 2, shade(c, 0.8));
    for (const sg of [-1, 1]) part(len / 2, 1.6, sg * (hw - 0.7), len, 13, 1.4, c);
    part(len - 0.7, 1.6, 0, 1.4, 15, hw * 2, c);
    part(0.7, 1.6, 0, 1.4, 12, hw * 2, shade(c, 0.85));
    const ld = clamp(V.load || 0, 0, 1);
    if (ld > 0.02) prim('sphLo', mul(bb, trs(len / 2, 4 + ld * 4, 0, 0, 0, len * 0.92, 6 + ld * 14, hw * 1.7)), C('#18181b'), 0, 1);
  }
  function drawTowLink(V) {
    if (!V || !V.towing) return;
    const s = V.spec || {}, target = V.towing, ts = target.spec || {};
    const pivot = s.towPivot, hitchX = s.fifth ?? (s.canTowVehicle ? (s.rear || -15) - 8 : 0);
    const hx = V.x + Math.cos(V.ang) * (pivot ? pivot[0] : hitchX) - Math.sin(V.ang) * (pivot ? pivot[1] : 0);
    const hz = V.y + Math.sin(V.ang) * (pivot ? pivot[0] : hitchX) + Math.cos(V.ang) * (pivot ? pivot[1] : 0);
    const tFront = ts.front || 15;
    const co = Math.cos(target.ang), si = Math.sin(target.ang);
    const tx = target.x + co * tFront, tz = target.y + si * tFront;
    const hy = bridgeGroundHeight(hx, hz, V.ang) + 10, ty = bridgeGroundHeight(tx, tz, target.ang) + 10;
    const dx = hx - tx, dy = hy - ty, dz = hz - tz, horizontal = Math.hypot(dx, dz), length = Math.hypot(horizontal, dy);
    prim('boxC', trs((hx + tx) / 2, (hy + ty) / 2, (hz + tz) / 2, Math.atan2(dz, dx), Math.atan2(dy, horizontal), length, 2.4, 2.4), C('#374151'), 0, 1);
    prim('sph', trs(hx, hy, hz, 0, 0, 3, 3, 3), C('#111827'), 0, 1);
  }
  // selang BBM: dari gulungan di sisi kiri truk tangki ke lubang tangki kendaraan (melengkung ke tanah)
  function drawHose(T, D) {
    const co = Math.cos(T.ang), si = Math.sin(T.ang), lx = T.spec.rear + 9, lz = -(T.spec.hw + 1);
    const ax = T.x + co * lx - si * lz, az = T.y + si * lx + co * lz, ay = bridgeGroundHeight(T.x, T.y, T.ang) + 9;
    const dm = (D.spec.front + D.spec.rear) / 2 - 6, dco = Math.cos(D.ang), dsi = Math.sin(D.ang);
    const sideSign = ((ax - D.x) * -dsi + (az - D.y) * dco) >= 0 ? 1 : -1;
    const bx2 = D.x + dco * dm - dsi * sideSign * D.spec.hw, bz = D.y + dsi * dm + dco * sideSign * D.spec.hw, by = bridgeGroundHeight(D.x, D.y, D.ang) + (D.type === 'motor' ? 8 : 10);
    let px = ax, py = ay, pz = az;
    const N = 10, sag = Math.min(8, Math.hypot(bx2 - ax, bz - az) * 0.15);
    for (let i = 1; i <= N; i++) {
      const t = i / N, x = ax + (bx2 - ax) * t, z = az + (bz - az) * t, y = ay + (by - ay) * t - Math.sin(t * Math.PI) * sag;
      const dx = x - px, dy = y - py, dz = z - pz, len = Math.hypot(dx, dy, dz);
      prim('boxC', trs((x + px) / 2, (y + py) / 2, (z + pz) / 2, Math.atan2(dz, dx), Math.atan2(dy, Math.hypot(dx, dz)), len + 0.3, 1.1, 1.1), C('#111827'), 0, 1);
      px = x; py = y; pz = z;
    }
    prim('boxC', trs(bx2, by, bz, 0, 0, 2.2, 2.2, 2.2), C('#facc15'), 0, 1);                  // nozzle
  }
  // paver: isi hopper (hotmix) & screed yang melebar saat menggelar aspal
  function drawPaverExtra(V, base, main) {
    const s = V.spec, hw = s.hw, a = clamp(V.asphalt || 0, 0, 1);
    if (a > 0.02) prim('sphLo', mul(base, trs(s.front - 7, 7 + a * 3, 0, 0, 0, 13, 4 + a * 9, hw * 1.7)), C('#18181b'), 0, 1);
    const ext = V.paving ? ((L.amp && L.amp.paveW) || 70) / 2 : hw + 2;
    for (const sg of [-1, 1]) prim('box', mul(base, trs(s.rear + 4, 3, sg * (ext - (ext - hw) / 2), 0, 0, 8, 7, Math.max(0.1, ext - hw + 2))), C('#6b7280'), 0, 1);
    if (main && V.paving) prim('box', mul(base, trs(s.rear + 2, 0.9, 0, 0, 0, 3, 0.4, ext * 2)), C('#fb923c'), 1, 1);   // pemanas screed
  }
  function bakeMilling(V) {          // road milling Sakai ER 550F: crawler, kabin operator, drum kupas di bawah badan, conveyor depan
    const s = V.spec, hw = s.hw, c = C(V.color || '#f59e0b'), m = new Mesh(), dk = C('#1f2937'), dx = s.drum != null ? s.drum : -6;
    for (const sg of [-1, 1]) {
      bx(m, -26, 0, sg * (hw - 4) - 3.5, 34, 7, sg * (hw - 4) + 3.5, C('#111827'));                    // crawler
      for (let x = -24; x < 32; x += 5) bx(m, x, 6.6, sg * (hw - 4) - 3.7, x + 2, 7.4, sg * (hw - 4) + 3.7, C('#374151'));
    }
    bx(m, -24, 7, -(hw - 2), 30, 20, hw - 2, c, 0.2);                                                   // badan
    bx(m, -30, 9, -(hw - 4), -24, 18, hw - 4, shade(c, 0.85));                                          // kap mesin belakang
    bx(m, -4, 20, -9, 14, 32, 9, c, 0.15);                                                              // kabin operator
    bx(m, 12, 22, -8.5, 14.4, 31, 8.5, C('#38bdf8'));                                                   // kaca depan
    bx(m, -6, 32, -11, 16, 33.6, 11, shade(c, 0.9));                                                    // atap
    cylY(m, -20, 20, hw - 6, 1.2, 14, C('#6b7280'));                                                    // knalpot
    bx(m, dx - 7, 3, -(hw - 1), dx + 7, 13, hw - 1, C('#6b7280'));                                      // rumah drum
    bx(m, dx - 4.5, 0.4, -(hw - 2), dx + 4.5, 8, hw - 2, C('#374151'));                                 // drum kupas
    for (let z = -(hw - 3); z < hw - 3; z += 3) bx(m, dx - 5, 0.2, z, dx + 5, 1.4, z + 1, C('#d1d5db')); // gigi pisau
    for (let i = 0; i < 5; i++) bx(m, 30 + i * 3, 10 + i * 1.3, -4, 33 + i * 3, 12 + i * 1.3, 4, C('#4b5563'));   // conveyor depan
    bx(m, 44, 16, -5, 47, 19, 5, C('#374151'));
    const lamps = [];
    for (const sg of [-1, 1]) lamps.push({ x: 29, y: 18, z: sg * (hw - 3), sx: 1.4, sy: 2, sz: 3, kind: 'head' }, { x: s.rear, y: 12, z: sg * (hw - 5), sx: 1, sy: 2, sz: 3, kind: 'tail' });
    return { body: m.upload(), wheels: [], lamps };
  }
  function drawMillingExtra(V, base, main) {                // drum menyala & alur kupasan saat mengupas
    if (!main || !V.milling) return;
    const s = V.spec, hw = s.hw, dx = s.drum != null ? s.drum : -6, flick = 0.5 + 0.5 * Math.sin(performance.now() * 0.03);
    prim('box', mul(base, trs(dx, 0.6, 0, 0, 0, 9.4, 1.2 + flick * 0.6, (hw - 2) * 2)), C('#fb923c'), 1, 1);
  }
  function bakeMotor(V) {             // sepeda motor bebek / matic
    const s = V.spec, c = C(V.color), m = new Mesh(), dark = C('#1f2937'), blk = C('#111827'), chrome = C('#9ca3af'), matic = s.model === 'matic';
    bx(m, 1, 3, -0.8, 13, 5, 0.8, dark);                                   // rangka
    bx(m, 3.5, 1.8, -1.7, 9, 5.6, 1.7, C('#6b7280'));                      // mesin
    if (matic) {
      bx(m, 4.5, 3.4, -2.5, 11, 4.4, 2.5, c);                              // dek kaki
      bx(m, -3, 4.4, -2.3, 6, 9.2, 2.3, c, 0.3);                           // bodi belakang
      bx(m, 10.6, 3.4, -2.6, 13.4, 11.8, 2.6, c, 0.2);                     // tameng depan
    } else {
      bx(m, 1.5, 5, -1.9, 9.5, 8.2, 1.9, c, 0.3);                          // bodi / tangki
      bx(m, 10.8, 4, -2.2, 13.4, 10.6, 2.2, c, 0.2);
      bx(m, -3.5, 6.2, -1.6, 1.5, 8.6, 1.6, c);
    }
    bx(m, -2.5, matic ? 9.2 : 8.2, -2, 7, (matic ? 9.2 : 8.2) + 1.6, 2, blk);  // jok
    bx(m, -5, 6.6, -1.4, -2, 8.2, 1.4, shade(c, 0.85));                    // spakbor belakang
    bx(m, 10.5, 6.8, -1.2, 16.5, 7.6, 1.2, c);                             // spakbor depan
    bx(m, 12.6, 3.2, -0.5, 13.4, 11.5, 0.5, chrome);                       // garpu depan
    bx(m, 12.2, 11.4, -3.8, 13.2, 12.2, 3.8, blk);                         // stang
    for (const sg of [-1, 1]) bx(m, 12.4, 12.2, sg * 3.2 - 0.3, 12.8, 14, sg * 3.2 + 0.3, blk);   // spion
    bx(m, 13.4, 9.6, -1.3, 15, 11.8, 1.3, c);                              // rumah lampu
    m.add(PR.cylX, trs(0, 3, 2.2, 0, 0, 9, 1.5, 1.5), chrome);             // knalpot
    const wheels = [{ x: 0, y: 3.2, z: 0, r: 3.2, w: 1.7 }, { x: s.wb, y: 3.2, z: 0, r: 3.2, w: 1.7, steer: true }];
    const lamps = [{ x: 15.1, y: 10.7, z: 0, sx: 0.6, sy: 1.5, sz: 1.8, kind: 'head' }, { x: -5.1, y: 7.6, z: 0, sx: 0.6, sy: 1, sz: 2, kind: 'tail' }];
    return { body: m.upload(), wheels, lamps };
  }
  // pengendara motor (duduk, tangan di stang, pakai helm)
  function drawRider3(V, main, base0) {
    const r = S0.riderOf(V), seat = V.spec.model === 'matic' ? 10.8 : 9.8;
    const base = base0 || trs(V.x, 0, V.y, V.ang, 0, 1, 1, 1);
    const jeans = C('#1e293b'), jk = C(r.jacket), skin = C('#d6a77a');
    const part = (name, px, py, pz, sx, sy, sz, col, roll = 0) => prim(name, mul(base, trs(px, py, pz, 0, roll, sx, sy, sz)), col, 0, 1);
    const sh = seat + 7, armA = Math.atan2(12.6 - sh, 11);              // lengan miring dari bahu ke stang
    for (const sg of [-1, 1]) {
      part('box', 2.4, seat, sg * 1.7, 6.6, 2.2, 2.4, jeans);                          // paha
      part('box', 6.4, seat - 6.2, sg * 2.5, 2.2, 6.6, 2.2, jeans);                    // betis
      part('box', 7, seat - 6.6, sg * 2.5, 3.8, 1.2, 2.6, C('#111827'));               // sepatu
      part('boxC', 6.6, (sh + 12.6) / 2, sg * 3.3, 11.4, 1.8, 1.8, jk, armA);           // lengan
      part('boxC', 12.4, 12.6, sg * 3.4, 1.8, 1.8, 1.8, skin);                          // tangan
    }
    part('box', 0.6, seat + 1, 0, 4.2, 7.6, 6.6, jk);                                   // badan
    if (V.foodDelivery) {
      part('box', -2.8, seat + 1.2, 0, 5.0, 6.2, 5.2, C('#059669'));                   // boks makanan hijau kurir
      part('box', -2.8, seat + 5.6, 0, 5.2, 1.2, 5.4, C('#10b981'));                   // tutup boks
      part('box', -0.3, seat + 3.2, 0, 0.4, 2.6, 3.4, C('#facc15'));                   // strip aksen kuning
    }
    prim('sph', mul(base, trs(1.4, seat + 11.2, 0, 0, 0, 5.6, 5.8, 5.6)), C(r.helmet), 0, 1);   // helm
    if (main) part('boxC', 4.1, seat + 11.4, 0, 0.6, 2.4, 4, C('#0f172a'));            // kaca helm
  }
  function bakeDump(V) {             // dump truck: kabin + sasis; bak jungkit digambar dinamis (bisa naik)
    const s = V.spec, hw = s.hw, c = C(V.color), m = new Mesh(), cab = s.front - 20;
    bx(m, s.rear, 4, -(hw - 3), s.front, 8, hw - 3, C('#1f2937'));
    bx(m, cab, 7, -(hw - 0.5), s.front, 28, hw - 0.5, c, 0.2);
    bx(m, s.front - 0.6, 16, -(hw - 3), s.front + 0.2, 26, hw - 3, C('#1e3a5f'));
    for (const sg of [-1, 1]) bx(m, cab + 3, 16, sg > 0 ? hw - 0.8 : -hw + 0.3, s.front - 5, 25, sg > 0 ? hw - 0.3 : -hw + 0.8, C('#1e3a5f'));
    bx(m, s.front - 1.5, 4, -(hw - 1), s.front + 1, 9, hw - 1, C('#4b5563'));
    bx(m, cab - 4, 8, -3, cab - 1, 24, 3, C('#374151'));                  // pelindung kabin
    const wheels = [], lamps = [];
    for (const sg of [-1, 1]) {
      wheels.push({ x: 0, y: 5, z: sg * (hw - 2), r: 5, w: 5 }, { x: -12, y: 5, z: sg * (hw - 2), r: 5, w: 5 }, { x: s.wb, y: 5, z: sg * (hw - 2), r: 5, w: 5, steer: true });
      lamps.push({ x: s.front, y: 12, z: sg * (hw - 3), sx: 1, sy: 2, sz: 3.6, kind: 'head' }, { x: s.rear, y: 8, z: sg * (hw - 3), sx: 1, sy: 2.4, sz: 3.6, kind: 'tail' });
    }
    return { body: m.upload(), wheels, lamps };
  }
  function bakeTanker(V) {           // truk tangki BBM: kabin + tangki silinder putih bergaris merah-biru, gulungan selang
    const s = V.spec, hw = s.hw, c = C(V.color), m = new Mesh(), cab = s.front - 20, t0 = s.rear + 1, t1 = cab - 3, tl = t1 - t0;
    bx(m, s.rear, 4, -(hw - 3), s.front, 8, hw - 3, C('#1f2937'));
    bx(m, cab, 7, -(hw - 0.5), s.front, 28, hw - 0.5, C('#dc2626'), 0.2);
    bx(m, s.front - 0.6, 16, -(hw - 3), s.front + 0.2, 26, hw - 3, C('#1e3a5f'));
    for (const sg of [-1, 1]) bx(m, cab + 3, 16, sg > 0 ? hw - 0.8 : -hw + 0.3, s.front - 5, 25, sg > 0 ? hw - 0.3 : -hw + 0.8, C('#1e3a5f'));
    bx(m, s.front - 1.5, 4, -(hw - 1), s.front + 1, 9, hw - 1, C('#4b5563'));
    m.add(PR.cylX, trs((t0 + t1) / 2, 19, 0, 0, 0, tl, 22, hw * 1.85), c);                     // tangki
    for (const [x, col] of [[0.25, '#dc2626'], [0.5, '#2563eb'], [0.75, '#dc2626']]) m.add(PR.cylX, trs(t0 + tl * x, 19, 0, 0, 0, 2.2, 22.4, hw * 1.87), C(col));
    for (const x of [0.2, 0.5, 0.8]) cylY(m, t0 + tl * x, 29, 0, 3, 2.2, C('#9ca3af'));         // tutup lubang isi
    bx(m, t0 + 4, 28, -2, t1 - 4, 30.5, 2, C('#6b7280'));                                       // pegangan atas
    m.add(PR.cylZ, trs(t0 + 8, 9, -(hw + 0.5), 0, 0, 9, 9, 3), C('#111827'));                   // gulungan selang (kiri)
    bx(m, t0 + 14, 5, -(hw + 1), t0 + 26, 12, -(hw - 1), C('#6b7280'));                          // kotak pompa
    const wheels = [], lamps = [];
    for (const sg of [-1, 1]) {
      wheels.push({ x: 0, y: 5, z: sg * (hw - 2), r: 5, w: 5 }, { x: -12, y: 5, z: sg * (hw - 2), r: 5, w: 5 }, { x: s.wb, y: 5, z: sg * (hw - 2), r: 5, w: 5, steer: true });
      lamps.push({ x: s.front, y: 12, z: sg * (hw - 3), sx: 1, sy: 2, sz: 3.6, kind: 'head' }, { x: s.rear, y: 8, z: sg * (hw - 3), sx: 1, sy: 2.4, sz: 3.6, kind: 'tail' });
    }
    lamps.push({ x: cab + 6, y: 28.5, z: 0, sx: 3, sy: 1.2, sz: 6, kind: 'head' });             // lampu rotari di atap
    return { body: m.upload(), wheels, lamps };
  }
  function bakePaver(V) {            // asphalt paver: rantai (crawler), hopper depan, mesin, kanopi, screed belakang
    const s = V.spec, hw = s.hw, c = C(V.color), m = new Mesh(), dk = C('#1f2937');
    for (const sg of [-1, 1]) {
      bx(m, -14, 0, sg * (hw - 5) - 4, s.front - 6, 8, sg * (hw - 5) + 4, C('#111827'));               // crawler
      for (let x = -12; x < s.front - 8; x += 5) bx(m, x, 7.6, sg * (hw - 5) - 4.2, x + 2, 8.4, sg * (hw - 5) + 4.2, C('#374151'));
    }
    bx(m, -16, 8, -(hw - 2), s.front - 14, 22, hw - 2, c, 0.2);                                         // badan & mesin
    bx(m, s.front - 14, 6, -hw, s.front, 8, hw, dk);                                                    // lantai hopper
    for (const sg of [-1, 1]) m.add(PR.box, trs(s.front - 7, 8, sg * (hw - 0.6), 0, 0, 14, 12, 1.2), c);   // sayap hopper
    bx(m, s.front - 0.6, 8, -hw, s.front + 0.6, 14, hw, c);
    bx(m, -14, 22, -8, 0, 27, 8, C('#374151'));                                                         // kursi & panel operator
    bx(m, -6, 22, -10, -3, 30, 10, C('#4b5563'));
    for (const [px, pz] of [[-16, -hw + 3], [-16, hw - 3], [4, -hw + 3], [4, hw - 3]]) cylY(m, px, 22, pz, 0.8, 22, C('#9ca3af'));
    bx(m, -19, 44, -(hw + 1), 7, 46, hw + 1, c);                                                        // kanopi
    cylY(m, 2, 22, -hw + 6, 1.4, 16, C('#6b7280'));                                                     // knalpot
    bx(m, s.rear, 3, -(hw + 2), s.rear + 10, 10, hw + 2, C('#6b7280'));                                  // screed (dasar)
    bx(m, s.rear + 6, 10, -hw, s.rear + 11, 15, hw, C('#4b5563'));
    const lamps = [];
    for (const sg of [-1, 1]) lamps.push({ x: 7, y: 42, z: sg * (hw - 2), sx: 1.4, sy: 2, sz: 3, kind: 'head' }, { x: s.rear, y: 8, z: sg * (hw - 1), sx: 1, sy: 2, sz: 3, kind: 'tail' });
    return { body: m.upload(), wheels: [], lamps };
  }
  function drawPlanePropeller(V, base, main) {
    if (!main) return;
    const s = V.spec, front = s.front || 42;
    const spin = ((V.v || 0) * 0.4 + (performance.now() * 0.04)) % (Math.PI * 2);
    const hub = mul(base, trs(front + 2, 12.5, 0, 0, 0, 1, 1, 1));
    const bladeM = mul(hub, mul(rotX(spin), trs(0, 0, 0, 0, 0, 1.2, 16, 2.5)));
    prim('boxC', bladeM, C('#111827'), 0, 1);
  }
  function bakePlane(V) {
    const s = V.spec, c = C(V.color || '#f8fafc'), m = new Mesh(), dark = C('#1e293b'), blue = C('#0284c7'), red = C('#dc2626');
    const hw = s.hw || 64, rear = s.rear || -48, front = s.front || 42;
    // Fuselage (badan pesawat)
    bx(m, rear, 8, -6.5, front - 8, 20, 6.5, c, 0.25);
    bx(m, front - 8, 8, -5.5, front, 17, 5.5, shade(c, 0.95), 0.2); // moncong depan
    bx(m, front - 1, 10, -2, front + 2, 15, 2, dark);                 // poros propeller
    // Kokpit kaca
    bx(m, 4, 15, -5.2, 22, 23, 5.2, blue);
    // Sayap utama (sayap atas/tinggi khas Cessna 172)
    bx(m, 2, 20.5, -hw, 20, 23.5, hw, c, 0.15);
    for (const sg of [-1, 1]) {
      // Penopang sayap (strut)
      bx(m, 8, 10, sg * (hw * 0.45) - 0.5, 12, 21, sg * (hw * 0.45) + 0.5, dark);
      // Lampu navigasi ujung sayap (merah di kiri, hijau di kanan)
      bx(m, 10, 21.5, sg * hw - (sg > 0 ? 1.5 : 0), 12, 23, sg * hw + (sg > 0 ? 0 : 1.5), sg > 0 ? C('#22c55e') : C('#ef4444'));
    }
    // Ekor vertikal & horizontal
    bx(m, rear - 2, 18, -1.2, rear + 14, 38, 1.2, red); // fin ekor
    bx(m, rear - 2, 16, -24, rear + 10, 18.5, 24, red); // sayap horizontal ekor
    // Roda pendarat (tricycle gear)
    const wheels = [
      { x: front - 12, y: 3.5, z: 0, r: 3.5, w: 2.2, steer: true },
      { x: -6, y: 3.8, z: -9, r: 3.8, w: 2.5 },
      { x: -6, y: 3.8, z: 9, r: 3.8, w: 2.5 }
    ];
    // Lampu pendarat
    const lamps = [{ x: front + 1, y: 12, z: 0, sx: 1.5, sy: 2, sz: 2.5, kind: 'head' }];
    return { body: m.upload(), wheels, lamps };
  }
  function bakeSu57(V) {
    const s = V.spec, c = C(V.color || '#64748b'), dark = C('#334155'), glass = C('#38bdf8'), m = new Mesh();
    bx(m, -42, 8, -6.5, 37, 17, 6.5, c, 0.15);
    bx(m, 30, 10, -5, 48, 14, 5, c);
    bx(m, 18, 15, -3.8, 33, 18, 3.8, glass, 0.1);
    for (const side of [-1, 1]) {
      const z0 = side * 6, z1 = side * 47;
      m.quad([-5, 12, z0], [10, 12, z0], [-27, 12, z1], [-36, 12, z1], [0, 1, 0], c);
      m.quad([-5, 9.5, z0], [-36, 9.5, z1], [-27, 9.5, z1], [10, 9.5, z0], [0, -1, 0], shade(c, 0.72));
      bx(m, -42, 7, side * 8, -21, 12, side * 12, dark);
      bx(m, -37, 7, side * 6, -23, 12, side * 10, C('#f97316'));
      const canardRoot = side * 5.5, canardTip = side * 29;
      m.quad([8, 12, canardRoot], [21, 12, canardRoot], [17, 12, canardTip], [12, 12, canardTip], [0, 1, 0], c);
      m.quad([8, 10.5, canardRoot], [12, 10.5, canardTip], [17, 10.5, canardTip], [21, 10.5, canardRoot], [0, -1, 0], shade(c, 0.72));
      const finInner = side * 6.5, finOuter = side * 7.7;
      const finRoot = [[-39, 16, finInner], [-19, 16, finInner], [-25, 38, finOuter], [-36, 38, finOuter]];
      const finOuterSide = finRoot.map(([x, y, z]) => [x, y, z + side * 0.8]);
      m.quad(...finRoot, [0, 0, side], dark);
      m.quad(...finOuterSide, [0, 0, -side], dark);
      m.quad(finRoot[0], finOuterSide[0], finOuterSide[1], finRoot[1], [0, -1, 0], dark);
      m.quad(finRoot[2], finRoot[3], finOuterSide[3], finOuterSide[2], [0, 1, 0], dark);
      bx(m, 44, 8, side * 4, 50, 11, side * 9, C('#b91c1c'));
    }
    bx(m, -41, 5, -4, -31, 7, 4, dark);
    bx(m, 29, 5, -3, 37, 7, 3, dark);
    const wheels = [
      { x: 34, y: 3.5, z: 0, r: 3.2, w: 2.4, steer: true },
      { x: -27, y: 3.5, z: -8, r: 3.2, w: 2.4 },
      { x: -27, y: 3.5, z: 8, r: 3.2, w: 2.4 }
    ];
    const lamps = [{ x: s.front, y: 10, z: 0, sx: 1.2, sy: 1.6, sz: 2.4, kind: 'head' }];
    return { body: m.upload(), wheels, lamps };
  }
  function bakeHelicopter(V) {
    const s = V.spec, c = C(V.color || '#facc15'), dark = C('#334155'), glass = C('#0284c7'), m = new Mesh();
    const hw = s.hw || 17, rear = s.rear || -38, front = s.front || 30;
    bx(m, -28, 9, -12, 15, 24, 12, c, 0.2);
    bx(m, 10, 13, -10, front, 22, 10, glass, 0.1);
    bx(m, rear - 20, 15, -2.5, -18, 19, 2.5, c);
    bx(m, rear - 22, 18, -1.2, rear - 19, 34, 1.2, C('#dc2626'));
    for (const sg of [-1, 1]) {
      bx(m, -17, 13, sg * 12.1, -3, 22, sg * 12.8, glass);
      bx(m, -23, 3, sg * (hw - 1), 18, 5, sg * (hw + 1), dark);
      bx(m, -18, 5, sg * (hw - 1), -16, 11, sg * (hw + 1), dark);
      bx(m, 12, 5, sg * (hw - 1), 14, 11, sg * (hw + 1), dark);
    }
    cylY(m, -4, 23, 0, 1.5, 9, dark);
    const lamps = [{ x: front, y: 15, z: 0, sx: 1.5, sy: 2, sz: 3, kind: 'head' }];
    return { body: m.upload(), wheels: [], lamps };
  }
  function drawHelicopterRotors(V, base, main) {
    if (!main) return;
    const spin = performance.now() * 0.006;
    prim('boxC', mul(base, trs(-4, 34, 0, spin, 0, 64, 1.4, 2.4)), C('#1f2937'), 0, 1);
    prim('boxC', mul(base, trs(-60, 23, 0, 0, spin, 1.4, 10, 2)), C('#1f2937'), 0, 1);
  }
  function drawFalconExhaust(V, base, main) {
    if (!main || !V.thrusting || V.wreck) return;
    const pulse = 0.88 + Math.sin(performance.now() / 28) * 0.12;
    const plume = (length, width, color, alpha) => {
      const model = mul(base, mul(trs(0, -length / 2, 0, 0, 0, width, length, width), rotX(Math.PI)));
      prim('cone', model, color, 1, alpha);
    };
    plume(27 * pulse, 6, C('#f97316'), 0.9);
    plume(17 * pulse, 3.2, C('#fde68a'), 0.95);
  }

  function bakeFalconRocket(V) {
    const c = C(V.color || '#f1f5f9'), dark = C('#1e293b'), accent = C('#0284c7'), m = new Mesh();

    cylY(m, 0, 15, 0, 8.5, 78, c);                                  // tangki tahap pertama
    cylY(m, 0, 8, 0, 9, 14, dark);                                  // interstage
    cylY(m, 0, 19, 0, 8.8, 3, accent);                               // marking biru
    cylY(m, 0, 91, 0, 8.5, 12, dark);                               // tahap kedua
    cylY(m, 0, 101, 0, 8.5, 14, c);                                 // fairing
    m.add(PR.cone, trs(0, 115, 0, 0, 0, 17, 20, 17), c);            // nosecone
    m.add(PR.cone, trs(0, 3, 0, 0, 0, 8, 6, 8), dark);            // bell nozzle
    cylY(m, 0, 4, 0, 3.2, 8.5, C('#475569'));

    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      bx(m, sx < 0 ? -3 : 1, 3, sz < 0 ? -15 : 9, sx < 0 ? -1 : 3, 18, sz < 0 ? -8 : 15, dark);
      bx(m, sx < 0 ? -3 : 1, 61, sz < 0 ? -15 : 9, sx < 0 ? -1 : 3, 71, sz < 0 ? -8 : 15, dark);
    }

    const lamps = [{ x: 0, y: 137, z: 0, sx: 2, sy: 2, sz: 2, kind: 'head' }];
    return { body: m.upload(), wheels: [], lamps };
  }
  function bakeLpgPlanet() {
    const m = new Mesh(), green = C('#16a34a'), darkGreen = C('#166534'), label = C('#f8fafc');
    cylY(m, 0, 0, 0, 103, 16, darkGreen);
    cylY(m, 0, 12, 0, 100, 145, green);
    m.add(PR.sph, trs(0, 157, 0, 0, 0, 200, 92, 200), green);
    cylY(m, 0, 198, 0, 31, 24, darkGreen);
    cylY(m, 0, 215, 0, 39, 8, green);
    cylY(m, 0, 223, 0, 10, 18, C('#9ca3af'));
    for (const side of [-1, 1]) {
      bx(m, -34, 69, side > 0 ? 98 : -102, 34, 112, side > 0 ? 102 : -98, label);
      bx(m, -17, 74, side > 0 ? 102 : -104, 17, 79, side > 0 ? 105 : -101, C('#dc2626'));
    }
    return m.upload();
  }

  // dua wiper pada kaca depan datar (bidang x = konstan). Posisi parkir: mendatar di tepi bawah kaca, menyapu ke atas (putar mengitari sumbu x).
  function wiperPair(x, yBase, gz) {
    const L = gz * 0.62, out = [], saved = REC; REC = null;           // lengan wiper bukan bagian badan: jangan ikut terekam saat ekspor
    try {
      for (const z0 of [-gz * 0.55, gz * 0.15]) {
        const wm = new Mesh(); bx(wm, x, yBase - 0.25, z0, x + 0.35, yBase + 0.25, z0 + L, C('#0b0f14'));
        out.push({ pivot: [x, yBase, z0], axis: [1, 0, 0], a: -1.25, mesh: wm.upload() });
      }
    } finally { REC = saved; }
    return out;
  }

  /* ---- kendaraan hasil editor CAD (/vehicle-editor): daftar primitif sudah dikompilasi (satuan px, origin = as roda belakang) ---- */
  // kotak dengan sudut dipotong (chamfer) / dibulatkan (fillet) — sama dengan editor; ukuran & radius dalam meter
  function bevelData(w, h, d, r, n, mode) {
    const H = [w / 2, h / 2, d / 2];
    r = Math.min(r, Math.min(w, h, d) / 2 * 0.999); n = mode === 'chamfer' ? 1 : Math.max(1, Math.floor(n));
    const grids = H.map((hh) => { const a = []; for (let i = 0; i <= n; i++) a.push(-hh + r * i / n); for (let i = 0; i <= n; i++) a.push(hh - r + r * i / n); return a; });
    const g = 2 * n + 2, pos = [], nor = [], idx = [], inner = [0, 0, 0], dir = [0, 0, 0]; let base = 0;
    [[0, 1, 2], [1, 2, 0], [2, 0, 1]].forEach(([ui, vi, wi]) => [1, -1].forEach((sign) => {
      for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
        const p = [0, 0, 0]; p[ui] = grids[ui][i]; p[vi] = grids[vi][j]; p[wi] = sign * H[wi];
        let l2 = 0, l1 = 0;
        for (let k = 0; k < 3; k++) { const lim = H[k] - r; inner[k] = Math.max(-lim, Math.min(lim, p[k])); dir[k] = p[k] - inner[k]; l2 += dir[k] * dir[k]; l1 += Math.abs(dir[k]); }
        l2 = Math.sqrt(l2);
        for (let k = 0; k < 3; k++) { pos.push(inner[k] + dir[k] * (mode === 'chamfer' ? r / l1 : r / l2)); nor.push(dir[k] / l2); }
      }
      for (let i = 0; i < g - 1; i++) for (let j = 0; j < g - 1; j++) {
        const a = base + i * g + j, b = base + (i + 1) * g + j, c = base + i * g + j + 1, e = base + (i + 1) * g + j + 1;
        if (sign === 1) idx.push(a, b, c, b, e, c); else idx.push(a, c, b, b, c, e);
      }
      base += g * g;
    }));
    const o = [];
    for (let t = 0; t < idx.length; t += 3) {
      const ia = idx[t] * 3, ib = idx[t + 1] * 3, ic = idx[t + 2] * 3;
      let fn = null;
      if (mode === 'chamfer') {                                   // sisi datar: normal per segitiga
        const ux = pos[ib] - pos[ia], uy = pos[ib + 1] - pos[ia + 1], uz = pos[ib + 2] - pos[ia + 2], wx = pos[ic] - pos[ia], wy = pos[ic + 1] - pos[ia + 1], wz = pos[ic + 2] - pos[ia + 2];
        fn = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx]; const l = Math.hypot(...fn) || 1; fn = fn.map((v) => v / l);
      }
      for (const i of [ia, ib, ic]) o.push(pos[i], pos[i + 1], pos[i + 2], ...(fn || [nor[i], nor[i + 1], nor[i + 2]]));
    }
    return { d: new Float32Array(o) };
  }
  const cadBevel = new Map();
  function cadAdd(m, prims) {
    for (const p of prims) {
      const c = C(p.c);
      if (p.k === 'tris') {
        const v = p.v;
        for (let i = 0; i + 8 < v.length; i += 9) {
          const a = [v[i], v[i + 1], v[i + 2]], b = [v[i + 3], v[i + 4], v[i + 5]], e = [v[i + 6], v[i + 7], v[i + 8]];
          const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = e[0] - a[0], wy = e[1] - a[1], wz = e[2] - a[2];
          let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const l = Math.hypot(nx, ny, nz) || 1;
          m.tri(a, b, e, [nx / l, ny / l, nz / l], c);
        }
      } else if (p.k === 'bevel') {
        const key = p.d.join(',') + '|' + p.r + '|' + p.n + '|' + p.mode;
        let pr = cadBevel.get(key); if (!pr) cadBevel.set(key, pr = bevelData(p.d[0], p.d[1], p.d[2], p.r, p.n, p.mode));
        m.add(pr, p.m, c);
      } else m.add(PR[p.k] || PR.boxC, p.m, c, p.ao || 0);
    }
  }
  function bakeCad(V) {
    const cad = V.spec.cad, m = new Mesh(), movers = [], saved = REC;
    cadAdd(m, cad.prims);
    REC = null;                                           // bagian bergerak tidak ikut direkam sebagai badan
    try { for (const mv of cad.movers || []) { const mm = new Mesh(); cadAdd(mm, mv.prims); movers.push({ pivot: mv.pivot, axis: mv.axis, a: mv.a, mesh: mm.upload() }); } } finally { REC = saved; }
    return { body: m.upload(), wheels: cad.wheels || [], lamps: cad.lamps || [], movers };
  }

  function bakeFor(V) {
    const s = V.spec;
    return s.model === 'cad' && s.cad ? bakeCad(V) : V.type === 'plane' ? (s.model === 'su57' ? bakeSu57(V) : bakePlane(V))
      : V.type === 'helicopter' ? bakeHelicopter(V) 
      : V.type === 'falcon' ? bakeFalconRocket(V) 
      : V.type === 'car' ? (s.model === 'bus' ? bakeBus(V) : bakeCar(V)) 
      : V.type === 'box' ? (s.model === 'manhx8x8' ? bakeManHx8x8(V) : bakeBoxTruck(V))
      : V.type === 'minitruck' ? bakeMiniTruck(V) 
      : V.type === 'custom' ? bakeCustom(V) 
      : V.type === 'motor' ? bakeMotor(V)
      : V.type === 'dump' ? bakeDump(V) 
      : V.type === 'milling' ? bakeMilling(V) : V.type === 'paver' ? bakePaver(V) 
      : V.type === 'tanker' ? bakeTanker(V) 
      : bakeTractor(V);
  }
  function modelFor(V) {
    const s = V.spec, key = [V.type, s.model, V.color, s.hw, s.front, s.rear, s.wb, s.fifth, s.parts ? JSON.stringify(s.parts) : '', s.cad ? s.cad.id + ':' + (s.cad.rev || 0) : ''].join('|');
    return models[key] || (models[key] = bakeFor(V));
  }
  // dipakai editor kendaraan: bake model tanpa WebGL lalu kembalikan semua primitif yang dibuat (satuan px)
  function exportModel(V) {
    if (!PR.box) makePrims();
    const rec = []; REC = rec;
    let g; try { g = bakeFor(V); } finally { REC = null; }
    return { rec, wheels: (g.wheels || []).map((w) => ({ ...w })), lamps: (g.lamps || []).map((l) => ({ ...l })), verts: g.body && g.body.a ? g.body.a.slice() : [] };
  }
  
  function bakeTrailer(color, legs) {
    const T = L.TR, hw = T.hw, c = C(color), m = new Mesh();
    bx(m, T.rear, 11, -hw, T.front, 50, hw, c, 0.15);
    bx(m, T.rear, 8, -(hw - 8), 0, 11, hw - 8, C('#2d3748'));
    const rib = shade(c, 0.78);
    for (let x = T.rear + 15; x < T.front - 4; x += 15) for (const sg of [-1, 1]) {
      const a = sg * (hw - 0.3), b = sg * (hw + 0.6);
      bx(m, x, 12, Math.min(a, b), x + 1.6, 49, Math.max(a, b), rib);
    }
    bx(m, T.rear - 0.4, 12, -hw + 1, T.rear + 0.6, 49, hw - 1, shade(c, 0.6));
    bx(m, T.rear - 1.2, 16, -0.6, T.rear + 0.2, 46, 0.6, C('#111827'));
    bx(m, T.rear - 2, 8, -(hw - 2), T.rear, 12, hw - 2, C('#374151'));
    bx(m, -4, 9.2, -3, 4, 11, 3, C('#111827'));              // kingpin
    if (legs) for (const sg of [-1, 1]) { cylY(m, -30, 0, sg * 12, 1.6, 11, C('#4b5563')); bx(m, -32.5, 0, sg * 12 - 2.5, -27.5, 0.8, sg * 12 + 2.5, C('#4b5563')); }
    const wheels = [];
    for (const x of [-L.TR.l2 + 8, -L.TR.l2 - 8]) for (const sg of [-1, 1]) wheels.push({ x, y: 5.5, z: sg * (hw - 3), r: 5.5, w: 6 });
    const lamps = [];
    for (const sg of [-1, 1]) lamps.push({ x: T.rear, y: 13, z: sg * (hw - 3), sx: 1.2, sy: 2.4, sz: 4, kind: 'tail' });
    return { body: m.upload(), wheels, lamps };
  }
  const trailerModel = (color, legs) => { const k = 'T' + color + legs; return models[k] || (models[k] = bakeTrailer(color, legs)); };

  /* ------------------------------ gambar dasar ----------------------------- */
  let cur = null;                         // program aktif
  const TIRE = [0.025, 0.027, 0.03], HUB = [0.35, 0.37, 0.4], WHITE = [1, 1, 1];
  function setProgram(p) { cur = p; gl.useProgram(p); }
  function draw(mesh, model, tint, emis, alpha) {
    if (!mesh || !mesh.n) return;
    gl.uniformMatrix4fv(cur.u.uModel, false, model);
    if (cur === progMain) {
      gl.uniformMatrix3fv(cur.u.uNorm, false, model === IDENT ? IDENT3 : norm3(model));
      gl.uniform3fv(cur.u.uTint, tint || WHITE); gl.uniform1f(cur.u.uEmis, emis || 0); gl.uniform1f(cur.u.uAlpha, alpha == null ? 1 : alpha);
    }
    gl.bindVertexArray(mesh.vao); gl.drawArrays(gl.TRIANGLES, 0, mesh.n);
  }
  const prim = (name, model, tint, emis, alpha) => draw(PR[name].mesh, model, tint, emis, alpha);

  const ents = new WeakMap();
  const entOf = (o) => { let e = ents.get(o); if (!e) { e = { dist: 0 }; ents.set(o, e); } return e; };
  function drawModel(mod, base, ent, steer, tail, main, tint, dead, groundContact, suspensionTravelPx = 6) {
    draw(mod.body, base, tint || WHITE, 0, 1);
    if (mod.movers && mod.movers.length) {                         // wiper: diam di posisi parkir (u = 0), menyapu saat u naik-turun
      const u = ent.wipU || 0;
      for (const mv of mod.movers) draw(mv.mesh, u ? mul(base, rotAbout(mv.pivot, mv.axis, mv.a * u)) : base, tint || WHITE, 0, 1);
    }
    for (const w of mod.wheels) {
      const yaw = w.steer ? steer * w.steer : 0, roll = -ent.dist / w.r;
      const localWheel = trs(w.x, w.y, w.z, yaw, roll, 2 * w.r, 2 * w.r, w.w);
      const wheel = mul(base, localWheel);
      let wheelCorrection = 0;
      if (groundContact) {
        const surfaceY = groundContact(wheel[12], wheel[14]);
        wheelCorrection = clamp(surfaceY + w.r - wheel[13], -suspensionTravelPx, suspensionTravelPx);
        wheel[13] += wheelCorrection;
      }
      prim('cylZ', wheel, TIRE, 0, 1);
      if (main) {
        const hub = mul(base, trs(w.x, w.y, w.z + Math.sign(w.z) * (w.w / 2 + 0.05), yaw, roll, w.r * 1.3, w.r * 0.28, 0.2));
        hub[13] += wheelCorrection;
        prim('boxC', hub, HUB, 0, 1);
      }
    }
    if (!main || dead) return;
    for (const l of mod.lamps) {
      const col = l.kind === 'head' ? C('#fff2b8') : tail;
      prim('boxC', mul(base, trs(l.x, l.y, l.z, 0, 0, l.sx, l.sy, l.sz)), col, 1, 1);
    }
  }
  const WRECK_TINT = [0.032, 0.028, 0.026];      // hangus (ruang linear: kecil sekali = hitam)
  const TAIL_OFF = C('#7a1010'), TAIL_BRAKE = C('#ff3030'), TAIL_REV = [1, 1, 0.93];
  const tailColor = (V) => (V.gear === 'R' ? TAIL_REV : V.braking ? TAIL_BRAKE : TAIL_OFF);

  function drawWalker3(x, z, ang, walkT, carrying, y0, still, main, style = null) {
    const base = trs(x, y0, z, ang, 0, 1, 1, 1), sw = still ? 0 : Math.sin(walkT / 5) * 2.2;
    const part = (name, px, py, pz, sx, sy, sz, col) => prim(name, mul(base, trs(px, py, pz, 0, 0, sx, sy, sz)), col, 0, 1);
    const jeans = C('#1e293b'), jacket = C(style && style.jacket || '#f97316');
    const skin = C(style && style.skin || '#d6a77a'), hair = C(style && style.hair || '#111827');
    part('box', sw, 0, -1.9, 3, 8.2, 2.8, jeans); part('box', -sw, 0, 1.9, 3, 8.2, 2.8, jeans);
    part('box', 0, 8, 0, 3.8, 6.8, 8.4, jacket);
    part('box', -sw * 0.9, 8.4, -5.3, 2.2, 6, 2.2, jacket); part('box', sw * 0.9, 8.4, 5.3, 2.2, 6, 2.2, jacket);
    part('box', -sw * 0.9, 7.6, -5.3, 2, 1.6, 2, skin); part('box', sw * 0.9, 7.6, 5.3, 2, 1.6, 2, skin);
    prim('sph', mul(base, trs(0.4, 16.6, 0, 0, 0, 5, 5.4, 5)), skin, 0, 1);
    prim('sph', mul(base, trs(-0.4, 17.1, 0, 0, 0, 5.3, 5.2, 5.3)), hair, 0, 1);
    if (carrying) part('box', 1.2, 4.6, 6.2, 3.2, 5, 4, C('#dc2626'));
  }

  function drawTaxiPassenger3(V, actor) {
    const forward = (V.spec.front + V.spec.rear) * 0.15, side = V.spec.hw * 0.45;
    const x = V.x + Math.cos(V.ang) * forward - Math.sin(V.ang) * side;
    const z = V.y + Math.sin(V.ang) * forward + Math.cos(V.ang) * side;
    const ground = TH(V.x, V.y);
    prim('boxC', trs(x, ground + 15, z, V.ang, 0, 5.2, 6.5, 4.4), C(actor.jacket), 0, 1);
    prim('sph', trs(x + Math.cos(V.ang) * 0.5, ground + 23, z + Math.sin(V.ang) * 0.5, 0, 0, 4.4, 4.6, 4.4), C(actor.skin), 0, 1);
    prim('sph', trs(x - Math.cos(V.ang) * 0.5, ground + 25, z - Math.sin(V.ang) * 0.5, 0, 0, 4.5, 2.6, 4.5), C(actor.hair), 0, 1);
  }

  /* ------------------------------ interior rumah --------------------------- */
  const interiors = {};
  function tvScreen(f) {                               // posisi layar TV (koordinat interior), dipakai juga oleh game.js
    const mg = Math.min(6, f.w * 0.14), x0 = f.x + mg + 1.5, x1 = f.x + f.w - mg - 1.5;
    return { x0, x1, y0: 7, y1: 7 + (x1 - x0) * 0.5625, z: f.y + 4.6 };
  }
  function buildInterior(S) {
    const th = S.THEME, IN = S.IN, RW = IN.room.w, RH = IN.room.h;
    const floor = new Mesh(), marks = new Mesh(), solid = new Mesh(), glow = new Mesh();
    const wallC = C(th.wall), trimC = C(th.trim), wood = C(th.wood), acc = C(th.accent);
    const gap0 = IN.room.doorX - IN.room.doorW / 2, gap1 = IN.room.doorX + IN.room.doorW / 2;
    flat(floor, -8, -8, RW + 8, RH + 8, 0, C(th.floor));
    const lc = shade(C(th.floor), 0.72);
    if (th.tile) {
      for (let x = 0; x <= RW; x += 20) flat(marks, x - 0.3, 0, x + 0.3, RH, 0.15, lc);
      for (let z = 0; z <= RH; z += 20) flat(marks, 0, z - 0.3, RW, z + 0.3, 0.15, lc);
    } else for (let z = 0; z <= RH; z += 8) flat(marks, 0, z - 0.2, RW, z + 0.2, 0.15, lc);
    flat(marks, gap0 + 2, RH - 9, gap1 - 2, RH - 2, 0.4, C('#292524'));
    // dinding (selatan dibuat rendah agar kamera dari selatan bisa melihat ke dalam)
    bx(solid, -6, 0, -6, RW + 6, 30, 0, wallC, 0.2); bx(solid, -6, 0, 0, 0, 30, RH + 6, wallC); bx(solid, RW, 0, 0, RW + 6, 30, RH + 6, wallC);
    bx(solid, -6, 0, RH, gap0, 9, RH + 6, wallC); bx(solid, gap1, 0, RH, RW + 6, 9, RH + 6, wallC);
    bx(solid, -6, 30, -6, RW + 6, 31.5, 0, trimC); bx(solid, -6, 30, 0, 0, 31.5, RH + 6, trimC); bx(solid, RW, 30, 0, RW + 6, 31.5, RH + 6, trimC);
    bx(solid, -6, 9, RH, gap0, 10.5, RH + 6, trimC); bx(solid, gap1, 9, RH, RW + 6, 10.5, RH + 6, trimC);
    bx(solid, 0, 0, 0, RW, 2.4, 0.8, trimC); bx(solid, 0, 0, 0, 0.8, 2.4, RH, trimC); bx(solid, RW - 0.8, 0, 0, RW, 2.4, RH, trimC);
    const dc = C('#92400e');
    bx(solid, gap0 - 2, 0, RH, gap0, 12, RH + 6, dc); bx(solid, gap1, 0, RH, gap1 + 2, 12, RH + 6, dc);
    for (const wx of IN.windows) {
      bx(solid, wx - 1.5, 9.5, 0, wx + 23.5, 26, 1.2, trimC);
      glow.quad([wx, 11, 1.4], [wx + 22, 11, 1.4], [wx + 22, 24.5, 1.4], [wx, 24.5, 1.4], [0, 0, 1], C('#cfe8ff'));
      bx(solid, wx + 10.6, 11, 1.3, wx + 11.4, 24.5, 1.8, trimC);
      bx(solid, wx - 4, 8, 1.2, wx, 27, 3.2, acc); bx(solid, wx + 22, 8, 1.2, wx + 26, 27, 3.2, acc);
    }
    for (const f of IN.furn) {
      const x = f.x, z = f.y, w = f.w, d = f.h, x1 = x + w, z1 = z + d, cx = x + w / 2, cz = z + d / 2;
      switch (f.kind) {
        case 'bed': {
          bx(solid, x - 1, 0, z - 1, x1 + 1, 4, z1 + 1, wood);
          bx(solid, x, 4, z, x1, 8, z1, C('#f8fafc'), 0.15);
          bx(solid, x - 0.3, 4, z + 10, x1 + 0.3, 8.9, z1 + 0.3, C(th.bed));
          bx(solid, x + 1.5, 8, z + 2, x + 9.5, 10.2, z + 8, C('#e2e8f0')); bx(solid, x1 - 9.5, 8, z + 2, x1 - 1.5, 10.2, z + 8, C('#e2e8f0'));
          bx(solid, x - 1, 0, z - 2.4, x1 + 1, 17, z, wood);
          break;
        }
        case 'nightstand':
          bx(solid, x, 0, z, x1, 7, z1, wood, 0.2); cylY(solid, cx, 7, cz, 1.3, 2, C('#f8fafc'));
          solid.add(PR.cone, trs(cx, 9, cz, 0, 0, 5, 4, 5), C('#fde68a')); sphere(glow, cx, 10.4, cz, 1.4, C('#fff3b0'));
          break;
        case 'wardrobe':
          bx(solid, x, 0, z, x1, 22, z1, wood, 0.2);
          for (const t of [1, 2]) bx(solid, x + w * t / 3 - 0.3, 1, z1, x + w * t / 3 + 0.3, 21, z1 + 0.5, shade(wood, 0.55));
          for (const t of [0.17, 0.5, 0.83]) bx(solid, x + w * t - 0.4, 9, z1, x + w * t + 0.4, 14, z1 + 0.9, C('#d6c9a8'));
          break;
        case 'tv': {                                        // layar 16:9; video digambar di atasnya oleh game.js saat TV menyala
          const sc = tvScreen(f);
          bx(solid, x, 0, z, x1, 5, z1, wood, 0.2);
          bx(solid, sc.x0 - 1.5, 5, z + 2.4, sc.x1 + 1.5, sc.y1 + 2, z + 4.4, C('#0b1220'));
          glow.quad([sc.x0, sc.y0, sc.z], [sc.x1, sc.y0, sc.z], [sc.x1, sc.y1, sc.z], [sc.x0, sc.y1, sc.z], [0, 0, 1], C('#16233a'));
          break;
        }
        case 'sofa': {
          const sc = C(th.sofa);
          bx(solid, x, 0, z, x1, 4, z1, shade(sc, 0.7));
          for (let i = 0; i < 3; i++) bx(solid, x + 2.5 + i * ((w - 5) / 3), 4, z + 0.6, x + 2.5 + (i + 1) * ((w - 5) / 3) - 0.5, 7.6, z1 - 3.2, shade(sc, 1.12), 0.15);
          bx(solid, x, 4, z1 - 3.4, x1, 13.5, z1, sc, 0.2);
          bx(solid, x, 4, z, x + 2.5, 9.5, z1, shade(sc, 0.85)); bx(solid, x1 - 2.5, 4, z, x1, 9.5, z1, shade(sc, 0.85));
          break;
        }
        case 'coffee':
          bx(solid, x, 4, z, x1, 5.2, z1, wood);
          for (const [px, pz] of [[x + 1, z + 1], [x1 - 1, z + 1], [x + 1, z1 - 1], [x1 - 1, z1 - 1]]) cylY(solid, px, 0, pz, 0.7, 4, shade(wood, 0.7));
          cylY(solid, x + 6, 5.2, z + 4.5, 1.7, 2.4, C('#f8fafc')); break;
        case 'dining':
          bx(solid, x, 7, z, x1, 8.2, z1, wood);
          for (const [px, pz] of [[x + 1.5, z + 1.5], [x1 - 1.5, z + 1.5], [x + 1.5, z1 - 1.5], [x1 - 1.5, z1 - 1.5]]) cylY(solid, px, 0, pz, 0.9, 7, shade(wood, 0.7));
          bx(solid, cx - 5, 8.2, cz - 3, cx + 5, 8.8, cz + 3, C('#fef3c7')); break;
        case 'chair': {
          const cc = C('#a16207');
          bx(solid, x, 4, z, x1, 5, z1, cc);
          if (f.flip) bx(solid, x, 5, z1 - 1.2, x1, 11, z1, cc); else bx(solid, x, 5, z, x1, 11, z + 1.2, cc);
          for (const [px, pz] of [[x + 0.8, z + 0.8], [x1 - 0.8, z + 0.8], [x + 0.8, z1 - 0.8], [x1 - 0.8, z1 - 0.8]]) cylY(solid, px, 0, pz, 0.5, 4, shade(cc, 0.6));
          break;
        }
        case 'fridge':
          bx(solid, x, 0, z, x1, 18, z1, C('#e5e7eb'), 0.2); bx(solid, x + 1.2, 6, z + 1, x + 2, 15, z + 1.8, C('#6b7280'));
          bx(solid, x, 8.6, z, x1, 9.1, z1, C('#9ca3af')); break;
        case 'counter':
          bx(solid, x, 0, z, x1, 9, z1, C('#94a3b8'), 0.25); bx(solid, x - 0.3, 9, z - 0.3, x1 + 0.3, 10.2, z1 + 0.3, C('#e2e8f0'));
          bx(solid, x + 3, 10.2, z + 6, x1 - 3, 10.5, z + 18, C('#64748b'));
          for (const [px, pz] of [[x + 4, z + 32], [x + 10, z + 32], [x + 4, z + 40], [x + 10, z + 40]]) cylY(solid, px, 10.2, pz, 2.2, 0.5, C('#111827'));
          bx(solid, x + 6, 17, z + 4, x1, 27, z1 - 4, C('#cbd5e1'), 0.2);
          break;
        case 'shoes':
          bx(solid, x, 0, z, x1, 4, z1, wood, 0.2);
          bx(solid, x + 3, 4, z + 3, x + 8, 5.5, z + 7, C('#111827')); bx(solid, x + 11, 4, z + 3, x + 16, 5.5, z + 7, C('#dc2626')); bx(solid, x + 18, 4, z + 3, x + 23, 5.5, z + 7, C('#f8fafc'));
          break;
        case 'wall':
          bx(solid, x, 0, z, x1, 30, z1, wallC, 0.2); bx(solid, x, 30, z, x1, 31.5, z1, trimC); break;
        case 'rug':
          flat(marks, x, z, x1, z1, 0.3, C(th[f.col] || f.col));
          if (f.border) { const wc = C('#f8fafc'); flat(marks, x + 2, z + 2, x1 - 2, z + 4, 0.45, wc); flat(marks, x + 2, z1 - 4, x1 - 2, z1 - 2, 0.45, wc); }
          break;
        case 'prayerMat': {
          flat(marks, x, z, x1, z1, 0.55, C('#166534'));
          flat(marks, x + 1, z + 1, x1 - 1, z + 2, 0.7, C('#fde68a'));
          flat(marks, x + 1, z1 - 2, x1 - 1, z1 - 1, 0.7, C('#fde68a'));
          flat(marks, x + 7, cz - 0.8, x1 - 3, cz + 0.8, 0.7, C('#fde68a'));
          marks.tri([x + 3, 0.7, cz], [x + 8, 0.7, cz - 3], [x + 8, 0.7, cz + 3], [0, 1, 0], C('#fde68a'));
          break;
        }
        case 'wudu':
          bx(solid, x, 0, z, x1, 8, z1, C('#94a3b8'), 0.2);
          for (let zz = z + 8; zz < z1 - 8; zz += 24) {
            bx(solid, x + 4, 8, zz, x1 - 4, 9.5, zz + 15, C('#64748b'));
            bx(solid, x + 6, 9.5, zz + 2, x1 - 6, 10.1, zz + 13, C('#bae6fd'));
            bx(solid, cx - 0.6, 10, zz - 3, cx + 0.6, 13, zz + 1, C('#e2e8f0'));
          }
          break;
        case 'etalase': {                                   // etalase kaca berisi makanan
          bx(solid, x, 0, z, x1, 7, z1, wood, 0.2);
          bx(solid, x + 0.5, 7, z + 0.5, x1 - 0.5, 7.4, z1 - 0.5, C('#e2e8f0'));
          const foods = ['#f59e0b', '#16a34a', '#b45309', '#dc2626', '#fde68a', '#78350f'];
          if (w >= d) for (let i = 0, xx = x + 5; xx < x1 - 4; xx += 9, i++) sphere(solid, xx, 8.6, cz, 2.8, C(foods[i % 6]));
          else for (let i = 0, zz = z + 5; zz < z1 - 4; zz += 9, i++) sphere(solid, cx, 8.6, zz, 2.8, C(foods[i % 6]));
          for (const [a0, b0, a1, b1] of [[x, z, x1, z + 0.6], [x, z1 - 0.6, x1, z1], [x, z, x + 0.6, z1], [x1 - 0.6, z, x1, z1]]) bx(glow, a0, 7, b0, a1, f.ht || 13, b1, C('#dbeafe'));
          bx(solid, x, (f.ht || 13), z, x1, (f.ht || 13) + 0.8, z1, C('#94a3b8'));
          break;
        }
        case 'stove':
          bx(solid, x, 0, z, x1, 10, z1, C('#9ca3af'), 0.2);
          for (const t of [0.28, 0.72]) cylY(solid, x + w * t, 10, cz, 3.6, 0.6, C('#1f2937'));
          cylY(solid, x + w * 0.28, 10.6, cz, 3.2, 5, C('#cbd5e1'));
          break;
        case 'table':
          bx(solid, x, 7, z, x1, 8.2, z1, wood);
          for (const [px, pz] of [[x + 1.5, z + 1.5], [x1 - 1.5, z + 1.5], [x + 1.5, z1 - 1.5], [x1 - 1.5, z1 - 1.5]]) cylY(solid, px, 0, pz, 0.9, 7, shade(wood, 0.7));
          for (let xx = x + 8; xx < x1 - 4; xx += 16) cylY(solid, xx, 8.2, cz, 2.4, 0.6, C('#f8fafc'));
          break;
        case 'bench':
          bx(solid, x, 4, z, x1, 5.2, z1, wood);
          for (const px of [x + 2, x1 - 2]) bx(solid, px - 0.8, 0, z + 0.5, px + 0.8, 4, z1 - 0.5, shade(wood, 0.6));
          break;
        case 'shelf': {                                     // rak barang
          bx(solid, x, 0, z, x1, f.ht || 18, z1, C('#e5e7eb'), 0.2);
          const cols = f.col ? [f.col, '#fde68a', f.col, '#f8fafc'] : ['#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#a855f7'];
          for (const yy of [3, 9, 15]) for (let i = 0, xx = x + 1.5; xx < x1 - 3; xx += 5, i++) {
            for (const zf of [z - 0.6, z1 + 0.6 - 3]) bx(solid, xx, yy, zf, xx + 3.6, yy + 4, zf + 3, C(cols[(i + yy) % cols.length]));
          }
          break;
        }
        case 'kasir':
          bx(solid, x, 0, z, x1, 10, z1, C('#334155'), 0.2); bx(solid, x - 0.3, 10, z - 0.3, x1 + 0.3, 11, z1 + 0.3, C('#e2e8f0'));
          bx(solid, x1 - 14, 11, z + 4, x1 - 4, 14, z + 11, C('#111827'));
          bx(glow, x1 - 13, 14, z + 5, x1 - 5, 19, z + 6, C('#38bdf8'));
          break;
        case 'desk':
          bx(solid, x, 0, z, x1, f.ht || 10, z1, wood, 0.2); bx(solid, x - 0.4, f.ht || 10, z - 0.4, x1 + 0.4, (f.ht || 10) + 1, z1 + 0.4, shade(wood, 1.2));
          bx(solid, x + 4, (f.ht || 10) + 1, z + 2, x + 14, (f.ht || 10) + 8, z + 3, C('#111827'));
          bx(glow, x + 4.5, (f.ht || 10) + 1.5, z + 3.05, x + 13.5, (f.ht || 10) + 7.5, z + 3.3, C('#93c5fd'));
          sphere(glow, x1 - 6, (f.ht || 10) + 2, cz, 1.6, C('#fde68a'));
          break;
        case 'sdesk':
          bx(solid, x, 7, z, x1, 8, z1, C('#d6b88a'));
          for (const [px, pz] of [[x + 1, z + 1], [x1 - 1, z + 1], [x + 1, z1 - 1], [x1 - 1, z1 - 1]]) cylY(solid, px, 0, pz, 0.6, 7, C('#6b7280'));
          bx(solid, x + 6, 8, z + 3, x + 16, 8.4, z + 9, C('#f8fafc'));
          break;
        case 'board':
          bx(solid, x - 1, 7, 0.8, x1 + 1, 25, 1.8, C('#475569'));
          bx(glow, x, 8, 1.8, x1, 24, 2.1, C('#f8fafc'));
          for (let i = 0; i < 4; i++) bx(solid, x + 6 + i * 18, 18 - i * 2.5, 2.1, x + 18 + i * 18, 18.6 - i * 2.5, 2.3, C('#2563eb'));
          break;
        case 'stall': {                                     // los pasar
          bx(solid, x, 0, z, x1, 8, z1, C('#92400e'), 0.2);
          for (let xx = x + 5; xx < x1 - 3; xx += 7) for (let zz = z + 5; zz < z1 - 3; zz += 6) sphere(solid, xx, 9.6, zz, 2.6, C(f.col || '#16a34a'));
          for (const px of [x + 1, x1 - 1]) for (const pz of [z + 1, z1 - 1]) cylY(solid, px, 8, pz, 0.6, 18, C('#78350f'));
          bx(solid, x - 2, 26, z - 2, x1 + 2, 27, z1 + 2, C(th.accent));
          break;
        }
        case 'crate':
          bx(solid, x, 0, z, x1, 9, z1, C('#a16207'), 0.2);
          for (let xx = x + 4; xx < x1; xx += 4) bx(solid, xx - 0.3, 0.5, z - 0.3, xx + 0.3, 8.5, z1 + 0.3, C('#78350f'));
          break;
        case 'jerry':
          for (let i = 0; i < 3; i++) { bx(solid, x + 1 + i * 10, 0, z + 2, x + 9 + i * 10, 9, z1 - 2, C('#dc2626'), 0.2); bx(solid, x + 3 + i * 10, 9, z + 3, x + 6 + i * 10, 10.5, z + 6, C('#111827')); }
          break;
        case 'showcar':
          prim0disc(marks, cx, cz, Math.max(w, d) / 2 + 6, 0.5, C('#e5e7eb'));
          prim0disc(marks, cx, cz, Math.max(w, d) / 2 + 3, 0.55, C('#dc2626'));
          break;
        case 'plant':
          cylY(solid, cx, 0, cz, 3.8, 6, C('#92400e'));
          sphere(solid, cx, 11, cz, 5.4, C('#15803d'), 1, true); sphere(solid, cx + 2, 14.5, cz - 1, 3.6, C('#22c55e'), 1, true);
          break;
        default: break;
      }
    }
    const sc = { layers: [floor, marks], solid, glow, env: ENV_IN, center: [RW / 2, 0, RH / 2] };
    sc.layers.forEach((m) => m.upload()); solid.upload(); glow.upload();
    return sc;
  }

  /* ------------------------------ kamera ----------------------------------- */
  const cam = { pos: [0, 100, 100], tgt: [0, 0, 0], yaw: 0, fov: 55, autoTop: false };
  // penghalang pandangan kamera: kotak {x0,z0,x1,z1,y0,y1}; kamera dimajukan bila garis ke targetnya menembus kotak
  let occl = [];
  const OCC_H = { amp: 110, house: 62, factory: 105, dock: 78, building: 44, shop: 36, market: 64, warung: 33, tollbooth: 30, pump: 22,
    store: 50, showroom: 46, hotel: 100, school: 66, mosque: 50, kumon: 50, monument: 40, bengkel: 68, terminal: 36, bus: 25 };
  function buildOccluders() {
    occl = [];
    for (const o of L.obstacles) if (OCC_H[o.kind]) { const h0 = TH(o.x + o.w / 2, o.y + o.h / 2); occl.push({ x0: o.x - 7, z0: o.y - 7, x1: o.x + o.w + 7, z1: o.y + o.h + 7, y0: h0, y1: h0 + OCC_H[o.kind] + 4 }); }   // + juluran atap
  }
  function clearFraction(tg, wp) {
    const N = 40;
    for (let i = 1; i <= N; i++) {
      const t = i / N, x = tg[0] + (wp[0] - tg[0]) * t, y = tg[1] + (wp[1] - tg[1]) * t, z = tg[2] + (wp[2] - tg[2]) * t;
      for (const b of occl) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y > b.y0 && y < b.y1) return Math.max(0.3, (i - 2) / N);
    }
    return 1;
  }
  let world = null, lastNow = 0, lastInside = null, lastMode = '', curVP = IDENT, curCW = 1, curCH = 1, forceSnap = false;
  const T0 = performance.now();

  // posisi kamera dari sudut: yaw (arah pandang di tanah), elevasi, jarak
  const orbitPos = (t, yaw, elev, dist) => [t[0] - Math.cos(yaw) * Math.cos(elev) * dist, t[1] + Math.sin(elev) * dist, t[2] - Math.sin(yaw) * Math.cos(elev) * dist];
  function updateCam(S, dt, snap) {
    const P = S.P, G = S.cam, zi = G.zoom, top = G.view3d === 'top', zf = G.zf || 1, orbit = G.orbit || 0, tilt = G.tilt || 0;
    const userCam = (G.idleT || 0) < 2.5 && (Math.abs(orbit) > 0.05 || Math.abs(tilt) > 0.05);
    let wp, wt, fov = 52, yaw;
    if (S.intro) {                                          // intro sinematik: kamera mengikuti jalur dari game
      wp = S.intro.pos.slice(); wt = S.intro.tgt.slice(); fov = S.intro.fov || 52; yaw = Math.atan2(wt[2] - wp[2], wt[0] - wp[0]);
    } else if (P.mode === 'inside') {
      const RW = S.IN.room.w, RH = S.IN.room.h, big = Math.max(RW / 220, RH / 150);
      wt = [RW / 2 + (P.ix - RW / 2) * 0.12, 0, RH / 2 + 3 + (P.iy - RH / 2) * 0.12];
      yaw = -Math.PI / 2 + orbit;
      wp = orbitPos(wt, yaw, clamp(Math.atan2(192, 122) + tilt * 0.6, 0.5, 1.5), Math.hypot(192, 122) * big * clamp(zf, 0.7, 1.3)); fov = 46;
    } else if (P.mode === 'drive') {
      const V = P.veh, tr = V.hooked;
      let tx = V.x, tz = V.y;
      if (tr) { tx = (V.x + tr.x - Math.cos(tr.ang) * 61) / 2; tz = (V.y + tr.y - Math.sin(tr.ang) * 61) / 2; }
      const isCabin = G.view3d === 'cabin';
      if (isCabin) {
        cam.yaw = snap ? V.ang : cam.yaw + wrapA(V.ang - cam.yaw) * (1 - Math.exp(-dt * 4.5));
        yaw = cam.yaw + orbit;
        const s = V.spec;
        const cabX = s.door || 12, cabH = (V.type === 'plane' ? 17 : V.type === 'tractor' ? 32 : V.type === 'motor' ? 13 : 18);
        const [cx, cz] = [V.x + Math.cos(V.ang) * cabX, V.y + Math.sin(V.ang) * cabX];
        const cy = bridgeGroundHeight(cx, cz, V.ang) + cabH;
        wp = [cx, cy, cz];
        wt = [cx + Math.cos(yaw) * 120, cy + Math.sin(tilt) * 60, cz + Math.sin(yaw) * 120];
        fov = 68;
      } else if (!top) {
        cam.yaw = snap ? V.ang : cam.yaw + wrapA(V.ang - cam.yaw) * (1 - Math.exp(-dt * 2.6));
        yaw = cam.yaw + orbit;
        const k = tr ? 1.25 : 1, back = [120, 175, 270][zi] * k, h = [55, 80, 120][zi] * k;
        const elev = clamp(Math.atan2(h, back) + tilt, 0.06, 1.5), dist = Math.hypot(back, h) * zf;
        // dengan trailer: kamera di belakang ujung trailer supaya trailer tetap terlihat
        const ox = tr && Math.abs(orbit) < 0.4 ? tr.x - Math.cos(tr.ang) * 136 : V.x, oz = tr && Math.abs(orbit) < 0.4 ? tr.y - Math.sin(tr.ang) * 136 : V.y;
        wt = [V.x + Math.cos(cam.yaw) * 38, 8, V.y + Math.sin(cam.yaw) * 38];
        wt[1] += bridgeGroundHeight(wt[0], wt[2], V.ang);
        wp = orbitPos([ox, bridgeGroundHeight(ox, oz, V.ang), oz], yaw, elev, dist);
        fov = 55 + clamp(Math.abs(V.v) * 0.08, 0, 8);
        const f = clearFraction(wt, wp);                       // terhalang gudang/rumah -> pindah ke pandangan atas
        cam.autoTop = userCam ? false : f < 0.75 ? true : (cam.autoTop && f < 1);
        if (cam.autoTop) { const h2 = [480, 660, 930][zi] * zf, g = bridgeGroundHeight(tx, tz, V.ang); wp = [tx, g + h2, tz + h2 * 0.42]; wt = [tx, g, tz]; fov = 50; yaw = -Math.PI / 2; }
      } else {                                          // tampak atas (parkir): hampir tegak lurus, arah hadap kendaraan ke atas layar
        const h = [380, 540, 780][zi] * zf * (tr ? 1.25 : 1);
        cam.yaw = snap ? V.ang : cam.yaw + wrapA(V.ang - cam.yaw) * (1 - Math.exp(-dt * 1.2));
        yaw = cam.yaw + orbit;
        wt = [tx, bridgeGroundHeight(tx, tz, V.ang), tz]; wp = orbitPos(wt, yaw, clamp(1.45 + tilt * 0.3, 0.9, 1.565), h); fov = 50;
      }
    } else {
      cam.autoTop = false;
      const h = [110, 150, 210][zi] * zf;
      wt = [P.x, 6 + TH(P.x, P.y), P.y];
      yaw = -Math.PI / 2 + orbit;
      const base = top ? 1.45 : Math.atan2(1, 0.95);
      wp = orbitPos(wt, yaw, clamp(base + tilt, 0.12, 1.5), top ? Math.hypot(h * 1.6, h * 0.35) : Math.hypot(h, h * 0.95));
    }
    if (P.mode === 'drive' && (P.veh.type === 'plane' || P.veh.type === 'helicopter' || P.veh.type === 'falcon')) {
      wt[1] += P.veh.alt || 0; wp[1] += P.veh.alt || 0;
    }
    R.camYaw = yaw;
    if (P.mode !== 'inside' && !S.intro) {
      const f = clearFraction(wt, wp);
      if (f < 1) wp = [wt[0] + (wp[0] - wt[0]) * f, wt[1] + (wp[1] - wt[1]) * f, wt[2] + (wp[2] - wt[2]) * f];
    }
    const k = snap || S.intro ? 1 : 1 - Math.exp(-dt * (P.mode === 'inside' ? 7 : userCam ? 9 : 5));
    for (let i = 0; i < 3; i++) { cam.pos[i] += (wp[i] - cam.pos[i]) * k; cam.tgt[i] += (wt[i] - cam.tgt[i]) * k; }
    cam.fov += (fov - cam.fov) * k;
    cam.pos[1] = Math.max(cam.pos[1], 10 + (P.mode === 'inside' ? 0 : TH(cam.pos[0], cam.pos[2])));
  }

  function lightVP(center, Rr, env) {
    const D = 4000, d = env.sun, v0 = lookAt([d[0] * D, d[1] * D, d[2] * D], [0, 0, 0]);
    const [x, y, z] = center;
    const lx = v0[0] * x + v0[4] * y + v0[8] * z + v0[12], ly = v0[1] * x + v0[5] * y + v0[9] * z + v0[13], lz = v0[2] * x + v0[6] * y + v0[10] * z + v0[14];
    const texel = 2 * Rr / SH.size, sx = Math.round(lx / texel) * texel, sy = Math.round(ly / texel) * texel, margin = Rr * 2 + 400;
    const near = Math.max(1, -lz - margin), far = -lz + margin;
    return { m: mul(ortho(sx - Rr, sx + Rr, sy - Rr, sy + Rr, near, far), v0), worldTexel: texel, range: far - near };
  }

  /* ------------------------------ gambar entitas --------------------------- */
  function drawEntities(S, pass, inside, lim) {
    const main = pass === 'main', P = S.P, cp = cam.tgt;
    const planetEnv = S.clock != null ? envAt(S.clock, S.night || 0) : ENV_OUT;
    const close = (x, z) => Math.hypot(x - cp[0], z - cp[2]) < lim;
    if (inside) {
      const bed = S.IN.furn.find((f) => f.kind === 'bed');
      if (P.resting === 'bed' && bed) {
        const cx = bed.x + bed.w / 2, len = bed.h - 13;
        prim('box', trs(cx, 8.8, bed.y + 10 + len / 2, 0, 0, 10, 2.4, len), shade(C(S.THEME.bed), 0.8), 0, 1);
        prim('sph', trs(cx, 10.6, bed.y + 6, 0, 0, 5.4, 5.4, 5.4), C('#d6a77a'), 0, 1);
        prim('sph', trs(cx, 11.1, bed.y + 5.3, 0, 0, 5.6, 5.2, 5.6), C('#111827'), 0, 1);
      } else if (P.resting && P.sit) drawWalker3(P.sit.x, P.sit.y, P.sit.ang, 0, 0, 2.2, true, main);
      else drawWalker3(P.ix, P.iy, P.ang, P.walkT, P.carrying, 0, false, main);
      const kz = P.cooking && S.IN.zones.find((z) => z.kind === 'masak');
      if (kz) {                                          // wajan di kompor + api + uap naik
        const t = performance.now() / 1000, cx0 = kz.rect.x + kz.rect.w / 2, cz0 = kz.rect.y + kz.rect.h / 2;
        prim('box', trs(cx0, 10.6, cz0, 0, 0, 9, 1.6, 9), C('#111827'), 0, 1);
        prim('sph', trs(cx0, 10.4, cz0, 0, 0, 5 + Math.sin(t * 18) * 0.8, 2.2, 5 + Math.cos(t * 15) * 0.8), C('#f97316'), 1, 0.85);
        for (let k = 0; k < 4; k++) { const ph = (t * 0.7 + k / 4) % 1, sz = 2.6 + ph * 4.5; prim('sph', trs(cx0 + Math.sin(t * 3 + k * 1.7) * 1.8, 13 + ph * 17, cz0 + Math.cos(t * 2.4 + k) * 1.8, 0, 0, sz, sz, sz), C('#f8fafc'), 0, 0.55 * (1 - ph)); }
      }
      for (const v of S.IN_DISPLAY || []) drawModel(modelFor(v), trs(v.x, 0, v.y, v.ang, 0, 1, 1, 1), entOf(v), 0, tailColor(v), main);
      return;
    }
    for (const t of S.trailers) {
      if (!t.owner && !close(t.x, t.y)) continue;      // trailer yang tersambung selalu digambar
      const e = entOf(t); if (t.owner) e.dist = entOf(t.owner).dist;
      const isT = S.mission && t === S.mission.trailer;
      const color = t.state === 'delivered' ? '#5f8f6e' : isT ? '#f59e0b' : '#9aa3ad';
      drawModel(trailerModel(color, t.state !== 'hooked'), trs(t.x, bridgeGroundHeight(t.x, t.y, t.ang), t.y, t.ang, pitchOf(t.x, t.y, t.ang, 0, -L.TR.l2), 1, 1, 1), e, 0, TAIL_OFF, main);
    }
    for (const list of [S.npcs, S.vehicles, S.display || []]) for (const v of list) {
      if (!close(v.x, v.y)) continue;
      const hp = v.hp ?? 100, k = v.wreck ? 0 : 1 - (1 - hp / 100) * 0.7;
      const tint = v.wreck ? WRECK_TINT : hp < 100 ? [k, k * 0.96, k * 0.92] : null;
      // kendaraan hancur: sedikit amblas & miring; di tanjakan ikut menunduk / mendongak
      const terrain = roadAttitude(v), gy = terrain.height + (v.alt || 0);
      const grounded = !v.airborne;
      const hasSuspension = grounded && v.type !== 'paver' && v.type !== 'milling';
      const pt = grounded ? terrain.pitch + (hasSuspension ? v.suspensionPitch || 0 : 0) : 0;
      const aircraft = v.type === 'helicopter' || v.type === 'plane';
      const roll = aircraft && !grounded ? v.bank || 0
        : grounded ? terrain.roll + (hasSuspension ? v.suspensionRoll || 0 : 0) : 0;
      const groundBase = v.wreck ? trs(v.x, gy - 0.8, v.y, v.ang, pt + 0.05, 1, 1, 1) : trs(v.x, gy, v.y, v.ang, pt, 1, 1, 1);
      const base = roll ? mul(groundBase, rotX(roll)) : groundBase;
      const wheelGround = grounded && v.type !== 'paver' && v.type !== 'milling'
        ? (x, z) => bridgeGroundHeight(x, z, v.ang) + roadSurfaceHeight(x, z) : null;
      const vent = entOf(v); vent.wipU = v.wipU || 0;
      drawModel(modelFor(v), base, vent, v.wreck ? 0.3 : v.steer || 0, tailColor(v), main, tint, v.wreck, wheelGround,
        S.suspensionTravelPx == null ? 6 : S.suspensionTravelPx);
      if (main && S.taxiJob && S.taxiJob.phase === 'onboard' && S.taxiJob.vehicle === v)
        drawTaxiPassenger3(v, S.taxiJob.passengerActor);
      if (v.type === 'motor' && S.hasRider && S.hasRider(v)) drawRider3(v, main, base);
      if (v.type === 'dump' || v.spec.model === 'manhx8x8') drawDumpBed(v, base, tint);
      if (v.towing) drawTowLink(v);
      if (v.type === 'paver') drawPaverExtra(v, base, main);
      if (v.type === 'milling') drawMillingExtra(v, base, main);
      if (v.type === 'plane' && v.spec.model !== 'su57') drawPlanePropeller(v, base, main);
      if (v.type === 'helicopter') drawHelicopterRotors(v, base, main);
      if (v.type === 'falcon') drawFalconExhaust(v, base, main);
      if (v.hoseTo && main) drawHose(v, v.hoseTo);
    }
    for (const actor of S.actors || []) {
      if (!close(actor.x, actor.y) || actor.state === 'onboard') continue;
      drawWalker3(actor.x, actor.y, actor.ang, actor.walkT, 0, TH(actor.x, actor.y),
        actor.state === 'waiting' || actor.wait > 0, main, actor);
    }
    if (main && close(LPG_PLANET.x, LPG_PLANET.z)) {
      gl.uniform2f(progMain.u.uFog, 0, 100000);
      gl.uniform1f(progMain.u.uShadowOn, 0);
      draw(lpgPlanet, trs(LPG_PLANET.x, LPG_PLANET.altitude, LPG_PLANET.z, 0, 0, 0.625, 0.52, 0.625), WHITE, 0, 1);
      gl.uniform2f(progMain.u.uFog, planetEnv.fogNear, planetEnv.fogFar);
      gl.uniform1f(progMain.u.uShadowOn, 1);
    }
    if (P.mode === 'walk') drawWalker3(P.x, P.y, P.ang, P.walkT, P.carrying, TH(P.x, P.y), false, main);
    if (main) for (const f0 of S.fx || []) {          // efek tabrakan: percikan, serpihan, asap
      if (!close(f0.x, f0.y)) continue;
      const f = TER ? { ...f0, z: f0.z + TH(f0.x, f0.y) } : f0;
      const a = 1 - f.t / f.life;
      if (f.k === 'spark') prim('boxC', trs(f.x, f.z, f.y, Math.atan2(f.vy, f.vx), 0, 4, 0.8, 0.8), C(f.col), 1, Math.min(1, a * 1.6));
      else if (f.k === 'debris') prim('boxC', trs(f.x, f.z + 1, f.y, f.rot, f.rot * 0.7, 4, 1.4, 3), C(f.col), 0, 1);
      else if (f.k === 'fire') { const r = f.r * (0.45 + a * 0.45); prim('sph', trs(f.x, f.z + r, f.y, 0, 0, r * 1.5, r * 2, r * 1.5), C(f.col), 1, 1); }
    }
  }
  const SMOKE_DARK = C('#2b2b30'), SMOKE_LIGHT = C('#9ca3af');
  // jalan aspal hasil paver: ribbon yang menempel kontur; dibangun ulang hanya bila datanya berubah
  let builtMesh = null, builtKey = '', curMesh = null, curKey = '';
  // Untuk ribbonH: subdivide segmen panjang agar jalan halus mengikuti kontur
  function interpPts(pts, maxSeg = 60) {
    if (pts.length < 2) return pts;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len / maxSeg));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }
  function ribbonH(m, pts, w, yo, c, edge) {
    const fine = interpPts(pts, 60);           // subdivide agar lereng halus
    const l = offsetLine(fine, w / 2), r = offsetLine(fine, -w / 2);
    const Y = (p) => THX(p[0], p[1]) + yo;    // THX: pakai terrain yang lebih halus + bahu
    for (let i = 0; i < fine.length - 1; i++) m.quad([l[i][0], Y(l[i]), l[i][1]], [l[i + 1][0], Y(l[i + 1]), l[i + 1][1]], [r[i + 1][0], Y(r[i + 1]), r[i + 1][1]], [r[i][0], Y(r[i]), r[i][1]], [0, 1, 0], c);
    if (edge) for (const sg of [1, -1]) {
      const e = offsetLine(fine, sg * (w / 2 - 4));
      for (let i = 0; i < e.length - 1; i++) {
        const a = e[i], b = e[i + 1], ux = b[0] - a[0], uz = b[1] - a[1], L0 = Math.hypot(ux, uz) || 1, nx = -uz / L0 * 0.9, nz = ux / L0 * 0.9;
        m.quad([a[0] + nx, Y(a) + 0.15, a[1] + nz], [b[0] + nx, Y(b) + 0.15, b[1] + nz], [b[0] - nx, Y(b) + 0.15, b[1] - nz], [a[0] - nx, Y(a) + 0.15, a[1] - nz], [0, 1, 0], edge);
      }
    }
  }
  function drawBuilt(S) {
    const B = S.built; if (!B) return;
    const key = B.roads.length + ':' + (B.ver || 0);
    if (key !== builtKey) {
      builtKey = key;
      const m = new Mesh();
      for (const r of B.roads) ribbonH(m, r.pts, r.w, 1.0, C('#3a3f45'), C('#d6d3d1'));
      builtMesh = m.upload();
    }
    const cur = B.cur, ck = cur ? cur.pts.length : 0;
    if (ck !== curKey) {
      curKey = ck;
      const m = new Mesh();
      if (cur && cur.pts.length > 1) ribbonH(m, cur.pts, cur.w, 1.05, C('#1c1e21'));
      curMesh = m.upload();
    }
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-6, -12);
    if (builtMesh) draw(builtMesh, IDENT, WHITE, 0, 1);
    if (curMesh) draw(curMesh, IDENT, WHITE, 0, 1);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }
  function drawSmoke(S) {                            // asap transparan (digambar bersama efek tembus pandang)
    const cp = cam.tgt;
    for (const f of S.fx || []) {
      if (f.k !== 'smoke' || Math.hypot(f.x - cp[0], f.y - cp[2]) > 1500) continue;
      const gz = TH(f.x, f.y), fz = f.z + gz;
      const near = clamp((Math.hypot(f.x - cam.pos[0], fz - cam.pos[1], f.y - cam.pos[2]) - f.r - 20) / 90, 0, 1);   // pudar dekat kamera
      const a = (1 - f.t / f.life) * near;
      if (a <= 0.01) continue;
      prim('sph', trs(f.x, fz + f.r * 0.6, f.y, 0, 0, f.r * 2, f.r * 1.6, f.r * 2), f.dark ? SMOKE_DARK : SMOKE_LIGHT, 0, (f.dark ? 0.42 : 0.35) * a);
    }
  }

  const SIGC = { r: C('#ff3b30'), y: C('#ffcc00'), g: C('#22e36b') }, SIGOFF = C('#2b2f36');
  function drawSignals(S) {                         // bola lampu merah / kuning / hijau
    if (!S.sigState) return;
    const cp = cam.tgt;
    for (const sg of L.signals || []) {
      if (Math.abs(sg.x - cp[0]) > 1700 || Math.abs(sg.y - cp[2]) > 1700) continue;
      for (const a of sg.arms) {
        const st = S.sigState(sg, a.phase), yaw = Math.atan2(a.uy, a.ux);
        ['r', 'y', 'g'].forEach((c, i) => {
          const on = st === c, x = a.px - a.ux * 2.7, z = a.py - a.uy * 2.7;
          prim('boxC', trs(x, 47.5 - i * 5.8, z, yaw, 0, 0.8, 4.2, 4.2), on ? SIGC[c] : SIGOFF, on ? 1 : 0, 1);
        });
      }
    }
  }
  function drawSignalGlow(S) {                      // pendar lampu (transparan, terlihat jelas malam hari)
    if (!S.sigState) return;
    const cp = cam.tgt, n = S.night || 0;
    for (const sg of L.signals || []) {
      if (Math.abs(sg.x - cp[0]) > 1500 || Math.abs(sg.y - cp[2]) > 1500) continue;
      for (const a of sg.arms) {
        const st = S.sigState(sg, a.phase), i = st === 'r' ? 0 : st === 'y' ? 1 : 2;
        prim('sph', trs(a.px - a.ux * 4, 47.5 - i * 5.8, a.py - a.uy * 4, 0, 0, 9, 9, 9), SIGC[st], 1, 0.18 + 0.3 * n);
        if (n > 0.05) prim('disc', trs(a.px - a.ux * 30, 2.4, a.py - a.uy * 30, 0, 0, 60, 1, 60), SIGC[st], 1, 0.12 * n);
      }
    }
  }
  function drawLamps(S) {                           // bola lampu jalan (menyala malam)
    const n = S.night || 0, cp = cam.tgt;
    for (const l of L.lamps || []) {
      if (Math.abs(l.x - cp[0]) > 1800 || Math.abs(l.y - cp[2]) > 1800) continue;
      const hx = l.x + Math.cos(l.ang) * 22, hz = l.y + Math.sin(l.ang) * 22;
      prim('boxC', trs(hx, 50.5, hz, l.ang, 0, 9, 1.6, 4.6), n > 0.05 ? lerp3(C('#9ca3af'), C('#fff1c2'), n) : C('#9ca3af'), n > 0.05 ? 1 : 0, 1);
    }
  }
  function drawNightLights(S) {                     // kolam cahaya lampu jalan & sorot lampu depan (transparan)
    const n = S.night || 0;
    if (n <= 0.02) return;
    const cp = cam.tgt;
    for (const l of L.lamps || []) {
      if (Math.abs(l.x - cp[0]) > 1600 || Math.abs(l.y - cp[2]) > 1600) continue;
      const hx = l.x + Math.cos(l.ang) * 22, hz = l.y + Math.sin(l.ang) * 22;
      prim('disc', trs(hx, 2.2, hz, 0, 0, 150, 1, 150), C('#ffd27a'), 1, 0.2 * n);
      prim('disc', trs(hx, 2.3, hz, 0, 0, 70, 1, 70), C('#ffe2a6'), 1, 0.16 * n);
    }
    const beam = (V) => {
      if (V.wreck) return;
      const sp = V.spec, L2 = V.type === 'motor' ? 105 : V.type === 'car' ? 150 : 190, wd = L2 * (V.type === 'motor' ? 0.6 : 0.8), fx = Math.cos(V.ang), fz = Math.sin(V.ang);
      const cx = V.x + fx * (sp.front + L2 / 2), cz = V.y + fz * (sp.front + L2 / 2);
      if (Math.abs(cx - cp[0]) > 1500 || Math.abs(cz - cp[2]) > 1500) return;
      prim('tri', trs(cx, 2.4 + TH(cx, cz), cz, V.ang + Math.PI, 0, L2, 1, wd), C('#fff1c4'), 1, 0.26 * n);
    };
    for (const V of S.npcs) beam(V);
    for (const V of S.vehicles) if (V === S.P.veh || Math.abs(V.v) > 0.5) beam(V);
  }

  function drawOverlays(S, now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 260), P = S.P, DEGR = Math.PI / 180;
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    draw(world.glass, IDENT, WHITE, 0, 0.38);
    drawNightLights(S);
    drawSignalGlow(S);
    drawSmoke(S);
    const walking = P.mode === 'walk';
    for (const p of L.places) {                                   // lingkaran titik interaksi
      if (Math.hypot(p.x - cam.tgt[0], p.y - cam.tgt[2]) > 1500) continue;
      prim('ring', trs(p.x, 1.2 + TH(p.x, p.y), p.y, 0, 0, p.r * 2, 1, p.r * 2), C('#fde68a'), 1, walking ? 0.55 + 0.4 * pulse : 0.3);
    }
    const mis = S.mission;
    for (const z of L.zones) {
      const active = mis && mis.zone === z, tr = mis && mis.trailer;
      const fit = active && tr.state === 'hooked' ? S.zoneFit(tr, z).inside : false;
      const yaw = z.angle * DEGR, co = Math.cos(yaw), si = Math.sin(yaw);
      const lw = (lx, lz) => [z.x + lx * co - lz * si, z.y + lx * si + lz * co];
      const col = active ? C('#4ade80') : C('#ffffff');
      // di atas lantai halaman (pads yL(3), marka yL(5)) supaya garis tidak tertutup
      const gy = 2.7 + TH(z.x, z.y), lc = fit ? C('#22c55e') : active ? C('#facc15') : C('#ffffff');
      prim('box', trs(z.x, gy, z.y, yaw, 0, z.w, 0.1, z.h), fit ? C('#22c55e') : col, 1, fit ? 0.5 : active ? 0.14 + 0.12 * pulse : 0.07);
      const ea = active ? 1 : 0.55;
      for (const sg of [-1, 1]) {
        const a = lw(0, sg * z.h / 2), b = lw(sg * z.w / 2, 0);
        prim('box', trs(a[0], gy + 0.1, a[1], yaw, 0, z.w + 2.6, 0.3, 2.6), lc, 1, ea);
        prim('box', trs(b[0], gy + 0.1, b[1], yaw, 0, 2.6, 0.3, z.h + 2.6), lc, 1, ea);
      }
      if (active) for (let t = -0.3; t <= 0.31; t += 0.3) { const c = lw(z.w * t, 0); prim('box', trs(c[0], gy + 0.1, c[1], yaw, 0, 6, 0.3, 1.2), lc, 1, 0.6); }   // garis tengah
      const ar = lw(z.w / 2 - 14, 0);
      prim('tri', trs(ar[0], gy + 0.2, ar[1], yaw, 0, 18, 1, 22), lc, 1, active ? 0.9 : 0.4);
      if (active) for (const sg of [-1, 1]) {                       // tiang sudut zona (terlihat dari jauh / dari kabin)
        for (const sx of [-1, 1]) { const c = lw(sx * z.w / 2, sg * z.h / 2); prim('cylY', trs(c[0], gy - 2.7, c[1], 0, 0, 2.4, 22, 2.4), sx > 0 ? C('#ef4444') : lc, 1, 0.9); }
      }
    }
    if (mis) {                                                    // tiang cahaya penunjuk tujuan + cincin kingpin
      const tr = mis.trailer, hooked = tr.state === 'hooked';
      const bxp = hooked ? mis.zone.x : tr.x, bzp = hooked ? mis.zone.y : tr.y;
      prim('cylY', trs(bxp, 0, bzp, 0, 0, 9, 190, 9), C(hooked ? '#4ade80' : '#f59e0b'), 1, 0.2 + 0.08 * pulse);
      if (!hooked && tr.state === 'parked') {
        const V = P.mode === 'drive' ? P.veh : null;
        let ok = false;
        if (V && V.spec.canTow) {
          const [fx, fz] = S.fifthWheel(V);
          ok = Math.hypot(fx - tr.x, fz - tr.y) < 14 && Math.abs(wrapA(V.ang - tr.ang)) < 20 * DEGR;
        }
        const ry = 2.8 + TH(tr.x, tr.y);
        prim('ring', trs(tr.x, ry, tr.y, 0, 0, 30 + pulse * 6, 1, 30 + pulse * 6), C(ok ? '#4ade80' : '#facc15'), 1, 0.9);
        prim('box', trs(tr.x + Math.cos(tr.ang) * 55, ry, tr.y + Math.sin(tr.ang) * 55, tr.ang, 0, 110, 0.2, 1.6), C(ok ? '#4ade80' : '#facc15'), 1, 0.55);
      }
    }
    gl.depthMask(true); gl.disable(gl.BLEND);
  }

  /* ------------------------------ proyeksi & label ------------------------- */
  function projRaw(x, y, z) {
    const m = curVP, w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!w) return null;
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    return { x: (nx * 0.5 + 0.5) * curCW, y: (1 - (ny * 0.5 + 0.5)) * curCH, behind: w < 0 };
  }
  function project(x, z, y = 0) {                      // dipakai game.js untuk panah target di luar layar
    const p = projRaw(x, y, z);
    if (!p) return [curCW / 2, curCH / 2];
    if (!p.behind) return [p.x, p.y];
    let dx = curCW / 2 - p.x, dy = curCH / 2 - p.y;
    if (Math.hypot(dx, dy) < 2) dy = 2;
    return [curCW / 2 + dx * 1000, curCH / 2 + dy * 1000];
  }
  const PLACE_ICON = { house: '🏠', pump: '⛽', shop: '🛒', warung: '🍜', oleh: '🎁', hotel: '🏨', dealer: '🚗', school: '🏫',
    kumon: '📚', ronde: '🍵', alun: '🌳', bengkel: '🔧', amp: '🏗️', wisata: '🌲', kopdes: '🏬', formulatrix: '🔬', airport: '✈️' };
  function drawLabels(S, c2) {
    const dpr = S.dpr, P = S.P;
    c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.lineJoin = 'round';
    const lab = (text, x, y, z, size, max, col, icon) => {
      const d = Math.hypot(x - cam.pos[0], y - cam.pos[1], z - cam.pos[2]);
      if (d > max) return;
      const p = projRaw(x, y, z);
      if (!p || p.behind || p.x < -150 || p.x > curCW + 150 || p.y < -50 || p.y > curCH + 50) return;
      const fs = clamp(size * 620 / d, icon ? 14 : 9, icon ? 34 : 28) * dpr, fade = 1 - clamp((d - max * 0.6) / (max * 0.4), 0, 1);
      c2.globalAlpha = fade; c2.font = `${icon ? '' : 'bold '}${fs}px sans-serif`;
      if (!icon) { c2.lineWidth = Math.max(2, fs * 0.2); c2.strokeStyle = 'rgba(10,14,20,0.8)'; c2.strokeText(text, p.x, p.y); }
      c2.fillStyle = col; c2.fillText(text, p.x, p.y); c2.globalAlpha = 1;
    };
    if (P.mode === 'drive' && P.veh.type === 'falcon') {
      const x = curCW / 2, y = 44 * dpr;
      c2.save();
      c2.fillStyle = 'rgba(15,23,42,0.82)'; c2.strokeStyle = '#86efac'; c2.lineWidth = 2 * dpr;
      c2.beginPath(); c2.roundRect(x - 126 * dpr, y - 22 * dpr, 252 * dpr, 44 * dpr, 10 * dpr); c2.fill(); c2.stroke();
      c2.fillStyle = '#22c55e'; c2.beginPath(); c2.roundRect(x - 112 * dpr, y - 12 * dpr, 14 * dpr, 24 * dpr, 6 * dpr); c2.fill();
      c2.fillStyle = '#dc2626'; c2.fillRect(x - 110 * dpr, y - 2 * dpr, 10 * dpr, 4 * dpr);
      c2.fillStyle = '#f0fdf4'; c2.font = `bold ${14 * dpr}px sans-serif`;
      c2.fillText('PLANET ELPIJI 3 KG · 19.000', x + 8 * dpr, y);
      c2.restore();
    }
    if (P.mode === 'inside') {
      const th = P.house;
      c2.globalAlpha = 1; c2.font = `bold ${22 * dpr}px sans-serif`; c2.lineWidth = 4 * dpr; c2.strokeStyle = 'rgba(0,0,0,0.7)';
      c2.strokeText(th.label.toUpperCase(), curCW / 2, 70 * dpr); c2.fillStyle = 'rgba(255,255,255,0.9)'; c2.fillText(th.label.toUpperCase(), curCW / 2, 70 * dpr);
      const bed = S.IN.furn.find((f) => f.kind === 'bed');
      for (const z of S.IN.zones) if (z.rect && z.icon) lab(z.icon, z.rect.x + z.rect.w / 2, 30, z.rect.y + z.rect.h / 2, 26, 900, '#fff', true);
      for (const v of S.IN_DISPLAY || []) lab(v.name, v.x + 15, 30, v.y, 14, 900, '#fecaca');
      lab('🚪 KELUAR', S.IN.room.doorX, 16, S.IN.room.h - 4, 12, 900, '#fde68a');
      if (P.resting && (P.resting !== 'bed' || bed)) {
        c2.fillStyle = P.resting === 'bed' ? 'rgba(6,10,30,0.45)' : 'rgba(6,10,30,0.18)'; c2.fillRect(0, 0, curCW, curCH);
        if (P.resting === 'bed') {
          const t0 = performance.now(), bp = projRaw(bed.x + bed.w / 2 + 6, 14, bed.y + 4);
          if (bp && !bp.behind) {
            c2.fillStyle = '#e0e7ff'; c2.textAlign = 'left';
            for (let i = 0; i < 3; i++) {
              const t = (t0 / 1400 + i / 3) % 1; c2.globalAlpha = 1 - t; c2.font = `bold ${(14 + i * 6) * dpr}px sans-serif`;
              c2.fillText('z', bp.x + (10 + t * 40 + i * 6) * dpr, bp.y - (6 + t * 60) * dpr);
            }
            c2.globalAlpha = 1; c2.textAlign = 'center';
          }
        }
      }
      return;
    }
    const mis = S.mission;
    for (const l of world.labels) {
      const col = l.zone ? (mis && mis.zone.id === l.zone ? '#bbf7d0' : 'rgba(255,255,255,0.6)') : l.col;
      lab(l.text, l.x, l.h, l.z, l.size, l.max, col);
    }
    for (const t of S.trailers) lab(t.id, t.x - Math.cos(t.ang) * 61, 58 + TH(t.x, t.y), t.y - Math.sin(t.ang) * 61, 14, 650, '#fff');
    for (const v of S.vehicles) if (P.veh !== v) { const [mx, mz] = [v.x + Math.cos(v.ang) * 22, v.y + Math.sin(v.ang) * 22]; lab(v.name, mx, TH(v.x, v.y) + (v.type === 'falcon' ? 132 : v.type === 'plane' ? 36 : v.type === 'tractor' ? 54 : v.type === 'custom' ? 44 : v.type === 'motor' ? 22 : v.type === 'paver' || v.type === 'milling' ? 56 : v.type === 'tanker' ? 42 : 30), mz, 12, 1200, '#e5e7eb'); }
    for (const n of S.npcs) if (n.service) {
      if (n.foodDelivery) lab('🛵 Kurir Delivery Food', n.x + Math.cos(n.ang) * 12, TH(n.x, n.y) + 26, n.y + Math.sin(n.ang) * 12, 12, 1400, '#34d399');
      else if (n.taxiService) lab('🚕 Taksi Salatiga', n.x + Math.cos(n.ang) * 20, TH(n.x, n.y) + 34, n.y + Math.sin(n.ang) * 20, 13, 1400, '#fbbf24');
      else lab('🚛 Mobil Tangki BBM', n.x + Math.cos(n.ang) * 20, TH(n.x, n.y) + 44, n.y + Math.sin(n.ang) * 20, 13, 1400, '#fdba74');
    }
    if (S.foodJob) {
      const pt = S.foodJob.phase === 'pickup' ? S.foodJob.pickup : S.foodJob.dest;
      lab(S.foodJob.phase === 'pickup' ? '🍲 Ambil Pesanan Makanan' : '📍 Antar ke Pelanggan', pt.x, TH(pt.x, pt.y) + 36, pt.y, 14, 1600, '#34d399');
    }
    if (S.taxiJob) {
      const tj = S.taxiJob;
      const pt = tj.phase === 'pickup' ? tj.pickup : tj.dest;
      lab(tj.phase === 'pickup' ? `🙋 Jemput ${tj.passenger}` : `🏁 Antar ${tj.passenger}`, pt.x, TH(pt.x, pt.y) + 38, pt.y, 15, 1700, '#fbbf24');
    }
    const now = performance.now();
    for (const p of L.places) lab(PLACE_ICON[p.kind] || '•', p.x, TH(p.x, p.y) + 34 + Math.sin(now / 300 + p.x) * 3, p.y, 22, 900, '#fff', true);
    lab('ELPIJI 3 KG', LPG_PLANET.x, LPG_PLANET.altitude + 275, LPG_PLANET.z, 20, 26000, '#bbf7d0');

    // Countdown digital pada tiang lampu lalu lintas
    if (S.sigCountdown) {
      for (const sg of L.signals || []) {
        if (Math.abs(sg.x - cam.tgt[0]) > 1400 || Math.abs(sg.y - cam.tgt[2]) > 1400) continue;
        for (const a of sg.arms) {
          const sc = S.sigCountdown(sg, a.phase);
          const col = sc.state === 'r' ? '#ff3b30' : sc.state === 'g' ? '#22e36b' : '#ffcc00';
          const px = a.px - a.ux * 2.8, pz = a.py - a.uy * 2.8;
          lab(String(sc.sec), px, 56 + TH(px, pz), pz, 14, 550, col);
        }
      }
    }
  }

  /* ------------------------------ bingkai ---------------------------------- */
  function frame(now, S, c2) {
    if (!R.ready) return;
    const dt = clamp((now - lastNow) / 1000, 0, 0.1); lastNow = now;
    const cw = c2.canvas.width, ch = c2.canvas.height; curCW = cw; curCH = ch;
    if (glc.width !== cw || glc.height !== ch) { glc.width = cw; glc.height = ch; }
    const P = S.P, inside = P.mode === 'inside', modeKey = P.mode + (P.veh ? P.veh.id : '');
    const snap = lastInside === null || inside !== lastInside || forceSnap;
    if ((modeKey !== lastMode || forceSnap) && P.mode === 'drive') cam.yaw = P.veh.ang;
    if (forceSnap) { forceSnap = false; cam.autoTop = false; }
    lastInside = inside; lastMode = modeKey;
    if (S.state === 'play') for (const list of [S.vehicles, S.npcs]) for (const v of list) entOf(v).dist += v.v * dt;
    updateCam(S, dt, snap);
    const sh = inside ? 0 : (S.cam.shake || 0);           // guncangan kamera saat tabrakan
    const eye = sh > 0.02 ? cam.pos.map((v) => v + (Math.random() - 0.5) * sh * 8) : cam.pos;
    curVP = mul(persp(cam.fov * DEG, cw / ch, 4, 40000), lookAt(eye, cam.tgt));

    let sc, env, lc, Rr;
    if (inside) {
      const key = S.IN.key + ':' + (P.house.theme || ''); sc = interiors[key] || (interiors[key] = buildInterior(S)); env = ENV_IN; lc = sc.center;
      Rr = Math.max(170, Math.hypot(S.IN.room.w, S.IN.room.h) * 0.62);
    } else {
      sc = world; env = S.clock != null ? envAt(S.clock, S.night || 0) : ENV_OUT; lc = cam.tgt;
      Rr = S.intro ? 900 : (S.cam.view3d === 'top' ? [560, 760, 1000] : P.mode === 'drive' ? [430, 580, 820] : [300, 400, 560])[S.cam.zoom];
    }
    const lv = lightVP(lc, Rr, env), lim = inside ? 1e9 : Rr * 2.2;

    // 1) shadow map
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, SH.fb); gl.viewport(0, 0, SH.size, SH.size);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT);
    setProgram(progShadow); gl.uniformMatrix4fv(progShadow.u.uLightVP, false, lv.m);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 4);
    draw(sc.solid, IDENT);
    drawEntities(S, 'shadow', inside, lim);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // 2) layar
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);
    const bg = inside ? [0.04, 0.03, 0.02] : env.hor;
    gl.clearColor(Math.pow(bg[0], 1 / 2.2), Math.pow(bg[1], 1 / 2.2), Math.pow(bg[2], 1 / 2.2), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!inside) {
      gl.disable(gl.DEPTH_TEST); setProgram(progSky);
      const u = progSky.u;
      gl.uniformMatrix4fv(u.uInvVP, false, inv(curVP)); gl.uniform3fv(u.uCam, cam.pos); gl.uniform3fv(u.uSun, env.sun);
      gl.uniform3fv(u.uHor, env.hor); gl.uniform3fv(u.uZen, env.zen); gl.uniform1f(u.uTime, (now - T0) / 1000); gl.uniform1f(u.uNight, env.night || 0);
      gl.bindVertexArray(vaoEmpty); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST);
    }
    setProgram(progMain);
    const u = progMain.u;
    gl.uniformMatrix4fv(u.uVP, false, curVP); gl.uniformMatrix4fv(u.uLightVP, false, lv.m);
    gl.uniform3fv(u.uSunDir, env.sun); gl.uniform3fv(u.uSunCol, env.sunCol); gl.uniform3fv(u.uSkyCol, env.sky); gl.uniform3fv(u.uGndCol, env.gnd);
    gl.uniform3fv(u.uCam, cam.pos); gl.uniform3fv(u.uFogCol, env.fog); gl.uniform2f(u.uFog, env.fogNear, env.fogFar);
    gl.uniform1f(u.uShadowOn, 1); gl.uniform1f(u.uTexel, 1 / SH.size); gl.uniform1f(u.uBias, 3 / lv.range); gl.uniform1f(u.uNormOff, lv.worldTexel * 1.4);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, SH.tex); gl.uniform1i(u.uShadow, 0);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    sc.layers.forEach((m, i) => { gl.polygonOffset(-i, -i * 2); draw(m, IDENT, WHITE, 0, 1); });
    gl.disable(gl.POLYGON_OFFSET_FILL);
    draw(sc.solid, IDENT, WHITE, 0, 1);
    if (sc.glow) draw(sc.glow, IDENT, WHITE, 0.9, 1);
    if (sc.lit) {                                   // jendela: biru kaca di siang hari, kuning menyala di malam hari
      const n = S.night || 0;
      draw(sc.lit, IDENT, lerp3(C('#5f86a8'), C('#ffcf6e'), n), n * 0.95, 1);
    }
    if (!inside) { drawBuilt(S); drawLamps(S); drawSignals(S); }
    drawEntities(S, 'main', inside, 4200);
    if (!inside) drawOverlays(S, now);

    // 3) label di kanvas 2D
    drawLabels(S, c2);
  }

  /* ------------------------------ inisialisasi ----------------------------- */
  function init(level, S) {
    L = level; L.TR = S.TRAILER; S0 = S;
    glc = document.getElementById('game3d');
    gl = glc.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 tidak tersedia');
    makePrims();
    lpgPlanet = bakeLpgPlanet();
    progMain = program(VS_MAIN, FS_MAIN, ['uVP', 'uModel', 'uLightVP', 'uNorm', 'uNormOff', 'uTint', 'uEmis', 'uAlpha', 'uShadowOn', 'uTexel', 'uBias',
      'uSunDir', 'uSunCol', 'uSkyCol', 'uGndCol', 'uCam', 'uFogCol', 'uFog', 'uShadow']);
    progShadow = program(VS_SHADOW, FS_SHADOW, ['uLightVP', 'uModel']);
    progSky = program(VS_SKY, FS_SKY, ['uInvVP', 'uCam', 'uSun', 'uHor', 'uZen', 'uTime', 'uNight']);
    vaoEmpty = gl.createVertexArray();
    SH.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, SH.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SH.size, SH.size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    SH.fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, SH.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, SH.tex, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer bayangan tidak lengkap');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.CULL_FACE);
    TER = L.terrain || null;
    buildRoadBumpGrid(L.roadBumps);
    world = buildWorld();
    world.drape.forEach(drapeMesh);
    for (const l of world.labels) l.h += TH(l.x, l.z);
    world.layers.forEach((m) => m.upload()); world.solid.upload(); world.glass.upload(); world.lit.upload();
    buildOccluders();
    R.stats = { solidVerts: world.solid.n, layerVerts: world.layers.map((m) => m.n), labels: world.labels.length };
    R.ready = true;
  }

  R.exportModel = exportModel; R.rotAbout = rotAbout;
  R.wiperCount = (V) => { if (!PR.box) makePrims(); return (modelFor(V).movers || []).length; };     // jumlah wiper kendaraan (0 = tidak punya)
  R.init = init; R.frame = frame; R.project = project; R.projRaw = projRaw; R.tvScreen = tvScreen; R.TH = TH;
  R.snap = () => { forceSnap = true; lastNow = performance.now(); };      // dipanggil saat ganti 2D -> 3D
  return R;
  return R;
})();
