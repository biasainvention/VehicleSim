'use strict';
/* =========================================================================
 * Formulatrix Minigames — Liquid Sorting & Logic Diagram Game
 * PT Formulatrix Indonesia (Robotics & Lab Automation)
 * Mini game edukatif & simulasi kerja automation dengan gaji jutaan rupiah!
 * ========================================================================= */

const FMX = {
  open: false,
  mode: 'liquid', // 'liquid' | 'logic'
  selectedTube: -1,
  tubes: [],
  logicProblem: null,
  salary: 0,
  score: 0,
  won: false,
  sel: 0,
  lastX: 0,
  lastY: 0
};

// Warna-warna reagen kimia/enzim untuk Liquid Sorting
const REAGENT_COLORS = [
  { name: 'Buffer Red', col: '#ef4444' },
  { name: 'Enzyme Blue', col: '#3b82f6' },
  { name: 'Protein Yellow', col: '#eab308' },
  { name: 'Reagent Green', col: '#10b981' }
];

function initLiquidGame() {
  FMX.mode = 'liquid';
  FMX.salary = 2500000; // Gaji Rp 2.500.000
  FMX.score = 500;
  FMX.selectedTube = -1;
  FMX.won = false;
  FMX.sel = 0;

  // 4 tabung: 3 tabung berisi campuran warna (kapasitas 3), 1 tabung kosong sebagai buffer
  const pool = [0, 0, 0, 1, 1, 1, 2, 2, 2];
  // Acak pool
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  FMX.tubes = [
    pool.slice(0, 3),
    pool.slice(3, 6),
    pool.slice(6, 9),
    [] // tabung kosong ke-4
  ];
}

function checkLiquidWin() {
  let completeTubes = 0;
  for (const tube of FMX.tubes) {
    if (tube.length === 0) continue;
    if (tube.length === 3 && tube.every(c => c === tube[0])) {
      completeTubes++;
    } else {
      return false;
    }
  }
  return completeTubes === 3;
}

function transferLiquid(fromIdx, toIdx) {
  if (fromIdx === toIdx) return;
  const fromTube = FMX.tubes[fromIdx];
  const toTube = FMX.tubes[toIdx];

  if (!fromTube || fromTube.length === 0) return;
  if (toTube.length >= 3) {
    tone(200, 0.1, 0.05, 'sawtooth');
    return;
  }

  const topColor = fromTube[fromTube.length - 1];
  if (toTube.length > 0 && toTube[toTube.length - 1] !== topColor) {
    tone(220, 0.12, 0.05, 'sawtooth');
    return;
  }

  // Tuang 1 unit liquid yang sama
  fromTube.pop();
  toTube.push(topColor);
  tone(550, 0.08, 0.04, 'sine');

  if (checkLiquidWin()) {
    FMX.won = true;
    onFmxJobSuccess('Liquid Dispenser Sorting Berhasil Diselesaikan!');
  }
}

// --- Logic Gate Diagram Game (Updated: Input Kiri, Output Kanan, Random Gates, Multiple Outputs) ---
function initLogicGame() {
  FMX.mode = 'logic';
  FMX.salary = 3000000; // Gaji Rp 3.000.000
  FMX.score = 650;
  FMX.won = false;
  FMX.sel = 0;

  const ops = ['AND', 'OR', 'XOR'];
  // Acak kombinasi 4 gerbang logika setiap mulai
  const gates = [pick(ops), pick(ops), pick(ops), pick(ops)];
  
  // Target acak untuk 2 buah output
  const target1 = Math.random() < 0.5 ? 1 : 0;
  const target2 = Math.random() < 0.5 ? 1 : 0;

  FMX.logicProblem = {
    inputs: [0, 0, 0, 0], // 4 Input Sensor: A, B, C, D
    gates,                // [Gate1, Gate2, Gate3, Gate4]
    targets: [target1, target2],
    description: `Atur sensor [A, B, C, D] agar Out 1 = ${target1 ? 'HIGH (1)' : 'LOW (0)'} dan Out 2 = ${target2 ? 'HIGH (1)' : 'LOW (0)'}`
  };
}

function evalGate(op, in1, in2) {
  if (op === 'AND') return (in1 && in2) ? 1 : 0;
  if (op === 'OR') return (in1 || in2) ? 1 : 0;
  if (op === 'XOR') return (in1 !== in2) ? 1 : 0;
  return 0;
}

function evalCurrentLogic() {
  const p = FMX.logicProblem;
  const [A, B, C, D] = p.inputs;
  const [g1, g2, g3, g4] = p.gates;

  // Layer 1 Gates
  const out1 = evalGate(g1, A, B);
  const out2 = evalGate(g2, C, D);

  // Layer 2 Gates (Multiple Outputs)
  const finalOut1 = evalGate(g3, out1, out2);
  const finalOut2 = evalGate(g4, out1, D);

  return { out1, out2, finalOut1, finalOut2 };
}

function onFmxJobSuccess(msg) {
  tone(523, 0.1, 0.05); tone(659, 0.1, 0.05, 'triangle', 0.08); tone(784, 0.15, 0.05, 'triangle', 0.16); tone(1046, 0.25, 0.06, 'triangle', 0.24);
  if (typeof coin === 'function') coin();
  if (typeof rumble === 'function') rumble(0.5, 250);
  
  P.money += FMX.salary;
  P.extraScore = (P.extraScore || 0) + FMX.score;
  
  showBanner(`🏆 <b>KERJA SELESAI DI FORMULATRIX!</b><br>${msg}<br><small>Gaji Diterima: <b>${rupiah(FMX.salary)}</b> · Bonus Skor: <b>+${FMX.score} pts</b></small>`, 5);
}

function openFmxLiquid() {
  initLiquidGame();
  FMX.open = true;
  $('fmxModal').classList.remove('hidden');
  renderFmx();
  tone(440, 0.1, 0.04, 'triangle');
}

function openFmxLogic() {
  initLogicGame();
  FMX.open = true;
  $('fmxModal').classList.remove('hidden');
  renderFmx();
  tone(440, 0.1, 0.04, 'triangle');
}

function closeFmx() {
  FMX.open = false;
  $('fmxModal').classList.add('hidden');
}

function renderFmx() {
  const title = $('fmxTitle');
  const body = $('fmxBody');
  const salaryBadge = $('fmxSalaryBadge');

  if (salaryBadge) salaryBadge.textContent = `Gaji: ${rupiah(FMX.salary)}`;

  if (FMX.mode === 'liquid') {
    title.innerHTML = '🧪 PT Formulatrix Indonesia — Robot Liquid Handling Sorting';
    
    let tubesHtml = '';
    for (let i = 0; i < FMX.tubes.length; i++) {
      const tube = FMX.tubes[i];
      const isSelected = FMX.selectedTube === i;
      const isCursor = FMX.sel === i;
      
      let layersHtml = '';
      for (let l = 2; l >= 0; l--) {
        if (l < tube.length) {
          const colorObj = REAGENT_COLORS[tube[l]] || { col: '#94a3b8', name: 'Unknown' };
          layersHtml += `<div class="fmx-liquid-layer" style="background:${colorObj.col};" title="${colorObj.name}"></div>`;
        } else {
          layersHtml += `<div class="fmx-liquid-layer empty"></div>`;
        }
      }

      tubesHtml += `
        <div class="fmx-tube-wrap ${isCursor ? 'cursor' : ''} ${isSelected ? 'selected' : ''}" data-idx="${i}">
          <div class="fmx-tube-label">Tabung #${i + 1} ${isSelected ? '(Terpilih)' : ''}</div>
          <div class="fmx-tube">
            ${layersHtml}
          </div>
        </div>
      `;
    }

    body.innerHTML = `
      <div class="fmx-intro">
        <b>Misi Teknisi Laboratorium:</b> Pisahkan cairan reagen kimia otomatis ke tabung yang homogen (warna seragam).
        <br><small>Pilih tabung asal lalu pilih tabung tujuan untuk memindahkan cairan atas. Hanya bisa menuang jika warna cairan atas sama atau ke tabung kosong!</small>
      </div>
      <div class="fmx-tubes-container">
        ${tubesHtml}
      </div>
      ${FMX.won ? `<div class="fmx-success-box">🎉 SEMUA REAGEN TERPISAH SEMPURNA! Gaji ${rupiah(FMX.salary)} telah ditransfer ke rekeningmu.</div>` : ''}
    `;
  } else {
    title.innerHTML = '⚡ PT Formulatrix Indonesia — Multi-Output Logic Gate Automation';
    const p = FMX.logicProblem;
    const { finalOut1, finalOut2 } = evalCurrentLogic();
    const isTargetMet = (finalOut1 === p.targets[0] && finalOut2 === p.targets[1]);

    let inputsHtml = '';
    const sensorNames = ['Sensor A', 'Sensor B', 'Sensor C', 'Sensor D'];
    for (let i = 0; i < 4; i++) {
      const isCursor = FMX.sel === i;
      inputsHtml += `
        <div class="fmx-gate-block ${isCursor ? 'cursor' : ''}" data-switch="${i}" style="margin-bottom: 8px;">
          <span class="fmx-lbl">${sensorNames[i]}</span>
          <button class="fmx-sw-btn ${p.inputs[i] ? 'high' : 'low'}">${p.inputs[i] ? 'HIGH (1)' : 'LOW (0)'}</button>
        </div>
      `;
    }

    body.innerHTML = `
      <div class="fmx-intro">
        <b>Tugas Otomasi Multi-Output Robot:</b> Konfigurasi sensor input di kiri agar kedua jalur output di kanan sesuai dengan target sistem!
        <br><small>${p.description}</small>
      </div>
      
      <div class="fmx-circuit-board">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
          <!-- Kolom Input (Kiri) -->
          <div style="display: flex; flex-direction: column; width: 140px;">
            ${inputsHtml}
          </div>

          <!-- Kolom Diagram SVG (Tengah) -->
          <div class="fmx-diagram-svg-wrap" style="flex: 1; overflow-x: auto;">
            <svg viewBox="0 0 460 200" class="fmx-circuit-svg" style="width: 100%; height: 180px;">
              <!-- Jalur Input ke Layer 1 -->
              <path d="M 10 20 L 60 20" stroke="${p.inputs[0] ? '#22c55e' : '#38bdf8'}" stroke-width="3" fill="none" />
              <path d="M 10 70 L 60 70" stroke="${p.inputs[1] ? '#22c55e' : '#38bdf8'}" stroke-width="3" fill="none" />
              <path d="M 10 130 L 60 130" stroke="${p.inputs[2] ? '#22c55e' : '#38bdf8'}" stroke-width="3" fill="none" />
              <path d="M 10 180 L 60 180" stroke="${p.inputs[3] ? '#22c55e' : '#38bdf8'}" stroke-width="3" fill="none" />

              <!-- Gate Layer 1 (X = 60 to 120) -->
              <rect x="60" y="35" width="60" height="40" rx="6" fill="#1e293b" stroke="#0ea5e9" stroke-width="2" />
              <text x="90" y="60" fill="#f8fafc" font-size="12" font-weight="bold" text-anchor="middle">${p.gates[0]}</text>

              <rect x="60" y="135" width="60" height="40" rx="6" fill="#1e293b" stroke="#0ea5e9" stroke-width="2" />
              <text x="90" y="160" fill="#f8fafc" font-size="12" font-weight="bold" text-anchor="middle">${p.gates[1]}</text>

              <!-- Jalur dari Layer 1 ke Layer 2 -->
              <path d="M 120 55 L 180 55" stroke="#64748b" stroke-width="3" fill="none" />
              <path d="M 120 155 L 180 155" stroke="#64748b" stroke-width="3" fill="none" />

              <!-- Gate Layer 2 (X = 180 to 240) -->
              <rect x="180" y="35" width="60" height="40" rx="6" fill="#1e293b" stroke="#0ea5e9" stroke-width="2" />
              <text x="210" y="60" fill="#f8fafc" font-size="12" font-weight="bold" text-anchor="middle">${p.gates[2]}</text>

              <rect x="180" y="115" width="60" height="40" rx="6" fill="#1e293b" stroke="#0ea5e9" stroke-width="2" />
              <text x="210" y="140" fill="#f8fafc" font-size="12" font-weight="bold" text-anchor="middle">${p.gates[3]}</text>

              <!-- Cross wire -->
              <path d="M 150 55 L 150 100 L 180 100" stroke="#64748b" stroke-width="2" fill="none" />

              <!-- Jalur ke Output Kanan -->
              <path d="M 240 55 L 340 55" stroke="${finalOut1 ? '#22c55e' : '#ef4444'}" stroke-width="3" fill="none" />
              <circle cx="345" cy="55" r="6" fill="${finalOut1 ? '#22c55e' : '#ef4444'}" />

              <path d="M 240 135 L 340 135" stroke="${finalOut2 ? '#22c55e' : '#ef4444'}" stroke-width="3" fill="none" />
              <circle cx="345" cy="135" r="6" fill="${finalOut2 ? '#22c55e' : '#ef4444'}" />
            </svg>
          </div>

          <!-- Kolom Output (Kanan) -->
          <div style="display: flex; flex-direction: column; width: 130px; gap: 20px; font-size: 12px; color: #f8fafc;">
            <div style="background: #0f172a; padding: 8px; border-radius: 6px; border: 1px solid ${finalOut1 === p.targets[0] ? '#22c55e' : '#ef4444'};">
              <b>Output 1:</b> ${finalOut1 ? '1 (HIGH)' : '0 (LOW)'}<br>
              <small style="color: #94a3b8;">Target: ${p.targets[0]}</small>
            </div>
            <div style="background: #0f172a; padding: 8px; border-radius: 6px; border: 1px solid ${finalOut2 === p.targets[1] ? '#22c55e' : '#ef4444'};">
              <b>Output 2:</b> ${finalOut2 ? '1 (HIGH)' : '0 (LOW)'}<br>
              <small style="color: #94a3b8;">Target: ${p.targets[1]}</small>
            </div>
          </div>
        </div>

        <div class="fmx-output-status" style="margin-top: 15px;">
          <div class="fmx-out-card ${isTargetMet ? 'valid' : 'invalid'}">
            <div class="fmx-valid-lbl">${isTargetMet ? '✅ SEMUA OUTPUT VALID & SESUAI TARGET!' : '❌ BELUM SESUAI TARGET'}</div>
          </div>
          
          <button id="fmxSubmitLogic" class="fmx-action-btn ${isTargetMet ? 'active' : 'disabled'}" ${isTargetMet && !FMX.won ? '' : 'disabled'} style="margin-top: 8px; width: 100%;">
            ${FMX.won ? 'Sirkuit Selesai ✓' : 'Kirim Output ke Lini Produksi Robot'}
          </button>
        </div>
      </div>
      ${FMX.won ? `<div class="fmx-success-box">🎉 MULTI-OUTPUT LOGIKA VALID! Gaji ${rupiah(FMX.salary)} telah ditransfer ke rekeningmu.</div>` : ''}
    `;
  }
}

function fmxUpdate(inp, dt) {
  if (!FMX.open) return;
  const sx = (inp.navX || (inp.mx ? Math.sign(inp.mx) : 0)), sy = (inp.navY || (inp.my ? Math.sign(inp.my) : 0));
  const ex = sx && sx !== FMX.lastX ? sx : 0, ey = sy && sy !== FMX.lastY ? sy : 0;
  FMX.lastX = sx; FMX.lastY = sy;

  if (inp.b || inp.start || keys.Escape) {
    closeFmx();
    return;
  }

  if (FMX.mode === 'liquid') {
    const totalTubes = FMX.tubes.length;
    if (ex) {
      FMX.sel = (FMX.sel + ex + totalTubes) % totalTubes;
      tone(450, 0.03, 0.03, 'sine');
      renderFmx();
    }
    if (inp.a) {
      if (FMX.selectedTube === -1) {
        if (FMX.tubes[FMX.sel].length > 0) {
          FMX.selectedTube = FMX.sel;
          tone(500, 0.05, 0.04, 'sine');
        } else {
          tone(220, 0.08, 0.04, 'sawtooth');
        }
      } else {
        transferLiquid(FMX.selectedTube, FMX.sel);
        FMX.selectedTube = -1;
      }
      renderFmx();
    }
  } else if (FMX.mode === 'logic') {
    if (ex) {
      FMX.sel = clamp(FMX.sel + ex, 0, 4); // 0..3 untuk 4 input sensor, 4 untuk tombol submit
      tone(450, 0.03, 0.03, 'sine');
      renderFmx();
    }
    if (inp.a) {
      if (FMX.sel < 4) {
        FMX.logicProblem.inputs[FMX.sel] = 1 - FMX.logicProblem.inputs[FMX.sel];
        tone(600, 0.05, 0.04, 'triangle');
        renderFmx();
      } else {
        const { finalOut1, finalOut2 } = evalCurrentLogic();
        const p = FMX.logicProblem;
        const isMet = (finalOut1 === p.targets[0] && finalOut2 === p.targets[1]);
        if (isMet && !FMX.won) {
          FMX.won = true;
          onFmxJobSuccess('Sirkuit Otomasi Multi-Output Berhasil Terverifikasi!');
          renderFmx();
        } else {
          tone(220, 0.12, 0.05, 'sawtooth');
        }
      }
    }
  }
}