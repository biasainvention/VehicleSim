'use strict';
/* =========================================================================
 * Trailer Yard — logika game di browser. Peta: rute Salatiga → Tengaran.
 *  - Fisika: model sepeda kinematik untuk kendaraan + trailer yang "ditarik"
 *    lewat kingpin di fifth wheel (pull-along constraint).
 *  - Transmisi otomatis P-R-N-D, dipilih dari gamepad (RB/LB atau D-pad).
 *  - Sopir bisa turun & jalan kaki: isi BBM di SPBU, beli jeriken, jajan di
 *    warung/toko, masuk ke dalam bangunan, istirahat di rumah, dan ganti kendaraan.
 *  - Lalu lintas NPC di jalan lingkar (lajur kiri).
 *  - Kamera mengikuti, minimap di pojok kanan bawah.
 *  - Satuan dunia: 10 px = 1 m.
 * ========================================================================= */
const cvs = document.getElementById('game');
const ctx = cvs.getContext('2d');
const mini = document.getElementById('minimap');
const mctx = mini.getContext('2d');
const $ = (id) => document.getElementById(id);

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const isVTOL = (V) => V.type === 'helicopter' || V.type === 'falcon';
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const inRect = (x, y, r) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
const rupiah = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');

const PX_PER_M = 10;
const MISSIONS = 3;
// Spesifikasi kendaraan: lihat static/vehspecs.js (dibagi dengan editor kendaraan). origin = as roda belakang, sumbu x ke depan
const SPECS = window.VEH_SPECS;
// Trailer: origin = kingpin, sumbu x ke arah moncong trailer
const TRAILER = { front: 14, rear: -136, hw: 23, l2: 112, underFront: -32 };
const MAX_HITCH = 85 * DEG;
const COUPLE_DIST = 14, COUPLE_ANG = 20 * DEG;
const CREEP = 9;
const GEARS = ['P', 'R', 'N', 'D'];
const ZOOMS = [560, 780, 1100];
const DEADZONE = 0.12;
const JERRY_L = 10;                  // isi jeriken (liter)
const WALK_V = 30, RUN_V = 90;       // kecepatan jalan / lari (px/s)
// Tampilan 2D / 3D bisa diganti saat main (tahan R3 / tombol T). /3d membuka langsung versi 3D.
let MODE3D = true;                    // game penuh 3D; 2D hanya cadangan bila WebGL2 tidak tersedia
const is3D = () => MODE3D && typeof Render3D !== 'undefined' && Render3D.ready;
function setView3D(on, quiet = false) {
  if (on && typeof Render3D !== 'undefined' && !Render3D.ready) {
    try { Render3D.init(level, render3dState()); }
    catch (err) { console.error(err); showToast('WebGL2 tidak tersedia di browser ini — tetap 2D', 5); on = false; }
  }
  if (on && typeof Render3D === 'undefined') on = false;
  MODE3D = on;
  if (level && vehicles.length) resyncTrailers();
  if (on && typeof Render3D !== 'undefined' && Render3D.snap) Render3D.snap();
  if (!on && (state === 'play' || state === 'paused') && P.mode !== 'inside') { const f = camFocus(); cam.x = f.x; cam.y = f.y; }
  document.body.classList.toggle('mode3d', on); document.body.classList.toggle('mode2d', !on);
  if (!quiet) showToast(on ? 'Tampilan 3D — stik kanan memutar kamera' : 'WebGL2 tidak tersedia — tampilan 2D', 2.2);
}

/* ----------------------------- Jam game: siang & malam ------------------- */
const HOUR_SEC = 60;                 // 1 jam di game = 60 detik nyata (1 hari = 12 menit)
let clock = 7;                       // jam game 0..24
function nightAmt(h = clock) {       // 0 = siang penuh, 1 = malam penuh
  if (h >= 6.5 && h <= 17.5) return 0;
  if (h >= 19 || h <= 5) return 1;
  return h < 12 ? 1 - (h - 5) / 1.5 : (h - 17.5) / 1.5;
}
const fmtClock = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}.${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const SCHOOL_HOURS = [6.5, 14];      // jam sekolah: zona sekolah wajib pelan

let SETTINGS = {};                    // settings.json dari server: channel TV, jalan paver, dan suspensi
const SUSPENSION_DEFAULTS = { stiffness: 15, damping: 1.2, travelCm: 60, pitchLimitDeg: 7, rollLimitDeg: 13 };
let suspensionSettings = { ...SUSPENSION_DEFAULTS };
const suspensionSettingsChannel = typeof BroadcastChannel === 'function'
  ? new BroadcastChannel('game_suspension_settings_channel') : null;
function applySuspensionSettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  const bounds = {
    stiffness: [4, 25], damping: [0.3, 2], travelCm: [0, 100],
    pitchLimitDeg: [1, 25], rollLimitDeg: [1, 30]
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = Number(settings[key]);
    if (Number.isFinite(value)) suspensionSettings[key] = clamp(value, min, max);
  }
}
if (suspensionSettingsChannel) {
  suspensionSettingsChannel.onmessage = ({ data }) => {
    if (data && data.type === 'suspension-settings') applySuspensionSettings(data.settings);
  };
}
let level = null, mapBg = null, OBS = [], W = 3000, H = 8400, PAT = {}, MAIN = null, ROADLABELS = [];
let state = 'loading';               // loading | menu | play | paused | done
let playerName = 'Pemain';
let vehicles = [], npcs = [], actors = [], trailers = [], mission, missionIdx, usedZones, results, damage, elapsed;
let hitCd = 0, jackCd = 0, nextMissionT = 0, bannerT = 0, toastT = 0, hudT = 0, beepT = 0;
let finalScore = 0;
let schoolWarnT = 0;
let DISPLAY = [];                    // mobil pajangan dealer (hanya hiasan)
// mode: walk (jalan kaki) | drive (menyetir) | inside (di dalam rumah; x,y = posisi pintu di luar, ix,iy = posisi di dalam)
const P = { mode: 'walk', veh: null, x: 0, y: 0, ang: 0, walkT: 0, carrying: 0, energy: 70, money: 0, run: false, busy: '',
  house: null, ix: 0, iy: 0, resting: null, bahan: 4, dish: 0, cook: 0, cooking: false };
const cam = { x: 0, y: 0, zoom: 1, scale: 1, view3d: 'chase', orbit: 0, tilt: 0, zf: 1, idleT: 0, shake: 0 };
const fade = { a: 0, dir: 0, fn: null };   // layar menghitam sebentar saat masuk / keluar rumah
let dpr = 1;

/* ----------------------------- Geometri ---------------------------------- */
function rectPoly(ox, oy, ang, x0, x1, hw) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [[x0, -hw], [x1, -hw], [x1, hw], [x0, hw]].map(([lx, ly]) => [ox + lx * c - ly * s, oy + lx * s + ly * c]);
}
function overlap(a, b) { // Separating Axis Theorem untuk poligon cembung
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const nx = q[1] - p[1], ny = p[0] - q[0];
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const v of a) { const d = v[0] * nx + v[1] * ny; if (d < amin) amin = d; if (d > amax) amax = d; }
      for (const v of b) { const d = v[0] * nx + v[1] * ny; if (d < bmin) bmin = d; if (d > bmax) bmax = d; }
      if (amax < bmin || bmax < amin) return false;
    }
  }
  return true;
}
const inBounds = (poly) => poly.every(([x, y]) => x >= 0 && y >= 0 && x <= W && y <= H);
const vehPoly = (v) => rectPoly(v.x, v.y, v.ang, v.spec.rear, v.spec.front, v.spec.hw);
const trailerPoly = (tr, under = false) =>
  rectPoly(tr.x, tr.y, tr.ang, TRAILER.rear, under ? TRAILER.underFront : TRAILER.front, TRAILER.hw);
const walkerPoly = (x = P.x, y = P.y, r = 6) => rectPoly(x, y, 0, -r, r, r);
const fifthWheel = (v) => {
  const s = (v && v.spec) || {};
  const hitchX = s.fifth ?? (s.canTowVehicle ? (s.rear || -15) - 8 : 0);
  return [v.x + Math.cos(v.ang) * hitchX, v.y + Math.sin(v.ang) * hitchX];
};
const towVehiclePoint = (v) => {
  const s = (v && v.spec) || {};
  const p = s.towPivot;
  return Array.isArray(p) && p.length >= 2 ? local2world(v, p[0], p[1]) : fifthWheel(v);
};
const vehMid = (v) => { const m = (v.spec.front + v.spec.rear) / 2; return [v.x + Math.cos(v.ang) * m, v.y + Math.sin(v.ang) * m]; };
const local2world = (v, lx, ly) => [v.x + lx * Math.cos(v.ang) - ly * Math.sin(v.ang), v.y + lx * Math.sin(v.ang) + ly * Math.cos(v.ang)];


const telemetryChannel = typeof BroadcastChannel === 'function'
  ? new BroadcastChannel('game_telemetry_channel') : null;
let telemetrySequence = 0, telemetryPrevious = null, telemetryActive = false;
const TELEMETRY_G = 9.80665;
function publishTelemetry(V, inp, dt) {
  if (!telemetryChannel) return;
  const timestampMs = performance.now();
  if (!V) {
    if (telemetryActive) telemetryChannel.postMessage({
      schemaVersion: 2, sequence: ++telemetrySequence, timestampMs, timestampUnixMs: Date.now(),
      active: false, reason: 'vehicle_exit'
    });
    telemetryActive = false;
    telemetryPrevious = null;
    return;
  }

  const angle = V.ang || 0, lateralPx = isVTOL(V) && V.airborne ? V.lateralV || 0 : 0;
  const groundHeight = bridgeGroundHeight(V.x, V.y, angle) + roadSurfaceHeightAt(V.x, V.y);
  const position = { x: V.x / PX_PER_M, y: V.y / PX_PER_M, z: (groundHeight + (V.alt || 0)) / PX_PER_M };
  const sampleDt = telemetryPrevious ? (timestampMs - telemetryPrevious.timestampMs) / 1000 : 0;
  const validDt = sampleDt > 0 && sampleDt <= 0.5 ? sampleDt : dt;
  const velocity = {
    x: (V.v * Math.cos(angle) - lateralPx * Math.sin(angle)) / PX_PER_M,
    y: (V.v * Math.sin(angle) + lateralPx * Math.cos(angle)) / PX_PER_M,
    z: telemetryPrevious && validDt > 0 ? (position.z - telemetryPrevious.position.z) / validDt : 0
  };
  const pitchCommand = V.type === 'plane' ? V.pitch || 0 : 0;
  const hw = Math.max(2, V.spec.hw * 0.75), front = Math.max(2, V.spec.front * 0.8), rear = Math.min(-2, V.spec.rear * 0.8);
  const sampleGround = (x, y) => {
    const wx = V.x + Math.cos(angle) * x - Math.sin(angle) * y;
    const wy = V.y + Math.sin(angle) * x + Math.cos(angle) * y;
    return bridgeGroundHeight(wx, wy, angle) + roadSurfaceHeightAt(wx, wy);
  };
  const frontLeft = sampleGround(front, -hw), frontRight = sampleGround(front, hw);
  const rearLeft = sampleGround(rear, -hw), rearRight = sampleGround(rear, hw);
  const terrainPitch = Math.atan2((frontLeft + frontRight - rearLeft - rearRight) / 2, front - rear);
  const terrainRoll = Math.atan2((frontLeft + rearLeft - frontRight - rearRight) / 2, hw * 2);
  const airborne = !!V.airborne;
  const pitchRad = airborne && V.type === 'plane'
    ? clamp(Math.atan2(pitchCommand * V.spec.climbRate, Math.max(Math.abs(V.v), 1)), -25 * DEG, 25 * DEG)
    : airborne && isVTOL(V) ? 0 : terrainPitch + (V.suspensionPitch || 0);
  const rollRad = airborne && (V.type === 'plane' || isVTOL(V))
    ? V.bank || 0 : terrainRoll + (V.suspensionRoll || 0);
  const pitchSource = airborne && V.type === 'plane' ? 'estimated_from_command'
    : airborne && isVTOL(V) ? 'not_simulated' : 'terrain_and_suspension';
  const rollSource = airborne && (V.type === 'plane' || isVTOL(V))
    ? 'bank' : 'terrain_and_suspension';
  const orientation = { rollRad, pitchCommand, pitchRad, yawRad: angle };
  const acceleration = telemetryPrevious && validDt > 0 ? {
    x: (velocity.x - telemetryPrevious.velocity.x) / validDt,
    y: (velocity.y - telemetryPrevious.velocity.y) / validDt,
    z: (velocity.z - telemetryPrevious.velocity.z) / validDt
  } : { x: 0, y: 0, z: 0 };
  const yawRate = telemetryPrevious && validDt > 0 ? wrap(angle - telemetryPrevious.orientation.yawRad) / validDt : 0;
  const rollRate = telemetryPrevious && validDt > 0 ? (orientation.rollRad - telemetryPrevious.orientation.rollRad) / validDt : 0;
  const pitchRate = telemetryPrevious && validDt > 0 ? (orientation.pitchRad - telemetryPrevious.orientation.pitchRad) / validDt : 0;
  const pitchCommandRate = telemetryPrevious && validDt > 0 ? (orientation.pitchCommand - telemetryPrevious.orientation.pitchCommand) / validDt : 0;
  const angularVelocity = { rollRadPerSec: rollRate, pitchRadPerSec: pitchRate, pitchCommandPerSec: pitchCommandRate, yawRadPerSec: yawRate };
  const angularAcceleration = telemetryPrevious && validDt > 0 ? {
    rollRadPerSec2: (rollRate - telemetryPrevious.angularVelocity.rollRadPerSec) / validDt,
    pitchRadPerSec2: (pitchRate - telemetryPrevious.angularVelocity.pitchRadPerSec) / validDt,
    pitchCommandPerSec2: (pitchCommandRate - telemetryPrevious.angularVelocity.pitchCommandPerSec) / validDt,
    yawRadPerSec2: (yawRate - telemetryPrevious.angularVelocity.yawRadPerSec) / validDt
  } : { rollRadPerSec2: 0, pitchRadPerSec2: 0, pitchCommandPerSec2: 0, yawRadPerSec2: 0 };
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const longitudinalAccel = acceleration.x * cos + acceleration.y * sin;
  const lateralAccel = -acceleration.x * sin + acceleration.y * cos;
  const gForce = {
    longitudinal: longitudinalAccel / TELEMETRY_G,
    lateral: lateralAccel / TELEMETRY_G,
    vertical: 1 + acceleration.z / TELEMETRY_G
  };
  const packet = {
    schemaVersion: 2,
    sequence: ++telemetrySequence,
    timestampMs,
    timestampUnixMs: Date.now(),
    active: true,
    frameDt: dt,
    vehicle: {
      id: V.id, name: V.name, type: V.type, gear: V.gear, fuel: V.fuel,
      fuelCapacity: V.spec.tank, health: hpOf(V), wheelbaseM: V.spec.wb / PX_PER_M,
      maxSteeringAngleRad: V.spec.maxSteer, maxForwardSpeedMps: V.spec.vf / PX_PER_M,
      maxReverseSpeedMps: V.spec.vr / PX_PER_M
    },
    position: { ...position, groundElevation: groundHeight / PX_PER_M, altitude: (V.alt || 0) / PX_PER_M },
    velocity: {
      ...velocity,
      forward: V.v / PX_PER_M,
      lateral: lateralPx / PX_PER_M,
      speedKmh: Math.hypot(velocity.x, velocity.y, velocity.z) * 3.6
    },
    acceleration,
    orientation,
    attitude: {
      pitchRad, rollRad, yawRad: angle,
      pitchDeg: pitchRad / DEG, rollDeg: rollRad / DEG, yawDeg: (angle / DEG % 360 + 360) % 360,
      pitchSource, rollSource, yawSource: 'vehicle_heading',
      reference: airborne ? 'airborne' : 'ground'
    },
    angularVelocity,
    angularAcceleration,
    suspension: {
      pitchRad: V.suspensionPitch || 0,
      pitchRateRadPerSec: V.suspensionPitchRate || 0,
      rollRad: V.suspensionRoll || 0,
      rollRateRadPerSec: V.suspensionRollRate || 0
    },
    gForce: { ...gForce, resultant: Math.hypot(gForce.longitudinal, gForce.lateral, gForce.vertical) },
    controls: {
      throttle: inp.thr, brake: inp.brk, handbrake: inp.hand ? 1 : 0,
      steering: inp.steer, steeringAngleRad: V.steer || 0, lift: (inp.liftUp ? 1 : 0) - (inp.liftDown ? 1 : 0),
      pitch: (inp.pitchUp ? 1 : 0) - (inp.pitchDown ? 1 : 0),
      yaw: (inp.heliRotRight ? 1 : 0) - (inp.heliRotLeft ? 1 : 0)
    },
    airborne: !!V.airborne,
    units: {
      position: 'm', velocity: 'm/s', acceleration: 'm/s^2', angles: 'rad',
      angularVelocity: 'rad/s; pitch command 1/s',
      angularAcceleration: 'rad/s^2; pitch command 1/s^2',
      suspension: 'rad; rate rad/s',
      pitchCommand: 'normalized [-1, 1]', gForce: 'g', fuel: 'L', steering: 'normalized [-1, 1]'
    },
    x: V.x, y: V.y, alt: V.alt || 0, v: V.v, ang: angle, steer: V.steer || 0, bank: V.bank || 0,
    gforce: Math.hypot(gForce.longitudinal, gForce.lateral, gForce.vertical),
    legacy: {
      x: V.x, y: V.y, alt: V.alt || 0, v: V.v, ang: angle, steer: V.steer || 0,
      bank: V.bank || 0, airborne: !!V.airborne
    }
  };
  telemetryChannel.postMessage(packet);
  telemetryPrevious = { timestampMs, position, velocity, orientation, angularVelocity };
  telemetryActive = true;
}



function zoneFit(tr, z) {
  const za = z.angle * DEG, c = Math.cos(-za), s = Math.sin(-za);
  const inside = trailerPoly(tr).every(([x, y]) => {
    const dx = x - z.x, dy = y - z.y;
    return Math.abs(dx * c - dy * s) <= z.w / 2 && Math.abs(dx * s + dy * c) <= z.h / 2;
  });
  const mid = (TRAILER.front + TRAILER.rear) / 2;
  const cx = tr.x + Math.cos(tr.ang) * mid, cy = tr.y + Math.sin(tr.ang) * mid;
  return { inside, offset: Math.hypot(cx - z.x, cy - z.y), angErr: Math.abs(wrap(tr.ang - za)) };
}

function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / L, 0, 1) : 0;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
function polyDist(px, py, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(px, py, pts[i], pts[i + 1]));
  return d;
}
function onPaved(x, y, builtToo = true) {
  for (const p of level.pads) if (inRect(x, y, p)) return true;
  for (const r of level.roads) if (inRect(x, y, r.bb) && polyDist(x, y, r.pts) <= r.w / 2) return true;
  return builtToo && onBuilt(x, y);
}
// tinggi tanah (px) dari grid kontur level (wilayah Kopeng); 0 di luar grid
function TH(x, y) {
  const T = level && level.terrain; if (!T) return 0;
  const fx = (x - T.x0) / T.cell, fy = (y - T.y0) / T.cell;
  if (fx < 0 || fy < 0 || fx > T.nx - 1 || fy > T.ny - 1) return 0;
  const n = T.nx, i = Math.min(n - 2, Math.floor(fx)), j = Math.min(T.ny - 2, Math.floor(fy)), tx = fx - i, ty = fy - j, h = T.h;
  return (h[j * n + i] * (1 - tx) + h[j * n + i + 1] * tx) * (1 - ty) + (h[(j + 1) * n + i] * (1 - tx) + h[(j + 1) * n + i + 1] * tx) * ty;
}
function bridgeGroundHeight(x, y, heading, fallback = TH(x, y)) {
  let height = fallback;
  for (const bridge of (level && level.bridges) || []) {
    const dx = x - bridge.x, dy = y - bridge.y, co = Math.cos(bridge.angle), si = Math.sin(bridge.angle);
    if (Math.abs(dx * co + dy * si) > bridge.length / 2 || Math.abs(-dx * si + dy * co) > bridge.width / 2) continue;
    if (heading != null) {
      const upperAlignment = Math.abs(Math.cos(heading - bridge.angle));
      const lowerAlignment = Math.abs(Math.cos(heading - bridge.lowerAngle));
      if (upperAlignment < 0.65 || upperAlignment <= lowerAlignment + 0.05) continue;
    }
    height = Math.max(height, bridge.upperZ + 1.8);
  }
  return height;
}
const ROAD_BUMP_CELL = 120;
let roadBumpGrid = new Map();
function buildRoadBumps(roads) {
  const bumps = [];
  for (const road of roads) {
    if (road.kind !== 'local' && road.kind !== 'estate') continue;
    const total = road.pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - road.pts[i][0], p[1] - road.pts[i][1]), 0);
    if (total < 500) continue;
    let traveled = 0, next = 180;
    for (let i = 0; i < road.pts.length - 1; i++) {
      const a = road.pts[i], b = road.pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (!length) continue;
      while (next < total - 140 && next <= traveled + length) {
        const t = (next - traveled) / length;
        bumps.push({
          x: a[0] + dx * t, y: a[1] + dy * t, angle: Math.atan2(dy, dx),
          width: road.w * 0.78, halfLength: 18,
          height: 2.2 + ((bumps.length * 17 + road.pts.length * 13) % 12) / 10,
          roadKind: road.kind
        });
        next += 460;
      }
      traveled += length;
    }
  }

  roadBumpGrid = new Map();
  for (const bump of bumps) {
    const radius = bump.width / 2 + bump.halfLength;
    for (let gx = Math.floor((bump.x - radius) / ROAD_BUMP_CELL); gx <= Math.floor((bump.x + radius) / ROAD_BUMP_CELL); gx++) {
      for (let gy = Math.floor((bump.y - radius) / ROAD_BUMP_CELL); gy <= Math.floor((bump.y + radius) / ROAD_BUMP_CELL); gy++) {
        const key = `${gx},${gy}`;
        if (!roadBumpGrid.has(key)) roadBumpGrid.set(key, []);
        roadBumpGrid.get(key).push(bump);
      }
    }
  }
  return bumps;
}
function roadSurfaceHeightAt(x, y) {
  let height = 0;
  const gx = Math.floor(x / ROAD_BUMP_CELL), gy = Math.floor(y / ROAD_BUMP_CELL);
  for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
    for (const bump of roadBumpGrid.get(`${ix},${iy}`) || []) {
      const dx = x - bump.x, dy = y - bump.y, co = Math.cos(bump.angle), si = Math.sin(bump.angle);
      const along = dx * co + dy * si, across = -dx * si + dy * co;
      if (Math.abs(along) >= bump.halfLength || Math.abs(across) >= bump.width / 2) continue;
      height = Math.max(height, bump.height * (0.5 + 0.5 * Math.cos(Math.PI * along / bump.halfLength)));
    }
  }
  return height;
}
function roadBumpAttitude(V) {
  const angle = V.ang || 0, co = Math.cos(angle), si = Math.sin(angle);
  const hw = Math.max(2, V.spec.hw * 0.75), front = Math.max(2, V.spec.front * 0.8), rear = Math.min(-2, V.spec.rear * 0.8);
  const sample = (x, y) => roadSurfaceHeightAt(V.x + co * x - si * y, V.y + si * x + co * y);
  const frontLeft = sample(front, -hw), frontRight = sample(front, hw);
  const rearLeft = sample(rear, -hw), rearRight = sample(rear, hw);
  return {
    pitch: Math.atan2((frontLeft + frontRight - rearLeft - rearRight) / 2, front - rear),
    roll: Math.atan2((frontLeft + rearLeft - frontRight - rearRight) / 2, hw * 2)
  };
}
/* ----- jalan aspal buatan pemain (paver), disimpan di settings.json lewat server ----- */
const BUILT = { roads: [], cur: null, ver: 0, grid: new Map() };
const BCELL = 120;
function builtIndex(r) {
  for (let i = 0; i < r.pts.length - 1; i++) {
    const [ax, ay] = r.pts[i], [bx, by] = r.pts[i + 1], m = r.w / 2;
    for (let gx = Math.floor((Math.min(ax, bx) - m) / BCELL); gx <= Math.floor((Math.max(ax, bx) + m) / BCELL); gx++)
      for (let gy = Math.floor((Math.min(ay, by) - m) / BCELL); gy <= Math.floor((Math.max(ay, by) + m) / BCELL); gy++) {
        const k = gx + ',' + gy; if (!BUILT.grid.has(k)) BUILT.grid.set(k, []); BUILT.grid.get(k).push([r, i]);
      }
  }
}
function onBuilt(x, y, shrink = 0) {
  const list = BUILT.grid.get(Math.floor(x / BCELL) + ',' + Math.floor(y / BCELL));
  if (!list) return false;
  for (const [r, i] of list) if (polyDist(x, y, [r.pts[i], r.pts[i + 1]]) <= r.w / 2 - shrink) return true;
  return false;
}
function setBuiltRoads(list) {
  BUILT.roads = []; BUILT.grid = new Map();
  for (const r of list || []) if (r && Array.isArray(r.pts) && r.pts.length > 1) { const rr = { pts: r.pts, w: r.w || 70, by: r.by, at: r.at }; BUILT.roads.push(rr); builtIndex(rr); }
  BUILT.ver++;
}
function polyBB(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
}
function hitsObstacles(poly) {
  const b = polyBB(poly);
  for (const O of OBS) {
    if (O.x1 < b.x0 || O.x0 > b.x1 || O.y1 < b.y0 || O.y0 > b.y1) continue;
    if (overlap(poly, O.poly)) return true;
  }
  return false;
}
function mainX(y) {               // x tengah jalan utama pada ketinggian y
  const pts = MAIN.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    if (y >= y0 && y <= y1) return x0 + (x1 - x0) * ((y - y0) / ((y1 - y0) || 1));
  }
  return pts[pts.length - 1][0];
}
function regionAt(x, y) {
  const r = level.regions.find((g) => y >= g.y0 && y < g.y1 && (g.x0 == null || (x >= g.x0 && x < g.x1)));
  return (r || level.regions[level.regions.length - 1]).name;
}
function roadNameAt(x, y) {
  let best = null, bd = Infinity;
  for (const r of level.roads) {
    if (!inRect(x, y, { x: r.bb.x - 80, y: r.bb.y - 80, w: r.bb.w + 160, h: r.bb.h + 160 })) continue;
    const d = polyDist(x, y, r.pts) - r.w / 2;
    if (d < bd) { bd = d; best = r; }
  }
  if (!best || bd > 60) return null;
  if (best.sections) return (best.sections.find((s) => y >= s.y0 && y < s.y1) || best).name;
  return best.name;
}

/* ----------------------------- Input ------------------------------------- */
const keys = {};
const keyPressed = new Set();
const physicalKeys = new Set();
const mouseHeld = new Map();
const GAME_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ShiftLeft', 'ShiftRight', 'KeyP', 'KeyR', 'KeyL', 'KeyQ', 'KeyE', 'KeyH', 'KeyZ', 'KeyF', 'KeyM', 'KeyN', 'KeyV', 'KeyT', 'KeyJ', 'KeyK', 'KeyI', 'KeyO', 'KeyB', 'KeyU', 'KeyC', 'Escape', 'Enter'];
addEventListener('keydown', (e) => {
  audio();
  if (document.activeElement === $('nameInput') && e.code !== 'Enter') return;
  if (document.activeElement === $('taxiDestination') && ['ArrowUp', 'ArrowDown', 'Enter'].includes(e.code)) return;
  physicalKeys.add(e.code);
  keys[e.code] = true;
  if (!e.repeat) keyPressed.add(e.code);
  if (GAME_KEYS.includes(e.code)) e.preventDefault();
});
const mouseHasKey = (code) => [...mouseHeld.values()].some((entry) => entry.codes.includes(code));
function releaseMousePointer(id) {
  const entry = mouseHeld.get(id);
  if (!entry) return;
  mouseHeld.delete(id);
  for (const code of entry.codes) keys[code] = physicalKeys.has(code) || mouseHasKey(code);
  entry.button.classList.toggle('active', [...mouseHeld.values()].some((held) => held.button === entry.button));
}
addEventListener('keyup', (e) => {
  physicalKeys.delete(e.code);
  keys[e.code] = mouseHasKey(e.code);
});
addEventListener('blur', () => {
  physicalKeys.clear();
  mouseHeld.clear();
  keyPressed.clear();
  for (const k in keys) keys[k] = false;
  document.querySelectorAll('#mouseControls [data-keys].active').forEach((el) => el.classList.remove('active'));
});
addEventListener('pointerdown', () => audio());

let padPrev = {};
let activePad = null;
const r3State = { down: false, t0: 0, fired: false };
// geser mouse (tombol kiri ditahan) di layar game = putar kamera 3D
const mouseCam = { dx: 0, dy: 0, drag: false };
addEventListener('pointerdown', (e) => { if (e.target && (e.target.id === 'game' || e.target.id === 'game3d' || e.target.id === 'stage')) mouseCam.drag = true; });
addEventListener('pointerup', () => { mouseCam.drag = false; });
addEventListener('pointermove', (e) => { if (mouseCam.drag) { mouseCam.dx += e.movementX * 0.25; mouseCam.dy += e.movementY * 0.25; } });
const dz = (v) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
const btnVal = (b) => (b ? (typeof b === 'object' ? b.value : b) : 0);
const isDown = (b) => !!(b && (typeof b === 'object' ? b.pressed : b > 0.5));

$('mouseControlToggle').addEventListener('click', () => {
  const open = $('mouseControls').classList.toggle('hidden') === false;
  $('mouseControlToggle').setAttribute('aria-expanded', String(open));
});
$('mouseControlClose').addEventListener('click', () => {
  $('mouseControls').classList.add('hidden');
  $('mouseControlToggle').setAttribute('aria-expanded', 'false');
});
$('mouseControls').addEventListener('pointerdown', (e) => {
  const button = e.target.closest('[data-keys]');
  if (!button || e.button !== 0) return;
  e.preventDefault();
  audio();
  const codes = button.dataset.keys.split(',').filter(Boolean);
  mouseHeld.set(e.pointerId, { button, codes });
  button.classList.add('active');
  for (const code of codes) {
    keys[code] = true;
    keyPressed.add(code);
  }
  button.setPointerCapture(e.pointerId);
});
const releaseMouseControl = (e) => releaseMousePointer(e.pointerId);
document.addEventListener('pointerup', releaseMouseControl);
document.addEventListener('pointercancel', releaseMouseControl);

function readInput() {
  let steer = 0, thr = 0, brk = 0, hand = false, horn = false, mx = 0, my = 0, run = false, aHeld = false, camX = 0, camY = 0;
  let pitchUp = !!keys.KeyQ, pitchDown = !!keys.KeyE;
  let liftUp = !!keys.KeyQ, liftDown = !!keys.KeyE;
  
  // Tambahan untuk rotasi helikopter (Yaw) menggunakan D-Pad / Tombol Kiri-Kanan khusus
  let heliRotLeft = !!keys.KeyA || !!keys.ArrowLeft;   // Contoh: Tombol A / Panah Kiri untuk putar kiri
  let heliRotRight = !!keys.KeyD || !!keys.ArrowRight; // Contoh: Tombol D / Panah Kanan untuk putar kanan

  let toggle3d = false;
  const kl = keys.ArrowLeft || keys.KeyA, kr = keys.ArrowRight || keys.KeyD;
  const ku = keys.ArrowUp || keys.KeyW, kd = keys.ArrowDown || keys.KeyS;
  
  if (kl) { steer -= 1; mx -= 1; }
  if (kr) { steer += 1; mx += 1; }
  if (ku) { thr = 1; my -= 1; }
  if (kd) { brk = 1; my += 1; }
  if (keys.ShiftLeft || keys.ShiftRight) { hand = true; run = true; }
  if (keys.KeyH) horn = true;
  if (keys.Space) aHeld = true;

  const btn = { a: false, b: false, x: false, y: false, start: false, back: false, up: false, down: false, zoom: false };
  activePad = null;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) if (p && p.connected) { activePad = p; break; }
  if (activePad) {
    const p = activePad, b = p.buttons, ax = p.axes;
    const sx = dz(ax[0] || 0), sy = dz(ax[1] || 0);
    if (sx) { steer = sx; mx = sx; }
    if (sy) my = sy;
    let rt = btnVal(b[7]), lt = btnVal(b[6]);
    if (p.mapping !== 'standard' && ax.length >= 6 && rt === 0 && lt === 0) {
      if (ax[5] > -0.99 && ax[5] !== 0) rt = (ax[5] + 1) / 2;
      if (ax[2] > -0.99 && ax[2] !== 0) lt = (ax[2] + 1) / 2;
    }
    const std = p.mapping === 'standard' || ax.length < 5;
    camX = dz(ax[std ? 2 : 3] || 0); camY = dz(ax[std ? 3 : 4] || 0);
    thr = Math.max(thr, rt < 0.04 ? 0 : rt);
    brk = Math.max(brk, lt < 0.04 ? 0 : lt);
    if (rt > 0.3) run = true;
    
    // Pemetaan D-Pad Gamepad (Tombol 14 = Kiri, 15 = Kanan) untuk Rotasi Helikopter
    if (isDown(b[14])) { steer = -1; mx = -1; heliRotLeft = true; }
    if (isDown(b[15])) { steer = 1; mx = 1; heliRotRight = true; }

    if (isDown(b[12])) my = -1;
    if (isDown(b[13])) my = 1;
    pitchUp ||= isDown(b[12]);
    pitchDown ||= isDown(b[13]);
    liftUp ||= isDown(b[12]);
    liftDown ||= isDown(b[13]);
    if (isDown(b[1])) { hand = true; run = true; }       // B
    if (isDown(b[2]) || isDown(b[10])) horn = true;      // X atau L3
    if (isDown(b[0])) aHeld = true;
    const cur = {
      a: isDown(b[0]), b: isDown(b[1]), x: isDown(b[2]), y: isDown(b[3]), start: isDown(b[9]), back: isDown(b[8]),
      up: isDown(b[4]) || isDown(b[12]),     
      down: isDown(b[5]) || isDown(b[13]),   
      gearUp: isDown(b[4]), gearDown: isDown(b[5]),
    };
    for (const k in cur) btn[k] = cur[k] && !padPrev[k];
    if (btn.x && P.mode === 'drive' && P.veh && Render3D.wiperCount && Render3D.wiperCount(P.veh)) wiperRequest = true;
    padPrev = cur;
    const r3 = isDown(b[11]), tnow = performance.now();
    if (r3 && !r3State.down) { r3State.down = true; r3State.t0 = tnow; r3State.fired = false; }
    if (r3 && !r3State.fired && tnow - r3State.t0 > 500) { r3State.fired = true; toggle3d = true; }
    if (!r3 && r3State.down) { r3State.down = false; if (!r3State.fired) btn.zoom = true; }
  }
  btn.a = btn.a || keyPressed.has('Space') || keyPressed.has('Enter');
  btn.x = btn.x || keyPressed.has('KeyH') || (state === 'menu' && keyPressed.has('KeyN'));
  btn.y = btn.y || keyPressed.has('KeyF');
  btn.b = btn.b || keyPressed.has('KeyB');
  btn.back = btn.back || keyPressed.has('KeyM');
  const board = keyPressed.has('KeyL');
  btn.start = btn.start || keyPressed.has('KeyP') || keyPressed.has('Escape');
  btn.up = btn.up || keyPressed.has('KeyQ');
  btn.down = btn.down || keyPressed.has('KeyE');
  btn.zoom = btn.zoom || keyPressed.has('KeyZ');
  const reset = keyPressed.has('KeyR');
  const navX = (keyPressed.has('ArrowRight') || keyPressed.has('KeyD') ? 1 : 0) - (keyPressed.has('ArrowLeft') || keyPressed.has('KeyA') ? 1 : 0);
  const navY = (keyPressed.has('ArrowDown') || keyPressed.has('KeyS') ? 1 : 0) - (keyPressed.has('ArrowUp') || keyPressed.has('KeyW') ? 1 : 0);
  const view = keyPressed.has('KeyV');
  const callFuel = keyPressed.has('KeyG');
  const orderFood = keyPressed.has('KeyU');
  const taxiAction = keyPressed.has('KeyC');
  let num = 0; for (let k = 1; k <= 6; k++) if (keyPressed.has('Digit' + k) || keyPressed.has('Numpad' + k)) num = k;
  if (keyPressed.has('KeyT')) toggle3d = true;
  if (keys.KeyJ) camX = -1;
  if (keys.KeyK) camX = 1;
  if (keys.KeyI) camY = -1;
  if (keys.KeyO) camY = 1;
  camX += mouseCam.dx; camY += mouseCam.dy; mouseCam.dx = 0; mouseCam.dy = 0;
  if (keyPressed.has('KeyX')) wiperRequest = true;          // X: wiper kaca depan
  keyPressed.clear();
  const m = Math.hypot(mx, my); if (m > 1) { mx /= m; my /= m; }
  
  // Return menyertakan status rotasi helikopter
  return { 
    steer: clamp(steer, -1, 1), thr, brk, hand, horn, mx, my, run, aHeld, 
    pitchUp, pitchDown, liftUp, liftDown, 
    heliRotLeft, heliRotRight, // <-- Ditambahkan di sini
    reset, board, view, camX, camY, toggle3d, navX, navY, num, callFuel, orderFood, taxiAction, ...btn 
  };
}

function rumble(strength, ms) {
  const act = activePad && activePad.vibrationActuator;
  if (act && act.playEffect) {
    act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.6 })
      .catch(() => {});
  }
}

/* ----------------------------- Audio ------------------------------------- */
let actx = null, hornNode = null, vehicleSound = null;
function audio() {
  if (!actx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try { actx = new C(); } catch { return null; }
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
function setHorn(on, car = false) {
  if (on === !!hornNode) return;
  const a = audio(); if (!a) return;
  const t = a.currentTime;
  if (on) {   // klakson truk: 3 nada rendah; mobil: 2 nada lebih tinggi
    const g = a.createGain(), f = a.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = car ? 2500 : 1500;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(car ? 0.10 : 0.16, t + 0.03);
    f.connect(g); g.connect(a.destination);
    const os = (car ? [415, 523] : [185, 233, 277]).map((fr) => {
      const o = a.createOscillator(); o.type = car ? 'square' : 'sawtooth'; o.frequency.value = fr; o.connect(f); o.start(); return o;
    });
    hornNode = { g, os };
  } else {
    const { g, os } = hornNode;
    g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + 0.06);
    os.forEach((o) => o.stop(t + 0.08));
    hornNode = null;
  }
}

function createVehicleSound() {
  const a = actx;
  if (!a || a.state !== 'running') return null;
  const engineFilter = a.createBiquadFilter(), engineGain = a.createGain();
  engineFilter.type = 'lowpass'; engineFilter.frequency.value = 500;
  engineGain.gain.value = 0;
  engineFilter.connect(engineGain); engineGain.connect(a.destination);
  const engine = [1, 2].map((harmonic) => {
    const oscillator = a.createOscillator(), gain = a.createGain();
    oscillator.type = 'sawtooth'; oscillator.frequency.value = 40 * harmonic;
    gain.gain.value = harmonic === 1 ? 0.65 : 0.16;
    oscillator.connect(gain); gain.connect(engineFilter); oscillator.start();
    return oscillator;
  });

  const noise = a.createBuffer(1, a.sampleRate, a.sampleRate), samples = noise.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  const motorSource = a.createBufferSource(), motorFilter = a.createBiquadFilter(), motorGain = a.createGain();
  motorSource.buffer = noise; motorSource.loop = true;
  motorFilter.type = 'lowpass'; motorFilter.frequency.value = 360;
  motorGain.gain.value = 0;
  motorSource.connect(motorFilter); motorFilter.connect(motorGain); motorGain.connect(a.destination);
  motorSource.start();

  const brakeSource = a.createBufferSource(), brakeFilter = a.createBiquadFilter(), brakeGain = a.createGain();
  brakeSource.buffer = noise; brakeSource.loop = true;
  brakeFilter.type = 'bandpass'; brakeFilter.frequency.value = 1200; brakeFilter.Q.value = 0.7;
  brakeGain.gain.value = 0;
  brakeSource.connect(brakeFilter); brakeFilter.connect(brakeGain); brakeGain.connect(a.destination);
  brakeSource.start();

  const squeal = a.createOscillator(), squealGain = a.createGain();
  squeal.type = 'sine'; squeal.frequency.value = 1900; squealGain.gain.value = 0;
  squeal.connect(squealGain); squealGain.connect(a.destination); squeal.start();
  return { engine, engineFilter, engineGain, motorFilter, motorGain, brakeFilter, brakeGain, squeal, squealGain, prevSpeed: 0 };
}

function updateVehicleSound(V, inp, dt) {
  const a = actx;
  if (!a || a.state !== 'running') return;
  if (!vehicleSound && (!V || P.mode !== 'drive')) return;
  if (!vehicleSound) vehicleSound = createVehicleSound();
  const sound = vehicleSound;
  if (!sound) return;
  const t = a.currentTime, smooth = 0.07;
  const target = (param, value) => param.setTargetAtTime(value, t, smooth);
  if (!V || P.mode !== 'drive') {
    target(sound.engineGain.gain, 0);
    target(sound.motorGain.gain, 0);
    target(sound.brakeGain.gain, 0);
    target(sound.squealGain.gain, 0);
    sound.prevSpeed = 0;
    return;
  }

  const speed = Math.abs(V.v), running = V.fuel > 0 && !V.wreck;
  const throttle = running ? clamp(inp.thr, 0, 1) : 0;
  const speedLoad = clamp(speed / Math.max(1, V.spec.vf * 0.72), 0, 1);
  const rev = running ? 38 + 68 * Math.max(throttle * 0.85, speedLoad * 0.72) : 0;
  const typeScale = V.type === 'motor' ? 1.65 : V.type === 'car' ? 1.2 : 1;
  const engineGain = running ? (0.024 + throttle * 0.066 + speedLoad * 0.018) : 0;
  for (let i = 0; i < sound.engine.length; i++)
    target(sound.engine[i].frequency, rev * typeScale * (i + 1));
  target(sound.engineFilter.frequency, running ? 420 + rev * 8 : 300);
  target(sound.engineGain.gain, engineGain);
  target(sound.motorFilter.frequency, 240 + rev * 4);
  target(sound.motorGain.gain, running ? 0.003 + throttle * 0.012 : 0);

  const pressure = Math.max(clamp(inp.brk, 0, 1), inp.hand ? 0.85 : 0);
  const moving = clamp(speed / 75, 0, 1);
  target(sound.brakeGain.gain, pressure * moving * 0.055);
  target(sound.brakeFilter.frequency, 800 + pressure * 1500);
  const deceleration = dt > 0 ? (sound.prevSpeed - speed) / dt : 0;
  const squealing = pressure > 0.65 && moving > 0.45 && (inp.hand || deceleration > 90);
  target(sound.squeal.frequency, 1650 + Math.min(700, speed * 2));
  target(sound.squealGain.gain, squealing ? pressure * 0.018 : 0);
  sound.prevSpeed = speed;
}

function tone(freq, dur, vol, type = 'square', delay = 0) {
  const a = actx; if (!a || a.state !== 'running') return;
  const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.setValueAtTime(vol, t + dur - 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
const coin = () => { tone(988, 0.08, 0.05, 'square'); tone(1319, 0.14, 0.05, 'square', 0.08); };

/* ----------------------------- UI helper --------------------------------- */
function showToast(text, sec = 2) { const el = $('toast'); el.textContent = text; el.classList.add('show'); toastT = sec; }
function showBanner(html, sec) { const el = $('banner'); el.innerHTML = html; el.classList.remove('hidden'); bannerT = sec; }
function hideBanner() { $('banner').classList.add('hidden'); bannerT = 0; }

async function loadBoard() {
  try {
    const rows = await (await fetch('/api/scores')).json();
    $('boardList').innerHTML = rows.length
      ? rows.map((r) => `<li><span>${escapeHtml(r.name)} · ${r.time}s · ${r.damage}×</span><span>${r.score}</span></li>`).join('')
      : '<li><span>Belum ada skor</span><span></span></li>';
  } catch { /* server tidak tersedia */ }
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ----------------------------- Dunia ------------------------------------- */
function makeVehicle(d, npc = false) {
  const custom = d.type === 'custom';
  const spec = custom ? customSpec(d.parts) : { ...SPECS[d.type] };
  if (!custom) for (const k of ['acc', 'vf', 'vr', 'tank', 'wb', 'front', 'rear', 'hw', 'door', 'burn', 'vTakeoff', 'v0', 'maxAlt', 'climbRate', 'maxSteer', 'grip', 'climb', 'damageRate', 'fifth', 'canTow', 'canTowVehicle', 'towPivot', 'fuelName', 'price', 'mass', 'cad']) if (d[k] != null) spec[k] = d[k];
  if (!custom) spec.model = d.model || d.type;
  return {
    id: d.id || `npc-${Math.random().toString(36).slice(2, 7)}`, name: d.name || 'Kendaraan', type: d.type, color: d.color,
    spec, x: d.x || 0, y: d.y || 0, ang: (d.angle || 0) * DEG, steer: 0, v: 0, gear: 'P',
    fuel: (d.fuel ?? 1) * spec.tank, hooked: null, towing: null, towedBy: null, braking: false, horn: false, npc, lowWarned: false,
    hp: 100, wreck: false, wreckT: 0, fxT: 0,          // kondisi bodi: 100 = mulus, 0 = hancur
    load: 0, loadT: 0, tip: 0, tipT: 0,                // dump truck: muatan hotmix (0..1), muat & jungkit
    milling: false, milledLen: 0, millLast: null,
    asphalt: 0, paving: false,                         // paver: isi hopper (0..1 = 1 truk), sedang menggelar aspal
    cargo: d.type === 'tanker' ? { Solar: 1500, Pertalite: 1500, ...(d.cargo || {}) } : null, hoseTo: null,   // truk tangki
    alt: d.alt || 0,        // 0 = di darat, >0 = di udara
    pitch: 0,               // -1 (menurun) hingga +1 (menanjak)
    airborne: false,        // status apakah sedang terbang
    suspensionPitch: 0, suspensionPitchRate: 0,
    suspensionRoll: 0, suspensionRollRate: 0,
  };
}

function lanePath(road, dir) {
  // lajur kiri (lalu lintas Indonesia): geser ke kiri arah jalan sejauh 1/4 lebar jalan
  const pts = road.pts.map((p) => [p[0], p[1]]);
  if (dir < 0) pts.reverse();
  const off = road.w * 0.25, out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
    out.push([pts[i][0] + ty * off, pts[i][1] - tx * off]);
  }
  return out;
}
function placeOnPath(n, path, frac) {
  const segs = []; let total = 0;
  for (let i = 0; i < path.length - 1; i++) { const L = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]); segs.push(L); total += L; }
  let d = clamp(frac, 0, 0.999) * total, i = 0;
  while (i < segs.length - 1 && d > segs[i]) { d -= segs[i]; i++; }
  const p = path[i], q = path[i + 1], f = d / (segs[i] || 1);
  n.ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
  const mid = (n.spec.front + n.spec.rear) / 2;
  n.x = p[0] + (q[0] - p[0]) * f - Math.cos(n.ang) * mid; n.y = p[1] + (q[1] - p[1]) * f - Math.sin(n.ang) * mid;
  n.si = i;
}
function makeNpc(d) {
  const n = makeVehicle({ ...d, name: 'NPC', id: undefined, x: 0, y: 0, angle: 0 }, true);
  const road = level.roads.find((r) => r.id === d.road);
  n.paths = [lanePath(road, d.dir), lanePath(road, -d.dir)];
  if (road.kind === 'toll') {          // lalu lintas tol putar balik jauh dari gerbang, agar tidak menghalangi plaza tol
    const trim = (path) => {
      let acc = 0, i0 = 0, i1 = path.length - 1;
      while (i0 < path.length - 2 && acc < 280) { acc += Math.hypot(path[i0 + 1][0] - path[i0][0], path[i0 + 1][1] - path[i0][1]); i0++; }
      acc = 0;
      while (i1 > i0 + 2 && acc < 280) { acc += Math.hypot(path[i1][0] - path[i1 - 1][0], path[i1][1] - path[i1 - 1][1]); i1--; }
      return path.slice(i0, i1 + 1);
    };
    n.paths = n.paths.map(trim);
  }
  n.pi = 0;
  placeOnPath(n, n.paths[0], d.t);
  n.cruise = road.kind === 'toll' ? (d.type === 'car' ? 175 + Math.random() * 25 : 120 + Math.random() * 15)
    : d.type === 'box' || d.type === 'minitruck' ? 75 + Math.random() * 8
    : d.type === 'motor' ? (road.kind === 'main' ? 88 + Math.random() * 30 : 62 + Math.random() * 12)
    : road.kind === 'main' ? 95 + Math.random() * 20 : 70;
  n.road = road;
  n.gear = 'D'; n.blockedT = 0; n.honkCd = 0;
  return n;
}

const ACTOR_STYLES = [
  { jacket: '#f97316', skin: '#d6a77a', hair: '#111827' },
  { jacket: '#2563eb', skin: '#c98f68', hair: '#292524' },
  { jacket: '#16a34a', skin: '#e0ac82', hair: '#1c1917' },
  { jacket: '#a855f7', skin: '#bd805e', hair: '#111827' },
  { jacket: '#e11d48', skin: '#d6a77a', hair: '#3f2a1d' },
  { jacket: '#0891b2', skin: '#c98f68', hair: '#292524' },
  { jacket: '#ca8a04', skin: '#e0ac82', hair: '#1c1917' },
  { jacket: '#475569', skin: '#bd805e', hair: '#111827' },
];

function makeActor(x, y, styleIndex = Math.floor(Math.random() * ACTOR_STYLES.length)) {
  return {
    x, y, ang: Math.random() * Math.PI * 2, walkT: 0,
    ...ACTOR_STYLES[styleIndex % ACTOR_STYLES.length],
  };
}

function chooseActorTarget(actor) {
  const angle = Math.random() * Math.PI * 2, distance = Math.random() * actor.radius;
  actor.targetX = actor.homeX + Math.cos(angle) * distance;
  actor.targetY = actor.homeY + Math.sin(angle) * distance;
  actor.wait = 0.8 + Math.random() * 2.8;
}

function setupActors() {
  actors = [];
  const places = getTaxiSpots();
  for (const place of places) {
    if (actors.length >= 14) break;
    if (actors.some((actor) => Math.hypot(actor.homeX - place.x, actor.homeY - place.y) < 600)) continue;
    const actor = makeActor(place.x + (Math.random() - 0.5) * 70, place.y + (Math.random() - 0.5) * 70);
    actor.homeX = actor.x;
    actor.homeY = actor.y;
    actor.radius = 35 + Math.random() * 55;
    actor.speed = 12 + Math.random() * 10;
    actor.state = 'ambient';
    chooseActorTarget(actor);
    actors.push(actor);
  }
}

function setupWorld() {
  vehicles = level.vehicles.map((d) => makeVehicle(d));
  npcs = level.traffic.map(makeNpc);
  setupActors();
  TAXI_SERVICE = null;
  taxiJob = null; availableTaxiJob = null;
  trailers = level.bays.map((b) => ({ id: b.id, bay: b, x: b.x, y: b.y, ang: b.angle * DEG, state: 'parked', atBay: true, owner: null }));
  P.money = level.money; P.extraScore = 0;
  Object.assign(P, { mode: 'walk', veh: null, x: level.spawn.x, y: level.spawn.y, ang: -Math.PI / 2, walkT: 0,
    carrying: 0, energy: 70, money: level.money, extraScore: 0, busy: '', warnE: false, warnE0: false,
    house: null, ix: 0, iy: 0, resting: null });
  fade.a = 0; fade.dir = 0; fade.fn = null;
  clock = level.clockStart ?? 7; P.debt = 0; P.dealerPick = 0; schoolWarnT = 0;
  P.owned = []; P.built = 0; P.tilang = 0; P.souvenir = 0; P.kumon = 0; P.bahan = 4; P.dish = 0; P.cook = 0; P.cooking = false; FX.length = 0;
  P.learn = { baca: 1, hitung: 1, stars: 0, sessions: 0 }; TV.rooms = {}; SERVICE = null;
  if (typeof LEARN !== 'undefined' && LEARN.open) closeLearn();
  if (typeof BUILD !== 'undefined') BUILD.open = false;
  missionIdx = 0; usedZones = new Set(); results = []; damage = 0; elapsed = 0;
  hitCd = 0; jackCd = 0; nextMissionT = 0; mission = null;
  cam.x = P.x; cam.y = P.y;
}

function startGame() {
  if (introActive) { endIntro(); return; }
  audio();
  playerName = ($('nameInput').value || '').trim().slice(0, 20) || 'Pemain';
  try { localStorage.setItem('trailerName', playerName); } catch { /* abaikan */ }
  $('startScreen').classList.add('hidden');
  $('board').classList.add('hidden');
  $('nameInput').blur();
  hideBanner();
  clearSave();
  setupWorld();
  state = 'play';
  newMission();
  saveGame(true);
  setTimeout(() => { if (state === 'play') showToast('🔧 Bengkel Rakit ada di seberang jalan rumah sopir (kotak oranye di radar) · 🚦 titik berwarna di radar = lampu lalu lintas', 6); }, 3600);
}

function newMission() {
  const free = trailers.filter((t) => t.state === 'parked' && t.atBay);
  const zones = level.zones.filter((z) => !usedZones.has(z.id));
  if (!free.length || !zones.length) { finish(); return; }
  const tr = pick(free), z = pick(zones);
  usedZones.add(z.id);
  mission = { no: missionIdx + 1, trailer: tr, zone: z, t: 0, dmg: 0 };
  $('mNo').textContent = `${mission.no}/${MISSIONS}`;
  $('mText').textContent = `${tr.id} → ${z.id}`;
  showBanner(`Misi ${mission.no}: ${tr.id} → ${z.id}<small>Ambil trailer oranye di ${tr.bay.area}<br>antar ke ${z.area}. Back / M = peta rute</small>`, 3.2);
}

function resetMission() {
  if (!mission) return;
  const tr = mission.trailer;
  if (tr.owner) { tr.owner.hooked = null; tr.owner = null; }
  Object.assign(tr, { x: tr.bay.x, y: tr.bay.y, ang: tr.bay.angle * DEG, state: 'parked', atBay: true });
  showToast(`${tr.id} dikembalikan ke dock`);
}

/* ----------------------------- Aksi ------------------------------------- */
function shiftGear(V, dir) {
  const i = GEARS.indexOf(V.gear), ni = clamp(i + dir, 0, GEARS.length - 1);
  if (ni === i) return;
  const g = GEARS[ni];
  const deny = (m) => { showToast(m); tone(220, 0.12, 0.05); };
  if (g === 'P' && Math.abs(V.v) > 4) return deny('Berhenti total dulu sebelum masuk P');
  if (g === 'R' && V.v > 6) return deny('Masih maju — berhenti dulu sebelum R');
  if (g === 'D' && V.v < -6) return deny('Masih mundur — berhenti dulu sebelum D');
  V.gear = g;
  tone(g === 'R' ? 880 : 660, 0.05, 0.04, 'sine');
  if (g === 'R') beepT = 0;
}

function toggleHitch(V) {
  if (!V.spec.canTow) { showToast(`${V.name} tidak bisa menarik trailer — pakai truk`); return; }
  if (V.towing || V.towedBy) { showToast('Lepaskan kendaraan derek sebelum menyambung trailer'); return; }
  if (V.hooked) {
    if (Math.abs(V.v) > 4) { showToast('Berhenti dulu sebelum melepas trailer'); return; }
    const tr = V.hooked;
    if (mission && tr === mission.trailer && zoneFit(tr, mission.zone).inside) { deliver(V); return; }
    V.hooked = null; tr.state = 'parked'; tr.owner = null;
    showToast('Trailer dilepas — belum masuk penuh ke zona tujuan');
    return;
  }
  const [fx, fy] = fifthWheel(V);
  for (const tr of trailers) {
    if (tr.state !== 'parked') continue;
    const d = Math.hypot(fx - tr.x, fy - tr.y);
    if (d < COUPLE_DIST * 2.5 && d >= COUPLE_DIST) { showToast(`Hampir! Kurang ${(d / PX_PER_M).toFixed(1)} m lagi`); return; }
    if (d < COUPLE_DIST) {
      if (Math.abs(wrap(V.ang - tr.ang)) > COUPLE_ANG) { showToast('Sudut truk & trailer belum lurus'); return; }
      if (!mission || tr !== mission.trailer) { showToast('Itu bukan trailer misi ini'); return; }
      if (Math.abs(V.v) > 20) { showToast('Terlalu cepat untuk menyambung'); return; }
      V.hooked = tr; tr.state = 'hooked'; tr.atBay = false; tr.owner = V;
      showToast('Trailer tersambung ✓'); rumble(0.4, 150); tone(440, 0.08, 0.06, 'triangle');
      return;
    }
  }
  showToast('Fifth wheel tidak di bawah kingpin — mundur lebih dekat');
}

function deliver(V) {
  const tr = V.hooked, fit = zoneFit(tr, mission.zone);
  const timeBonus = Math.max(0, Math.round(1200 - 4 * mission.t));
  const acc = Math.round(500 * (0.5 * clamp(1 - fit.offset / 20, 0, 1) + 0.5 * clamp(1 - fit.angErr / (6 * DEG), 0, 1)));
  const pen = 75 * mission.dmg;
  const score = Math.max(100, 1000 + timeBonus + acc - pen);
  const PAY_BONUS = 3000000;        // gaji tambahan per misi
  const pay = Math.round((450000 + score * 100 + PAY_BONUS) / 1000) * 1000;
  const cut = P.debt > 0 ? Math.min(P.debt, Math.round(pay * (level.dealer ? level.dealer.cut : 0.3))) : 0;
  P.debt -= cut;
  P.money += pay - cut;
  results.push({ no: mission.no, time: mission.t, dmg: mission.dmg, acc, score });
  V.hooked = null; tr.state = 'delivered'; tr.owner = null;
  rumble(0.6, 250); coin();
  missionIdx++;
  mission = null;
  $('mNo').textContent = '–'; $('mText').textContent = 'Misi selesai';
  if (missionIdx >= MISSIONS) { finish(); return; }
  showBanner(`Misi ${missionIdx} selesai! +${score}` +
    `<small>Ongkos kirim ${rupiah(pay)}${cut ? ` · cicilan mobil −${rupiah(cut)}${P.debt ? ` (sisa ${rupiah(P.debt)})` : ' — LUNAS'}` : ''}<br>Waktu bonus ${timeBonus} · Presisi ${acc} · Benturan −${pen}</small>`, 3);
  nextMissionT = 3.2;
}

async function finish() {
  state = 'done';
  clearSave();
  setHorn(false);
  finalScore = (results ? results.reduce((s, r) => s + r.score, 0) : 0) + (P.extraScore || 0);
  const rows = results.map((r) => `Misi ${r.no}: ${r.score} (${r.time.toFixed(1)} s, ${r.dmg}× benturan)`).join('<br>');
  showBanner(`Selesai! Total skor ${finalScore}<small>${rows}<br>Uang akhir ${rupiah(P.money)}<br>Tekan A / Enter untuk main lagi</small>`, Infinity);
  try {
    const res = await fetch('/api/scores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: playerName, score: finalScore, time: elapsed, damage, mission: results.length }),
    });
    const j = await res.json();
    if (j.rank) showToast(`Peringkat #${j.rank} di papan skor`, 4);
  } catch { showToast('Skor tidak tersimpan (server tidak terjangkau)'); }
  await loadBoard();
  $('board').classList.remove('hidden');
}

/* ----------------------------- Interior bangunan -------------------------- */
// Sopir bisa masuk lewat pintu bangunan (A): rumah, warung, pasar, toko SPBU, Toko Luwes, hotel, Kumon,
// sekolah, dealer. Tiap jenis punya denah (room), perabot (furn) dan titik interaksi (zones).
// Koordinat interior dalam px (10 px = 1 m): asal di pojok barat-laut ruangan, y ke selatan.
// Pintu keluar selalu di dinding selatan. Data ini dipakai bersama oleh render 2D dan render 3D.
const THEME_BASE = { wall: '#efe3cc', trim: '#9a3412', floor: '#b98a5b', floorLine: 'rgba(60,35,15,0.28)', carpet: '#a9876a',
  sofa: '#9a3412', bed: '#2563eb', accent: '#f59e0b', wood: '#7c4a21', tile: false };
const THEMES = Object.fromEntries(Object.entries({
  sopir: {},
  puri: { wall: '#eceff3', trim: '#334155', floor: '#d6d3d1', floorLine: 'rgba(60,60,70,0.25)', carpet: '#9fb0c2',
    sofa: '#475569', bed: '#64748b', accent: '#38bdf8', wood: '#6b5b4b', tile: true },
  warung: { wall: '#fdf0d5', trim: '#0f766e', floor: '#c9bba5', floorLine: 'rgba(80,60,40,0.22)', accent: '#ef4444', wood: '#8b5a2b', tile: true },
  pasar: { wall: '#e7e5e4', trim: '#b45309', floor: '#a8a29e', floorLine: 'rgba(40,30,20,0.2)', accent: '#f59e0b', wood: '#92400e', tile: true },
  toko: { wall: '#f8fafc', trim: '#dc2626', floor: '#e5e7eb', floorLine: 'rgba(0,0,0,0.1)', accent: '#dc2626', wood: '#94a3b8', tile: true },
  luwes: { wall: '#f0fdf4', trim: '#15803d', floor: '#e7e5e4', floorLine: 'rgba(0,0,0,0.1)', accent: '#15803d', wood: '#a16207', tile: true },
  hotel: { wall: '#f3e8d2', trim: '#7c2d12', floor: '#a8794e', floorLine: 'rgba(60,35,15,0.3)', carpet: '#7f1d1d', sofa: '#7c2d12',
    accent: '#b45309', wood: '#5b3a1e' },
  kumon: { wall: '#f0f9ff', trim: '#0369a1', floor: '#cbd5e1', floorLine: 'rgba(0,0,0,0.1)', accent: '#0ea5e9', wood: '#e2e8f0', tile: true },
  sekolah: { wall: '#fefce8', trim: '#166534', floor: '#d6d3d1', floorLine: 'rgba(0,0,0,0.12)', accent: '#16a34a', wood: '#a16207', tile: true },
  dealer: { wall: '#f9fafb', trim: '#dc2626', floor: '#d1d5db', floorLine: 'rgba(0,0,0,0.08)', carpet: '#7f1d1d', sofa: '#111827',
    accent: '#dc2626', wood: '#6b7280', tile: true },
  masjid: { wall: '#f0fdf4', trim: '#15803d', floor: '#e7e5e4', floorLine: 'rgba(0,0,0,0.1)', carpet: '#166534',
    accent: '#16a34a', wood: '#92400e', tile: true },
}).map(([k, v]) => [k, { ...THEME_BASE, ...v }]));

const F = (kind, x, y, w, h, o = {}) => ({ kind, x, y, w, h, solid: o.solid ?? true, ...o });
const rest = (rect, kind, sit) => ({ kind, rect, reach: 13, sit });
const doorZone = (room) => ({ kind: 'door', cx: room.doorX, cy: room.h - 6, r: 24 });

function makeInteriors() {
  const I = {};
  // --- rumah (sama seperti sebelumnya)
  {
    const room = { w: 220, h: 150, doorX: 110, doorW: 26, wr: 5 };
    const furn = [
      F('rug', 0, 0, 82, 90, { solid: false, col: 'carpet' }), F('rug', 112, 20, 56, 48, { solid: false, col: 'accent', border: true }),
      F('wall', 82, 0, 4, 88, { ht: 30 }), F('bed', 10, 8, 22, 26, { ht: 9 }), F('nightstand', 34, 8, 8, 8, { ht: 7 }),
      F('wardrobe', 48, 3, 30, 10, { ht: 22 }), F('tv', 118, 3, 44, 8, { ht: 5 }), F('sofa', 122, 44, 36, 12, { ht: 13 }),
      F('coffee', 130, 26, 20, 9, { ht: 5 }), F('dining', 160, 76, 26, 16, { ht: 8 }), F('fridge', 206, 18, 14, 16, { ht: 18 }),
      F('counter', 206, 38, 14, 72, { ht: 10 }), F('shoes', 58, 138, 26, 10, { ht: 4 }), F('plant', 192, 134, 10, 10, { ht: 16 }),
      F('chair', 166, 68, 7, 7, { solid: false, ht: 11 }), F('chair', 177, 68, 7, 7, { solid: false, ht: 11 }),
      F('chair', 166, 93, 7, 7, { solid: false, ht: 11, flip: true }), F('chair', 177, 93, 7, 7, { solid: false, ht: 11, flip: true }),
    ];
    const bed = furn.find((f) => f.kind === 'bed'), sofa = furn.find((f) => f.kind === 'sofa'), tv = furn.find((f) => f.kind === 'tv');
    I.rumah = { room, furn, windows: [24, 96, 176], greet: 'tahan A di kasur atau sofa untuk istirahat · tahan A di dapur untuk memasak · A di dekat TV untuk TV edukasi',
      zones: [{ kind: 'bed', rect: bed, reach: 14, icon: '🛏️' }, { kind: 'tv', rect: tv, reach: 16, icon: '📺' },
        { kind: 'masak', rect: { x: 206, y: 62, w: 14, h: 24 }, reach: 13, icon: '🍳' }, { kind: 'kulkas', rect: furn.find((f) => f.kind === 'fridge'), reach: 12, icon: '🧊' },
        { kind: 'sofa', rect: sofa, reach: 14, icon: '🛋️', sit: { x: sofa.x + sofa.w / 2, y: sofa.y + 5, ang: -Math.PI / 2 } }, doorZone(room)] };
  }
  // --- warung makan (Warung Klero)
  {
    const room = { w: 160, h: 110, doorX: 80, doorW: 26, wr: 5 };
    const et = F('etalase', 18, 6, 72, 14, { ht: 13 }), t1 = F('table', 16, 54, 50, 14, { ht: 8 }), t2 = F('table', 94, 54, 50, 14, { ht: 8 });
    const furn = [et, F('stove', 96, 4, 30, 12, { ht: 10 }), F('fridge', 138, 5, 16, 16, { ht: 19, drinks: true }), t1, t2,
      F('bench', 16, 44, 50, 6, { solid: false, ht: 5 }), F('bench', 16, 72, 50, 6, { solid: false, ht: 5 }),
      F('bench', 94, 44, 50, 6, { solid: false, ht: 5 }), F('bench', 94, 72, 50, 6, { solid: false, ht: 5 }),
      F('plant', 4, 96, 10, 10, { ht: 16 }), F('plant', 146, 96, 10, 10, { ht: 16 })];
    I.warung = { room, furn, windows: [20, 112], greet: 'pesan di etalase (kasir), lalu duduk makan',
      menu: [{ b: 'a', name: 'Nasi rames', price: 15000, energy: 45 }, { b: 'x', name: 'Es teh manis', price: 5000, energy: 12 }],
      zones: [{ kind: 'kasir', rect: et, reach: 14, icon: '🍛' },
        rest(t1, 'seat', { x: 41, y: 76, ang: -Math.PI / 2 }), rest(t2, 'seat', { x: 119, y: 76, ang: -Math.PI / 2 }), doorZone(room)] };
  }
  // --- pasar tradisional (Pasar Kembangsari): los-los dagangan
  {
    const room = { w: 220, h: 150, doorX: 110, doorW: 34, wr: 5 };
    const pecel = F('stall', 150, 70, 60, 22, { ht: 9, col: '#a16207', goods: 'pecel' });
    const dawet = F('stall', 10, 70, 60, 22, { ht: 9, col: '#16a34a', goods: 'dawet' });
    const furn = [F('stall', 10, 10, 60, 22, { ht: 9, col: '#16a34a', goods: 'sayur' }), F('stall', 80, 10, 60, 22, { ht: 9, col: '#dc2626', goods: 'cabai' }),
      F('stall', 150, 10, 60, 22, { ht: 9, col: '#f59e0b', goods: 'buah' }), dawet, pecel,
      F('bench', 150, 100, 60, 6, { solid: false, ht: 5 }), F('bench', 10, 100, 60, 6, { solid: false, ht: 5 }),
      F('crate', 84, 70, 22, 16, { ht: 9 }), F('crate', 114, 70, 22, 16, { ht: 9 })];
    I.pasar = { room, furn, windows: [], greet: 'jajan pecel atau dawet di los pasar',
      menu: [{ b: 'a', name: 'Nasi pecel', price: 12000, energy: 35 }, { b: 'x', name: 'Dawet ayu', price: 7000, energy: 15 }, { b: 'y', name: 'Bahan masak 4 porsi', price: 28000, bahan: 4 }],
      zones: [{ kind: 'kasir', rect: pecel, reach: 14, icon: '🍲' }, { kind: 'kasir', rect: dawet, reach: 14, icon: '🥤' },
        rest(F('', 150, 100, 60, 6), 'seat', { x: 180, y: 104, ang: -Math.PI / 2 }), doorZone(room)] };
  }
  // --- toko / minimarket SPBU
  {
    const room = { w: 170, h: 120, doorX: 130, doorW: 28, wr: 5 };
    const kasir = F('kasir', 104, 66, 44, 16, { ht: 10 });
    const furn = [F('shelf', 16, 22, 66, 10, { ht: 18 }), F('shelf', 16, 50, 66, 10, { ht: 18 }), F('shelf', 16, 78, 66, 10, { ht: 18 }),
      F('fridge', 98, 4, 18, 14, { ht: 20, drinks: true }), F('fridge', 118, 4, 18, 14, { ht: 20, drinks: true }), F('fridge', 138, 4, 18, 14, { ht: 20, drinks: true }),
      kasir, F('jerry', 4, 100, 30, 14, { ht: 9 }), F('plant', 156, 100, 10, 10, { ht: 16 })];
    I.toko = { room, furn, windows: [20, 60], greet: 'bayar belanjaan di kasir',
      menu: [{ b: 'a', name: `Jeriken ${JERRY_L} L BBM`, price: 70000, jerry: true }, { b: 'x', name: 'Roti & kopi', price: 12000, energy: 25 }],
      zones: [{ kind: 'kasir', rect: kasir, reach: 14, icon: '🛒' }, doorZone(room)] };
  }
  // --- Toko Luwes (oleh-oleh khas Salatiga)
  {
    const room = { w: 240, h: 160, doorX: 120, doorW: 30, wr: 5 };
    const k1 = F('kasir', 30, 120, 46, 16, { ht: 10 }), k2 = F('kasir', 164, 120, 46, 16, { ht: 10 });
    const furn = [];
    for (const [x, c] of [[14, '#a16207'], [70, '#ca8a04'], [126, '#b45309'], [182, '#16a34a']]) {
      furn.push(F('shelf', x, 22, 44, 10, { ht: 18, col: c }), F('shelf', x, 58, 44, 10, { ht: 18, col: c }));
    }
    furn.push(F('shelf', 4, 4, 232, 8, { ht: 22, col: '#15803d' }), k1, k2, F('plant', 4, 140, 10, 10, { ht: 16 }), F('plant', 226, 140, 10, 10, { ht: 16 }),
      F('rug', 90, 100, 60, 46, { solid: false, col: 'accent' }));
    I.luwes = { room, furn, windows: [], greet: 'pilih oleh-oleh khas Salatiga lalu bayar di kasir',
      menu: [{ b: 'a', name: 'Enting-enting gepuk', price: 25000, energy: 15 }, { b: 'x', name: 'Paket oleh-oleh', price: 120000, energy: 30, souvenir: true }, { b: 'y', name: 'Bahan masak 4 porsi', price: 30000, bahan: 4 }],
      zones: [{ kind: 'kasir', rect: k1, reach: 14, icon: '🎁' }, { kind: 'kasir', rect: k2, reach: 14, icon: '🎁' }, doorZone(room)] };
  }
  // --- Hotel Laras Asri: lobi (resepsionis), restoran, sofa
  {
    const room = { w: 260, h: 170, doorX: 130, doorW: 30, wr: 5 };
    const desk = F('desk', 20, 14, 76, 14, { ht: 11 }), buffet = F('etalase', 150, 8, 94, 14, { ht: 12 }), sofa = F('sofa', 34, 96, 44, 12, { ht: 13 });
    const furn = [F('rug', 10, 60, 112, 80, { solid: false, col: 'carpet', border: true }), desk, buffet, sofa, F('coffee', 46, 76, 20, 9, { ht: 5 }),
      F('table', 156, 50, 34, 20, { ht: 8 }), F('table', 206, 50, 34, 20, { ht: 8 }), F('table', 156, 98, 34, 20, { ht: 8 }), F('table', 206, 98, 34, 20, { ht: 8 }),
      F('chair', 168, 40, 9, 8, { solid: false, ht: 11 }), F('chair', 218, 40, 9, 8, { solid: false, ht: 11 }),
      F('chair', 168, 120, 9, 8, { solid: false, ht: 11, flip: true }), F('chair', 218, 120, 9, 8, { solid: false, ht: 11, flip: true }),
      F('plant', 4, 4, 10, 10, { ht: 16 }), F('plant', 108, 150, 10, 10, { ht: 16 }), F('plant', 142, 150, 10, 10, { ht: 16 }), F('wall', 134, 0, 4, 40, { ht: 30 })];
    I.hotel = { room, furn, windows: [150, 200], greet: 'resepsionis untuk menginap, restoran di sebelah kanan',
      menu: [{ b: 'a', name: 'Makan di restoran', price: 85000, energy: 50 }, { b: 'x', name: 'Kopi & pisang goreng', price: 20000, energy: 10 }],
      zones: [{ kind: 'inn', rect: desk, reach: 14, icon: '🛎️' }, { kind: 'kasir', rect: buffet, reach: 14, icon: '🍽️' },
        { kind: 'sofa', rect: sofa, reach: 13, icon: '🛋️', sit: { x: 56, y: 101, ang: -Math.PI / 2 } }, doorZone(room)] };
  }
  // --- Kumon Sukowati: ruang les (papan tulis, meja guru, meja murid)
  {
    const room = { w: 180, h: 130, doorX: 90, doorW: 26, wr: 5 };
    const guru = F('desk', 16, 16, 40, 12, { ht: 10 }), board = F('board', 50, 0, 84, 3, { ht: 24 }), tv = F('tv', 140, 3, 36, 8, { ht: 5 });
    const furn = [board, guru, tv, F('shelf', 130, 113, 30, 10, { ht: 20, col: '#0ea5e9' })];
    const seats = [];
    for (const yy of [48, 82]) for (const xx of [26, 76, 126]) {
      const d = F('sdesk', xx, yy, 30, 12, { ht: 8 });
      furn.push(d, F('chair', xx + 11, yy + 14, 8, 8, { solid: false, ht: 11, flip: true }));
      seats.push(rest(d, 'seat', { x: xx + 15, y: yy + 17, ang: -Math.PI / 2 }));
    }
    furn.push(F('plant', 4, 114, 10, 10, { ht: 16 }), F('plant', 166, 114, 10, 10, { ht: 16 }));
    I.kumon = { room, furn, windows: [], greet: 'belajar di papan tulis (A), les di meja guru, TV edukasi di pojok',
      zones: [{ kind: 'belajar', rect: board, reach: 24, icon: '✏️' }, { kind: 'les', rect: guru, reach: 14, icon: '📚' },
        { kind: 'tv', rect: tv, reach: 16, icon: '📺' }, ...seats.slice(0, 3), doorZone(room)] };
  }
  // --- Sekolah Al-Irsyad: ruang kelas + kantin
  {
    const room = { w: 220, h: 150, doorX: 110, doorW: 26, wr: 5 };
    const kantin = F('etalase', 186, 30, 28, 64, { ht: 12 }), guru = F('desk', 20, 16, 40, 12, { ht: 10 });
    const board = F('board', 62, 0, 76, 3, { ht: 24 }), tv = F('tv', 140, 3, 31, 8, { ht: 5 });
    const furn = [board, tv, guru, kantin, F('wall', 172, 0, 4, 22, { ht: 30 }), F('wall', 172, 104, 4, 46, { ht: 30 })];
    const seats = [];
    for (const yy of [46, 76, 106]) for (const xx of [20, 64, 108]) {
      const d = F('sdesk', xx, yy, 32, 12, { ht: 8 });
      furn.push(d, F('chair', xx + 12, yy + 14, 8, 8, { solid: false, ht: 11, flip: true }));
      seats.push(rest(d, 'seat', { x: xx + 16, y: yy + 17, ang: -Math.PI / 2 }));
    }
    I.sekolah = { room, furn, windows: [24, 160], greet: 'A di papan tulis = belajar membaca & berhitung · TV edukasi · kantin di kanan',
      menu: [{ b: 'a', name: 'Jajan cilok', price: 5000, energy: 10 }, { b: 'x', name: 'Es teh', price: 4000, energy: 8 }],
      zones: [{ kind: 'belajar', rect: board, reach: 24, icon: '✏️' }, { kind: 'tv', rect: tv, reach: 16, icon: '📺' }, { kind: 'kasir', rect: kantin, reach: 14, icon: '🍢' }, ...seats.slice(0, 3), doorZone(room)] };
  }
  // --- dealer Mitsubishi: ruang pamer (mobil pajangan), meja sales, ruang tunggu
  {
    const room = { w: 280, h: 180, doorX: 140, doorW: 34, wr: 5 };
    const sales = F('desk', 206, 30, 56, 14, { ht: 11 }), sofa = F('sofa', 212, 112, 44, 12, { ht: 13 });
    const furn = [F('rug', 196, 96, 70, 46, { solid: false, col: 'carpet' }),
      F('showcar', 24, 26, 70, 30, { ht: 0, car: 'xpander' }), F('showcar', 112, 26, 70, 30, { ht: 0, car: 'pajero' }),
      F('showcar', 24, 96, 70, 30, { ht: 0, car: 'triton' }), F('showcar', 112, 96, 70, 30, { ht: 0, car: 'xforce' }),
      sales, sofa, F('coffee', 222, 96, 22, 9, { ht: 5 }), F('plant', 4, 4, 10, 10, { ht: 16 }), F('plant', 266, 4, 10, 10, { ht: 16 })];
    I.dealer = { room, furn, windows: [30, 120, 210], greet: 'tanya mobil ke meja sales',
      zones: [{ kind: 'dealer', rect: sales, reach: 16, icon: '🚗' },
        { kind: 'sofa', rect: sofa, reach: 13, icon: '🛋️', sit: { x: 234, y: 117, ang: -Math.PI / 2 } }, doorZone(room)] };
  }
  // --- Formulatrix: Laboratorium Otomasi, Ruang Robotika & Liquid Handling
  {
    const room = { w: 260, h: 160, doorX: 130, doorW: 30, wr: 5 };
    const labBench = F('desk', 20, 24, 80, 20, { ht: 13 });
    const logicDesk = F('desk', 160, 24, 80, 20, { ht: 13 });
    const sofa = F('sofa', 180, 110, 50, 14, { ht: 13 });
    const tv = F('tv', 115, 3, 30, 8, { ht: 5 });
    const furn = [
      labBench, logicDesk, sofa, tv,
      F('plant', 6, 6, 12, 12, { ht: 18 }), F('plant', 242, 6, 12, 12, { ht: 18 }),
      F('coffee', 195, 95, 20, 10, { ht: 5 })
    ];
    I.formulatrix = {
      room, furn, windows: [40, 200],
      greet: 'Selamat datang di Lab Robotika & Automasi Formulatrix! Kerjakan job robotika untuk gaji jutaan rupiah.',
      zones: [
        { kind: 'fmx_liquid', rect: labBench, reach: 20, icon: '🧪' },
        { kind: 'fmx_logic', rect: logicDesk, reach: 20, icon: '⚡' },
        { kind: 'tv', rect: tv, reach: 16, icon: '📺' },
        { kind: 'sofa', rect: sofa, reach: 14, icon: '🛋️', sit: { x: 205, y: 115, ang: -Math.PI / 2 } },
        doorZone(room)
      ]
    };
  }
  // --- masjid: tempat wudu, ruang sholat menghadap barat, dan TV edukasi
  {
    const room = { w: 240, h: 180, doorX: 120, doorW: 30, wr: 5 };
    const wudu = F('wudu', 194, 34, 30, 104, { ht: 8 });
    const tv = F('tv', 92, 3, 56, 10, { ht: 5 });
    const mats = [42, 74, 106].map((x) => F('prayerMat', x, 54, 22, 38, { solid: false, facing: 'west' }));
    const prayerArea = F('rug', 32, 46, 106, 54, { solid: false, col: 'carpet', border: true });
    const furn = [prayerArea, tv, ...mats, wudu, F('plant', 10, 10, 12, 12, { ht: 18 })];
    I.masjid = {
      room, furn, windows: [28, 180],
      greet: 'area wudu memulihkan tenaga · sajadah menghadap barat · A di TV untuk video edukasi',
      zones: [
        { kind: 'wudu', rect: wudu, reach: 14, icon: '💧' },
        { kind: 'tv', rect: tv, reach: 16, icon: '📺' },
        { kind: 'salat', rect: prayerArea, reach: 10, icon: '⬅️' },
        doorZone(room)
      ]
    };
  }
  for (const [k, v] of Object.entries(I)) v.key = k;
  return I;
}
const INTERIORS = makeInteriors();
let IN = INTERIORS.rumah;                       // interior yang sedang dimasuki
let IN_DISPLAY = [];                            // mobil pajangan di dalam ruang pamer dealer
const REST_RATE = { bed: 30, sofa: 16, seat: 10, wudu: 12 };   // tenaga per detik
// Dapur rumah: tahan A di kompor untuk memasak lalu langsung makan. X ganti menu. Bahan dibeli di Pasar / Toko Luwes (Y).
const COOK = [
  { name: 'Nasi goreng telur', energy: 40, time: 5, bahan: 1, mins: 15 },
  { name: 'Mie rebus sayur', energy: 28, time: 3.5, bahan: 1, mins: 10 },
  { name: 'Nasi liwet komplit', energy: 65, time: 8, bahan: 2, mins: 30 },
];
function finishCook(dish) {
  const before = P.energy;
  P.bahan = Math.max(0, (P.bahan || 0) - dish.bahan);
  P.energy = Math.min(100, P.energy + dish.energy); P.cook = 0;
  clock = (clock + dish.mins / 60) % 24;
  tone(523, 0.1, 0.05, 'triangle'); tone(659, 0.1, 0.05, 'triangle', 0.09); tone(784, 0.18, 0.05, 'triangle', 0.18);
  showToast(`🍽️ ${dish.name} matang! Sopir makan dengan lahap — tenaga +${Math.round(P.energy - before)} · sisa bahan ${P.bahan} porsi`, 3.6);
}

function setInterior(pl) {
  IN = INTERIORS[pl.interior || 'rumah'] || INTERIORS.rumah;
  IN_DISPLAY = [];
  if (IN.key === 'dealer' && level.dealer) {
    for (const f of IN.furn) if (f.kind === 'showcar') {
      const st = level.dealer.stock.find((c) => c.id === f.car) || level.dealer.stock[0];
      const veh = makeVehicle({ type: 'car', model: st.model, color: st.color, name: st.name, ...st.spec }, true);
      const mid = (veh.spec.front + veh.spec.rear) / 2;
      Object.assign(veh, { x: f.x + f.w / 2 - mid, y: f.y + f.h / 2, ang: 0, display: true });
      IN_DISPLAY.push(veh);
    }
  }
}
const themeOf = (pl) => THEMES[pl.theme] || THEMES[IN.key] || THEMES.sopir;

function distRect(px, py, r) {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w)), dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}
function interiorBlocked(x, y) {
  const r = IN.room.wr;
  if (x < r || x > IN.room.w - r || y < r || y > IN.room.h - r) return true;
  for (const f of IN.furn) if (f.solid && x + r > f.x && x - r < f.x + f.w && y + r > f.y && y - r < f.y + f.h) return true;
  return false;
}
function nearZone() {
  let best = null, bd = Infinity;
  for (const z of IN.zones) {
    const d = z.rect ? distRect(P.ix, P.iy, z.rect) - z.reach : Math.hypot(P.ix - z.cx, P.iy - z.cy) - z.r;
    if (d <= 0 && d < bd) { bd = d; best = z; }
  }
  return best;
}

function transition(fn) {            // layar menggelap -> jalankan fn -> terang lagi
  if (fade.dir) return;
  fade.dir = 1; fade.fn = fn;
}
function fadeStep(dt) {
  if (!fade.dir) return;
  fade.a += fade.dir * dt / 0.2;
  if (fade.dir > 0 && fade.a >= 1) {
    fade.a = 1; const fn = fade.fn; fade.fn = null; fade.dir = -1;
    if (fn) fn();
  } else if (fade.dir < 0 && fade.a <= 0) { fade.a = 0; fade.dir = 0; }
}

function enterHouse(pl) {
  const d = pl.door || { x: pl.x, y: pl.y + 10 };
  transition(() => {
    setInterior(pl);
    Object.assign(P, { mode: 'inside', house: pl, x: d.x, y: d.y, ix: IN.room.doorX, iy: IN.room.h - 20, ang: -Math.PI / 2,
      resting: null, sit: null, busy: '', run: false });
    tone(260, 0.1, 0.05, 'triangle'); tone(330, 0.1, 0.04, 'triangle', 0.09);
    showToast(`Masuk ${pl.label} — ${IN.greet}`, 3.5);
  });
}
function exitHouse() {
  const pl = P.house;
  if (!pl) return;
  const d = pl.door || { x: pl.x, y: pl.y + 10 };
  transition(() => {
    let x = d.x, y = d.y;
    for (const [ox, oy] of [[0, 0], [24, 0], [-24, 0], [0, 18], [34, 12], [-34, 12]]) {
      if (!walkerBlocked(d.x + ox, d.y + oy)) { x = d.x + ox; y = d.y + oy; break; }
    }
    Object.assign(P, { mode: 'walk', house: null, x, y, ang: Math.PI / 2, resting: null, sit: null, busy: '' });
    tone(300, 0.08, 0.05, 'triangle');
  });
}

// beli satu item menu (kasir warung / toko / Luwes / pasar / restoran / kantin)
function buyItem(it) {
  if (it.jerry && P.carrying) { showToast('Sopir sudah membawa jeriken'); return; }
  if (!buy(it.price, it.name.toLowerCase())) return;
  if (it.energy) P.energy = Math.min(100, P.energy + it.energy);
  if (it.jerry) P.carrying = JERRY_L;
  if (it.souvenir) P.souvenir = (P.souvenir || 0) + 1;
  if (it.bahan) P.bahan = (P.bahan || 0) + it.bahan;
  showToast(`${it.name} — ${rupiah(it.price)}${it.energy ? ` · tenaga +${it.energy}` : ''}${it.souvenir ? ` · oleh-oleh ${P.souvenir}` : ''}${it.bahan ? ` · bahan masak sekarang ${P.bahan} porsi — masak di dapur rumah` : ''}${it.jerry ? ' · bawa keluar & tuang ke kendaraan' : ''}`, 2.6);
}
function menuText(menu) {
  return menu.map((it) => `${it.b.toUpperCase()}: ${it.name} ${rupiah(it.price)}${it.energy ? ` (+${it.energy})` : it.bahan ? ` (${it.bahan} porsi)` : ''}`).join(' · ');
}
function stayHotel() {                 // Hotel Laras Asri: menginap = tenaga penuh + waktu maju
  if (!buy(450000, 'kamar hotel')) return;
  transition(() => {
    P.energy = 100;
    clock = clock >= 18 || clock < 6 ? 6.5 : (clock + 8) % 24;
    showToast(`Menginap di Hotel Laras Asri — bangun pukul ${fmtClock(clock)}, tenaga penuh`, 4);
  });
}
function joinKumon() {                 // Kumon: 1 sesi les = 1 jam
  if (!buy(60000, 'les Kumon')) return;
  transition(() => {
    clock = (clock + 1) % 24; P.kumon = (P.kumon || 0) + 1;
    const subj = P.kumon % 2 ? 'Matematika' : 'Bahasa Inggris';
    showToast(`📚 Les Kumon ${subj} selesai (sesi ke-${P.kumon}) — sekarang pukul ${fmtClock(clock)}`, 4);
  });
}
function dealerControl(inp) {
  const D = level.dealer; if (!D) return;
  const n = D.stock.length;
  if (inp.down) P.dealerPick = ((P.dealerPick || 0) + 1) % n;
  if (inp.up) P.dealerPick = ((P.dealerPick || 0) + n - 1) % n;
  const car = D.stock[P.dealerPick || 0];
  if (inp.a) buyCar(car, false);
  if (inp.x) buyCar(car, true);
}

function insideUpdate(inp, dt) {
  setHorn(false);
  P.busy = ''; P.run = false; P.cooking = false;
  const z = nearZone();
  const rate = z && REST_RATE[z.kind];
  // Kasur = toggle: tekan A sekali untuk tidur, tekan A lagi untuk bangun.
  // Sofa/kursi/tempat wudu tetap tahan A.
  const isBed = !!(z && z.kind === 'bed');
  let wantRest = !!(rate && inp.aHeld);
  if (isBed) {
    const asleep = P.resting === 'bed';
    wantRest = inp.a ? !asleep : asleep;
    if (inp.a) {
      if (asleep) { tone(520, 0.08, 0.04, 'triangle'); showToast('Bangun dari tidur', 1.8); }
      else { tone(300, 0.12, 0.04, 'sine'); showToast('Tidur… tekan A lagi untuk bangun', 2.2); }
    }
  }
  if (wantRest) {                       // istirahat: sopir diam di tempat
    P.resting = z.kind; P.sit = z.sit || null;
    if (inp.x && tvOnHere()) tvNext(P.house);            // sambil duduk: X ganti channel TV
    if (tvOnHere()) { if (inp.y) tvBig(); if (inp.down) tvCommand('nextVideo'); if (inp.up) tvCommand('previousVideo'); }
    if (P.energy >= 100) P.busy = 'Tenaga sudah penuh';
    else {
      P.energy = Math.min(100, P.energy + rate * dt);
      P.busy = z.kind === 'bed' ? 'Tidur… zzz (A: bangun)' : z.kind === 'wudu' ? 'Berwudu… tenaga pulih' : 'Duduk santai…';
    }
    return;
  }
  P.resting = null; P.sit = null;
  if (z && z.kind === 'masak') {
    if (inp.x) { P.dish = ((P.dish || 0) + 1) % COOK.length; P.cook = 0; tone(480, 0.05, 0.04, 'sine'); showToast(`Menu: ${COOK[P.dish].name} (tenaga +${COOK[P.dish].energy}, ${COOK[P.dish].bahan} porsi bahan)`, 2.2); }
    const dish = COOK[P.dish || 0];
    if (inp.aHeld) {                    // memasak: sopir diam di depan kompor
      if (P.energy >= 100) { P.cook = 0; P.busy = 'Tenaga sudah penuh — belum perlu makan'; }
      else if ((P.bahan || 0) < dish.bahan) { P.cook = 0; P.busy = `Bahan masak kurang (${P.bahan || 0}/${dish.bahan} porsi) — beli di Pasar Kembangsari / Toko Luwes`; }
      else {
        const was = P.cook; P.cook += dt; P.cooking = true;
        P.busy = `🍳 Memasak ${dish.name}… ${Math.min(99, Math.round(P.cook / dish.time * 100))}%`;
        if (Math.floor(was * 6) !== Math.floor(P.cook * 6)) tone(900 + Math.random() * 500, 0.03, 0.012, 'sawtooth');   // suara menggoreng
        if (P.cook >= dish.time) finishCook(dish);
      }
      return;
    }
    P.cook = 0;
  }
  if (z && z.kind === 'kasir' && IN.menu) for (const it of IN.menu) if (inp[it.b]) buyItem(it);
  if (z && z.kind === 'inn' && inp.a) stayHotel();
  if (z && z.kind === 'les' && inp.a) joinKumon();
  if (z && z.kind === 'belajar' && inp.a) openLearn(P.house.label);
  if (z && z.kind === 'fmx_liquid' && inp.a) openFmxLiquid();
  if (z && z.kind === 'fmx_logic' && inp.a) openFmxLogic();
  if (z && z.kind === 'tv') { if (inp.a) tvToggle(P.house); if (inp.x) tvNext(P.house); }
  if (tvOnHere() && !(z && z.kind === 'dealer')) { if (inp.y) tvBig(); if (inp.down) tvCommand('nextVideo'); if (inp.up) tvCommand('previousVideo'); }
  if (z && z.kind === 'dealer') dealerControl(inp);
  [inp.mx, inp.my] = camRelMove(inp);
  const sp = (inp.run ? RUN_V : WALK_V) * (P.energy <= 0 ? 0.6 : 1);
  P.run = !!(inp.run && (inp.mx || inp.my));
  if (inp.mx || inp.my) {
    const nx = P.ix + inp.mx * sp * dt, ny = P.iy + inp.my * sp * dt;
    if (!interiorBlocked(nx, P.iy)) P.ix = nx;
    if (!interiorBlocked(P.ix, ny)) P.iy = ny;
    P.ang = Math.atan2(inp.my, inp.mx);
    P.walkT += dt * sp;
  }
  if (z && z.kind === 'door' && inp.a) exitHouse();
}

/* ----- naik / turun kendaraan & interaksi jalan kaki ----- */
function walkerBlocked(x, y) {
  const wp = walkerPoly(x, y);
  if (!inBounds(wp)) return true;
  if (hitsObstacles(wp)) return true;
  for (const v of vehicles) if (overlap(wp, vehPoly(v))) return true;
  for (const n of npcs) if (overlap(wp, vehPoly(n))) return true;
  for (const tr of trailers) if (overlap(wp, trailerPoly(tr))) return true;
  return false;
}
function nearVehicle() {
  const probe = walkerPoly(P.x, P.y, 20);
  let best = null, bd = Infinity;
  for (const v of vehicles) {
    if (!overlap(probe, vehPoly(v))) continue;
    const [mx, my] = vehMid(v), d = Math.hypot(mx - P.x, my - P.y);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}
const nearPlace = () => level.places.find((p) => Math.hypot(p.x - P.x, p.y - P.y) < p.r);
function vehicleAtPump(pump) {
  let best = null, bd = 130;
  for (const v of vehicles) {
    const [mx, my] = vehMid(v), d = Math.hypot(mx - pump.x, my - pump.y);
    if (d < bd && Math.abs(v.v) < 1) { bd = d; best = v; }
  }
  return best;
}

function toggleVehicle() {
  if (P.mode === 'drive') {
    const V = P.veh;
    if (Math.abs(V.v) > 4) { showToast('Berhenti dulu sebelum turun'); return; }
    const s = V.spec;
    const spots = [[s.door, -(s.hw + 10)], [s.door, s.hw + 10], [s.rear - 12, 0], [s.front + 12, 0], [s.door, -(s.hw + 26)]];
    for (const [lx, ly] of spots) {
      const [x, y] = local2world(V, lx, ly);
      if (!walkerBlocked(x, y)) {
        if (V.gear !== 'P') { V.gear = 'P'; showToast('Transmisi otomatis dipindah ke P'); }
        V.v = 0; V.horn = false; setHorn(false);
        publishTelemetry(null);
        Object.assign(P, { mode: 'walk', veh: null, x, y, ang: V.ang - Math.PI / 2 });
        tone(300, 0.06, 0.05, 'triangle');
        return;
      }
    }
    showToast('Pintu terhalang — geser kendaraan sedikit');
    return;
  }
  const v = nearVehicle();
  if (!v) { showToast('Tidak ada kendaraan di dekat sopir'); return; }
  if ((v.type === 'plane' || isVTOL(v)) && v.gear === 'P') v.gear = 'D';
  Object.assign(P, { mode: 'drive', veh: v, busy: '' });
  tone(300, 0.06, 0.05, 'triangle');
  showToast(`Naik ${v.name} · ${v.spec.fuelName} ${Math.round(v.fuel)} L`);
}

function buy(price, what) {
  if (P.money < price) { showToast(`Uang tidak cukup untuk ${what}`); tone(220, 0.12, 0.05); return false; }
  P.money -= price; coin(); return true;
}

function buyCar(car, credit) {
  const D = level.dealer;
  const pay = credit ? Math.round(car.price * D.dp) : car.price;
  if (credit && P.debt > 0) { showToast(`Lunasi dulu kredit sebelumnya (sisa ${rupiah(P.debt)})`, 3); tone(220, 0.12, 0.05); return; }
  if (P.money < pay) { showToast(`Uang belum cukup: perlu ${rupiah(pay)}`, 3); tone(220, 0.12, 0.05); return; }
  const n = (P.owned || []).length + 1;
  const def = { id: `beli-${car.id}-${n}`, name: `${car.name}`, type: 'car', model: car.model, color: car.color, fuel: 1, ...car.spec };
  const veh = makeVehicle(def);
  const spot = D.lot.find((l) => { Object.assign(veh, { x: l.x, y: l.y, ang: l.angle * DEG }); return !collidesOther(veh); });
  if (!spot) { showToast('Parkiran dealer penuh — pindahkan dulu mobil yang menghalangi', 3); return; }
  P.money -= pay;
  if (credit) P.debt = car.price - pay;
  P.owned = [...(P.owned || []), def];
  vehicles.push(veh);
  coin(); rumble(0.4, 200);
  showBanner(`🚗 ${car.name} baru!<small>${credit ? `Kredit: DP ${rupiah(pay)}, sisa ${rupiah(P.debt)} dipotong ${Math.round(D.cut * 100)}% dari tiap ongkos kirim`
    : `Dibayar tunai ${rupiah(pay)}`}<br>Mobil menunggu di parkiran dealer · tangki penuh</small>`, 4);
}

function walkInteract(inp, dt) {
  P.busy = '';
  const pl = nearPlace();
  if (pl && pl.interior) {             // rumah, warung, toko, pasar, Luwes, hotel, Kumon, sekolah, dealer: masuk ke dalam
    if (inp.a) enterHouse(pl);
    return;
  }
  if (pl && pl.kind === 'bengkel') {     // bengkel: masuk mode rakit kendaraan
    if (inp.a) openBuilder();
    return;
  }
  if (pl && pl.kind === 'ronde') {      // gerobak wedang ronde: buka sore sampai tengah malam
    const open = clock >= 15 || clock < 1;
    if ((inp.a || inp.x) && !open) { showToast('Gerobak wedang ronde baru buka pukul 15.00', 2.5); return; }
    if (inp.a && buy(10000, 'wedang ronde')) { P.energy = Math.min(100, P.energy + 20); showToast('Wedang ronde jahe hangat — tenaga +20'); }
    if (inp.x && buy(12000, 'bakmi jawa')) { P.energy = Math.min(100, P.energy + 35); showToast('Bakmi jawa — tenaga +35'); }
    return;
  }
  if (pl && (pl.kind === 'alun' || pl.kind === 'wisata')) {       // duduk santai di bangku alun-alun / taman wisata
    if (inp.aHeld) {
      P.energy = Math.min(100, P.energy + (pl.kind === 'wisata' ? 12 : 8) * dt);
      P.busy = P.energy >= 100 ? 'Tenaga sudah penuh' : pl.kind === 'wisata' ? 'Menikmati udara sejuk hutan pinus Kopeng…' : 'Duduk santai di Alun-alun Pancasila…';
    }
    return;
  }
  if (pl && pl.kind === 'amp') { if (inp.a) showToast('Naik dump truck (Y), parkir di bawah silo, lalu tekan A untuk memuat hotmix', 3.5); return; }
  if (pl && pl.kind === 'pump') {
    const v = vehicleAtPump(pl);
    if (!v) { if (inp.a) showToast('Parkir kendaraan di samping pompa dulu'); return; }
    if (inp.aHeld) {
      const s = v.spec;
      if (v.cargo && s.tank - v.fuel < 0.05) {             // truk tangki: isi kompartemen Solar lalu Pertalite
        const k = v.cargo.Solar < CARGO_MAX - 0.5 ? 'Solar' : v.cargo.Pertalite < CARGO_MAX - 0.5 ? 'Pertalite' : null;
        if (!k) { if (inp.a) showToast('Kompartemen truk tangki sudah penuh'); return; }
        const add = Math.min(120 * dt, CARGO_MAX - v.cargo[k], P.money / FUEL_PRICE[k]);
        if (add <= 0) { if (inp.a) showToast('Uang tidak cukup'); return; }
        v.cargo[k] += add; P.money = Math.max(0, Math.round(P.money - add * FUEL_PRICE[k]));
        P.busy = `Mengisi kompartemen ${k}: Solar ${Math.round(v.cargo.Solar)} · Pertalite ${Math.round(v.cargo.Pertalite)} / ${CARGO_MAX} L`;
        return;
      }
      const want = Math.min(15 * dt, s.tank - v.fuel, P.money / s.price);
      if (s.tank - v.fuel < 0.05) { if (inp.a) showToast(`Tangki ${v.name} sudah penuh`); return; }
      if (want <= 0) { if (inp.a) showToast('Uang tidak cukup'); return; }
      v.fuel += want; P.money = Math.max(0, Math.round(P.money - want * s.price)); v.lowWarned = false;
      P.busy = `Mengisi ${s.fuelName} ${v.name}: ${Math.round(v.fuel)}/${s.tank} L`;
    }
    return;
  }
  const dv = nearVehicle();
  if ((inp.x || inp.callFuel) && dv && !pl) { callTanker(dv); return; }
  if (inp.a && !P.carrying && dv && hpOf(dv) < 100) { repairVehicle(dv); return; }
  if (inp.a && P.carrying) {
    const v = nearVehicle();
    if (v) {
      const add = Math.min(P.carrying, v.spec.tank - v.fuel);
      v.fuel += add; P.carrying = 0; v.lowWarned = false;
      showToast(`Jeriken dituang ke ${v.name}: +${add.toFixed(0)} L`); tone(500, 0.2, 0.04, 'sine');
    }
  }
}

/* ----------------------------- Fisika ------------------------------------ */
function integrate(V, h) {
  const towed = V.towing;
  const towedX = towed && towed.x, towedY = towed && towed.y;
  const lateral = isVTOL(V) && V.airborne ? V.lateralV || 0 : 0;
  V.x += (V.v * Math.cos(V.ang) - lateral * Math.sin(V.ang) + (V.kx || 0)) * h;
  V.y += (V.v * Math.sin(V.ang) + lateral * Math.cos(V.ang) + (V.ky || 0)) * h;
  if (isVTOL(V) && V.airborne) {
    V.lateralV = (V.lateralV || 0) * Math.exp(-h * 1.1);
    V.ang = wrap(V.ang + (V.spin || 0) * h);
  } else {
    if (isVTOL(V)) V.lateralV = (V.lateralV || 0) * Math.exp(-h * 2);
    V.ang = wrap(V.ang + ((V.v / V.spec.wb) * Math.tan(V.steer) + (V.spin || 0)) * h);
  }
  if (towed) {
    const [hx, hy] = towVehiclePoint(V), dx = hx - towed.x, dy = hy - towed.y;
    if (Math.hypot(dx, dy) > 0.01) towed.ang = Math.atan2(dy, dx);
    const co = Math.cos(towed.ang), si = Math.sin(towed.ang);
    const tFront = (towed.spec && typeof towed.spec.front === 'number' && !isNaN(towed.spec.front)) ? towed.spec.front : 15;
    towed.x = hx - co * tFront;
    towed.y = hy - si * tFront;
    towed.v = h > 0 ? ((towed.x - towedX) * co + (towed.y - towedY) * si) / h : V.v;
    towed.steer = 0;
  }
  const tr = V.hooked;
  if (!tr) return false;
  const [kx, ky] = fifthWheel(V);
  const ax = tr.x - Math.cos(tr.ang) * TRAILER.l2, ay = tr.y - Math.sin(tr.ang) * TRAILER.l2;
  let na = Math.atan2(ky - ay, kx - ax);
  const d = wrap(V.ang - na);
  let jack = false;
  if (Math.abs(d) > MAX_HITCH) { na = wrap(V.ang - Math.sign(d) * MAX_HITCH); jack = true; }
  tr.ang = na; tr.x = kx; tr.y = ky;
  return jack;
}

function collides(V) {
  const vp = vehPoly(V);
  if (!inBounds(vp)) return true;
  if (hitsObstacles(vp)) return true;
  for (const tr of trailers) if (tr !== V.hooked && overlap(vp, trailerPoly(tr, V.spec.canTow))) return true;
  for (const u of vehicles) if (u !== V && u !== V.towing && u !== V.towedBy && overlap(vp, vehPoly(u))) return true;
  for (const n of npcs) if (overlap(vp, vehPoly(n))) return true;
  if (V.towing) {
    const tp = vehPoly(V.towing);
    if (!inBounds(tp) || hitsObstacles(tp)) return true;
    for (const tr of trailers) if (tr !== V.hooked && overlap(tp, trailerPoly(tr))) return true;
    for (const u of vehicles) if (u !== V && u !== V.towing && overlap(tp, vehPoly(u))) return true;
    for (const n of npcs) if (overlap(tp, vehPoly(n))) return true;
  }
  const h = V.hooked;
  if (h) {
    const hp = trailerPoly(h);
    if (!inBounds(hp)) return true;
    if (hitsObstacles(hp)) return true;
    for (const tr of trailers) if (tr !== h && overlap(hp, trailerPoly(tr))) return true;
    for (const u of vehicles) if (u !== V && u !== V.towing && u !== V.towedBy && overlap(hp, vehPoly(u))) return true;
    for (const n of npcs) if (overlap(hp, vehPoly(n))) return true;
  }
  return false;
}


function collidesOther(o) {              // apakah kendaraan diam o menabrak sesuatu (dipakai saat menaruh mobil baru)
  const vp = vehPoly(o);
  if (!inBounds(vp) || hitsObstacles(vp)) return true;
  for (const tr of trailers) if (overlap(vp, trailerPoly(tr))) return true;
  for (const list of [vehicles, npcs]) for (const u of list) if (u !== o && u !== o.towing && u !== o.towedBy && overlap(vp, vehPoly(u))) return true;
  return false;
}

/* ----- benturan: impuls berbasis massa, kendaraan terpental & berputar ----- */
const MASS = { tractor: 3, car: 1, box: 2, minitruck: 1.6, motor: 0.3, dump: 2.4, paver: 3.2, milling: 3.4, tanker: 2.6, plane: 1.8 };
const massOf = (v) => (v.spec.mass || MASS[v.type] || 1) + (v.hooked ? 3 : 0);
const RESTITUTION = 0.55;               // 0 = lengket, 1 = memantul sempurna

function normalFromBox(px, py, x0, y0, x1, y1) {          // normal dari kotak ke titik + titik kontak
  const cx = clamp(px, x0, x1), cy = clamp(py, y0, y1);
  let nx = px - cx, ny = py - cy, l = Math.hypot(nx, ny);
  if (l < 1e-3) {                                          // titik di dalam kotak: dorong ke sisi terdekat
    const d = [px - x0, x1 - px, py - y0, y1 - py], m = Math.min(...d), i = d.indexOf(m);
    nx = [-1, 1, 0, 0][i]; ny = [0, 0, -1, 1][i]; l = 1;
  }
  return { n: [nx / l, ny / l], p: [cx, cy] };
}
function normalFromPoint(px, py, ox, oy) {
  const nx = px - ox, ny = py - oy, l = Math.hypot(nx, ny) || 1;
  return { n: [nx / l, ny / l], p: [(px + ox) / 2, (py + oy) / 2] };
}
// apa yang ditabrak kendaraan V (atau trailernya) + arah normal (menjauhi benda) + titik kontak
function collideInfo(V) {
  const bodies = [{ poly: vehPoly(V), mid: vehMid(V) }];
  if (V.hooked) { const t = V.hooked, m = (TRAILER.front + TRAILER.rear) / 2; bodies.push({ poly: trailerPoly(t), mid: [t.x + Math.cos(t.ang) * m, t.y + Math.sin(t.ang) * m] }); }
  for (const b of bodies) {
    const [mx, my] = b.mid;
    if (!inBounds(b.poly)) return { other: null, ...normalFromPoint(W / 2, H / 2, mx, my), wall: true };
    const bb = polyBB(b.poly);
    for (const O of OBS) {
      if (O.x1 < bb.x0 || O.x0 > bb.x1 || O.y1 < bb.y0 || O.y0 > bb.y1) continue;
      if (overlap(b.poly, O.poly)) return { other: null, obj: O.o, ...normalFromBox(mx, my, O.x0, O.y0, O.x1, O.y1) };
    }
    for (const tr of trailers) {
      if (tr === V.hooked || !overlap(b.poly, trailerPoly(tr, b === bodies[0] && V.spec.canTow))) continue;
      const m = (TRAILER.front + TRAILER.rear) / 2;
      return { other: null, ...normalFromPoint(mx, my, tr.x + Math.cos(tr.ang) * m, tr.y + Math.sin(tr.ang) * m) };
    }
    for (const list of [vehicles, npcs]) for (const u of list) {
      if (u === V || !overlap(b.poly, vehPoly(u))) continue;
      const [ux, uy] = vehMid(u);
      return { other: u, ...normalFromPoint(mx, my, ux, uy) };
    }
  }
  return null;
}

function applyBounce(V, hit, v0) {
  const fx = Math.cos(V.ang), fy = Math.sin(V.ang), [nx, ny] = hit.n;
  let ux = v0 * fx + (V.kx || 0), uy = v0 * fy + (V.ky || 0);
  const vn = ux * nx + uy * ny;                  // < 0 berarti bergerak masuk ke benda
  if (vn >= 0) { V.v = v0 * 0.2; return 0; }
  const m1 = massOf(V), o = hit.other, m2 = o ? massOf(o) : Infinity;
  const share = o ? m2 / (m1 + m2) : 1;          // kendaraan ringan menabrak yang berat -> terpental lebih jauh
  const J = -(1 + RESTITUTION) * vn * Math.max(0.35, share);
  ux += J * nx; uy += J * ny;
  // kecepatan setelah tabrakan jadi gerak terpental (meluruh dalam ±1 detik)
  V.v = 0; V.kx = ux; V.ky = uy; V.knockDecay = 1.8;
  // tabrakan menyerong / di pojok membuat kendaraan berputar
  V.spin = clamp((V.spin || 0) + (fx * ny - fy * nx) * -vn * 0.02 * Math.max(0.4, share) + (Math.random() - 0.5) * -vn * 0.004, -2.6, 2.6);
  if (o) {                                       // kendaraan lain ikut terdorong & berputar
    const Jo = (1 + RESTITUTION) * -vn * (m1 / (m1 + m2));
    o.kx = (o.kx || 0) - nx * Jo; o.ky = (o.ky || 0) - ny * Jo; o.knockDecay = 2.2;
    const ofx = Math.cos(o.ang), ofy = Math.sin(o.ang);
    o.spin = clamp((o.spin || 0) + (ofx * -ny + ofy * nx) * Jo * 0.018 + (Math.random() - 0.5) * 0.3, -3, 3);
    if (o.npc) { o.v *= 0.2; o.stunT = 1.6; } else o.v = 0;
  }
  const sx = V.x, sy = V.y;                      // dorong sedikit keluar agar tidak menempel
  V.x += nx * 1.5; V.y += ny * 1.5;
  if (collides(V)) { V.x = sx; V.y = sy; }
  return -vn;
}

function knockUpdate(o, dt) {            // gerak sisa tabrakan untuk kendaraan yang tidak sedang disetir
  if (!o.kx && !o.ky && !o.spin) return;
  const prev = { x: o.x, y: o.y, ang: o.ang };
  o.x += (o.kx || 0) * dt; o.y += (o.ky || 0) * dt; o.ang = wrap(o.ang + (o.spin || 0) * dt);
  if (collidesOther(o)) { Object.assign(o, prev); o.kx = -(o.kx || 0) * 0.3; o.ky = -(o.ky || 0) * 0.3; o.spin = -(o.spin || 0) * 0.3; }
  decayKnock(o, dt);
}
/* ----- kendaraan menyangkut (tumpang tindih): dilempar saling menjauh sampai terpisah ----- */
const UNTANGLE_PUSH = 150;                  // px/s: dorongan langsung memisahkan kendaraan yang masih bertumpuk
const UNTANGLE_KICK = 70;                   // px/s: hentakan terpental (meluruh seperti benturan biasa)
function untangleVehicles(dt) {
  const list = [];
  for (const v of vehicles) if (!v.airborne && !(v.alt > 5)) list.push(v);
  for (const n of npcs) list.push(n);
  const active = (v) => (v === P.veh && P.mode === 'drive') || Math.abs(v.v || 0) > 2 || Math.hypot(v.kx || 0, v.ky || 0) > 1 || !!v.npc;
  const shift = (v, dx, dy) => {                           // geser v; batal bila malah menabrak tembok / bangunan
    const px = v.x, py = v.y;
    v.x += dx; v.y += dy;
    const vp = vehPoly(v);
    if (!inBounds(vp) || hitsObstacles(vp)) { v.x = px; v.y = py; return false; }
    return true;
  };
  for (let i = 0; i < list.length; i++) {
    const A = list[i], [ax, ay] = vehMid(A), la = (A.spec.front - A.spec.rear) / 2 + A.spec.hw;
    for (let j = i + 1; j < list.length; j++) {
      const B = list[j];
      if (!active(A) && !active(B)) continue;              // dua kendaraan parkir yang sudah menumpuk dari awal: biarkan
      if (B === A.towing || B === A.towedBy || A === B.towing || A === B.towedBy) continue;
      const [bx, by] = vehMid(B), lb = (B.spec.front - B.spec.rear) / 2 + B.spec.hw;
      if (Math.hypot(ax - bx, ay - by) > la + lb) continue;
      if (!overlap(vehPoly(A), vehPoly(B))) continue;
      let nx = ax - bx, ny = ay - by, l = Math.hypot(nx, ny);
      if (l < 1e-3) { nx = Math.cos(A.ang + 1.3); ny = Math.sin(A.ang + 1.3); l = 1; }   // tepat bertumpuk: pilih arah apa saja
      nx /= l; ny /= l;
      const mA = massOf(A), mB = massOf(B), sA = mB / (mA + mB), sB = mA / (mA + mB);    // yang ringan terlempar lebih jauh
      const step = Math.max(1.5, UNTANGLE_PUSH * dt);
      const movedA = A.npc && !A.stunT ? false : shift(A, nx * step * sA * 2, ny * step * sA * 2);
      const movedB = B.npc && !B.stunT ? false : shift(B, -nx * step * sB * 2, -ny * step * sB * 2);
      if (!movedA && !movedB) { shift(A, nx * step, ny * step); shift(B, -nx * step, -ny * step); }
      if ((A.untangleCd || 0) <= 0 && (B.untangleCd || 0) <= 0) {           // hentakan terpental + efek, sekali tiap ±0,6 dtk
        A.untangleCd = B.untangleCd = 0.6;
        A.kx = (A.kx || 0) + nx * UNTANGLE_KICK * sA; A.ky = (A.ky || 0) + ny * UNTANGLE_KICK * sA; A.knockDecay = 2.2;
        B.kx = (B.kx || 0) - nx * UNTANGLE_KICK * sB; B.ky = (B.ky || 0) - ny * UNTANGLE_KICK * sB; B.knockDecay = 2.2;
        A.spin = clamp((A.spin || 0) + (Math.random() - 0.5) * 1.2 * sA, -1.5, 1.5);
        B.spin = clamp((B.spin || 0) + (Math.random() - 0.5) * 1.2 * sB, -1.5, 1.5);
        if (A.npc) A.stunT = Math.max(A.stunT || 0, 1.2);
        if (B.npc) B.stunT = Math.max(B.stunT || 0, 1.2);
        spawnCrash((ax + bx) / 2, (ay + by) / 2, nx, ny, 10, A.color);
        if (A === P.veh || B === P.veh) { tone(180, 0.1, 0.05, 'square'); rumble(0.3, 160); }
      }
    }
  }
  for (const v of list) if (v.untangleCd > 0) v.untangleCd -= dt;
}

function decayKnock(o, dt) {
  const k = Math.exp(-dt * (o.knockDecay || 3)), ks = Math.exp(-dt * 2.8);
  o.kx = (o.kx || 0) * k; o.ky = (o.ky || 0) * k; o.spin = (o.spin || 0) * ks;
  if (Math.hypot(o.kx, o.ky) < 0.5) { o.kx = 0; o.ky = 0; }
  if (Math.abs(o.spin) < 0.01) o.spin = 0;
}

/* ----- efek tabrakan: percikan api, serpihan, asap (dipakai render 2D & 3D) ----- */
const FX = [];
function spawnCrash(x, y, nx, ny, power, color) {
  const n = Math.min(40, 6 + Math.round(power / 4));
  for (let i = 0; i < n; i++) {                       // percikan api: cepat, menyala, sebentar
    const a = Math.atan2(ny, nx) + (Math.random() - 0.5) * 2.4, s = 60 + Math.random() * (90 + power * 1.5);
    FX.push({ k: 'spark', x, y, z: 6 + Math.random() * 10, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 40 + Math.random() * 90,
      life: 0.35 + Math.random() * 0.35, t: 0, col: Math.random() < 0.5 ? '#fde047' : '#fb923c' });
  }
  const nd = Math.min(10, 2 + Math.round(power / 15));
  for (let i = 0; i < nd; i++) {                      // serpihan bodi & kaca
    const a = Math.random() * 6.283, s = 30 + Math.random() * (40 + power);
    FX.push({ k: 'debris', x, y, z: 8, vx: Math.cos(a) * s + nx * 30, vy: Math.sin(a) * s + ny * 30, vz: 60 + Math.random() * 80,
      life: 1.4 + Math.random(), t: 0, col: Math.random() < 0.35 ? '#bfdbfe' : (color || '#6b7280'), rot: Math.random() * 6, spin: (Math.random() - 0.5) * 14 });
  }
  const ns = Math.min(8, 2 + Math.round(power / 20));
  for (let i = 0; i < ns; i++) {                      // asap / debu
    FX.push({ k: 'smoke', x: x + (Math.random() - 0.5) * 12, y: y + (Math.random() - 0.5) * 12, z: 6, vx: nx * 10 + (Math.random() - 0.5) * 20,
      vy: ny * 10 + (Math.random() - 0.5) * 20, vz: 12 + Math.random() * 10, life: 1.6 + Math.random() * 0.8, t: 0, r: 8 + Math.random() * 6 });
  }
  if (FX.length > 400) FX.splice(0, FX.length - 400);
}
function fxUpdate(dt) {
  for (let i = FX.length - 1; i >= 0; i--) {
    const f = FX[i];
    f.t += dt;
    if (f.t >= f.life) { FX.splice(i, 1); continue; }
    f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
    if (f.k === 'smoke') { f.vx *= 0.96; f.vy *= 0.96; f.r += (f.dark ? 8 : 14) * dt; }
    else if (f.k === 'fire') { f.vx *= 0.94; f.vy *= 0.94; f.r *= Math.exp(-dt * 1.6); }
    else {
      f.vz -= 420 * dt;                               // gravitasi
      if (f.z <= 0) { f.z = 0; f.vz *= -0.3; f.vx *= 0.6; f.vy *= 0.6; }
      if (f.k === 'debris') f.rot += f.spin * dt;
    }
  }
}
function drawFX2D() {
  if (!FX.length) return;
  for (const f of FX) {
    const a = 1 - f.t / f.life;
    if (f.k === 'smoke') {
      ctx.fillStyle = f.dark ? `rgba(38,38,42,${0.5 * a})` : `rgba(120,120,120,${0.35 * a})`; ctx.beginPath(); ctx.arc(f.x, f.y - f.z * 0.3, f.r, 0, 7); ctx.fill();
    } else if (f.k === 'fire') {
      ctx.fillStyle = f.col; ctx.globalAlpha = Math.min(1, a * 1.5); ctx.beginPath(); ctx.arc(f.x, f.y - f.z * 0.3, f.r, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    } else if (f.k === 'debris') {
      ctx.save(); ctx.translate(f.x, f.y - f.z * 0.3); ctx.rotate(f.rot); ctx.globalAlpha = Math.min(1, a * 2);
      ctx.fillStyle = f.col; ctx.fillRect(-2.5, -1.5, 5, 3); ctx.restore(); ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = f.col; ctx.globalAlpha = a; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(f.x, f.y - f.z * 0.3); ctx.lineTo(f.x - f.vx * 0.03, f.y - f.z * 0.3 - f.vy * 0.03); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}
function spawnFire(x, y, n = 3, big = 1) {             // api kendaraan hancur
  for (let i = 0; i < n; i++) {
    FX.push({ k: 'fire', x: x + (Math.random() - 0.5) * 10 * big, y: y + (Math.random() - 0.5) * 10 * big, z: 6 + Math.random() * 6,
      vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8, vz: 22 + Math.random() * 22, life: 0.45 + Math.random() * 0.45, t: 0,
      r: (3 + Math.random() * 3.5) * big, col: Math.random() < 0.45 ? '#fde047' : Math.random() < 0.6 ? '#fb923c' : '#ef4444' });
  }
  if (FX.length > 500) FX.splice(0, FX.length - 500);
}
function spawnSmoke(x, y, dark, big = 1) {
  FX.push({ k: 'smoke', x: x + (Math.random() - 0.5) * 6, y: y + (Math.random() - 0.5) * 6, z: 10, vx: (Math.random() - 0.5) * 12,
    vy: (Math.random() - 0.5) * 12, vz: 16 + Math.random() * 12, life: 1.8 + Math.random() * 1.2, t: 0, r: (5 + Math.random() * 4) * big, dark });
  if (FX.length > 500) FX.splice(0, FX.length - 500);
}
function spawnFalconSmoke(V) {
  const [x, y] = local2world(V, -11, 0), speed = 10 + Math.random() * 12;
  FX.push({ k: 'smoke', x, y, z: (V.alt || 0) + 5, vx: -Math.cos(V.ang) * speed + (Math.random() - 0.5) * 8,
    vy: -Math.sin(V.ang) * speed + (Math.random() - 0.5) * 8, vz: 10 + Math.random() * 8,
    life: 1.2 + Math.random() * 0.7, t: 0, r: 3 + Math.random() * 3, dark: false, sourceId: V.id });
  if (FX.length > 500) FX.splice(0, FX.length - 500);
}

/* ----- kondisi kendaraan: penyok, berasap, sampai hancur & terbakar ----- */
const hpOf = (V) => V.hp ?? 100;
function enginePos(V) {
  const s = V.spec;
  return local2world(V, V.type === 'motor' ? 6 : s.front - Math.min(14, (s.front - s.rear) * 0.2), 0);
}
// benturan dengan kecepatan impact (px/s): kerusakan dibagi menurut massa — yang ringan lebih parah
function crashDamage(V, hit, impact) {
  const base = Math.max(0, impact - 18) * 0.45;
  if (!base) return;
  const m1 = massOf(V), o = hit && hit.other, m2 = o ? massOf(o) : 4;
  // jeda 0,5 dtk per kendaraan: kontak beruntun dalam satu tabrakan dihitung sekali
  if (!(V.dmgUntil > elapsed)) { damageVehicle(V, base * clamp(2 * m2 / (m1 + m2), 0.3, 1.7), true); V.dmgUntil = elapsed + 0.5; }
  if (o && !(o.dmgUntil > elapsed)) { damageVehicle(o, base * clamp(2 * m1 / (m1 + m2), 0.3, 1.8), true); o.dmgUntil = elapsed + 0.5; }
}
function damageVehicle(V, amt, byPlayer = false) {
  amt *= V.spec.damageRate ?? 1;
  if (V.wreck || !(amt > 0)) return;
  const before = hpOf(V);
  V.hp = Math.max(0, before - amt);
  if (V === P.veh && before >= 35 && V.hp < 35 && V.hp > 0) showToast(`⚠️ ${V.name} rusak berat — mesin pincang, berasap`, 3);
  if (V.hp > 0) return;
  V.wreck = true; V.wreckT = 0; V.v = 0; V.horn = false;
  const [ex, ey] = vehMid(V);
  spawnCrash(ex, ey, 0, 0, 130, '#1f2937'); spawnFire(ex, ey, 10, 1.2);
  for (let i = 0; i < 3; i++) spawnSmoke(ex, ey, true, 1.2);
  crashSound(140); rumble(1, 400); cam.shake = Math.min(1, cam.shake + 0.7);
  if (V.npc) {
    if (byPlayer) {
      const fine = V.type === 'motor' ? 1500000 : V.type === 'car' ? 4000000 : 7000000;
      P.money = Math.max(0, P.money - fine);
      showToast(`💥 Kendaraan lain hancur! Ganti rugi ${rupiah(fine)}`, 3.5);
    }
  } else if (V === P.veh && P.mode === 'drive') {
    showToast(`💥 ${V.name} HANCUR! Mesin mati — turun (Y), lalu A di dekatnya untuk panggil montir`, 5);
  } else showToast(`💥 ${V.name} hancur!`, 3);
}
const REPAIR_BASE = { motor: 1.5, car: 6, minitruck: 8, box: 10, tractor: 14, custom: 9 };
const repairCost = (V) => Math.round(((100 - hpOf(V)) / 100 + (V.wreck ? 0.5 : 0)) * (V.spec.model === 'bus' ? 12 : REPAIR_BASE[V.type] || 6) * 1000) * 1000;
function repairVehicle(V) {
  const cost = repairCost(V);
  if (!buy(cost, `perbaikan ${V.name}`)) return;
  Object.assign(V, { hp: 100, wreck: false, wreckT: 0 });
  showToast(`🔧 Montir datang — ${V.name} kembali mulus (${rupiah(cost)})`, 3);
  tone(700, 0.08, 0.05, 'triangle'); tone(900, 0.1, 0.05, 'triangle', 0.1);
}
// pengendara motor terlempar saat benturan keras
function throwRider(V) {
  const s = V.spec;
  for (const [lx, ly] of [[s.door, -(s.hw + 12)], [s.door, s.hw + 12], [s.rear - 12, 0], [s.door, -(s.hw + 26)], [s.door, s.hw + 26]]) {
    const [x, y] = local2world(V, lx, ly);
    if (walkerBlocked(x, y)) continue;
    V.v = 0; V.horn = false; setHorn(false);
    Object.assign(P, { mode: 'walk', veh: null, x, y, ang: V.ang + Math.PI / 2 });
    P.energy = Math.max(0, P.energy - 8);
    showToast('🤕 Terjatuh dari motor! Tenaga −8 · Y untuk naik lagi', 3.5);
    return;
  }
}
// asap & api dari kendaraan rusak / hancur; NPC yang hancur diderek (muncul lagi) setelah 30 detik
function damageFx(dt) {
  const f = camFocus();
  for (const list of [vehicles, npcs]) for (const V of list) {
    const hp = hpOf(V);
    if (V.wreck) V.wreckT += dt;
    if (hp >= 60 && !V.wreck) continue;
    if (Math.abs(V.x - f.x) > 1400 || Math.abs(V.y - f.y) > 1400) continue;
    V.fxT -= dt;
    if (V.fxT > 0) continue;
    const [ex, ey] = enginePos(V);
    if (V.wreck) {
      const burning = V.wreckT < 14;
      if (burning) spawnFire(ex, ey, V.type === 'motor' ? 1 : 2, V.type === 'motor' ? 0.7 : 1.1);
      spawnSmoke(ex, ey, true, burning ? 1 : 0.8);
      V.fxT = burning ? 0.09 : 0.35;
    } else { spawnSmoke(ex, ey, hp < 30, hp < 30 ? 1 : 0.7); V.fxT = hp < 30 ? 0.22 : 0.6; }
  }
}

// suara benturan: dentum rendah + derau logam
let noiseBuf = null;
function crashSound(power) {
  const a = actx; if (!a || a.state !== 'running') return;
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate * 0.6, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
  }
  const t = a.currentTime, vol = clamp(power / 90, 0.15, 0.6);
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = noiseBuf; f.type = 'bandpass'; f.frequency.value = 900 + Math.random() * 900; f.Q.value = 0.8;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  src.connect(f); f.connect(g); g.connect(a.destination); src.start(t);
  tone(70 + Math.random() * 30, 0.22, vol * 0.5, 'sawtooth');
}

function schoolZoneCheck(V, dt) {
  // Pesawat dan heli tidak berlaku (sesuaikan nama properti jika berbeda, misal V.isAir)
  if (V.type === 'plane' || isVTOL(V)) return;

  schoolWarnT -= dt;
  const z = level.decor.find((d) => d.kind === 'schoolzone');
  if (!z || V.y < z.y0 || V.y > z.y1 || Math.abs(V.x - mainX(V.y)) > 120) return;
  if (clock < SCHOOL_HOURS[0] || clock > SCHOOL_HOURS[1]) return;
  const kmh = Math.abs(V.v) / PX_PER_M * 3.6;
  if (kmh > 30 && schoolWarnT <= 0) {
    schoolWarnT = 6;
    const fine = 50000;
    P.money = Math.max(0, P.money - fine);
    showToast(`⚠️ Zona sekolah Al-Irsyad! ${Math.round(kmh)} km/j (maks 30) — denda ${rupiah(fine)}`, 3.5);
    tone(880, 0.12, 0.05); tone(660, 0.16, 0.05, 'square', 0.14);
  }
}

// Gerbang tol: melintas gerbang pertama kali = masuk tol (tap e-toll), melintas gerbang berikutnya = keluar & bayar.
const TOLL_CLASS = { car: 'Gol. I', minitruck: 'Gol. II', box: 'Gol. II', tractor: 'Gol. IV/V' };
function tollCheck(V) {
  // Pesawat dan helikopter tidak berlaku/dikecualikan dari gerbang tol
  if (['plane', 'helicopter', 'falcon', 'paver', 'milling'].includes(V.type)) return;

  const gates = level.tollGates || [];
  const [mx, my] = vehMid(V);
  const g = gates.find((q) => inRect(mx, my, q.zone));
  if (!g) { V.atGate = null; return; }
  if (V.type === 'motor') {                     // sepeda motor tidak boleh masuk jalan tol
    if (V.v > 0) V.v = 0;
    if (V.atGate !== g.id) { V.atGate = g.id; showToast('🚫 Sepeda motor dilarang masuk jalan tol — putar balik (R untuk mundur)', 3.5); tone(220, 0.15, 0.05); }
    return;
  }
  if (V.atGate === g.id) return;                // masih di gerbang yang sama
  V.atGate = g.id;
  const nice = g.name.replace('GERBANG TOL', 'GT').replace(/\b(\w)(\w*)/g, (m, a, b) => a + b.toLowerCase()).replace('Gt', 'GT');
  if (!V.tollIn) {
    V.tollIn = g.id;
    tone(1320, 0.07, 0.05, 'sine'); tone(1760, 0.09, 0.05, 'sine', 0.08);
    showToast(`🛣️ Masuk tol di ${nice} — kartu e-toll ditempel. Bayar saat keluar.`, 3.5);
    return;
  }
  const fare = (level.tollFare && level.tollFare[tollType(V)]) || 25500;
  if (P.money < fare) { showToast(`Saldo tidak cukup untuk tarif tol ${rupiah(fare)}!`, 3); tone(220, 0.15, 0.05); return; }
  P.money -= fare; V.tollIn = null; coin();
  showToast(`🛣️ Keluar tol di ${nice} · ${TOLL_CLASS[tollType(V)] || 'Gol. I'} · tarif ${rupiah(fare)}`, 3.5);
}

/* ----------------------------- Bengkel: rakit kendaraan dari blok dasar ---- */
// Blok: mesin, roda + sumbu, sasis, kabin, muatan (+ warna). Spesifikasi fisika dihitung dari blok-blok itu,
// sehingga kendaraan rakitan benar-benar terasa beda (tarikan, kecepatan, berat, BBM, bisa tarik trailer, dll.).
const JT = 1_000_000;
const PARTS = {
  mesin: [
    { id: 'b13', name: 'Bensin 1.3 L', acc: 168, vf: 195, burn: 0.08, fuel: 'Pertalite', price: 10000, power: 1, mass: 0.25, cost: 8 * JT, hp: 95 },
    { id: 'd25', name: 'Diesel 2.5 L', acc: 140, vf: 165, burn: 0.14, fuel: 'Solar', price: 6800, power: 2, mass: 0.45, cost: 15 * JT, hp: 136 },
    { id: 'd60', name: 'Diesel 6.0 L Turbo', acc: 150, vf: 150, burn: 0.30, fuel: 'Solar', price: 6800, power: 3, mass: 0.8, cost: 35 * JT, hp: 280 },
  ],
  roda: [
    { id: 'r2s', name: '2 sumbu · roda kecil', axles: 2, r: 3.6, steer: 37, grip: 0.4, mass: 0.15, cost: 3 * JT },
    { id: 'r2b', name: '2 sumbu · roda besar', axles: 2, r: 5.2, steer: 34, grip: 0.65, mass: 0.3, cost: 6 * JT },
    { id: 'r3', name: '3 sumbu (tandem belakang)', axles: 3, r: 5.4, steer: 30, grip: 0.6, mass: 0.5, cost: 12 * JT },
  ],
  sasis: [
    { id: 's', name: 'Pendek (5,6 m)', len: 56, hw: 11.5, mass: 0.3, cost: 4 * JT },
    { id: 'm', name: 'Sedang (7,8 m)', len: 78, hw: 14.5, mass: 0.5, cost: 7 * JT },
    { id: 'l', name: 'Panjang (10 m)', len: 100, hw: 19, mass: 0.8, cost: 12 * JT },
  ],
  kabin: [
    { id: 'mobil', name: 'Kabin mobil (penumpang)', frac: 0.55, h: 15, mass: 0.15, cost: 5 * JT },
    { id: 'truk', name: 'Kabin truk', abs: 22, h: 27, mass: 0.3, cost: 8 * JT },
    { id: 'sleeper', name: 'Kabin truk sleeper (tidur)', abs: 30, h: 32, mass: 0.4, cost: 14 * JT },
  ],
  muatan: [
    { id: 'none', name: 'Tanpa muatan', mass: 0, cost: 0 },
    { id: 'bak', name: 'Bak terbuka', mass: 0.2, cost: 3 * JT },
    { id: 'boks', name: 'Boks tertutup', mass: 0.4, cost: 7 * JT },
    { id: 'tangki', name: 'Tangki', mass: 0.5, cost: 10 * JT },
    { id: 'fifth', name: 'Fifth wheel (tarik trailer)', mass: 0.2, cost: 9 * JT, tow: true },
  ],
  warna: ['#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#7c3aed', '#0f172a', '#f8fafc', '#0891b2', '#ea580c', '#64748b'],
};
const SLOTS = [['mesin', 'Mesin'], ['roda', 'Roda + sumbu'], ['sasis', 'Sasis'], ['kabin', 'Kabin'], ['muatan', 'Muatan'], ['warna', 'Warna']];
const partOf = (parts, slot) => (slot === 'warna' ? parts.warna : PARTS[slot].find((p) => p.id === parts[slot]) || PARTS[slot][0]);

function customGeom(parts) {         // geometri dasar: origin = sumbu roda belakang, x ke depan
  const sa = partOf(parts, 'sasis'), ka = partOf(parts, 'kabin'), ro = partOf(parts, 'roda');
  const len = sa.len, rear = -len * 0.2, front = len * 0.8, wb = len * 0.6;
  const cabLen = ka.abs || len * ka.frac, cab0 = front - cabLen;
  const tandem = ro.axles === 3 ? -ro.r * 2.3 : null;
  return { len, rear, front, wb, hw: sa.hw, cabLen, cab0, cabH: ka.h, tandem, wheelR: ro.r };
}
function customProblems(parts) {
  const out = [], m = partOf(parts, 'mesin'), ro = partOf(parts, 'roda'), sa = partOf(parts, 'sasis'), ka = partOf(parts, 'kabin'), mu = partOf(parts, 'muatan');
  if (mu.id === 'fifth' && m.power < 3) out.push('Fifth wheel butuh mesin Diesel 6.0 L Turbo untuk menarik trailer');
  if (mu.id === 'fifth' && ro.id === 'r2s') out.push('Fifth wheel butuh roda besar atau 3 sumbu');
  if (mu.id === 'fifth' && sa.id === 's') out.push('Fifth wheel butuh sasis sedang atau panjang');
  if (ka.id === 'sleeper' && sa.id === 's') out.push('Kabin sleeper terlalu panjang untuk sasis pendek');
  if (ro.id === 'r3' && sa.id === 's') out.push('3 sumbu tidak muat di sasis pendek');
  if ((mu.id === 'tangki' || mu.id === 'boks') && ka.id === 'mobil' && sa.id === 's') out.push('Sasis pendek + kabin mobil tidak menyisakan ruang muatan');
  return out;
}
function customSpec(parts) {
  const g = customGeom(parts), m = partOf(parts, 'mesin'), ro = partOf(parts, 'roda'), mu = partOf(parts, 'muatan');
  const mass = 0.6 + m.mass + ro.mass + partOf(parts, 'sasis').mass + partOf(parts, 'kabin').mass + mu.mass;
  return {
    wb: g.wb, front: g.front, rear: g.rear, hw: g.hw, fifth: mu.tow ? 4 : 0, door: g.cab0 + g.cabLen * 0.4,
    maxSteer: ro.steer * DEG, vf: m.vf * (ro.axles === 3 ? 0.92 : 1), vr: g.len > 80 ? 45 : 58,
    acc: m.acc * Math.sqrt(1.4 / mass), tank: Math.round(35 + g.len * 0.7 + (m.power - 1) * 25),
    burn: m.burn * (mass / 1.5), fuelName: m.fuel, price: m.price, canTow: !!mu.tow, mass, grip: ro.grip,
    model: 'custom', geom: g, parts: { ...parts },
  };
}
const customCost = (parts) => SLOTS.reduce((s, [k]) => s + (k === 'warna' ? 0 : partOf(parts, k).cost), 0);
const customTollType = (V) => {
  const p = V.spec.parts; if (!p) return 'car';
  if (p.muatan === 'fifth' || p.roda === 'r3') return 'tractor';
  return partOf(p, 'mesin').power >= 2 && p.muatan !== 'none' ? 'box' : 'car';
};
const tollType = (V) => (V.type === 'custom' ? customTollType(V) : V.spec.model === 'bus' ? 'box' : V.type === 'dump' || V.type === 'paver' || V.type === 'milling' || V.type === 'tanker' ? 'box' : V.type);

// ---- gambar kendaraan rakitan (tampak atas), dipakai di dunia 2D & pratinjau bengkel
function drawCustomTop(g, V, now, opts = {}) {
  const s = V.spec, G = s.geom, p = s.parts, hw = G.hw, col = V.color;
  g.save(); g.translate(V.x, V.y); g.rotate(V.ang);
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(G.rear + 3, -hw + 3, G.front - G.rear, hw * 2);
  const axles = [0, G.wb]; if (G.tandem != null) axles.push(G.tandem);
  for (const ax of axles) for (const sy of [-1, 1]) {
    g.save(); g.translate(ax, sy * (hw - 1)); if (ax === G.wb) g.rotate(V.steer || 0);
    g.fillStyle = '#0e0f11'; g.fillRect(-G.wheelR * 1.4, -G.wheelR * 0.7, G.wheelR * 2.8, G.wheelR * 1.4); g.restore();
  }
  g.fillStyle = '#374151'; g.fillRect(G.rear, -hw * 0.45, G.cab0 - G.rear, hw * 0.9);                   // sasis (rel)
  const c0 = G.rear, c1 = G.cab0 - 2;
  if (p.muatan === 'bak') {
    g.fillStyle = '#6b4423'; g.fillRect(c0, -hw, c1 - c0, hw * 2); g.fillStyle = '#a16207'; g.fillRect(c0 + 2, -hw + 2, c1 - c0 - 4, hw * 2 - 4);
    g.strokeStyle = 'rgba(60,30,10,0.5)'; g.lineWidth = 0.8; for (let x = c0 + 6; x < c1 - 3; x += 6) { g.beginPath(); g.moveTo(x, -hw + 2); g.lineTo(x, hw - 2); g.stroke(); }
  } else if (p.muatan === 'boks') {
    g.fillStyle = '#e5e7eb'; g.fillRect(c0, -hw, c1 - c0, hw * 2); g.strokeStyle = 'rgba(0,0,0,0.2)'; g.lineWidth = 1;
    for (let x = c0 + 10; x < c1; x += 10) { g.beginPath(); g.moveTo(x, -hw); g.lineTo(x, hw); g.stroke(); }
    g.fillStyle = col; g.fillRect(c0, -hw, c1 - c0, 3); g.fillRect(c0, hw - 3, c1 - c0, 3);
  } else if (p.muatan === 'tangki') {
    g.fillStyle = '#cbd5e1'; g.beginPath(); g.roundRect(c0, -hw + 1, c1 - c0, hw * 2 - 2, hw - 1); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(c0 + hw * 0.6, -hw * 0.25, c1 - c0 - hw * 1.2, hw * 0.3);
    g.fillStyle = '#64748b'; g.beginPath(); g.arc((c0 + c1) / 2, 0, 3, 0, 7); g.fill();
  } else if (p.muatan === 'fifth') {
    g.fillStyle = '#6b7280'; g.beginPath(); g.arc(s.fifth, 0, Math.min(11, hw * 0.7), 0, 7); g.fill();
    g.fillStyle = '#1f2937'; g.fillRect(s.fifth - 12, -2.5, 12, 5);
  }
  // kabin
  const k0 = G.cab0, k1 = G.front, car = p.kabin === 'mobil';
  g.fillStyle = col; g.beginPath(); g.roundRect(k0, -hw + 0.5, k1 - k0, hw * 2 - 1, car ? 5 : 2); g.fill();
  g.fillStyle = 'rgba(15,23,42,0.78)';
  if (car) { g.fillRect(k0 + (k1 - k0) * 0.62, -hw + 2.5, 5, hw * 2 - 5); g.fillRect(k0 + 2, -hw + 2.5, 3.5, hw * 2 - 5); }
  else { g.fillRect(k1 - 6, -hw + 3, 4, hw * 2 - 6); }
  g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(k0 + (car ? 7 : 3), -hw + 3, (k1 - k0) * (car ? 0.45 : 0.4), hw * 2 - 6);
  if (p.kabin === 'sleeper') { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(k0 + 2, -hw + 3, 8, hw * 2 - 6); }
  g.fillStyle = '#fde68a'; g.fillRect(k1 - 2, -hw + 1, 2, 4); g.fillRect(k1 - 2, hw - 5, 2, 4);
  if (!opts.preview) { tailLights(V, G.rear, hw, 1); drawHorn(V, now); }
  g.restore();
}
// tampak samping (hanya pratinjau bengkel)
function drawCustomSide(g, parts, cx, base, k) {
  const sp = customSpec(parts), G = sp.geom, col = parts.warna, m = partOf(parts, 'mesin');
  const X = (x) => cx + (x - (G.front + G.rear) / 2) * k, Y = (y) => base - y * k;
  const r = G.wheelR;
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(X(G.rear), Y(0) - 2, (G.front - G.rear) * k, 4);
  g.fillStyle = '#374151'; g.fillRect(X(G.rear), Y(r * 2 + 2), (G.front - G.rear) * k, 3 * k);                         // sasis
  const top = r * 2 + 2;
  if (parts.muatan === 'bak') { g.fillStyle = '#a16207'; g.fillRect(X(G.rear), Y(top + 9), (G.cab0 - 2 - G.rear) * k, 9 * k); }
  else if (parts.muatan === 'boks') { g.fillStyle = '#e5e7eb'; g.fillRect(X(G.rear), Y(top + 27), (G.cab0 - 2 - G.rear) * k, 27 * k); g.fillStyle = col; g.fillRect(X(G.rear), Y(top + 27), (G.cab0 - 2 - G.rear) * k, 3 * k); }
  else if (parts.muatan === 'tangki') { g.fillStyle = '#cbd5e1'; g.beginPath(); g.roundRect(X(G.rear), Y(top + 22), (G.cab0 - 2 - G.rear) * k, 21 * k, 10 * k); g.fill(); }
  else if (parts.muatan === 'fifth') { g.fillStyle = '#6b7280'; g.fillRect(X(sp.fifth - 10), Y(top + 3), 20 * k, 3 * k); }
  // kabin + kaca
  const ch = G.cabH;
  g.fillStyle = col; g.beginPath(); g.roundRect(X(G.cab0), Y(top + ch - 2), G.cabLen * k, (ch) * k, (parts.kabin === 'mobil' ? 5 : 2) * k); g.fill();
  g.fillStyle = '#1e3a5f';
  if (parts.kabin === 'mobil') g.fillRect(X(G.cab0 + G.cabLen * 0.2), Y(top + ch - 4), G.cabLen * 0.55 * k, 6 * k);
  else g.fillRect(X(G.front - 12), Y(top + ch - 5), 10 * k, 9 * k);
  // mesin (blok di bawah kabin / kap)
  const ew = m.power === 3 ? 16 : m.power === 2 ? 12 : 9;
  g.fillStyle = '#9ca3af'; g.fillRect(X(G.front - ew - 3), Y(top + 6), ew * k, 6 * k);
  g.fillStyle = '#ef4444'; g.fillRect(X(G.front - ew - 3), Y(top + 6), ew * k, 1.2 * k);
  // roda
  const axles = [0, G.wb]; if (G.tandem != null) axles.push(G.tandem);
  for (const ax of axles) { g.fillStyle = '#0e0f11'; g.beginPath(); g.arc(X(ax), Y(r), r * k, 0, 7); g.fill(); g.fillStyle = '#9ca3af'; g.beginPath(); g.arc(X(ax), Y(r), r * 0.45 * k, 0, 7); g.fill(); }
}

// ---- mode rakit (overlay HTML)
const BUILD = { open: false, slot: 0, parts: { mesin: 'd25', roda: 'r2b', sasis: 'm', kabin: 'truk', muatan: 'bak', warna: '#ea580c' }, lastX: 0, rep: 0 };
function openBuilder() {
  BUILD.open = true; BUILD.slot = 0; BUILD.lastX = 0; BUILD.lastY = 0;
  $('builder').classList.remove('hidden');
  P.busy = ''; setHorn(false);
  tone(520, 0.08, 0.05, 'triangle'); tone(780, 0.1, 0.05, 'triangle', 0.08);
  renderBuilder();
}
function closeBuilder() { BUILD.open = false; $('builder').classList.add('hidden'); }
function cyclePart(slot, dir) {
  const list = PARTS[slot];
  if (slot === 'warna') { const i = list.indexOf(BUILD.parts.warna); BUILD.parts.warna = list[(i + dir + list.length) % list.length]; }
  else { const i = list.findIndex((p) => p.id === BUILD.parts[slot]); BUILD.parts[slot] = list[(i + dir + list.length) % list.length].id; }
  tone(660, 0.04, 0.03, 'sine');
  renderBuilder();
}
function builderStats(parts) {
  const sp = customSpec(parts), kmh = (v) => Math.round(v / PX_PER_M * 3.6);
  return [
    ['Kecepatan maks', `${kmh(sp.vf)} km/j`], ['Tarikan', `${Math.round(sp.acc)} (${sp.acc > 140 ? 'gesit' : sp.acc > 105 ? 'sedang' : 'berat'})`],
    ['Berat', `${(sp.mass * 1.9).toFixed(1)} ton`], ['Panjang', `${(sp.geom.len / PX_PER_M).toFixed(1)} m`],
    ['BBM · tangki', `${sp.fuelName} · ${sp.tank} L`], ['Di luar aspal', sp.grip >= 0.6 ? 'kuat' : 'lambat'],
    ['Tarik trailer', sp.canTow ? 'BISA' : 'tidak'], ['Golongan tol', ({ car: 'Gol. I', box: 'Gol. II', tractor: 'Gol. IV/V' })[customTollType({ spec: sp })]],
  ];
}
function renderBuilder() {
  const parts = BUILD.parts;
  $('bSlots').innerHTML = SLOTS.map(([k, label], i) => {
    const p = partOf(parts, k);
    const val = k === 'warna' ? `<i class="sw" style="background:${p}"></i>` : `${p.name}<small>${p.cost ? rupiah(p.cost) : 'gratis'}</small>`;
    return `<div class="bslot${i === BUILD.slot ? ' on' : ''}" data-i="${i}"><span>${label}</span><b><em>‹</em><span class="v">${val}</span><em>›</em></b></div>`;
  }).join('');
  $('bStats').innerHTML = builderStats(parts).map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('');
  const probs = customProblems(parts), cost = customCost(parts);
  $('bWarn').innerHTML = probs.map((t) => `⚠️ ${t}`).join('<br>');
  $('bCost').textContent = `Total ${rupiah(cost)} · uang ${rupiah(P.money)}`;
  $('bBuild').disabled = probs.length > 0 || P.money < cost;
  // pratinjau: tampak samping & atas
  const cv = $('bPreview'), g = cv.getContext('2d'), W2 = cv.width, H2 = cv.height;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W2, H2);
  g.fillStyle = '#1f2937'; g.fillRect(0, 0, W2, H2);
  g.strokeStyle = 'rgba(255,255,255,0.06)'; for (let x = 0; x < W2; x += 20) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H2); g.stroke(); }
  g.fillStyle = '#4b5563'; g.fillRect(0, H2 * 0.52, W2, 3);
  const k = Math.min(3.2, (W2 - 60) / 110);
  drawCustomSide(g, parts, W2 / 2, H2 * 0.52, k);
  const sp = customSpec(parts), fake = { x: 0, y: 0, ang: 0, steer: 0, color: parts.warna, spec: sp };
  g.save(); g.translate(W2 / 2 - ((sp.front + sp.rear) / 2) * k, H2 * 0.79); g.scale(k, k);
  drawCustomTop(g, fake, 0, { preview: true }); g.restore();
  g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '12px sans-serif'; g.fillText('tampak samping', 10, 18); g.fillText('tampak atas', 10, H2 * 0.6);
}
function buildVehicle() {
  const parts = { ...BUILD.parts }, probs = customProblems(parts), cost = customCost(parts);
  if (probs.length) { showToast(probs[0], 3); tone(220, 0.12, 0.05); return; }
  if (P.money < cost) { showToast(`Uang belum cukup: perlu ${rupiah(cost)}`, 3); tone(220, 0.12, 0.05); return; }
  P.built = (P.built || 0) + 1;
  const def = { id: `rakit-${Date.now().toString(36)}`, name: `Rakitan ${P.built}`, type: 'custom', parts, color: parts.warna, fuel: 1 };
  const veh = makeVehicle(def);
  const spot = level.bengkel.lot.find((l) => { Object.assign(veh, { x: l.x, y: l.y, ang: l.angle * DEG }); return !collidesOther(veh); });
  if (!spot) { P.built--; showToast('Parkiran bengkel penuh — pindahkan dulu kendaraan yang menghalangi', 3); return; }
  P.money -= cost; P.owned = [...(P.owned || []), def]; vehicles.push(veh);
  closeBuilder(); coin(); rumble(0.5, 250);
  showBanner(`🔧 ${def.name} selesai dirakit!<small>${partOf(parts, 'mesin').name} · ${partOf(parts, 'roda').name} · sasis ${partOf(parts, 'sasis').name}<br>
    ${partOf(parts, 'kabin').name} · ${partOf(parts, 'muatan').name} — biaya ${rupiah(cost)}<br>Menunggu di parkiran bengkel, tangki penuh. Tekan Y di dekatnya untuk naik.</small>`, 5);
}
function builderUpdate(inp) {
  // navigasi: atas/bawah = pilih blok, kiri/kanan = ganti pilihan (stik / D-pad / panah)
  const sx = Math.abs(inp.mx) > 0.5 ? Math.sign(inp.mx) : 0, sy = Math.abs(inp.my) > 0.5 ? Math.sign(inp.my) : 0;
  const ex = inp.navX || (sx && sx !== BUILD.lastX ? sx : 0), ey = inp.navY || (sy && sy !== BUILD.lastY ? sy : 0);
  if (ex) cyclePart(SLOTS[BUILD.slot][0], ex);
  if (ey) { BUILD.slot = (BUILD.slot + ey + SLOTS.length) % SLOTS.length; tone(500, 0.03, 0.03, 'sine'); renderBuilder(); }
  BUILD.lastX = sx; BUILD.lastY = sy;
  if (inp.a) buildVehicle();
  if (inp.b || inp.start || inp.y) closeBuilder();
}

/* ----------------------------- Lampu lalu lintas ------------------------- */
// Siklus 2 fase: fase 0 (jalan raya) hijau -> kuning -> merah semua -> fase 1 hijau -> kuning -> merah semua.
// Setiap simpang punya offset acak agar tidak serempak. Waktu memakai `elapsed` (berhenti saat jeda).
const SIG_ARMS = [];                   // semua lengan simpang (diisi saat level dimuat)
function sigCycle() { const c = level.signalCycle; return c.g0 + c.y0 + c.r0 + c.g1 + c.y1 + c.r1; }
function sigState(sig, phase) {        // 'g' | 'y' | 'r'
  const c = level.signalCycle, t = ((elapsed + sig.offset) % sigCycle() + sigCycle()) % sigCycle();
  const a0 = c.g0, a1 = a0 + c.y0, a2 = a1 + c.r0, a3 = a2 + c.g1, a4 = a3 + c.y1;
  if (phase === 0) return t < a0 ? 'g' : t < a1 ? 'y' : 'r';
  return t >= a2 && t < a3 ? 'g' : t >= a3 && t < a4 ? 'y' : 'r';
}
// sisa detik lampu saat ini (countdown timer pada tiang lampu)
function sigCountdown(sig, phase) {
  const c = level.signalCycle, total = sigCycle();
  const t = ((elapsed + sig.offset) % total + total) % total;
  const a0 = c.g0, a1 = a0 + c.y0, a2 = a1 + c.r0, a3 = a2 + c.g1, a4 = a3 + c.y1;
  let st = 'r', rem = 0;
  if (phase === 0) {
    if (t < a0) { st = 'g'; rem = a0 - t; }
    else if (t < a1) { st = 'y'; rem = a1 - t; }
    else { st = 'r'; rem = total - t; }
  } else {
    if (t < a2) { st = 'r'; rem = a2 - t; }
    else if (t < a3) { st = 'g'; rem = a3 - t; }
    else if (t < a4) { st = 'y'; rem = a4 - t; }
    else { st = 'r'; rem = (total - t) + a2; }
  }
  return { state: st, sec: Math.max(1, Math.ceil(rem)) };
}
function initSignals() {
  SIG_ARMS.length = 0;
  for (const sg of level.signals || []) for (const a of sg.arms) { a.sig = sg; SIG_ARMS.push(a); }
}
// lengan yang sedang didekati kendaraan V (searah & di badan jalan lengan itu); d = jarak bemper depan ke garis henti
function armAhead(V, maxD = 90) {
  const fx = Math.cos(V.ang), fy = Math.sin(V.ang);
  const bx = V.x + fx * V.spec.front, by = V.y + fy * V.spec.front;
  let best = null;
  for (const a of SIG_ARMS) {
    if (fx * a.ux + fy * a.uy < 0.7) continue;
    const dx = a.sx - bx, dy = a.sy - by, d = dx * a.ux + dy * a.uy;
    if (d < -40 || d > maxD) continue;
    const lat = Math.abs(-dx * a.uy + dy * a.ux);
    if (lat > a.w / 2 + 6) continue;
    if (!best || d < best.d) best = { a, d };
  }
  return best;
}

// pemain menerobos lampu merah -> denda tilang
function redLightCheck(V, dt) {
  // Abaikan jika kendaraan adalah pesawat atau helikopter
  if (!V || V.type === 'plane' || isVTOL(V)) return;
  
  V.sigCd = Math.max(0, (V.sigCd || 0) - dt);
  const hit = armAhead(V, 60);
  const prev = V.sigPrev;
  V.sigPrev = hit ? { a: hit.a, d: hit.d } : null;
  
  if (!hit || !prev || prev.a !== hit.a) return;
  
  // Baru saja melewati garis henti dengan kecepatan > 8 dan cooldown tilang habis
  if (prev.d > 0 && hit.d <= 0 && V.v > 8 && V.sigCd <= 0) {         
    const st = sigState(hit.a.sig, hit.a.phase);
    if (st === 'r') {
      const fine = 100000;
      P.money = Math.max(0, P.money - fine); 
      V.sigCd = 4; 
      P.tilang = (P.tilang || 0) + 1;
      
      showToast(`🚦 Terobos lampu merah! Tilang ${rupiah(fine)}`, 3.5);
      tone(880, 0.12, 0.06); 
      tone(660, 0.12, 0.06, 'square', 0.14); 
      tone(880, 0.12, 0.06, 'square', 0.28);
      rumble(0.3, 150);
    }
  }
}

const SIG_COL = { r: '#ef4444', y: '#facc15', g: '#22c55e' };
function drawSignals2D(v) {
  for (const sg of level.signals || []) {
    if (!visible(v, sg.x - 220, sg.y - 220, sg.x + 220, sg.y + 220)) continue;
    for (const a of sg.arms) {
      const scInfo = sigCountdown(sg, a.phase);
      const st = scInfo.state, lx = a.uy, ly = -a.ux;
      // garis henti di lajur datang (lajur kiri)
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(a.sx + lx * 3, a.sy + ly * 3); ctx.lineTo(a.sx + lx * (a.w / 2 - 8), a.sy + ly * (a.w / 2 - 8)); ctx.stroke();
      // tiang + kepala lampu menghadap pengendara yang datang
      ctx.save(); ctx.translate(a.px, a.py); ctx.rotate(Math.atan2(a.uy, a.ux));
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(-4, -11, 10, 24);
      ctx.fillStyle = '#1f2937'; ctx.fillRect(-6, -12, 9, 24);
      ['r', 'y', 'g'].forEach((c, i) => {
        const on = st === c;
        ctx.fillStyle = on ? SIG_COL[c] : 'rgba(255,255,255,0.12)';
        ctx.beginPath(); ctx.arc(-1.5, -7 + i * 7, 2.6, 0, 7); ctx.fill();
        if (on) {
          const g = ctx.createRadialGradient(-1.5, -7 + i * 7, 0, -1.5, -7 + i * 7, 14);
          g.addColorStop(0, SIG_COL[c] + 'aa'); g.addColorStop(1, SIG_COL[c] + '00');
          ctx.fillStyle = g; ctx.fillRect(-16, -21 + i * 7, 30, 28);
        }
      });
      // display countdown digital kecil di atas kepala tiang lampu
      ctx.fillStyle = '#0f172a'; ctx.fillRect(-5, -23, 7, 9);
      ctx.fillStyle = st === 'r' ? '#ef4444' : st === 'g' ? '#22c55e' : '#facc15';
      ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(scInfo.sec), -1.5, -18.5);
      ctx.restore();
    }
  }
}

/* ----- AMP, dump truck & asphalt paver ----- */
const AMPC = () => level.amp || { price: 2000000, payPerMeter: 40000, millPerMeter: 25000, loadLen: 1000, paveW: 70, chute: { x: -1e9, y: -1e9, w: 0, h: 0 } };
function nearPaverHopper(V) {                    // dump truck mundur sampai bak menempel hopper depan paver
  const [rx, ry] = local2world(V, V.spec.rear, 0);
  for (const pv of vehicles) {
    if (pv.type !== 'paver') continue;
    const [hx, hy] = local2world(pv, pv.spec.front + 2, 0);
    if (Math.hypot(rx - hx, ry - hy) < 40 && Math.abs(wrap(V.ang - pv.ang)) < 35 * DEG) return pv;
  }
  return null;
}
const isDumpTruck = (V) => V.type === 'dump' || V.spec.model === 'manhx8x8';
function inChute(V) { const c = AMPC().chute, [mx, my] = vehMid(V); return mx > c.x - 8 && mx < c.x + c.w + 8 && my > c.y - 10 && my < c.y + c.h + 10; }
function nearTowVehicle(V) {
  if (!V.spec.canTowVehicle || V.hooked || V.towedBy) return null;
  const [hx, hy] = towVehiclePoint(V), co = Math.cos(V.ang), si = Math.sin(V.ang);
  let nearest = null, nearestDistance = Infinity;
  for (const candidate of vehicles) {
    if (candidate === V || candidate.npc || candidate.hooked || candidate.towing || candidate.towedBy) continue;
    if (Math.abs(candidate.v) > 3 || (!candidate.wreck && candidate.gear !== 'P')) continue;
    const [mx, my] = vehMid(candidate), dx = mx - hx, dy = my - hy;
    const behind = dx * co + dy * si;
    const side = Math.abs(-dx * si + dy * co);
    const distance = Math.hypot(dx, dy);
    if (behind > -15 || side > 62 || distance > 105 || distance >= nearestDistance) continue;
    nearest = candidate;
    nearestDistance = distance;
  }
  return nearest;
}
function attachTowVehicle(V, target) {
  if (Math.abs(V.v) > 3 || Math.abs(target.v) > 3) { showToast('Berhentikan kedua kendaraan sebelum menyambung derek'); return; }
  const [hx, hy] = towVehiclePoint(V), old = { x: target.x, y: target.y, ang: target.ang };
  const tFront = (target.spec && typeof target.spec.front === 'number' && !isNaN(target.spec.front)) ? target.spec.front : 15;
  target.ang = V.ang;
  target.x = hx - Math.cos(V.ang) * tFront;
  target.y = hy - Math.sin(V.ang) * tFront;
  V.towing = target;
  target.towedBy = V;
  if (collidesOther(target)) {
    V.towing = null;
    target.towedBy = null;
    Object.assign(target, old);
    showToast('Tidak ada ruang aman untuk menyambungkan kendaraan derek');
    return;
  }
  target.v = 0;
  target.gear = 'P';
  showToast(`🔗 ${target.name} tersambung — B untuk melepas`);
}
function detachTowVehicle(V) {
  if (!V.towing) return;
  const target = V.towing;
  const old = { x: target.x, y: target.y };
  V.towing = null;
  target.towedBy = null;
  const co = Math.cos(V.ang), si = Math.sin(V.ang);
  let clear = false;
  for (let offset = 0; offset <= 64; offset += 1) {
    target.x = old.x - co * offset;
    target.y = old.y - si * offset;
    if (overlap(vehPoly(V), vehPoly(target))) continue;
    clear = !collidesOther(target);
    break;
  }
  if (!clear) {
    target.x = old.x;
    target.y = old.y;
    V.towing = target;
    target.towedBy = V;
    showToast(`Tidak ada ruang aman untuk melepas ${target.name} — maju ke tempat terbuka`);
    return;
  }
  target.v = 0;
  target.gear = 'P';
  showToast(`${target.name} dilepas dari derek`);
}
function dumpAction(V) {
  if (V.tipT > 0 || V.loadT > 0) return;
  if (V.towing || V.towedBy) { showToast('Lepaskan kendaraan derek sebelum memuat atau menuang hotmix'); return; }
  if (inChute(V)) {
    if (Math.abs(V.v) > 3) { showToast('Berhenti dulu di bawah silo'); return; }
    if (V.load >= 0.99) { showToast('Bak sudah penuh hotmix — bawa ke paver'); return; }
    const cost = Math.round(AMPC().price * (1 - V.load) / 1000) * 1000;
    if (!buy(cost, 'hotmix')) return;
    V.loadT = 4; tone(180, 0.6, 0.05, 'sawtooth');
    showToast(`🏗️ Memuat hotmix ${rupiah(cost)} — tunggu, jangan bergerak…`, 4);
    return;
  }
  if (V.load > 0.01) {
    const pv = nearPaverHopper(V);
    if (!pv) { showToast('Mundurkan dump truck lurus sampai bak menempel hopper DEPAN paver, lalu A', 3.5); return; }
    if (pv.asphalt >= 0.99) { showToast('Hopper paver masih penuh — gelar aspal dulu'); return; }
    V.tipT = 3.2; V.gear = 'P'; V.tipTarget = pv; tone(140, 0.8, 0.05, 'sawtooth');
    showToast('⬆️ Bak diangkat — hotmix dituang ke hopper paver…', 3);
    return;
  }
  showToast('Bak kosong — isi hotmix di Silo AMP (Jl. Raya Suruh, ikon 🏗️)', 3.5);
}
function paverAction(V) {
  if (V.paving) { stopPaving(V, 'Screed diangkat — penggelaran dihentikan'); return; }
  if (V.asphalt <= 0.005) { showToast('Hopper kosong — tuang hotmix dari dump truck (mundurkan dump truck ke depan paver)', 4); return; }
  
  V.paving = true; 
  // Langsung masukkan titik awal saat A ditekan agar aspal langsung keluar seketika
  const [sx, sy] = local2world(V, V.spec.rear - 2, 0);
  BUILT.cur = { pts: [[sx, sy]], w: AMPC().paveW, len: 0 };
  
  tone(330, 0.15, 0.05, 'square');
  showToast(`🛣️ Screed turun — maju pelan untuk menggelar aspal (sisa ${Math.round(V.asphalt * AMPC().loadLen / PX_PER_M)} m). A lagi untuk berhenti`, 4);
}
function finishStrip() {
  const cur = BUILT.cur; BUILT.cur = null;
  if (!cur || cur.pts.length < 2 || cur.len < 20) return 0;
  const r = { pts: cur.pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]), w: cur.w };
  BUILT.roads.push(r); builtIndex(r); BUILT.ver++;
  fetch('/api/roads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...r, by: playerName }) })
    .catch(() => showToast('⚠️ Server tidak bisa menyimpan jalan baru ke settings.json', 3));
  const m = cur.len / PX_PER_M, pay = Math.round(m * AMPC().payPerMeter / 1000) * 1000;
  const scoreGained = Math.round(m * 2);
  P.money += pay;
  P.extraScore = (P.extraScore || 0) + scoreGained;
  if (pay > 0) coin();
  return { m, pay, score: scoreGained };
}
function stopPaving(V, why) {
  V.paving = false;
  const res = finishStrip();
  const m = res ? res.m : 0, pay = res ? res.pay : 0, sc = res ? res.score : 0;
  showToast(`${why}${m > 0 ? ` · ${m.toFixed(0)} m jalan baru (+${sc} skor) · bayaran ${rupiah(pay)}` : ''}`, 4);
}
function paverStep(V, dt) {
  if (!V.paving) return;
  if (V.v > 22) V.v = 22;                                   // ±8 km/j saat menggelar
  
  // Ubah batas minimal kecepatan dari 1 menjadi 0 agar langsung merespons saat mulai jalan
  if (V.v <= 0) return; 
  
  const cur = BUILT.cur || (BUILT.cur = { pts: [], w: AMPC().paveW, len: 0 });
  const [sx, sy] = local2world(V, V.spec.rear - 2, 0), last = cur.pts[cur.pts.length - 1];
  
  if (last && Math.hypot(sx - last[0], sy - last[1]) < 12) return;
  
  const d = last ? Math.hypot(sx - last[0], sy - last[1]) : 0;
  cur.pts.push([sx, sy]); cur.len += d;
  V.asphalt = Math.max(0, V.asphalt - d / AMPC().loadLen);
  if (Math.random() < 0.5) spawnSmoke(sx + (Math.random() - 0.5) * 40, sy + (Math.random() - 0.5) * 40, false, 0.6);   // uap aspal panas
  if (V.asphalt <= 0) stopPaving(V, '🛣️ Hotmix habis');
}
/* ----- Road milling (Sakai ER 550F): kupas / hapus aspal jalan buatan paver ----- */
const MILL_R = 26;                                         // radius kupasan drum (px): ruas jalan yang as-nya masuk lingkaran ini terhapus
function cutPolyline(pts, cx, cy, rad) {                   // potong polyline: bagian di dalam lingkaran dibuang; hasil = daftar potongan
  const pieces = [], inside = (p) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2 < rad * rad;
  let cur = [], changed = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) { if (inside(p)) changed = true; else cur.push(p); continue; }
    const a = pts[i - 1], dx = p[0] - a[0], dy = p[1] - a[1], fx = a[0] - cx, fy = a[1] - cy;
    const A = dx * dx + dy * dy || 1e-9, B = 2 * (fx * dx + fy * dy), disc = B * B - 4 * A * (fx * fx + fy * fy - rad * rad);
    let t0 = 0, t1 = 0, hit = false;
    if (disc > 0) { const sq = Math.sqrt(disc), ta = (-B - sq) / (2 * A), tb = (-B + sq) / (2 * A); if (tb > 0 && ta < 1) { hit = true; t0 = Math.max(0, ta); t1 = Math.min(1, tb); } }
    if (!hit) { if (!cur.length) cur.push(a); cur.push(p); continue; }
    changed = true;
    if (t0 > 0) { if (!cur.length) cur.push(a); cur.push([a[0] + dx * t0, a[1] + dy * t0]); }
    if (cur.length > 1) pieces.push(cur);
    cur = t1 < 1 ? [[a[0] + dx * t1, a[1] + dy * t1], p] : [];
  }
  if (cur.length > 1) pieces.push(cur);
  return changed ? pieces : null;                          // null = tidak ada yang terpotong
}
const polyLen = (pts) => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return l; };
function eraseBuiltAt(cx, cy, rad) {                       // hapus aspal buatan di sekitar (cx, cy); mengembalikan panjang yang terhapus (px)
  let removed = 0, any = false;
  const out = [];
  for (const r of BUILT.roads) {
    const pieces = cutPolyline(r.pts, cx, cy, rad);
    if (!pieces) { out.push(r); continue; }
    any = true; removed += polyLen(r.pts);
    for (const pc of pieces) { const l = polyLen(pc); if (l >= 8) { removed -= l; out.push({ pts: pc, w: r.w, by: r.by, at: r.at }); } }
  }
  if (!any) return 0;
  BUILT.roads = out; BUILT.grid = new Map(); for (const r of out) builtIndex(r);
  BUILT.ver++; BUILT.dirty = true;
  return Math.max(0, removed);
}
function saveBuiltRoads() {
  if (!BUILT.dirty) return;
  BUILT.dirty = false;
  fetch('/api/roads', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roads: BUILT.roads.map((r) => ({ pts: r.pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]), w: r.w, by: r.by || '', at: r.at || '' })) }) })
    .catch(() => showToast('⚠️ Server tidak bisa menyimpan perubahan jalan ke settings.json', 3));
}
function millingAction(V) {
  if (V.milling) { stopMilling(V, 'Drum diangkat — pengupasan dihentikan'); return; }
  V.milling = true; V.millLast = null; V.milledLen = 0;
  tone(260, 0.18, 0.05, 'sawtooth');
  showToast(`🛠️ Drum turun — maju pelan di atas aspal jalan buatan untuk mengupasnya (upah ${rupiah(millRate())}/m). A lagi untuk berhenti`, 4.5);
}
function stopMilling(V, why) {
  V.milling = false; V.millLast = null;
  saveBuiltRoads();
  const m = (V.milledLen || 0) / PX_PER_M, ok = m > 0.5;
  const pay = ok ? Math.round(m * millRate() / 1000) * 1000 : 0, sc = ok ? Math.round(m * 1.5) : 0;   // upah per meter, seperti paver
  if (pay > 0) { P.money += pay; P.extraScore = (P.extraScore || 0) + sc; coin(); }
  showToast(`${why}${ok ? ` · ${m.toFixed(0)} m aspal dikupas (+${sc} skor) · upah ${rupiah(pay)}` : ''}`, 4.5);
  V.milledLen = 0;
}
const millRate = () => (AMPC().millPerMeter != null ? AMPC().millPerMeter : 25000);
function millingStep(V, dt) {
  if (!V.milling) return;
  if (V.v > 28) V.v = 28;                                  // ±10 km/j saat mengupas
  const [gx, gy] = local2world(V, V.spec.drum != null ? V.spec.drum : -6, 0), last = V.millLast;
  if (last && Math.hypot(gx - last[0], gy - last[1]) < 10) return;
  const d = last ? Math.hypot(gx - last[0], gy - last[1]) : 0, steps = Math.max(1, Math.ceil(d / 12));
  let removed = 0;
  for (let i = 1; i <= steps; i++) {                       // jangan loncat: kupas di titik-titik antara posisi lama & baru
    const t = i / steps; removed += eraseBuiltAt(last ? last[0] + (gx - last[0]) * t : gx, last ? last[1] + (gy - last[1]) * t : gy, MILL_R);
  }
  V.millLast = [gx, gy];
  if (removed > 0) {
    V.milledLen = (V.milledLen || 0) + removed;
    if (Math.random() < 0.7) spawnSmoke(gx + (Math.random() - 0.5) * 30, gy + (Math.random() - 0.5) * 30, false, 0.7);   // debu kupasan
  }
}
function dumpStep(V, dt) {                                   // muat di silo & jungkit bak (berjalan walau sopir turun)
  if (V.loadT > 0) {
    V.v = 0;
    V.loadT -= dt; V.load = Math.min(1, V.load + dt / 4);
    if (Math.random() < 0.25) { const c = AMPC().chute; spawnSmoke(c.x + c.w / 2, c.y + c.h / 2, false, 0.8); }
    if (V.loadT <= 0) { V.loadT = 0; V.load = 1; showToast('✅ Bak penuh hotmix — bawa ke paver di lahan kosong', 3); tone(660, 0.1, 0.05, 'triangle'); }
  }
  if (V.tipT > 0) {
    V.tipT -= dt;
    V.tip = V.tipT > 2.2 ? (3.2 - V.tipT) : V.tipT > 1 ? 1 : V.tipT;
    const pv = V.tipTarget;
    if (pv && V.load > 0 && V.tipT < 2.2) {
      const mv = Math.min(V.load, dt / 1.2, 1 - pv.asphalt);
      V.load -= mv; pv.asphalt += mv;
      if (Math.random() < 0.3) { const [hx, hy] = local2world(pv, pv.spec.front, 0); spawnSmoke(hx, hy, false, 0.5); }
    }
    if (V.tipT <= 0) {
      V.tip = 0; V.tipT = 0; V.tipTarget = null; if (V.load < 0.02) V.load = 0;
      V.autoMove = 320;                                       // truk maju sedikit menjauhi paver agar paver bisa jalan
      if (pv) showToast(`✅ Hopper paver terisi ${Math.round(pv.asphalt * 100)}% — dump truck maju menjauh. Naik paver (Y), tekan A untuk menggelar aspal`, 4.5);
    }
  } else V.tip = 0;
  if (V.autoMove > 0) {                                       // maju pelan (walau sopir sudah turun)
    const st = Math.min(V.autoMove, 60 * dt), prev = { x: V.x, y: V.y };
    V.x += Math.cos(V.ang) * st; V.y += Math.sin(V.ang) * st; V.autoMove -= st;
    if (collidesOther(V)) { Object.assign(V, prev); V.autoMove = 0; }
  }
}
/* ----- Mobil tangki BBM -----
   1) Layanan antar: tahan klakson (X/H) saat berhenti, tekan G, atau X di dekat kendaraan saat jalan kaki.
      Mobil tangki berangkat dari SPBU terdekat, menyusuri jaringan jalan (rute terpendek), berhenti di samping
      kendaraan, mengisi BBM lewat selang (bayar per liter + ongkos antar), lalu kembali ke SPBU.
   2) Truk Tangki BBM yang bisa disetir sendiri: A di dekat kendaraan lain = isi lewat selang dari kompartemen. */
const CARGO_MAX = 3000, HOSE_RATE = 18, DELIVERY_FEE = 75000;
const FUEL_PRICE = { Solar: 6800, Pertalite: 10000 };
let RG = null;                                   // graf jalan: {nodes:[{x,y,w,adj:[[j,d]]}], grid}
function buildRoadGraph() {
  const nodes = [], grid = new Map(), CELL = 100, key = (x, y) => Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
  const add = (x, y, r) => { const i = nodes.length; nodes.push({ x, y, w: r.w, road: r.id, adj: [] }); const k = key(x, y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); return i; };
  const link = (a, b) => { if (a === b) return; const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y); nodes[a].adj.push([b, d]); nodes[b].adj.push([a, d]); };
  const ends = [];
  for (const r of level.roads) {
    if (r.kind === 'toll') continue;
    let prev = -1, acc = 0;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [ax, ay] = r.pts[i], [bx, by] = r.pts[i + 1], L = Math.hypot(bx - ax, by - ay) || 1;
      for (; acc < L; acc += 50) { const n = add(ax + (bx - ax) * acc / L, ay + (by - ay) * acc / L, r); if (prev >= 0) link(prev, n); else ends.push(n); prev = n; }
      acc -= L;
    }
    const [lx, ly] = r.pts[r.pts.length - 1], n = add(lx, ly, r); link(prev, n); ends.push(n);
  }
  const near = (x, y, rad) => { const out = []; for (let gx = Math.floor((x - rad) / CELL); gx <= Math.floor((x + rad) / CELL); gx++) for (let gy = Math.floor((y - rad) / CELL); gy <= Math.floor((y + rad) / CELL); gy++) for (const i of grid.get(gx + ',' + gy) || []) if (Math.hypot(nodes[i].x - x, nodes[i].y - y) <= rad) out.push(i); return out; };
  for (let i = 0; i < nodes.length; i++) for (const j of near(nodes[i].x, nodes[i].y, 40)) if (j > i && nodes[j].road !== nodes[i].road) link(i, j);   // persimpangan silang
  for (const e of ends) {                          // simpang-T: ujung jalan ke titik terdekat jalan lain
    let best = -1, bd = Infinity;
    for (const j of near(nodes[e].x, nodes[e].y, nodes[e].w / 2 + 90)) if (nodes[j].road !== nodes[e].road) { const d = Math.hypot(nodes[j].x - nodes[e].x, nodes[j].y - nodes[e].y); if (d < bd) { bd = d; best = j; } }
    if (best >= 0) link(e, best);
  }
  RG = { nodes, near, nearest(x, y) { for (const rad of [150, 400, 1000, 3000, 9000]) { let b = -1, bd = Infinity; for (const i of near(x, y, rad)) { const d = Math.hypot(nodes[i].x - x, nodes[i].y - y); if (d < bd) { bd = d; b = i; } } if (b >= 0) return b; } return 0; } };
}
function routeBetween(a, b) {                    // Dijkstra (heap biner) -> daftar titik di lajur kiri
  const N = RG.nodes, dist = new Float64Array(N.length).fill(Infinity), prev = new Int32Array(N.length).fill(-1), heap = [[0, a]];
  dist[a] = 0;
  const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  heap.length = 0; push([0, a]);
  while (heap.length) {
    const [d, u] = pop(); if (d > dist[u]) continue; if (u === b) break;
    for (const [v, w] of N[u].adj) if (d + w < dist[v]) { dist[v] = d + w; prev[v] = u; push([d + w, v]); }
  }
  if (!Number.isFinite(dist[b])) return null;
  const ids = []; for (let u = b; u >= 0; u = prev[u]) ids.push(u); ids.reverse();
  return ids.map((id, k) => {                    // geser ke lajur kiri (lalu lintas Indonesia)
    const p0 = N[ids[Math.max(0, k - 1)]], p1 = N[ids[Math.min(ids.length - 1, k + 1)]], nd = N[id];
    const tx = p1.x - p0.x, ty = p1.y - p0.y, L = Math.hypot(tx, ty) || 1, off = Math.min(nd.w * 0.25, 30);
    return [nd.x + ty / L * off, nd.y - tx / L * off];
  });
}
const DEPOTS = () => {                            // SPBU (satu per kelompok pompa) sebagai pangkalan mobil tangki
  const out = [];
  for (const p of level.places) if (p.kind === 'pump' && !out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 400)) {
    const cn = level.decor.find((d) => d.kind === 'canopy' && Math.hypot(d.x + d.w / 2 - p.x, d.y + d.h / 2 - p.y) < 400);
    out.push({ x: p.x, y: p.y, name: cn ? cn.label.replace(/\bSPBU\b/, 'SPBU').replace(/(\w)(\w*)/g, (m, a, b) => a + b.toLowerCase()).replace('Spbu', 'SPBU') : 'SPBU' });
  }
  return out;
};
let SERVICE = null;                               // mobil tangki layanan yang sedang berjalan
const sideSpot = (t) => { const s = t.spec; return local2world(t, (s.front + s.rear) / 2, -(s.hw + 24)); };
function callTanker(target) {
  if (!target || target.type === 'tanker' && !target.npc && false) return;
  if (SERVICE) { showToast(`🚛 Mobil tangki sudah dalam perjalanan (${Math.round(serviceDist() / PX_PER_M)} m lagi)`, 2.5); return; }
  if (target.fuel >= target.spec.tank - 0.5) { showToast(`Tangki ${target.name} sudah penuh`); return; }
  if (P.money < DELIVERY_FEE) { showToast('Uang tidak cukup untuk ongkos antar BBM'); return; }
  if (!RG) buildRoadGraph();
  const [gx, gy] = sideSpot(target), goal = RG.nearest(gx, gy);
  let best = null;
  for (const d of DEPOTS()) {
    const st = RG.nearest(d.x, d.y), r = routeBetween(st, goal);
    if (r) { let L = 0; for (let i = 1; i < r.length; i++) L += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]); if (!best || L < best.len) best = { d, st, r, len: L }; }
  }
  if (!best) { showToast('Mobil tangki tidak menemukan jalan ke lokasi ini', 3); return; }
  const T = makeVehicle({ type: 'tanker', color: '#f8fafc', name: 'Mobil Tangki BBM', fuel: 1 }, true);
  const [x0, y0] = best.r[0], [x1, y1] = best.r[Math.min(1, best.r.length - 1)];
  Object.assign(T, { id: 'layanan-tangki', service: true, x: x0, y: y0, ang: Math.atan2(y1 - y0, x1 - x0), gear: 'D', v: 0,
    route: [...best.r, [gx, gy]], ri: 0, phase: 'to', target, depot: best.d, stuckT: 0, ghostT: 0, recheckT: 3, cruise: 95 });
  T.x -= Math.cos(T.ang) * ((T.spec.front + T.spec.rear) / 2); T.y -= Math.sin(T.ang) * ((T.spec.front + T.spec.rear) / 2);
  npcs.push(T); SERVICE = T;
  P.money -= DELIVERY_FEE; coin();
  showToast(`🚛 Mobil tangki BBM berangkat dari ${best.d.name} — ±${Math.round(best.len / PX_PER_M)} m, ongkos antar ${rupiah(DELIVERY_FEE)}`, 4);
  tone(523, 0.08, 0.05, 'triangle'); tone(659, 0.12, 0.05, 'triangle', 0.1);
}
function serviceDist() { const T = SERVICE; if (!T) return 0; let L = 0, px = T.x, py = T.y; for (let i = T.ri; i < T.route.length; i++) { L += Math.hypot(T.route[i][0] - px, T.route[i][1] - py); [px, py] = T.route[i]; } return L; }
function endService(msg) { if (msg) showToast(msg, 3.5); if (SERVICE) { SERVICE.hoseTo = null; const i = npcs.indexOf(SERVICE); if (i >= 0) npcs.splice(i, 1); } SERVICE = null; }
// alirkan BBM lewat selang; pay = bayar per liter (layanan), cargo = ambil dari kompartemen truk tangki pemain
function hoseFlow(src, dst, dt, pay) {
  const name = dst.spec.fuelName, room = dst.spec.tank - dst.fuel;
  let amt = Math.min(HOSE_RATE * dt, room);
  if (src.cargo) amt = Math.min(amt, src.cargo[name] || 0);
  if (pay) amt = Math.min(amt, P.money / (FUEL_PRICE[name] || dst.spec.price));
  if (amt <= 0) return false;
  dst.fuel += amt; dst.lowWarned = false;
  if (src.cargo) src.cargo[name] -= amt;
  if (pay) P.money = Math.max(0, P.money - amt * (FUEL_PRICE[name] || dst.spec.price));
  return dst.spec.tank - dst.fuel > 0.05;
}
function serviceUpdate(T, dt) {
  if (T.wreck) { T.v = 0; knockUpdate(T, dt); if (T.wreckT > 8) endService('🚛 Mobil tangki rusak — panggil lagi nanti'); return; }
  const tg = T.target;
  if (T.phase === 'fill') {
    T.v = 0; knockUpdate(T, dt);
    const [mx, my] = vehMid(tg), [tx, ty] = vehMid(T);
    if (Math.hypot(mx - tx, my - ty) > 140 || Math.abs(tg.v) > 3) { T.hoseTo = null; startReturn(T, '⛽ Pengisian dihentikan — kendaraan bergerak'); return; }
    T.hoseTo = tg; T.fillT = (T.fillT || 0) + dt;
    if (!hoseFlow(T, tg, dt, true)) {
      T.hoseTo = null;
      startReturn(T, `✅ ${tg.name} terisi ${tg.spec.fuelName} ${Math.round(tg.fuel)}/${tg.spec.tank} L — mobil tangki kembali ke ${T.depot.name}`);
      coin();
    }
    return;
  }
  // ikuti rute (pure pursuit)
  if (T.phase === 'to' && (T.recheckT -= dt) <= 0) {     // kendaraan tujuan pindah? hitung ulang rute
    T.recheckT = 3;
    const [gx, gy] = sideSpot(tg), end = T.route[T.route.length - 1];
    if (Math.hypot(gx - end[0], gy - end[1]) > 150) {
      const r = routeBetween(RG.nearest(T.x, T.y), RG.nearest(gx, gy));
      if (r) { T.route = [...r, [gx, gy]]; T.ri = 0; }
    }
  }
  const R = T.route, [mx, my] = vehMid(T);
  while (T.ri < R.length - 1 && Math.hypot(R[T.ri][0] - mx, R[T.ri][1] - my) < 45) T.ri++;
  const last = T.ri >= R.length - 1, [ax, ay] = R[T.ri], dEnd = serviceDist();
  const want = Math.atan2(ay - my, ax - mx);
  T.steer = clamp(wrap(want - T.ang), -0.6, 0.6);
  T.ang = wrap(T.ang + clamp(wrap(want - T.ang), -1.6 * dt, 1.6 * dt) * Math.min(1, Math.abs(T.v) / 25 + 0.3));
  const bend = Math.abs(wrap(want - T.ang));
  let target = T.cruise * (bend > 0.6 ? 0.45 : bend > 0.3 ? 0.7 : 1);
  if (dEnd < 160) target = Math.min(target, 18 + dEnd * 0.4);
  // berhenti bila ada kendaraan / orang di depan (kecuali kendaraan tujuan saat hampir sampai)
  const probe = rectPoly(T.x, T.y, T.ang, T.spec.front + 2, T.spec.front + 55, T.spec.hw + 3);
  let blocked = false;
  if (T.ghostT > 0) T.ghostT -= dt;
  else {
    for (const v of vehicles) if (v !== tg && overlap(probe, vehPoly(v))) { blocked = true; break; }
    if (!blocked) for (const o of npcs) if (o !== T && overlap(probe, vehPoly(o))) { blocked = true; break; }
    if (!blocked && P.mode === 'walk' && overlap(probe, walkerPoly(P.x, P.y, 10))) blocked = true;
  }
  T.stuckT = blocked ? T.stuckT + dt : 0;
  if (T.stuckT > 5) { T.ghostT = 2.5; T.stuckT = 0; }      // macet lama: menyelip pelan
  if (blocked) target = 0;
  T.v += clamp(target - T.v, -220 * dt, 60 * dt);
  T.braking = blocked || T.v > target + 5;
  T.x += Math.cos(T.ang) * T.v * dt; T.y += Math.sin(T.ang) * T.v * dt;
  knockUpdate(T, dt);
  if (last && dEnd < 22) {
    if (T.phase === 'to') { T.phase = 'fill'; T.v = 0; T.ang = tg.ang; showToast(`⛽ Mobil tangki tiba — mengisi ${tg.spec.fuelName} ${tg.name}…`, 3); tone(880, 0.06, 0.05, 'sine'); }
    else endService();
  }
}
function startReturn(T, msg) {
  showToast(msg, 4);
  const r = routeBetween(RG.nearest(T.x, T.y), RG.nearest(T.depot.x, T.depot.y));
  if (!r) { endService(); return; }
  Object.assign(T, { route: r, ri: 0, phase: 'back' });
}
// truk tangki pemain: A di dekat kendaraan lain -> selang
function tankerAction(V) {
  if (V.hoseTo) { V.hoseTo = null; showToast('Selang dilepas'); return; }
  if (Math.abs(V.v) > 3) { showToast('Berhenti dulu untuk memasang selang'); return; }
  const [mx, my] = vehMid(V);
  let best = null, bd = 95;
  for (const o of vehicles) { if (o === V) continue; const [ox, oy] = vehMid(o), d = Math.hypot(ox - mx, oy - my) - o.spec.hw; if (d < bd) { bd = d; best = o; } }
  if (!best) { showToast(`Dekati kendaraan yang mau diisi (sisa Solar ${Math.round(V.cargo.Solar)} L · Pertalite ${Math.round(V.cargo.Pertalite)} L)`, 3); return; }
  const name = best.spec.fuelName;
  if (best.fuel >= best.spec.tank - 0.5) { showToast(`Tangki ${best.name} sudah penuh`); return; }
  if ((V.cargo[name] || 0) < 1) { showToast(`Kompartemen ${name} kosong — isi ulang di SPBU (parkir di pompa, tahan A)`, 3.5); return; }
  V.hoseTo = best; tone(600, 0.06, 0.05, 'sine');
  showToast(`⛽ Selang terpasang ke ${best.name} — mengisi ${name}…`, 2.5);
}
function tankerStep(V, dt) {
  const tg = V.hoseTo; if (!tg) return;
  const [ax, ay] = vehMid(V), [bx, by] = vehMid(tg);
  if (Math.hypot(ax - bx, ay - by) > 130 || Math.abs(V.v) > 3 || Math.abs(tg.v) > 3) { V.hoseTo = null; showToast('Selang terlepas — kendaraan bergerak'); return; }
  if (!hoseFlow(V, tg, dt, false)) {
    V.hoseTo = null;
    showToast(tg.fuel >= tg.spec.tank - 0.1 ? `✅ ${tg.name} penuh (${tg.spec.tank} L)` : `Kompartemen ${tg.spec.fuelName} habis`, 3);
    tone(660, 0.1, 0.05, 'triangle');
  }
}

/* ----------------------------- Mode Pengiriman Delivery Food -------------
 * Dua fungsi:
 *   1) Pesan Antar Makanan (tambah tenaga langsung di mana saja):
 *      Sopir menekan tombol U atau klik bar Tenaga 🛵 -> pilih menu makanan.
 *      Kurir motor (NPC berseragam hijau & boks makanan) berangkat dari warung/resto
 *      terdekat dan menavigasi lewat jalan ke lokasi sopir. Begitu tiba, kurir menyerahkan
 *      makanan dan tenaga sopir langsung bertambah!
 *   2) Jadi Kurir Delivery Food (kerja antar pesanan & bonus tenaga):
 *      Sopir mengambil order antar makanan dari warung ke pelanggan. Selesai antar,
 *      sopir mendapatkan ongkos kirim dan jatah makan gratis untuk memulihkan tenaga!
 */
const FOOD_MENU = [
  { id: 'pecel', name: 'Nasi Pecel Salatiga + Telur', icon: '🥗', price: 15000, energy: 35, desc: 'Pecel sayur segar bumbu kacang gurih khas Salatiga + telur ceplok' },
  { id: 'bakmi', name: 'Bakmi Jawa Godhog / Goreng', icon: '🍜', price: 18000, energy: 45, desc: 'Mi telur kenyal kuah kaldu ayam kampung hangat' },
  { id: 'soto', name: 'Soto Salatiga + Tempe Goreng', icon: '🍲', price: 20000, energy: 50, desc: 'Soto kuah rempah harum gurih dengan taburan tauge dan perkedel' },
  { id: 'geprek', name: 'Paket Ayam Geprek + Es Teh', icon: '🍗', price: 25000, energy: 65, desc: 'Ayam krispi sambal bawang pedas nampol + es teh manis jumbo' },
  { id: 'padang', name: 'Nasi Padang Rendang Komplit', icon: '🍛', price: 30000, energy: 75, desc: 'Nasi rendang sapi empuk, gulai sayur, daun singkong & sambal ijo' },
  { id: 'sultan', name: 'Paket Kenyang Sultan (All-In)', icon: '🍱', price: 45000, energy: 100, desc: 'Porsi lengkap istimewa: ayam bakar, telur, aneka lauk, es kelapa (tenaga penuh 100%)' },
];
const FOOD_DELIVERY_FEE = 5000;

let FOOD_SERVICE = null;
let foodJob = null;
let foodDeliveryPick = 0;
let foodActiveTab = 'order'; // 'order' | 'job'
let availableFoodJob = null;

const FOOD_DEPOTS = () => {
  const out = [];
  if (level && level.places) {
    for (const p of level.places) {
      if (['warung', 'hotel', 'oleh', 'shop'].includes(p.kind) && !out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 300)) {
        out.push({ x: p.x, y: p.y, name: p.label, kind: p.kind });
      }
    }
  }
  if (!out.length) out.push({ x: 1400, y: 4935, name: 'Warung Klero' });
  return out;
};

function getFoodJobCustomers() {
  const cust = [];
  if (level && level.places) {
    for (const p of level.places) {
      if (['house', 'hotel', 'school', 'wisata'].includes(p.kind)) {
        cust.push({ id: p.id || p.label, label: p.label, x: p.x, y: p.y });
      }
    }
  }
  if (!cust.length) {
    cust.push({ id: 'rumah-sopir', label: 'Rumah Sopir (Tingkir)', x: 1475, y: 2512 });
    cust.push({ id: 'rumah-puri', label: 'Rumah Puri Wahid', x: 1685, y: 4314 });
    cust.push({ id: 'hotel-laras', label: 'Hotel Laras Asri', x: 1330, y: 1700 });
  }
  return cust;
}

function getAvailableFoodJob() {
  if (availableFoodJob) return availableFoodJob;
  const depots = FOOD_DEPOTS();
  const custs = getFoodJobCustomers();
  const pickup = pick(depots);
  const dest = pick(custs.filter((c) => Math.hypot(c.x - pickup.x, c.y - pickup.y) > 300) || custs);
  const item = pick(FOOD_MENU);
  const dist = Math.hypot(dest.x - pickup.x, dest.y - pickup.y);
  const fee = Math.max(30000, Math.round((28000 + (dist / PX_PER_M) * 15) / 1000) * 1000);
  availableFoodJob = {
    pickup,
    dest,
    item,
    fee,
    customerName: pick(['Pak Budi', 'Ibu Ratna', 'Mas Hendra', 'Mbak Dewi', 'Pak Joko', 'Tamu Hotel']),
    phase: 'pickup',
  };
  return availableFoodJob;
}

function isFoodModalOpen() {
  const el = $('foodModal');
  return el && !el.classList.contains('hidden');
}

function openFoodDelivery() {
  if (state !== 'play') return;
  const el = $('foodModal');
  if (!el) return;
  el.classList.remove('hidden');
  updateFoodModalUI();
  tone(440, 0.06, 0.04, 'triangle');
}

function closeFoodDelivery() {
  const el = $('foodModal');
  if (!el) return;
  el.classList.add('hidden');
}

function updateFoodModalUI() {
  const el = $('foodModal');
  if (!el || el.classList.contains('hidden')) return;

  const tabOrder = $('fTabOrder'), tabJob = $('fTabJob');
  const orderView = $('fOrderView'), jobView = $('fJobView');
  if (tabOrder) tabOrder.classList.toggle('on', foodActiveTab === 'order');
  if (tabJob) tabJob.classList.toggle('on', foodActiveTab === 'job');
  if (orderView) orderView.classList.toggle('hidden', foodActiveTab !== 'order');
  if (jobView) jobView.classList.toggle('hidden', foodActiveTab !== 'job');

  const fMoney = $('fMoney'), fEnergy = $('fEnergy'), fLoc = $('fLoc');
  if (fMoney) fMoney.textContent = rupiah(P.money);
  if (fEnergy) fEnergy.textContent = `${Math.round(P.energy)}%`;
  const f = camFocus(), rn = roadNameAt(f.x, f.y);
  if (fLoc) fLoc.textContent = `${regionAt(f.x, f.y)}${rn ? ' · ' + rn : ''}`;

  if (foodActiveTab === 'order') {
    const list = $('fList');
    if (list) {
      list.innerHTML = FOOD_MENU.map((item, i) => `
        <div class="fitem ${i === foodDeliveryPick ? 'on' : ''}" data-i="${i}">
          <div class="ficon">${item.icon}</div>
          <div class="fdetails">
            <div class="fname">${item.name}</div>
            <div class="fdesc">${item.desc}</div>
            <div class="fmeta">
              <span class="fprice">${rupiah(item.price)}</span>
              <span class="fenergy">⚡ +${item.energy} Tenaga</span>
            </div>
          </div>
        </div>
      `).join('');
    }
    const cur = FOOD_MENU[foodDeliveryPick] || FOOD_MENU[0];
    const btn = $('fOrder');
    if (btn) btn.textContent = `Pesan ${cur.name} (${rupiah(cur.price + FOOD_DELIVERY_FEE)})`;
  } else {
    const details = $('fJobDetails');
    const acceptBtn = $('fJobAccept'), cancelBtn = $('fJobCancel');
    if (foodJob) {
      if (details) {
        details.innerHTML = `
          <div><b>Status Order:</b> <span style="color:#34d399">${foodJob.phase === 'pickup' ? 'Ambil pesanan di warung' : 'Antar ke pelanggan'}</span></div>
          <div><b>Pelanggan:</b> ${escapeHtml(foodJob.customerName)}</div>
          <div><b>Pesanan:</b> ${foodJob.item.icon} ${escapeHtml(foodJob.item.name)}</div>
          <div><b>Lokasi Ambil:</b> 🍲 ${escapeHtml(foodJob.pickup.name)}</div>
          <div><b>Lokasi Antar:</b> 📍 ${escapeHtml(foodJob.dest.label)}</div>
          <div><b>Ongkos Kirim:</b> <b style="color:#fcd34d">${rupiah(foodJob.fee)}</b></div>
          <div><b>Jatah Makan:</b> <span style="color:#86efac">⚡ +40 Tenaga (langsung dinikmati saat tiba di pelanggan)</span></div>
        `;
      }
      if (acceptBtn) acceptBtn.classList.add('hidden');
      if (cancelBtn) cancelBtn.classList.remove('hidden');
    } else {
      const job = getAvailableFoodJob();
      if (details) {
        details.innerHTML = `
          <div><b>Pelanggan:</b> ${escapeHtml(job.customerName)}</div>
          <div><b>Pesanan:</b> ${job.item.icon} ${escapeHtml(job.item.name)}</div>
          <div><b>Lokasi Ambil:</b> 🍲 ${escapeHtml(job.pickup.name)}</div>
          <div><b>Lokasi Antar:</b> 📍 ${escapeHtml(job.dest.label)}</div>
          <div><b>Ongkos Kirim:</b> <b style="color:#fcd34d">${rupiah(job.fee)}</b></div>
          <div><b>Bonus Kurir:</b> <span style="color:#86efac">⚡ +40 Tenaga (jatah makan gratis setelah antar)</span></div>
        `;
      }
      if (acceptBtn) {
        acceptBtn.classList.remove('hidden');
        acceptBtn.textContent = `Ambil Order Ini (${rupiah(job.fee)})`;
      }
      if (cancelBtn) cancelBtn.classList.add('hidden');
    }
  }
}

function foodModalStep(inp, dt) {
  if (inp.b || inp.back || keys.Escape || keyPressed.has('KeyU')) {
    closeFoodDelivery();
    tone(300, 0.05, 0.03, 'triangle');
    return;
  }
  if (inp.navX || keys.ArrowLeft || keys.ArrowRight || keys.KeyA || keys.KeyD) {
    foodActiveTab = foodActiveTab === 'order' ? 'job' : 'order';
    tone(420, 0.04, 0.03, 'sine');
    updateFoodModalUI();
  }
  if (foodActiveTab === 'order') {
    if (inp.num && inp.num >= 1 && inp.num <= FOOD_MENU.length) {
      foodDeliveryPick = inp.num - 1;
      tone(400, 0.04, 0.03, 'sine');
      updateFoodModalUI();
    }
    if (inp.navY || keys.ArrowUp || keys.ArrowDown || keys.KeyW || keys.KeyS) {
      const dir = (inp.navY > 0 || keys.ArrowDown || keys.KeyS) ? 1 : -1;
      const n = FOOD_MENU.length;
      foodDeliveryPick = (foodDeliveryPick + dir + n) % n;
      tone(350, 0.04, 0.03, 'sine');
      updateFoodModalUI();
    }
    if (inp.a || keys.Enter || keys.Space) {
      orderFoodDelivery(FOOD_MENU[foodDeliveryPick]);
    }
  } else {
    if (inp.a || keys.Enter || keys.Space) {
      if (!foodJob) acceptFoodJob();
    }
  }
}

function orderFoodDelivery(item) {
  if (!item) return;
  if (FOOD_SERVICE) {
    showToast(`🛵 Kurir sedang mengantar ${FOOD_SERVICE.foodItem.name} (${Math.round(foodServiceDist() / PX_PER_M)} m lagi)`, 3);
    return;
  }
  const total = item.price + FOOD_DELIVERY_FEE;
  if (P.money < total) {
    showToast(`Uang tidak cukup: perlu ${rupiah(total)}`);
    tone(220, 0.12, 0.05);
    return;
  }
  if (!RG) buildRoadGraph();

  let gx, gy;
  if (P.mode === 'drive' && P.veh) {
    [gx, gy] = sideSpot(P.veh);
  } else if (P.mode === 'inside' && P.house) {
    gx = P.house.door ? P.house.door.x : P.house.x;
    gy = P.house.door ? P.house.door.y : P.house.y;
  } else {
    gx = P.x; gy = P.y;
  }

  const goal = RG.nearest(gx, gy);
  let best = null;
  for (const d of FOOD_DEPOTS()) {
    const st = RG.nearest(d.x, d.y), r = routeBetween(st, goal);
    if (r) {
      let L = 0;
      for (let i = 1; i < r.length; i++) L += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
      if (!best || L < best.len) best = { d, st, r, len: L };
    }
  }
  if (!best) {
    showToast('Kurir makanan tidak menemukan rute jalan ke posisimu saat ini', 3.5);
    return;
  }

  P.money -= total;
  coin();

  const C = makeVehicle({ type: 'motor', model: 'matic', color: '#059669', name: 'Kurir Food Delivery', fuel: 1 }, true);
  const [x0, y0] = best.r[0], [x1, y1] = best.r[Math.min(1, best.r.length - 1)];
  Object.assign(C, {
    id: 'kurir-food-' + Math.floor(Math.random() * 10000),
    service: true,
    foodDelivery: true,
    foodItem: item,
    x: x0, y: y0,
    ang: Math.atan2(y1 - y0, x1 - x0),
    gear: 'D',
    v: 0,
    route: [...best.r, [gx, gy]],
    ri: 0,
    phase: 'to',
    targetVeh: P.mode === 'drive' ? P.veh : null,
    depot: best.d,
    stuckT: 0,
    ghostT: 0,
    recheckT: 2.5,
    cruise: 125,
  });
  C.x -= Math.cos(C.ang) * ((C.spec.front + C.spec.rear) / 2);
  C.y -= Math.sin(C.ang) * ((C.spec.front + C.spec.rear) / 2);

  npcs.push(C);
  FOOD_SERVICE = C;

  tone(523, 0.08, 0.05, 'triangle');
  tone(659, 0.12, 0.05, 'triangle', 0.08);
  showToast(`🛵 Pesanan ${item.name} siap diantar! Kurir berangkat dari ${best.d.name} (±${Math.round(best.len / PX_PER_M)} m)`, 4);
  closeFoodDelivery();
}

function foodServiceDist() {
  const C = FOOD_SERVICE; if (!C) return 0;
  let L = 0, px = C.x, py = C.y;
  for (let i = C.ri; i < C.route.length; i++) {
    L += Math.hypot(C.route[i][0] - px, C.route[i][1] - py);
    [px, py] = C.route[i];
  }
  return L;
}

function endFoodService(msg) {
  if (msg) showToast(msg, 3.5);
  if (FOOD_SERVICE) {
    const i = npcs.indexOf(FOOD_SERVICE);
    if (i >= 0) npcs.splice(i, 1);
  }
  FOOD_SERVICE = null;
}

function startFoodReturn(C, msg) {
  showToast(msg, 4);
  if (!RG) buildRoadGraph();
  const r = routeBetween(RG.nearest(C.x, C.y), RG.nearest(C.depot.x, C.depot.y));
  if (!r) { endFoodService(); return; }
  Object.assign(C, { route: r, ri: 0, phase: 'back' });
}

function foodServiceUpdate(C, dt) {
  if (C.wreck) {
    C.v = 0; knockUpdate(C, dt);
    if (C.wreckT > 6) {
      P.money += C.foodItem ? (C.foodItem.price + FOOD_DELIVERY_FEE) : 0;
      endFoodService('🛵 Kurir mengalami kendala di jalan — uang pesanan dikembalikan');
    }
    return;
  }

  let gx, gy;
  if (P.mode === 'drive' && P.veh) [gx, gy] = sideSpot(P.veh);
  else if (P.mode === 'inside' && P.house) {
    gx = P.house.door ? P.house.door.x : P.house.x;
    gy = P.house.door ? P.house.door.y : P.house.y;
  } else { gx = P.x; gy = P.y; }

  const [mx, my] = vehMid(C);
  const distToPlayer = Math.hypot(gx - mx, gy - my);

  if (C.phase === 'to') {
    if ((C.recheckT -= dt) <= 0) {
      C.recheckT = 2.5;
      const end = C.route[C.route.length - 1];
      if (Math.hypot(gx - end[0], gy - end[1]) > 120 && RG) {
        const r = routeBetween(RG.nearest(C.x, C.y), RG.nearest(gx, gy));
        if (r) { C.route = [...r, [gx, gy]]; C.ri = 0; }
      }
    }

    const dEnd = foodServiceDist();
    if (dEnd < 28 || distToPlayer < 38) {
      C.phase = 'handover';
      C.v = 0;
      tone(700, 0.08, 0.05);
      tone(700, 0.08, 0.05, 'sine', 0.1);
      const it = C.foodItem;
      P.energy = Math.min(100, P.energy + it.energy);
      P.warnE = false; P.warnE0 = false;
      showBanner(`🛵 <b>Pesanan Delivery Food Tiba!</b><br>Sopir menyantap <b>${it.name}</b> 😋<br><small>Tenaga bertambah <b>+${it.energy}</b> · Tenaga sekarang: <b>${Math.round(P.energy)}%</b></small>`, 3.8);
      tone(523, 0.1, 0.05); tone(659, 0.1, 0.05, 'triangle', 0.08); tone(784, 0.18, 0.05, 'triangle', 0.16);
      startFoodReturn(C, `✅ Makanan dinikmati — kurir kembali ke ${C.depot.name}`);
      return;
    }
  }

  if (C.phase === 'back') {
    const dEnd = foodServiceDist();
    if (dEnd < 30 || C.ri >= C.route.length - 1) {
      endFoodService();
      return;
    }
  }

  const R = C.route;
  while (C.ri < R.length - 1 && Math.hypot(R[C.ri][0] - mx, R[C.ri][1] - my) < 35) C.ri++;
  const [ax, ay] = R[C.ri], dEnd = foodServiceDist();
  const want = Math.atan2(ay - my, ax - mx);
  C.steer = clamp(wrap(want - C.ang), -0.7, 0.7);
  C.ang = wrap(C.ang + clamp(wrap(want - C.ang), -2.2 * dt, 2.2 * dt) * Math.min(1, Math.abs(C.v) / 20 + 0.35));

  const bend = Math.abs(wrap(want - C.ang));
  let target = C.cruise * (bend > 0.6 ? 0.45 : bend > 0.3 ? 0.75 : 1);
  if (dEnd < 140) target = Math.min(target, 18 + dEnd * 0.4);

  const probe = rectPoly(C.x, C.y, C.ang, C.spec.front + 2, C.spec.front + 38, C.spec.hw + 2);
  let blocked = false;
  if (C.ghostT > 0) C.ghostT -= dt;
  else {
    for (const v of vehicles) if (v !== P.veh && overlap(probe, vehPoly(v))) { blocked = true; break; }
    if (!blocked) for (const o of npcs) if (o !== C && overlap(probe, vehPoly(o))) { blocked = true; break; }
  }
  C.stuckT = blocked ? C.stuckT + dt : 0;
  if (C.stuckT > 3.5) { C.ghostT = 2.5; C.stuckT = 0; }
  if (blocked) target = 0;

  C.v += clamp(target - C.v, -280 * dt, 120 * dt);
  C.braking = blocked || C.v > target + 5;
  C.x += Math.cos(C.ang) * C.v * dt;
  C.y += Math.sin(C.ang) * C.v * dt;
  knockUpdate(C, dt);
}

function acceptFoodJob() {
  const job = getAvailableFoodJob();
  foodJob = { ...job };
  if (P.veh && P.veh.type === 'motor') P.veh.foodDelivery = true;
  showBanner(`🛵 <b>Order Kurir Makanan Diterima!</b><br>Ambil pesanan di <b>${job.pickup.name}</b> lalu antar ke <b>${job.dest.label}</b>.<br><small>Ongkos kirim <b>${rupiah(job.fee)}</b> + Jatah makan gratis (<b>+40 tenaga</b>)</small>`, 4);
  tone(523, 0.08, 0.05, 'triangle');
  closeFoodDelivery();
}

function cancelFoodJob() {
  if (foodJob) {
    showToast('Orderan kurir dibatalkan', 3);
    if (P.veh) P.veh.foodDelivery = false;
    foodJob = null;
    availableFoodJob = null;
    updateFoodModalUI();
  }
}

function updateFoodJob(dt) {
  if (!foodJob) return;
  const [px, py] = [P.x, P.y];
  if (foodJob.phase === 'pickup') {
    const d = Math.hypot(px - foodJob.pickup.x, py - foodJob.pickup.y);
    if (d < 65 || (P.mode === 'inside' && P.house && Math.hypot(P.house.x - foodJob.pickup.x, P.house.y - foodJob.pickup.y) < 100)) {
      foodJob.phase = 'deliver';
      tone(523, 0.08, 0.05, 'triangle');
      tone(659, 0.12, 0.05, 'triangle', 0.08);
      showBanner(`📦 <b>Pesanan ${foodJob.item.name} Diambil!</b><br>Antarkan ke <b>${foodJob.dest.label}</b>.<br><small>Ikuti penanda hijau di minimap / jalan raya</small>`, 3.5);
    }
  } else if (foodJob.phase === 'deliver') {
    const d = Math.hypot(px - foodJob.dest.x, py - foodJob.dest.y);
    if (d < 70 || (P.mode === 'inside' && P.house && P.house.id === foodJob.dest.id)) {
      const fee = foodJob.fee;
      const jobScore = 150;
      P.money += fee;
      P.extraScore = (P.extraScore || 0) + jobScore;
      P.energy = Math.min(100, P.energy + 40);
      P.warnE = false; P.warnE0 = false;
      if (P.veh) P.veh.foodDelivery = false;
      coin(); rumble(0.4, 200);
      showBanner(`✅ <b>Pesanan Makanan Terantar!</b><br>Pelanggan sangat puas! Kamu menerima ongkir <b>${rupiah(fee)}</b> (+${jobScore} skor)!<br><small>Jatah makan gratis dinikmati: <b>tenaga +40</b> (Tenaga sekarang: <b>${Math.round(P.energy)}%</b>)</small>`, 4.5);
      tone(523, 0.1, 0.05); tone(659, 0.1, 0.05, 'triangle', 0.08); tone(784, 0.18, 0.05, 'triangle', 0.16);
      foodJob = null;
      availableFoodJob = null;
    }
  }
}

// --- Misi Antar Jemput Penumpang (Taksi / Ojek) ---
let taxiJob = null;
let availableTaxiJob = null;

const PASSENGER_NAMES = [
  'Pak RT Supardi', 'Ibu Nurul', 'Mbak Cindy', 'Mas Bayu', 'Pak Dokter Arif',
  'Mbah Karto', 'Mahasiswa UKSW', 'Wisatawan Jakarta', 'Adik Pelajar SMP', 'Ibu Hajah Maryam'
];

function getTaxiSpots() {
  const spots = [];
  if (level && level.places) {
    for (const p of level.places) {
      if (['house', 'hotel', 'school', 'wisata', 'warung', 'shop', 'oleh', 'kumon', 'alun', 'kopdes', 'airport'].includes(p.kind)) {
        spots.push({ id: p.id || p.label, label: p.label, x: p.x, y: p.y, kind: p.kind });
      }
    }
  }
  if (!spots.length) {
    spots.push({ id: 'tingkir', label: 'Tingkir', x: 1475, y: 2512, kind: 'house' });
    spots.push({ id: 'hotel', label: 'Hotel Laras Asri', x: 1330, y: 1700, kind: 'hotel' });
    spots.push({ id: 'kopeng', label: 'Taman Wisata Kopeng', x: 880, y: 225, kind: 'wisata' });
  }
  return spots;
}

let TAXI_SERVICE = null, TAXI_SPOTS = [], TAXI_QUOTE = null;
function isTaxiRideModalOpen() { return !$('taxiRideModal').classList.contains('hidden'); }

function taxiRoadRoute(from, to) {
  const path = routeBetween(RG.nearest(from.x, from.y), RG.nearest(to.x, to.y));
  return path ? [...path, [to.x, to.y]] : null;
}

function taxiRouteLength(from, route) {
  let distance = 0, x = from.x, y = from.y;
  for (const [nextX, nextY] of route) {
    distance += Math.hypot(nextX - x, nextY - y);
    x = nextX; y = nextY;
  }
  return distance;
}

function updateTaxiRideQuote() {
  const select = $('taxiDestination');
  const destination = TAXI_SPOTS[Number(select.value)];
  TAXI_QUOTE = null;
  if (!destination || !RG) { $('taxiFare').textContent = 'Rute tidak tersedia'; $('taxiBookBtn').disabled = true; return; }
  const route = taxiRoadRoute({ x: P.x, y: P.y }, destination);
  if (!route) { $('taxiFare').textContent = 'Rute tidak tersedia'; $('taxiBookBtn').disabled = true; return; }
  const distance = taxiRouteLength({ x: P.x, y: P.y }, route);
  if (distance < 50) { $('taxiFare').textContent = 'Kamu sudah berada di tujuan'; $('taxiBookBtn').disabled = true; return; }
  const fare = Math.max(12000, Math.ceil((10000 + distance / (PX_PER_M * 1000) * 12000) / 1000) * 1000);
  TAXI_QUOTE = { destination, distance, fare };
  $('taxiFare').textContent = `${rupiah(fare)} · sekitar ${(distance / PX_PER_M / 1000).toFixed(1)} km`;
  $('taxiBookBtn').disabled = P.money < fare;
  if (P.money < fare) $('taxiFare').textContent += ` · uang ${rupiah(P.money)}`;
}

function openTaxiRide() {
  if (state !== 'play') return;
  if (P.mode !== 'walk') { showToast('Turun dari kendaraan dulu untuk memesan taksi'); return; }
  if (TAXI_SERVICE) { showToast(`🚕 Taksi sedang menuju ${TAXI_SERVICE.destination.label}`); return; }
  if (!RG) buildRoadGraph();
  TAXI_SPOTS = getTaxiSpots();
  $('taxiDestination').innerHTML = TAXI_SPOTS.map((spot, index) => `<option value="${index}">${escapeHtml(spot.label)}</option>`).join('');
  updateTaxiRideQuote();
  $('taxiRideModal').classList.remove('hidden');
  $('taxiDestination').focus();
}

function closeTaxiRide() {
  $('taxiRideModal').classList.add('hidden');
}

function taxiRideModalStep(inp) {
  if (inp.b || inp.start) { closeTaxiRide(); return; }
  if (inp.a) bookTaxiRide();
}

function bookTaxiRide() {
  if (!TAXI_QUOTE || TAXI_SERVICE || P.mode !== 'walk') return;
  if (P.money < TAXI_QUOTE.fare) { showToast('Uang tidak cukup untuk ongkos taksi'); return; }
  const stands = getTaxiSpots();
  const stand = stands.reduce((best, spot) => !best || Math.hypot(spot.x - P.x, spot.y - P.y) < Math.hypot(best.x - P.x, best.y - P.y) ? spot : best, null);
  const route = taxiRoadRoute(stand, { x: P.x, y: P.y });
  if (!route) { showToast('Taksi tidak menemukan rute ke lokasimu'); return; }
  const cab = makeVehicle({ type: 'car', model: 'sedan', color: '#facc15', name: 'Taksi Online', fuel: 1 }, true);
  const [startX, startY] = route[0], [nextX, nextY] = route[Math.min(1, route.length - 1)];
  const angle = Math.atan2(nextY - startY, nextX - startX), midpoint = (cab.spec.front + cab.spec.rear) / 2;
  Object.assign(cab, {
    id: `taxi-${Date.now()}`, service: true, taxiService: true, phase: 'pickup',
    route, routeIndex: 0, recheck: 0, destination: TAXI_QUOTE.destination, fare: TAXI_QUOTE.fare,
    cruise: 90, x: startX - Math.cos(angle) * midpoint, y: startY - Math.sin(angle) * midpoint,
    ang: angle, gear: 'D', v: 0,
  });
  TAXI_SERVICE = cab;
  npcs.push(cab);
  P.money -= cab.fare;
  closeTaxiRide();
  showToast(`🚕 Taksi menuju lokasimu · ${rupiah(cab.fare)}`, 4);
  tone(523, 0.08, 0.05, 'triangle'); tone(659, 0.12, 0.05, 'triangle', 0.1);
}

function taxiServiceDistance(T) {
  const [midX, midY] = vehMid(T);
  return taxiRouteLength({ x: midX, y: midY }, T.route.slice(T.routeIndex));
}

function endTaxiService(T, arrived) {
  if (arrived) {
    P.mode = 'walk'; P.veh = null; P.x = T.destination.x; P.y = T.destination.y;
    showToast(`🚕 Tiba di ${T.destination.label}`);
  } else if (P.mode === 'taxi') {
    P.mode = 'walk'; P.veh = null; P.x = T.x; P.y = T.y;
  }
  const index = npcs.indexOf(T);
  if (index >= 0) npcs.splice(index, 1);
  TAXI_SERVICE = null;
}

function taxiServiceUpdate(T, dt) {
  if (T.phase === 'pickup' && P.mode !== 'walk') { endTaxiService(T, false); return; }
  if (T.phase === 'pickup' && (T.recheck -= dt) <= 0) {
    T.recheck = 2;
    const [midX, midY] = vehMid(T), end = T.route[T.route.length - 1];
    if (Math.hypot(P.x - end[0], P.y - end[1]) > 80) {
      const route = taxiRoadRoute({ x: midX, y: midY }, { x: P.x, y: P.y });
      if (route) { T.route = route; T.routeIndex = 0; }
    }
  }
  const [midX, midY] = vehMid(T);
  while (T.routeIndex < T.route.length - 1 && Math.hypot(T.route[T.routeIndex][0] - midX, T.route[T.routeIndex][1] - midY) < 45) T.routeIndex++;
  const [targetX, targetY] = T.route[T.routeIndex], distance = taxiServiceDistance(T);
  const desiredAngle = Math.atan2(targetY - midY, targetX - midX);
  T.ang = wrap(T.ang + clamp(wrap(desiredAngle - T.ang), -1.6 * dt, 1.6 * dt) * Math.min(1, Math.abs(T.v) / 25 + 0.3));
  let targetSpeed = T.cruise * (distance < 160 ? Math.max(0.2, distance / 160) : 1);
  const probe = rectPoly(T.x, T.y, T.ang, T.spec.front + 2, T.spec.front + 55, T.spec.hw + 3);
  let blocked = false;
  for (const vehicle of vehicles) if (overlap(probe, vehPoly(vehicle))) { blocked = true; break; }
  if (!blocked) for (const other of npcs) if (other !== T && overlap(probe, vehPoly(other))) { blocked = true; break; }
  if (blocked) targetSpeed = 0;
  T.v += clamp(targetSpeed - T.v, -220 * dt, 60 * dt);
  T.braking = blocked || T.v > targetSpeed + 5;
  T.x += Math.cos(T.ang) * T.v * dt; T.y += Math.sin(T.ang) * T.v * dt;
  if (T.phase === 'ride') { P.x = T.x; P.y = T.y; }
  if (distance >= 40) return;
  if (T.phase === 'pickup') {
    const destinationRoute = taxiRoadRoute({ x: midX, y: midY }, T.destination);
    if (!destinationRoute) { endTaxiService(T, false); showToast('Taksi tidak menemukan rute ke tujuan'); return; }
    T.phase = 'ride'; T.route = destinationRoute; T.routeIndex = 0; T.v = 0;
    P.mode = 'taxi'; P.veh = null; P.x = T.x; P.y = T.y;
    showToast(`🚕 Perjalanan ke ${T.destination.label} dimulai`);
  } else {
    endTaxiService(T, true);
  }
}

function getAvailableTaxiJob() {
  if (availableTaxiJob) return availableTaxiJob;
  const spots = getTaxiSpots();
  if (spots.length < 2) return null;
  const pickup = pick(spots);
  const others = spots.filter(s => Math.hypot(s.x - pickup.x, s.y - pickup.y) > 400);
  const dest = others.length ? pick(others) : pick(spots);
  const distM = Math.hypot(dest.x - pickup.x, dest.y - pickup.y) / PX_PER_M;
  const fare = Math.max(35000, Math.round((25000 + distM * 35) / 1000) * 1000);
  const score = Math.max(50, Math.round(distM * 0.4));
  availableTaxiJob = {
    passenger: pick(PASSENGER_NAMES),
    pickup,
    dest,
    fare,
    score,
    phase: 'pickup' // 'pickup' | 'onboard'
  };
  return availableTaxiJob;
}

function acceptTaxiJob() {
  if (taxiJob) return;
  const job = getAvailableTaxiJob();
  if (!job) return;
  taxiJob = { ...job };
  availableTaxiJob = null;
  tone(587, 0.1, 0.05, 'triangle'); tone(740, 0.15, 0.05, 'triangle', 0.08);
  showBanner(`🚕 <b>Pesanan Penumpang Diterima!</b><br>Jemput <b>${taxiJob.passenger}</b> di <b>${taxiJob.pickup.label}</b>.<br><small>Ongkos: ${rupiah(taxiJob.fare)} · Bonus: +${taxiJob.score} Skor · Ikuti penanda kuning di jalan raya</small>`, 4);
}

function cancelTaxiJob() {
  if (taxiJob) {
    showToast(`Pesanan antar jemput ${taxiJob.passenger} dibatalkan`, 3);
    if (taxiJob.passengerActor) {
      const actor = taxiJob.passengerActor;
      actor.state = 'ambient';
      actor.homeX = actor.x; actor.homeY = actor.y; actor.radius = 45;
      actor.speed = 14;
      chooseActorTarget(actor);
    }
    taxiJob = null;
    availableTaxiJob = null;
  }
}

function taxiDoorPosition(vehicle) {
  const forward = (vehicle.spec.front + vehicle.spec.rear) * 0.25;
  const side = vehicle.spec.hw + 15;
  return {
    x: vehicle.x + Math.cos(vehicle.ang) * forward - Math.sin(vehicle.ang) * side,
    y: vehicle.y + Math.sin(vehicle.ang) * forward + Math.cos(vehicle.ang) * side,
  };
}

function moveActorTo(actor, x, y, dt, speed = actor.speed || 30) {
  const dx = x - actor.x, dy = y - actor.y, distance = Math.hypot(dx, dy);
  if (distance < 3) { actor.x = x; actor.y = y; return true; }
  const step = Math.min(distance, speed * dt);
  actor.ang = Math.atan2(dy, dx);
  actor.x += dx / distance * step;
  actor.y += dy / distance * step;
  actor.walkT += step;
  return distance <= step + 3;
}

function updateActors(dt) {
  for (const actor of actors) {
    if (actor.state === 'ambient') {
      if (actor.wait > 0) actor.wait -= dt;
      else if (moveActorTo(actor, actor.targetX, actor.targetY, dt)) chooseActorTarget(actor);
    }
  }
  if (!taxiJob || !taxiJob.passengerActor) return;
  const actor = taxiJob.passengerActor;
  if (taxiJob.phase === 'boarding') {
    const door = taxiDoorPosition(taxiJob.vehicle);
    if (moveActorTo(actor, door.x, door.y, dt, 28)) {
      actor.state = 'onboard';
      taxiJob.phase = 'onboard';
      tone(440, 0.08, 0.05); tone(659, 0.12, 0.05, 'sine', 0.08); tone(880, 0.15, 0.06, 'sine', 0.16);
      showBanner(`👤 <b>${taxiJob.passenger} Sudah Naik!</b><br>Antarkan ke tujuan: <b>${taxiJob.dest.label}</b>.<br><small>Berkendara dengan hati-hati sampai tujuan</small>`, 3.8);
    }
  } else if (taxiJob.phase === 'alighting') {
    if (moveActorTo(actor, taxiJob.alightTarget.x, taxiJob.alightTarget.y, dt, 28)) {
      actor.state = 'ambient';
      actor.homeX = actor.x; actor.homeY = actor.y; actor.radius = 45;
      actor.speed = 14;
      chooseActorTarget(actor);
      const fare = taxiJob.fare, score = taxiJob.score, passenger = taxiJob.passenger;
      P.money += fare;
      P.extraScore = (P.extraScore || 0) + score;
      coin(); rumble(0.4, 200);
      showBanner(`🎉 <b>Penumpang Sampai di Tujuan!</b><br>${passenger} mengucapkan terima kasih!<br><small>Ongkos diterima: <b>${rupiah(fare)}</b> · Skor tambahan: <b>+${score} pts</b></small>`, 4.5);
      tone(523, 0.1, 0.05); tone(659, 0.1, 0.05, 'triangle', 0.08); tone(784, 0.15, 0.05, 'triangle', 0.16); tone(1046, 0.22, 0.06, 'triangle', 0.24);
      taxiJob = null;
      availableTaxiJob = null;
    }
  }
}

function updateTaxiJob(dt) {
  if (!taxiJob) return;
  const px = P.x, py = P.y;
  const inVeh = P.mode === 'drive' && P.veh;
  if (taxiJob.phase === 'pickup') {
    const d = Math.hypot(px - taxiJob.pickup.x, py - taxiJob.pickup.y);
    if (d < 75) {
      if (!inVeh) {
        showToast(`🚕 Naik kendaraan dulu untuk menjemput ${taxiJob.passenger}`, 2.5);
        return;
      }
      if (Math.abs(P.veh.v) > 10) {
        showToast(`🚕 Pelankan kendaraan untuk menjemput ${taxiJob.passenger}`, 1.5);
        return;
      }
      const actor = makeActor(taxiJob.pickup.x + 30, taxiJob.pickup.y + 24);
      Object.assign(actor, { name: taxiJob.passenger, state: 'boarding', taxiPassenger: true });
      actors = actors.filter((nearby) => nearby.state !== 'ambient'
        || Math.hypot(nearby.x - taxiJob.pickup.x, nearby.y - taxiJob.pickup.y) > 100);
      actors.push(actor);
      taxiJob.passengerActor = actor;
      taxiJob.vehicle = P.veh;
      taxiJob.phase = 'boarding';
      showToast(`🚶 ${taxiJob.passenger} berjalan menuju mobil`, 2.5);
    }
  } else if (taxiJob.phase === 'boarding') {
    if (!inVeh || P.veh !== taxiJob.vehicle || Math.abs(P.veh.v) > 10) {
      taxiJob.passengerActor.state = 'waiting';
      taxiJob.phase = 'pickup';
      showToast(`🚕 Hentikan kendaraan agar ${taxiJob.passenger} bisa naik`, 2);
    }
  } else if (taxiJob.phase === 'onboard') {
    const d = Math.hypot(px - taxiJob.dest.x, py - taxiJob.dest.y);
    if (d < 80) {
      if (inVeh && Math.abs(P.veh.v) > 10) {
        showToast(`🚕 Pelankan dan hentikan kendaraan untuk menurunkan penumpang`, 1.5);
        return;
      }
      const door = inVeh ? taxiDoorPosition(P.veh) : { x: P.x, y: P.y };
      taxiJob.alightTarget = { x: taxiJob.dest.x + 35, y: taxiJob.dest.y + 22 };
      Object.assign(taxiJob.passengerActor, door, { state: 'alighting' });
      taxiJob.phase = 'alighting';
      showToast(`🚶 ${taxiJob.passenger} turun dan berjalan ke tujuan`, 2.5);
    }
  }
}

function handleTaxiKeyAction() {
  if (taxiJob) {
    cancelTaxiJob();
  } else {
    acceptTaxiJob();
  }
}

function vehicleAction(V) {
  if (V.type === 'tanker') { tankerAction(V); return; }
  if (isDumpTruck(V)) {
    if ((inChute(V) || V.load > 0.01 && nearPaverHopper(V)) && !V.towing && !V.towedBy) { dumpAction(V); return; }
    if (V.hooked) { toggleHitch(V); return; }
    if (V.spec.canTow && mission && mission.trailer.state === 'parked') {
      const [fx, fy] = fifthWheel(V);
      if (Math.hypot(fx - mission.trailer.x, fy - mission.trailer.y) < COUPLE_DIST * 2.5) {
        toggleHitch(V);
        return;
      }
    }
    dumpAction(V);
  }
  else if (V.type === 'paver') paverAction(V);
  else if (V.type === 'milling') millingAction(V);
  else toggleHitch(V);
}

function towVehicleAction(V) {
  if (V.towing) {
    detachTowVehicle(V);
  } else if (V.spec.canTowVehicle) {
    const target = nearTowVehicle(V);
    if (target) attachTowVehicle(V, target);
    else showToast('Dekati kendaraan lain untuk menderek (B)');
  }
}

function stepSuspension(V, longitudinalAccel, dt, bumpPitch = 0, bumpRoll = 0) {
  if (V.type === 'paver' || V.type === 'milling' || (V.airborne && (V.type === 'plane' || isVTOL(V)))) {
    V.suspensionPitch = 0; V.suspensionPitchRate = 0;
    V.suspensionRoll = 0; V.suspensionRollRate = 0;
    return;
  }

  const lateralAccel = V.v * (V.v / V.spec.wb) * Math.tan(V.steer) / PX_PER_M;
  const pitchLimit = suspensionSettings.pitchLimitDeg * DEG;
  const rollLimit = suspensionSettings.rollLimitDeg * DEG;
  const pitchTarget = clamp(longitudinalAccel * 0.012 + bumpPitch * 0.28, -pitchLimit, pitchLimit);
  const rollTarget = clamp(-lateralAccel * 0.012 + bumpRoll * 0.28, -rollLimit, rollLimit);
  const omega = suspensionSettings.stiffness, damping = suspensionSettings.damping;
  const steps = Math.max(1, Math.ceil(dt / 0.025)), h = dt / steps;
  for (let i = 0; i < steps; i++) {
    V.suspensionPitchRate += (omega * omega * (pitchTarget - V.suspensionPitch)
      - 2 * damping * omega * V.suspensionPitchRate) * h;
    V.suspensionPitch = clamp(V.suspensionPitch + V.suspensionPitchRate * h, -pitchLimit, pitchLimit);
    if (Math.abs(V.suspensionPitch) >= pitchLimit && Math.sign(V.suspensionPitchRate) === Math.sign(V.suspensionPitch)) V.suspensionPitchRate = 0;
    V.suspensionRollRate += (omega * omega * (rollTarget - V.suspensionRoll)
      - 2 * damping * omega * V.suspensionRollRate) * h;
    V.suspensionRoll = clamp(V.suspensionRoll + V.suspensionRollRate * h, -rollLimit, rollLimit);
    if (Math.abs(V.suspensionRoll) >= rollLimit && Math.sign(V.suspensionRollRate) === Math.sign(V.suspensionRoll)) V.suspensionRollRate = 0;
  }
}

function driveUpdate(V, inp, dt) {
  if (inp.b && (V.towing || V.spec.canTowVehicle)) towVehicleAction(V);
  if (inp.a) vehicleAction(V);
  if (V.type === 'plane') {
    if (inp.gearDown) shiftGear(V, +1);
    if (inp.gearUp) shiftGear(V, -1);
  } else if (!isVTOL(V)) {
    if (inp.down) shiftGear(V, +1);
    if (inp.up) shiftGear(V, -1);
  }
  V.horn = inp.horn;
  if (inp.callFuel) callTanker(V);
  V.hornHold = inp.horn && Math.abs(V.v) < 2 ? (V.hornHold || 0) + dt : 0;
  if (V.hornHold > 1.2 && !V.hornCalled) { V.hornCalled = true; callTanker(V); }
  if (!inp.horn) V.hornCalled = false;
  setHorn(inp.horn, V.type === 'car' || V.type === 'motor' || (V.type === 'custom' && V.spec.parts.kabin === 'mobil'));
  if (V.gear === 'R' && V.type !== 'motor' && !isVTOL(V) && V.type !== 'plane' && V.type !== 'car') { 
    beepT -= dt; 
    if (beepT <= 0) { 
      tone(1150, 0.32, 0.035); 
      beepT = 0.7; 
    } 
  }  V.braking = inp.brk > 0.05 || inp.hand;

  const s = V.spec;
  const target = inp.steer * s.maxSteer * (1 - 0.45 * clamp(Math.abs(V.v) / s.vf, 0, 1));
  V.steer += clamp(target - V.steer, -2.2 * dt, 2.2 * dt);

  const grip = s.grip || 0.4;
  const paved = onPaved(V.x, V.y);
  const surf = paved ? { vmax: 1, drag: 0 } : { vmax: grip, drag: 0.9 * (0.4 / grip) };
  const tired = (P.energy <= 0 ? 0.35 : P.energy < 20 ? 0.7 : 1) * (hpOf(V) < 35 ? 0.6 : 1);   // rusak berat: mesin pincang
  const hasFuel = V.fuel > 0 && !V.wreck;
  V.deadMsgT = (V.deadMsgT || 0) - dt;
  if (V.wreck && inp.thr > 0.3 && V.deadMsgT <= 0) { showToast(`${V.name} hancur — mesin tidak mau hidup. Turun (Y) & panggil montir (A)`, 2.5); V.deadMsgT = 3; }
  const mass = V.hooked || V.towing ? 1.7 : 1;
  const { thr, brk } = inp;
  const dir = V.gear === 'D' ? 1 : V.gear === 'R' ? -1 : 0;
  const v = V.v;
  let a = 0;
  if (isVTOL(V) && hasFuel) {
    const control = clamp(thr - brk, -1, 1);
    if (Math.abs(control) > 0.05) {
      const maxSpeed = control < 0 ? s.vr : s.vf;
      a += s.acc * control * Math.max(0, 1 - Math.abs(v) / maxSpeed);
    }
  } else if (dir && hasFuel) {
    const terrainLimit = !paved && s.offroadMaxSpeed ? s.offroadMaxSpeed : Infinity;
    const vmax = Math.min((dir > 0 ? s.vf : s.vr) * surf.vmax, terrainLimit) * tired;
    const vd = v * dir;
    if (thr > 0.05) a += dir * (s.acc / mass) * thr * Math.max(0, 1 - vd / vmax);
    else if (brk < 0.05 && !inp.hand && vd < CREEP * surf.vmax) a += dir * 45;
  }
  a -= v * (0.25 + surf.drag);
  // tanjakan / turunan (kontur Kopeng): g = 9,8 m/s² = 98 px/s²
  const cfx = Math.cos(V.ang), cfy = Math.sin(V.ang);
  const roadHeight = (x, y) => bridgeGroundHeight(x, y, V.ang) + roadSurfaceHeightAt(x, y);
  const slope = (roadHeight(V.x + cfx * 20, V.y + cfy * 20) - roadHeight(V.x - cfx * 20, V.y - cfy * 20)) / 40;
  if (!(isVTOL(V) && V.airborne) && V.gear !== 'P' && slope) a -= 98 * slope * (V.spec.climb != null ? V.spec.climb : 1) * (V.hooked ? 1.15 : 1);
  V.slope = slope;
  let nv = v + a * dt;
  if (!paved && s.offroadMaxSpeed) {
    const reverseLimit = Math.min(s.vr * surf.vmax * tired, s.offroadMaxSpeed);
    const forwardLimit = Math.min(s.vf * surf.vmax * tired, s.offroadMaxSpeed);
    nv = clamp(nv, -reverseLimit, forwardLimit);
  }
  if (V.type === 'paver' || V.type === 'milling') nv = clamp(nv, -s.vr, s.vf);
  const dec = ((isVTOL(V) ? 0 : 320 * brk) + (inp.hand ? 450 : 0)
    + (thr < 0.05 && (!isVTOL(V) || brk < 0.05) ? 22 : 0)) * dt;
  nv = Math.abs(nv) <= dec ? 0 : nv - Math.sign(nv) * dec;
  if (V.type === 'plane' && V.airborne && dir > 0 && brk < 0.05 && !inp.hand) nv = Math.max(nv, s.v0);
  if ((V.gear === 'P' && !isVTOL(V)) || V.tipT > 0 || V.loadT > 0) nv = 0; // kendaraan berhenti saat diparkir / dimuat
  V.v = nv;
  const bumpAttitude = roadBumpAttitude(V);
  stepSuspension(V, dt > 0 ? (nv - v) / dt : 0, dt, bumpAttitude.pitch, bumpAttitude.roll);

  // BBM
  if (hasFuel) {
    const engineInput = isVTOL(V) ? Math.max(thr, brk) : dir ? thr : 0;
    V.fuel = Math.max(0, V.fuel - (0.012 + engineInput * s.burn * mass) * dt);
    if (V.fuel === 0) showToast(`${s.fuelName} habis! Jalan kaki ke SPBU, beli jeriken`, 4);
    else if (!V.lowWarned && V.fuel < s.tank * 0.12) { V.lowWarned = true; showToast(`${s.fuelName} tinggal sedikit — mampir ke SPBU`, 3); }
  }

  schoolZoneCheck(V, dt);
  if (V.type === 'paver') paverStep(V, dt);
  if (V.type === 'milling') millingStep(V, dt);
  tollCheck(V);
  redLightCheck(V, dt);

  if (isVTOL(V)) {
    // 1. Rotasi Badan (Yaw) menggunakan D-Pad Kiri/Kanan khusus (heliRotLeft / heliRotRight)
    let rotInput = (inp.heliRotRight ? 1 : 0) - (inp.heliRotLeft ? 1 : 0);
    if (rotInput !== 0) {
      V.ang = wrap(V.ang + rotInput * 1.8 * dt);
    }

    // 2. Banking & Geser Samping murni menggunakan inp.steer utama
    const bankTarget = V.airborne ? inp.steer * 0.38 : 0;
    const sideTarget = V.airborne ? inp.steer * s.vf * 0.55 : 0;
    V.bank = (V.bank || 0) + clamp(bankTarget - (V.bank || 0), -1.4 * dt, 1.4 * dt);
    V.lateralV = (V.lateralV || 0) + clamp(sideTarget - (V.lateralV || 0), -s.acc * dt, s.acc * dt);
  } else if (V.type === 'plane') {
    const bankTarget = V.airborne ? inp.steer * 0.78 : 0;
    V.bank = (V.bank || 0) + clamp(bankTarget - (V.bank || 0), -1.8 * dt, 1.8 * dt);
  }

  const prev = { x: V.x, y: V.y, ang: V.ang };
  const prevTowed = V.towing ? { x: V.towing.x, y: V.towing.y, ang: V.towing.ang, v: V.towing.v } : null;
  const h = V.hooked, prevTr = h ? { x: h.x, y: h.y, ang: h.ang } : null;
  let jack = false;
  for (let i = 0; i < 4; i++) jack = integrate(V, dt / 4) || jack;
  if (!(V.airborne && (V.type === 'plane' || isVTOL(V))) && collides(V)) {
    const hit = collideInfo(V);
    Object.assign(V, prev);
    if (h) Object.assign(h, prevTr);
    if (V.towing && prevTowed) Object.assign(V.towing, prevTowed);
    const impact = hit ? applyBounce(V, hit, v) : Math.abs(v);
    if (!hit) V.v = -v * 0.3;
    if (hit) crashDamage(V, hit, impact);         // bodi penyok, bisa sampai hancur (juga kendaraan yang ditabrak)
    if (impact > 8 && hit) {                       // efek: percikan, serpihan, asap, guncangan, suara
      spawnCrash(hit.p[0], hit.p[1], hit.n[0], hit.n[1], impact, V.color);
      cam.shake = Math.min(1, cam.shake + impact / 110);
      if (hitCd <= 0) crashSound(impact);
    }
    if (impact > 12 && hitCd <= 0) {
      damage++; if (mission) mission.dmg++;
      hitCd = 0.7;
      const what = hit && hit.other ? (hit.other.npc ? 'kendaraan lain' : hit.other.name) : hit && hit.obj ? (hit.obj.label || ({ tree: 'pohon', house: 'rumah', fence: 'pagar', lamp: 'tiang lampu', signal: 'tiang lampu merah', tollbooth: 'gardu tol', cart: 'gerobak' }[hit.obj.kind] || 'bangunan')) : 'pembatas';
      if (!V.wreck && !(hit && hit.other && hit.other.wreck && hit.other.wreckT < 0.05)) showToast(`💥 Benturan dengan ${what}! (${Math.round(impact / PX_PER_M * 3.6)} km/j) −75 poin · kondisi ${Math.round(hpOf(V))}%`);
      rumble(clamp(impact / 70, 0.35, 1), 260);
    }
    if (V.type === 'motor' && impact > 45 && P.veh === V) throwRider(V);
  } else if (jack && V.v < 0) {
    V.v = 0;
    if (jackCd <= 0) { showToast('Jackknife! Pindah ke D dan maju sedikit untuk meluruskan'); rumble(0.5, 200); jackCd = 2; }
  }
  decayKnock(V, dt);
  // Di dalam fungsi driveUpdate(V, inp, dt):
  if (V.type === 'plane') {
    const s = V.spec;
    const currentSpeed = Math.abs(V.v);

    // Kontrol Pitch (Naik / Turun)
    // Tombol Q / D-pad Atas untuk menanjak (Climb)
    // Tombol E / D-pad Bawah untuk menukik (Descent)
    if (inp.pitchUp && currentSpeed >= s.vTakeoff) {
      V.pitch = Math.min(1, V.pitch + 2 * dt);
    } else if (inp.pitchDown) {
      V.pitch = Math.max(-1, V.pitch - 2 * dt);
    } else {
      V.pitch *= Math.exp(-dt * 3); // Kembali datar secara otomatis
    }

    // Perubahan Altitude
    if (V.pitch > 0 && currentSpeed >= s.vTakeoff) {
      V.alt = clamp(V.alt + V.pitch * s.climbRate * dt, 0, s.maxAlt);
    } else if (V.pitch < 0 || currentSpeed < s.vTakeoff) {
      // Pesawat turun jika hidung diturunkan atau kecepatan di bawah vTakeoff (stall)
      V.alt = Math.max(0, V.alt + (V.pitch < 0 ? V.pitch : -0.5) * s.climbRate * dt);
    }

    V.airborne = V.alt > 5;
    if (V.airborne) s.grip = 1.0;
  } else if (isVTOL(V)) {
    if (inp.liftUp && V.fuel > 0 && !V.wreck) V.alt = Math.min(s.maxAlt, V.alt + s.climbRate * dt);
    else if (inp.liftDown || V.fuel <= 0 || V.wreck) V.alt = Math.max(0, V.alt - s.climbRate * dt);
    V.airborne = V.alt > 5;
  }
  V.thrusting = V.type === 'falcon' && (inp.liftUp || inp.liftDown) && hasFuel && V.alt > 0;
  if (V.thrusting) {
    V.exhaustT = (V.exhaustT || 0) - dt;
    if (V.exhaustT <= 0) { spawnFalconSmoke(V); V.exhaustT = 0.08; }
  } else {
    V.exhaustT = 0;
    if (V.type === 'falcon') {
      for (let i = FX.length - 1; i >= 0; i--) {
        if (FX[i].sourceId === V.id) FX.splice(i, 1);
      }
    }
  }
  publishTelemetry(V, inp, dt);
}

/* ----- trailer selalu menempel di fifth wheel (pengaman, mis. setelah ganti 2D <-> 3D) ----- */
function resyncTrailers() {
  for (const V of vehicles) {
    const t = V.hooked;
    if (!t) continue;
    t.owner = V; t.state = 'hooked'; t.atBay = false;
    const [kx, ky] = fifthWheel(V);
    if (!Number.isFinite(t.ang) || Math.abs(wrap(V.ang - t.ang)) > MAX_HITCH + 0.05) t.ang = V.ang;
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || Math.hypot(t.x - kx, t.y - ky) > 2) { t.x = kx; t.y = ky; }
  }
  for (const t of trailers) {
    if (t.state === 'hooked' && !(t.owner && t.owner.hooked === t)) { t.state = 'parked'; t.owner = null; }
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.ang)) Object.assign(t, { x: t.bay.x, y: t.bay.y, ang: t.bay.angle * DEG, state: 'parked', atBay: true, owner: null });
  }
}

// arah gerak jalan kaki mengikuti arah kamera 3D (stik ke atas = menjauhi kamera)
function camRelMove(inp) {
  if (!is3D() || (!inp.mx && !inp.my)) return [inp.mx, inp.my];
  const y = Render3D.camYaw, fx = Math.cos(y), fy = Math.sin(y);
  return [inp.mx * -fy - inp.my * fx, inp.mx * fx - inp.my * fy];
}

function walkUpdate(inp, dt) {
  [inp.mx, inp.my] = camRelMove(inp);
  setHorn(false);
  const sp = (inp.run ? RUN_V : WALK_V) * (P.energy <= 0 ? 0.6 : 1);
  P.run = inp.run && (inp.mx || inp.my);
  if (inp.mx || inp.my) {
    const nx = P.x + inp.mx * sp * dt, ny = P.y + inp.my * sp * dt;
    if (!walkerBlocked(nx, P.y)) P.x = nx;
    if (!walkerBlocked(P.x, ny)) P.y = ny;
    P.ang = Math.atan2(inp.my, inp.mx);
    P.walkT += dt * sp;
  }
  walkInteract(inp, dt);
}

function npcUpdate(dt) {
  const focus = camFocus();
  for (const n of npcs) {
    if (n.service) {
      if (n.taxiService) taxiServiceUpdate(n, dt);
      else if (n.foodDelivery) foodServiceUpdate(n, dt);
      else serviceUpdate(n, dt);
      continue;
    }
    if (n.wreck) {                        // NPC hancur: diam di tempat, diderek setelah 30 detik
      n.v = 0; n.braking = false; knockUpdate(n, dt);
      if (n.wreckT > 30 && Math.hypot(n.x - focus.x, n.y - focus.y) > 450) {
        Object.assign(n, { hp: 100, wreck: false, wreckT: 0, kx: 0, ky: 0, spin: 0, stunT: 0 });
        n.pi = Math.random() < 0.5 ? 0 : 1; placeOnPath(n, n.paths[n.pi], Math.random() * 0.9);
      }
      continue;
    }
    // pure pursuit: kejar titik 60 px di depan proyeksi posisi pada garis lajur
    const [mx, my] = vehMid(n);
    let path = n.paths[n.pi], i = n.si, t = 0, L = 1;
    for (;;) {
      const p = path[i], q = path[i + 1];
      L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      t = ((mx - p[0]) * (q[0] - p[0]) + (my - p[1]) * (q[1] - p[1])) / L;
      if (t > L && i < path.length - 2) { i++; continue; }
      break;
    }
    n.si = i;
    if (i >= path.length - 2 && t > L - 30) {        // ujung jalan: putar balik ke lajur seberang
      const nextPi = 1 - n.pi, candidate = { ...n };
      placeOnPath(candidate, n.paths[nextPi], 0);

      // Tambahkan timer stuck agar jika macet > 2 detik di ujung, paksa putar balik
      n.turnStuck = (n.turnStuck || 0) + dt;
      if (collidesOther(candidate) && n.turnStuck < 2.5) { 
        n.v = 0; n.braking = true; continue; 
      }

      n.turnStuck = 0;
      n.pi = nextPi; 
      placeOnPath(n, n.paths[n.pi], 0); 
      
      // FIX: Sinkronkan sudut hadap (ang) dengan arah segmen pertama jalur baru agar tidak berputar
      const pNew = n.paths[n.pi][0], qNew = n.paths[n.pi][1];
      if (pNew && qNew) {
        n.ang = Math.atan2(qNew[1] - pNew[1], qNew[0] - pNew[0]);
      }

      n.v = Math.max(n.v, 30); // Beri sedikit dorongan kecepatan agar tidak langsung berhenti
      continue;
    }
    let rem = 60, k = i, tt = Math.max(0, t), tx = mx, ty = my;
    while (k < path.length - 1) {
      const p = path[k], q = path[k + 1], Lk = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      if (tt + rem <= Lk) { tx = p[0] + (q[0] - p[0]) / Lk * (tt + rem); ty = p[1] + (q[1] - p[1]) / Lk * (tt + rem); break; }
      rem -= Lk - tt; tt = 0; k++; tx = q[0]; ty = q[1];
    }
    
    const want = Math.atan2(ty - my, tx - mx);
    
    // FIX: Batasi kecepatan rotasi sudut (mencegah glitch berputar-putar cepat / spinning)
    const angleDiff = wrap(want - n.ang);
    const maxTurnRate = 2.5 * dt; // Batas kecepatan putar per frame
    n.ang = wrap(n.ang + clamp(angleDiff, -maxTurnRate, maxTurnRate));

    // berhenti bila ada sesuatu di depan
    const probe = rectPoly(n.x, n.y, n.ang, n.spec.front + 2, n.spec.front + 70, n.spec.hw + 4);
    let blocked = false;
    if (n.stunT > 0) { n.stunT -= dt; blocked = true; }
    n.redStop = false;
    if (!blocked) {                                     // lampu lalu lintas
      const sa = armAhead(n, 95);
      if (sa) {
        const st = sigState(sa.a.sig, sa.a.phase);
        if (st === 'r' && sa.d > -4 || st === 'y' && sa.d > 30) { blocked = true; n.redStop = true; n.stopD = sa.d; }
      }
    }
    if (!blocked) for (const v of vehicles) if (overlap(probe, vehPoly(v))) { blocked = true; break; }
    if (!blocked) for (const tr of trailers) if (overlap(probe, trailerPoly(tr))) { blocked = true; break; }
    let queue = false;                                  // antre di belakang NPC lain (mis. lampu merah): tidak perlu klakson
    if (!blocked) for (const o of npcs) if (o !== n && overlap(probe, vehPoly(o))) { blocked = true; queue = true; break; }
    if (!blocked && P.mode === 'walk' && overlap(probe, walkerPoly(P.x, P.y, 10))) blocked = true;

    // Cek jika NPC terjebak macet/stuck di tempat yang sama
    if (blocked) {
      n.stuckSec = (n.stuckSec || 0) + dt;
      if (n.stuckSec > 5.0) {
        // Jika sudah 5 detik stuck, paksa abaikan hambatan sementara agar bisa jalan lagi
        blocked = false;
        n.v = 40; // Beri sedikit kecepatan dorong
        n.stuckSec = 0;
      }
    } else {
      n.stuckSec = 0;
    }

    // FIX TAMBAHAN: Jika NPC mengalami kecepatan sangat rendah tapi sudutnya berubah drastis (indikasi berputar-putar), reset arah ke waypoint depan
    if (Math.abs(n.v) < 1 && Math.abs(angleDiff) > 1.5) {
      n.ang = want; // Langsung arahkan ke target tanpa interpolasi lambat
      n.v = 15;     // Dorong keluar dari posisi macet/putar
    }

    const target = !blocked ? n.cruise : n.redStop ? clamp((n.stopD - 6) * 2.4, 0, n.cruise) : 0;   // berhenti halus tepat di garis henti
    n.v += clamp(target - n.v, -260 * dt, 70 * dt);
    n.braking = blocked;
    n.blockedT = blocked && n.v < 1 && !n.redStop && !queue ? n.blockedT + dt : 0;
    n.honkCd -= dt;
    if (n.blockedT > 1.6 && n.honkCd <= 0) {
      n.honkCd = 4;
      if (Math.hypot(n.x - focus.x, n.y - focus.y) < 600) { tone(420, 0.15, 0.04); tone(420, 0.2, 0.04, 'square', 0.22); }
    }
    n.x += Math.cos(n.ang) * n.v * dt; n.y += Math.sin(n.ang) * n.v * dt;
    knockUpdate(n, dt);
  }
  untangleVehicles(dt);
  for (const v of vehicles) if (v !== P.veh || P.mode !== 'drive') knockUpdate(v, dt);
}

function update(dt, inp) {
  if (state !== 'play') { setHorn(false); updateVehicleSound(null, inp, dt); return; }
  if (BUILD.open) { updateVehicleSound(null, inp, dt); builderUpdate(inp); return; }        // dunia berhenti selama di layar rakit
  if (LEARN.open) { updateVehicleSound(null, inp, dt); learnUpdate(inp, dt); return; }      // … dan selama minigame belajar
  if (typeof FMX !== 'undefined' && FMX.open) { updateVehicleSound(null, inp, dt); fmxUpdate(inp, dt); return; } // minigame Formulatrix
  elapsed += dt; hitCd -= dt; jackCd -= dt;
  if (mission) mission.t += dt;
  const h0 = clock;
  clock = (clock + dt / HOUR_SEC * (P.resting === 'bed' ? 24 : 1)) % 24;
  if (h0 < 18 && clock >= 18) showToast('🌆 Hari mulai gelap — lampu kendaraan & jalan menyala', 3.5);
  if (h0 < 5.5 && clock >= 5.5) showToast('🌅 Subuh — hari mulai terang', 3);
  if (nextMissionT > 0) { nextMissionT -= dt; if (nextMissionT <= 0) newMission(); }
  fxUpdate(dt);
  damageFx(dt);
  resyncTrailers();
  for (const V of vehicles) if (isDumpTruck(V)) dumpStep(V, dt);
  for (const V of vehicles) if (V.type === 'tanker') tankerStep(V, dt);
  for (const V of vehicles) if (V.type === 'paver' && V.paving && P.veh !== V) stopPaving(V, 'Sopir turun dari paver');
  for (const V of vehicles) if (V.type === 'milling' && V.milling && P.veh !== V) stopMilling(V, 'Sopir turun dari road milling');

  // tenaga sopir & pekerjaan antar
  fadeStep(dt);
  if (foodJob) updateFoodJob(dt);
  if (taxiJob) updateTaxiJob(dt);
  const frozen = fade.dir !== 0;        // input dibekukan selama layar menggelap
  P.energy = Math.max(0, P.energy - (P.mode === 'drive' ? 0.07 : P.mode === 'inside' ? 0.02 : P.run ? 0.12 : 0.05) * dt);
  if (P.energy < 25 && !P.warnE) { P.warnE = true; showToast('Sopir mulai lapar — tekan U / klik Tenaga untuk Pesan Delivery Food atau jajan di warung', 4.5); }
  if (P.energy >= 30) P.warnE = false;
  if (P.energy <= 0 && !P.warnE0) { P.warnE0 = true; showToast('Sopir kelelahan! Kendaraan & langkah melambat — pesan Delivery Food (U)', 4.5); }
  if (P.energy > 5) P.warnE0 = false;

  if (!frozen) {
    if (inp.y && (P.mode === 'walk' || P.mode === 'drive')) toggleVehicle();
      if (P.mode === 'drive') driveUpdate(P.veh, inp, dt);
    else if (P.mode === 'inside') insideUpdate(inp, dt);
      else if (P.mode === 'taxi') setHorn(false);
      else walkUpdate(inp, dt);
  }
  updateVehicleSound(!frozen && P.mode === 'drive' ? P.veh : null, inp, dt);
  updateActors(dt);
  npcUpdate(dt);
}

/* ----------------------------- Kamera ------------------------------------ */
function resize() {
  dpr = window.devicePixelRatio || 1;
  cvs.width = Math.round(innerWidth * dpr); cvs.height = Math.round(innerHeight * dpr);
  const r = mini.getBoundingClientRect();
  mini.width = Math.round(r.width * dpr); mini.height = Math.round(r.height * dpr);
  const bm = $('bigmap'), br = bm.getBoundingClientRect();
  bm.width = Math.round(br.width * dpr); bm.height = Math.round(br.height * dpr);
}
addEventListener('resize', resize);

function camFocus() {
  if (P.mode === 'drive') return { x: P.veh.x, y: P.veh.y };
  return { x: P.x, y: P.y };
}
function updateCamera(dt) {
  const walking = P.mode !== 'drive';
  cam.scale = cvs.height / (ZOOMS[cam.zoom] * (walking ? 0.6 : 1) * cam.zf);
  let tx, ty;
  if (walking) { tx = P.x; ty = P.y; }
  else {
    const V = P.veh;
    tx = V.x; ty = V.y;
    if (V.hooked) { tx = (tx + V.hooked.x - Math.cos(V.hooked.ang) * 60) / 2; ty = (ty + V.hooked.y - Math.sin(V.hooked.ang) * 60) / 2; }
    const look = clamp(V.v, -60, 150) * 0.9;
    tx += Math.cos(V.ang) * look; ty += Math.sin(V.ang) * look;
  }
  const k = Math.min(1, dt * 3.5);
  cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
  const hw = cvs.width / 2 / cam.scale, hh = cvs.height / 2 / cam.scale;
  cam.x = W > 2 * hw ? clamp(cam.x, hw, W - hw) : W / 2;
  cam.y = H > 2 * hh ? clamp(cam.y, hh, H - hh) : H / 2;
  if (cam.shake > 0.02 && !MODE3D) { cam.x += (Math.random() - 0.5) * cam.shake * 10; cam.y += (Math.random() - 0.5) * cam.shake * 10; }
}

function camInput(inp, dt) {         // stik kanan / J K I O / geser mouse
  const active = Math.abs(inp.camX) > 0.02 || Math.abs(inp.camY) > 0.02;
  cam.idleT = active ? 0 : cam.idleT + dt;
  if (MODE3D) {
    cam.orbit = wrap(cam.orbit + inp.camX * 2.4 * dt);
    cam.tilt = clamp(cam.tilt + inp.camY * 1.3 * dt, -0.45, 0.95);
    // saat menyetir & stik dilepas 2 detik, kamera kembali ke belakang kendaraan
    if (P.mode === 'drive' && cam.view3d === 'chase' && cam.idleT > 2) cam.orbit *= Math.exp(-dt * 1.6);
  } else if (Math.abs(inp.camY) > 0.02) cam.zf = clamp(cam.zf * Math.exp(inp.camY * 1.2 * dt), 0.55, 2.2);
  cam.shake *= Math.exp(-dt * 6);
}
const toScreen = (x, y) => (is3D() ? Render3D.project(x, y, 6)
  : [(x - cam.x) * cam.scale + cvs.width / 2, (y - cam.y) * cam.scale + cvs.height / 2]);

/* ----------------------------- Render dunia ------------------------------ */
// Peta panjang (3000 × 8400 px) digambar langsung tiap frame, hanya bagian yang terlihat.
function makePattern(base, n, extra, size = 160) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < n; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.08)';
    g.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  if (extra) extra(g, size);
  return ctx.createPattern(c, 'repeat');
}
function buildPatterns() {
  PAT.grass = makePattern('#3d5a3a', 900, (g, s) => {
    for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(80,120,60,0.35)'; g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 3 + Math.random() * 5, 0, 7); g.fill(); }
  });
  PAT.asphalt = makePattern('#41464d', 1200);
  PAT.yard = makePattern('#3b4047', 1200);
  PAT.paving = makePattern('#6b6258', 900, (g, s) => { g.strokeStyle = 'rgba(0,0,0,0.12)'; for (let i = 0; i < s; i += 20) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.moveTo(0, i); g.lineTo(s, i); g.stroke(); } });
  PAT.sawah = makePattern('#6b9a3c', 300, (g, s) => {
    g.strokeStyle = 'rgba(40,80,20,0.45)'; g.lineWidth = 2;
    for (let y = 4; y < s; y += 8) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
  });
}
const PAD_PAT = { yard: 'yard', spbu: 'yard', driveway: 'paving', warung: 'paving', market: 'paving', parking: 'asphalt',
  tollplaza: 'asphalt', plaza: 'paving', bengkel: 'asphalt',
  paving: 'paving', showroom: 'asphalt', resort: 'paving', school: 'yard' };

function viewRect(m = 80) {
  const hw = cvs.width / 2 / cam.scale, hh = cvs.height / 2 / cam.scale;
  return { x0: cam.x - hw - m, y0: cam.y - hh - m, x1: cam.x + hw + m, y1: cam.y + hh + m };
}
const visible = (v, x0, y0, x1, y1) => !(x1 < v.x0 || x0 > v.x1 || y1 < v.y0 || y0 > v.y1);

function strokePath(pts) {
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

function offsetPath(pts, off) {        // garis sejajar polyline (geser tegak lurus)
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0] - (b[1] - a[1]) / L * off, p[1] + (b[0] - a[0]) / L * off];
  });
}
function drawRoads(v) {
  const rs = level.roads.filter((r) => visible(v, r.bb.x, r.bb.y, r.bb.x + r.bb.w, r.bb.y + r.bb.h));
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const r of rs) if (r.kind === 'toll') {         // jalan tol: bahu beton + pagar pengaman (guard rail)
    ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = r.w + 14; strokePath(r.pts);
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = r.w + 8; strokePath(r.pts);
  }
  for (const r of rs) { ctx.strokeStyle = PAT.asphalt; ctx.lineWidth = r.w; strokePath(r.pts); }
  for (const r of rs) { ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = r.w - 12; strokePath(r.pts); }
  for (const r of rs) { ctx.strokeStyle = PAT.asphalt; ctx.lineWidth = r.w - 18; strokePath(r.pts); }
  ctx.lineCap = 'butt';
  for (const r of rs) {
    if (r.w < 100 || r.kind === 'access') continue;
    if (r.kind === 'toll') {                          // tol: 2 lajur per arah, garis tengah ganda kuning
      ctx.setLineDash([]); ctx.strokeStyle = 'rgba(250,204,21,0.85)'; ctx.lineWidth = 2.5;
      strokePath(offsetPath(r.pts, -4)); strokePath(offsetPath(r.pts, 4));
      ctx.setLineDash([30, 30]); ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 2.5;
      strokePath(offsetPath(r.pts, -r.w / 4)); strokePath(offsetPath(r.pts, r.w / 4));
      continue;
    }
    ctx.setLineDash([28, 24]); ctx.strokeStyle = 'rgba(250,204,21,0.75)'; ctx.lineWidth = 3; strokePath(r.pts);
  }
  ctx.setLineDash([]);
  for (const bridge of level.bridges || []) {
    const co = Math.cos(bridge.angle), si = Math.sin(bridge.angle);
    const a = [bridge.x - co * bridge.length / 2, bridge.y - si * bridge.length / 2];
    const b = [bridge.x + co * bridge.length / 2, bridge.y + si * bridge.length / 2];
    ctx.lineCap = 'round'; ctx.strokeStyle = '#64748b'; ctx.lineWidth = bridge.width + 10; strokePath([a, b]);
    ctx.strokeStyle = '#40454c'; ctx.lineWidth = bridge.width; strokePath([a, b]);
    ctx.lineCap = 'butt'; ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 3;
    for (const side of [-1, 1]) {
      const ox = -si * side * (bridge.width / 2 - 3), oy = co * side * (bridge.width / 2 - 3);
      strokePath([[a[0] + ox, a[1] + oy], [b[0] + ox, b[1] + oy]]);
    }
  }
  ctx.lineCap = 'butt';
}

function drawObstacle(o) {
  const g = ctx;
  if (o.kind === 'tree') {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.arc(cx + 4, cy + 4, 18, 0, 7); g.fill();
    g.fillStyle = '#2f6b33'; g.beginPath(); g.arc(cx, cy, 18, 0, 7); g.fill();
    g.fillStyle = '#3f8a43'; g.beginPath(); g.arc(cx - 4, cy - 4, 11, 0, 7); g.fill();
  } else if (o.kind === 'fence') {
    g.fillStyle = '#a3acb6'; g.fillRect(o.x, o.y + o.h / 2 - 2, o.w, 4); g.fillRect(o.x + o.w / 2 - 2, o.y, 4, o.h);
    g.fillStyle = '#6b7480';
    if (o.w > o.h) for (let x = o.x; x <= o.x + o.w; x += 40) g.fillRect(x - 3, o.y, 6, o.h);
    else for (let y = o.y; y <= o.y + o.h; y += 40) g.fillRect(o.x, y - 3, o.w, 6);
  } else if (o.kind === 'terminal') {
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 5, o.y + 5, o.w, o.h);
    g.fillStyle = '#64748b'; g.fillRect(o.x, o.y + o.h - 8, o.w, 8);
    g.fillStyle = '#e5e7eb'; for (const x of [o.x + 6, o.x + o.w - 10]) for (const y of [o.y + 6, o.y + o.h - 18]) g.fillRect(x, y, 4, 18);
    g.fillStyle = '#1d4ed8'; g.fillRect(o.x - 4, o.y, o.w + 8, 8);
    g.fillStyle = '#facc15'; g.fillRect(o.x + o.w / 2 - 28, o.y - 7, 56, 8);
  } else if (o.kind === 'bus') {
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(o.x + 4, o.y + 4, o.w, o.h);
    g.fillStyle = '#111827'; g.fillRect(o.x + 8, o.y + o.h - 5, o.w - 16, 5);
    g.fillStyle = o.color || '#facc15'; g.beginPath(); g.roundRect(o.x, o.y, o.w, o.h, 6); g.fill();
    g.fillStyle = '#1e3a5f'; g.fillRect(o.x + 10, o.y + 5, o.w - 30, 11);
    for (let x = o.x + 17; x < o.x + o.w - 22; x += 19) {
      g.fillStyle = 'rgba(191,219,254,0.9)'; g.fillRect(x, o.y + 6, 14, 9);
    }
    g.fillStyle = '#bfdbfe'; g.fillRect(o.x + o.w - 15, o.y + 6, 9, o.h - 12);
    g.fillStyle = '#f8fafc'; g.fillRect(o.x + 3, o.y + 8, 3, o.h - 16);
    g.fillStyle = '#111827'; g.beginPath();
    for (const x of [o.x + 22, o.x + o.w - 31]) { g.arc(x, o.y + 2, 5, 0, 7); g.arc(x, o.y + o.h - 2, 5, 0, 7); }
    g.fill();
  } else if (o.kind === 'house') {
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 5, o.y + 5, o.w, o.h);
    g.fillStyle = o.color || '#9a3412'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    if (o.w >= o.h) g.fillRect(o.x, o.y, o.w, o.h / 2); else g.fillRect(o.x, o.y, o.w / 2, o.h);
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 2; g.beginPath();
    if (o.w >= o.h) { g.moveTo(o.x, o.y + o.h / 2); g.lineTo(o.x + o.w, o.y + o.h / 2); }
    else { g.moveTo(o.x + o.w / 2, o.y); g.lineTo(o.x + o.w / 2, o.y + o.h); }
    g.stroke();
  } else if (o.kind === 'pump') {
    g.fillStyle = '#d1d5db'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = '#dc2626'; g.fillRect(o.x + 10, o.y + 3, 22, o.h - 6); g.fillRect(o.x + o.w - 32, o.y + 3, 22, o.h - 6);
  } else if (o.kind === 'warung' || o.kind === 'market') {
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 6, o.y + 6, o.w, o.h);
    g.fillStyle = o.kind === 'market' ? '#b45309' : '#0f766e'; g.fillRect(o.x, o.y, o.w, o.h);
    for (let x = o.x; x < o.x + o.w; x += 25) { g.fillStyle = Math.round((x - o.x) / 25) % 2 ? '#fde68a' : '#ef4444'; g.fillRect(x, o.y - 8, Math.min(25, o.x + o.w - x), 10); }
  } else if (o.kind === 'shop') {
    g.fillStyle = '#f1f5f9'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = '#dc2626'; g.fillRect(o.x, o.y + o.h - 8, o.w, 8);
  } else if (o.kind === 'displaycar') {
    /* digambar sebagai mobil (lihat drawDisplayCars) */
  } else if (o.kind === 'bengkel') {       // gedung bengkel: atap seng oranye + 3 pintu garasi menghadap barat
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(o.x + 7, o.y + 7, o.w, o.h);
    g.fillStyle = o.color || '#ea580c'; g.fillRect(o.x, o.y, o.w, o.h);
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 2; for (let y = o.y + 10; y < o.y + o.h; y += 12) { g.beginPath(); g.moveTo(o.x, y); g.lineTo(o.x + o.w, y); g.stroke(); }
    g.fillStyle = '#374151'; for (let k = 0; k < 3; k++) g.fillRect(o.x - 4, o.y + 20 + k * 70, 6, 50);
  } else if (o.kind === 'partsrack') {     // gudang suku cadang: rak ban & mesin
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 5, o.y + 5, o.w, o.h);
    g.fillStyle = '#6b7280'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = '#111827'; for (let x = o.x + 12; x < o.x + o.w - 6; x += 18) { g.beginPath(); g.arc(x, o.y + 16, 7, 0, 7); g.fill(); }
    g.fillStyle = '#9ca3af'; for (let x = o.x + 8; x < o.x + o.w - 16; x += 26) g.fillRect(x, o.y + 36, 18, 22);
  } else if (o.kind === 'signal') {        /* tiang lampu lalu lintas: digambar di drawSignals2D */
  } else if (o.kind === 'monument') {      // Patung Tiga Pahlawan di tengah alun-alun
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 5, o.y + 5, o.w, o.h);
    g.fillStyle = '#e7e5e4'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = '#a8a29e'; g.fillRect(o.x + 6, o.y + 6, o.w - 12, o.h - 12);
    g.fillStyle = '#57534e'; for (const [dx, dy] of [[0.3, 0.38], [0.5, 0.62], [0.7, 0.38]]) { g.beginPath(); g.arc(o.x + o.w * dx, o.y + o.h * dy, 4.5, 0, 7); g.fill(); }
  } else if (o.kind === 'cart') {           // gerobak wedang ronde
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 3, o.y + 3, o.w, o.h);
    g.fillStyle = o.color || '#b45309'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = '#fef3c7'; g.fillRect(o.x + 3, o.y + 3, o.w - 6, 5);
    g.fillStyle = '#111827'; g.beginPath(); g.arc(o.x + 5, o.y + o.h + 1, 3, 0, 7); g.arc(o.x + o.w - 5, o.y + o.h + 1, 3, 0, 7); g.fill();
  } else if (o.kind === 'kumon') {          // gedung les Kumon: biru + papan nama
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 6, o.y + 6, o.w, o.h);
    g.fillStyle = '#e0f2fe'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = o.color || '#0369a1'; g.fillRect(o.x, o.y, o.w, 16);
    g.fillStyle = 'rgba(3,105,161,0.35)'; for (let x = o.x + 12; x < o.x + o.w - 12; x += 28) g.fillRect(x, o.y + 26, 16, o.h - 40);
  } else if (o.kind === 'lamp') {
    g.fillStyle = '#6b7280'; g.beginPath(); g.arc(o.x + 3, o.y + 3, 3.5, 0, 7); g.fill();
  } else if (o.kind === 'store') {           // Toko Luwes
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 6, o.y + 6, o.w, o.h);
    g.fillStyle = '#f8fafc'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = o.color || '#15803d'; g.fillRect(o.x, o.y + o.h - 14, o.w, 14);
    for (let x = o.x + 10; x < o.x + o.w - 10; x += 30) { g.fillStyle = '#bfdbfe'; g.fillRect(x, o.y + o.h - 11, 20, 8); }
  } else if (o.kind === 'showroom') {        // dealer Mitsubishi: kaca + atap merah
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 6, o.y + 6, o.w, o.h);
    g.fillStyle = '#e5e7eb'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = '#9fc3df'; g.fillRect(o.x + 6, o.y + 6, o.w - 30, o.h - 12);
    g.fillStyle = '#dc2626'; g.fillRect(o.x + o.w - 22, o.y, 22, o.h);
    g.save(); g.translate(o.x + o.w - 11, o.y + 30); g.fillStyle = '#fff';           // logo tiga berlian
    for (const a of [0, 2.094, 4.189]) { g.save(); g.rotate(a); g.beginPath(); g.moveTo(0, 0); g.lineTo(3, -5); g.lineTo(0, -10); g.lineTo(-3, -5); g.closePath(); g.fill(); g.restore(); }
    g.restore();
  } else if (o.kind === 'hotel') {           // Hotel Laras Asri: atap joglo bertingkat
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(o.x + 8, o.y + 8, o.w, o.h);
    g.fillStyle = o.color || '#7c2d12'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = '#9a3412'; g.fillRect(o.x + 20, o.y + 15, o.w - 40, o.h - 30);
    g.fillStyle = '#b45309'; g.fillRect(o.x + 50, o.y + 35, o.w - 100, o.h - 70);
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(o.x, o.y); g.lineTo(o.x + 50, o.y + 35); g.moveTo(o.x + o.w, o.y); g.lineTo(o.x + o.w - 50, o.y + 35);
    g.moveTo(o.x, o.y + o.h); g.lineTo(o.x + 50, o.y + o.h - 35); g.moveTo(o.x + o.w, o.y + o.h); g.lineTo(o.x + o.w - 50, o.y + o.h - 35); g.stroke();
  } else if (o.kind === 'school') {
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 6, o.y + 6, o.w, o.h);
    g.fillStyle = o.color || '#166534'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = 'rgba(255,255,255,0.12)'; if (o.w > o.h) g.fillRect(o.x, o.y, o.w, o.h / 2); else g.fillRect(o.x, o.y, o.w / 2, o.h);
  } else if (o.kind === 'mosque') {
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(o.x + 6, o.y + 6, o.w, o.h);
    g.fillStyle = '#f8fafc'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = '#15803d'; g.beginPath(); g.arc(o.x + o.w / 2, o.y + o.h / 2, o.w * 0.33, 0, 7); g.fill();
    g.fillStyle = '#fde047'; g.beginPath(); g.arc(o.x + o.w / 2, o.y + o.h / 2, 4, 0, 7); g.fill();
  } else if (o.kind === 'tollbooth') {
    g.fillStyle = '#fbbf24'; g.fillRect(o.x, o.y, o.w, o.h);
  } else if (o.kind === 'factory') {
    g.fillStyle = '#64748b'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    for (let y = o.y + 6; y < o.y + o.h - 10; y += 26) g.fillRect(o.x + 6, y, o.w - 12, 12);
  } else {
    g.fillStyle = o.kind === 'dock' ? '#4b5563' : '#59606b'; g.fillRect(o.x, o.y, o.w, o.h);
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(o.x + 8, o.y + 8, o.w - 16, o.h - 16);
    g.strokeStyle = '#2a2f36'; g.lineWidth = 3; g.strokeRect(o.x + 1.5, o.y + 1.5, o.w - 3, o.h - 3);
  }
}

function drawGround(v) {
  ctx.fillStyle = PAT.grass; ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
  for (const sw of level.sawah) {
    if (!visible(v, sw.x, sw.y, sw.x + sw.w, sw.y + sw.h)) continue;
    ctx.fillStyle = PAT.sawah; ctx.fillRect(sw.x, sw.y, sw.w, sw.h);
    ctx.strokeStyle = '#7a6a3a'; ctx.lineWidth = 5; ctx.strokeRect(sw.x, sw.y, sw.w, sw.h);
  }
  for (const d of level.decor) {
    if (d.kind !== 'arena' || !visible(v, d.x - d.rx, d.y - d.ry, d.x + d.rx, d.y + d.ry)) continue;
    ctx.fillStyle = '#a16207'; ctx.beginPath(); ctx.ellipse(d.x, d.y, d.rx, d.ry, 0, 0, 7); ctx.fill();
    ctx.fillStyle = PAT.grass; ctx.beginPath(); ctx.ellipse(d.x, d.y, d.rx - 50, d.ry - 50, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 3;
    for (const k of [0, 50]) { ctx.beginPath(); ctx.ellipse(d.x, d.y, d.rx - k, d.ry - k, 0, 0, 7); ctx.stroke(); }
  }
  for (const p of level.pads) {
    if (!visible(v, p.x, p.y, p.x + p.w, p.y + p.h)) continue;
    ctx.fillStyle = PAT[PAD_PAT[p.kind] || 'yard']; ctx.fillRect(p.x, p.y, p.w, p.h);
  }
  drawRoads(v);
  for (const d of level.decor) {
    if (d.kind === 'pool' && visible(v, d.x, d.y, d.x + d.w, d.y + d.h)) {
      ctx.fillStyle = '#e7e5e4'; ctx.fillRect(d.x - 6, d.y - 6, d.w + 12, d.h + 12);
      ctx.fillStyle = '#38bdf8'; ctx.fillRect(d.x, d.y, d.w, d.h);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5;
      for (let y = d.y + 10; y < d.y + d.h; y += 14) { ctx.beginPath(); ctx.moveTo(d.x + 4, y); ctx.quadraticCurveTo(d.x + d.w / 2, y + 4, d.x + d.w - 4, y); ctx.stroke(); }
    } else if (d.kind === 'alun' && visible(v, d.x, d.y, d.x + d.w, d.y + d.h)) {
      ctx.fillStyle = '#4f8a3a'; ctx.fillRect(d.x + 16, d.y + 16, d.w - 32, d.h - 32);              // lapangan rumput
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 12;
      for (let x = d.x + 30; x < d.x + d.w - 20; x += 24) { ctx.beginPath(); ctx.moveTo(x, d.y + 16); ctx.lineTo(x, d.y + d.h - 16); ctx.stroke(); }
      ctx.fillStyle = '#d6cfc2';                                                                      // jalur silang ke patung
      ctx.fillRect(d.x + d.w / 2 - 9, d.y + 16, 18, d.h - 32); ctx.fillRect(d.x + 16, d.y + d.h / 2 - 9, d.w - 32, 18);
      ctx.beginPath(); ctx.arc(d.x + d.w / 2, d.y + d.h / 2, 46, 0, 7); ctx.fill();
      ctx.strokeStyle = '#a8a29e'; ctx.lineWidth = 2; ctx.strokeRect(d.x + 16, d.y + 16, d.w - 32, d.h - 32);
    } else if (d.kind === 'field' && visible(v, d.x, d.y, d.x + d.w, d.y + d.h)) {
      ctx.fillStyle = '#4d7c0f'; ctx.fillRect(d.x, d.y, d.w, d.h);
      ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 2; ctx.strokeRect(d.x + 4, d.y + 4, d.w - 8, d.h - 8);
      ctx.beginPath(); ctx.moveTo(d.x + 4, d.y + d.h / 2); ctx.lineTo(d.x + d.w - 4, d.y + d.h / 2); ctx.stroke();
    } else if (d.kind === 'schoolzone' && visible(v, 0, d.y0, W, d.y1)) {
      for (const yy of [d.y0, d.y1 - 70]) {        // cat merah "ZONA SELAMAT SEKOLAH" di aspal
        const x = mainX(yy + 35);
        ctx.fillStyle = 'rgba(185,28,28,0.75)'; ctx.fillRect(x - MAIN.w / 2 + 8, yy, MAIN.w - 16, 70);
        ctx.save(); ctx.translate(x, yy + 35); ctx.fillStyle = '#fef2f2'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('ZONA SELAMAT', 0, -8); ctx.fillText('SEKOLAH', 0, 10); ctx.restore();
      }
    }
  }
  // atap SPBU (tembus pandang)
  for (const d of level.decor) {
    if (d.kind !== 'canopy' || !visible(v, d.x, d.y, d.x + d.w, d.y + d.h)) continue;
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(d.x, d.y, d.w, d.h);
    ctx.strokeStyle = 'rgba(239,68,68,0.8)'; ctx.lineWidth = 5; ctx.strokeRect(d.x, d.y, d.w, d.h);
  }
  // marka dock & pintu gudang
  for (const b of level.bays) {
    if (!visible(v, b.x - 200, b.y - 200, b.x + 200, b.y + 200)) continue;
    ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.angle * DEG);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 3;
    for (const sy of [-70, 70]) { ctx.beginPath(); ctx.moveTo(TRAILER.rear - 6, sy); ctx.lineTo(TRAILER.rear + 190, sy); ctx.stroke(); }
    ctx.fillStyle = '#1f242b'; ctx.fillRect(TRAILER.rear - 20, -30, 14, 60);
    ctx.fillStyle = '#facc15'; for (let i = 0; i < 6; i++) ctx.fillRect(TRAILER.rear - 20, -30 + i * 10, 14, 4);
    ctx.restore();
  }
  for (const O of OBS) if (visible(v, O.x0, O.y0, O.x1, O.y1)) drawObstacle(O.o);
}

function drawOverhead(v) {        // jalan tol layang, kanopi gerbang tol & gapura (di atas kendaraan)
  for (const d of level.decor) {
    if (d.kind === 'tollgate' && visible(v, d.x - d.w, d.y - d.w, d.x + d.w, d.y + d.w)) {
      const hw = d.w / 2, cw = 50;
      ctx.save(); ctx.translate(d.x, d.y); if (d.horizontal) ctx.rotate(Math.PI / 2);
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(-hw + 10, -cw / 2 + 12, d.w, cw);
      ctx.fillStyle = 'rgba(30,64,175,0.55)'; ctx.fillRect(-hw, -cw / 2, d.w, cw);
      ctx.fillStyle = 'rgba(250,204,21,0.9)'; ctx.fillRect(-hw, -cw / 2, d.w, 6);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(d.label, 0, 6);
      ctx.restore();
      continue;
    }
    if (d.kind === 'toll' && visible(v, d.bb.x0, d.bb.y0, d.bb.x1, d.bb.y1)) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
      ctx.save(); ctx.translate(14, 18); ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = d.w + 10; strokePath(d.pts); ctx.restore();
      ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = d.w; strokePath(d.pts);
      ctx.strokeStyle = '#4b5563'; ctx.lineWidth = d.w - 14; strokePath(d.pts);
      ctx.setLineDash([24, 20]); ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 3; strokePath(d.pts); ctx.setLineDash([]);
      const [a, b] = [d.pts[1], d.pts[2]];
      ctx.save(); ctx.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 22); ctx.rotate(Math.atan2(b[1] - a[1], b[0] - a[0]));
      ctx.fillStyle = '#e5e7eb'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${d.label} (jalan layang)`, 0, 0);
      ctx.restore();
    } else if (d.kind === 'gapura' && visible(v, d.x - d.w, d.y - 60, d.x + d.w, d.y + 60)) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(d.x - d.w / 2 + 8, d.y - 8 + 8, d.w, 22);
      ctx.fillStyle = '#7c2d12'; ctx.fillRect(d.x - d.w / 2 - 14, d.y - 22, 26, 44); ctx.fillRect(d.x + d.w / 2 - 12, d.y - 22, 26, 44);
      ctx.fillStyle = 'rgba(180,83,9,0.9)'; ctx.fillRect(d.x - d.w / 2, d.y - 9, d.w, 18);
      ctx.fillStyle = '#fef3c7'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(d.title || 'SRUWEN', d.x, d.y);
      ctx.font = 'bold 15px sans-serif'; ctx.fillStyle = '#fde68a'; ctx.textAlign = 'left'; ctx.fillText(d.label, d.x + d.w / 2 + 24, d.y); ctx.textAlign = 'center';
    }
  }
}

const PLACE_ICON = { house: '🏠', pump: '⛽', shop: '🛒', warung: '🍜', oleh: '🎁', hotel: '🏨', dealer: '🚗', school: '🏫', kumon: '📚', ronde: '🍵', alun: '🌳', bengkel: '🔧', amp: '🏗️', wisata: '🌲' };
function drawLabels(now, v) {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // nama wilayah (besar, di tanah)
  for (const r of level.regions) {
    if (r.x0 != null && r.name !== 'Randuacir, Argomulyo') continue;
    const y = r.x0 != null ? (r.y0 + r.y1) / 2 + 120 : r.y0 + 230, x = r.x0 != null ? (r.x0 + r.x1) / 2 - 40 : mainX(y) + 380;
    if (!visible(v, x - 300, y - 40, x + 300, y + 40)) continue;
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.font = 'bold 44px sans-serif'; ctx.fillText(r.name.toUpperCase(), x, y);
  }
  for (const O of OBS) {
    const o = O.o;
    if (!o.label || !visible(v, O.x0, O.y0, O.x1, O.y1)) continue;
    ctx.save(); ctx.fillStyle = o.kind === 'shop' ? '#7f1d1d' : 'rgba(255,255,255,0.88)';
    ctx.font = `bold ${o.kind === 'house' ? 16 : 18}px sans-serif`;
    ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
    if (o.h > o.w * 1.6) ctx.rotate(-Math.PI / 2);
    ctx.fillText(o.label, 0, 0); ctx.restore();
  }
  for (const d of level.decor) {
    if (d.kind === 'canopy' && visible(v, d.x, d.y - 30, d.x + d.w, d.y)) {
      ctx.fillStyle = '#fecaca'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(d.label, d.x + d.w / 2, d.y - 14);
    } else if (d.kind === 'arena' && visible(v, d.x - d.rx, d.y - d.ry, d.x + d.rx, d.y + d.ry)) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(d.label, d.x, d.y);
    }
  }
  for (const l of level.labels) {
    if (!visible(v, l.x - 250, l.y - 30, l.x + 250, l.y + 30)) continue;
    ctx.fillStyle = 'rgba(253,230,138,0.9)'; ctx.font = `bold ${l.size || 16}px sans-serif`; ctx.fillText(l.text, l.x, l.y);
  }
  // nama jalan di badan jalan
  ctx.font = 'bold 13px sans-serif';
  for (const rl of ROADLABELS) {
    if (!visible(v, rl.x - 120, rl.y - 120, rl.x + 120, rl.y + 120)) continue;
    ctx.save(); ctx.translate(rl.x, rl.y); ctx.rotate(rl.a);
    ctx.fillStyle = 'rgba(15,18,22,0.55)';
    const w = ctx.measureText(rl.text).width + 14; ctx.fillRect(-w / 2, -10, w, 20);
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillText(rl.text, 0, 1); ctx.restore();
  }
  // titik interaksi
  const walking = P.mode === 'walk';
  for (const p of level.places) {
    if (!visible(v, p.x - 60, p.y - 60, p.x + 60, p.y + 60)) continue;
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);
    ctx.globalAlpha = walking ? 0.55 + 0.35 * pulse : 0.35;
    ctx.strokeStyle = '#fde68a'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = walking ? 0.9 : 0.5; ctx.font = '18px sans-serif';
    ctx.fillText(PLACE_ICON[p.kind] || '•', p.x + p.r * 0.7, p.y + p.r * 0.7); ctx.globalAlpha = 1;
  }
}

function buildRoadLabels() {
  ROADLABELS = [];
  for (const r of level.roads) {
    let acc = r.kind === 'main' ? 250 : r.kind === 'estate' ? 200 : 120;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [x0, y0] = r.pts[i], [x1, y1] = r.pts[i + 1], L = Math.hypot(x1 - x0, y1 - y0);
      while (acc < L) {
        const t = acc / L, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        let a = Math.atan2(y1 - y0, x1 - x0);
        if (a > Math.PI / 2 || a < -Math.PI / 2) a += Math.PI;
        const text = r.sections ? (r.sections.find((s) => y >= s.y0 && y < s.y1) || r).name : r.name;
        // tulis di bahu jalan (bukan di lajur) agar tidak menutupi marka
        const nx = -(y1 - y0) / L, ny = (x1 - x0) / L, off = r.w / 2 - 22;
        ROADLABELS.push({ x: x + nx * off, y: y + ny * off, a, text });
        acc += r.kind === 'main' ? 700 : 500;
      }
      acc -= L;
    }
  }
}

function wheel(x, y, rot = 0, l = 16, w = 8) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  ctx.fillStyle = '#0e0f11'; ctx.fillRect(-l / 2, -w / 2, l, w);
  ctx.restore();
}

function tailLights(V, x, hw, inset) {
  const tail = V.gear === 'R' ? '#ffffff' : V.braking ? '#ff3b3b' : '#7f1d1d';
  ctx.fillStyle = tail; ctx.fillRect(x, -hw + inset, 3, 5); ctx.fillRect(x, hw - inset - 5, 3, 5);
}

function drawHorn(V, now) {
  if (!V.horn) return;
  ctx.strokeStyle = 'rgba(253,230,138,0.8)'; ctx.lineWidth = 2.5;
  const ph = (now / 120) % 1;
  for (let i = 0; i < 3; i++) {
    const r = 16 + ((i / 3 + ph) % 1) * 30;
    ctx.globalAlpha = 1 - ((i / 3 + ph) % 1);
    ctx.beginPath(); ctx.arc(V.spec.front, 0, r, -0.6, 0.6); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawTractor(V, now) {
  const s = V.spec, hw = s.hw;
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.ang);
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(s.rear + 3, -hw + 3, s.front - s.rear, hw * 2);
  for (const sy of [-1, 1]) { wheel(0, sy * (hw - 2)); wheel(-11, sy * (hw - 2)); wheel(s.wb, sy * (hw - 2), V.steer); }
  ctx.fillStyle = '#2d3748'; ctx.fillRect(s.rear, -hw + 5, 50, hw * 2 - 10);
  ctx.fillStyle = '#6b7280'; ctx.beginPath(); ctx.arc(s.fifth, 0, 11, 0, 7); ctx.fill();
  ctx.fillStyle = '#1f2937'; ctx.fillRect(s.fifth - 12, -2.5, 12, 5);
  ctx.fillStyle = V.color; ctx.fillRect(32, -hw, s.front - 32, hw * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(36, -hw + 4, 14, hw * 2 - 8);
  ctx.fillStyle = '#93c5fd'; ctx.fillRect(s.front - 8, -hw + 3, 5, hw * 2 - 6);
  ctx.fillStyle = '#fde68a'; ctx.fillRect(s.front - 2, -hw + 1, 2, 6); ctx.fillRect(s.front - 2, hw - 7, 2, 6);
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(44, -hw - 4, 4, 4); ctx.fillRect(44, hw, 4, 4);
  tailLights(V, s.rear, hw, 5);
  drawHorn(V, now);
  ctx.restore();
}

function drawBus(V, now) {
  const s = V.spec, hw = s.hw, len = s.front - s.rear;
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.ang);
  ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(s.rear + 4, -hw + 4, len, hw * 2);
  for (const sy of [-1, 1]) { wheel(0, sy * (hw - 1), 0, 12, 6); wheel(s.wb, sy * (hw - 1), V.steer, 12, 6); }
  ctx.fillStyle = V.color; ctx.beginPath(); ctx.roundRect(s.rear, -hw, len, hw * 2, 6); ctx.fill();
  ctx.fillStyle = '#1e3a5f'; ctx.fillRect(s.rear + 8, -hw + 3, len - 30, 4); ctx.fillRect(s.rear + 8, hw - 7, len - 30, 4);   // kaca samping
  ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(s.rear + 8, -hw + 9, len - 34, hw * 2 - 18);                        // atap
  ctx.fillStyle = 'rgba(0,0,0,0.12)'; for (let x = s.rear + 22; x < s.front - 30; x += 19) ctx.fillRect(x, -hw + 9, 1.2, hw * 2 - 18);
  ctx.fillStyle = '#bfdbfe'; ctx.fillRect(s.front - 15, -hw + 5, 9, hw * 2 - 10);                                           // kaca depan
  ctx.fillStyle = '#f8fafc'; ctx.fillRect(s.rear + 2, -hw + 7, 3, hw * 2 - 14);
  ctx.fillStyle = '#fde68a'; ctx.fillRect(s.front - 2, -hw + 1, 2, 5); ctx.fillRect(s.front - 2, hw - 6, 2, 5);
  tailLights(V, s.rear, hw, 1.5);
  drawHorn(V, now);
  ctx.restore();
}

function drawCar(V, now) {
  const s = V.spec, hw = s.hw, len = s.front - s.rear, model = s.model;
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.ang);
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(s.rear + 3, -hw + 3, len, hw * 2);
  const ww = model === 'hatch' ? 8 : 10;
  for (const sy of [-1, 1]) { wheel(0, sy * (hw - 1), 0, ww, 5); wheel(s.wb, sy * (hw - 1), V.steer, ww, 5); }
  ctx.fillStyle = V.color;
  ctx.beginPath(); ctx.roundRect(s.rear, -hw, len, hw * 2, model === 'hatch' ? 7 : model === 'mpv' ? 4 : 5); ctx.fill();
  const glass = 'rgba(15,23,42,0.78)';
  if (model === 'hatch') {                 // Mirage: hatchback pendek, kap depan bulat
    ctx.fillStyle = glass;
    ctx.fillRect(s.rear + len * 0.60, -hw + 2, 6, hw * 2 - 4);           // kaca depan
    ctx.fillRect(s.rear + 2, -hw + 2.5, 4, hw * 2 - 5);                 // kaca pintu belakang
    ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(s.rear + 7, -hw + 2.5, len * 0.48, hw * 2 - 5);   // atap
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(s.rear + len * 0.75, -0.6, len * 0.22, 1.2);           // garis kap
  } else if (model === 'suv') {            // SUV (Pajero Sport / Xforce): kotak tinggi, rel atap
    ctx.fillStyle = glass;
    ctx.fillRect(s.rear + len * 0.66, -hw + 2.5, 6, hw * 2 - 5);
    ctx.fillRect(s.rear + 2, -hw + 2.5, 4, hw * 2 - 5);
    ctx.fillStyle = 'rgba(255,255,255,0.13)'; ctx.fillRect(s.rear + 8, -hw + 3, len * 0.56, hw * 2 - 6);
    ctx.fillStyle = 'rgba(15,23,42,0.85)'; ctx.fillRect(s.rear + 10, -hw + 2.5, len * 0.5, 1.6); ctx.fillRect(s.rear + 10, hw - 4.1, len * 0.5, 1.6);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(s.front - 6, -hw + 2, 3, hw * 2 - 4);
  } else if (model === 'pickup') {         // Triton / L300: kabin depan + bak belakang
    const bedEnd = s.rear + len * 0.5;
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(s.rear + 2, -hw + 2, bedEnd - s.rear - 3, hw * 2 - 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 0.8;
    for (let x = s.rear + 6; x < bedEnd - 2; x += 5) { ctx.beginPath(); ctx.moveTo(x, -hw + 3); ctx.lineTo(x, hw - 3); ctx.stroke(); }
    ctx.fillStyle = glass; ctx.fillRect(s.rear + len * 0.74, -hw + 2.5, 5, hw * 2 - 5); ctx.fillRect(bedEnd + 1, -hw + 2.5, 3, hw * 2 - 5);
    ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(bedEnd + 5, -hw + 3, len * 0.2, hw * 2 - 6);
  } else if (model === 'mpv') {            // Innova: MPV panjang, 3 baris kaca, roof rail
    ctx.fillStyle = glass;
    ctx.fillRect(s.rear + len * 0.70, -hw + 2.5, 6, hw * 2 - 5);         // kaca depan
    ctx.fillRect(s.rear + 2, -hw + 2.5, 4, hw * 2 - 5);                 // kaca belakang
    for (const fx of [0.18, 0.38, 0.56]) { ctx.fillRect(s.rear + len * fx, -hw, len * 0.14, 2); ctx.fillRect(s.rear + len * fx, hw - 2, len * 0.14, 2); }
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(s.rear + 8, -hw + 3, len * 0.60, hw * 2 - 6);    // atap
    ctx.fillStyle = 'rgba(203,213,225,0.9)'; ctx.fillRect(s.rear + 10, -hw + 3, len * 0.55, 1.5); ctx.fillRect(s.rear + 10, hw - 4.5, len * 0.55, 1.5);
  } else {                                 // sedan
    ctx.fillStyle = glass;
    ctx.fillRect(s.rear + len * 0.62, -hw + 2.5, 6, hw * 2 - 5);
    ctx.fillRect(s.rear + len * 0.18, -hw + 2.5, 4, hw * 2 - 5);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(s.rear + len * 0.28, -hw + 3, len * 0.32, hw * 2 - 6);
  }
  ctx.fillStyle = '#fde68a'; ctx.fillRect(s.front - 2, -hw + 1, 2, 4); ctx.fillRect(s.front - 2, hw - 5, 2, 4);
  tailLights(V, s.rear, hw, 1);
  drawHorn(V, now);
  ctx.restore();
}

function drawBoxTruck(V) {
  const s = V.spec, hw = s.hw;
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.ang);
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(s.rear + 3, -hw + 3, s.front - s.rear, hw * 2);
  if (s.model === 'manhx8x8') {
    for (const [i, x] of [s.wb, 16, -12, s.rear + 18].entries()) {
      const axleSteer = i === 0 ? V.steer : i === 1 ? V.steer * 0.65 : 0;
      for (const sy of [-1, 1]) wheel(x, sy * (hw - 2), axleSteer, 12, 6);
    }
    ctx.fillStyle = '#374151'; ctx.fillRect(s.rear + 3, -hw + 5, s.front - s.rear - 6, hw * 2 - 10);
    ctx.save(); ctx.translate(s.rear, 0); ctx.rotate(clamp(V.tip || 0, 0, 1) * 0.75);
    const bedLength = 12 - s.rear;
    ctx.fillStyle = '#4b5563'; ctx.fillRect(0, -hw + 5, bedLength, hw * 2 - 10);
    ctx.strokeStyle = 'rgba(15,23,42,0.7)'; ctx.lineWidth = 1.5;
    ctx.strokeRect(1, -hw + 6, bedLength - 2, hw * 2 - 12);
    ctx.fillStyle = '#374151'; ctx.fillRect(2, -hw + 7, bedLength - 4, 3); ctx.fillRect(2, hw - 10, bedLength - 4, 3);
    ctx.fillRect(bedLength - 5, -hw + 7, 3, hw * 2 - 14);
    if (V.load > 0.02) {
      ctx.fillStyle = '#18181b'; ctx.fillRect(6, -hw + 9, (bedLength - 12) * clamp(V.load, 0, 1), hw * 2 - 18);
    }
    ctx.restore();
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(s.rear + 2, -4, s.fifth - s.rear - 2, 8);
    ctx.fillRect(s.fifth - 4, -7, 8, 14);
    ctx.fillStyle = V.color; ctx.fillRect(14, -hw, s.front - 14, hw * 2);
    ctx.fillStyle = 'rgba(15,23,42,0.82)'; ctx.fillRect(s.front - 8, -hw + 4, 5, hw * 2 - 8);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(19, -hw + 3, 10, hw * 2 - 6);
    ctx.fillStyle = '#334155'; ctx.fillRect(s.front - 2, -hw + 1, 2, hw * 2 - 2);
    ctx.fillStyle = '#fde68a'; ctx.fillRect(s.front - 1, -hw + 3, 2, 5); ctx.fillRect(s.front - 1, hw - 8, 2, 5);
    tailLights(V, s.rear, hw, 2);
    ctx.restore();
    return;
  }
  for (const sy of [-1, 1]) { wheel(0, sy * (hw - 1), 0, 12, 6); wheel(s.wb, sy * (hw - 1), V.steer, 12, 6); }
  ctx.fillStyle = V.color; ctx.fillRect(s.rear, -hw, 62, hw * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1.5; ctx.strokeRect(s.rear + 1, -hw + 1, 60, hw * 2 - 2);
  ctx.fillStyle = '#334155'; ctx.fillRect(s.rear + 62, -hw + 2, s.front - s.rear - 62, hw * 2 - 4);
  ctx.fillStyle = '#93c5fd'; ctx.fillRect(s.front - 6, -hw + 4, 4, hw * 2 - 8);
  tailLights(V, s.rear, hw, 2);
  ctx.restore();
}

function drawMiniTruck(V, now) {           // truk mini: kabin depan + bak kayu terbuka
  const s = V.spec, hw = s.hw, cab = s.front - 18;
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.ang);
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(s.rear + 3, -hw + 3, s.front - s.rear, hw * 2);
  for (const sy of [-1, 1]) { wheel(0, sy * (hw - 1), 0, 11, 5.5); wheel(s.wb, sy * (hw - 1), V.steer, 11, 5.5); }
  ctx.fillStyle = '#8b5a2b'; ctx.fillRect(s.rear, -hw, cab - 2 - s.rear, hw * 2);                     // bak kayu
  ctx.fillStyle = '#a16207'; ctx.fillRect(s.rear + 2, -hw + 2, cab - 6 - s.rear, hw * 2 - 4);
  ctx.strokeStyle = 'rgba(60,30,10,0.55)'; ctx.lineWidth = 0.8;
  for (let x = s.rear + 6; x < cab - 4; x += 6) { ctx.beginPath(); ctx.moveTo(x, -hw + 2); ctx.lineTo(x, hw - 2); ctx.stroke(); }
  ctx.fillStyle = V.color; ctx.beginPath(); ctx.roundRect(cab, -hw + 0.5, s.front - cab, hw * 2 - 1, 3); ctx.fill();   // kabin
  ctx.fillStyle = 'rgba(15,23,42,0.78)'; ctx.fillRect(s.front - 7, -hw + 2.5, 4, hw * 2 - 5);
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(cab + 2, -hw + 3, 8, hw * 2 - 6);
  ctx.fillStyle = '#fde68a'; ctx.fillRect(s.front - 2, -hw + 1, 2, 4); ctx.fillRect(s.front - 2, hw - 5, 2, 4);
  tailLights(V, s.rear, hw, 1);
  drawHorn(V, now);
  ctx.restore();
}

const RIDER_COLS = ['#334155', '#0f766e', '#7c2d12', '#1e40af', '#6b21a8', '#be123c', '#4d7c0f', '#111827'];
const HELMET_COLS = ['#111827', '#f8fafc', '#dc2626', '#1d4ed8', '#facc15', '#16a34a'];
function hashStr(t) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const riderOf = (V) => {                        // warna jaket & helm pengendara
  if (V.foodDelivery) return { jacket: '#059669', helmet: '#047857' };
  if (!V.npc) return { jacket: '#f97316', helmet: '#111827' };
  const h = hashStr(V.id);
  return { jacket: RIDER_COLS[h % RIDER_COLS.length], helmet: HELMET_COLS[(h >>> 5) % HELMET_COLS.length] };
};
const hasRider = (V) => !V.wreck && (V.npc || (P.mode === 'drive' && P.veh === V));
function drawMotor(V, now) {                    // sepeda motor tampak atas (bebek / matic) + pengendara
  const s = V.spec, matic = s.model === 'matic';
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.ang);
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(9, 2.5, 13, 4.5, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#0e0f11'; ctx.fillRect(-3.4, -1.1, 6.8, 2.2);                                      // roda belakang
  ctx.save(); ctx.translate(s.wb, 0); ctx.rotate(V.steer || 0);
  ctx.fillStyle = '#0e0f11'; ctx.fillRect(-3.4, -1.1, 6.8, 2.2);                                      // roda depan
  ctx.fillStyle = '#111827'; ctx.fillRect(-1.5, -4.4, 1.6, 8.8);                                      // stang
  ctx.fillStyle = '#9ca3af'; ctx.fillRect(-1.7, -4.6, 2, 1.2); ctx.fillRect(-1.7, 3.4, 2, 1.2);       // spion / handgrip
  ctx.restore();
  ctx.fillStyle = V.color; ctx.beginPath();
  if (matic) ctx.roundRect(-3.5, -2.6, 17, 5.2, 2.4); else ctx.roundRect(-3, -2.1, 16, 4.2, 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(matic ? 8.5 : 9, -1.4, 3.2, 2.8);              // tameng depan
  ctx.fillStyle = '#111827'; ctx.beginPath(); ctx.roundRect(-2, -1.8, 9, 3.6, 1.6); ctx.fill();         // jok
  ctx.fillStyle = '#fde68a'; ctx.fillRect(s.front - 4, -1.1, 1.6, 2.2);                                // lampu depan
  ctx.fillStyle = V.gear === 'R' ? '#ffffff' : V.braking ? '#ff3b3b' : '#7f1d1d'; ctx.fillRect(-5, -1, 1.5, 2);
  if (V.foodDelivery) {
    ctx.fillStyle = '#059669'; ctx.beginPath(); ctx.roundRect(-8, -3.2, 5.5, 6.4, 1.2); ctx.fill();  // boks kurir hijau
    ctx.fillStyle = '#facc15'; ctx.fillRect(-4, -1.8, 1, 3.6);                                        // strip aksen kuning
  }
  if (hasRider(V)) {
    const r = riderOf(V);
    ctx.fillStyle = r.jacket;
    ctx.beginPath(); ctx.ellipse(2.8, 0, 3, 4.6, 0, 0, 7); ctx.fill();                                // badan & bahu
    ctx.strokeStyle = r.jacket; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    for (const sy of [-1, 1]) { ctx.beginPath(); ctx.moveTo(3.5, sy * 3.6); ctx.lineTo(s.wb - 1, sy * 3.8); ctx.stroke(); }   // lengan ke stang
    ctx.fillStyle = r.helmet; ctx.beginPath(); ctx.arc(3.4, 0, 2.7, 0, 7); ctx.fill();               // helm
    ctx.fillStyle = 'rgba(15,23,42,0.85)'; ctx.fillRect(5, -1.6, 1.1, 3.2);                           // kaca helm
  }
  drawHorn(V, now);
  ctx.restore();
}
function drawDamage2D(V) {                      // jelaga, penyok & retak sesuai kondisi; hangus bila hancur
  const hp = hpOf(V);
  if (hp >= 92 && !V.wreck) return;
  const s = V.spec, len = s.front - s.rear, hw = s.hw;
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.ang);
  ctx.fillStyle = V.wreck ? 'rgba(14,12,12,0.74)' : `rgba(35,28,22,${(1 - hp / 100) * 0.42})`;
  ctx.beginPath(); ctx.roundRect(s.rear, -hw, len, hw * 2, 3); ctx.fill();
  let seed = hashStr(V.id || 'x');
  const rnd = () => { seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0; seed ^= seed >>> 13; return (seed % 1000) / 1000; };
  const n = V.wreck ? 7 : Math.round((1 - hp / 100) * 6);
  ctx.strokeStyle = V.wreck ? 'rgba(0,0,0,0.75)' : 'rgba(20,20,20,0.6)'; ctx.lineWidth = V.type === 'motor' ? 0.6 : 1.1;
  for (let i = 0; i < n; i++) {
    let x = s.rear + rnd() * len, y = (rnd() * 2 - 1) * hw * 0.85;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 3; k++) { x += (rnd() - 0.5) * hw; y += (rnd() - 0.5) * hw * 0.8; ctx.lineTo(x, clamp(y, -hw, hw)); }
    ctx.stroke();
  }
  if (V.wreck && V.wreckT < 14) {               // bara menyala
    ctx.fillStyle = `rgba(251,146,60,${0.35 + 0.25 * Math.sin(performance.now() / 90)})`;
    ctx.beginPath(); ctx.ellipse(V.type === 'motor' ? 6 : s.front - 12, 0, Math.min(10, len * 0.18), hw * 0.6, 0, 0, 7); ctx.fill();
  }
  ctx.restore();
}
function drawPlane2D(V, now) {
  if (V.spec.model === 'su57') return drawSu57_2D(V);
  const s = V.spec, c = V.color || '#f8fafc';
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.ang);
  // Bayangan
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(0, 0, 44, 10, 0, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(6, 0, 10, s.hw, 0, 0, 7); ctx.fill();
  ctx.translate(0, -(V.alt || 0));
  applyPlaneBank2D(V);

  // Sayap utama (lebar)
  ctx.fillStyle = c;
  ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(14, -s.hw); ctx.lineTo(16, s.hw); ctx.lineTo(0, s.hw * 0.95); ctx.lineTo(-2, -s.hw * 0.95); ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Badan pesawat (fuselage)
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.ellipse(0, 0, 42, 8, 0, 0, 7);
  ctx.fill(); ctx.stroke();

  // Kaca kokpit
  ctx.fillStyle = '#0284c7';
  ctx.beginPath(); ctx.ellipse(14, 0, 9, 5, 0, 0, 7); ctx.fill();

  // Ekor horizontal & vertikal
  ctx.fillStyle = '#dc2626';
  ctx.beginPath(); ctx.moveTo(-36, -20); ctx.lineTo(-30, 20); ctx.lineTo(-44, 16); ctx.lineTo(-44, -16); ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Baling-baling berputar di depan
  const spin = (now / 35) % Math.PI;
  ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(43, -14 * Math.sin(spin)); ctx.lineTo(43, 14 * Math.sin(spin));
  ctx.stroke();
  ctx.restore();
}

function drawSu57_2D(V) {
  const c = V.color || '#475569';
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.ang); ctx.translate(0, -(V.alt || 0));
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.ellipse(0, 0, 48, 25, 0, 0, Math.PI * 2); ctx.fill();
  applyPlaneBank2D(V);
  ctx.fillStyle = c; ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(52, 0); ctx.lineTo(27, -6); ctx.lineTo(4, -10); ctx.lineTo(-8, -45);
  ctx.lineTo(-20, -45); ctx.lineTo(-17, -12); ctx.lineTo(-38, -22); ctx.lineTo(-48, -19);
  ctx.lineTo(-35, 0); ctx.lineTo(-48, 19); ctx.lineTo(-38, 22); ctx.lineTo(-17, 12);
  ctx.lineTo(-20, 45); ctx.lineTo(-8, 45); ctx.lineTo(4, 10); ctx.lineTo(27, 6);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#38bdf8'; ctx.beginPath(); ctx.ellipse(20, 0, 10, 4.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1e293b';
  for (const z of [-11, 11]) ctx.fillRect(-45, z - 3, 11, 6);
  ctx.restore();
}

function applyPlaneBank2D(V) {
  const bank = clamp(V.bank || 0, -0.9, 0.9);
  ctx.transform(1, 0, Math.sin(bank) * 0.55, Math.max(0.45, Math.cos(bank)), 0, 0);
}

function drawHelicopter2D(V, now) {
  const c = V.color || '#facc15', spin = now / 90;
  ctx.save(); ctx.translate(V.x, V.y);
  ctx.fillStyle = `rgba(0,0,0,${0.22 - Math.min(0.14, (V.alt || 0) / 1800)})`;
  ctx.beginPath(); ctx.ellipse(0, 0, 38, 12, 0, 0, 7); ctx.fill();
  ctx.translate(0, -(V.alt || 0)); ctx.rotate(V.ang);
  ctx.fillStyle = c; ctx.beginPath(); ctx.roundRect(-30, -8, 48, 16, 7); ctx.fill();
  ctx.fillStyle = '#0284c7'; ctx.beginPath(); ctx.ellipse(12, 0, 8, 6, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#334155'; ctx.fillRect(-52, -2, 28, 4);
  ctx.fillStyle = '#dc2626'; ctx.beginPath(); ctx.moveTo(-52, -2); ctx.lineTo(-60, -8); ctx.lineTo(-57, 0); ctx.lineTo(-60, 8); ctx.lineTo(-52, 2); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#111827'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-20, -13); ctx.lineTo(12, -13); ctx.moveTo(-20, 13); ctx.lineTo(12, 13); ctx.stroke();
  ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-4, -46 * Math.cos(spin)); ctx.lineTo(-4, 46 * Math.cos(spin)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-4 - 46 * Math.sin(spin), 0); ctx.lineTo(-4 + 46 * Math.sin(spin), 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-56, -9 * Math.cos(spin * 2)); ctx.lineTo(-56, 9 * Math.cos(spin * 2)); ctx.stroke();
  ctx.restore();
}

function drawFalcon2D(V, now) {
  ctx.save(); ctx.translate(V.x, V.y);
  ctx.fillStyle = `rgba(0,0,0,${0.22 - Math.min(0.14, (V.alt || 0) / 1800)})`;
  ctx.beginPath(); ctx.ellipse(0, 0, 17, 17, 0, 0, 7); ctx.fill();
  ctx.translate(0, -(V.alt || 0)); ctx.rotate(V.ang);
  if (V.thrusting && P.mode === 'drive' && P.veh === V) {
    const flicker = 22 + Math.sin(now / 24) * 4;
    ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.moveTo(-8, -3.2); ctx.lineTo(-flicker, 0); ctx.lineTo(-8, 3.2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.moveTo(-8, -1.5); ctx.lineTo(-(flicker * 0.66), 0); ctx.lineTo(-8, 1.5); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = '#1e293b';
  for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    ctx.save(); ctx.rotate(a); ctx.fillRect(5, -2, 12, 4); ctx.restore();
  }
  ctx.fillStyle = V.color || '#f1f5f9'; ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#0284c7'; ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.ellipse(-8, 0, 3.8, 4.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(-10, 0, 2.4, 3.2, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// kendaraan hasil editor CAD (/vehicle-editor): tampak atas dari jejak tiap primitif (urut dari yang paling rendah)
const CAD_RING = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [Math.cos(i * Math.PI / 4) * 0.5, Math.sin(i * Math.PI / 4) * 0.5]);
function drawCad2D(V, now) {
  const cad = V.spec.cad, tops = [];
  for (const p of cad.prims) {
    const m = p.m; let pts, top = 0;
    if (p.k === 'tris') {
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (let i = 0; i < p.v.length; i += 3) { x0 = Math.min(x0, p.v[i]); x1 = Math.max(x1, p.v[i]); z0 = Math.min(z0, p.v[i + 2]); z1 = Math.max(z1, p.v[i + 2]); top = Math.max(top, p.v[i + 1]); }
      pts = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    } else {
      let foot, cy = 0;
      if (p.k === 'bevel') foot = [[-p.d[0] / 2, -p.d[2] / 2], [p.d[0] / 2, -p.d[2] / 2], [p.d[0] / 2, p.d[2] / 2], [-p.d[0] / 2, p.d[2] / 2]];
      else if (p.k === 'box' || p.k === 'boxC') { foot = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]; cy = p.k === 'box' ? 0.5 : 0; }
      else { foot = CAD_RING; cy = /^(cyl|cone)/.test(p.k) ? 0.5 : 0; }
      pts = foot.map(([a, b]) => [m[0] * a + m[8] * b + m[12], m[2] * a + m[10] * b + m[14]]);
      top = m[13] + m[5] * cy;
    }
    tops.push({ pts, top, c: p.c });
  }
  tops.sort((a, b) => a.top - b.top);
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.ang);
  for (const w of cad.wheels) wheel(w.x, w.z, w.steer ? V.steer : 0, w.r * 2, w.w);
  for (const t of tops) { ctx.fillStyle = t.c; ctx.beginPath(); t.pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); ctx.fill(); }
  const lamps = cad.lamps || [];
  for (const l of lamps) {
    ctx.fillStyle = l.kind === 'tail'
      ? (V.gear === 'R' ? '#ffffff' : V.braking ? '#ff3b3b' : '#7f1d1d')
      : '#fde68a';
    const sx = Math.max(2, l.sx || 3), sz = Math.max(2, l.sz || 5);
    ctx.fillRect(l.x - sx / 2, l.z - sz / 2, sx, sz);
  }
  if (!lamps.some((l) => l.kind === 'tail')) tailLights(V, V.spec.rear, V.spec.hw, 2);
  drawHorn(V, now);
  ctx.restore();
}

function drawVehicle(V, now) {
  if (V.spec.model === 'cad' && V.spec.cad) drawCad2D(V, now);
  else if (V.type === 'plane') drawPlane2D(V, now);
  else if (V.type === 'helicopter') drawHelicopter2D(V, now);
  else if (V.type === 'falcon') drawFalcon2D(V, now);
  else if (V.type === 'motor') drawMotor(V, now);
  else if (V.type === 'car') (V.spec.model === 'bus' ? drawBus : drawCar)(V, now);
  else if (V.type === 'box' || V.type === 'dump' || V.type === 'paver' || V.type === 'milling' || V.type === 'tanker') drawBoxTruck(V);
  else if (V.type === 'minitruck') drawMiniTruck(V, now);
  else if (V.type === 'custom') drawCustomTop(ctx, V, now);
  else drawTractor(V, now);
  drawDamage2D(V);
  if (V.towing) {
    const [hx, hy] = fifthWheel(V), co = Math.cos(V.ang), si = Math.sin(V.ang);
    const tx = V.x + co * (V.spec.rear + 2), ty = V.y + si * (V.spec.rear + 2);
    ctx.save(); ctx.strokeStyle = '#374151'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.fillStyle = '#111827'; ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  if (!V.npc && P.veh !== V) {                  // nama kendaraan yang sedang parkir
    const [mx, my] = vehMid(V);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(V.name, mx, my - V.spec.hw - 26);
  }
}

function drawWalker() {
  if (P.mode !== 'walk') return;
  drawWalkerAt(P.x, P.y, P.ang);
}
function drawWalkerAt(x, y, ang, still = false, style = null, walkT = P.walkT) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  const sw = still ? 0 : Math.sin(walkT / 5) * 4;
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(2, 2, 7, 9, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#1e293b'; ctx.fillRect(sw - 3, -5, 6, 3); ctx.fillRect(-sw - 3, 2, 6, 3);
  ctx.fillStyle = style && style.jacket || '#f97316'; ctx.beginPath(); ctx.ellipse(0, 0, 4.5, 8, 0, 0, 7); ctx.fill();
  ctx.fillStyle = style && style.skin || '#d6a77a'; ctx.beginPath(); ctx.arc(1, 0, 4.2, 0, 7); ctx.fill();
  ctx.fillStyle = style && style.hair || '#111827'; ctx.beginPath(); ctx.arc(-0.5, 0, 3.6, 0, 7); ctx.fill();
  if (!style && P.carrying) { ctx.fillStyle = '#dc2626'; ctx.fillRect(-4, 8, 8, 6); }
  ctx.restore();
}

function drawTaxiPassenger2D(V) {
  if (!taxiJob || taxiJob.phase !== 'onboard' || taxiJob.vehicle !== V) return;
  const side = V.spec.hw * 0.45, forward = (V.spec.front + V.spec.rear) * 0.15;
  const x = V.x + Math.cos(V.ang) * forward - Math.sin(V.ang) * side;
  const y = V.y + Math.sin(V.ang) * forward + Math.cos(V.ang) * side;
  drawWalkerAt(x, y, V.ang, true, taxiJob.passengerActor);
}

function drawTrailer(tr, now) {
  const isTarget = mission && tr === mission.trailer;
  const color = tr.state === 'delivered' ? '#5f8f6e' : isTarget ? '#f59e0b' : '#9aa3ad';
  ctx.save(); ctx.translate(tr.x, tr.y); ctx.rotate(tr.ang);
  const len = TRAILER.front - TRAILER.rear, hw = TRAILER.hw;
  ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(TRAILER.rear + 4, -hw + 4, len, hw * 2);
  for (const sy of [-1, 1]) for (const wx of [-TRAILER.l2 + 8, -TRAILER.l2 - 8]) wheel(wx, sy * (hw - 1));
  ctx.fillStyle = color; ctx.fillRect(TRAILER.rear, -hw, len, hw * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 2; ctx.strokeRect(TRAILER.rear + 1, -hw + 1, len - 2, hw * 2 - 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
  for (let x = TRAILER.rear + 15; x < TRAILER.front - 4; x += 15) { ctx.beginPath(); ctx.moveTo(x, -hw + 2); ctx.lineTo(x, hw - 2); ctx.stroke(); }
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(TRAILER.rear, -hw, 4, hw * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.save(); ctx.translate((TRAILER.front + TRAILER.rear) / 2, 0);
  if (Math.cos(tr.ang) < 0) ctx.rotate(Math.PI);
  ctx.fillText(tr.id, 0, 0); ctx.restore();
  if (tr.state !== 'hooked') {
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#4b5563'; ctx.fillRect(-26, -hw - 2, 5, 4); ctx.fillRect(-26, hw - 2, 5, 4);
  }
  ctx.restore();

  const V = P.mode === 'drive' ? P.veh : null;
  if (isTarget && tr.state === 'parked') {
    const pulse = 0.5 + 0.5 * Math.sin(now / 200);
    let ok = false;
    if (V && V.spec.canTow) {
      const [fx, fy] = fifthWheel(V);
      ok = Math.hypot(fx - tr.x, fy - tr.y) < COUPLE_DIST && Math.abs(wrap(V.ang - tr.ang)) < COUPLE_ANG;
    }
    ctx.strokeStyle = ok ? '#4ade80' : `rgba(250,204,21,${0.5 + 0.5 * pulse})`;
    ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(tr.x, tr.y, COUPLE_DIST + pulse * 4, 0, 7); ctx.stroke();
    ctx.setLineDash([8, 8]); ctx.strokeStyle = 'rgba(250,204,21,0.45)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tr.x, tr.y); ctx.lineTo(tr.x + Math.cos(tr.ang) * 110, tr.y + Math.sin(tr.ang) * 110); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawZones(now) {
  for (const z of level.zones) {
    const active = mission && mission.zone === z;
    const used = usedZones && usedZones.has(z.id) && !active;
    const tr = mission && mission.trailer;
    const fit = active && tr.state === 'hooked' ? zoneFit(tr, z).inside : false;
    ctx.save(); ctx.translate(z.x, z.y); ctx.rotate(z.angle * DEG);
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    ctx.fillStyle = fit ? 'rgba(74,222,128,0.40)' : active ? `rgba(74,222,128,${0.10 + 0.10 * pulse})` : 'rgba(255,255,255,0.04)';
    ctx.fillRect(-z.w / 2, -z.h / 2, z.w, z.h);
    ctx.setLineDash(active ? [] : [10, 8]);
    ctx.strokeStyle = active ? '#4ade80' : used ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = active ? 3 : 2; ctx.strokeRect(-z.w / 2, -z.h / 2, z.w, z.h);
    ctx.setLineDash([]);
    ctx.fillStyle = active ? '#4ade80' : 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.moveTo(z.w / 2 - 6, 0); ctx.lineTo(z.w / 2 - 22, -10); ctx.lineTo(z.w / 2 - 22, 10); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = active ? '#bbf7d0' : 'rgba(255,255,255,0.6)'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
    const ly = z.angle % 180 === 0 ? z.y - z.h / 2 - 10 : z.y;
    const lx = z.angle % 180 === 0 ? z.x : z.x + z.h / 2 + 34;
    ctx.fillText(z.id, lx, ly);
  }
}

/* ----- panel bantuan docking: sambung trailer & parkir trailer di zona tujuan ----- */
// Menampilkan denah kecil (zona + trailer + truk) dan status OK / belum beserta angka koreksinya.
function dockInfo() {
  if (!mission || P.mode !== 'drive' || state !== 'play') return null;
  const V = P.veh, tr = mission.trailer;
  if (tr.state === 'hooked' && V.hooked === tr) {
    const z = mission.zone, mid = (TRAILER.front + TRAILER.rear) / 2;
    const cx = tr.x + Math.cos(tr.ang) * mid, cy = tr.y + Math.sin(tr.ang) * mid;
    if (Math.hypot(cx - z.x, cy - z.y) > 520) return null;
    const za = z.angle * DEG, co = Math.cos(-za), si = Math.sin(-za), loc = ([x, y]) => [(x - z.x) * co - (y - z.y) * si, (x - z.x) * si + (y - z.y) * co];
    let out = 0;
    for (const p of trailerPoly(tr)) { const [lx, ly] = loc(p); out = Math.max(out, Math.abs(lx) - z.w / 2, Math.abs(ly) - z.h / 2); }
    const fit = zoneFit(tr, z), angDeg = Math.abs(wrap(tr.ang - za)) / DEG;
    const acc = Math.round(100 * (0.5 * clamp(1 - fit.offset / 20, 0, 1) + 0.5 * clamp(1 - fit.angErr / (6 * DEG), 0, 1)));
    return { kind: 'drop', z, loc, fit, out: Math.max(0, out), angDeg, acc, still: Math.abs(V.v) <= 4 };
  }
  if (tr.state === 'parked' && V.spec.canTow && !V.hooked) {
    const [fx, fy] = fifthWheel(V), d = Math.hypot(fx - tr.x, fy - tr.y);
    if (d > 260) return null;
    const angDeg = Math.abs(wrap(V.ang - tr.ang)) / DEG;
    return { kind: 'couple', d, angDeg, ok: d < COUPLE_DIST && angDeg < COUPLE_ANG / DEG, tr };
  }
  return null;
}
let dockBeepT = 0;
function drawDockPanel(dt) {
  const el = $('dockPanel'), info = dockInfo();
  el.classList.toggle('hidden', !info);
  if (!info) return;
  const cv = $('dockCanvas'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
  g.fillStyle = '#0f172a'; g.fillRect(0, 0, W, H);
  const V = P.veh;
  let title, ok, lines;
  if (info.kind === 'drop') {
    const z = info.z, k = Math.min((W - 20) / (z.w * 1.9), (H - 16) / (z.h * 3.2));
    g.translate(W / 2, H / 2); g.scale(k, k);
    const poly = (pts, fill, stroke) => { g.beginPath(); pts.forEach((p, i) => { const [x, y] = info.loc(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2 / k; g.stroke(); } };
    ok = info.fit.inside;
    g.fillStyle = ok ? 'rgba(34,197,94,0.35)' : 'rgba(250,204,21,0.12)'; g.fillRect(-z.w / 2, -z.h / 2, z.w, z.h);
    g.strokeStyle = ok ? '#22c55e' : '#facc15'; g.lineWidth = 3 / k; g.setLineDash([8 / k, 5 / k]); g.strokeRect(-z.w / 2, -z.h / 2, z.w, z.h); g.setLineDash([]);
    g.fillStyle = '#ef4444'; g.fillRect(z.w / 2 - 2 / k, -z.h / 2, 4 / k, z.h);                       // ujung dalam (dinding pabrik)
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1 / k; g.beginPath(); g.moveTo(-z.w / 2, 0); g.lineTo(z.w / 2, 0); g.stroke();
    poly(rectPoly(V.x, V.y, V.ang, V.spec.rear, V.spec.front, V.spec.hw), 'rgba(96,165,250,0.7)', '#bfdbfe');
    poly(trailerPoly(info.tr || mission.trailer), ok ? 'rgba(34,197,94,0.85)' : 'rgba(245,158,11,0.85)', '#fff');
    title = `🅿️ PARKIR TRAILER · ${z.id}`;
    const sudut = info.angDeg < 1.5 ? 'lurus ✓' : `${info.angDeg.toFixed(0)}° miring`;
    lines = ok
      ? [info.still ? '✅ OK — sudah masuk penuh. Tekan A untuk lepas trailer' : '✅ Sudah masuk — berhenti dulu, lalu A', `Presisi ${info.acc}% · sudut ${sudut}`]
      : [`⏳ Belum masuk penuh — kurang ${(info.out / PX_PER_M).toFixed(1)} m`, `Sudut ${sudut} · presisi ${info.acc}%`];
  } else {
    const tr = info.tr, k = Math.min((W - 20) / 220, (H - 16) / 120);
    const ca = Math.cos(-tr.ang + Math.PI / 2 * 0), sa = Math.sin(-tr.ang);
    const loc = ([x, y]) => [((x - tr.x) * Math.cos(-tr.ang) - (y - tr.y) * sa), ((x - tr.x) * sa + (y - tr.y) * Math.cos(-tr.ang))];
    g.translate(W / 2 + 30 * k, H / 2); g.scale(k, k);
    const poly = (pts, fill, stroke) => { g.beginPath(); pts.forEach((p, i) => { const [x, y] = loc(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); g.fillStyle = fill; g.fill(); g.strokeStyle = stroke; g.lineWidth = 2 / k; g.stroke(); };
    ok = info.ok; void ca;
    poly(trailerPoly(tr), 'rgba(245,158,11,0.75)', '#fff');
    poly(rectPoly(V.x, V.y, V.ang, V.spec.rear, V.spec.front, V.spec.hw), 'rgba(96,165,250,0.7)', '#bfdbfe');
    const [fx, fy] = loc(fifthWheel(V));
    g.fillStyle = ok ? '#22c55e' : '#facc15'; g.beginPath(); g.arc(0, 0, 5 / k, 0, 7); g.fill();          // kingpin
    g.strokeStyle = '#e2e8f0'; g.lineWidth = 2 / k; g.beginPath(); g.arc(fx, fy, 7 / k, 0, 7); g.stroke();  // fifth wheel
    g.setLineDash([4 / k, 4 / k]); g.beginPath(); g.moveTo(0, 0); g.lineTo(fx, fy); g.stroke(); g.setLineDash([]);
    title = '🔗 SAMBUNG TRAILER';
    lines = ok ? ['✅ OK — fifth wheel tepat di kingpin. Tekan A', `Jarak ${(info.d / PX_PER_M).toFixed(1)} m · sudut ${info.angDeg.toFixed(0)}°`]
      : [`⏳ Mundur lagi ${(Math.max(0, info.d - COUPLE_DIST * 0.5) / PX_PER_M).toFixed(1)} m ke kingpin`, `Sudut ${info.angDeg.toFixed(0)}° ${info.angDeg < COUPLE_ANG / DEG ? '✓' : `(maks ${(COUPLE_ANG / DEG).toFixed(0)}°)`}`];
  }
  $('dockTitle').textContent = title;
  $('dockStatus').innerHTML = lines.map((t, i) => (i ? `<small>${t}</small>` : `<b>${t}</b>`)).join('');
  el.classList.toggle('ok', !!ok);
  // sensor parkir: bunyi makin rapat saat makin dekat; nada panjang saat OK
  const wasOk = el.dataset.ok === '1'; el.dataset.ok = ok ? '1' : '0';
  if (ok && !wasOk) { tone(988, 0.12, 0.05, 'sine'); tone(1319, 0.18, 0.05, 'sine', 0.12); rumble(0.3, 120); }
  if (!ok && Math.abs(V.v) > 1 && V.gear === 'R') {
    const rem = info.kind === 'drop' ? info.out : info.d;
    dockBeepT -= dt;
    if (dockBeepT <= 0) { tone(1400, 0.04, 0.03, 'sine'); dockBeepT = clamp(rem / 120, 0.12, 0.8); }
  }
}

function missionTarget() {
  if (mission) {
    const tr = mission.trailer;
    return tr.state === 'hooked' ? [mission.zone.x, mission.zone.y] : [tr.x, tr.y];
  }
  if (taxiJob) {
    const pt = taxiJob.phase === 'pickup' ? taxiJob.pickup : taxiJob.dest;
    return [pt.x, pt.y];
  }
  if (foodJob) {
    const pt = foodJob.phase === 'pickup' ? foodJob.pickup : foodJob.dest;
    return [pt.x, pt.y];
  }
  return null;
}

function drawGuide() {
  const tg = missionTarget();
  if (!tg || state !== 'play') return;
  const f = P.mode === 'drive' ? fifthWheel(P.veh) : [P.x, P.y];
  if (Math.hypot(tg[0] - f[0], tg[1] - f[1]) < 90) return;
  ctx.setLineDash([4, 10]); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(f[0], f[1]); ctx.lineTo(tg[0], tg[1]); ctx.stroke(); ctx.setLineDash([]);
}

function drawOffscreenArrow() {
  const tg = missionTarget();
  if (!tg || state !== 'play') return;
  const [sx, sy] = toScreen(tg[0], tg[1]);
  const m = 46 * dpr, cw = cvs.width, ch = cvs.height;
  if (sx > m && sx < cw - m && sy > m && sy < ch - m) return;
  const cx = cw / 2, cy = ch / 2, ang = Math.atan2(sy - cy, sx - cx);
  const kx = (cw / 2 - m) / Math.abs(Math.cos(ang) || 1e-6), ky = (ch / 2 - m) / Math.abs(Math.sin(ang) || 1e-6);
  const k = Math.min(kx, ky);
  const px = cx + Math.cos(ang) * k, py = cy + Math.sin(ang) * k;
  ctx.save(); ctx.translate(px, py); ctx.rotate(ang); ctx.scale(dpr, dpr);
  ctx.fillStyle = mission ? (mission.trailer.state === 'hooked' ? '#4ade80' : '#f59e0b') : taxiJob ? '#facc15' : '#34d399';
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(-10, -13); ctx.lineTo(-4, 0); ctx.lineTo(-10, 13); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
  const f = camFocus();
  const dist = Math.hypot(tg[0] - f.x, tg[1] - f.y) / PX_PER_M;
  ctx.save(); ctx.font = `bold ${12 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
  ctx.fillText(`${Math.round(dist)} m`, px - Math.cos(ang) * 30 * dpr, py - Math.sin(ang) * 30 * dpr + 4 * dpr);
  ctx.restore();
}

/* ----------------------------- Render interior rumah (2D) ----------------- */
const PLANK = 8;
function furnShadow(f, o = 2) { ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(f.x + o, f.y + o, f.w, f.h); }
const FURN_DRAW = {
  wall(f, th) { ctx.fillStyle = th.wall; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = th.trim; ctx.fillRect(f.x, f.y + f.h - 1, f.w, 1); },
  bed(f, th) {
    furnShadow(f);
    ctx.fillStyle = '#4b2e17'; ctx.fillRect(f.x - 1, f.y - 1, f.w + 2, f.h + 2);
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(f.x + 1, f.y + 1, f.w - 2, f.h - 2);
    ctx.fillStyle = '#e2e8f0'; ctx.beginPath(); ctx.roundRect(f.x + 2, f.y + 2, 8, 5, 1.5); ctx.roundRect(f.x + f.w - 10, f.y + 2, 8, 5, 1.5); ctx.fill();
    ctx.fillStyle = th.bed; ctx.fillRect(f.x + 1, f.y + 10, f.w - 2, f.h - 11);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(f.x + 1, f.y + 10, f.w - 2, 3);
    ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(f.x + f.w / 2, f.y + 13); ctx.lineTo(f.x + f.w / 2, f.y + f.h - 1); ctx.stroke();
  },
  nightstand(f, th) {
    furnShadow(f, 1.5); ctx.fillStyle = th.wood; ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(f.x + f.w / 2, f.y + f.h / 2, 2.4, 0, 7); ctx.fill();
  },
  wardrobe(f, th) {
    furnShadow(f); ctx.fillStyle = th.wood; ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(f.x, f.y, f.w, 3);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.5;
    for (let i = 1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(f.x + f.w * i / 3, f.y); ctx.lineTo(f.x + f.w * i / 3, f.y + f.h); ctx.stroke(); }
  },
  tv(f, th) {
    furnShadow(f); ctx.fillStyle = th.wood; ctx.fillRect(f.x, f.y, f.w, f.h);
    const mg = Math.min(6, f.w * 0.14);
    ctx.fillStyle = '#0b1220'; ctx.fillRect(f.x + mg, f.y + 1.5, f.w - mg * 2, 3);
    if (tvOnHere()) {                         // layar menyala
      ctx.fillStyle = `hsl(${(performance.now() / 20) % 360},70%,55%)`; ctx.fillRect(f.x + mg + 1, f.y + 1.8, f.w - mg * 2 - 2, 2.4);
      ctx.fillStyle = `rgba(147,197,253,${0.18 + 0.1 * Math.sin(performance.now() / 120)})`;
      ctx.beginPath(); ctx.moveTo(f.x + mg, f.y + 5); ctx.lineTo(f.x + f.w - mg, f.y + 5); ctx.lineTo(f.x + f.w + 10, f.y + 40); ctx.lineTo(f.x - 10, f.y + 40); ctx.fill();
    } else { ctx.fillStyle = 'rgba(96,165,250,0.25)'; ctx.fillRect(f.x + mg + 1, f.y + 2, f.w - mg * 2 - 2, 1.2); }
  },
  sofa(f, th) {
    furnShadow(f);
    ctx.fillStyle = th.sofa; ctx.beginPath(); ctx.roundRect(f.x, f.y, f.w, f.h, 2.5); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(f.x + 1, f.y + f.h - 3.5, f.w - 2, 2.5);          // sandaran (sisi selatan)
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    for (let i = 0; i < 3; i++) ctx.fillRect(f.x + 3 + i * ((f.w - 6) / 3), f.y + 1.5, (f.w - 6) / 3 - 1, f.h - 6);
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(f.x, f.y, 2.5, f.h); ctx.fillRect(f.x + f.w - 2.5, f.y, 2.5, f.h);
  },
  coffee(f, th) { furnShadow(f, 1.5); ctx.fillStyle = th.wood; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(f.x + 1, f.y + 1, f.w - 2, f.h - 2);
    ctx.fillStyle = '#f8fafc'; ctx.beginPath(); ctx.arc(f.x + 6, f.y + 4.5, 1.8, 0, 7); ctx.fill(); },
  dining(f, th) { furnShadow(f); ctx.fillStyle = th.wood; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(f.x + 1, f.y + 1, f.w - 2, f.h - 2);
    ctx.fillStyle = '#fef3c7'; ctx.fillRect(f.x + f.w / 2 - 5, f.y + f.h / 2 - 3, 10, 6); },
  chair(f, th) { furnShadow(f, 1); ctx.fillStyle = '#a16207'; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(f.x, f.flip ? f.y + f.h - 1.5 : f.y, f.w, 1.5); },
  fridge(f) { furnShadow(f); ctx.fillStyle = '#e5e7eb'; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = '#9ca3af'; ctx.fillRect(f.x + 2, f.y + 1, 1, f.h - 2); ctx.fillRect(f.x, f.y + f.h / 2, f.w, 0.6); },
  counter(f) {
    furnShadow(f); ctx.fillStyle = '#cbd5e1'; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = '#64748b'; ctx.fillRect(f.x + 2, f.y + 2, f.w - 4, f.h - 4);
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(f.x + 3, f.y + 6, f.w - 6, 12); ctx.fillStyle = '#94a3b8'; ctx.fillRect(f.x + 5, f.y + 8, f.w - 10, 8);   // bak cuci
    ctx.fillStyle = '#111827'; for (const [dx, dy] of [[4, 32], [10, 32], [4, 40], [10, 40]]) { ctx.beginPath(); ctx.arc(f.x + dx, f.y + dy, 2.2, 0, 7); ctx.fill(); }
  },
  shoes(f) { furnShadow(f, 1.5); ctx.fillStyle = '#78350f'; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = '#111827'; ctx.fillRect(f.x + 3, f.y + 3, 5, 3); ctx.fillStyle = '#dc2626'; ctx.fillRect(f.x + 11, f.y + 3, 5, 3); ctx.fillStyle = '#f8fafc'; ctx.fillRect(f.x + 18, f.y + 3, 5, 3); },
  rug(f, th) {
    ctx.fillStyle = th[f.col] || f.col; ctx.globalAlpha = f.col === 'accent' ? 0.55 : 1; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(f.x + 2, f.y + 2, f.w - 4, f.h - 4);
    if (f.border) { ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 0.8; ctx.strokeRect(f.x + 2, f.y + 2, f.w - 4, f.h - 4); }
  },
  prayerMat(f) {
    ctx.fillStyle = '#166534'; ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.8; ctx.strokeRect(f.x + 1, f.y + 1, f.w - 2, f.h - 2);
    ctx.fillStyle = '#fde68a'; ctx.fillRect(f.x + 5, f.y + f.h / 2 - 0.8, f.w - 9, 1.6);
    ctx.beginPath(); ctx.moveTo(f.x + 3, f.y + f.h / 2); ctx.lineTo(f.x + 8, f.y + f.h / 2 - 3);
    ctx.lineTo(f.x + 8, f.y + f.h / 2 + 3); ctx.closePath(); ctx.fill();
  },
  wudu(f) {
    furnShadow(f, 2); ctx.fillStyle = '#9ca3af'; ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.fillStyle = '#64748b'; ctx.fillRect(f.x + 3, f.y + 3, f.w - 6, f.h - 6);
    for (let y = f.y + 8; y < f.y + f.h - 10; y += 24) {
      ctx.fillStyle = '#bae6fd'; ctx.fillRect(f.x + 5, y, f.w - 10, 14);
      ctx.fillStyle = '#e2e8f0'; ctx.fillRect(f.x + 10, y + 2, f.w - 20, 10);
      ctx.fillStyle = '#475569'; ctx.fillRect(f.x + f.w / 2 - 1, y - 3, 2, 5);
    }
  },
  etalase(f, th) {                         // etalase kaca berisi lauk / makanan
    furnShadow(f); ctx.fillStyle = th.wood; ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.fillStyle = 'rgba(191,219,254,0.85)'; ctx.fillRect(f.x + 1.5, f.y + 1.5, f.w - 3, f.h - 3);
    const foods = ['#f59e0b', '#16a34a', '#b45309', '#dc2626', '#fde68a', '#78350f'];
    for (let i = 0, x = f.x + 4; x < f.x + f.w - 6; x += 9, i++) { ctx.fillStyle = foods[i % foods.length]; ctx.beginPath(); ctx.ellipse(x + 3, f.y + f.h / 2, 3.2, Math.min(4, f.h / 3), 0, 0, 7); ctx.fill(); }
    if (f.h > f.w) for (let i = 0, y = f.y + 4; y < f.y + f.h - 6; y += 9, i++) { ctx.fillStyle = foods[i % foods.length]; ctx.beginPath(); ctx.arc(f.x + f.w / 2, y + 3, 3, 0, 7); ctx.fill(); }
  },
  stove(f) { furnShadow(f); ctx.fillStyle = '#9ca3af'; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = '#1f2937';
    for (const dx of [0.28, 0.72]) { ctx.beginPath(); ctx.arc(f.x + f.w * dx, f.y + f.h / 2, 3.6, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#e5e7eb'; ctx.beginPath(); ctx.arc(f.x + f.w * 0.28, f.y + f.h / 2, 3, 0, 7); ctx.fill(); },
  table(f, th) { furnShadow(f); ctx.fillStyle = th.wood; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(f.x + 1, f.y + 1, f.w - 2, f.h - 2);
    ctx.fillStyle = '#f8fafc'; for (let x = f.x + 8; x < f.x + f.w - 4; x += 16) { ctx.beginPath(); ctx.arc(x, f.y + f.h / 2, 2.4, 0, 7); ctx.fill(); } },
  bench(f, th) { furnShadow(f, 1); ctx.fillStyle = th.wood; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(f.x, f.y + f.h - 1.2, f.w, 1.2); },
  shelf(f) {                               // rak barang (warna-warni)
    furnShadow(f); ctx.fillStyle = '#e5e7eb'; ctx.fillRect(f.x, f.y, f.w, f.h);
    const cols = f.col ? [f.col, '#fde68a', f.col, '#f8fafc'] : ['#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#a855f7'];
    for (let i = 0, x = f.x + 1.5; x < f.x + f.w - 3; x += 5, i++) { ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(x, f.y + 1.5, 3.8, f.h - 3); }
  },
  kasir(f) {                               // meja kasir + mesin kasir
    furnShadow(f); ctx.fillStyle = '#334155'; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = '#e2e8f0'; ctx.fillRect(f.x + 1, f.y + 1, f.w - 2, 4);
    ctx.fillStyle = '#111827'; ctx.fillRect(f.x + f.w - 14, f.y + 6, 10, 7); ctx.fillStyle = '#38bdf8'; ctx.fillRect(f.x + f.w - 13, f.y + 7, 8, 3);
  },
  desk(f, th) { furnShadow(f); ctx.fillStyle = th.wood; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(f.x, f.y, f.w, 3);
    ctx.fillStyle = '#111827'; ctx.fillRect(f.x + 4, f.y + 3, 10, 5); ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(f.x + f.w - 6, f.y + 6, 2, 0, 7); ctx.fill(); },
  sdesk(f) { furnShadow(f, 1.5); ctx.fillStyle = '#d6b88a'; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = '#f8fafc'; ctx.fillRect(f.x + 6, f.y + 3, 10, 6);
    ctx.strokeStyle = '#1d4ed8'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(f.x + 18, f.y + 4); ctx.lineTo(f.x + 24, f.y + 8); ctx.stroke(); },
  board(f) { ctx.fillStyle = '#475569'; ctx.fillRect(f.x - 1, f.y, f.w + 2, f.h + 1); ctx.fillStyle = '#f8fafc'; ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.fillStyle = '#2563eb'; ctx.font = 'bold 2.4px sans-serif'; ctx.textAlign = 'left'; ctx.fillText('1 + 2 = 3   7 × 8 = 56', f.x + 4, f.y + 2); },
  stall(f) {                               // los pasar: meja kayu + dagangan
    furnShadow(f); ctx.fillStyle = '#92400e'; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = '#b45309'; ctx.fillRect(f.x + 1.5, f.y + 1.5, f.w - 3, f.h - 3);
    for (let x = f.x + 5; x < f.x + f.w - 3; x += 7) for (let y = f.y + 5; y < f.y + f.h - 3; y += 6) {
      ctx.fillStyle = f.col; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill(); }
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = 'bold 4px sans-serif'; ctx.textAlign = 'center'; ctx.fillText((f.goods || '').toUpperCase(), f.x + f.w / 2, f.y - 3);
  },
  crate(f) { furnShadow(f, 1.5); ctx.fillStyle = '#a16207'; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 0.6;
    for (let x = f.x + 4; x < f.x + f.w; x += 4) { ctx.beginPath(); ctx.moveTo(x, f.y); ctx.lineTo(x, f.y + f.h); ctx.stroke(); } },
  jerry(f) { furnShadow(f, 1.5); for (let i = 0; i < 3; i++) { ctx.fillStyle = '#dc2626'; ctx.fillRect(f.x + 1 + i * 10, f.y + 2, 8, f.h - 4); ctx.fillStyle = '#111827'; ctx.fillRect(f.x + 3 + i * 10, f.y + 1, 3, 2); } },
  showcar(f) { ctx.fillStyle = 'rgba(220,38,38,0.25)'; ctx.beginPath(); ctx.ellipse(f.x + f.w / 2, f.y + f.h / 2, f.w / 2 + 6, f.h / 2 + 6, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.8; ctx.stroke(); },
  plant(f) { ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.arc(f.x + 6, f.y + 6, 5.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#92400e'; ctx.beginPath(); ctx.arc(f.x + 5, f.y + 5, 4, 0, 7); ctx.fill();
    ctx.fillStyle = '#15803d'; for (let i = 0; i < 6; i++) { const a = i * 1.05; ctx.beginPath(); ctx.arc(f.x + 5 + Math.cos(a) * 2.6, f.y + 5 + Math.sin(a) * 2.6, 2.4, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#22c55e'; ctx.beginPath(); ctx.arc(f.x + 5, f.y + 5, 2.4, 0, 7); ctx.fill(); },
};

function drawRoom2D(th, now) {
  const R = IN.room, g = ctx, RW = R.w, RH = R.h, gap0 = R.doorX - R.doorW / 2, gap1 = R.doorX + R.doorW / 2;
  // lantai
  g.fillStyle = th.floor; g.fillRect(0, 0, RW, RH);
  g.strokeStyle = th.floorLine; g.lineWidth = 0.4;
  g.beginPath();
  if (th.tile) { for (let x = 0; x <= RW; x += 20) { g.moveTo(x, 0); g.lineTo(x, RH); } for (let y = 0; y <= RH; y += 20) { g.moveTo(0, y); g.lineTo(RW, y); } }
  else {
    for (let y = 0, r = 0; y <= RH; y += PLANK, r++) { g.moveTo(0, y); g.lineTo(RW, y); for (let x = (r % 3) * 22 + 10; x < RW; x += 66) { g.moveTo(x, y); g.lineTo(x, y + PLANK); } }
  }
  g.stroke();
  // dinding (di luar ruangan) + jendela di dinding utara
  g.fillStyle = th.trim; g.fillRect(-7, -7, RW + 14, 7); g.fillRect(-7, -7, 7, RH + 14); g.fillRect(RW, -7, 7, RH + 14);
  g.fillRect(-7, RH, gap0 + 7, 7); g.fillRect(gap1, RH, RW - gap1 + 7, 7);
  g.fillStyle = th.wall; g.fillRect(-5, -5, RW + 10, 5); g.fillRect(-5, -5, 5, RH + 10); g.fillRect(RW, -5, 5, RH + 10);
  g.fillRect(-5, RH + 1, gap0 + 5, 5); g.fillRect(gap1, RH + 1, RW - gap1 + 5, 5);
  g.fillStyle = '#bfdbfe'; for (const wx of IN.windows) { g.fillRect(wx, -4.5, 22, 4); }
  g.fillStyle = '#92400e'; g.fillRect(gap0 - 1.5, RH - 1, 1.5, 8); g.fillRect(gap1, RH - 1, 1.5, 8);   // kusen pintu
  g.fillStyle = '#292524'; g.fillRect(gap0 + 2, RH - 5, R.doorW - 4, 4);                                // keset
  g.fillStyle = 'rgba(253,230,138,0.85)'; g.font = 'bold 4px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('PINTU ↓', R.doorX, RH - 2.8);
  // perabot: yang di lantai dulu, lalu yang padat
  for (const f of IN.furn) if (f.kind !== 'wall' && !f.solid) (FURN_DRAW[f.kind] || (() => {}))(f, th);
  for (const f of IN.furn) if (f.solid || f.kind === 'wall') (FURN_DRAW[f.kind] || (() => {}))(f, th);
  for (const dc of IN_DISPLAY) drawCar(dc, now);
  // lingkaran interaksi
  const pulse = 0.5 + 0.5 * Math.sin(now / 300);
  g.lineWidth = 0.9; g.setLineDash([2.5, 2.5]); g.strokeStyle = '#fde68a';
  for (const z of IN.zones) {
    if (!z.rect || !z.icon) continue;
    const f = z.rect;
    g.globalAlpha = 0.4 + 0.35 * pulse; g.beginPath(); g.roundRect(f.x - 12, f.y - 12, f.w + 24, f.h + 24, 10); g.stroke();
    g.globalAlpha = 0.9; g.setLineDash([]); g.font = '9px sans-serif'; g.fillText(z.icon, f.x + f.w + 8, f.y - 6); g.setLineDash([2.5, 2.5]);
  }
  g.setLineDash([]); g.globalAlpha = 1;
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = 'bold 7px sans-serif'; g.textAlign = 'center';
  g.fillText(P.house.label.toUpperCase(), RW / 2, -14);
}

function renderInterior2D(now) {
  const th = themeOf(P.house), R = IN.room, FBED = IN.furn.find((f) => f.kind === 'bed');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#17120d'; ctx.fillRect(0, 0, cvs.width, cvs.height);
  const pad = 36, s = Math.min(cvs.width / (R.w + pad * 2), cvs.height / (R.h + pad * 2));
  ctx.setTransform(s, 0, 0, s, (cvs.width - R.w * s) / 2, (cvs.height - R.h * s) / 2);
  drawRoom2D(th, now);
  const bed = P.resting === 'bed' && FBED, sofa = P.resting && !bed && P.sit;
  if (bed) {                                   // sopir tidur di kasur (kepala di bantal)
    const f = FBED; ctx.save();
    ctx.fillStyle = '#d6a77a'; ctx.beginPath(); ctx.arc(f.x + f.w / 2, f.y + 5, 3.2, 0, 7); ctx.fill();
    ctx.fillStyle = '#111827'; ctx.beginPath(); ctx.arc(f.x + f.w / 2, f.y + 4.2, 3.2, Math.PI, 0); ctx.fill();
    ctx.fillStyle = 'rgba(15,23,42,0.35)'; ctx.beginPath(); ctx.roundRect(f.x + f.w / 2 - 5, f.y + 9, 10, f.h - 12, 3); ctx.fill();
    ctx.restore();
  } else if (sofa) drawWalkerAt(P.sit.x, P.sit.y, P.sit.ang, true);
  else drawWalkerAt(P.ix, P.iy, P.ang);
  if (bed || sofa) {                           // redup + "zzz"
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bed ? 'rgba(6,10,30,0.45)' : 'rgba(6,10,30,0.18)'; ctx.fillRect(0, 0, cvs.width, cvs.height);
    if (bed) {
      ctx.setTransform(s, 0, 0, s, (cvs.width - R.w * s) / 2, (cvs.height - R.h * s) / 2);
      ctx.fillStyle = '#e0e7ff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (let i = 0; i < 3; i++) {
        const t = ((now / 1400 + i / 3) % 1);
        ctx.globalAlpha = 1 - t; ctx.font = `bold ${5 + i * 2}px sans-serif`;
        ctx.fillText('z', FBED.x + 20 + t * 14 + i * 3, FBED.y - 2 - t * 18);
      }
      ctx.globalAlpha = 1;
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function renderWorld2D(now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#26352a'; ctx.fillRect(0, 0, cvs.width, cvs.height);
  const s = cam.scale;
  ctx.setTransform(s, 0, 0, s, cvs.width / 2 - cam.x * s, cvs.height / 2 - cam.y * s);
  const v = viewRect();
  drawGround(v);
  drawZones(now);
  drawGuide();
  for (const tr of trailers) if (tr.owner || visible(v, tr.x - 160, tr.y - 160, tr.x + 160, tr.y + 160)) drawTrailer(tr, now);
  for (const actor of actors) if (visible(v, actor.x - 20, actor.y - 20, actor.x + 20, actor.y + 20))
    drawWalkerAt(actor.x, actor.y, actor.ang, actor.state === 'waiting' || actor.wait > 0, actor, actor.walkT);
  for (const n of npcs) if (visible(v, n.x - 90, n.y - 90, n.x + 90, n.y + 90)) drawVehicle(n, now);
  for (const veh of vehicles) { drawVehicle(veh, now); drawTaxiPassenger2D(veh); }
  for (const dc of DISPLAY) if (visible(v, dc.x - 80, dc.y - 80, dc.x + 80, dc.y + 80)) drawCar(dc, now);
  drawWalker();
  drawSignals2D(v);
  drawFX2D();
  drawOverhead(v);
  drawNight2D(v);
  drawLabels(now, v);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawOffscreenArrow();
}

// Malam di 2D: lapisan gelap dengan "lubang" cahaya (lampu jalan, lampu depan, jendela, toko)
let nightCvs = null;
function drawNight2D(v) {
  const n = nightAmt();
  if (n <= 0) return;
  if (!nightCvs) nightCvs = document.createElement('canvas');
  if (nightCvs.width !== cvs.width || nightCvs.height !== cvs.height) { nightCvs.width = cvs.width; nightCvs.height = cvs.height; }
  const g = nightCvs.getContext('2d'), s = cam.scale;
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, nightCvs.width, nightCvs.height);
  g.fillStyle = `rgba(6,10,32,${0.74 * n})`; g.fillRect(0, 0, nightCvs.width, nightCvs.height);
  g.setTransform(s, 0, 0, s, cvs.width / 2 - cam.x * s, cvs.height / 2 - cam.y * s);
  g.globalCompositeOperation = 'destination-out';
  const hole = (x, y, r, a = 1) => {
    if (!visible(v, x - r, y - r, x + r, y + r)) return;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  const beam = (V) => {                     // kerucut lampu depan
    if (V.wreck) return;
    const s2 = V.spec, fx = Math.cos(V.ang), fy = Math.sin(V.ang), L = V.type === 'motor' ? 105 : V.type === 'car' ? 150 : 190;
    const x0 = V.x + fx * s2.front, y0 = V.y + fy * s2.front;
    if (!visible(v, x0 - L, y0 - L, x0 + L, y0 + L)) return;
    const gr = g.createRadialGradient(x0, y0, 4, x0, y0, L);
    gr.addColorStop(0, 'rgba(0,0,0,0.95)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.beginPath(); g.moveTo(x0 - fy * s2.hw, y0 + fx * s2.hw);
    g.lineTo(x0 + fx * L - fy * L * 0.42, y0 + fy * L + fx * L * 0.42);
    g.lineTo(x0 + fx * L + fy * L * 0.42, y0 + fy * L - fx * L * 0.42);
    g.lineTo(x0 + fy * s2.hw, y0 - fx * s2.hw); g.closePath(); g.fill();
    hole(V.x - fx * 4, V.y - fy * 4, 40, 0.5);
  };
  for (const l of level.lamps) hole(l.x + Math.cos(l.ang) * 22, l.y + Math.sin(l.ang) * 22, 110, 0.9);
  for (const V of vehicles) if (V === P.veh || Math.abs(V.v) > 0.5) beam(V);
  for (const V of npcs) beam(V);
  for (const p of level.places) hole(p.x, p.y, 90, 0.7);
  for (const O of OBS) {
    const o = O.o;
    if (!visible(v, O.x0 - 40, O.y0 - 40, O.x1 + 40, O.y1 + 40)) continue;
    if (o.kind === 'house' && ((o.x * 7 + o.y * 13) % 10) < 6) hole(o.x + o.w / 2, o.y + o.h + 6, 34, 0.55);
    else if (['shop', 'warung', 'market', 'store', 'showroom', 'hotel', 'mosque', 'factory', 'dock', 'building', 'school', 'kumon', 'monument', 'cart', 'tollbooth', 'bengkel', 'partsrack'].includes(o.kind))
      hole(o.x + o.w / 2, o.y + o.h / 2, Math.max(o.w, o.h) * 0.8, 0.7);
  }
  if (P.mode === 'walk') hole(P.x, P.y, 45, 0.6);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(nightCvs, 0, 0); ctx.restore();
  // pendar kuning lampu jalan
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const l of level.lamps) {
    const x = l.x + Math.cos(l.ang) * 22, y = l.y + Math.sin(l.ang) * 22;
    if (!visible(v, x - 60, y - 60, x + 60, y + 60)) continue;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, 60);
    gr.addColorStop(0, `rgba(255,200,110,${0.35 * n})`); gr.addColorStop(1, 'rgba(255,200,110,0)');
    ctx.fillStyle = gr; ctx.fillRect(x - 60, y - 60, 120, 120);
  }
  ctx.restore();
}

function render3dState() {
  return { built: BUILT, P, cam, vehicles, npcs, actors, trailers, mission, usedZones, state, dpr, W, H, ROOM: IN.room, FURN: IN.furn, IN, IN_DISPLAY, THEMES, THEME: P.house ? themeOf(P.house) : THEMES.sopir, ZOOMS, TRAILER, PX_PER_M,
    suspensionTravelPx: suspensionSettings.travelCm / 10,
    fifthWheel, zoneFit, onPaved, fadeA: fade.a, clock, night: nightAmt(), mainX, display: DISPLAY, fx: FX, sigState, sigCountdown, riderOf, hasRider, foodJob, taxiJob, intro: introActive ? introCamAt() : null };
}

function render(now) {
  if (is3D()) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cvs.width, cvs.height);
    Render3D.frame(now, render3dState(), ctx);        // dunia 3D + label di kanvas 2D (overlay)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (P.mode !== 'inside') drawOffscreenArrow();
  } else if (P.mode === 'inside') renderInterior2D(now);
  else renderWorld2D(now);
  if (fade.a > 0) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(0,0,0,${Math.min(1, fade.a)})`; ctx.fillRect(0, 0, cvs.width, cvs.height); }
}

/* ----------------------------- Minimap (radar) & peta rute ---------------- */
const RADAR_W = 2600;                // lebar dunia yang tampil di radar
const MAP_K = 0.12;                  // skala gambar peta penuh
function buildMinimap() {
  const c = document.createElement('canvas'); c.width = Math.round(W * MAP_K); c.height = Math.round(H * MAP_K);
  const g = c.getContext('2d');
  g.scale(MAP_K, MAP_K);
  g.fillStyle = '#2f4a2d'; g.fillRect(0, 0, W, H);
  const T = level.terrain;
  if (T) for (let j = 0; j < T.ny - 1; j++) for (let i = 0; i < T.nx - 1; i++) {          // bayangan kontur
    const h = T.h[j * T.nx + i]; if (h < 3) continue;
    const band = Math.floor(h / 50) % 2;
    g.fillStyle = `rgba(${band ? 120 : 95},${band ? 150 : 130},${band ? 90 : 80},${Math.min(0.85, 0.25 + h / 600)})`;
    g.fillRect(T.x0 + i * T.cell, T.y0 + j * T.cell, T.cell + 1, T.cell + 1);
  }
  g.fillStyle = '#557a36'; for (const sw of level.sawah) g.fillRect(sw.x, sw.y, sw.w, sw.h);
  g.fillStyle = '#7a5a2a'; for (const d of level.decor) if (d.kind === 'arena') { g.beginPath(); g.ellipse(d.x, d.y, d.rx, d.ry, 0, 0, 7); g.fill(); }
  g.fillStyle = '#4b5563'; for (const p of level.pads) g.fillRect(p.x, p.y, p.w, p.h);
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (const r of level.roads) {
    g.strokeStyle = r.kind === 'main' ? '#e5e7eb' : r.kind === 'toll' ? '#f59e0b' : '#9ca3af'; g.lineWidth = Math.max(r.w, 60);
    g.beginPath(); r.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  }
  for (const d of level.decor) if (d.kind === 'toll') {
    g.strokeStyle = '#f59e0b'; g.lineWidth = 70; g.setLineDash([120, 60]);
    g.beginPath(); d.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); g.setLineDash([]);
  }
  const col = { house: '#a8a29e', warung: '#14b8a6', market: '#f59e0b', shop: '#f1f5f9', pump: '#ef4444', factory: '#94a3b8', dock: '#94a3b8', building: '#94a3b8', tollbooth: '#fbbf24',
    kumon: '#38bdf8', monument: '#e7e5e4', cart: '#b45309', bengkel: '#f97316', partsrack: '#6b7280', signal: '#22c55e', store: '#16a34a', showroom: '#ef4444', hotel: '#b45309', school: '#16a34a',
    amp: '#facc15', stockpile: '#a8a29e' };
  for (const d of level.decor) if (d.kind === 'alun') { g.fillStyle = '#65a30d'; g.fillRect(d.x, d.y, d.w, d.h); }
  for (const o of level.obstacles) {
    if (o.kind === 'tree') { g.fillStyle = '#3f8a43'; g.beginPath(); g.arc(o.x + 15, o.y + 15, 22, 0, 7); g.fill(); }
    else if (o.kind === 'pine') { g.fillStyle = '#1f4d2b'; g.beginPath(); g.arc(o.x + 10, o.y + 10, 18, 0, 7); g.fill(); }
    else if (o.kind === 'fence') { g.fillStyle = '#cbd5e1'; g.fillRect(o.x, o.y, Math.max(o.w, 16), Math.max(o.h, 16)); }
    else { g.fillStyle = col[o.kind] || '#9ca3af'; g.fillRect(o.x, o.y, o.w, o.h); }
  }
  g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 14;
  for (const z of level.zones) { g.save(); g.translate(z.x, z.y); g.rotate(z.angle * DEG); g.strokeRect(-z.w / 2, -z.h / 2, z.w, z.h); g.restore(); }
  const pc = { house: '#facc15', pump: '#ef4444', shop: '#f8fafc', warung: '#2dd4bf', oleh: '#4ade80', hotel: '#fb923c', dealer: '#f87171',
    school: '#86efac', kumon: '#38bdf8', ronde: '#fbbf24', alun: '#a3e635', bengkel: '#fb923c', amp: '#facc15', wisata: '#4ade80' };
  for (const p of level.places) { g.fillStyle = pc[p.kind] || '#e5e7eb'; g.strokeStyle = '#000'; g.lineWidth = 10; g.beginPath(); g.arc(p.x, p.y, 45, 0, 7); g.fill(); g.stroke(); }
  return c;
}

function miniPoly(g, p) { g.beginPath(); p.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); }

function drawMapMarkers(g, now, k) {   // k = ukuran penanda (px dunia)
  const pulse = 0.5 + 0.5 * Math.sin(now / 200);
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (const r of [...BUILT.roads, ...(BUILT.cur && BUILT.cur.pts.length > 1 ? [BUILT.cur] : [])]) {   // jalan buatan paver
    g.strokeStyle = r === BUILT.cur ? '#111827' : '#6b7280'; g.lineWidth = Math.max(r.w, 50);
    g.beginPath(); r.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  }
  const amp = level.places.find((p) => p.kind === 'amp');
  if (amp) { g.font = `${k * 1.1}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('🏗️', amp.x, amp.y); }
  for (const sg of level.signals || []) {           // lampu lalu lintas: titik berwarna sesuai lampu jalan raya
    g.fillStyle = SIG_COL[sigState(sg, 0)]; g.strokeStyle = '#000'; g.lineWidth = k * 0.1;
    g.beginPath(); g.arc(sg.x, sg.y, k * 0.32, 0, 7); g.fill(); g.stroke();
  }
  const bk = level.places.find((p) => p.kind === 'bengkel');
  if (bk) {                                         // bengkel: ikon kunci oranye
    g.fillStyle = '#f97316'; g.strokeStyle = '#000'; g.lineWidth = k * 0.1;
    g.beginPath(); g.roundRect(bk.x - k * 0.6, bk.y - k * 0.6, k * 1.2, k * 1.2, k * 0.25); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.font = `${k * 0.9}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('🔧', bk.x, bk.y + k * 0.05);
  }
  if (mission) {
    const z = mission.zone;
    g.save(); g.translate(z.x, z.y); g.rotate(z.angle * DEG);
    g.fillStyle = `rgba(74,222,128,${0.5 + 0.5 * pulse})`; g.fillRect(-z.w / 2 - k * 0.3, -z.h / 2 - k * 0.3, z.w + k * 0.6, z.h + k * 0.6);
    g.restore();
  }
  for (const tr of trailers) {
    const isT = mission && tr === mission.trailer;
    g.fillStyle = tr.state === 'delivered' ? '#86efac' : isT ? '#f59e0b' : '#d1d5db';
    miniPoly(g, trailerPoly(tr));
    if (isT && tr.state !== 'hooked') {
      g.strokeStyle = '#f59e0b'; g.lineWidth = k * 0.15;
      g.beginPath(); g.arc(tr.x, tr.y, k * (0.8 + 0.4 * pulse), 0, 7); g.stroke();
    }
  }
  for (const n of npcs) {
    if (n.foodDelivery) {
      g.fillStyle = '#10b981';
      miniPoly(g, rectPoly(n.x, n.y, n.ang, -k * 0.4, k * 0.9, k * 0.4));
    } else {
      g.fillStyle = n.service ? '#f97316' : '#e2e8f0';
      miniPoly(g, rectPoly(n.x, n.y, n.ang, -k * 0.3, k * (n.service ? 1 : 0.7), k * (n.service ? 0.4 : 0.25)));
    }
  }
  if (SERVICE) { g.strokeStyle = 'rgba(249,115,22,0.8)'; g.lineWidth = k * 0.25; g.setLineDash([k * 0.6, k * 0.4]); g.beginPath(); g.moveTo(SERVICE.x, SERVICE.y); for (let i = SERVICE.ri; i < SERVICE.route.length; i++) g.lineTo(SERVICE.route[i][0], SERVICE.route[i][1]); g.stroke(); g.setLineDash([]); }
  if (FOOD_SERVICE) {
    g.strokeStyle = 'rgba(16,185,129,0.85)'; g.lineWidth = k * 0.25; g.setLineDash([k * 0.5, k * 0.3]);
    g.beginPath(); g.moveTo(FOOD_SERVICE.x, FOOD_SERVICE.y); for (let i = FOOD_SERVICE.ri; i < FOOD_SERVICE.route.length; i++) g.lineTo(FOOD_SERVICE.route[i][0], FOOD_SERVICE.route[i][1]); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#10b981'; g.font = `${k * 1.1}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('🛵', FOOD_SERVICE.x, FOOD_SERVICE.y);
  }
  if (foodJob) {
    const pt = foodJob.phase === 'pickup' ? foodJob.pickup : foodJob.dest;
    g.strokeStyle = '#10b981'; g.lineWidth = k * 0.15;
    g.beginPath(); g.arc(pt.x, pt.y, k * (0.8 + 0.4 * pulse), 0, 7); g.stroke();
    g.fillStyle = '#10b981'; g.font = `${k * 1.1}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(foodJob.phase === 'pickup' ? '🍲' : '📍', pt.x, pt.y);
  }
  if (taxiJob) {
    const pt = taxiJob.phase === 'pickup' ? taxiJob.pickup : taxiJob.dest;
    g.strokeStyle = '#fbbf24'; g.lineWidth = k * 0.18;
    g.beginPath(); g.arc(pt.x, pt.y, k * (0.9 + 0.5 * pulse), 0, 7); g.stroke();
    g.fillStyle = '#fbbf24'; g.font = `${k * 1.2}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(taxiJob.phase === 'pickup' ? '🙋' : '🏁', pt.x, pt.y);
  }
  for (const v of vehicles) {
    if (v === P.veh) continue;
    g.fillStyle = '#93c5fd'; miniPoly(g, rectPoly(v.x, v.y, v.ang, -k * 0.3, k * 0.8, k * 0.3));
  }
  const f = P.mode === 'drive' ? P.veh : null;
  g.save();
  if (f) { g.translate(f.x, f.y); g.rotate(f.ang); g.fillStyle = '#60a5fa'; }
  else { g.translate(P.x, P.y); g.rotate(P.ang); g.fillStyle = '#facc15'; }
  g.strokeStyle = '#0b1220'; g.lineWidth = k * 0.12;
  g.beginPath(); g.moveTo(k, 0); g.lineTo(-k * 0.5, -k * 0.6); g.lineTo(-k * 0.5, k * 0.6); g.closePath(); g.fill(); g.stroke();
  g.restore();
}

function drawMinimap(now) {
  if (!mapBg) return;
  const g = mctx, f = camFocus();
  const s = mini.width / RADAR_W;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#1b2a1b'; g.fillRect(0, 0, mini.width, mini.height);
  g.setTransform(s, 0, 0, s, mini.width / 2 - f.x * s, mini.height / 2 - f.y * s);
  g.drawImage(mapBg, 0, 0, W, H);
  drawMapMarkers(g, now, 110);
  if (!is3D()) {
    const hw = cvs.width / 2 / cam.scale, hh = cvs.height / 2 / cam.scale;
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 10;
    g.strokeRect(cam.x - hw, cam.y - hh, hw * 2, hh * 2);
  }
  // panah ke target bila di luar radar
  const tg = missionTarget();
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (tg) {
    const dx = (tg[0] - f.x) * s, dy = (tg[1] - f.y) * s, cw = mini.width / 2 - 12 * dpr, ch = mini.height / 2 - 12 * dpr;
    if (Math.abs(dx) > cw || Math.abs(dy) > ch) {
      const a = Math.atan2(dy, dx), kk = Math.min(cw / Math.abs(Math.cos(a) || 1e-6), ch / Math.abs(Math.sin(a) || 1e-6));
      g.save(); g.translate(mini.width / 2 + Math.cos(a) * kk, mini.height / 2 + Math.sin(a) * kk); g.rotate(a); g.scale(dpr, dpr);
      g.fillStyle = mission.trailer.state === 'hooked' ? '#4ade80' : '#f59e0b';
      g.beginPath(); g.moveTo(9, 0); g.lineTo(-6, -7); g.lineTo(-6, 7); g.closePath(); g.fill(); g.restore();
    }
  }
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = `bold ${11 * dpr}px sans-serif`; g.textAlign = 'left';
  g.fillText('U ↑', 6 * dpr, 14 * dpr);
}

function drawBigMap(now) {
  const bm = $('bigmap'), g = bm.getContext('2d');
  const s = Math.min((bm.height - 30 * dpr) / H, (bm.width * 0.45) / W);
  const ox = bm.width * 0.3 - (W * s) / 2, oy = 15 * dpr;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, bm.width, bm.height);
  g.setTransform(s, 0, 0, s, ox, oy);
  g.drawImage(mapBg, 0, 0, W, H);
  drawMapMarkers(g, now, 150);
  g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 2 / s; g.strokeRect(0, 0, W, H);
  // nama wilayah & tempat di samping peta
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineWidth = dpr;
  const lx = ox + W * s + 16 * dpr;
  for (const r of level.regions) {
    if (r.x0 != null) continue;
    const y = oy + ((r.y0 + r.y1) / 2) * s;
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.beginPath(); g.moveTo(ox + W * s, oy + r.y0 * s); g.lineTo(lx + 220 * dpr, oy + r.y0 * s); g.stroke();
    g.fillStyle = '#fde68a'; g.font = `bold ${15 * dpr}px sans-serif`; g.fillText(r.name, lx, y);
  }
  const pts = [
    ['Toko Luwes (oleh-oleh)', 250], ['Alun-alun Pancasila', 420], ['Dealer Mitsubishi Sun Star', 700], ['Bengkel Rakit Tingkir', 2550], ['Kumon Sukowati', 900], ['Hotel Laras Asri', 1680],
    ['Kec. Argomulyo (barat)', 3150], ['Sekolah Al-Irsyad', 7240],
    ['Gudang Ekspedisi (ambil trailer)', level.bays[0].y], ['Perumahan Puri Wahid (Mirage, Innova)', 2350],
    ['Rumah sopir', level.spawn.y + 60],
    ['SPBU Tingkir', level.places.find((p) => p.kind === 'pump').y], ['Gerbang Tol Tingkir (masuk tol)', 3640],
    ['Jalan Tol Semarang–Solo (sisi barat)', 5400], ['Gerbang Tol Boyolali (keluar)', 8010],
    ['Warung Klero', 4935], ['SPBU Tengaran', level.places.filter((p) => p.kind === 'pump')[2].y],
    ['Pasar Kembangsari', 6385], ['Pabrik (tujuan)', level.zones[0].y],
    ['Kopeng & Taman Wisata (barat laut, jalan menanjak)', 640], ['AMP aspal: dump truck & paver (barat)', 3200], ['Lahan kosong: bangun jalan (barat daya)', 5200],
  ];
  g.font = `${12 * dpr}px sans-serif`; g.fillStyle = '#e2e8f0';
  for (const [t, y] of pts) g.fillText('• ' + t, lx + 230 * dpr, oy + y * s);
  g.fillStyle = '#fff'; g.font = `bold ${18 * dpr}px sans-serif`;
  g.fillText('Peta Rute Salatiga → Tengaran', lx, oy + 6 * dpr);
  g.font = `${12 * dpr}px sans-serif`; g.fillStyle = '#cbd5e1';
  g.fillText('Jarak dipadatkan · Back / M untuk menutup', lx, oy + 26 * dpr);
}

/* ----------------------------- HUD --------------------------------------- */
function promptText() {
  if (state !== 'play') return '';
  if (TAXI_SERVICE) return TAXI_SERVICE.phase === 'pickup'
    ? `🚕 Taksi menuju lokasimu · ${TAXI_SERVICE.destination.label}`
    : `🚕 Dalam perjalanan ke ${TAXI_SERVICE.destination.label}`;
  if (FOOD_SERVICE) return `🛵 Kurir Delivery Food mengantar ${FOOD_SERVICE.foodItem.name}: ${Math.round(foodServiceDist() / PX_PER_M)} m`;
  if (taxiJob) {
    if (taxiJob.phase === 'pickup') return `🚕 Jemput ${taxiJob.passenger} di ${taxiJob.pickup.label} (${Math.round(Math.hypot(P.x - taxiJob.pickup.x, P.y - taxiJob.pickup.y) / PX_PER_M)} m) · Tekan C untuk batal`;
    return `🚕 Antar ${taxiJob.passenger} ke ${taxiJob.dest.label} (${Math.round(Math.hypot(P.x - taxiJob.dest.x, P.y - taxiJob.dest.y) / PX_PER_M)} m) · Ongkos ${rupiah(taxiJob.fare)}`;
  }
  if (foodJob) {
    if (foodJob.phase === 'pickup') return `📦 Ambil makanan di ${foodJob.pickup.name} (${Math.round(Math.hypot(P.x - foodJob.pickup.x, P.y - foodJob.pickup.y) / PX_PER_M)} m)`;
    return `🛵 Antar ${foodJob.item.name} ke ${foodJob.dest.label} (${Math.round(Math.hypot(P.x - foodJob.dest.x, P.y - foodJob.dest.y) / PX_PER_M)} m)`;
  }
  if (P.mode === 'inside') {
    if (P.busy) return P.busy;
    const z = nearZone();
    if (!z) return '';
    if (z.kind === 'kasir') return IN.menu ? menuText(IN.menu) : '';
    if (z.kind === 'masak') { const d = COOK[P.dish || 0]; return `🍳 Dapur · tahan A: masak ${d.name} (tenaga +${d.energy}, butuh ${d.bahan} porsi, bahan ${P.bahan || 0}) · X: ganti menu`; }
    if (z.kind === 'kulkas') return `🧊 Kulkas · bahan masak ${P.bahan || 0} porsi · beli di Pasar Kembangsari / Toko Luwes (tombol Y di kasir)`;
    if (z.kind === 'wudu') return 'Tahan A: Berwudu (tenaga pulih +12/detik)';
    if (z.kind === 'salat') return 'Area sholat menghadap barat (kiblat ←)';
    if (z.kind === 'inn') return `Resepsionis · A: Menginap 1 malam ${rupiah(450000)} (tenaga penuh, waktu maju)`;
    if (z.kind === 'les') return `Meja guru Kumon · A: Ikut les 1 sesi ${rupiah(60000)} (1 jam)`;
    if (z.kind === 'belajar') return '✏️ Papan tulis · A: Belajar membaca & berhitung (10 soal, ada suara)';
    if (z.kind === 'fmx_liquid') return '🧪 Meja Lab Robotika · A: Minigame Liquid Sorting (Gaji Rp 2.500.000)';
    if (z.kind === 'fmx_logic') return '⚡ Meja Otomasi & Logic Gate · A: Minigame Logic Diagram (Gaji Rp 3.000.000)';
    if (z.kind === 'tv') { const st = tvOf(P.house), chs = tvChannels(); return st.on && chs.length ? `📺 ${chs[st.ch % chs.length].name} · A: Matikan · X: channel lain · LB/RB: video lain · Y: layar lebar` : '📺 A: Nyalakan TV (YouTube edukasi)'; }
    if (z.kind === 'dealer' && level.dealer) {
      const D = level.dealer, car = D.stock[P.dealerPick || 0];
      return `🚗 ${car.name} ${rupiah(car.price)} · A: Tunai · X: Kredit DP ${rupiah(car.price * D.dp)} · LB/RB: model lain (${(P.dealerPick || 0) + 1}/${D.stock.length})`;
    }
    return z.kind === 'bed' ? (P.resting === 'bed' ? 'Tidur… zzz · tekan A: Bangun' : 'Tekan A: Tidur di kasur (tenaga naik cepat)')
      : z.kind === 'sofa' ? 'Tahan A: Duduk santai di sofa (tenaga naik)'
      : z.kind === 'seat' ? 'Tahan A: Duduk santai (tenaga naik)' : `A: Keluar dari ${P.house.label}`;
  }
  if (P.mode === 'drive') {
    const V = P.veh;
    if (isDumpTruck(V)) {
      if (V.loadT > 0) return `Memuat hotmix… ${Math.round(V.load * 100)}%`;
      if (V.tipT > 0) return 'Menuang hotmix ke hopper paver…';
      if (V.towing) return `${V.towing.name} ditarik · B: lepas derek`;
      if (inChute(V)) return V.load >= 0.99 ? 'Bak penuh — bawa ke paver' : `A: Muat hotmix ${rupiah(Math.round(AMPC().price * (1 - V.load) / 1000) * 1000)}`;
      if (V.load > 0.01) return nearPaverHopper(V) ? 'A: Angkat bak — tuang ke hopper paver' : `Muatan hotmix ${Math.round(V.load * 100)}% · mundur lurus ke hopper depan paver`;
      const towTarget = nearTowVehicle(V);
      if (towTarget) return `B: sambungkan ${towTarget.name} untuk diderek`;
      if (V.spec.canTowVehicle) return 'B: tarik kendaraan lain · isi hotmix di Silo AMP';
    }
    if (V.towing) return `${V.towing.name} ditarik · B: lepas derek`;
    if (V.spec.canTowVehicle) {
      const target = nearTowVehicle(V);
      return target ? `B: sambungkan ${target.name} untuk diderek` : 'B: tarik kendaraan lain';
    }
    if (V.type === 'tanker') {
      if (V.hoseTo) return `⛽ Mengisi ${V.hoseTo.name}: ${Math.round(V.hoseTo.fuel)}/${V.hoseTo.spec.tank} L · A: lepas selang`;
      if (Math.abs(V.v) < 4) return `A: Pasang selang ke kendaraan terdekat · Solar ${Math.round(V.cargo.Solar)} L · Pertalite ${Math.round(V.cargo.Pertalite)} L · Y: Turun`;
    }
    if (V.type === 'milling') {
      if (V.milling) return `🛠️ Mengupas aspal · ${((V.milledLen || 0) / PX_PER_M).toFixed(0)} m terkupas · upah ±${rupiah(Math.round((V.milledLen || 0) / PX_PER_M * millRate() / 1000) * 1000)} · A: berhenti & terima upah`;
      if (Math.abs(V.v) < 4) return 'A: Turunkan drum & kupas aspal jalan buatan (lahan kosong) · Y: Turun';
    }
    if (V.type === 'paver') {
      const m = Math.round(V.asphalt * AMPC().loadLen / PX_PER_M);
      if (V.paving) return `🛣️ Menggelar aspal · sisa ±${m} m · ${BUILT.cur ? (BUILT.cur.len / PX_PER_M).toFixed(0) : 0} m ruas ini · A: berhenti`;
      if (Math.abs(V.v) < 4) return V.asphalt > 0.005 ? `A: Turunkan screed & gelar aspal (±${m} m) · Y: Turun` : 'Hopper kosong — isi dari dump truck · Y: Turun';
    }
    if (SERVICE && SERVICE.target === V) return SERVICE.phase === 'fill' ? `⛽ Diisi mobil tangki: ${Math.round(V.fuel)}/${V.spec.tank} L — jangan bergerak` : `🚛 Mobil tangki menuju ke sini: ${Math.round(serviceDist() / PX_PER_M)} m`;
    if (isVTOL(V)) return 'Gerak: gas/rem + stik kiri atau W/S + A/D · Putar: D-pad kiri/kanan atau A/D · Terbang: Q/E atau D-pad atas/bawah · Y: turun';
    if (Math.abs(V.v) < 4) return `Y: Turun dari ${V.name}${V.fuel < V.spec.tank * 0.6 ? ' · tahan X / G: panggil mobil tangki BBM' : ''}${P.energy < 40 ? ' · U: pesan delivery food' : ''}${!taxiJob ? ' · C: order antar jemput penumpang' : ''}`;
    return '';
  }
  if (P.busy) return P.busy;
  const pl = nearPlace();
  if (pl) {
    if (pl.interior) {
      const extra = pl.kind === 'school' ? ' · zona sekolah maks 30 km/j pukul 06.30–14.00' : pl.kind === 'house' ? ' (istirahat di dalam)' : '';
      return `A: Masuk ${pl.label}${extra}`;
    }
    if (pl.kind === 'ronde') return clock >= 15 || clock < 1 ? `Wedang ronde · A: Wedang ronde ${rupiah(10000)} (+20) · X: Bakmi jawa ${rupiah(12000)} (+35)`
      : 'Gerobak wedang ronde (buka 15.00–01.00)';
    if (pl.kind === 'alun') return 'Alun-alun Pancasila · tahan A: duduk santai di bangku';
    if (pl.kind === 'wisata') return '🌲 Taman Wisata Kopeng · tahan A: duduk menikmati hutan pinus';
    if (pl.kind === 'airport') return '✈️ Bandara Perintis Salatiga · pesawat, helikopter, Su-57 & Falcon 9 tersedia — dekati lalu tekan Y untuk menerbangkan';
    if (pl.kind === 'amp') return `🏗️ Silo hotmix AMP — muat dump truck di sini (${rupiah(AMPC().price)} per truk)`;
    if (pl.kind === 'bengkel') return '🔧 A: Masuk mode rakit kendaraan (mesin, roda + sumbu, sasis, kabin, muatan)';
    if (pl.kind === 'pump') {
      const v = vehicleAtPump(pl);
      return v ? `Tahan A: Isi ${v.spec.fuelName} ${v.name} — ${rupiah(v.spec.price)}/L (${Math.round(v.fuel)}/${v.spec.tank} L)`
        : 'Parkir kendaraan di samping pompa untuk mengisi BBM';
    }
  }
  const v = nearVehicle();
  if (v) {
    if (P.carrying) return `A: Tuang jeriken ke ${v.name} · Y: Naik`;
    if (SERVICE && SERVICE.target === v) return SERVICE.phase === 'fill' ? `⛽ ${v.name} diisi mobil tangki: ${Math.round(v.fuel)}/${v.spec.tank} L` : `🚛 Mobil tangki menuju ${v.name}: ${Math.round(serviceDist() / PX_PER_M)} m`;
    if (hpOf(v) < 100) return `${v.wreck ? '💥 ' + v.name + ' hancur' : v.name + ' kondisi ' + Math.round(hpOf(v)) + '%'} · A: Panggil montir ${rupiah(repairCost(v))} · Y: Naik`;
    return `Y: Naik ${v.name}${v.fuel < v.spec.tank * 0.6 ? ` · X: panggil mobil tangki BBM (${v.spec.fuelName} ${Math.round(v.fuel)}/${v.spec.tank} L)` : ''}${P.energy < 40 ? ' · U: pesan delivery food' : ''}`;
  }
  return '';
}

function hud(dt, inp) {
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').classList.remove('show'); }
  if (bannerT > 0 && bannerT !== Infinity) { bannerT -= dt; if (bannerT <= 0) hideBanner(); }
  const driving = P.mode === 'drive';
  $('steerMark').style.left = `${50 + (driving ? inp.steer : 0) * 46}%`;
  $('thrBar').style.width = `${(driving ? inp.thr : 0) * 100}%`;
  $('brkBar').style.width = `${(driving ? inp.brk : 0) * 100}%`;
  hudT -= dt; if (hudT > 0) return; hudT = 0.1;

  const V = driving ? P.veh : null;
  $('time').textContent = `${(mission ? mission.t : 0).toFixed(1)} s`;
  const inside = P.mode === 'inside';
  $('speed').textContent = driving ? `${Math.round(Math.abs(V.v) / PX_PER_M * 3.6)} km/j` : P.mode === 'taxi' ? 'dalam taksi' : inside ? 'di dalam' : (P.run ? 'lari' : 'jalan');
  for (const el of document.querySelectorAll('#prnd span')) el.classList.toggle('on', !!V && el.dataset.g === V.gear);
  $('score').textContent = (results ? results.reduce((s, r) => s + r.score, 0) : 0) + (P.extraScore || 0);
  $('damage').textContent = damage || 0;
  $('vehName').textContent = driving ? V.name + (isDumpTruck(V) ? ` · bak ${Math.round(V.load * 100)}%` : V.type === 'milling' ? (V.milling ? ' · drum turun' : ' · drum naik') : V.type === 'paver' ? ` · hopper ${Math.round(V.asphalt * 100)}%` : V.type === 'tanker' ? ` · S ${Math.round(V.cargo.Solar)} P ${Math.round(V.cargo.Pertalite)} L` : '')
    + (V.slope > 0.03 ? ' ⛰️↑' : V.slope < -0.03 ? ' ⛰️↓' : '') : P.mode === 'taxi' ? 'Penumpang taksi' : inside ? `Di ${P.house.label}` : `Jalan kaki${P.carrying ? ' · bawa jeriken' : ''}`;
  { const wb = $('wiperBtn'); if (wb) { const has = !!V && !!Render3D.wiperCount && Render3D.wiperCount(V) > 0; wb.classList.toggle('hidden', !has); wb.classList.toggle('on', !!(V && V.wipOn)); } }
  const fv = V || (inside ? null : nearVehicle());
  if (fv) {
    const pct = fv.fuel / fv.spec.tank;
    $('fuelBar').style.width = `${pct * 100}%`;
    $('fuelBar').style.background = pct < 0.12 ? '#f87171' : pct < 0.3 ? '#fbbf24' : '#38bdf8';
    $('fuelText').textContent = `${fv.spec.fuelName} ${Math.round(fv.fuel)}/${fv.spec.tank} L`;
  } else { $('fuelBar').style.width = '0%'; $('fuelText').textContent = 'BBM –'; }
  if (fv) {
    const hp = hpOf(fv);
    $('hpBar').style.width = `${hp}%`;
    $('hpBar').style.background = fv.wreck ? '#6b7280' : hp < 35 ? '#f87171' : hp < 70 ? '#fbbf24' : '#4ade80';
    $('hpText').textContent = fv.wreck ? 'Kondisi: HANCUR' : `Kondisi ${Math.round(hp)}%`;
  } else { $('hpBar').style.width = '0%'; $('hpText').textContent = 'Kondisi –'; }
  $('energyBar').style.width = `${P.energy}%`;
  $('energyBar').style.background = P.energy < 20 ? '#f87171' : P.energy < 40 ? '#fbbf24' : '#a3e635';
  $('energyText').textContent = `Tenaga ${Math.round(P.energy)}`;
  $('money').textContent = rupiah(P.money);
  $('debt').textContent = P.debt > 0 ? `💳 utang ${rupiah(P.debt)}` : '';
  const nt = nightAmt();
  $('clock').textContent = `${nt > 0.5 ? '🌙' : clock < 7 || clock > 17 ? '🌅' : '☀️'} ${fmtClock(clock)}`;
  const f = camFocus(), rn = roadNameAt(f.x, f.y);
  $('loc').textContent = `📍 ${regionAt(f.x, f.y)}${rn ? ' · ' + rn : ''}`;
  const pr = promptText();
  $('prompt').textContent = pr; $('prompt').classList.toggle('show', !!pr);
  const ps = $('padStatus');
  if (activePad) { ps.textContent = `🎮 ${activePad.id.slice(0, 40)}`; ps.classList.add('on'); }
  else { ps.textContent = 'Gamepad belum terdeteksi — keyboard dan mouse tersedia'; ps.classList.remove('on'); }

  let hint = '';
  if (state === 'play' && mission) {
    const tr = mission.trailer;
    if (inside) hint = `${P.house.label}: ${IN.greet}. Pintu keluar di bawah — tekan A di dekat pintu.`;
    else if (!driving) hint = 'Jalan ke truk lalu tekan Y untuk naik. Mampir SPBU / warung / rumah bila BBM atau tenaga menipis.';
    else if (!V.spec.canTow) hint = `${V.name} tidak bisa menarik trailer — tukar ke Truk Biru / Truk Merah.`;
    else if (tr.state === 'hooked' && tr.owner !== V) hint = `${tr.id} masih tersambung ke ${tr.owner.name}.`;
    else if (V.hooked === tr && zoneFit(tr, mission.zone).inside) hint = 'Posisi pas! Berhenti, lalu tekan A untuk melepas trailer.';
    else if (V.gear === 'P') hint = 'Transmisi di P — tekan RB / D-pad ↓ untuk pindah ke R atau D.';
    else if (V.hooked === tr) hint = `Bawa ke ${mission.zone.id} (lihat minimap). Masuk R untuk memundurkan trailer ke kotak hijau.`;
    else {
      const [fx, fy] = fifthWheel(V);
      const d = Math.hypot(fx - tr.x, fy - tr.y);
      const ae = Math.abs(wrap(V.ang - tr.ang)) / DEG;
      hint = d < 70
        ? `Kingpin: ${(d / PX_PER_M).toFixed(1)} m · sudut ${ae.toFixed(0)}° — tekan A bila lingkaran hijau`
        : `Ke ${tr.bay.area} (Jl. Jend. Sudirman). Hadapkan truk searah garis kuning ${tr.id}, gigi R, mundur ke kingpin.`;
    }
  } else if (state === 'play') hint = 'Menunggu misi berikutnya…';
  $('hint').textContent = hint;
}


/* ----------------------------- Simpan / muat ----------------------------- */
// Keadaan disimpan ke localStorage tiap 2 detik & saat tab ditutup/di-refresh,
// plus cadangan ke server (saves.json) tiap 10 detik & lewat sendBeacon saat keluar.
const SAVE_KEY = 'trailerSave', SAVE_VER = 1;
let saveT = 0, remoteT = 0, pendingSave = null, saveLookup = 'pending';   // tombol A di menu menunggu pencarian simpanan selesai

function serialize() {
  const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    ver: SAVE_VER, level: level.name, savedAt: Date.now(), name: playerName,
    P: { mode: P.mode, veh: P.veh ? P.veh.id : null, x: r1(P.x), y: r1(P.y), ang: r3(P.ang), carrying: P.carrying,
      energy: r1(P.energy), money: Math.round(P.money),
      house: P.house ? P.house.id : null, ix: r1(P.ix), iy: r1(P.iy),
      debt: Math.round(P.debt || 0), extraScore: P.extraScore || 0, owned: P.owned || [], souvenir: P.souvenir || 0, kumon: P.kumon || 0, built: P.built || 0, tilang: P.tilang || 0, bahan: P.bahan ?? 4, learn: P.learn || null },
    clock: Math.round(clock * 1000) / 1000, view3d: MODE3D,
    vehicles: vehicles.map((v) => ({ id: v.id, x: r1(v.x), y: r1(v.y), ang: r3(v.ang), v: r1(v.v), steer: r3(v.steer),
      gear: v.gear, fuel: r1(v.fuel), hooked: v.hooked ? v.hooked.id : null, towing: v.towing ? v.towing.id : null, lowWarned: v.lowWarned, tollIn: v.tollIn || null,
      hp: Math.round(hpOf(v)), wreck: !!v.wreck, load: r3(v.load || 0), asphalt: r3(v.asphalt || 0), cargo: v.cargo || undefined })),
    trailers: trailers.map((t) => ({ id: t.id, x: r1(t.x), y: r1(t.y), ang: r3(t.ang), state: t.state, atBay: t.atBay })),
    npcs: npcs.filter((n) => !n.service).map((n) => ({ x: r1(n.x), y: r1(n.y), ang: r3(n.ang), v: r1(n.v), pi: n.pi, si: n.si })),
    mission: mission ? { no: mission.no, trailer: mission.trailer.id, zone: mission.zone.id, t: r1(mission.t), dmg: mission.dmg } : null,
    missionIdx, usedZones: [...usedZones], results, damage, elapsed: r1(elapsed), nextMissionT: r1(nextMissionT),
    zoom: cam.zoom, worldDX: level.worldDX || 0,
  };
}

function validSave(d) { return d && d.ver === SAVE_VER && d.level === level.name && Array.isArray(d.vehicles); }

function saveGame(remote = false, beacon = false) {
  if (!level || (state !== 'play' && state !== 'paused')) return;
  const d = serialize();
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(d)); } catch { /* penuh / diblokir */ }
  if (!remote) return;
  const body = JSON.stringify({ name: playerName, data: d });
  if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/save', new Blob([body], { type: 'application/json' }));
  else fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* abaikan */ }
  fetch(`/api/save?name=${encodeURIComponent(playerName)}`, { method: 'DELETE' }).catch(() => {});
  pendingSave = null;
}

// simpanan dari sebelum peta diperluas: semua koordinat x digeser sejauh worldDX
function migrateSave(d) {
  const dx = (level.worldDX || 0) - (d.worldDX || 0);
  if (!dx) return d;
  d = JSON.parse(JSON.stringify(d));
  d.P.x += dx;
  for (const v of d.vehicles) v.x += dx;
  for (const t of d.trailers) t.x += dx;
  for (const n of d.npcs || []) n.x += dx;
  d.worldDX = level.worldDX;
  return d;
}
function restoreGame(d) {
  d = migrateSave(d);
  if (SERVICE) endService();
  if (FOOD_SERVICE) endFoodService();
  foodJob = null;
  playerName = d.name || playerName;
  setupWorld();
  for (const def of (d.P.owned || [])) if (!vehicles.some((v) => v.id === def.id)) vehicles.push(makeVehicle(def));
  P.owned = d.P.owned || []; P.debt = d.P.debt || 0; P.extraScore = d.P.extraScore || 0; P.souvenir = d.P.souvenir || 0; P.kumon = d.P.kumon || 0; P.built = d.P.built || 0; P.tilang = d.P.tilang || 0; P.bahan = d.P.bahan ?? 4; P.cook = 0; P.cooking = false;
  P.learn = d.P.learn || { baca: 1, hitung: 1, stars: 0, sessions: 0 };
  clock = d.clock ?? level.clockStart ?? 7;
  if (d.view3d != null && d.view3d !== MODE3D) setView3D(!!d.view3d, true);
  const vById = Object.fromEntries(vehicles.map((v) => [v.id, v]));
  const tById = Object.fromEntries(trailers.map((t) => [t.id, t]));
  for (const st of d.trailers) {
    const t = tById[st.id]; if (!t) continue;
    Object.assign(t, { x: st.x, y: st.y, ang: st.ang, state: st.state, atBay: st.atBay, owner: null });
  }
  for (const sv of d.vehicles) {
    const v = vById[sv.id]; if (!v) continue;
    const fVal = (sv.fuel == null || isNaN(sv.fuel)) ? v.spec.tank : sv.fuel;
    Object.assign(v, { x: sv.x, y: sv.y, ang: sv.ang, v: sv.v, steer: sv.steer, gear: sv.gear,
      fuel: clamp(fVal, 0, v.spec.tank), lowWarned: !!sv.lowWarned, hooked: null, tollIn: sv.tollIn || null,
      hp: sv.hp ?? 100, wreck: !!sv.wreck, wreckT: sv.wreck ? 20 : 0, load: sv.load || 0, asphalt: sv.asphalt || 0 });
    if (sv.cargo && v.cargo) Object.assign(v.cargo, sv.cargo);
    if (sv.hooked && tById[sv.hooked]) { v.hooked = tById[sv.hooked]; v.hooked.owner = v; v.hooked.state = 'hooked'; }
  }
  for (const sv of d.vehicles) {
    const v = vById[sv.id], towed = sv.towing && vById[sv.towing];
    if (v && towed && v.spec.canTowVehicle && !towed.towedBy) { v.towing = towed; towed.towedBy = v; }
  }
  if (Array.isArray(d.npcs) && d.npcs.length === npcs.length) {
    d.npcs.forEach((sn, i) => Object.assign(npcs[i], { x: sn.x, y: sn.y, ang: sn.ang, v: sn.v, pi: sn.pi, si: sn.si }));
  }
  Object.assign(P, { mode: d.P.mode, veh: d.P.veh ? vById[d.P.veh] || null : null, x: d.P.x, y: d.P.y, ang: d.P.ang,
    carrying: d.P.carrying || 0, energy: d.P.energy, money: d.P.money });
  if (P.mode === 'drive' && !P.veh) P.mode = 'walk';
  if (P.mode === 'inside') {                       // simpanan saat sopir sedang di dalam rumah
    const pl = level.places.find((p) => p.id === d.P.house);
    if (pl) { setInterior(pl); Object.assign(P, { house: pl, ix: d.P.ix ?? IN.room.doorX, iy: d.P.iy ?? IN.room.h - 20, resting: null, sit: null }); }
    else P.mode = 'walk';
  }
  missionIdx = d.missionIdx; usedZones = new Set(d.usedZones || []); results = d.results || [];
  damage = d.damage || 0; elapsed = d.elapsed || 0; nextMissionT = d.nextMissionT || 0;
  mission = null;
  if (d.mission && tById[d.mission.trailer]) {
    const z = level.zones.find((zz) => zz.id === d.mission.zone);
    if (z) mission = { no: d.mission.no, trailer: tById[d.mission.trailer], zone: z, t: d.mission.t, dmg: d.mission.dmg };
  }
  if (!mission && nextMissionT <= 0 && missionIdx < MISSIONS) nextMissionT = 1;
  $('mNo').textContent = mission ? `${mission.no}/${MISSIONS}` : '–';
  $('mText').textContent = mission ? `${mission.trailer.id} → ${mission.zone.id}` : 'Misi selesai';
  cam.zoom = d.zoom ?? cam.zoom;
  const f = camFocus(); cam.x = f.x; cam.y = f.y;
  $('startScreen').classList.add('hidden'); $('nameInput').blur();
  hideBanner();
  state = 'paused';
  $('pauseScreen').classList.remove('hidden');
  showToast('Permainan dilanjutkan dari simpanan terakhir', 3);
}

function describeSave(d) {
  const when = new Date(d.savedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  const m = d.mission ? `Misi ${d.mission.no}/${MISSIONS}` : `${d.missionIdx}/${MISSIONS} misi selesai`;
  return `${escapeHtml(d.name)} · ${m} · ${rupiah(d.P.money)} · ${when}`;
}

async function findSave() {
  saveLookup = 'pending';
  let local = null;
  try { local = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { local = null; }
  if (!validSave(local)) local = null;
  let remote = null;
  const name = ($('nameInput').value || '').trim();
  if (name) {
    try {
      const res = await fetch(`/api/save?name=${encodeURIComponent(name)}`);
      if (res.ok) { const j = await res.json(); if (validSave(j.data)) remote = j.data; }
    } catch { /* server tidak terjangkau */ }
  }
  const best = [local, remote].filter(Boolean).sort((a, b) => b.savedAt - a.savedAt)[0] || null;
  pendingSave = best; saveLookup = 'done';
  $('resumeBox').classList.toggle('hidden', !best);
  $('startBtn').textContent = best ? 'Main baru' : 'Mulai';
  if (best) $('resumeInfo').innerHTML = describeSave(best);
}

addEventListener('pagehide', () => saveGame(true, true));
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveGame(true, true); });

/* ----------------------------- Loop -------------------------------------- */
function handleGlobal(inp, dt) {
  if (inp.orderFood && (state === 'play' || isFoodModalOpen())) {
    if (isFoodModalOpen()) closeFoodDelivery();
    else openFoodDelivery();
    inp.orderFood = false;
  }
  if (inp.taxiAction && state === 'play' && !isFoodModalOpen() && !isTaxiRideModalOpen()) {
    handleTaxiKeyAction();
    inp.taxiAction = false;
  }
  if (isFoodModalOpen()) {
    foodModalStep(inp, dt);
    return;
  }
  if (isTaxiRideModalOpen()) { taxiRideModalStep(inp); return; }
  if ((BUILD.open || LEARN.open || (typeof FMX !== 'undefined' && FMX.open)) && state === 'play') return;   // input dipakai layar rakit / belajar / formulatrix
  if ((inp.toggle3d || inp.view) && level) {             // tampilan kamera 3D: chase -> cabin -> top -> chase
    if (!MODE3D) setView3D(true);
    cam.view3d = cam.view3d === 'chase' ? 'cabin' : cam.view3d === 'cabin' ? 'top' : 'chase';
    cam.orbit = 0; cam.tilt = 0;
    const msg = cam.view3d === 'cabin' ? '🚘 Kamera Kabin / Kokpit (sisi dalam)' : cam.view3d === 'top' ? '🅿️ Tampak atas — mudah untuk parkir' : '🎥 Kamera mengikuti dari belakang';
    showToast(msg, 1.8);
  }
  camInput(inp, dt);
  if (inp.board) { const b = $('board'); if (b.classList.contains('hidden')) { loadBoard(); b.classList.remove('hidden'); } else b.classList.add('hidden'); }
  if (inp.back && state !== 'menu') { $('bigmapWrap').classList.toggle('hidden'); resize(); }
  if (inp.zoom) { cam.zoom = (cam.zoom + 1) % ZOOMS.length; showToast(`Zoom kamera ${cam.zoom + 1}/${ZOOMS.length}`, 1); }

  if (introActive) {                                   // preview intro: tombol apa pun melewati
    if (inp.a || inp.x || inp.y || inp.b || inp.start) endIntro();
    inp.a = inp.x = inp.y = inp.b = false; return;
  }
  if (state === 'menu' && pendingSave && (inp.a || inp.x)) {
    if (inp.a) restoreGame(pendingSave); else startGame();
    inp.a = false; inp.x = false; return;
  }
  if (state === 'menu' && inp.a && saveLookup !== 'done') { inp.a = false; return; }   // jangan menimpa simpanan sebelum pencarian selesai
  if ((state === 'menu' || state === 'done') && inp.a) { startGame(); inp.a = false; return; }
  if (state === 'paused' && inp.y) {
    resetMission(); state = 'play'; $('pauseScreen').classList.add('hidden'); inp.y = false; return;
  }
  if (inp.reset && state === 'play') resetMission();
  if (inp.start && (state === 'play' || state === 'paused')) {
    state = state === 'play' ? 'paused' : 'play';
    $('pauseScreen').classList.toggle('hidden', state !== 'paused');
    if (state === 'paused') { loadBoard(); $('board').classList.remove('hidden'); } else $('board').classList.add('hidden');
  }
}

/* ----------------------------- Intro sinematik (preview di awal) ----------------
 * Kamera terbang di dunia 3D asli: rumah sopir -> terminal bus -> gudang -> jalan raya -> Kopeng -> bandara.
 * Lewati: klik / Enter / Spasi / A / Esc. Putar ulang: tombol di layar awal. */
const INTRO_DIP = 0.45, INTRO_TITLE_T = 4.6, INTRO_OUTRO = 2.8;
let introActive = false, introT = 0, introShot = -1;
const introPaths = {};
const ezi = (u) => u * u * (3 - 2 * u);
const mix3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const gp = (x, z, h) => [x, (Render3D.TH ? Render3D.TH(x, z) : 0) + h, z];     // titik dunia: x, tinggi di atas tanah, z
function roadPath(id) {
  if (introPaths[id]) return introPaths[id];
  const r = level.roads.find((q) => q.id === id); if (!r) return null;
  const cum = [0]; for (let i = 1; i < r.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]));
  return (introPaths[id] = { p: r.pts, cum, total: cum[cum.length - 1] });
}
function roadAt(pa, s) {
  s = clamp(s, 0, pa.total); let i = 1; while (i < pa.cum.length - 1 && pa.cum[i] < s) i++;
  const t = (s - pa.cum[i - 1]) / ((pa.cum[i] - pa.cum[i - 1]) || 1);
  return [pa.p[i - 1][0] + (pa.p[i][0] - pa.p[i - 1][0]) * t, pa.p[i - 1][1] + (pa.p[i][1] - pa.p[i - 1][1]) * t];
}
// terbang menyusuri jalan: mulai di titik pertama yang memenuhi `from`, sepanjang `len`
function followShot(id, from, len, back, ahead, up, fov) {
  return (u) => {
    const pa = roadPath(id); if (!pa) return null;
    const i0 = Math.max(0, pa.p.findIndex(from)), s = pa.cum[i0] + len * u;
    const a = roadAt(pa, s - back), b = roadAt(pa, s + ahead);
    return { pos: gp(a[0], a[1], up), tgt: gp(b[0], b[1], 4), fov };
  };
}
const INTRO_SHOTS = [
  { dur: 5.8, cap: '🏠 Pagi di Tingkir — sopir bersiap berangkat',
    cam: (u) => { const e = ezi(u); return { pos: mix3(gp(6330, 2760, 38), gp(6820, 2700, 115), e), tgt: mix3(gp(6593, 2455, 28), gp(6593, 2440, 40), e), fov: 54 }; } },
  { dur: 5.2, cap: '🚌 Terminal Bus Tingkir — kendarai bus, truk, sedan, sampai pesawat',
    cam: (u) => { const e = ezi(u); return { pos: mix3(gp(7440, 3030, 26), gp(7770, 3010, 58), e), tgt: mix3(gp(7620, 2880, 14), gp(7640, 2880, 18), e), fov: 56 }; } },
  { dur: 5.2, cap: '📦 Gudang Ekspedisi Salatiga — ambil trailer oranye',
    cam: (u) => { const e = ezi(u); return { pos: mix3(gp(7800, 1000, 220), gp(7790, 1850, 170), e), tgt: gp(8040, 1450, 6), fov: 58 }; } },
  { dur: 6.0, cap: '🛣️ Jalan raya Salatiga–Solo — antar ke kawasan industri Tengaran',
    cam: followShot('main', (p) => p[1] > 2900, 1600, 140, 300, 75, 62) },
  { dur: 6.0, cap: '⛰️ Tanjakan Kopeng — jalan berkelok, AMP aspal, bangun jalan sendiri',
    cam: followShot('kopeng', (p) => p[0] < 4300, 1900, 160, 320, 110, 60) },
  { dur: 5.2, cap: '✈️ Bandara Perintis Salatiga — pesawat & helikopter menunggu',
    cam: (u) => { const a = -0.9 + 1.6 * ezi(u); return { pos: gp(1380 + Math.cos(a) * 520, 5200 + Math.sin(a) * 520, 190), tgt: gp(1380, 5180, 10), fov: 56 }; } },
];
const INTRO_TOTAL = INTRO_SHOTS.reduce((a, b) => a + b.dur, 0);
// titik layar menggelap sebentar: awal, antar adegan, dan akhir (tanpa gelap saat masuk outro)
const INTRO_EDGES = (() => { const e = [0]; let a = 0; for (let k = 0; k < INTRO_SHOTS.length - 1; k++) { a += INTRO_SHOTS[k].dur; e.push(a); } e.push(INTRO_TOTAL + INTRO_OUTRO); return e; })();
function introPos() {                                   // { i: nomor shot, u: 0..1, outro }
  let t = introT; for (let i = 0; i < INTRO_SHOTS.length; i++) { if (t < INTRO_SHOTS[i].dur) return { i, u: t / INTRO_SHOTS[i].dur }; t -= INTRO_SHOTS[i].dur; }
  return { i: INTRO_SHOTS.length - 1, u: 1, outro: true };
}
function introCamAt() {
  const ps = introPos(), c = INTRO_SHOTS[ps.i].cam(ps.u);
  return c || { pos: gp(6593, 300, 300), tgt: gp(6593, 2500, 0), fov: 50 };
}
function startIntro() {
  window.__introRan = true; introActive = true; introT = 0; introShot = -1;
  document.body.classList.add('intro-on'); $('intro').classList.remove('hidden');
  $('introDots').innerHTML = INTRO_SHOTS.map(() => '<i></i>').join('');
  $('introCap').textContent = ''; $('introCap').classList.remove('on');
}
function endIntro() {
  if (!introActive) return;
  introActive = false; document.body.classList.remove('intro-on'); $('intro').classList.add('hidden');
  const ss = $('startScreen'); ss.classList.remove('reveal'); void ss.offsetWidth; ss.classList.add('reveal');
}
function introTick(dt) {
  if (!introActive) return;
  introT += dt;
  if (introT >= INTRO_TOTAL + INTRO_OUTRO) { endIntro(); return; }
  const ps = introPos();
  if (ps.i !== introShot) {                              // ganti teks pengantar & titik indikator
    introShot = ps.i; const cap = $('introCap'); cap.textContent = INTRO_SHOTS[ps.i].cap; cap.classList.remove('on'); void cap.offsetWidth; cap.classList.add('on');
    [...$('introDots').children].forEach((d, k) => d.classList.toggle('on', k <= ps.i));
  }
  const title = introT < INTRO_TITLE_T || ps.outro;
  $('introTitleBox').classList.toggle('show', title); $('introCap').style.visibility = title ? 'hidden' : 'visible';
  const d = Math.min(...INTRO_EDGES.map((e) => Math.abs(introT - e)));
  $('introFade').style.opacity = String(clamp(1 - d / INTRO_DIP, 0, 1));
}

/* ----------------------------- Wiper kaca depan ------------------------------------------------
 * X (atau klik 🧹 di panel kendaraan) menyalakan / mematikan wiper kendaraan yang sedang dikendarai.
 * Fase sapuan disimpan di V.wipPh; render3d membaca V.wipU (0 = posisi parkir ... 1 = sapuan penuh).
 * Mobil, bus, truk box, MAN HX, dan kendaraan buatan editor CAD yang punya part "Wiper Kaca" bisa memakainya. */
let wiperRequest = false;
const WIPER_W = Math.PI * 2 * 0.85;                       // ~0,85 sapuan per detik
function toggleWipers() {
  const V = P.mode === 'drive' ? P.veh : null;
  if (!V) { showToast('🧹 Naik kendaraan dulu untuk menyalakan wiper', 1.8); return; }
  if (!Render3D.wiperCount || !Render3D.wiperCount(V)) { showToast('🧹 Kendaraan ini tidak punya wiper', 2); return; }
  V.wipOn = !V.wipOn;
  tone(V.wipOn ? 620 : 420, 0.06, 0.04, 'triangle');
  showToast(V.wipOn ? '🧹 Wiper menyala' : '🧹 Wiper mati', 1.4);
}
function updateWipers(dt) {
  if (wiperRequest) { wiperRequest = false; if (state === 'play') toggleWipers(); }
  const drv = P.mode === 'drive' ? P.veh : null, TAU = Math.PI * 2, step = state === 'play' ? WIPER_W * dt : 0;
  for (const V of vehicles) {
    if (V.wipOn && V !== drv) V.wipOn = false;              // ditinggal pengemudi: selesaikan sapuan lalu berhenti di posisi parkir
    if (!V.wipOn && !V.wipPh) continue;
    if (V.wipOn) V.wipPh = ((V.wipPh || 0) + step) % TAU || 1e-6;
    else { V.wipPh += step; if (V.wipPh >= TAU) V.wipPh = 0; }
    V.wipU = V.wipPh ? 0.5 - 0.5 * Math.cos(V.wipPh) : 0;
  }
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const inp = readInput();
  handleGlobal(inp, dt);
  update(dt, inp);
  if (state === 'play' || state === 'paused') {
    saveT -= dt; remoteT -= dt;
    if (saveT <= 0) { saveT = 2; saveGame(remoteT <= 0); if (remoteT <= 0) remoteT = 10; }
  }
  introTick(dt);
  updateWipers(dt);
  updateCamera(dt);
  render(now);
  drawMinimap(now);
  if (!$('bigmapWrap').classList.contains('hidden')) drawBigMap(now);
  hud(dt, inp);
  drawDockPanel(dt);
  tvUpdate();
  requestAnimationFrame(loop);
}

addEventListener('gamepadconnected', (e) => showToast(`Gamepad terhubung: ${e.gamepad.id.slice(0, 40)}`, 3));
addEventListener('gamepaddisconnected', () => showToast('Gamepad terputus', 3));
$('startBtn').addEventListener('click', startGame);
$('intro').addEventListener('click', () => endIntro());
$('replayIntro').addEventListener('click', () => { if (state === 'menu') startIntro(); });
$('bBuild').addEventListener('click', () => buildVehicle());
$('bClose').addEventListener('click', () => closeBuilder());
$('lClose').addEventListener('click', () => closeLearn());
if ($('fmxClose')) $('fmxClose').addEventListener('click', () => closeFmx());
if ($('fmxBody')) {
  $('fmxBody').addEventListener('click', (e) => {
    if (typeof FMX === 'undefined' || !FMX.open) return;
    audio();
    if (FMX.mode === 'liquid') {
      const wrap = e.target.closest('.fmx-tube-wrap');
      if (wrap && wrap.dataset.idx != null) {
        const idx = +wrap.dataset.idx;
        if (FMX.selectedTube === -1) {
          if (FMX.tubes[idx].length > 0) {
            FMX.selectedTube = idx;
            FMX.sel = idx;
            tone(500, 0.05, 0.04, 'sine');
          }
        } else {
          transferLiquid(FMX.selectedTube, idx);
          FMX.selectedTube = -1;
          FMX.sel = idx;
        }
        renderFmx();
      }
    } else if (FMX.mode === 'logic') {
      const blk = e.target.closest('.fmx-gate-block');
      if (blk && blk.dataset.switch != null) {
        const sw = +blk.dataset.switch;
        FMX.logicProblem.inputs[sw] = 1 - FMX.logicProblem.inputs[sw];
        FMX.sel = sw;
        tone(600, 0.05, 0.04, 'triangle');
        renderFmx();
      }
      if (e.target.id === 'fmxSubmitLogic') {
        const { finalOut } = evalCurrentLogic();
        if (finalOut === FMX.logicProblem.target && !FMX.won) {
          FMX.won = true;
          onFmxJobSuccess('Sirkuit Otomasi Logic Gate Berhasil Terverifikasi!');
          renderFmx();
        } else {
          tone(220, 0.12, 0.05, 'sawtooth');
        }
      }
    }
  });
}
$('lBody').addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t || !LEARN.open) return;
  audio();
  if (t.dataset.s) startSession(t.dataset.s);
  else if (t.dataset.i != null && LEARN.phase === 'q') answer(+t.dataset.i);
  else if (t.dataset.e != null) { if (t.dataset.e === '0') { LEARN.phase = 'menu'; LEARN.sel = 0; renderLearn(); } else closeLearn(); }
});
$('lSay').addEventListener('click', () => { if (LEARN.q && LEARN.phase !== 'menu') eduSay(LEARN.q.say); });
$('tvPip').addEventListener('click', () => { if (tvOnHere()) tvNext(P.house); });
$('bSlots').addEventListener('click', (e) => {
  const el = e.target.closest('.bslot'); if (!el) return;
  const i = +el.dataset.i, rect = el.getBoundingClientRect();
  if (i === BUILD.slot) cyclePart(SLOTS[i][0], e.clientX > rect.left + rect.width / 2 ? 1 : -1);
  else { BUILD.slot = i; renderBuilder(); }
});
$('resumeBtn').addEventListener('click', () => { audio(); if (pendingSave) restoreGame(pendingSave); });
$('nameInput').addEventListener('change', () => { if (state === 'menu') findSave(); });
try { $('nameInput').value = localStorage.getItem('trailerName') || ''; } catch { /* abaikan */ }

$('fClose').addEventListener('click', closeFoodDelivery);
if ($('energyRow')) $('energyRow').addEventListener('click', openFoodDelivery);
if ($('wiperBtn')) $('wiperBtn').addEventListener('click', (e) => { e.stopPropagation(); wiperRequest = true; });
if ($('foodQuickBtn')) $('foodQuickBtn').addEventListener('click', (e) => { e.stopPropagation(); openFoodDelivery(); });
if ($('taxiQuickBtn')) $('taxiQuickBtn').addEventListener('click', (e) => { e.stopPropagation(); openTaxiRide(); });
if ($('taxiRideClose')) $('taxiRideClose').addEventListener('click', closeTaxiRide);
if ($('taxiDestination')) $('taxiDestination').addEventListener('change', updateTaxiRideQuote);
if ($('taxiBookBtn')) $('taxiBookBtn').addEventListener('click', bookTaxiRide);
$('fTabOrder').addEventListener('click', () => { foodActiveTab = 'order'; updateFoodModalUI(); });
$('fTabJob').addEventListener('click', () => { foodActiveTab = 'job'; updateFoodModalUI(); });
$('fOrder').addEventListener('click', () => orderFoodDelivery(FOOD_MENU[foodDeliveryPick]));
$('fJobAccept').addEventListener('click', () => acceptFoodJob());
$('fJobCancel').addEventListener('click', () => cancelFoodJob());
$('fList').addEventListener('click', (e) => {
  const itemEl = e.target.closest('.fitem');
  if (itemEl && itemEl.dataset.i != null) {
    foodDeliveryPick = +itemEl.dataset.i;
    tone(350, 0.04, 0.03, 'sine');
    updateFoodModalUI();
  }
});

const JS_VERSION = '2026.11.14-underpass-towing-b';
function versionCheck(l) {
  const probs = [];
  if (l.version !== JS_VERSION || (window.GAME_VERSION && window.GAME_VERSION !== JS_VERSION)) {
    probs.push(`Server menjalankan versi <b>${escapeHtml(l.version || 'lama')}</b>, sedangkan file game versi <b>${JS_VERSION}</b>.`);
  }
  if (!(l.signals && l.signals.length)) probs.push('Data lampu lalu lintas tidak ada di peta dari server.');
  if (!l.bengkel) probs.push('Data Bengkel Rakit tidak ada di peta dari server.');
  $('nSig').textContent = (l.signals || []).length;
  if (!probs.length) { console.info('Trailer Salatiga–Tengaran', JS_VERSION, '·', l.signals.length, 'lampu lalu lintas · bengkel OK'); return; }
  const el = $('verWarn');
  el.innerHTML = `⚠️ <b>Server lama masih berjalan.</b> ${probs.join(' ')}<br>Cara memperbaiki: tutup semua jendela terminal yang menjalankan
    <code>python app.py</code> (atau tekan Ctrl+C), pastikan isi zip terbaru sudah menimpa folder <code>trailer_game</code> yang sama,
    jalankan lagi <code>python app.py</code> dari folder itu, lalu tekan <b>Ctrl+F5</b> di browser.`;
  el.classList.remove('hidden');
  console.warn('Versi tidak cocok', l.version, JS_VERSION);
}
fetch('/api/level').then((r) => r.json()).then((l) => {
  versionCheck(l);
  level = l; W = l.world.w; H = l.world.h;
  OBS = l.obstacles.map((o) => ({ o, poly: [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]],
    x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h }));
  for (const r of l.roads) {
    const b = polyBB(r.pts);
    r.bb = { x: b.x0 - r.w / 2, y: b.y0 - r.w / 2, w: b.x1 - b.x0 + r.w, h: b.y1 - b.y0 + r.w };
  }
  l.roadBumps = buildRoadBumps(l.roads);
  for (const d of l.decor) if (d.pts) { const b = polyBB(d.pts); d.bb = { x0: b.x0 - d.w, y0: b.y0 - d.w, x1: b.x1 + d.w, y1: b.y1 + d.w }; }
  MAIN = l.roads.find((r) => r.kind === 'main');
  initSignals();
  DISPLAY = (l.displayCars || []).map((c) => {
    const st = (l.dealer && l.dealer.stock.find((k) => k.model === c.model)) || {};
    return Object.assign(makeVehicle({ type: 'car', ...c, ...(st.spec || {}) }, true), { display: true });
  });
  buildPatterns();
  buildRoadLabels();
  setupWorld();
  resize();
  mapBg = buildMinimap();
  setView3D(true, true);
  fetch('/api/settings').then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }).then((st) => {
    SETTINGS = st || {};
    setBuiltRoads(st.builtRoads);
    applySuspensionSettings(st.suspension);
  }).catch((err) => console.error('Gagal memuat pengaturan game:', err));
  state = 'menu';
  loadBoard();
  findSave();
  startIntro();
  requestAnimationFrame(loop);
});
