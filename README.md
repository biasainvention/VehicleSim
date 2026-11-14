# Trailer Salatiga – Tengaran — game truk trailer (Python Flask + Gamepad)

Ambil trailer oranye dari dock, tarik ke drop zone hijau, mundurkan sampai masuk penuh, lalu lepas.
Satu permainan = 3 misi; skor tersimpan di `scores.json` (papan skor 10 besar).

## Menjalankan
Butuh Python 3.9 atau lebih baru. Dari dalam folder `trailer_game`:
```bash
# (opsional, disarankan) buat lingkungan virtual
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate       # Linux / macOS

pip install -r requirements.txt  # memasang Flask
python app.py
```
Kalau perintah `pip` tidak dikenali, pakai `python -m pip install -r requirements.txt`
(di Windows bisa juga `py -m pip install -r requirements.txt`).
Buka **http://127.0.0.1:5000** di Chrome/Edge (Gamepad API paling stabil di sana). Tampilan **2D ↔ 3D bisa diganti
kapan saja saat main** (tahan R3 ½ detik, atau tombol T / tombol "Ganti ke 3D" di layar awal); pilihan terakhir diingat.
Alamat **/3d** langsung membuka tampilan 3D.
Di tampilan 3D, suspensi kendaraan darat merespons akselerasi, pengereman, belokan,
serta kemiringan dan kontur permukaan jalan. Ruas jalan lokal/permukiman memiliki gundukan
berulang yang terlihat di 3D dan memicu pitch/roll serta gerak suspensi kendaraan. Roda
mengikuti tinggi jalan secara terpisah dari badan, dalam batas travel suspensi ±6 px (60 cm);
di luar batas tersebut roda dapat terangkat dari permukaan. Asphalt paver tidak memakai suspensi.
Di off-road, dump truck dibatasi sekitar 25 km/j untuk traksi dan stabilitas.
Colokkan gamepad (Xbox/PS/generik XInput), lalu tekan tombol apa saja agar terdeteksi.

## Peta fleksibel
Editor peta di **/editor** menyimpan seluruh perubahan peta—objek baru, objek bawaan yang
dipindah/dihapus, dan jalan beserta elevasinya—ke file **`mapedit.json`** terpisah dari
`settings.json`. Saat game meminta level, server menggabungkan file itu di atas peta dasar dari
`level_salatiga.py` dan `level_world.py`; perubahan tetap dipakai setelah game/server dimuat ulang.
Editan lama di `settings.json` (`mapEdit`) otomatis dipindahkan ke file baru pada akses editor/game
pertama. Tombol **Reset semua** di editor mengosongkan editan dan mengembalikan peta dasar.
Jika centerline dua jalan berpotongan dengan selisih elevasi sedikitnya 3 m, level otomatis
membangun dek jembatan pada jalan yang lebih tinggi. Terrain di bawah dek mengikuti jalan
yang lebih rendah; dek, pagar, dan pilar terlihat di tampilan 2D/3D, dan kendaraan yang melaju
searah jalan atas mengikuti elevasi jembatan.

## Telemetri motion rig
Buka `/telemetry` di tab lain pada browser yang sama. Saat kendaraan dikemudikan, game
menyiarkan paket telemetri schema v2 lewat `BroadcastChannel` (`game_telemetry_channel`)
hingga sekitar frekuensi update game; dashboard membatasi pembaruan visual agar tetap ringan.
Paket menyediakan posisi, kecepatan, percepatan linear/sudut, orientasi/kontrol, laju sudut, G-force,
attitude pitch/roll/yaw untuk semua kendaraan (termasuk kemiringan kontur dan respons suspensi di darat),
status dan spesifikasi kendaraan, timestamp monotonic dan Unix, nomor urut, serta satuan. Posisi/kecepatan
memakai meter dan detik (10 px game = 1 m); sumbu X/Y adalah bidang peta, Z ke atas, dan
heading nol menunjuk timur. Field koordinat lama tetap disertakan dalam satuan piksel untuk
kompatibilitas; `attitude` menyertakan derajat/radian dan sumber setiap sudut. Pitch pesawat
terbang adalah estimasi dari command; pitch Falcon saat terbang belum disimulasikan dan ditandai
`not_simulated`. Field `pitchCommand` tetap berupa command ternormalisasi.
Parameter kekakuan, redaman, batas sudut pitch/roll bodi, dan jarak travel roda dapat diubah dari dashboard `/telemetry`;
tekan **Simpan pengaturan** untuk menyimpan ke `settings.json` dan menerapkan nilainya langsung
ke tab game yang terbuka. Rentang: kekakuan 4–25 rad/s, redaman 0,3–2,0, batas pitch ±1–25°,
batas roll ±1–30°, dan travel 0–100 cm.

Dashboard telemetry juga dapat mengirim paket langsung ke ESP32 lewat USB Serial:
pilih **2.000.000 baud** (maksimum yang disediakan), lalu tekan **Hubungkan ESP32** dan pilih port.
ESP32 menerima NDJSON UTF-8: satu paket schema v2 per baris, diakhiri `\n`, termasuk pesan
`active: false` saat kendaraan tidak lagi dikemudikan. Samakan baud rate pada firmware ESP32.
Koneksi browser memerlukan Chrome/Edge dengan Web Serial dan halaman dari `localhost` atau HTTPS.

## Simpan otomatis
Keadaan permainan tersimpan otomatis, jadi aman kalau browser di-refresh, tab ditutup, atau komputer mati:
- disimpan ke `localStorage` browser tiap 2 detik dan saat halaman ditutup/di-refresh;
- cadangan ke server Flask (`saves.json`, per nama pemain) tiap 10 detik dan saat halaman ditutup.

Yang disimpan: posisi sopir & semua kendaraan, gigi, BBM tiap kendaraan, trailer (termasuk yang
sedang tersambung), misi berjalan, uang, tenaga, jeriken, benturan, waktu, dan lalu lintas.
Saat dibuka lagi muncul tombol **Lanjutkan** (A / Enter) atau **Main baru** (X / N).
Permainan yang dilanjutkan mulai dalam keadaan jeda; tekan Start / P untuk jalan.
Kalau data browser terhapus, ketik nama pemain yang sama untuk memuat cadangan dari server.

## Kontrol
| Aksi | Gamepad | Keyboard |
|---|---|---|
| Setir / jalan kaki | Stik kiri / D-pad | Panah / WASD |
| Gas (saat jalan kaki: lari) | RT | ↑ / W (lari: Shift) |
| Rem | LT (hanya mengerem) | ↓ / S |
| Pesan taksi ke tempat pilihan | Klik ikon 🚕 | Klik ikon 🚕 |
| Jadi sopir taksi / ojek | – | C |
| **Pesawat:** pitch naik/turun · **Helikopter/Falcon 9:** naik/turun vertikal | D-pad ↑ / ↓ | Q / E |
| **Helikopter/Falcon 9:** maju / mundur · geser kiri/kanan · putar badan | RT / LT · stik kiri · D-pad ← / → | W / S · A / D |
| Gigi ke arah D (P→R→N→D) | RB / D-pad ↓ | E |
| Gigi ke arah P (D→N→R→P) | LB / D-pad ↑ | Q |
| Naik / turun kendaraan | Y | F |
| Aksi: sambung/lepas trailer, masuk/keluar bangunan, beli di kasir, tuang jeriken | A (tahan untuk isi BBM / tidur / duduk) | Spasi |
| Klakson / beli item ke-2 di kasir | X / L3 | H |
| Rem tangan | B | Shift |
| **Putar kamera 3D** kiri/kanan | Stik kanan ← → | J / K · geser mouse |
| Kamera 3D naik/turun · zoom halus di 2D | Stik kanan ↑ ↓ | I / O |
| Zoom kamera | R3 (tekan singkat) | Z |
| **Ganti tampilan 2D ↔ 3D** | R3 (tahan ½ detik) | T |
| Kamera 3D: dari belakang ↔ dari atas | – | V |
| Dealer: pilih model mobil | LB / RB | Q / E |
| Peta rute Salatiga → Tengaran | Back / Select | M |
| Papan skor | (tampil saat jeda) | L |
| Jeda (saat jeda, Y = kembalikan trailer misi ke dock) | Start | P / Esc (R = kembalikan trailer) |

### Transmisi otomatis PRND
- Pindah gigi langsung dengan RB/LB, tanpa perlu menginjak rem.
- **P** parkir (terkunci), **R** mundur (ada bunyi beep), **N** netral, **D** maju.
- Tanpa gas, di D/R kendaraan merayap pelan (creep) seperti mobil matic.
- Pindah ke R, D, atau P hanya saat kendaraan hampir berhenti. Saat sopir turun, gigi otomatis ke P.

## Sopir, kendaraan & kampung
Sopir mulai berjalan kaki di depan **rumah sopir**. Truk & sedan ada di carport rumah sopir; Mirage & Innova di carport Rumah Puri Wahid. Semua bisa dipakai bergantian:

| Kendaraan | BBM | Catatan |
|---|---|---|
| Truk Biru | Solar 200 L | bisa menarik trailer |
| Truk Merah | Solar 160 L | tarikan lebih kuat, bisa menarik trailer |
| Mobil Sedan | Pertalite 40 L | cepat, tidak bisa menarik trailer |
| Mirage (hatchback) | Pertalite 35 L | lincah & irit, parkir di Rumah Puri Wahid |
| Innova (MPV) | Pertalite 55 L | lebih besar, parkir di Rumah Puri Wahid |
| **Pick-up** (bak terbuka) | Pertalite 47 L | carport rumah sopir |
| **Truk Mini** (engkel, bak kayu) | Solar 70 L | carport rumah sopir |

Mobil baru juga bisa dibeli di dealer Mitsubishi (tunai atau kredit; cicilan dipotong dari ongkos kirim).

### Bangunan yang bisa dimasuki
Berdiri di lingkaran depan pintu lalu tekan **A** untuk masuk; di dalam, dekati titik interaksi (lingkaran kuning
+ ikon), keluar lewat pintu di dinding bawah. Posisi di dalam bangunan ikut tersimpan.

| Bangunan | Di dalam |
|---|---|
| Rumah sopir & Rumah Puri Wahid | kasur (tahan A tidur, tenaga cepat naik), sofa, dapur |
| Warung Klero | etalase: A nasi rames, X es teh · bangku makan (tahan A duduk) |
| Pasar Kembangsari | los sayur, cabai, buah · los pecel (A) & dawet (X) · bangku |
| Toko SPBU Tingkir / Tengaran | rak, kulkas · kasir: A jeriken 10 L, X roti & kopi |
| Toko Luwes | rak oleh-oleh · kasir: A enting-enting, X paket oleh-oleh |
| Hotel Laras Asri | resepsionis: A menginap (tenaga penuh, waktu maju) · restoran: A makan, X kopi · sofa lobi |
| Kumon Sukowati | meja guru: A ikut les 1 sesi (1 jam) · meja murid (duduk) |
| Sekolah Al-Irsyad | ruang kelas · kantin: A cilok, X es teh |
| Masjid Al-Irsyad, dekat Lapangan Pancasila & Puri Wahid | tempat wudu (tahan A untuk memulihkan tenaga) · sajadah menghadap barat · TV video YouTube |
| Dealer Mitsubishi | 4 mobil pajangan · meja sales: LB/RB pilih, A tunai, X kredit · sofa tunggu |

Di luar: **Terminal Bus Tingkir** dengan bus yang diparkir, **Alun-alun Pancasila** (tahan A duduk santai),
dan gerobak **wedang ronde** (buka 15.00–01.00: A wedang ronde, X bakmi jawa). TV di masjid langsung memilih
unggahan kanal Yufid Kids; video spesifik dapat dipilih dengan kontrol YouTube.

### Jalan tol
Masuk lewat **Gerbang Tol Tingkir** (dari Jl. Raya Salatiga–Suruh), menyusur sisi barat, keluar di
**Gerbang Tol Boyolali** dekat Sruwen. Lewat gardu pertama = tap e-toll, gardu berikutnya = bayar:
Gol. I (mobil, pick-up) Rp 25.500 · Gol. II (truk mini/boks) Rp 38.500 · Gol. IV/V (truk gandeng) Rp 51.500.
Jalan tol 2 lajur per arah, berpagar pengaman, dan ramai lalu lintas yang lebih cepat.

### Siang & malam
1 hari game = 12 menit (1 jam = 30 detik). Malam hari lampu jalan, lampu kendaraan, dan jendela menyala;
tidur di kasur mempercepat waktu. Jam tampil di HUD dan ikut tersimpan.

### Benturan
Tabrakan memakai impuls berbasis massa: kendaraan **terpental dan berputar**, kendaraan lain yang ditabrak
ikut terdorong (yang ringan terlempar lebih jauh; truk gandeng paling berat). Ada percikan api, serpihan bodi,
asap, guncangan kamera (2D & 3D), suara benturan, suara mesin yang mengikuti putaran gas/kecepatan,
desis rem dan decit saat pengereman keras, serta getar gamepad. Tiap benturan > 4 km/j = −75 poin.

### Lampu lalu lintas
Setiap persimpangan (20 simpang, dideteksi otomatis dari data jalan) punya lampu 2 fase: jalan raya hijau 14 s →
kuning 3 s → merah semua → jalan cabang hijau 10 s → kuning → merah semua. Garis henti & tiang lampu ada di lajur
kiri tiap lengan simpang; malam hari lampunya berpendar. Lalu lintas NPC berhenti di garis henti saat merah.
**Menerobos lampu merah = tilang Rp 100.000.** Tiang lampu bisa ditabrak.

### Bengkel Rakit Tingkir — mode buat kendaraan
Di timur jalan raya Tingkir (seberang rumah sopir). Berdiri di lingkaran depan bengkel, tekan **A**:
layar rakit terbuka (dunia berhenti sementara). Pilih blok dasar:

| Blok | Pilihan | Pengaruh |
|---|---|---|
| Mesin | Bensin 1.3 L · Diesel 2.5 L · Diesel 6.0 L Turbo | tarikan, kecepatan maks, jenis & boros BBM, bisa tarik trailer |
| Roda + sumbu | 2 sumbu roda kecil · 2 sumbu roda besar · 3 sumbu (tandem) | sudut belok, kemampuan di luar aspal, golongan tol |
| Sasis | Pendek 5,6 m · Sedang 7,8 m · Panjang 10 m | panjang, lebar, jarak sumbu, tangki BBM |
| Kabin | Kabin mobil · kabin truk · kabin truk sleeper | bentuk & tinggi kabin |
| Muatan | Tanpa · bak terbuka · boks · tangki · fifth wheel | fifth wheel = bisa menarik trailer misi |
| Warna | 10 warna | — |

Pratinjau tampak samping & atas serta statistik (kecepatan, tarikan, berat, panjang, tangki, golongan tol)
berubah langsung. Kombinasi yang tidak masuk akal ditolak (mis. fifth wheel butuh Diesel 6.0 L, roda besar/3 sumbu
& sasis ≥ sedang). Tekan **A** untuk merakit (bayar total harga blok); kendaraan muncul di parkiran bengkel dengan
tangki penuh, bisa dikendarai seperti kendaraan lain, digambar di 2D & 3D, dan ikut tersimpan.
Kontrol layar rakit: stik kiri / D-pad ↑↓ pilih blok, ←→ ganti pilihan, A rakit, B keluar (keyboard: panah, Spasi, Esc; klik juga bisa).

### Lain-lain
- **Tenaga** sopir turun pelan-pelan. Di bawah 20 kendaraan melambat; di 0 sopir kelelahan.
- **BBM** habis = kendaraan tidak bisa jalan. Jalan kaki ke SPBU, beli jeriken.
- **Uang bekal** Rp 90.000.000, bertambah dari ongkos kirim tiap misi (ongkos dasar + bonus skor + gaji tambahan Rp 3.000.000).
- **Lalu lintas**: mobil, pick-up, truk mini & truk boks NPC berjalan di lajur kiri jalan raya, jalan tol,
  Jl. Muwardi, Jl. Raya Salatiga–Suruh; berhenti di lampu merah dan membunyikan klakson kalau dihalangi.
- **Warga pejalan kaki** terlihat berjalan di sekitar berbagai tempat. Dalam misi antar jemput,
  penumpang berjalan mendekati mobil saat dijemput, terlihat duduk selama perjalanan, lalu turun
  dan berjalan ke tujuan sebelum ongkos dibayarkan. Hentikan kendaraan untuk proses naik/turun.

## Peta: Salatiga → Tengaran
Utara di atas. Jalan raya Semarang–Solo turun dari Kota Salatiga ke Tengaran:

| Wilayah | Isi |
|---|---|
| Kota Salatiga | Jl. Jenderal Sudirman, **Toko Luwes**, **Alun-alun Pancasila** (Patung Tiga Pahlawan, wedang ronde), **Dealer Mitsubishi**, Jl. Muwardi, Jl. Fatmawati, Simpang Tiga Pendem, **Gudang Ekspedisi** (ambil trailer) |
| Sukowati, Salatiga | Jl. Sukowati, **Kumon Sukowati** |
| Ledok, Argomulyo | **Hotel Laras Asri** |
| Kec. Argomulyo (barat) | Kumpulrejo, Cebongan, Tegalrejo, Noborejo: Jl. Cebongan, Jl. Tegalrejo, Jl. Noborejo |
| Randuacir, Argomulyo | **Perumahan Puri Wahid Regency** (gapura, Jl. Puri Wahid) & **Rumah Puri Wahid** (istirahat, Mirage & Innova) — masuk dari Jalan Lingkar Selatan |
| Tingkir, Salatiga | Simpang Jalan Lingkar Selatan, **rumah sopir**, **Bengkel Rakit Tingkir**, **SPBU Tingkir**, Jl. Raya Salatiga–Suruh, **Gerbang Tol Tingkir** |
| Sisi barat | **Jalan Tol Semarang–Solo** (Tingkir → Boyolali) |
| Klero, Tengaran | **Warung Klero**, Arena Pacuan Kuda Tegalwaton |
| Tengaran | **SPBU Tengaran**, **Pasar Kembangsari** (bisa jajan) |
| Butuh, Tengaran | **Kawasan industri**: Pabrik Garmen & Pabrik Kayu (drop zone), **Sekolah Al-Irsyad** (zona sekolah maks 30 km/j pukul 06.30–14.00) |
| Sruwen, Tengaran | **Gerbang Tol Boyolali**, gapura batas Kab. Semarang / Kab. Boyolali, terus ke Solo |

Jarak dipadatkan (±8 km jadi ±0,85 km) dan tata letaknya disederhanakan. Gudang, depo, rumah,
SPBU, dan warung fiktif; nama jalan, kampung, dan landmark (Alun-alun Pancasila, Luwes, Hotel Laras Asri,
Kumon Sukowati, Al-Irsyad, dealer Mitsubishi, GT Tingkir) diambil dari tempat nyata, posisinya perkiraan.
Kamera mengikuti sopir/kendaraan, radar di kanan bawah, peta rute penuh dengan Back / M,
lokasi saat ini tampil di kiri atas. Rumput & sawah bisa dilewati tapi lambat.

## Cara main
1. Jalan ke truk di carport rumah (Tingkir), tekan **Y** untuk naik, pindah ke **D**, ke utara menuju
   Gudang Ekspedisi Salatiga di Jl. Jend. Sudirman.
2. Masuk gudang lewat gerbang, hadapkan truk searah garis kuning di depan trailer oranye,
   pindah ke **R** dan mundur sampai fifth wheel di bawah kingpin (lingkaran hijau), tekan **A**.
3. Tarik trailer ke selatan sampai kawasan industri Butuh, Tengaran, lalu ke zona hijau (panah zona = arah moncong trailer, biasanya harus mundur masuk).
4. Saat seluruh trailer di dalam kotak, berhenti dan tekan **A**. Ongkos kirim masuk ke dompet.

Skor per misi = 1000 + bonus waktu (maks 1200) + presisi (maks 500) − 75 × benturan.
Suara butuh izin audio dari browser: klik tombol **Mulai** dengan mouse atau tekan tombol keyboard sekali.

## Tampilan 3D
Dirender dengan WebGL2 murni (tanpa library & tanpa internet): dunia, rumah, pohon, SPBU, pabrik, jalan tol, gunung,
kendaraan, bayangan, langit siang/senja/malam berbintang, dan interior semua bangunan. Butuh browser dengan WebGL2
(Chrome/Edge/Firefox terbaru); kalau tidak ada, game otomatis memakai tampilan 2D.
- **Rotasi kamera**: stik kanan memutar (← →) dan menaikkan/menurunkan (↑ ↓) kamera. Saat menyetir, kamera kembali
  ke belakang kendaraan 2 detik setelah stik dilepas. Jalan kaki mengikuti arah kamera (stik ke atas = menjauhi kamera).
- Mengemudi: kamera mengikuti dari belakang (di belakang ujung trailer saat menarik trailer). Tekan **V** untuk pandangan dari atas.
- Jalan kaki: kamera miring dengan utara di atas, sehingga arah panah/stik sama seperti versi 2D.
- Kalau gudang/rumah menghalangi pandangan (misalnya saat mundur ke dock), kamera pindah sendiri ke pandangan atas.
- Zoom (Z) mengubah jarak kamera. Lingkaran kuning = titik interaksi, tiang cahaya oranye/hijau = tujuan misi.

## Struktur
```
app.py              Flask: halaman, /api/level, /api/scores, /api/save (simpan/muat permainan)
level_salatiga.py   pembangkit peta Salatiga–Tengaran (jalan, bangunan, kendaraan, lalu lintas)
templates/index.html
static/game.js      fisika truk+trailer & benturan, input gamepad, jam siang-malam, tol, lampu lalu lintas,
                    interior bangunan, bengkel rakit kendaraan, render 2D
static/render3d.js  renderer 3D WebGL2 (bisa diganti saat main); logika tetap di game.js
static/style.css
```
Peta (jalan, bangunan, tol, persimpangan & lampu, kendaraan, lalu lintas) dibangkitkan di `level_salatiga.py`;
blok bengkel (harga & spesifikasi) ada di `PARTS` dalam `game.js`;
denah interior bangunan ada di `makeInteriors()` dalam `game.js`.
Konstanta fisika (kecepatan, sudut setir, panjang trailer, toleransi sambung) ada di bagian atas `game.js`.

## Sepeda motor
- Di halaman rumah sopir ada **Motor Bebek** dan **Motor Matic** (Y untuk naik). Ringan, lincah, irit (tangki ±5 L Pertalite).
- Motor tidak bisa menarik trailer dan **dilarang masuk jalan tol** (dihentikan di gerbang tol).
- Mundur hanya pelan (didorong). Tabrakan keras membuat pengendara **terjatuh dari motor** (tenaga −8).
- Lalu lintas sekarang ramai motor NPC di Jl. Raya Salatiga–Solo, Jl. Muwardi, dan Jl. Suruh.

## Kerusakan & kendaraan hancur
- Setiap kendaraan punya **Kondisi** 0–100 % (bar di panel kiri bawah). Benturan mengurangi kondisi;
  kerusakan dibagi menurut massa — motor dan mobil kecil lebih parah dibanding truk.
- Kondisi < 60 %: berasap. Kondisi < 35 %: asap hitam, mesin pincang (kecepatan maks turun).
- Kondisi 0 %: **HANCUR** — meledak, terbakar ±14 detik, bodi hangus, mesin mati.
- Kendaraan lain (NPC) juga bisa hancur bila kamu tabrak; kamu membayar ganti rugi. Bangkai NPC diderek setelah ±30 detik.
- Perbaikan: berdiri di dekat kendaraan yang rusak/hancur, tekan **A** untuk panggil montir (biaya sesuai kerusakan).

## Perbaikan bug
- Saat ganti 2D ↔ 3D, trailer yang tersambung selalu disinkronkan ke fifth wheel truk dan selalu digambar;
  kamera 3D langsung ditempatkan di belakang kendaraan (tidak lagi melayang melewati trailer).

## Belajar membaca & berhitung (minigame sekolah)
- Ada di **Sekolah Al-Irsyad** dan **Kumon Sukowati**: masuk, berdiri di depan **papan tulis ✏️**, tekan **A**.
- Pilih pelajaran: 📖 Membaca, 🔢 Berhitung, atau 🎲 Campuran. Satu sesi berisi 10 soal pilihan ganda dan memakan waktu 20 menit di jam game.
- Naik level (maks 5) kalau benar ≥ 8 soal. Bintang ⭐ dikumpulkan dan progres tersimpan.
  - Membaca: huruf awal → cocokkan gambar dengan kata → suku kata → ejaan yang benar → baca kalimat & jawab.
  - Berhitung: menghitung benda → penjumlahan dua angka satu digit (hasil ≤ 9) dan pengurangan ≤ 10 dengan gambar → sampai 50 & membandingkan → perkalian → bagi & soal cerita.
- Kontrol: D-pad/stik/panah memilih, A/Spasi menjawab (tombol 1–4 juga bisa), **X (H) membacakan soal dengan suara**, B/Esc keluar. Mouse juga bisa.

## TV edukasi (YouTube)
- TV ada di rumah sopir, rumah Puri Wahid, sekolah, Kumon, dan masjid. TV memutar video dari **channel YouTube** (perlu internet).
- Di dekat TV: **A** menyalakan/mematikan, **X (H)** ganti channel, **LB/RB (Q/E)** video sebelumnya/berikutnya,
  **Y (F)** layar lebar. Saat duduk di sofa (tahan A), tombol-tombol itu juga berfungsi.
- Video menempel di layar TV 3D. Bila TV terlalu kecil/tidak terlihat, video tampil di jendela kecil kanan atas.
- Daftar channel ada di **`settings.json`** (`tv.channels`). Bawaannya:
  Kids Tv Prasekolah (huruf, angka, warna) · YuBimba (calistung) · Kok Bisa? (sains) · Nussa Official (animasi edukasi) · Yufid Kids.
  Tambahkan channel dengan `{"name": "...", "channelId": "UC..."}`, playlist `{"name": "...", "playlist": "PL..."}`,
  atau unggahan nama pengguna lama `{"name": "...", "uploads": "YufidKids"}`.
  Kalau ada video yang tidak bisa diputar, berarti pemilik channel menonaktifkan pemutaran di situs lain: ganti channel.


## Tampilan 3D penuh
- Tampilan 2D dihapus. Game selalu 3D (2D hanya cadangan kalau browser tidak mendukung WebGL2).
- **Tahan R3 / tekan T atau V** = **tampak atas** (kamera hampir tegak lurus, arah hadap kendaraan di atas layar) untuk
  mempermudah parkir dan memundurkan trailer. Tekan lagi untuk kembali ke kamera belakang.

## Peta lebih luas & kontur naik-turun
- Peta diperluas ke barat (6200 × 8400 px). Simpanan lama otomatis digeser sehingga tetap bisa dilanjutkan.
- **Jl. Raya Salatiga–Kopeng**: sambungan Jl. Lingkar Selatan ke barat, berkelok-kelok menanjak (tanjakan maks ±10 %)
  sampai **Kopeng** di lereng Merbabu: hutan pinus, **Taman Wisata Kopeng** (tahan A untuk duduk menikmati udara sejuk),
  dan **Warung Kopeng**. Gunung Merbabu terlihat di barat laut.
- Tanah, jalan, bangunan, dan kendaraan ikut naik-turun. Tanjakan memperlambat, turunan mempercepat (gigi N pun bisa
  menggelinding). Panel kiri bawah menampilkan ⛰️↑ / ⛰️↓ saat menanjak / menurun.
- **Jl. Raya Suruh** (barat) menuju **AMP aspal**, dan di selatannya ada **lahan kosong** yang luas.

## Asphalt paver, dump truck & AMP
1. Ke **AMP Aspal Suruh** (ikon 🏗️ di radar). Di sana ada Dump Truck 1, Dump Truck 2, dan **Asphalt Paver**.
2. Naik dump truck, parkir di **bawah silo hotmix** (kotak kuning), lalu tekan **A** untuk memuat hotmix
   (Rp 2.000.000 per truk, ±4 detik).
3. Bawa paver ke lahan kosong. Mundurkan dump truck **lurus** sampai bak belakang menempel **hopper depan paver**,
   lalu tekan **A**: bak terangkat dan hotmix dituang. Setelah itu dump truck otomatis maju sedikit.
4. Naik paver (Y), tekan **A** untuk menurunkan screed, lalu maju pelan. Kecepatan paver dibatasi
   sekitar 11 km/j di jalan dan 8 km/j di off-road. Jalan aspal selebar 7 m terbentuk
   di belakang paver. **1 truk hotmix ≈ 100 m jalan**, dibayar Rp 40.000 per meter.
5. Jalan hanya terbentuk di **lahan kosong**. Saat melewati jalan, halaman, atau sawah, ruas terputus lalu lanjut lagi.
   Tekan A untuk berhenti.
6. Setiap ruas yang selesai **disimpan ke `settings.json`** (`builtRoads`) di server, jadi tetap ada setelah game
   ditutup atau main baru. Jalan buatan bisa dilalui (kendaraan lebih cepat di aspal) dan tampil di radar & peta.
   Untuk mengosongkan lahan lagi, hapus isi `builtRoads` di `settings.json` (atau kirim `DELETE /api/roads`).

## Mobil tangki BBM
**Layanan antar BBM (mobil tangki menghampiri kendaraan)**
- Saat kendaraan berhenti, **tahan X / klakson ±1 detik** (keyboard: **G**). Saat jalan kaki, tekan **X** di dekat
  kendaraan. Mobil tangki berangkat dari SPBU terdekat (Tingkir atau Tengaran).
- Mobil tangki mencari rute terpendek lewat jaringan jalan, melaju di lajur kiri, dan berhenti kalau ada kendaraan
  atau orang di depannya. Rutenya tampil sebagai garis oranye di radar, dan jaraknya di layar.
- Setelah tiba, mobil tangki parkir di samping kendaraan dan mengisi lewat selang (±18 L/detik) sampai penuh.
  Jangan jalankan kendaraan selama pengisian. Mobil tangki lalu kembali ke SPBU.
- Biaya: ongkos antar Rp 75.000 + harga BBM per liter (Solar Rp 6.800, Pertalite Rp 10.000).

**Truk Tangki BBM yang bisa disetir sendiri** (parkir di halaman rumah sopir)
- Punya 2 kompartemen, Solar dan Pertalite, masing-masing maks 3.000 L.
- Dekati kendaraan lain, berhenti, lalu tekan **A**: selang terpasang dan BBM yang sesuai mengalir sampai penuh
  (gratis, karena BBM-nya sudah dibeli). Tekan A lagi untuk melepas selang.
- Isi ulang kompartemen di SPBU: parkir truk tangki di samping pompa, turun, lalu **tahan A**. Tangki truk sendiri
  diisi dulu, setelah itu kompartemen Solar, lalu Pertalite.
- Konsumsi & kapasitas bisa diatur di `static/game.js`: `SPECS.tanker`, `CARGO_MAX`, `HOSE_RATE`, `DELIVERY_FEE`, `FUEL_PRICE`.

## Bantuan docking trailer
- Garis zona tujuan di pabrik kini selalu terlihat di 3D. Sebelumnya garis tertutup lantai halaman.
  - Garis kuning = zona misi aktif, berubah hijau saat trailer sudah pas.
  - Ada tiang di keempat sudut zona; tiang merah menandai ujung dalam (sisi dinding pabrik).
- **Panel docking** muncul otomatis di tengah atas layar:
  - **🔗 Sambung trailer** (truk mundur ke trailer di dock): denah fifth wheel ↔ kingpin, jarak yang masih
    kurang, dan sudut. Status **✅ OK — tekan A** saat sudah tepat.
  - **🅿️ Parkir trailer** (dekat zona tujuan): denah zona + trailer + truk, berapa meter trailer belum masuk,
    kemiringan, dan perkiraan presisi (memengaruhi skor). Status **✅ OK — tekan A untuk lepas trailer**.
- Sensor parkir: saat mundur (gigi R) terdengar bip yang makin rapat saat makin dekat, lalu nada "ding-dong" ketika OK.
