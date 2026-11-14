'use strict';
/* Integrasi editor kendaraan CAD (templates/vehicle_editor.html) <-> game.
 *  - Muat aset kendaraan game ke editor   (Render3D.exportModel -> VehCadCore.importModel -> restoreState)
 *  - Kompilasi model editor -> primitif game (VehCadCore.compile) dan simpan ke settings.json lewat /api/vehicles
 *  - Buka / hapus kendaraan yang sudah tersimpan di game
 * Memakai fungsi global editor asli: assemblyGroup, recordState, restoreState, serializeObject, selectedObjects, buildWheelAxle. */
(() => {
  const Core = window.VehCadCore, SPECS = window.VEH_SPECS || {};
  const $ = (id) => document.getElementById(id);
  const DEG = Math.PI / 180, KMH = 0.36;                      // px/detik -> km/j  (10 px = 1 m)
  const BASES = ['car', 'tractor', 'box', 'minitruck'];
  let catalog = [], saved = [], editingId = null, lastSig = '';

  const say = (msg, bad) => { const el = $('gv-status'); el.textContent = msg; el.style.color = bad ? '#f87171' : '#86efac'; };
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  const setv = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v === null || v === undefined || Number.isNaN(v) ? '' : v; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ------------------------------------------------------------ model Three.js -> bentuk netral */
  function geoTris(g) {
    const pa = g.attributes.position, idx = g.index, out = [];
    const P = (i) => [pa.getX(i), pa.getY(i), pa.getZ(i)];
    if (idx) for (let i = 0; i < idx.count; i++) out.push(...P(idx.getX(i)));
    else for (let i = 0; i < pa.count; i++) out.push(...P(i));
    return out;
  }
  function ownerPart(o) {
    let p = o; while (p && !(p.userData && p.userData.partType) && p.parent) p = p.parent;
    return p && p.userData && p.userData.partType ? p : null;
  }
  function meshToItem(o) {
    const g = o.geometry, p = g.parameters || {}, m = Array.from(o.matrixWorld.elements);
    const color = '#' + o.material.color.getHexString(), own = ownerPart(o), ud = own ? own.userData : {}, ao = ud.ao || 0;
    if (o.userData.boxDims || g.type === 'BoxGeometry') return { kind: 'mesh', shape: 'box', m, dims: o.userData.boxDims || [p.width, p.height, p.depth], color, bevel: ud.bevel || null, ao };
    if (g.type === 'CylinderGeometry' && Math.abs(p.radiusTop - p.radiusBottom) < 1e-6) return { kind: 'mesh', shape: 'cyl', m, rt: p.radiusTop, rb: p.radiusBottom, h: p.height, color, ao };
    if (g.type === 'ConeGeometry' && p.radialSegments >= 12) return { kind: 'mesh', shape: 'cone', m, r: p.radius, h: p.height, color, ao };
    if (g.type === 'SphereGeometry' && p.widthSegments >= 12) return { kind: 'mesh', shape: 'sph', m, r: p.radius, color };
    return { kind: 'mesh', shape: 'tris', m, v: geoTris(g), color };          // torus, ring, plane, baji, mixer, mesh kustom, dll.
  }
  const WHEEL_DEFAULT = { r: 0.6, w: 0.4, track: 1.1 };
  function collectItems() {
    assemblyGroup.updateMatrixWorld(true);
    const items = [], mat = (o) => Array.from(o.matrixWorld.elements);
    const visit = (o) => {
      if (o.visible === false) return;
      const ud = o.userData || {}, t = ud.partType;
      if (ud.isWheel) { items.push({ kind: 'wheel', m: mat(o), wheel: ud.wheel || WHEEL_DEFAULT, steer: !!ud.steerable }); return; }
      if (t === 'lampHead' || t === 'lampTail') {
        let mesh = null;
        o.traverse((child) => { if (!mesh && child.isMesh && child.visible !== false) mesh = child; });
        items.push({ kind: 'lamp', m: mat(mesh || o), dims: ud.customBox || [0.1, 0.16, 0.45], lamp: t === 'lampTail' ? 'tail' : 'head' });
        return;
      }
      if (t === 'wiper') {                                     // wiper: bagian bergerak, menyapu saat wiper dinyalakan di game
        const meshes = []; o.traverse((c) => { if (c.isMesh && c.visible !== false && c.geometry) meshes.push(meshToItem(c)); });
        items.push({ kind: 'mover', type: 'wiper', meshes }); return;
      }
      if (t === 'payloadFifthWheel') items.push({ kind: 'marker', name: 'fifth', m: mat(o) });
      if (t === 'payloadCrane') o.traverse((c) => {
        if (c.visible !== false && c.userData && c.userData.towTip) items.push({ kind: 'marker', name: 'towVehicle', point: Core.apply(mat(c), c.userData.towTip) });
      });
      if (o.isMesh) { items.push(meshToItem(o)); return; }
      o.children.forEach(visit);
    };
    assemblyGroup.children.forEach(visit);
    return items;
  }

  /* ------------------------------------------------------------ properti kendaraan di panel */
  function baseDefaults(base) {
    const s = SPECS[base] || SPECS.car || {};
    return { vf: s.vf, acc: s.acc, maxSteer: s.maxSteer, tank: s.tank, burn: s.burn, fuelName: s.fuelName, mass: s.mass, door: s.door, grip: s.grip ?? 0.4 };
  }
  function fillProps(o) {
    if (o.name !== undefined) setv('gv-name', o.name);
    if (o.base) $('gv-base').value = o.base;
    if (o.color) setv('gv-color', o.color);
    if (o.vf !== undefined) setv('gv-speed', Math.round(o.vf * KMH));
    if (o.acc !== undefined) setv('gv-acc', Math.round(o.acc));
    if (o.maxSteer !== undefined) setv('gv-steer', Math.round(o.maxSteer / DEG));
    if (o.maxSteerDeg !== undefined) setv('gv-steer', Math.round(o.maxSteerDeg));
    if (o.tank !== undefined) setv('gv-tank', o.tank);
    if (o.burn !== undefined) setv('gv-burn', o.burn);
    if (o.fuelName) $('gv-fuel').value = o.fuelName === 'Solar' ? 'Solar' : 'Pertalite';
    if (o.mass !== undefined) setv('gv-mass', o.mass);
    if (o.grip !== undefined) setv('gv-grip', o.grip);
    if (o.door !== undefined) setv('gv-door', o.door);
  }
  function recalc() {
    let res;
    try {
      const manual = !$('gv-origin-auto').checked;
      res = Core.compile(collectItems(), manual ? { rearX: num('gv-origin-x', 0) } : {});
    } catch (e) { say('Gagal membaca model: ' + e.message, true); console.error(e); return null; }
    const a = res.auto;
    $('gv-info').textContent = `Roda: ${a.wheelCount} (${a.axles} as) · primitif: ${res.prims.length} · lampu: ${res.lamps.length}` + (res.movers.length ? ` · wiper: ${res.movers.length}` : '') + (a.wheelCount < 2 ? ' — tambahkan roda!' : '');
    if (document.activeElement && document.activeElement.id === 'gv-origin-x') return res;
    if ($('gv-geo-auto').checked) {
      setv('gv-wb', a.wb); setv('gv-front', a.front); setv('gv-rear', a.rear); setv('gv-hw', a.hw); setv('gv-fifth', a.fifth === null ? '' : a.fifth);
      setv('gv-door', clamp(Math.round(a.hw + 10), 14, 45));
    }
    if ($('gv-origin-auto').checked) setv('gv-origin-x', Math.round(a.rearAxleM * 1000) / 1000);
    return res;
  }
  function geoSig() {                                         // tanda cepat bahwa model berubah (dipoll agar ukuran fisik ikut otomatis)
    let h = assemblyGroup.children.length;
    assemblyGroup.traverse((o) => { h += o.position.x * 3 + o.position.y * 5 + o.position.z * 7 + o.scale.x + o.scale.y * 2 + o.scale.z * 3 + o.rotation.y * 11; if (o.userData && o.userData.wheel) h += o.userData.wheel.r * 13 + o.userData.wheel.track * 17; if (o.userData && o.userData.steerable) h += 1; });
    return h.toFixed(4);
  }

  /* ------------------------------------------------------------ muat daftar (katalog aset + kendaraan tersimpan) */
  async function refresh() {
    try {
      const j = await (await fetch('/api/vehicles')).json();
      catalog = j.catalog || []; saved = j.vehicles || [];
      const sel = $('gm-asset'); sel.innerHTML = '';
      const groups = {};
      for (const c of catalog) { (groups[c.group] = groups[c.group] || []).push(c); }
      for (const [g, list] of Object.entries(groups)) {
        const og = document.createElement('optgroup'); og.label = g;
        for (const c of list) { const op = document.createElement('option'); op.value = c.id; op.textContent = `${c.name}  [${c.type}${c.model !== c.type ? '/' + c.model : ''}]`; og.appendChild(op); }
        sel.appendChild(og);
      }
      const sv = $('gm-saved'); sv.innerHTML = '';
      if (!saved.length) { const op = document.createElement('option'); op.value = ''; op.textContent = '(belum ada)'; sv.appendChild(op); }
      for (const v of saved) { const op = document.createElement('option'); op.value = v.id; op.textContent = `${v.name}  [${v.base}] rev ${v.rev}` + (j.parking && j.parking[v.id] ? `  @ ${Math.round(j.parking[v.id][0])},${Math.round(j.parking[v.id][1])}` : ''); sv.appendChild(op); }
      if (editingId) sv.value = editingId;
    } catch (e) { say('Gagal memuat daftar dari server: ' + e.message, true); }
  }

  /* ------------------------------------------------------------ muat aset game ke editor */
  function importAsset() {
    const e = catalog.find((c) => c.id === $('gm-asset').value);
    if (!e) return;
    if (typeof Render3D === 'undefined' || !Render3D.exportModel) { say('render3d.js belum termuat.', true); return; }
    const spec = Object.assign({}, SPECS[e.type], e.over || {}); spec.model = e.model || e.type;
    let model;
    try { model = Render3D.exportModel({ type: e.type, color: e.color, spec }); } catch (err) { say('Gagal membaca aset: ' + err.message, true); console.error(err); return; }
    const parts = Core.importModel(model);
    if (assemblyGroup.children.length && !confirm('Ganti model di editor dengan "' + e.name + '"? (Undo masih bisa)')) return;
    recordState(); restoreState(parts);
    editingId = null;
    const base = BASES.includes(e.type) ? e.type : 'car';              // pesawat/helikopter/dll. dimainkan sebagai kendaraan darat
    const d = BASES.includes(e.type) ? spec : Object.assign({}, SPECS.car, { mass: 1 });
    fillProps({ name: e.name + ' (salinan)', base, color: e.color, vf: d.vf, acc: d.acc, maxSteer: d.maxSteer, tank: d.tank, burn: d.burn, fuelName: d.fuelName, mass: d.mass || 1.5, grip: d.grip ?? 0.4 });
    $('gv-origin-auto').checked = false; setv('gv-origin-x', 0);        // koordinat aset game: titik acuan asli = x 0
    $('gv-geo-auto').checked = true;
    recalc();
    const wheels = model.wheels.length;
    say(`"${e.name}" dimuat: ${parts.length} bagian, ${wheels} roda.` + (wheels < 2 ? ' Aset ini tanpa roda — tambahkan 🛞 Pasang Roda sebelum disimpan.' : ' Edit lalu klik Simpan ke Game.'));
  }
  function newVehicle() {
    if (assemblyGroup.children.length && !confirm('Kosongkan editor untuk kendaraan baru?')) return;
    recordState(); restoreState([]); editingId = null;
    $('gv-origin-auto').checked = true; $('gv-geo-auto').checked = true;
    fillProps(Object.assign({ name: 'Kendaraan Saya', base: 'car' }, baseDefaults('car')));
    recalc(); say('Editor dikosongkan. Tambahkan sasis, kabin, dan minimal 2 as roda.');
  }
  function openSaved() {
    const v = saved.find((x) => x.id === $('gm-saved').value);
    if (!v) return;
    recordState(); restoreState(v.parts || []); editingId = v.id;
    const s = v.spec || {};
    fillProps({ name: v.name, base: v.base, color: v.color, vf: s.vf, acc: s.acc, maxSteerDeg: s.maxSteerDeg, tank: s.tank, burn: s.burn, fuelName: s.fuelName, mass: s.mass, door: s.door, grip: s.grip ?? 0.4 });
    const manual = v.originX !== undefined && v.originX !== null;
    $('gv-origin-auto').checked = !manual; if (manual) setv('gv-origin-x', v.originX);
    $('gv-geo-auto').checked = false;                                   // pakai ukuran fisik yang dulu disimpan
    setv('gv-wb', s.wb); setv('gv-front', s.front); setv('gv-rear', s.rear); setv('gv-hw', s.hw); setv('gv-fifth', s.fifth === undefined ? '' : s.fifth);
    const hasPark = !!v.park; $('gv-park-auto').checked = !hasPark; if (hasPark) { setv('gv-park-x', v.park.x); setv('gv-park-y', v.park.y); setv('gv-park-ang', v.park.angle); }
    recalc(); say(`"${v.name}" dibuka (rev ${v.rev}). Simpan lagi untuk memperbarui di game.`);
  }
  async function deleteSaved() {
    const id = $('gm-saved').value; if (!id) return;
    const v = saved.find((x) => x.id === id);
    if (!confirm('Hapus kendaraan "' + (v ? v.name : id) + '" dari game?')) return;
    const r = await fetch('/api/vehicles/' + encodeURIComponent(id), { method: 'DELETE' });
    if (r.ok) { if (editingId === id) editingId = null; say('Kendaraan dihapus dari game.'); await refresh(); } else say('Gagal menghapus.', true);
  }

  /* ------------------------------------------------------------ simpan ke game */
  async function saveToGame() {
    const res = recalc(); if (!res) return;
    const a = res.auto;
    if (!res.prims.length) { say('Model kosong — tambahkan bodi kendaraan.', true); return; }
    if (a.wheelCount < 2 || a.axles < 2) { say('Butuh minimal 2 as roda (depan & belakang). Pakai 🛞 Pasang Roda / Axle di panel kiri.', true); return; }
    const base = $('gv-base').value, auto = $('gv-geo-auto').checked;
    const spec = {
      vf: Math.round(num('gv-speed', 50) / KMH * 100) / 100, acc: num('gv-acc', 120), maxSteerDeg: num('gv-steer', 34), tank: num('gv-tank', 80), burn: num('gv-burn', 0.02),
      mass: num('gv-mass', 1.5), grip: clamp(num('gv-grip', 0.4), 0.1, 1.5), fuelName: $('gv-fuel').value, door: num('gv-door', 20),
      wb: auto ? a.wb : num('gv-wb', a.wb), front: auto ? a.front : num('gv-front', a.front), rear: auto ? a.rear : num('gv-rear', a.rear), hw: auto ? a.hw : num('gv-hw', a.hw),
    };
    const hasFifthWheel = assemblyGroup.children.some((o) => o.userData && o.userData.partType === 'payloadFifthWheel');
    const hasCrane = assemblyGroup.children.some((o) => o.userData && o.userData.partType === 'payloadCrane');
    spec.canTow = base === 'tractor' || hasFifthWheel;
    spec.canTowVehicle = hasCrane;
    if (hasCrane && a.towPivot) spec.towPivot = a.towPivot;
    if (spec.canTow) {
      const manualFifth = parseFloat($('gv-fifth').value);
      const f = auto ? a.fifth : Number.isFinite(manualFifth) ? manualFifth : a.fifth;
      spec.fifth = Number.isFinite(f) ? f : (SPECS.tractor ? SPECS.tractor.fifth : 4);
    }
    if (!(spec.wb > 0)) { say('Jarak antar roda (wb) harus > 0: pastikan as depan dan belakang berada di posisi X berbeda.', true); return; }
    const vehicle = { id: editingId || 'cv' + Date.now().toString(36), name: $('gv-name').value.trim() || 'Kendaraan CAD', base, color: $('gv-color').value, spec,
      prims: res.prims, movers: res.movers, wheels: res.wheels, lamps: res.lamps, parts: assemblyGroup.children.map(serializeObject), originX: $('gv-origin-auto').checked ? null : num('gv-origin-x', 0) };
    if (!$('gv-park-auto').checked) vehicle.park = { x: num('gv-park-x', 0), y: num('gv-park-y', 0), angle: num('gv-park-ang', 0) };
    say('Menyimpan…');
    let r, j;
    try { r = await fetch('/api/vehicles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vehicle }) }); j = await r.json(); } catch (e) { say('Gagal menghubungi server: ' + e.message, true); return; }
    if (!r.ok) { say('Gagal: ' + (j.error || r.status), true); return; }
    editingId = j.id; await refresh();
    say(`✅ Tersimpan (rev ${j.rev}). Parkir di x ${Math.round(j.park.x)}, y ${Math.round(j.park.y)} (dekat Bengkel Rakit Tingkir). Muat ulang game (F5) lalu naiki dengan tombol Y / F.`);
  }

  /* ------------------------------------------------------------ roda terpilih: ubah radius / lebar / track */
  let wheelSel = null;
  function pollSelection() {
    const sel = (typeof selectedObjects !== 'undefined' && selectedObjects.length === 1) ? selectedObjects[0] : null;
    const isW = sel && sel.userData && sel.userData.isWheel;
    if (isW !== !!wheelSel || sel !== wheelSel) {
      wheelSel = isW ? sel : null;
      $('gv-wheel-box').style.display = wheelSel ? 'block' : 'none';
      if (wheelSel) { const W = wheelSel.userData.wheel || WHEEL_DEFAULT; setv('gv-wr', W.r); setv('gv-ww', W.w); setv('gv-wt', W.track); }
    }
    const sig = geoSig(); if (sig !== lastSig) { lastSig = sig; recalc(); }
  }
  function applyWheel() {
    if (!wheelSel) return;
    const W = { r: clamp(num('gv-wr', 0.6), 0.05, 5), w: clamp(num('gv-ww', 0.4), 0.05, 3), track: clamp(num('gv-wt', 1.1), 0, 10) };
    if (wheelSel.userData.wheel && wheelSel.userData.wheel.single) W.single = true;
    recordState();
    wheelSel.children.slice().forEach((c) => wheelSel.remove(c));
    buildWheelAxle(wheelSel, W); wheelSel.userData.wheel = W;
    if (typeof syncPivot === 'function') syncPivot();
    if (typeof generateBakeCode === 'function') generateBakeCode();
    recalc();
  }

  /* ------------------------------------------------------------ pasang */
  function init() {
    $('gm-load-asset').addEventListener('click', importAsset);
    $('gm-new').addEventListener('click', newVehicle);
    $('gm-load-saved').addEventListener('click', openSaved);
    $('gm-del-saved').addEventListener('click', deleteSaved);
    $('gv-save').addEventListener('click', saveToGame);
    $('gv-recalc').addEventListener('click', () => { recalc(); say('Ukuran fisik dihitung ulang dari model.'); });
    $('gv-wheel-apply').addEventListener('click', applyWheel);
    $('gv-base').addEventListener('change', () => { const d = baseDefaults($('gv-base').value); fillProps(d); say('Nilai bawaan jenis "' + $('gv-base').value + '" dimuat (kecepatan, setir, BBM). Ubah sesuka hati.'); });
    for (const id of ['gv-geo-auto', 'gv-origin-auto']) $(id).addEventListener('change', recalc);
    $('gv-origin-x').addEventListener('change', recalc);
    fillProps(Object.assign({ name: 'Kendaraan Saya', base: 'car' }, baseDefaults('car')));
    refresh(); setInterval(pollSelection, 700);
  }
  window.VehEditorDebug = { collectItems, meshToItem, recalc };     // dipakai tes otomatis
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();