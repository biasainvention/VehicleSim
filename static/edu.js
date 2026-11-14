/* Edukasi: minigame "Belajar Membaca & Berhitung" di sekolah + TV edukasi.
 * Dimuat sebelum game.js; memakai fungsi/variabel global game.js (P, clock, tone, showToast, $, …) saat dijalankan.
 */
'use strict';

/* ----------------------------- suara (text-to-speech) ------------------- */
let eduVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices();
  return vs.find((v) => /^id/i.test(v.lang)) || vs.find((v) => /indones/i.test(v.name)) || null;
}
if ('speechSynthesis' in window) {
  eduVoice = pickVoice();
  speechSynthesis.onvoiceschanged = () => { eduVoice = pickVoice(); };
}
function eduSay(text, rate = 0.9) {
  if (!('speechSynthesis' in window) || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'id-ID'; u.rate = rate; u.pitch = 1.05;
    if (eduVoice) u.voice = eduVoice;
    speechSynthesis.speak(u);
  } catch { /* abaikan */ }
}
function eduHush() { try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch { /* abaikan */ } }

/* ----------------------------- bank kata & alat bantu ------------------- */
const WORDS = [['🍎', 'A-PEL'], ['⚽', 'BO-LA'], ['🐟', 'I-KAN'], ['🐄', 'SA-PI'], ['🍌', 'PI-SANG'], ['🐱', 'KU-CING'], ['🚗', 'MO-BIL'],
  ['🏠', 'RU-MAH'], ['🐘', 'GA-JAH'], ['🍊', 'JE-RUK'], ['📚', 'BU-KU'], ['🥕', 'WOR-TEL'], ['🐍', 'U-LAR'], ['💡', 'LAM-PU'],
  ['🌙', 'BU-LAN'], ['🐔', 'A-YAM'], ['🦆', 'BE-BEK'], ['🌳', 'PO-HON'], ['🍚', 'NA-SI'], ['🥛', 'SU-SU'], ['👟', 'SE-PA-TU'],
  ['🪑', 'KUR-SI'], ['🚲', 'SE-PE-DA'], ['🍉', 'SE-MANG-KA'], ['🐒', 'MO-NYET'], ['🦋', 'KU-PU-KU-PU'], ['✏️', 'PEN-SIL'],
  ['🎈', 'BA-LON'], ['🐸', 'KA-TAK'], ['🍞', 'RO-TI'], ['🧢', 'TO-PI'], ['🐦', 'BU-RUNG'], ['🌸', 'BU-NGA'], ['🐯', 'HA-RI-MAU'],
  ['🦓', 'ZE-BRA'], ['🍍', 'NA-NAS'], ['🐑', 'DOM-BA'], ['🚚', 'TRUK'], ['⏰', 'JAM'], ['🐜', 'SE-MUT']]
  .map(([e, s]) => ({ e, syl: s.split('-'), w: s.replace(/-/g, '') }));
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
// susun 4 pilihan: jawaban + pengecoh unik, diacak
function choices(answer, pool) {
  const out = [String(answer)];
  for (const d of shuffle(pool)) { const s = String(d); if (out.length >= 4) break; if (!out.includes(s)) out.push(s); }
  const opts = shuffle(out);
  return { options: opts, answer: opts.indexOf(String(answer)) };
}
function numPool(ans, spread = 3) {
  const p = new Set();
  for (const d of [1, -1, 2, -2, spread, -spread, 10, -10, rint(1, 5), -rint(1, 5)]) if (ans + d >= 0 && ans + d !== ans) p.add(ans + d);
  return [...p];
}
const fmtN = (n) => n.toLocaleString('id-ID');
const emojiRow = (e, n) => `<span class="lemo">${Array(n).fill(e).join('')}</span>`;

/* ----------------------------- soal membaca ---------------------------- */
const SENTENCES = [
  ['Ibu pergi ke pasar membeli sayur.', 'Ke mana Ibu pergi?', ['pasar', 'sekolah', 'kantor', 'sawah']],
  ['Budi naik sepeda ke sekolah setiap pagi.', 'Budi ke sekolah naik apa?', ['sepeda', 'bus', 'motor', 'kereta']],
  ['Pak sopir mengantar trailer ke pabrik di Tengaran.', 'Ke mana trailer diantar?', ['pabrik', 'pasar', 'rumah', 'sekolah']],
  ['Siti makan nasi pecel di warung.', 'Apa yang dimakan Siti?', ['nasi pecel', 'roti', 'bakso', 'sate']],
  ['Lampu merah menyala, semua kendaraan berhenti.', 'Apa yang dilakukan kendaraan saat lampu merah?', ['berhenti', 'ngebut', 'putar balik', 'membunyikan klakson']],
  ['Adik menanam bunga mawar di halaman rumah.', 'Apa yang ditanam adik?', ['bunga mawar', 'pohon mangga', 'padi', 'jagung']],
  ['Kakak membaca buku cerita di perpustakaan.', 'Di mana kakak membaca?', ['perpustakaan', 'dapur', 'pasar', 'kebun']],
  ['Ayah memakai helm sebelum naik motor.', 'Apa yang dipakai ayah sebelum naik motor?', ['helm', 'topi', 'sarung', 'dasi']],
  ['Hujan turun deras, Rina membawa payung.', 'Apa yang dibawa Rina?', ['payung', 'bola', 'tas sekolah', 'sapu']],
  ['Udara Salatiga sejuk karena dekat Gunung Merbabu.', 'Mengapa udara Salatiga sejuk?', ['dekat gunung', 'dekat pantai', 'banyak pabrik', 'banyak mobil']],
  ['Dina menabung uang sakunya di celengan ayam.', 'Di mana Dina menabung?', ['celengan', 'dompet', 'laci', 'bank']],
  ['Kucing Rudi berwarna hitam dan suka tidur di sofa.', 'Apa warna kucing Rudi?', ['hitam', 'putih', 'oranye', 'abu-abu']],
];
const ALPHA = 'ABCDEFGHIJKLMNOPRSTUWYZ'.split('');
function qBaca(level) {
  if (level <= 1) {                                   // huruf awal
    const w = pickOne(WORDS);
    const c = choices(w.w[0], ALPHA.filter((l) => l !== w.w[0]));
    return { ...c, prompt: `<div class="lbig">${w.e}</div><div class="lword"><u>?</u>${w.w.slice(1)}</div><div class="lq">Huruf awal yang tepat?</div>`,
      say: `${w.w.toLowerCase()}. Huruf awalnya apa?`, explain: `${w.w} dimulai dengan huruf ${w.w[0]}` };
  }
  if (level === 2) {                                  // cocokkan gambar dengan kata
    const w = pickOne(WORDS);
    const c = choices(w.w, WORDS.filter((x) => x !== w).map((x) => x.w));
    return { ...c, prompt: `<div class="lbig">${w.e}</div><div class="lq">Gambar apa ini? Pilih kata yang tepat.</div>`, say: 'Gambar apa ini? Pilih kata yang tepat.', explain: `${w.e} = ${w.w}` };
  }
  if (level === 3) {                                  // lengkapi suku kata
    const w = pickOne(WORDS.filter((x) => x.syl.length >= 2));
    const i = Math.floor(Math.random() * w.syl.length), ans = w.syl[i];
    const pool = WORDS.flatMap((x) => x.syl).filter((s) => s !== ans && Math.abs(s.length - ans.length) <= 1);
    const c = choices(ans, pool);
    const shown = w.syl.map((s, k) => (k === i ? '<u>__</u>' : s)).join(' - ');
    return { ...c, prompt: `<div class="lbig">${w.e}</div><div class="lword">${shown}</div><div class="lq">Suku kata yang hilang?</div>`,
      say: `${w.syl.join(', ').toLowerCase()}. Suku kata mana yang hilang?`, explain: `${w.syl.join(' - ')} → ${w.w}` };
  }
  if (level === 4) {                                  // ejaan yang benar
    const w = pickOne(WORDS.filter((x) => x.w.length >= 4)), s = w.w, wrong = new Set();
    const V = 'AIUEO';
    for (let guard = 0; wrong.size < 6 && guard < 60; guard++) {
      const k = rint(0, s.length - 2), t = Math.random();
      let x;
      if (t < 0.35) x = s.slice(0, k) + s[k + 1] + s[k] + s.slice(k + 2);                     // tukar dua huruf
      else if (t < 0.6) x = s.slice(0, k) + s.slice(k + 1);                                    // satu huruf hilang
      else { const vi = [...s].map((ch, j) => (V.includes(ch) ? j : -1)).filter((j) => j >= 0); const j = pickOne(vi); x = s.slice(0, j) + pickOne(V.replace(s[j], '').split('')) + s.slice(j + 1); }
      if (x !== s) wrong.add(x);
    }
    const c = choices(s, [...wrong]);
    return { ...c, prompt: `<div class="lbig">${w.e}</div><div class="lq">Tulisan yang benar adalah…</div>`, say: 'Pilih tulisan yang benar.', explain: `Yang benar: ${s}` };
  }
  const [text, q, opts] = pickOne(SENTENCES);         // baca kalimat & jawab
  const c = choices(opts[0], opts.slice(1));
  return { ...c, prompt: `<div class="lread">“${text}”</div><div class="lq">${q}</div>`, say: `${text} ${q}`, explain: `Jawaban: ${opts[0]}` };
}

/* ----------------------------- soal berhitung -------------------------- */
const COUNT_EMO = ['🍎', '🐟', '⭐', '🚗', '🦆', '🍌', '🎈', '🐱', '🌸', '⚽'];
function qHitung(level) {
  if (level <= 1) {
    if (Math.random() < 0.7) {                        // menghitung benda
      const n = rint(1, 9), e = pickOne(COUNT_EMO);
      const c = choices(n, numPool(n).filter((x) => x >= 1 && x <= 12));
      return { ...c, prompt: `${emojiRow(e, n)}<div class="lq">Ada berapa ${e}?</div>`, say: 'Ayo hitung. Ada berapa?', explain: `Ada ${n}` };
    }
    const n = rint(1, 9);                              // angka sesudah
    const c = choices(n + 1, numPool(n + 1).filter((x) => x >= 0));
    return { ...c, prompt: `<div class="lword">${n}, <u>?</u></div><div class="lq">Angka sesudah ${n} adalah…</div>`, say: `Angka sesudah ${n} adalah?`, explain: `${n} lalu ${n + 1}` };
  }
  if (level === 2) {                                  // penjumlahan satu digit / pengurangan sampai 10
    const e = pickOne(COUNT_EMO);
    if (Math.random() < 0.7) {
      const a = rint(0, 9), b = rint(0, 9 - a), ans = a + b;
      const c = choices(ans, numPool(ans).filter((x) => x >= 0));
      return { ...c, prompt: `${emojiRow(e, a)} <b class="lop">+</b> ${emojiRow(e, b)}<div class="lword">${a} + ${b} = <u>?</u></div>`, say: `${a} tambah ${b} sama dengan?`, explain: `${a} + ${b} = ${ans}` };
    }
    const a = rint(3, 10), b = rint(1, a - 1), ans = a - b;
    const c = choices(ans, numPool(ans).filter((x) => x >= 0));
    return { ...c, prompt: `<span class="lemo">${Array(a).fill(e).map((x, i) => (i >= a - b ? `<s>${x}</s>` : x)).join('')}</span><div class="lword">${a} − ${b} = <u>?</u></div>`,
      say: `${a} kurang ${b} sama dengan?`, explain: `${a} − ${b} = ${ans}` };
  }
  if (level === 3) {                                  // sampai 50 + membandingkan
    const t = Math.random();
    if (t < 0.4) { const a = rint(5, 30), b = rint(3, 20), ans = a + b; const c = choices(ans, numPool(ans, 10)); return { ...c, prompt: `<div class="lword">${a} + ${b} = <u>?</u></div>`, say: `${a} tambah ${b} sama dengan?`, explain: `${a} + ${b} = ${ans}` }; }
    if (t < 0.8) { const a = rint(15, 50), b = rint(3, a - 2), ans = a - b; const c = choices(ans, numPool(ans, 10).filter((x) => x >= 0)); return { ...c, prompt: `<div class="lword">${a} − ${b} = <u>?</u></div>`, say: `${a} kurang ${b} sama dengan?`, explain: `${a} − ${b} = ${ans}` }; }
    const ns = shuffle([rint(10, 99), rint(10, 99), rint(10, 99), rint(10, 99)]).filter((v, i, arr) => arr.indexOf(v) === i);
    while (ns.length < 4) ns.push(rint(10, 99) + ns.length);
    const mx = Math.max(...ns), opts = ns.map(String);
    return { options: opts, answer: opts.indexOf(String(mx)), prompt: '<div class="lq">Bilangan mana yang <b>paling besar</b>?</div>', say: 'Bilangan mana yang paling besar?', explain: `${mx} paling besar` };
  }
  if (level === 4) {                                  // perkalian 2–5, tambah sampai 100
    if (Math.random() < 0.6) { const a = rint(2, 5), b = rint(1, 10), ans = a * b; const c = choices(ans, numPool(ans, a)); return { ...c, prompt: `<div class="lword">${a} × ${b} = <u>?</u></div>`, say: `${a} kali ${b} sama dengan?`, explain: `${a} × ${b} = ${ans}` }; }
    const a = rint(20, 70), b = rint(10, 99 - a), ans = a + b; const c = choices(ans, numPool(ans, 10));
    return { ...c, prompt: `<div class="lword">${a} + ${b} = <u>?</u></div>`, say: `${a} tambah ${b} sama dengan?`, explain: `${a} + ${b} = ${ans}` };
  }
  const t = Math.random();                            // level 5: kali, bagi, soal cerita
  if (t < 0.3) { const a = rint(3, 10), b = rint(3, 10), ans = a * b; const c = choices(ans, numPool(ans, a)); return { ...c, prompt: `<div class="lword">${a} × ${b} = <u>?</u></div>`, say: `${a} kali ${b} sama dengan?`, explain: `${a} × ${b} = ${ans}` }; }
  if (t < 0.55) { const b = rint(2, 9), ans = rint(2, 10), a = b * ans; const c = choices(ans, numPool(ans)); return { ...c, prompt: `<div class="lword">${a} : ${b} = <u>?</u></div>`, say: `${a} dibagi ${b} sama dengan?`, explain: `${a} : ${b} = ${ans}` }; }
  const stories = [
    () => { const a = rint(3, 9), b = rint(4, 9); return [`Truk membawa ${a} peti. Tiap peti berisi ${b} jeruk. Berapa jeruk semuanya?`, a * b, ' jeruk', b]; },
    () => { const b = rint(2, 6), ans = rint(3, 8); return [`Ada ${b * ans} kue dibagi rata kepada ${b} anak. Berapa kue untuk tiap anak?`, ans, ' kue', 1]; },
    () => { const n = rint(2, 5); return [`Harga es teh Rp 4.000. Ibu membeli ${n} gelas. Berapa yang harus dibayar?`, 4000 * n, '', 4000, true]; },
    () => { const a = rint(40, 90), b = rint(10, a - 10); return [`Bensin di tangki ${a} liter. Terpakai ${b} liter di jalan. Sisa berapa liter?`, a - b, ' liter', 10]; },
    () => { const a = rint(12, 30), b = rint(5, 20); return [`Di parkiran ada ${a} motor dan ${b} mobil. Berapa kendaraan semuanya?`, a + b, ' kendaraan', 10]; },
  ];
  const [text, ans, unit, spread, rp] = pickOne(stories)();
  const fmt = (v) => (rp ? `Rp ${fmtN(v)}` : `${v}${unit}`);
  const pool = numPool(ans, spread).filter((x) => x > 0).map(fmt);
  const c = choices(fmt(ans), pool);
  return { ...c, prompt: `<div class="lread">${text}</div>`, say: text, explain: `Jawaban: ${fmt(ans)}` };
}

/* ----------------------------- layar belajar --------------------------- */
const LEARN = { open: false, place: '', phase: 'menu', sel: 0, subject: 'baca', q: null, n: 0, ok: 0, streak: 0, fbT: 0, picked: -1, lastX: 0, lastY: 0, mixFlip: 0 };
const LEARN_N = 10;
const SUBJECTS = [['baca', '📖 Membaca'], ['hitung', '🔢 Berhitung'], ['campur', '🎲 Campuran']];
const learnProg = () => (P.learn || (P.learn = { baca: 1, hitung: 1, stars: 0, sessions: 0 }));

function openLearn(placeLabel) {
  learnProg();
  Object.assign(LEARN, { open: true, place: placeLabel, phase: 'menu', sel: 0, lastX: 0, lastY: 0 });
  $('learn').classList.remove('hidden');
  P.busy = ''; setHorn(false); tvHush();
  tone(523, 0.08, 0.05, 'triangle'); tone(659, 0.08, 0.05, 'triangle', 0.08); tone(784, 0.12, 0.05, 'triangle', 0.16);
  renderLearn();
}
function closeLearn() { LEARN.open = false; $('learn').classList.add('hidden'); eduHush(); }

function nextQuestion() {
  const pr = learnProg();
  let subj = LEARN.subject;
  if (subj === 'campur') subj = (LEARN.mixFlip++ % 2) ? 'hitung' : 'baca';
  LEARN.q = { ...(subj === 'baca' ? qBaca(pr.baca) : qHitung(pr.hitung)), subj };
  LEARN.phase = 'q'; LEARN.sel = 0; LEARN.picked = -1;
  renderLearn();
}
function startSession(subject) {
  Object.assign(LEARN, { subject, n: 0, ok: 0, streak: 0, mixFlip: Math.random() < 0.5 ? 0 : 1 });
  nextQuestion();
}
function answer(i) {
  if (LEARN.phase !== 'q') return;
  const q = LEARN.q, right = i === q.answer;
  LEARN.picked = i; LEARN.phase = 'fb'; LEARN.fbT = performance.now() + (right ? 1100 : 2300); LEARN.n++;
  if (right) { LEARN.ok++; LEARN.streak++; tone(660, 0.07, 0.05, 'triangle'); tone(880, 0.1, 0.05, 'triangle', 0.08); if (LEARN.streak % 5 === 0) tone(1175, 0.15, 0.05, 'triangle', 0.18); }
  else { LEARN.streak = 0; tone(230, 0.18, 0.05); }
  renderLearn();
}
function finishSession() {
  const pr = learnProg(), stars = LEARN.ok >= 9 ? 3 : LEARN.ok >= 7 ? 2 : LEARN.ok >= 5 ? 1 : 0;
  pr.stars += stars; pr.sessions++;
  LEARN.stars = stars; LEARN.levelUp = [];
  if (LEARN.ok >= 8) for (const s of LEARN.subject === 'campur' ? ['baca', 'hitung'] : [LEARN.subject]) {
    if (pr[s] < 5) { pr[s]++; LEARN.levelUp.push(s); }
  }
  clock = (clock + 1 / 3) % 24;                        // satu sesi belajar = 20 menit
  LEARN.phase = 'end'; LEARN.sel = 0;
  if (stars >= 2) { tone(523, 0.1, 0.05, 'triangle'); tone(659, 0.1, 0.05, 'triangle', 0.1); tone(784, 0.1, 0.05, 'triangle', 0.2); tone(1047, 0.25, 0.05, 'triangle', 0.3); }
  renderLearn();
}

function learnUpdate(inp, dt) {
  const sx = Math.abs(inp.mx) > 0.5 ? Math.sign(inp.mx) : 0, sy = Math.abs(inp.my) > 0.5 ? Math.sign(inp.my) : 0;
  const ex = inp.navX || (sx && sx !== LEARN.lastX ? sx : 0), ey = inp.navY || (sy && sy !== LEARN.lastY ? sy : 0);
  LEARN.lastX = sx; LEARN.lastY = sy;
  if (inp.b || inp.start) { closeLearn(); return; }
  if (inp.x) {                                         // 🔊 bacakan soal
    if (LEARN.phase === 'q' || LEARN.phase === 'fb') eduSay(LEARN.q.say);
  }
  if (LEARN.phase === 'menu') {
    if (ex || ey) { LEARN.sel = (LEARN.sel + (ex || ey) + SUBJECTS.length) % SUBJECTS.length; tone(500, 0.03, 0.03, 'sine'); renderLearn(); }
    if (inp.num && inp.num <= SUBJECTS.length) startSession(SUBJECTS[inp.num - 1][0]);
    else if (inp.a) startSession(SUBJECTS[LEARN.sel][0]);
    return;
  }
  if (LEARN.phase === 'q') {
    if (ex) { LEARN.sel = (LEARN.sel % 2 === 0 ? LEARN.sel + 1 : LEARN.sel - 1); tone(500, 0.03, 0.03, 'sine'); renderLearn(); }
    if (ey) { LEARN.sel = (LEARN.sel + 2) % 4; tone(500, 0.03, 0.03, 'sine'); renderLearn(); }
    if (inp.num && inp.num <= 4) answer(inp.num - 1);
    else if (inp.a) answer(LEARN.sel);
    return;
  }
  if (LEARN.phase === 'fb') {
    const left = LEARN.fbT - performance.now();          // jeda umpan balik (waktu nyata, tidak tergantung FPS)
    if (left <= 0 || (inp.a && left < (LEARN.picked === LEARN.q.answer ? 900 : 1900))) { if (LEARN.n >= LEARN_N) finishSession(); else nextQuestion(); }
    return;
  }
  if (LEARN.phase === 'end') {
    if (ex || ey) { LEARN.sel = 1 - LEARN.sel; renderLearn(); }
    if (inp.a) { if (LEARN.sel === 0) { LEARN.phase = 'menu'; LEARN.sel = 0; renderLearn(); } else closeLearn(); }
  }
}

const SUBJ_NAME = { baca: 'Membaca', hitung: 'Berhitung' };
function renderLearn() {
  const pr = learnProg();
  $('lTitle').textContent = `✏️ Belajar Membaca & Berhitung — ${LEARN.place}`;
  $('lInfo').textContent = `📖 Baca lv ${pr.baca} · 🔢 Hitung lv ${pr.hitung} · ⭐ ${pr.stars}`;
  const B = $('lBody');
  if (LEARN.phase === 'menu') {
    B.innerHTML = `<div class="lmenu">${SUBJECTS.map(([k, name], i) => `<button class="lopt big${i === LEARN.sel ? ' on' : ''}" data-s="${k}">
      ${name}<small>${k === 'campur' ? 'baca & hitung bergantian' : `level ${pr[k]} dari 5`}</small></button>`).join('')}</div>
      <div class="lq">Pilih pelajaran — ${LEARN_N} soal per sesi. Benar ≥ 8 soal = naik level.</div>`;
    return;
  }
  if (LEARN.phase === 'end') {
    const st = '⭐'.repeat(LEARN.stars) + '☆'.repeat(3 - LEARN.stars);
    const lu = LEARN.levelUp.length ? `<div class="lgood">🎉 Naik level: ${LEARN.levelUp.map((s) => `${SUBJ_NAME[s]} → lv ${pr[s]}`).join(', ')}</div>` : '';
    const msg = LEARN.ok >= 9 ? 'Hebat sekali!' : LEARN.ok >= 7 ? 'Bagus!' : LEARN.ok >= 5 ? 'Lumayan, terus berlatih!' : 'Ayo coba lagi, pasti bisa!';
    B.innerHTML = `<div class="lend"><div class="lstars">${st}</div><div class="lword">${LEARN.ok} / ${LEARN_N} benar</div><div class="lq">${msg}</div>${lu}
      <div class="lmenu">${['🔁 Belajar lagi', '🚪 Selesai'].map((t, i) => `<button class="lopt${i === LEARN.sel ? ' on' : ''}" data-e="${i}">${t}</button>`).join('')}</div></div>`;
    return;
  }
  const q = LEARN.q, fb = LEARN.phase === 'fb';
  const head = `<div class="lprog"><span>${q.subj === 'baca' ? '📖 Membaca' : '🔢 Berhitung'} · level ${pr[q.subj]}</span><span>Soal ${Math.min(LEARN.n + (fb ? 0 : 1), LEARN_N)}/${LEARN_N} · ✅ ${LEARN.ok}${LEARN.streak >= 3 ? ` · 🔥 ${LEARN.streak}` : ''}</span></div>`;
  const opts = q.options.map((o, i) => {
    let cls = 'lopt';
    if (!fb && i === LEARN.sel) cls += ' on';
    if (fb && i === q.answer) cls += ' right';
    if (fb && i === LEARN.picked && i !== q.answer) cls += ' wrong';
    return `<button class="${cls}" data-i="${i}"><em>${i + 1}</em>${o}</button>`;
  }).join('');
  const verdict = fb ? (LEARN.picked === q.answer ? '<div class="lgood">✅ Benar! Hebat!</div>' : `<div class="lbad">❌ Belum tepat — ${q.explain}</div>`) : '';
  B.innerHTML = `${head}<div class="lprompt">${q.prompt}</div><div class="lgrid">${opts}</div>${verdict}`;
}

/* ----------------------------- TV edukasi (YouTube) ---------------------- */
// TV memutar video dari channel YouTube. Daftar channel ada di settings.json (tv.channels):
//   { "name": "...", "channelId": "UC..." }  -> memutar semua unggahan channel (playlist "UU...")
//   { "name": "...", "uploads": "handle" }   -> memutar unggahan berdasarkan nama pengguna YouTube lama
//   { "name": "...", "playlist": "PL..." }   -> memutar playlist tertentu
// Video ditempelkan di layar TV 3D (transformasi perspektif CSS) atau di jendela TV kecil; Y = layar lebar.
const TV = { rooms: {}, big: false, src: '', frame: null };
const tvOf = (pl) => (pl ? (TV.rooms[pl.id || pl.label] || (TV.rooms[pl.id || pl.label] = { on: false, ch: 0 })) : null);
const tvChannels = () => ((SETTINGS.tv && SETTINGS.tv.channels) || []).filter((c) => c && (c.channelId || c.playlist || c.uploads));
function tvUrl(c) {
  if (c.uploads) {
    const q = new URLSearchParams({ listType: 'user_uploads', list: c.uploads, autoplay: '1', rel: '0', playsinline: '1',
      enablejsapi: '1', origin: location.origin });
    return `https://www.youtube-nocookie.com/embed?${q}`;
  }
  const list = c.playlist || ('UU' + String(c.channelId).slice(2));
  const q = new URLSearchParams({ list, autoplay: '1', rel: '0', modestbranding: '1', playsinline: '1', enablejsapi: '1', origin: location.origin });
  return `https://www.youtube-nocookie.com/embed/videoseries?${q}`;
}
function tvHush() { eduHush(); }
function tvToggle(pl) {
  const st = tvOf(pl), chs = tvChannels();
  if (!st.on && !chs.length) { showToast('Belum ada channel YouTube di settings.json (tv.channels)', 3.5); return; }
  st.on = !st.on;
  if (st.on) {
    if (IN.key === 'masjid') {
      const kidsIndex = chs.findIndex((c) => c.uploads === 'YufidKids');
      if (kidsIndex >= 0) st.ch = kidsIndex;
    }
    st.ch %= chs.length; tone(880, 0.05, 0.04, 'sine');
    showToast(`📺 YouTube: ${chs[st.ch].name} · X ganti channel · LB/RB video lain · Y layar lebar`, 3.5);
  } else { tone(440, 0.05, 0.04, 'sine'); TV.big = false; }
}
function tvNext(pl) {
  const st = tvOf(pl), chs = tvChannels(); if (!st.on || !chs.length) return;
  st.ch = (st.ch + 1) % chs.length;
  tone(990, 0.04, 0.04, 'sine'); showToast(`📺 Channel ${st.ch + 1}/${chs.length}: ${chs[st.ch].name}`, 2.2);
}
function tvCommand(func) {                            // perintah ke pemutar YouTube (video berikut / sebelumnya)
  try { TV.frame && TV.frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: '' }), '*'); } catch { /* abaikan */ }
}
function tvBig() { TV.big = !TV.big; tone(700, 0.04, 0.04, 'sine'); }
const tvOnHere = () => !!(P.mode === 'inside' && P.house && tvOf(P.house).on && IN.furn.some((f) => f.kind === 'tv'));

// homografi: petakan persegi panjang w×h ke 4 titik layar (CSS px) -> CSS matrix3d
function quadMatrix(w, h, p) {
  const [x0, y0] = p[0], [x1, y1] = p[1], [x2, y2] = p[2], [x3, y3] = p[3];
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (dx3 * dy2 - dx2 * dy3) / den, hh = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0, d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
  return `matrix3d(${a / w},${d / w},0,${g / w},${b / h},${e / h},0,${hh / h},0,0,1,0,${c},${f},0,1)`;
}
// dipanggil tiap frame dari game.js
function tvUpdate() {
  const box = $('tvPip'), wrap = $('tvWrap');
  const inside = (state === 'play' || state === 'paused') && P.mode === 'inside' && !LEARN.open && !BUILD.open;
  const st = inside ? tvOf(P.house) : null, chs = tvChannels();
  const show = !!(st && st.on && chs.length && IN.furn.some((f) => f.kind === 'tv'));
  if (!show) {
    if (TV.frame) { TV.frame.remove(); TV.frame = null; TV.src = ''; }
    box.classList.add('hidden'); wrap.classList.add('hidden'); TV.big = false;
    return;
  }
  const c = chs[st.ch % chs.length], src = tvUrl(c);
  if (!TV.frame) {
    TV.frame = document.createElement('iframe');
    TV.frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    TV.frame.referrerPolicy = 'strict-origin-when-cross-origin';
    TV.frame.title = 'TV edukasi (YouTube)';
    wrap.appendChild(TV.frame);
  }
  if (TV.src !== src) { TV.src = src; TV.frame.src = src; }
  $('tvTitle').textContent = `📺 ${c.name}`;
  wrap.classList.remove('hidden');
  // posisi: layar lebar, menempel di layar TV 3D, atau jendela kecil
  let mode = TV.big ? 'big' : 'pip', quad = null;
  if (!TV.big && typeof is3D === 'function' && is3D() && Render3D.tvScreen) {
    const f = IN.furn.find((q) => q.kind === 'tv'), sc = Render3D.tvScreen(f), d = window.devicePixelRatio || 1;
    const pts = [[sc.x0, sc.y1], [sc.x1, sc.y1], [sc.x1, sc.y0], [sc.x0, sc.y0]].map(([x, y]) => Render3D.projRaw(x, y, sc.z));
    if (pts.every((q) => q && !q.behind)) {
      quad = pts.map((q) => [q.x / d, q.y / d]);
      const wpx = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
      if (wpx > 70) mode = 'tv';                          // terlalu kecil di layar -> pakai jendela kecil
    }
  }
  wrap.className = 'tv-' + mode;
  box.classList.toggle('hidden', mode !== 'pip');
  if (mode === 'tv') { wrap.style.transform = quadMatrix(640, 360, quad); }
  else wrap.style.transform = '';
}
