"""
Peta diperluas: peta Salatiga–Tengaran (level_salatiga.py) digeser ke timur sejauh DX, lalu
di sebelah barat ditambah wilayah baru berkontur (naik-turun):

  * Jl. Raya Salatiga–Kopeng — sambungan Jl. Lingkar Selatan, berkelok-kelok menanjak ke Kopeng
    (lereng Merbabu, kawasan hutan pinus, Taman Wisata Kopeng, Warung Kopeng).
  * Jl. Raya Suruh (barat) — sambungan Jl. Suruh menuju AMP (Asphalt Mixing Plant).
  * AMP aspal: tempat dump truck memuat hotmix; asphalt paver & dump truck parkir di sini.
  * Lahan kosong luas di selatan AMP: tempat membangun jalan sendiri dengan asphalt paver.

Ketinggian tanah dikirim ke browser sebagai grid (terrain), dipakai render 3D (tanah, jalan,
bangunan, kendaraan ikut naik-turun) dan fisika (tanjakan memperlambat, turunan mempercepat).
"""
import copy
import math
import random

import level_salatiga as base

OLD = base.LEVEL
DX = OLD["world"]["h"] - OLD["world"]["w"]  # perluasan barat agar lebar peta sama dengan tingginya
W, H = OLD["world"]["w"] + DX, OLD["world"]["h"]
rng = random.Random(23)

LEVEL = copy.deepcopy(OLD)

# ----------------------------------------------------------------------------- geser peta lama ke timur
X_KEYS = {"x", "x0", "x1", "sx", "px"}


def _shift(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in X_KEYS and isinstance(v, (int, float)):
                o[k] = round(v + DX, 1) if isinstance(v, float) else v + DX
            elif k == "pts" and isinstance(v, list):
                for p in v:
                    p[0] = round(p[0] + DX, 1)
            else:
                _shift(v)
    elif isinstance(o, list):
        for v in o:
            _shift(v)


for key, val in LEVEL.items():
    if key in ("world", "tollFare", "signalCycle", "money", "clockStart", "name", "traffic"):
        continue
    _shift(val)
LEVEL["world"] = {"w": W, "h": H}
LEVEL["worldDX"] = DX           # simpanan lama (sebelum peta diperluas) digeser sejauh ini saat dimuat

roads, pads, obstacles, places, labels, regions, decor, vehicles, traffic = (
    LEVEL["roads"], LEVEL["pads"], LEVEL["obstacles"], LEVEL["places"], LEVEL["labels"],
    LEVEL["regions"], LEVEL["decor"], LEVEL["vehicles"], LEVEL["traffic"])

catmull, poly_dist, rect = base.catmull, base.poly_dist, base.rect

# ----------------------------------------------------------------------------- jalan baru
KOPENG_CTRL = [(DX, 1950), (DX - 260, 1935), (DX - 560, 1870), (DX - 820, 1740), (DX - 1060, 1640),
               (DX - 1250, 1500), (DX - 1200, 1300), (DX - 1320, 1160), (DX - 1690, 1500), (DX - 1850, 1120),
               (DX - 1760, 900), (DX - 1960, 600), (DX - 2220, 820), (DX - 2450, 700), (DX - 2700, 520),
               (DX - 2950, 460), (60, 580)]
KOPENG = catmull([list(p) for p in KOPENG_CTRL], 26)
SURUH_CTRL = [(DX, 3320), (DX - 300, 3335), (DX - 620, 3410), (DX - 950, 3455), (DX - 1300, 3440),
              (DX - 1650, 3480), (DX - 2000, 3560), (DX - 2400, 3610), (DX - 2800, 3700), (60, 3760)]
SURUH_W = catmull([list(p) for p in SURUH_CTRL], 30)
# jalan desa di Kopeng (menuju taman wisata)
KP_X, KP_Y = 760, 640           # pusat Kopeng
DESA_CTRL = [(KP_X - 10, 600), (KP_X - 30, 430), (KP_X + 60, 300), (KP_X + 40, 160)]
DESA = catmull([list(p) for p in DESA_CTRL], 24)

roads += [
    {"id": "kopeng", "name": "Jl. Raya Salatiga–Kopeng", "w": 100, "kind": "local", "pts": KOPENG},
    {"id": "suruh-barat", "name": "Jl. Raya Suruh", "w": 100, "kind": "local", "pts": SURUH_W},
    {"id": "desa-kopeng", "name": "Jl. Wisata Kopeng", "w": 80, "kind": "local", "pts": DESA},
    {"id": "akses-bandara", "name": "Jl. Akses Bandara", "w": 90, "kind": "local", "pts": [[1400, 3440], [1400, 4200], [1400, 4960]]},
]
NEW_ROADS = roads[-4:]

regions[:0] = [                 # di depan: regionAt() memakai kecocokan pertama
    {"name": "Kopeng, Getasan", "x0": 0, "x1": 1500, "y0": 0, "y1": 1300},
    {"name": "Sumogawe, Getasan", "x0": 1500, "x1": DX, "y0": 0, "y1": 2300},
    {"name": "Tajuk, Getasan", "x0": 0, "x1": 1500, "y0": 1300, "y1": 2300},
    {"name": "Plumbon, Suruh", "x0": 0, "x1": DX, "y0": 2300, "y1": 3900},
    {"name": "Lahan proyek Suruh", "x0": 0, "x1": DX, "y0": 3900, "y1": H},
]


def near_road(x, y, margin):
    return any(poly_dist(x, y, r["pts"]) < r["w"] / 2 + margin for r in NEW_ROADS)


# ----------------------------------------------------------------------------- AMP aspal
AMP_X, AMP_Y = DX - 1700, 3060                      # pojok kiri-atas halaman AMP
AMP_W, AMP_H = 560, 340
pads.append(rect(AMP_X, AMP_Y, AMP_W, AMP_H, "amp"))
obstacles.append(rect(AMP_X + 20, AMP_Y + 30, 200, 120, "amp", "AMP — ASPHALT MIXING PLANT"))      # drum, menara, tangki
obstacles.append(rect(AMP_X + 330, AMP_Y + 26, 70, 70, "stockpile", color="#9ca3af"))            # tumpukan agregat
obstacles.append(rect(AMP_X + 420, AMP_Y + 26, 70, 70, "stockpile", color="#78716c"))
obstacles.append(rect(AMP_X + 20, AMP_Y + 210, 120, 70, "building", "KANTOR AMP"))
CHUTE = {"x": AMP_X + 238, "y": AMP_Y + 40, "w": 66, "h": 120}                           # jalur di bawah silo
decor.append({"kind": "ampsilo", "x": CHUTE["x"], "y": CHUTE["y"], "w": CHUTE["w"], "h": CHUTE["h"], "label": "SILO HOTMIX"})
places.append({"kind": "amp", "id": "amp-silo", "label": "Silo Hotmix AMP", "x": CHUTE["x"] + CHUTE["w"] // 2,
               "y": CHUTE["y"] + CHUTE["h"] // 2, "r": 50})
labels.append({"text": "AMP ASPAL SURUH", "x": AMP_X + AMP_W / 2, "y": AMP_Y - 18, "size": 24})
LEVEL["amp"] = {"chute": CHUTE, "price": 2_000_000, "payPerMeter": 40_000, "millPerMeter": 25_000, "loadLen": 1000, "paveW": 70}
# Base vehicles at AMP
vehicles += [
    {"id": "dump-1", "name": "Dump Truck 1", "type": "dump", "color": "#f59e0b",
     "x": AMP_X + 271, "y": AMP_Y + 300, "angle": -90, "fuel": 0.7},
    {"id": "dump-2", "name": "Dump Truck 2", "type": "dump", "color": "#dc2626",
     "x": AMP_X + 361, "y": AMP_Y + 300, "angle": -90, "fuel": 0.6},
    {"id": "paver", "name": "Asphalt Paver", "type": "paver", "color": "#facc15",
     "x": AMP_X + 470, "y": AMP_Y + 200, "angle": -90, "fuel": 0.8},
    {"id": "milling", "name": "Road Milling Sakai ER 550F", "type": "milling", "color": "#f59e0b",
     "x": AMP_X + 470, "y": AMP_Y + 290, "angle": -90, "fuel": 0.8},
]

# -----------------------------------------------------------------------------
# Garasi kendaraan: muat semua kendaraan dari file JSON di folder static/vehicles
# Garasi diletakkan di area apron dekat bandara (x≈1400, y≈5400). Setiap kendaraan
# ditempatkan berjarak 30px secara grid untuk menghindari tumpang tindih.
import os, json

def _load_garage_vehicles():
    base_dir = os.path.dirname(__file__)  # folder proyek
    veh_dir = os.path.join(base_dir, 'static', 'vehicles')
    if not os.path.isdir(veh_dir):
        return []
    files = [f for f in os.listdir(veh_dir) if f.lower().endswith('.json')]
    garage_x, garage_y = 1400, 5400  # koordinat pusat garasi dekat bandara
    spacing = 30
    loaded = []
    for idx, fn in enumerate(files):
        path = os.path.join(veh_dir, fn)
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception:
            continue
        # `data` dapat berupa dict (satu kendaraan) atau list (banyak kendaraan)
        vehicles_data = data if isinstance(data, list) else [data]
        for v in vehicles_data:
            if not isinstance(v, dict):
                continue
            # Pastikan ada id unik
            if 'id' not in v:
                v['id'] = f"garage-{idx}"
            # Tempatkan di garasi
            v['x'] = garage_x + (len(loaded) % 5) * spacing
            v['y'] = garage_y + (len(loaded) // 5) * spacing
            v.setdefault('angle', 0)
            loaded.append(v)
    return loaded

vehicles.extend(_load_garage_vehicles())

# ----------------------------------------------------------------------------- Kopeng
pads.append(rect(KP_X - 30, 140, 300, 170, "plaza"))                               # Taman Wisata Kopeng
places.append({"kind": "wisata", "id": "taman-kopeng", "label": "Taman Wisata Kopeng", "x": KP_X + 120, "y": 225, "r": 60})
labels.append({"text": "TAMAN WISATA KOPENG", "x": KP_X + 120, "y": 120, "size": 22})
labels.append({"text": "KOPENG", "x": KP_X - 120, "y": 760, "size": 30})
labels.append({"text": "↖ GUNUNG MERBABU", "x": 260, "y": 380, "size": 22})
labels.append({"text": "LAHAN KOSONG — bangun jalan dengan asphalt paver", "x": DX / 2, "y": 4300, "size": 26})
# warung di tepi jalan Kopeng
WK = (KP_X + 150, 700)
pads.append(rect(WK[0] - 60, WK[1] + 52, 130, 50, "warung"))
obstacles.append(rect(WK[0] - 55, WK[1] - 18, 120, 70, "warung", "WARUNG KOPENG"))
places.append({"kind": "warung", "label": "Warung Kopeng", "interior": "warung", "x": WK[0] + 5, "y": WK[1] + 50, "r": 40})

# --- Gedung Kopdes (Koperasi Desa) di tepi Jl. Raya Suruh / Plumbon
KOPDES_X, KOPDES_Y = DX - 1100, 3330
pads.append(rect(KOPDES_X - 15, KOPDES_Y - 115, 250, 150, "paving"))
obstacles.append(rect(KOPDES_X + 15, KOPDES_Y - 105, 190, 85, "building", "GEDUNG KOPDES", color="#8F0000"))
places.append({"kind": "kopdes", "id": "kopdes-plumbon", "label": "Gedung Kopdes", "interior": "kopdes",
               "x": KOPDES_X + 110, "y": KOPDES_Y - 5, "r": 48})
labels.append({"text": "GEDUNG KOPDES (KOPERASI DESA)", "x": KOPDES_X + 110, "y": KOPDES_Y - 120, "size": 20})

# --- Gedung PT Formulatrix Indonesia (Pusat Robotika & Lab Automation)
# Geser FMX_Y dari 3340 menjadi 3440 agar tidak menimpa jalan di sebelah utaranya
FMX_X, FMX_Y = DX - 580, 3140
pads.append(rect(FMX_X - 10, FMX_Y - 130, 320, 170, "paving"))
obstacles.append(rect(FMX_X + 10, FMX_Y - 120, 260, 95, "building", "PT FORMULATRIX INDONESIA", color="#0284c7"))
places.append({"kind": "formulatrix", "id": "fmx-salatiga", "label": "PT Formulatrix Indonesia", "interior": "formulatrix",
               "x": FMX_X + 140, "y": FMX_Y - 5, "r": 55})
labels.append({"text": "PT FORMULATRIX INDONESIA (ROBOTICS & LAB AUTOMATION)", "x": FMX_X + 140, "y": FMX_Y - 135, "size": 19})


# --- Gedung PT Formulatrix Indonesia (Pusat Robotika & Lab Automation)
FMX_X, FMX_Y = DX - 580, 3340
pads.append(rect(FMX_X - 20, FMX_Y - 130, 320, 170, "paving"))
obstacles.append(rect(FMX_X + 10, FMX_Y - 120, 260, 95, "building", "PT FORMULATRIX INDONESIA", color="#0284c7"))
places.append({"kind": "formulatrix", "id": "fmx-salatiga", "label": "PT Formulatrix Indonesia", "interior": "formulatrix",
               "x": FMX_X + 140, "y": FMX_Y - 10, "r": 55})
labels.append({"text": "PT FORMULATRIX INDONESIA (ROBOTICS & LAB AUTOMATION)", "x": FMX_X + 140, "y": FMX_Y - 135, "size": 19})

# --- Bandara Perintis Salatiga & Landasan Pacu (Runway 09-27)
RN_X0, RN_X1 = 450, 2350
RN_Y, RN_W = 5600, 110
pads.append(rect(RN_X0, RN_Y - RN_W // 2, RN_X1 - RN_X0, RN_W, "asphalt"))
decor.append({"kind": "runway", "x": RN_X0, "y": RN_Y - RN_W // 2, "w": RN_X1 - RN_X0, "h": RN_W, "label": "RUNWAY 09-27"})

# Taxiway & Apron (pelataran parkir pesawat & terminal)
pads.append(rect(1350, 5260, 170, 285, "asphalt"))
pads.append(rect(1150, 4960, 540, 300, "asphalt"))

# Gedung Terminal, Menara ATC, Hanggar Pesawat
obstacles.append(rect(1170, 4980, 200, 80, "building", "TERMINAL BANDARA SALATIGA", color="#1e3a8a"))
obstacles.append(rect(1390, 4980, 60, 60, "building", "MENARA ATC", color="#f8fafc"))
obstacles.append(rect(1470, 4980, 180, 110, "building", "HANGGAR PESAWAT", color="#374151"))
decor.append({"kind": "hangar", "x": 1470, "y": 4980, "w": 180, "h": 110, "label": "HANGGAR PESAWAT"})

places.append({"kind": "airport", "id": "bandara-salatiga", "label": "Bandara Perintis Salatiga", "x": 1380, "y": 5120, "r": 85})
labels.append({"text": "BANDARA PERINTIS SALATIGA", "x": 1400, "y": 4940, "size": 24})
labels.append({"text": "LANDASAN PACU 09 - 27", "x": 1400, "y": 5625, "size": 18})
labels.append({"text": "SPACEX FALCON 9", "x": 1450, "y": 5315, "size": 16})

# Pesawat yang bisa dinaiki & diterbangkan
vehicles += [
    {"id": "pesawat-1", "name": "Pesawat Cessna 172", "type": "plane", "color": "#f8fafc",
     "x": 1280, "y": 5150, "angle": 90, "fuel": 1.0},
    {"id": "pesawat-2", "name": "Pesawat Latih Kuning", "type": "plane", "color": "#facc15",
     "x": 1460, "y": 5150, "angle": 90, "fuel": 1.0},
    {"id": "helikopter-1", "name": "Helikopter Bandara", "type": "helicopter", "color": "#facc15",
     "x": 1600, "y": 5160, "angle": 90, "fuel": 1.0},
    {"id": "su57-bandara", "name": "Sukhoi Su-57", "type": "plane", "model": "su57", "color": "#64748b",
     "x": 1800, "y": 5525, "angle": 0, "fuel": 1.0,
     "wb": 34, "front": 54, "rear": -48, "hw": 48, "door": 14,
     "acc": 240, "vf": 900, "vr": 120, "vTakeoff": 110, "v0": 120, "maxAlt": 4000, "climbRate": 140},
    {"id": "falcon-9", "name": "SpaceX Falcon 9", "type": "falcon", "color": "#f1f5f9",
     "x": 1450, "y": 5400, "angle": 0, "fuel": 1.0},
]

# Rumah paling selatan dekat akses keluar GT Boyolali, dengan MAN HX 8x8 di carport.
toll_home_clearance = (6500, 7970, 7350, 8395)
roads.append({"id": "akses-rumah-tol", "name": "Akses Rumah GT Boyolali", "w": 72, "kind": "local",
              "pts": [[6548, 8012], [6548, 8030], [6820, 8030], [6820, 8310]]})
pads.append(rect(6775, 8205, 520, 185, "driveway"))
obstacles.append(rect(6940, 8225, 220, 96, "house", "RUMAH GT BOYOLALI", color="#166534", home="rumah-tol"))
places.append({"kind": "house", "id": "rumah-tol", "theme": "sopir", "interior": "rumah", "label": "Rumah GT Boyolali",
               "x": 7050, "y": 8342, "r": 40, "door": {"x": 7050, "y": 8342}})
vehicles.append({"id": "man-hx-8x8", "name": "MAN HX 8x8", "type": "box", "model": "manhx8x8", "color": "#3f6212",
                 "x": 6840, "y": 8332, "angle": 0, "fuel": 0.8,
                 "wb": 42, "front": 68, "rear": -58, "hw": 24, "door": 48,
                 "vf": 300, "acc": 500, "maxSteer": 38 * math.pi / 180, "grip": 1.0, "damageRate": 0.05,
                 "tank": 300, "canTow": True, "canTowVehicle": True, "fifth": -54})

taken = [(AMP_X - 20, AMP_Y - 20, AMP_X + AMP_W + 20, AMP_Y + AMP_H + 20),
         (KP_X - 50, 120, KP_X + 290, 330),
         (WK[0] - 70, WK[1] - 30, WK[0] + 80, WK[1] + 110),
         (KOPDES_X - 30, KOPDES_Y - 130, KOPDES_X + 260, KOPDES_Y + 40),
         (FMX_X - 40, FMX_Y - 150, FMX_X + 330, FMX_Y + 50),  # Otomatis ikut bergeser karena menggunakan FMX_Y
         (FMX_X - 40, FMX_Y - 150, FMX_X + 330, FMX_Y + 50),
         (RN_X0 - 40, 4900, RN_X1 + 40, 5700),
         toll_home_clearance]


def free(x0, y0, x1, y1, pad=10):
    for (a, b, c, d) in taken:
        if x0 < c + pad and x1 > a - pad and y0 < d + pad and y1 > b - pad:
            return False
    return not near_road((x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) / 2 + 14)


ROOFS = ["#7c2d12", "#9a3412", "#475569", "#b45309", "#1f2937"]
for (x, y, ux, uy) in base.walk(KOPENG, 70):
    if x > DX - 200:
        continue
    village = math.hypot(x - KP_X, y - 640) < 900 or rng.random() < 0.25
    if not village:
        continue
    for side in (-1, 1):
        if rng.random() < 0.35:
            continue
        w, h = rng.uniform(44, 70), rng.uniform(36, 54)
        off = 50 + 26 + max(w, h) / 2 + rng.uniform(0, 14)
        cx, cy = x - uy * side * off, y + ux * side * off
        if 20 < cx < DX - 30 and 20 < cy < H - 20 and free(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2):
            obstacles.append(rect(cx - w / 2, cy - h / 2, w, h, "house", color=rng.choice(ROOFS)))
            taken.append((cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2))

# hutan pinus di lereng (makin rapat makin ke barat laut), pohon biasa di dataran selatan
pines = 0
for _ in range(9000):
    if pines >= 520:
        break
    x, y = rng.uniform(30, DX - 120), rng.uniform(30, 3000)
    dens = max(0.0, 1.1 - math.hypot(x - 300, y - 300) / 2600)
    if rng.random() > dens or not free(x - 12, y - 12, x + 12, y + 12, 6):
        continue
    obstacles.append(rect(x - 10, y - 10, 20, 20, "pine"))
    taken.append((x - 12, y - 12, x + 12, y + 12))
    pines += 1
trees = 0
for _ in range(3000):
    if trees >= 90:
        break
    x, y = rng.uniform(40, DX - 140), rng.uniform(3900, H - 60)
    # sebagian besar lahan dibiarkan kosong: pohon hanya di tepi barat & dekat jalan
    if 300 < x < DX - 300 and y > 4100 and rng.random() < 0.85:
        continue
    if free(x - 16, y - 16, x + 16, y + 16, 10):
        obstacles.append(rect(x - 15, y - 15, 30, 30, "tree"))
        taken.append((x - 16, y - 16, x + 16, y + 16))
        trees += 1

# lalu lintas di jalan baru
traffic += [
    {"type": "car", "color": "#0ea5e9", "road": "kopeng", "dir": 1, "t": 0.2},
    {"type": "motor", "model": "bebek", "color": "#dc2626", "road": "kopeng", "dir": -1, "t": 0.45},
    {"type": "minitruck", "color": "#16a34a", "road": "kopeng", "dir": 1, "t": 0.7},
    {"type": "car", "color": "#f8fafc", "road": "kopeng", "dir": -1, "t": 0.85, **base.PICKUP_SPEC},
    {"type": "motor", "model": "matic", "color": "#7c3aed", "road": "suruh-barat", "dir": 1, "t": 0.3},
    {"type": "box", "color": "#e2e8f0", "road": "suruh-barat", "dir": -1, "t": 0.6},
]

# ----------------------------------------------------------------------------- kontur (tinggi tanah)
CELL = 40
NX, NY = DX // CELL + 1, H // CELL + 1


def smooth01(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def natural(x, y):
    massif = 470 * math.exp(-(((x - 150) / 1500) ** 2 + ((y - 250) / 1350) ** 2))       # lereng Merbabu
    ridge = 55 * (0.5 + 0.5 * math.sin(x / 260 + 0.7) * math.sin(y / 310 + 1.9)) * math.exp(-((y - 900) / 1900) ** 2)
    roll = 26 * (1 + math.sin(x / 520 + 1.3) * math.cos(y / 430 + 0.4)) * smooth01((y - 2600) / 900)  # dataran bergelombang
    east = smooth01((DX - x) / 650)                 # 0 di batas peta lama (tetap datar)
    return max(0.0, (massif + ridge + roll) * east)


grid = [[natural(i * CELL, j * CELL) for i in range(NX)] for j in range(NY)]


def grid_at(x, y):
    fx, fy = max(0, min(NX - 1.001, x / CELL)), max(0, min(NY - 1.001, y / CELL))
    i, j = int(fx), int(fy)
    tx, ty = fx - i, fy - j
    a, b, c, d = grid[j][i], grid[j][i + 1], grid[j + 1][i], grid[j + 1][i + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def road_profile(pts, h_end_east=0.0, max_grade=0.105):
    """tinggi jalan di tiap titik: tanah alami yang dihaluskan + batas kemiringan."""
    hs = [natural(x, y) for x, y in pts]
    s = [0.0]
    for i in range(1, len(pts)):
        s.append(s[-1] + math.dist(pts[i - 1], pts[i]))
    sm = []
    for i in range(len(pts)):                       # rata-rata bergerak ±300 px
        acc = wsum = 0.0
        for k in range(len(pts)):
            d = abs(s[k] - s[i])
            if d < 300:
                wgt = 1 - d / 300
                acc += hs[k] * wgt
                wsum += wgt
        sm.append(acc / wsum)
    for i, (x, y) in enumerate(pts):                # tepat 0 di sambungan dengan peta lama
        if x >= DX - 5:
            sm[i] = h_end_east
    for _ in range(3):                              # batasi tanjakan
        for i in range(1, len(pts)):
            lim = (s[i] - s[i - 1]) * max_grade
            sm[i] = max(sm[i - 1] - lim, min(sm[i - 1] + lim, sm[i]))
        for i in range(len(pts) - 2, -1, -1):
            lim = (s[i + 1] - s[i]) * max_grade
            sm[i] = max(sm[i + 1] - lim, min(sm[i + 1] + lim, sm[i]))
    return sm


best_d = [[1e9] * NX for _ in range(NY)]
best_h = [[0.0] * NX for _ in range(NY)]
best_w = [[0.0] * NX for _ in range(NY)]
for r in NEW_ROADS:
    prof = road_profile(r["pts"])
    r["h"] = [round(v, 1) for v in prof]
    reach = r["w"] / 2 + 140
    for k in range(len(r["pts"]) - 1):
        (ax, ay), (bx, by) = r["pts"][k], r["pts"][k + 1]
        ha, hb = prof[k], prof[k + 1]
        i0, i1 = max(0, int((min(ax, bx) - reach) / CELL)), min(NX - 1, int((max(ax, bx) + reach) / CELL) + 1)
        j0, j1 = max(0, int((min(ay, by) - reach) / CELL)), min(NY - 1, int((max(ay, by) + reach) / CELL) + 1)
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy or 1e-9
        for j in range(j0, j1 + 1):
            py = j * CELL
            for i in range(i0, i1 + 1):
                px = i * CELL
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
                if d < best_d[j][i]:
                    best_d[j][i], best_h[j][i], best_w[j][i] = d, ha + (hb - ha) * t, r["w"]
for j in range(NY):
    for i in range(NX):
        d = best_d[j][i]
        if d < 1e8:
            t = smooth01((d - (best_w[j][i] / 2 + 18)) / 120)
            grid[j][i] = best_h[j][i] * (1 - t) + grid[j][i] * t

# halaman/bangunan diratakan (AMP, taman, warung, rumah)
flats = [(p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"]) for p in pads if p["x"] < DX]
flats += [(o["x"], o["y"], o["x"] + o["w"], o["y"] + o["h"]) for o in obstacles if o["x"] < DX and o["kind"] in ("house", "warung", "amp", "building", "stockpile")]
for (x0, y0, x1, y1) in flats:
    target = grid_at((x0 + x1) / 2, (y0 + y1) / 2)
    m = 60
    for j in range(max(0, int((y0 - m) / CELL)), min(NY - 1, int((y1 + m) / CELL) + 1) + 1):
        for i in range(max(0, int((x0 - m) / CELL)), min(NX - 1, int((x1 + m) / CELL) + 1) + 1):
            px, py = i * CELL, j * CELL
            d = math.hypot(max(x0 - px, 0, px - x1), max(y0 - py, 0, py - y1))
            t = smooth01(d / m)
            grid[j][i] = target * (1 - t) + grid[j][i] * t

LEVEL["terrain"] = {"x0": 0, "y0": 0, "cell": CELL, "nx": NX, "ny": NY,
                    "h": [round(v, 1) for row in grid for v in row]}

# tempat & label tinggi untuk informasi
LEVEL["regions"] = regions
LEVEL["spawn"] = LEVEL["spawn"]

if __name__ == "__main__":
    hs = LEVEL["terrain"]["h"]
    print("world", LEVEL["world"], "terrain", NX, NY, "max h", max(hs))
    print("kopeng road h", LEVEL["roads"][-3]["h"][::10])
    print("pines", pines, "trees", trees, "obstacles", len(obstacles))
