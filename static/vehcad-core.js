'use strict';
/* Inti editor kendaraan CAD <-> game (fungsi murni, tanpa Three.js, bisa diuji di Node).
 *
 *   importModel(model)      model = hasil Render3D.exportModel (satuan px, origin as roda belakang)
 *                           -> daftar "part" editor (satuan meter), siap dimuat ke editor lewat restoreState()
 *   partToMeshes(part)      part editor -> daftar bentuk netral (dipakai tes; editor memakai Three untuk semua jenis part)
 *   compile(items, opts)    daftar bentuk netral (meter, matriks dunia) -> { prims, wheels, lamps, auto } untuk game (px)
 *
 * Konvensi: matriks 4x4 kolom-mayor (sama dengan Three.js & render3d), sudut Euler urutan XYZ seperti Three.js.
 * Sumbu sama dengan game: x = depan, y = atas, z = samping. Editor: 1 unit = 1 m; game: 10 px = 1 m. */
(function (root) {
  const PX = 10, r4 = (v) => Math.round(v * 1e4) / 1e4, r2 = (v) => Math.round(v * 100) / 100;

  /* ------------------------------------------------------------ matriks */
  const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
    return o;
  }
  const scaleM = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
  const transM = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const apply = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  const colLen = (m, c) => Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);

  function rotFromEuler(e) {                      // Three.js Matrix4.makeRotationFromEuler, urutan 'XYZ'
    const a = Math.cos(e[0]), b = Math.sin(e[0]), c = Math.cos(e[1]), d = Math.sin(e[1]), g = Math.cos(e[2]), f = Math.sin(e[2]);
    const ae = a * g, af = a * f, be = b * g, bf = b * f;
    return [c * g, af + be * d, bf - ae * d, 0, -c * f, ae - bf * d, be + af * d, 0, d, -b * c, a * c, 0, 0, 0, 0, 1];
  }
  function eulerFromRot(m) {                      // Three.js Euler.setFromRotationMatrix, urutan 'XYZ'
    const m11 = m[0], m12 = m[4], m13 = m[8], m22 = m[5], m23 = m[9], m32 = m[6], m33 = m[10];
    const y = Math.asin(Math.max(-1, Math.min(1, m13)));
    if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33), y, Math.atan2(-m12, m11)];
    return [Math.atan2(m32, m22), y, 0];
  }
  function compose(pos, euler, scale) {            // T * R * S
    const R = rotFromEuler(euler), m = R.slice();
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] *= scale[c];
    m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2];
    return m;
  }
  // pecah matriks T*R*S: skala selalu positif (bila ada cermin, kolom pertama rotasi dibalik)
  function decompose(m) {
    const s = [colLen(m, 0) || 1e-9, colLen(m, 1) || 1e-9, colLen(m, 2) || 1e-9], R = I4();
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) R[c * 4 + r] = m[c * 4 + r] / s[c];
    const det = R[0] * (R[5] * R[10] - R[9] * R[6]) - R[4] * (R[1] * R[10] - R[9] * R[2]) + R[8] * (R[1] * R[6] - R[5] * R[2]);
    if (det < 0) { R[0] = -R[0]; R[1] = -R[1]; R[2] = -R[2]; }
    return { pos: [m[12], m[13], m[14]], R, s };
  }

  /* ------------------------------------------------------------ warna */
  const lin2hex = (c) => '#' + c.map((v) => Math.round(Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2) * 255).toString(16).padStart(2, '0')).join('');

  /* ------------------------------------------------------------ impor: aset game -> part editor */
  // bentuk primitif game -> jenis part editor.  c = titik tengah bentuk di ruang lokal primitif (kotak/silinder game berpangkal di y = 0);
  // A = putaran dari sumbu bentuk editor (silinder/kerucut sumbu Y) ke sumbu primitif game; sc = pemetaan skala game -> skala bentuk editor
  const Rx90 = rotFromEuler([Math.PI / 2, 0, 0]), Rzm90 = rotFromEuler([0, 0, -Math.PI / 2]);
  const SHAPES = {
    box: { type: 'primBox', c: [0, 0.5, 0], name: 'Box' }, boxC: { type: 'primBox', c: [0, 0, 0], name: 'Box' },
    cylY: { type: 'primCylinder', c: [0, 0.5, 0], sc: (s) => [s[0] / 2, s[1] / 2, s[2] / 2], name: 'Silinder' },
    cylYlo: { type: 'primCylinder', c: [0, 0.5, 0], sc: (s) => [s[0] / 2, s[1] / 2, s[2] / 2], name: 'Silinder' },
    cylY16: { type: 'primCylinder', c: [0, 0.5, 0], sc: (s) => [s[0] / 2, s[1] / 2, s[2] / 2], name: 'Silinder' },
    cylX: { type: 'primCylinder', c: [0, 0, 0], A: Rzm90, sc: (s) => [s[1] / 2, s[0] / 2, s[2] / 2], name: 'Silinder' },
    cylZ: { type: 'primCylinder', c: [0, 0, 0], A: Rx90, sc: (s) => [s[0] / 2, s[2] / 2, s[1] / 2], name: 'Silinder' },
    cone: { type: 'primCone', c: [0, 0.5, 0], sc: (s) => [s[0] / 2, s[1] / 2, s[2] / 2], name: 'Kerucut' },
    coneLo: { type: 'primCone', c: [0, 0.5, 0], sc: (s) => [s[0] / 2, s[1] / 2, s[2] / 2], name: 'Kerucut' },
    cone16: { type: 'primCone', c: [0, 0.5, 0], sc: (s) => [s[0] / 2, s[1] / 2, s[2] / 2], name: 'Kerucut' },
    sph: { type: 'primSphere', c: [0, 0, 0], sc: (s) => [s[0] / 2, s[1] / 2, s[2] / 2], name: 'Bola' },
    sphLo: { type: 'primSphere', c: [0, 0, 0], sc: (s) => [s[0] / 2, s[1] / 2, s[2] / 2], name: 'Bola' },
    sph12: { type: 'primSphere', c: [0, 0, 0], sc: (s) => [s[0] / 2, s[1] / 2, s[2] / 2], name: 'Bola' },
  };
  const part = (o) => Object.assign({ name: 'Part', type: 'primBox', isWheel: false, steerable: false, isMoving: false, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#888888', bevel: null, customBox: null }, o);

  function importModel(model) {
    const parts = [], cnt = {};
    const nm = (base) => base + '_' + String(cnt[base] = (cnt[base] || 0) + 1).padStart(2, '0');
    for (const rec of model.rec || []) {
      const color = lin2hex(rec.c);
      if (rec.k === 'tris') {                                       // segitiga bebas -> mesh kustom, titik relatif terhadap titik tengahnya
        const v = rec.v, n = v.length / 3; if (!n) continue;
        let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
        for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i * 3 + k]); hi[k] = Math.max(hi[k], v[i * 3 + k]); }
        const c = lo.map((a, k) => (a + hi[k]) / 2), rel = [];
        for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) rel.push(r4((v[i * 3 + k] - c[k]) / PX));
        parts.push(part({ name: nm('Mesh'), type: 'customMesh', position: c.map((a) => r4(a / PX)), color, tris: rel }));
        continue;
      }
      const sh = SHAPES[rec.k]; if (!sh) continue;
      const d = decompose(rec.m), ctr = apply(rec.m, sh.c);          // titik tengah di dunia (px)
      const Q = sh.A ? mul(d.R, sh.A) : d.R, o = { name: nm(sh.name), type: sh.type, color, position: ctr.map((a) => r4(a / PX)), rotation: eulerFromRot(Q).map(r4) };
      if (sh.type === 'primBox') o.customBox = d.s.map((a) => Math.max(0.01, r4(a / PX)));
      else o.scale = sh.sc(d.s).map((a) => Math.max(0.01, r4(a / PX)));
      if (rec.ao > 0) o.ao = rec.ao;
      parts.push(part(o));
    }
    // roda: pasangkan kiri-kanan (z & -z) menjadi satu as
    const used = new Set(), W = model.wheels || [], eq = (a, b) => Math.abs(a - b) < 0.05;
    for (let i = 0; i < W.length; i++) {
      if (used.has(i)) continue; const w = W[i]; used.add(i);
      let j = -1;
      if (Math.abs(w.z) > 0.05) j = W.findIndex((o, k) => !used.has(k) && eq(o.x, w.x) && eq(o.y, w.y) && eq(o.r, w.r) && eq(o.z, -w.z) && !!o.steer === !!w.steer);
      if (j >= 0) used.add(j);
      const wheel = { r: r4(w.r / PX), w: r4((w.w || w.r) / PX), track: r4(Math.abs(w.z) / PX) };
      if (j < 0) wheel.single = true;
      parts.push(part({ name: nm(w.steer ? 'AsSetir' : 'AsRoda'), type: 'wheelPair', isWheel: true, steerable: !!w.steer, color: '#222222',
        position: [r4(w.x / PX), r4(w.y / PX), j < 0 ? r4(w.z / PX) : 0], wheel }));
    }
    for (const l of model.lamps || []) {
      parts.push(part({ name: nm(l.kind === 'tail' ? 'LampuBelakang' : 'LampuDepan'), type: l.kind === 'tail' ? 'lampTail' : 'lampHead',
        color: l.kind === 'tail' ? '#ef4444' : '#fde68a', position: [l.x, l.y, l.z].map((a) => r4(a / PX)), customBox: [l.sx, l.sy, l.sz].map((a) => Math.max(0.02, r4(a / PX))) }));
    }
    return parts;
  }

  /* ------------------------------------------------------------ part editor -> bentuk netral (hanya jenis hasil impor; dipakai tes) */
  function partToMeshes(p) {
    const m = compose(p.position, p.rotation, p.scale);
    switch (p.type) {
      case 'primBox': return [{ kind: 'mesh', shape: 'box', m, dims: p.customBox || [1.5, 1.5, 1.5], color: p.color, bevel: p.bevel, ao: p.ao }];
      case 'primCylinder': return [{ kind: 'mesh', shape: 'cyl', m, rt: 1, rb: 1, h: 2, color: p.color, ao: p.ao }];
      case 'primCone': return [{ kind: 'mesh', shape: 'cone', m, r: 1, h: 2, color: p.color, ao: p.ao }];
      case 'primSphere': return [{ kind: 'mesh', shape: 'sph', m, r: 1, color: p.color }];
      case 'customMesh': return [{ kind: 'mesh', shape: 'tris', m, v: p.tris, color: p.color }];
      case 'wheelPair': return [{ kind: 'wheel', m, wheel: p.wheel, steer: !!p.steerable }];
      case 'lampHead': case 'lampTail': return [{ kind: 'lamp', m, dims: p.customBox || [0.1, 0.16, 0.45], lamp: p.type === 'lampTail' ? 'tail' : 'head' }];
      default: return [];
    }
  }

  /* ------------------------------------------------------------ kompilasi: bentuk netral -> primitif game */
  function localBox(it) {                          // kotak pembatas lokal (min, maks) tiap bentuk, untuk menghitung ukuran bodi
    if (it.shape === 'box') return [it.dims.map((d) => -d / 2), it.dims.map((d) => d / 2)];
    if (it.shape === 'cyl') { const r = Math.max(it.rt, it.rb); return [[-r, -it.h / 2, -r], [r, it.h / 2, r]]; }
    if (it.shape === 'cone') return [[-it.r, -it.h / 2, -it.r], [it.r, it.h / 2, it.r]];
    if (it.shape === 'sph') return [[-it.r, -it.r, -it.r], [it.r, it.r, it.r]];
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < it.v.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], it.v[i + k]); hi[k] = Math.max(hi[k], it.v[i + k]); }
    return [lo, hi];
  }
  function compile(items, opts = {}) {
    // 1) roda: posisi pusat (meter) dan ukuran efektif
    const wheels = [];
    for (const it of items) if (it.kind === 'wheel') {
      const w = it.wheel, sx = colLen(it.m, 0), sy = colLen(it.m, 1), sz = colLen(it.m, 2), r = w.r * (sx + sy) / 2, wd = w.w * sz;
      const zs = w.single ? [0] : [w.track, -w.track];
      for (const z of zs) { const c = apply(it.m, [0, 0, z]); wheels.push({ x: c[0], y: c[1], z: c[2], r, w: wd, steer: !!it.steer }); }
    }
    const X0 = opts.rearX !== undefined ? opts.rearX : (wheels.length ? Math.min(...wheels.map((w) => w.x)) : 0);
    // tanah: dasar roda terendah = y 0 (kendaraan buatan dari nol tidak melayang / terbenam)
    const Y0 = opts.groundY !== undefined ? opts.groundY : (wheels.length ? Math.min(...wheels.map((w) => w.y - w.r)) : 0);
    const toGame = (m) => { const o = m.slice(); for (let i = 0; i < 12; i++) o[i] *= PX; o[12] = (m[12] - X0) * PX; o[13] = (m[13] - Y0) * PX; o[14] = m[14] * PX; return o.map(r4); };

    // 2) bentuk -> primitif; sekaligus hitung kotak pembatas bodi
    const prims = [], movers = []; let minX = 1e9, maxX = -1e9, maxZ = 0, fifthX = null, towPivot = null;
    const grow = (p) => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); maxZ = Math.max(maxZ, Math.abs(p[2])); };
    const emit = (it) => {                                    // satu bentuk netral -> satu primitif game (atau null)
      const [lo, hi] = localBox(it);
      for (const cx of [lo[0], hi[0]]) for (const cy of [lo[1], hi[1]]) for (const cz of [lo[2], hi[2]]) grow(apply(it.m, [cx, cy, cz]));
      const c = it.color || '#888888';
      if (it.shape === 'box' && it.bevel && it.bevel.mode && it.bevel.mode !== 'none' && it.bevel.r > 0)
        return { k: 'bevel', m: toGame(it.m), c, d: it.dims.map(r4), r: r4(it.bevel.r), n: it.bevel.seg || 4, mode: it.bevel.mode };
      if (it.shape === 'box') {
        const ao = it.ao > 0 ? r4(it.ao) : 0;                  // ao memakai sumbu y primitif 0..1 -> pakai kotak berpangkal di dasar
        if (ao) return { k: 'box', ao, m: toGame(mul(it.m, mul(transM(0, -it.dims[1] / 2, 0), scaleM(it.dims[0], it.dims[1], it.dims[2])))), c };
        return { k: 'boxC', m: toGame(mul(it.m, scaleM(it.dims[0], it.dims[1], it.dims[2]))), c };
      }
      if (it.shape === 'cyl' && Math.abs(it.rt - it.rb) < 1e-6) { const q = { k: 'cylY16', m: toGame(mul(it.m, mul(transM(0, -it.h / 2, 0), scaleM(2 * it.rt, it.h, 2 * it.rt)))), c }; if (it.ao > 0) q.ao = r4(it.ao); return q; }
      if (it.shape === 'cone') { const q = { k: 'cone16', m: toGame(mul(it.m, mul(transM(0, -it.h / 2, 0), scaleM(2 * it.r, it.h, 2 * it.r)))), c }; if (it.ao > 0) q.ao = r4(it.ao); return q; }
      if (it.shape === 'sph') return { k: 'sph12', m: toGame(mul(it.m, scaleM(2 * it.r, 2 * it.r, 2 * it.r))), c };
      if (it.shape === 'tris') {
        const g = toGame(it.m), v = [];
        for (let i = 0; i < it.v.length; i += 3) v.push(...apply(g, [it.v[i], it.v[i + 1], it.v[i + 2]]).map(r2));
        return { k: 'tris', v, c };
      }
      return null;
    };
    for (const it of items) {
      if (it.kind === 'marker') {
        if (it.name === 'fifth') fifthX = apply(it.m, [0, 0, 0])[0];
        else if (it.name === 'towVehicle') towPivot = [r2((it.point[0] - X0) * PX), r2(it.point[2] * PX)];
        continue;
      }
      if (it.kind === 'mover') {
        // bagian bergerak (wiper): batang pertama berbentuk kotak menentukan poros. Titik tumpu = ujung bawah sumbu Y lokalnya,
        // sumbu putar = sumbu X lokalnya (tegak lurus kaca), arah sapuan dipilih agar ujung batang bergerak ke atas.
        const arm = it.meshes.find((q) => q.shape === 'box'), mp = it.meshes.map(emit).filter(Boolean);
        if (!arm || !mp.length) { prims.push(...mp); continue; }
        const piv = apply(arm.m, [0, -arm.dims[1] / 2, 0]), tip = apply(arm.m, [0, arm.dims[1] / 2, 0]);
        let ax = [arm.m[0], arm.m[1], arm.m[2]]; const al = Math.hypot(...ax) || 1; ax = ax.map((v) => v / al);
        const d = [tip[0] - piv[0], tip[1] - piv[1], tip[2] - piv[2]], vy = ax[2] * d[0] - ax[0] * d[2];      // sumbu y dari (sumbu x arah sapuan)
        movers.push({ type: 'wiper', pivot: [(piv[0] - X0) * PX, (piv[1] - Y0) * PX, piv[2] * PX].map(r2), axis: ax.map(r4), a: (Math.abs(vy) > 1e-6 && vy < 0 ? -1 : 1) * (it.sweep || 1.2), prims: mp });
        continue;
      }
      if (it.kind !== 'mesh') continue;
      const q = emit(it); if (q) prims.push(q);
    }
    for (const w of wheels) { grow([w.x - w.r, 0, w.z + w.w / 2]); grow([w.x + w.r, 0, w.z - w.w / 2]); }

    // 3) roda & lampu dalam px
    const outW = wheels.map((w) => { const o = { x: r2((w.x - X0) * PX), y: r2((w.y - Y0) * PX), z: r2(w.z * PX), r: r2(w.r * PX), w: r2(w.w * PX) }; if (w.steer) o.steer = true; return o; });
    const lamps = [];
    for (const it of items) if (it.kind === 'lamp') {
      const c = apply(it.m, [0, 0, 0]);
      lamps.push({ x: r2((c[0] - X0) * PX), y: r2((c[1] - Y0) * PX), z: r2(c[2] * PX), sx: r2(it.dims[0] * colLen(it.m, 0) * PX), sy: r2(it.dims[1] * colLen(it.m, 1) * PX), sz: r2(it.dims[2] * colLen(it.m, 2) * PX), kind: it.lamp });
    }
    // 4) ukuran fisik otomatis (px, origin = as roda belakang)
    const steerX = wheels.filter((w) => w.steer).map((w) => w.x), allX = wheels.map((w) => w.x);
    const frontAxle = steerX.length ? Math.max(...steerX) : (allX.length ? Math.max(...allX) : X0);
    const hasBody = minX <= maxX;
    const auto = { rearAxleM: X0, groundM: Y0, wb: r2((frontAxle - X0) * PX), rear: hasBody ? r2((minX - X0) * PX) : -10, front: hasBody ? r2((maxX - X0) * PX) : 40, hw: r2(Math.max(maxZ, 0.2) * PX),
      fifth: fifthX === null ? null : r2((fifthX - X0) * PX), towPivot, wheelCount: wheels.length, axles: new Set(allX.map((x) => Math.round(x * 20))).size };
    return { prims, wheels: outW, lamps, movers, auto };
  }

  root.VehCadCore = { PX, I4, mul, compose, decompose, rotFromEuler, eulerFromRot, apply, scaleM, transM, colLen, lin2hex, importModel, partToMeshes, compile };
})(typeof window !== 'undefined' ? window : module.exports);
