'use strict';
/* Spesifikasi dasar kendaraan: dipakai game.js DAN editor kendaraan (/vehicle-editor).
 * origin = as roda belakang, sumbu x ke depan. Satuan: px (10 px = 1 m), px/detik, radian. */
window.VEH_SPECS = (() => {
  const DEG = Math.PI / 180;
  return {
    tractor: { wb: 44, front: 60, rear: -16, hw: 20, fifth: 4, door: 46, maxSteer: 34 * DEG, vf: 150, vr: 55, acc: 120,
      tank: 500, burn: 0.040, fuelName: 'Solar', price: 6800, canTow: true },
    car: { wb: 30, front: 40, rear: -10, hw: 11, fifth: 0, door: 14, maxSteer: 36 * DEG, vf: 200, vr: 60, acc: 170,
      tank: 40, burn: 0.010, fuelName: 'Pertalite', price: 10000, canTow: false },
    box: { wb: 48, front: 64, rear: -22, hw: 16, fifth: 0, door: 50, maxSteer: 32 * DEG, vf: 120, vr: 40, acc: 90,
      tank: 100, burn: 0.02, fuelName: 'Solar', price: 6800, canTow: false },
    // truk mini engkel (bak kayu terbuka), mis. truk ringan 4 roda
    minitruck: { wb: 34, front: 54, rear: -20, hw: 15, fifth: 0, door: 42, maxSteer: 34 * DEG, vf: 140, vr: 45, acc: 105,
      tank: 70, burn: 0.016, fuelName: 'Solar', price: 6800, canTow: false },
    // sepeda motor (bebek / matic): ringan, lincah, irit; mundur hanya didorong pelan; dilarang masuk tol
    motor: { wb: 14, front: 19, rear: -5, hw: 4, fifth: 0, door: 7, maxSteer: 32 * DEG, vf: 175, vr: 14, acc: 200,
      tank: 5, burn: 0.0025, fuelName: 'Pertalite', price: 10000, canTow: false },
    // dump truck 3 sumbu dengan bak jungkit: angkut hotmix dari AMP ke paver
    dump: { wb: 42, front: 60, rear: -26, hw: 15, fifth: 0, door: 48, maxSteer: 36 * DEG, vf: 180, vr: 50, acc: 150,
      tank: 120, burn: 0.024, fuelName: 'Solar', price: 6800, canTow: false, grip: 1, offroadMaxSpeed: 120 },
    // asphalt paver (finisher): lambat, beroda rantai, hopper di depan, screed di belakang
    // truk tangki BBM: 2 kompartemen (Solar & Pertalite) untuk mengisi kendaraan lain lewat selang
    tanker: { wb: 44, front: 62, rear: -24, hw: 15, fifth: 0, door: 50, maxSteer: 32 * DEG, vf: 125, vr: 40, acc: 92,
      tank: 100, burn: 0.02, fuelName: 'Solar', price: 6800, canTow: false, grip: 0.6 },
    // road milling machine Sakai ER 550F: kupas (hapus) aspal jalan buatan; drum di tengah badan (drum = jarak dari as belakang)
    milling: { wb: 24, front: 40, rear: -30, hw: 15, fifth: 0, door: -4, maxSteer: 35 * DEG, vf: 130, vr: 40, acc: 70, drum: -6, climb: 0.25,   // climb: pengali gaya tanjakan (1 = normal; kecil = kuat nanjak, torsi crawler)
     
      tank: 140, burn: 0.001, fuelName: 'Solar', price: 6800, canTow: false, grip: 1, offroadMaxSpeed: 80 },
    paver: { wb: 26, front: 30, rear: -36, hw: 16, fifth: 0, door: -6, maxSteer: 35 * DEG, vf: 150, vr: 40, acc: 45,
      tank: 160, burn: 0.001, fuelName: 'Solar', price: 6800, canTow: false, grip: 1, offroadMaxSpeed: 80 },
    helicopter: { wb: 28, front: 30, rear: -38, hw: 17, fifth: 0, door: 8, maxSteer: 38 * DEG,
      vf: 600, vr: 50, acc: 100, tank: 120, burn: 0.16, fuelName: 'Avtur', price: 15000,
      canTow: false, grip: 0.9, maxAlt: 1500, climbRate: 65 },
    falcon: { wb: 30, front: 20, rear: -20, hw: 16, fifth: 0, door: 0, maxSteer: 38 * DEG,
      vf: 420, vr: 100, acc: 100, tank: 180, burn: 0.4, fuelName: 'Avtur', price: 18000,
      canTow: false, grip: 0.9, maxAlt: 20000, climbRate: 150 },
    // pesawat perintis / latih: sayap lebar, baling-baling, bisa taksi dan lepas landas
    plane: { 
      wb: 32, front: 42, rear: -48, hw: 64, fifth: 0, door: 12, maxSteer: 28 * DEG, 
      vf: 600, vr: 50, acc: 180, tank: 150, burn: 0.35, fuelName: 'Avtur', price: 15000, 
      canTow: false, grip: 0.9,
      // Parameter Penerbangan Baru:
      vTakeoff: 60, // Kecepatan minimal (px/s) untuk bisa lepas landas (V1/VR)
      v0: 80,
      maxAlt: 2500,   // Ketinggian terbang maksimum (px/z-height)
      climbRate: 80  // Kecepatan naik/turun altitude per detik
    },
  };
})();
