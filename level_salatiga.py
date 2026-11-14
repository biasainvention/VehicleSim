"""
Peta rute Salatiga -> Tengaran (disederhanakan & jarak dipadatkan).

Utara di atas. Jalan utama (jalur nasional Semarang-Solo) turun dari Kota Salatiga
lewat Tingkir, lalu masuk Kecamatan Tengaran (Klero, Pasar Kembangsari, kawasan
pabrik Desa Butuh) sampai Sruwen di batas Kabupaten Boyolali.

Skala kendaraan 10 px = 1 m, tetapi jarak antar-tempat dipadatkan (~8 km jadi ~0,85 km)
supaya enak dimainkan. Posisi gudang, depo, rumah sopir, SPBU & warung adalah fiktif;
nama jalan & kampung diambil dari tempat nyata di sepanjang rute.
"""
import math
import random

W, H = 3000, 8400
MAIN_W = 240
random.seed(7)


# ----------------------------------------------------------------------------- util
def catmull(points, step=60):
    """Haluskan garis kontrol jadi polyline (Catmull-Rom)."""
    pts = [points[0]] + points + [points[-1]]
    out = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        n = max(2, int(math.dist(p1, p2) / step))
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            xy = []
            for d in range(2):
                xy.append(0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t
                                 + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2
                                 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3))
            out.append([round(xy[0], 1), round(xy[1], 1)])
    out.append([float(points[-1][0]), float(points[-1][1])])
    return out


def seg_dist(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def poly_dist(px, py, pts):
    return min(seg_dist(px, py, pts[i], pts[i + 1]) for i in range(len(pts) - 1))


MAIN_CTRL = [(1500, 0), (1500, 600), (1520, 1000), (1520, 1800), (1600, 2300), (1560, 2800),
             (1500, 3300), (1560, 3900), (1720, 4500), (1740, 5000), (1640, 5500), (1620, 6000),
             (1620, 6500), (1780, 6950), (1780, 7700), (1720, H)]
MAIN = catmull(MAIN_CTRL, 70)


def main_x(y):
    """x tengah jalan utama pada ketinggian y."""
    for i in range(len(MAIN) - 1):
        (x0, y0), (x1, y1) = MAIN[i], MAIN[i + 1]
        if y0 <= y <= y1:
            return x0 + (x1 - x0) * ((y - y0) / (y1 - y0 or 1))
    return MAIN[-1][0]


def main_x_range(y0, y1):
    xs = [main_x(y) for y in range(int(y0), int(y1) + 1, 20)]
    return min(xs), max(xs)


def rect(x, y, w, h, kind, label="", **kw):
    d = {"x": round(x), "y": round(y), "w": round(w), "h": round(h), "kind": kind, "label": label}
    d.update(kw)
    return d


def fence(x0, y0, x1, y1, gaps):
    """Pagar keliling persegi; gaps = {'w': (ya, yb), 'n': (xa, xb), ...}."""
    t = 10
    out = []

    def side(name, a, b, make):
        if name in gaps:
            ga, gb = gaps[name]
            if ga > a:
                out.append(make(a, ga))
            if b > gb:
                out.append(make(gb, b))
        else:
            out.append(make(a, b))

    side("n", x0, x1, lambda a, b: rect(a, y0 - t / 2, b - a, t, "fence"))
    side("s", x0, x1, lambda a, b: rect(a, y1 - t / 2, b - a, t, "fence"))
    side("w", y0, y1, lambda a, b: rect(x0 - t / 2, a, t, b - a, "fence"))
    side("e", y0, y1, lambda a, b: rect(x1 - t / 2, a, t, b - a, "fence"))
    return out


# ----------------------------------------------------------------------------- jalan
roads = [{
    "id": "main", "name": "Jl. Raya Semarang–Solo", "w": MAIN_W, "kind": "main", "pts": MAIN,
    "sections": [
        {"y0": 0, "y1": 2250, "name": "Jl. Jenderal Sudirman"},
        {"y0": 2250, "y1": 4350, "name": "Jl. Raya Salatiga–Solo"},
        {"y0": 4350, "y1": H, "name": "Jl. Raya Solo–Semarang"},
    ],
}]


def add_road(rid, name, ctrl, w, step=60, kind="local"):
    roads.append({"id": rid, "name": name, "w": w, "kind": kind, "pts": catmull(ctrl, step)})


add_road("muwardi", "Jl. Muwardi", [(main_x(450), 450), (1150, 450), (980, 700), (960, 1300),
                                     (1060, 1850), (main_x(2020), 2020)], 100)
add_road("fatmawati", "Jl. Fatmawati", [(main_x(950), 950), (2100, 950), (W, 880)], 100)
add_road("pendem", "Jalan kampung Pendem", [(main_x(2000), 2000), (2300, 2060), (W, 2010)], 90)
add_road("jls", "Jalan Lingkar Selatan", [(main_x(2250), 2250), (1050, 2230), (500, 2100), (0, 1950)], 120)
add_road("suruh", "Jl. Raya Salatiga–Suruh", [(main_x(3450), 3450), (950, 3450), (450, 3360), (0, 3320)], 120)
add_road("tol-akses", "Akses Gerbang Tol Tingkir", [(600, 3390), (600, 3640)], 110)
add_road("tegalwaton", "Jl. Tegalwaton", [(main_x(5350), 5350), (1150, 5320), (850, 5230)], 100)
# Kecamatan Argomulyo (barat-daya Salatiga). Nama jalan diambil dari nama kelurahan; tata letak fiktif.
add_road("cebongan", "Jl. Cebongan", [(110, 1985), (110, 2600), (110, 3330)], 100)
add_road("tegalrejo", "Jl. Tegalrejo", [(110, 3020), (600, 3010), (1100, 3030), (main_x(3020), 3020)], 100)
add_road("noborejo", "Jl. Noborejo", [(1000, 3030), (990, 3240), (950, 3450)], 90)
# Jl. Sukowati (pusat kota, tempat Kumon Sukowati) — jalan penghubung Jl. Jend. Sudirman <-> Jl. Muwardi
add_road("sukowati", "Jl. Sukowati", [(main_x(820), 820), (1250, 822), (968, 818)], 90)

# Jalan Tol Semarang–Solo (dipadatkan): masuk GT Tingkir, menyusur sisi barat, keluar GT Boyolali
# di ujung selatan dekat Sruwen. Jalan tol tidak bersimpangan dengan jalan lain kecuali di gerbangnya.
TOLL_W = 170
TOLL_CTRL = [(600, 3700), (560, 3830), (330, 3950), (120, 4120), (100, 4400), (100, 5600), (100, 6800),
             (110, 7600), (190, 7880), (420, 8000), (900, 8010)]
add_road("tol", "Jalan Tol Semarang–Solo", TOLL_CTRL, TOLL_W, step=50, kind="toll")
roads[-1]["limit"] = 100           # batas kecepatan km/j (rambu)
add_road("tol-keluar", "Akses Gerbang Tol Boyolali", [(1030, 8010), (1300, 8010), (main_x(8012) - 10, 8012)], 120, kind="local")

# ----------------------------------------------------------------------------- area & bangunan
pads, obstacles, places, decor, labels = [], [], [], [], []
reserved = []          # kotak yang tidak boleh diisi rumah/pohon acak


def reserve(x, y, w, h, m=30):
    reserved.append((x - m, y - m, x + w + m, y + h + m))


# --- Gudang Ekspedisi Salatiga (tempat ambil trailer), timur Jl. Jend. Sudirman
gy0, gy1 = 1150, 1770
gx0 = main_x_range(gy0, gy1)[1] + MAIN_W / 2 + 60
gx1 = gx0 + 1040
pads.append(rect(gx0, gy0, gx1 - gx0, gy1 - gy0, "yard"))
obstacles += fence(gx0, gy0, gx1, gy1, {"w": (1385, 1525)})
add_road("akses-gudang", "Akses Gudang Ekspedisi", [(main_x(1455), 1455), (gx0 + 20, 1455)], 140, kind="access")
obstacles.append(rect(gx1 + 5, gy0, 140, gy1 - gy0, "dock", "GUDANG EKSPEDISI"))
reserve(gx0, gy0, gx1 - gx0 + 150, gy1 - gy0)
bays = [{"id": f"Dock {i + 1}", "area": "Gudang Ekspedisi Salatiga", "x": round(gx1 - 146), "y": y, "angle": 180}
        for i, y in enumerate([1250, 1390, 1530, 1670])]
labels.append({"text": "GUDANG EKSPEDISI SALATIGA", "x": (gx0 + gx1) / 2 - 80, "y": gy0 + 40, "size": 26})

# --- Depo kawasan industri Desa Butuh (tujuan), timur jalan
dy0, dy1 = 6960, 7720
dx0 = main_x_range(dy0, dy1)[1] + MAIN_W / 2 + 60
dx1 = min(dx0 + 900, W - 170)
pads.append(rect(dx0, dy0, dx1 - dx0, dy1 - dy0, "yard"))
obstacles += fence(dx0, dy0, dx1, dy1, {"w": (7265, 7405)})
add_road("akses-depo", "Akses Kawasan Industri Butuh", [(main_x(7335), 7335), (dx0 + 20, 7335)], 140, kind="access")
obstacles.append(rect(dx1 + 5, dy0, 150, 330, "factory", "PABRIK GARMEN"))
obstacles.append(rect(dx1 + 5, dy0 + 370, 150, dy1 - dy0 - 370, "factory", "PABRIK KAYU"))
reserve(dx0, dy0, dx1 - dx0 + 160, dy1 - dy0)
zones = [
    {"id": "Garmen A", "x": round(dx1 - 96), "y": 7060, "angle": 180, "w": 184, "h": 56},
    {"id": "Garmen B", "x": round(dx1 - 96), "y": 7220, "angle": 180, "w": 184, "h": 56},
    {"id": "Kayu C", "x": round(dx1 - 96), "y": 7450, "angle": 180, "w": 184, "h": 56},
    {"id": "Kayu D", "x": round(dx1 - 96), "y": 7610, "angle": 180, "w": 184, "h": 56},
]
for z in zones:
    z["area"] = "Kawasan Industri Butuh, Tengaran"
labels.append({"text": "KAWASAN INDUSTRI BUTUH", "x": (dx0 + dx1) / 2 - 60, "y": dy0 + 40, "size": 26})
obstacles.append(rect(dx0 + 80, dy0 + 520, 160, 90, "building", "KANTOR DEPO"))

# --- Rumah sopir (Tingkir), barat jalan
hy0, hy1 = 2480, 2790
hx1 = main_x_range(hy0, hy1)[0] - MAIN_W / 2 + 6
hx0 = hx1 - 430
pads.append(rect(hx0, hy0, hx1 - hx0, hy1 - hy0, "driveway"))
obstacles.append(rect(hx0 + 60, hy0 - 140, 230, 140, "house", "RUMAH SOPIR", color="#9a3412", home="rumah-sopir"))
reserve(hx0, hy0 - 150, hx1 - hx0, hy1 - hy0 + 150)
# pintu rumah ada di sisi selatan (bawah) rumah; "door" = tempat sopir muncul saat keluar rumah
places.append({"kind": "house", "id": "rumah-sopir", "theme": "sopir", "interior": "rumah", "label": "Rumah Sopir",
               "x": round(hx0 + 175), "y": hy0 + 12, "r": 40, "door": {"x": round(hx0 + 175), "y": hy0 + 22}})
spawn = {"x": round(hx0 + 175), "y": hy0 + 24}
vehicles = [
    {"id": "truk-biru", "name": "Truk Biru", "type": "tractor", "color": "#2563eb",
     "x": round(hx0 + 40), "y": hy0 + 80, "angle": 0, "fuel": 0.45},
    {"id": "truk-merah", "name": "Truk Merah", "type": "tractor", "color": "#dc2626",
     "x": round(hx0 + 40), "y": hy0 + 170, "angle": 0, "fuel": 0.30, "acc": 150, "vf": 140, "tank": 160},
    {"id": "mobil", "name": "Mobil Sedan", "type": "car", "color": "#e5e7eb",
     "x": round(hx0 + 50), "y": hy0 + 255, "angle": 0, "fuel": 0.7},
    # pick-up (bak terbuka) & truk mini engkel (bak kayu) — tidak bisa menarik trailer
    {"id": "pickup", "name": "Pick-up", "type": "car", "model": "pickup", "color": "#f8fafc",
     "x": round(hx0 + 215), "y": hy0 + 175, "angle": 0, "fuel": 0.6,
     "wb": 30, "front": 46, "rear": -18, "hw": 12, "door": 16, "vf": 155, "acc": 125, "tank": 47, "burn": 0.12},
    {"id": "truk-mini", "name": "Truk Mini", "type": "minitruck", "color": "#facc15",
     "x": round(hx0 + 225), "y": hy0 + 260, "angle": 0, "fuel": 0.55},
    # truk tangki BBM: bawa Solar & Pertalite, menghampiri kendaraan lain untuk mengisi BBM (A di dekatnya)
    {"id": "truk-tangki", "name": "Truk Tangki BBM", "type": "tanker", "color": "#f8fafc",
     "x": round(hx0 + 330), "y": hy0 + 250, "angle": 0, "fuel": 0.8, "cargo": {"Solar": 1500, "Pertalite": 1500}},
    # sepeda motor (tidak boleh masuk tol, tidak bisa menarik trailer)
    {"id": "motor-bebek", "name": "Motor Bebek", "type": "motor", "model": "bebek", "color": "#1d4ed8",
     "x": round(hx0 + 345), "y": hy0 + 55, "angle": 0, "fuel": 0.8},
    {"id": "motor-matic", "name": "Motor Matic", "type": "motor", "model": "matic", "color": "#e11d48",
     "x": round(hx0 + 345), "y": hy0 + 90, "angle": 0, "fuel": 0.7},
]


def spbu(x0, y0, label, east=True):
    """SPBU: halaman, 2 pulau pompa, toko. east=True berarti di timur jalan."""
    w, h = 450, 280
    pads.append(rect(x0, y0, w, h, "spbu"))
    reserve(x0, y0, w, h)
    ix = x0 + (150 if east else 200)
    for k, iy in enumerate([y0 + 100, y0 + 180]):
        obstacles.append(rect(ix, iy, 100, 22, "pump"))
        places.append({"kind": "pump", "label": f"Pompa {k + 1}", "x": ix + 50, "y": iy + 11, "r": 50})
    sx = x0 + w - 115 if east else x0 + 10
    obstacles.append(rect(sx, y0 + 6, 105, 60, "shop", "TOKO"))
    places.append({"kind": "shop", "label": "Toko " + label.title().replace("Spbu", "SPBU"), "interior": "toko",
                   "x": sx + 52, "y": y0 + 84, "r": 34})
    decor.append({"kind": "canopy", "x": ix - 60, "y": y0 + 75, "w": 220, "h": 150, "label": label})


# SPBU Tingkir (timur jalan) & SPBU Tengaran (barat jalan)
spbu(main_x_range(2900, 3180)[1] + MAIN_W / 2 - 6, 2900, "SPBU TINGKIR", east=True)
spbu(main_x_range(5800, 6080)[0] - MAIN_W / 2 + 6 - 450, 5800, "SPBU TENGARAN", east=False)

# Warung (Klero), timur jalan
wx0 = main_x_range(4850, 4980)[1] + MAIN_W / 2 - 6
pads.append(rect(wx0, 4850, 260, 110, "warung"))
obstacles.append(rect(wx0 + 50, 4960, 180, 80, "warung", "WARUNG KLERO"))
places.append({"kind": "warung", "label": "Warung Klero", "interior": "warung", "x": round(wx0 + 140), "y": 4935, "r": 42})
reserve(wx0, 4850, 260, 200)

# Pasar Kembangsari (Tengaran), barat jalan — bisa jajan di sini
px1 = main_x_range(6280, 6640)[0] - MAIN_W / 2 + 6
pads.append(rect(px1 - 420, 6280, 420, 130, "market"))
obstacles.append(rect(px1 - 380, 6410, 330, 210, "market", "PASAR KEMBANGSARI"))
places.append({"kind": "warung", "label": "Pasar Kembangsari", "interior": "pasar", "x": round(px1 - 215), "y": 6385, "r": 46})
reserve(px1 - 420, 6280, 420, 360)

# Gerbang tol: pos-pos gardu di tengah jalan (lajur di antaranya), atap kanopi (hiasan), zona bayar.
toll_gates = []


def toll_gate(gid, name, cx, cy, horizontal, role):
    """Plaza gerbang tol selebar 260 px: 3 lajur @ 70 px dipisah 4 gardu (tebal 10 px).
    horizontal=True: jalan arah barat-timur (gardu berderet utara-selatan)."""
    PW, PL = 260, 120
    for off in (-125, -45, 45, 125):
        if horizontal:
            obstacles.append(rect(cx - 18, cy + off - 5, 36, 10, "tollbooth"))
        else:
            obstacles.append(rect(cx + off - 5, cy - 18, 10, 36, "tollbooth"))
    plaza = ({"x": cx - PL / 2, "y": cy - PW / 2, "w": PL, "h": PW} if horizontal
             else {"x": cx - PW / 2, "y": cy - PL / 2, "w": PW, "h": PL})
    pads.append(rect(plaza["x"], plaza["y"], plaza["w"], plaza["h"], "tollplaza"))
    zone = ({"x": cx - 24, "y": cy - PW / 2, "w": 48, "h": PW} if horizontal
            else {"x": cx - PW / 2, "y": cy - 24, "w": PW, "h": 48})
    toll_gates.append({"id": gid, "name": name, "x": cx, "y": cy, "horizontal": horizontal, "zone": zone, "role": role})
    decor.append({"kind": "tollgate", "x": cx, "y": cy, "horizontal": horizontal, "w": PW + 20, "label": name})
    reserve(plaza["x"] - 30, plaza["y"] - 30, plaza["w"] + 60, plaza["h"] + 60, 10)


toll_gate("gt-tingkir", "GERBANG TOL TINGKIR (SALATIGA)", 600, 3640, False, "masuk")
toll_gate("gt-boyolali", "GERBANG TOL BOYOLALI", 965, 8010, True, "keluar")
labels.append({"text": "TOL SEMARANG–SOLO · maks 100 km/j", "x": 230, "y": 4300, "size": 16})

# Arena Pacuan Kuda Tegalwaton (landmark)
decor.append({"kind": "arena", "x": 520, "y": 5020, "rx": 330, "ry": 170, "label": "ARENA PACUAN KUDA TEGALWATON"})
pads.append(rect(780, 5160, 220, 140, "parking"))
reserve(160, 4820, 860, 500)

# Gapura batas kabupaten di Sruwen
decor.append({"kind": "gapura", "x": main_x(8150), "y": 8150, "w": MAIN_W + 60,
              "label": "Selamat Jalan — Batas Kab. Semarang / Kab. Boyolali"})


def east_edge(y0, y1):
    return main_x_range(y0, y1)[1] + MAIN_W / 2 - 6


def west_edge(y0, y1):
    return main_x_range(y0, y1)[0] - MAIN_W / 2 + 6


# --- Toko Luwes (oleh-oleh khas Salatiga), Jl. Jend. Sudirman, pusat kota — posisi perkiraan
lx1 = west_edge(240, 420)
pads.append(rect(lx1 - 300, 330, 300, 90, "paving"))
obstacles.append(rect(lx1 - 290, 230, 270, 100, "store", "TOKO LUWES", color="#15803d"))
places.append({"kind": "oleh", "label": "Toko Luwes", "interior": "luwes", "x": round(lx1 - 155), "y": 360, "r": 42})
reserve(lx1 - 300, 225, 300, 200)

# --- Dealer Mitsubishi PT Sun Star Motor, Jl. Jend. Sudirman No. 213 (timur jalan)
mx0 = east_edge(600, 880)
pads.append(rect(mx0, 600, 470, 280, "showroom"))
obstacles.append(rect(mx0 + 300, 610, 160, 190, "showroom", "MITSUBISHI · SUN STAR MOTOR"))
places.append({"kind": "dealer", "label": "Dealer Mitsubishi", "interior": "dealer", "x": round(mx0 + 270), "y": 705, "r": 46})
reserve(mx0, 600, 480, 290)
# mobil pajangan (tidak bisa dinaiki); mobil yang dibeli muncul di tempat "lot"
display_cars = [
    {"model": "mpv", "color": "#e5e7eb", "x": round(mx0 + 60), "y": 640, "angle": 90, "name": "Xpander"},
    {"model": "suv", "color": "#111827", "x": round(mx0 + 130), "y": 640, "angle": 90, "name": "Pajero Sport"},
    {"model": "pickup", "color": "#b91c1c", "x": round(mx0 + 200), "y": 640, "angle": 90, "name": "Triton"},
]
for c in display_cars:
    obstacles.append(rect(c["x"] - 14, c["y"] - 12, 28, 62, "displaycar"))
dealer = {
    "lot": [{"x": round(mx0 + 60 + 70 * i), "y": 790, "angle": -90} for i in range(4)],
    "stock": [
        {"id": "xpander", "name": "Xpander", "model": "mpv", "color": "#e5e7eb", "price": 270_000_000,
         "spec": {"wb": 31, "front": 47, "rear": -12, "hw": 12.5, "door": 16, "vf": 180, "acc": 150, "tank": 45, "burn": 0.11}},
        {"id": "xforce", "name": "Xforce", "model": "suv", "color": "#f59e0b", "price": 390_000_000,
         "spec": {"wb": 30, "front": 44, "rear": -11, "hw": 12.5, "door": 15, "vf": 190, "acc": 165, "tank": 45, "burn": 0.11}},
        {"id": "pajero", "name": "Pajero Sport", "model": "suv", "color": "#111827", "price": 560_000_000,
         "spec": {"wb": 32, "front": 49, "rear": -13, "hw": 13.5, "door": 16, "vf": 195, "acc": 175, "tank": 68, "burn": 0.15}},
        {"id": "triton", "name": "Triton", "model": "pickup", "color": "#b91c1c", "price": 330_000_000,
         "spec": {"wb": 34, "front": 50, "rear": -16, "hw": 13, "door": 18, "vf": 175, "acc": 160, "tank": 75, "burn": 0.14}},
        {"id": "l300", "name": "L300 Pick Up", "model": "pickup", "color": "#f8fafc", "price": 240_000_000,
         "spec": {"wb": 30, "front": 46, "rear": -18, "hw": 12, "door": 16, "vf": 150, "acc": 120, "tank": 47, "burn": 0.12}},
    ],
    "dp": 0.2,          # kredit: uang muka 20%
    "cut": 0.3,         # cicilan dipotong 30% dari setiap ongkos kirim
}

# --- Hotel Laras Asri Resort & Spa, Jl. Jend. Sudirman No. 335 (barat jalan)
hlx1 = west_edge(1540, 1820)
pads.append(rect(1140, 1540, hlx1 - 1140, 280, "resort"))
obstacles.append(rect(1160, 1555, 200, 120, "hotel", "HOTEL LARAS ASRI", color="#7c2d12"))
decor.append({"kind": "pool", "x": 1175, "y": 1700, "w": 120, "h": 70})
places.append({"kind": "hotel", "label": "Hotel Laras Asri", "interior": "hotel", "x": 1330, "y": 1700, "r": 42})
for p in [(1158, 1795), (1320, 1800), (1400, 1560)]:
    obstacles.append(rect(p[0] - 15, p[1] - 15, 30, 30, "tree"))
reserve(1140, 1540, hlx1 - 1140, 280)

# --- Sekolah Al-Irsyad, Jl. Solo–Semarang Km 45, Butuh, Tengaran (barat jalan)
sx1 = west_edge(7000, 7480)
pads.append(rect(1180, 7000, sx1 - 1180, 480, "school"))
obstacles += fence(1180, 7000, sx1, 7480, {"e": (7180, 7300)})
obstacles.append(rect(1200, 7020, 300, 70, "school", "SEKOLAH AL-IRSYAD", color="#166534"))
obstacles.append(rect(1200, 7090, 70, 300, "school", "", color="#166534"))
obstacles.append(rect(1200, 7390, 300, 70, "school", "", color="#166534"))
obstacles.append(rect(1360, 7180, 90, 90, "mosque", "MASJID"))
decor.append({"kind": "field", "x": 1290, "y": 7110, "w": 60, "h": 260})
places.append({"kind": "school", "label": "Sekolah Al-Irsyad", "interior": "sekolah", "x": round(sx1 - 60), "y": 7240, "r": 46})
places.append({"kind": "mosque", "id": "masjid-al-irsyad", "interior": "masjid", "label": "Masjid Al-Irsyad",
               "x": 1460, "y": 7225, "r": 48, "door": {"x": 1455, "y": 7225}})
labels.append({"text": "Pesantren & Sekolah Al-Irsyad Tengaran", "x": 1440, "y": 6975, "size": 16})
decor.append({"kind": "schoolzone", "y0": 6930, "y1": 7560, "label": "ZONA SELAMAT SEKOLAH"})
reserve(1170, 6990, sx1 - 1160, 500)

# --- Bengkel Rakit Tingkir (timur jalan raya, seberang rumah sopir): mode rakit kendaraan dari blok dasar
bk0 = east_edge(2400, 2820)
BK = {"x": round(bk0), "y": 2400, "w": 470, "h": 400}
pads.append(rect(BK["x"], BK["y"], BK["w"], BK["h"], "bengkel"))
obstacles.append(rect(BK["x"] + 300, BK["y"] + 30, 160, 230, "bengkel", "BENGKEL RAKIT TINGKIR", color="#ea580c"))
obstacles.append(rect(BK["x"] + 330, BK["y"] + 300, 110, 70, "partsrack", "GUDANG SUKU CADANG"))
places.append({"kind": "bengkel", "id": "bengkel-rakit", "label": "Bengkel Rakit Tingkir",
               "x": BK["x"] + 270, "y": BK["y"] + 145, "r": 44})
bengkel = {"lot": [{"x": BK["x"] + 150, "y": BK["y"] + 50 + 85 * i, "angle": 180} for i in range(4)]}
labels.append({"text": "BENGKEL RAKIT · buat kendaraanmu sendiri", "x": BK["x"] + 200, "y": BK["y"] - 14, "size": 15})
reserve(BK["x"], BK["y"] - 20, BK["w"], BK["h"] + 30)

# --- Terminal Bus Tingkir
terminal = {"x": 2120, "y": 2780, "w": 300, "h": 180}
pads.append(rect(terminal["x"], terminal["y"], terminal["w"], terminal["h"], "paving"))
obstacles.append(rect(2175, 2795, 160, 55, "terminal", "TERMINAL BUS TINGKIR"))
# Bus Tingkir: kini kendaraan yang bisa dikendarai (model "bus"); as roda belakang di x = 2155 + 14
vehicles.append({"id": "bus-tingkir", "name": "Bus Tingkir", "type": "car", "model": "bus", "color": "#facc15",
                 "x": 2183, "y": 2891, "angle": 0, "fuel": 0.7,
                 "wb": 85, "front": 112, "rear": -28, "hw": 21, "door": 36, "maxSteer": 0.75,
                 "vf": 180, "acc": 185, "tank": 150, "burn": 0.022, "fuelName": "Solar", "price": 6800, "mass": 3.2})
places.append({"kind": "terminal", "id": "terminal-bus-tingkir", "label": "Terminal Bus Tingkir",
               "x": 2260, "y": 2860, "r": 68})
labels.append({"text": "TERMINAL BUS TINGKIR", "x": 2255, "y": 2778, "size": 18})
reserve(terminal["x"], terminal["y"], terminal["w"], terminal["h"], 20)

# --- Alun-alun Pancasila Salatiga (timur Jl. Jend. Sudirman, pusat kota; posisi perkiraan)
#     lapangan rumput, jalur pedestrian keliling, pohon rindang, Patung Tiga Pahlawan, gerobak wedang ronde
ax0 = east_edge(110, 520) + 40
AL = {"x": round(ax0), "y": 110, "w": 400, "h": 400}
pads.append(rect(AL["x"], AL["y"], AL["w"], AL["h"], "plaza"))
decor.append({"kind": "alun", **AL, "label": "ALUN-ALUN PANCASILA"})
obstacles.append(rect(AL["x"] + AL["w"] / 2 - 22, AL["y"] + AL["h"] / 2 - 22, 44, 44, "monument", "PATUNG TIGA PAHLAWAN"))
for k in range(10):                                    # pohon beringin keliling alun-alun
    t = k / 10
    for (px, py) in [(AL["x"] + 30 + t * (AL["w"] - 60), AL["y"] + 30), (AL["x"] + 30 + t * (AL["w"] - 60), AL["y"] + AL["h"] - 30)]:
        if k % 2 == 0:
            obstacles.append(rect(px - 15, py - 15, 30, 30, "tree"))
for (px, py) in [(AL["x"] + 30, AL["y"] + 140), (AL["x"] + 30, AL["y"] + 260), (AL["x"] + AL["w"] - 30, AL["y"] + 140),
                 (AL["x"] + AL["w"] - 30, AL["y"] + 260)]:
    obstacles.append(rect(px - 15, py - 15, 30, 30, "tree"))
for k, (gx, gy) in enumerate([(AL["x"] + 70, AL["y"] + AL["h"] + 14), (AL["x"] + 190, AL["y"] + AL["h"] + 14)]):
    obstacles.append(rect(gx, gy, 34, 18, "cart", "", color="#b45309"))
places.append({"kind": "ronde", "label": "Wedang Ronde Alun-alun", "x": AL["x"] + 130, "y": AL["y"] + AL["h"] + 58, "r": 46})
places.append({"kind": "alun", "label": "Alun-alun Pancasila", "x": AL["x"] + AL["w"] / 2, "y": AL["y"] + AL["h"] / 2 + 60, "r": 60})
pads.append(rect(AL["x"], AL["y"] + AL["h"], 320, 90, "paving"))
reserve(AL["x"] - 20, AL["y"] - 20, AL["w"] + 40, AL["h"] + 130)
alun_mosque = {"x": AL["x"] + 566, "y": AL["y"] + 260, "w": 100, "h": 90}
pads.append(rect(alun_mosque["x"] - 60, alun_mosque["y"] - 20, 220, 170, "paving"))
obstacles.append(rect(alun_mosque["x"], alun_mosque["y"], alun_mosque["w"], alun_mosque["h"],
                      "mosque", "MASJID LAPANGAN PANCASILA"))
places.append({"kind": "mosque", "id": "masjid-pancasila", "interior": "masjid", "label": "Masjid dekat Lapangan Pancasila",
               "x": alun_mosque["x"] + 50, "y": alun_mosque["y"] + 100, "r": 48,
               "door": {"x": alun_mosque["x"] + 50, "y": alun_mosque["y"] + 96}})
labels.append({"text": "MASJID · LAPANGAN PANCASILA", "x": alun_mosque["x"] + 50, "y": alun_mosque["y"] - 12, "size": 15})
reserve(alun_mosque["x"] - 60, alun_mosque["y"] - 20, 220, 170, 15)

# --- Kumon Sukowati (tempat les), sisi selatan Jl. Sukowati — posisi perkiraan
kx0 = 1130
pads.append(rect(kx0, 868, 220, 50, "paving"))
obstacles.append(rect(kx0 + 20, 918, 180, 100, "kumon", "KUMON SUKOWATI", color="#0369a1"))
places.append({"kind": "kumon", "label": "Kumon Sukowati", "interior": "kumon", "x": kx0 + 110, "y": 893, "r": 38})
reserve(kx0, 860, 220, 170)

# --- lampu jalan di sepanjang jalan utama (menyala malam hari); dibangkitkan setelah sawah
lamps = []


def walk(pts, step):
    acc = 0.0
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        L = math.hypot(x1 - x0, y1 - y0)
        while acc < L:
            t = acc / L
            yield x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, (x1 - x0) / L, (y1 - y0) / L
            acc += step
        acc -= L

# --- Perumahan Puri Wahid Regency (Randuacir, Argomulyo), akses dari Jalan Lingkar Selatan
jls = next(r for r in roads if r["id"] == "jls")


def road_y_at(pts, x):
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        if min(x0, x1) <= x <= max(x0, x1):
            return y0 + (y1 - y0) * ((x - x0) / ((x1 - x0) or 1))
    return pts[-1][1]


PW_X = 640                                   # sumbu jalan masuk perumahan
pw_top = road_y_at(jls["pts"], PW_X)         # titik simpang dengan JLS
PW_CROSS = 2420                              # jalan melintang di dalam perumahan
PW_END = 2800
add_road("puri-wahid", "Jl. Puri Wahid", [(PW_X, pw_top), (PW_X, PW_END)], 90, kind="estate")
add_road("puri-wahid-2", "Jl. Puri Wahid Raya", [(260, PW_CROSS), (min(1000, hx0 - 90), PW_CROSS)], 90, kind="estate")
decor.append({"kind": "gapura", "x": PW_X, "y": pw_top + 80, "w": 90 + 50, "title": "PURI WAHID",
              "label": "Perumahan Puri Wahid Regency"})
labels.append({"text": "Perumahan Puri Wahid Regency · Randuacir, Argomulyo", "x": PW_X - 20, "y": PW_END + 40, "size": 16})

# Rumah Puri Wahid: carport berisi Mirage & Innova
pwx0, pwx1, pwy0, pwy1 = PW_X + 45 - 6, PW_X + 345, 2560, 2770
pads.append(rect(pwx0, pwy0, pwx1 - pwx0, pwy1 - pwy0, "driveway"))
obstacles.append(rect(pwx0 + 70, pwy0 - 82, 230, 82, "house", "RUMAH PURI WAHID", color="#334155", home="rumah-puri"))
places.append({"kind": "house", "id": "rumah-puri", "theme": "puri", "interior": "rumah", "label": "Rumah Puri Wahid",
               "x": round(pwx0 + 185), "y": pwy0 + 14, "r": 40, "door": {"x": round(pwx0 + 185), "y": pwy0 + 24}})
reserve(pwx0, pwy0 - 90, pwx1 - pwx0, pwy1 - pwy0 + 90, 15)
pw_mosque = {"x": 350, "y": 2550, "w": 100, "h": 80}
pads.append(rect(330, 2535, 170, 145, "paving"))
obstacles.append(rect(pw_mosque["x"], pw_mosque["y"], pw_mosque["w"], pw_mosque["h"],
                      "mosque", "MASJID PURI WAHID"))
places.append({"kind": "mosque", "id": "masjid-puri-wahid", "interior": "masjid", "label": "Masjid Puri Wahid",
               "x": 400, "y": 2640, "r": 48, "door": {"x": 400, "y": 2638}})
labels.append({"text": "MASJID PURI WAHID", "x": 400, "y": 2537, "size": 15})
reserve(pw_mosque["x"] - 15, pw_mosque["y"] - 10, pw_mosque["w"] + 30, pw_mosque["h"] + 50, 8)
vehicles += [
    {"id": "mirage", "name": "Mirage", "type": "car", "model": "hatch", "color": "#e11d48",
     "x": round(pwx0 + 50), "y": pwy0 + 70, "angle": 0, "fuel": 0.8,
     "wb": 24, "front": 34, "rear": -8, "hw": 9.5, "door": 12, "vf": 190, "acc": 165, "tank": 35, "burn": 0.08},
    {"id": "innova", "name": "Innova", "type": "car", "model": "mpv", "color": "#475569",
     "x": round(pwx0 + 50), "y": pwy0 + 150, "angle": 0, "fuel": 0.6,
     "wb": 30, "front": 46, "rear": -12, "hw": 12.5, "door": 16, "vf": 175, "acc": 140, "tank": 55, "burn": 0.13},
]

# rumah-rumah cluster (seragam, 2 lantai) di sepanjang jalan perumahan
estate = []
ESTATE_ROOFS = ["#334155", "#475569", "#1f2937", "#7c2d12", "#57534e"]
for r in roads:
    if r["kind"] != "estate":
        continue
    (ax, ay), (bx, by) = r["pts"][0], r["pts"][-1]
    vertical = abs(bx - ax) < abs(by - ay)
    a0, a1 = (min(ay, by) + 130, max(ay, by)) if vertical else (min(ax, bx) + 10, max(ax, bx) - 10)
    v = a0
    while v + 56 <= a1:
        for side in (-1, 1):
            if vertical:
                cx, cy, w, h = ax + side * (45 + 14 + 34), v + 28, 68, 56
            else:
                cx, cy, w, h = v + 34, ay + side * (45 + 14 + 28), 68, 56
            estate.append((cx - w / 2, cy - h / 2, w, h))
        v += 80

# --- wilayah (untuk HUD & tulisan besar di tanah)
regions = [
    # wilayah dengan x0/x1 dicek lebih dulu (lebih spesifik) — Kecamatan Argomulyo di barat-daya
    {"name": "Randuacir, Argomulyo", "x0": 150, "x1": 1060, "y0": 2180, "y1": 2880},
    {"name": "Kumpulrejo, Argomulyo", "x0": 0, "x1": 700, "y0": 1700, "y1": 2180},
    {"name": "Ledok, Argomulyo", "x0": 700, "x1": 1130, "y0": 1960, "y1": 2180},
    {"name": "Cebongan, Argomulyo", "x0": 0, "x1": 150, "y0": 2180, "y1": 2880},
    {"name": "Cebongan, Argomulyo", "x0": 0, "x1": 450, "y0": 2880, "y1": 3420},
    {"name": "Tegalrejo, Argomulyo", "x0": 450, "x1": 900, "y0": 2880, "y1": 3420},
    {"name": "Noborejo, Argomulyo", "x0": 900, "x1": 1420, "y0": 2880, "y1": 3420},
    {"name": "Ledok, Argomulyo", "x0": 1100, "x1": 1445, "y0": 1500, "y1": 1960},
    {"name": "Sukowati, Salatiga", "x0": 960, "x1": 1440, "y0": 760, "y1": 1060},
    {"name": "Kota Salatiga", "y0": 0, "y1": 2300},
    {"name": "Tingkir, Salatiga", "y0": 2300, "y1": 4350},
    {"name": "Klero, Tengaran", "y0": 4350, "y1": 5650},
    {"name": "Tengaran", "y0": 5650, "y1": 6850},
    {"name": "Butuh, Tengaran", "y0": 6850, "y1": 7950},
    {"name": "Sruwen, Tengaran", "y0": 7950, "y1": H},
]
labels += [
    {"text": "↑ Semarang", "x": main_x(60) + 150, "y": 60, "size": 22},
    {"text": "↓ Solo / Boyolali", "x": main_x(H - 60) + 170, "y": H - 60, "size": 22},
    {"text": "← Suruh", "x": 120, "y": 3260, "size": 20},
    {"text": "← Kumpulrejo, Argomulyo", "x": 200, "y": 1900, "size": 20},
    {"text": "Simpang Tiga Pendem", "x": main_x(2000) + 190, "y": 1960, "size": 16},
    {"text": "Simpang Jl. Lingkar Selatan", "x": main_x(2250) - 230, "y": 2300, "size": 16},
    {"text": "KECAMATAN ARGOMULYO", "x": 560, "y": 2950, "size": 30},
    {"text": "Kumpulrejo", "x": 330, "y": 1880, "size": 22},
    {"text": "Ledok", "x": 900, "y": 2120, "size": 22},
    {"text": "Cebongan", "x": 260, "y": 3180, "size": 22},
    {"text": "Tegalrejo", "x": 680, "y": 3180, "size": 22},
    {"text": "Noborejo", "x": 1200, "y": 3180, "size": 22},
    {"text": "Randuacir", "x": 420, "y": 2250, "size": 22},
]

# --- sawah (hiasan, tidak menghalangi)
sawah = []


def far_from_roads(x, y, m):
    return all(poly_dist(x, y, r["pts"]) > r["w"] / 2 + m for r in roads)


def free_rect(x0, y0, x1, y1, m=12):
    for (a, b, c, d) in reserved:
        if x0 < c and x1 > a and y0 < d and y1 > b:
            return False
    pts = [(x0, y0), (x1, y0), (x0, y1), (x1, y1), ((x0 + x1) / 2, (y0 + y1) / 2),
           ((x0 + x1) / 2, y0), ((x0 + x1) / 2, y1), (x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2)]
    return all(far_from_roads(px, py, m) for px, py in pts) and 0 <= x0 and x1 <= W and 0 <= y0 and y1 <= H


for _ in range(400):
    if len(sawah) >= 26:
        break
    y = random.uniform(3000, H - 300)
    side = random.choice([-1, 1])
    w, h = random.uniform(300, 650), random.uniform(220, 480)
    x = main_x(y) + side * (MAIN_W / 2 + random.uniform(160, 500)) - (w if side < 0 else 0)
    if free_rect(x, y, x + w, y + h, 60) and all(
            x + w < s["x"] or x > s["x"] + s["w"] or y + h < s["y"] or y > s["y"] + s["h"] for s in sawah):
        sawah.append(rect(x, y, w, h, "sawah"))
for s in sawah:
    reserve(s["x"], s["y"], s["w"], s["h"], 10)

# lampu jalan (jalan utama & Jalan Lingkar Selatan), menyala saat malam
for rid, step in (("main", 230), ("jls", 210)):
    road = next(r for r in roads if r["id"] == rid)
    for k, (x, y, ux, uy) in enumerate(walk(road["pts"], step)):
        side = 1 if k % 2 == 0 else -1          # selang-seling kiri/kanan
        nx, ny = -uy * side, ux * side
        off = road["w"] / 2 + 10
        lx, ly = x + nx * off, y + ny * off
        if any(poly_dist(lx, ly, q["pts"]) < q["w"] / 2 + 16 for q in roads if q is not road):
            continue
        if any(p["x"] - 12 < lx < p["x"] + p["w"] + 12 and p["y"] - 12 < ly < p["y"] + p["h"] + 12 for p in pads):
            continue
        if not (10 < lx < W - 10 and 10 < ly < H - 10):
            continue
        lamps.append({"x": round(lx, 1), "y": round(ly, 1), "ang": round(math.atan2(-ny, -nx), 3)})
        obstacles.append(rect(lx - 3, ly - 3, 6, 6, "lamp"))
        reserve(lx - 3, ly - 3, 6, 6, 12)

# --- rumah-rumah & pohon di sepanjang jalan
ROOFS = ["#9a3412", "#b45309", "#7c2d12", "#991b1b", "#57534e", "#1e3a8a", "#0f766e", "#a16207"]
houses = []


def place_estate():
    for (x0, y0, w, h) in estate:
        if free_rect(x0, y0, x0 + w, y0 + h, 8) and all(
                x0 >= c + 8 or x0 + w <= a - 8 or y0 >= d + 8 or y0 + h <= b - 8 for (a, b, c, d) in houses):
            houses.append((x0, y0, x0 + w, y0 + h))
            obstacles.append(rect(x0, y0, w, h, "house", color=random.choice(ESTATE_ROOFS)))
    reserve(150, 2180, 910, 700, 0)      # perumahan tertutup: tidak diisi rumah/pohon acak


def try_house(cx, cy, w, h):
    x0, y0 = cx - w / 2, cy - h / 2
    if not free_rect(x0, y0, x0 + w, y0 + h):
        return False
    for (a, b, c, d) in houses:
        if x0 < c + 10 and x0 + w > a - 10 and y0 < d + 10 and y0 + h > b - 10:
            return False
    houses.append((x0, y0, x0 + w, y0 + h))
    obstacles.append(rect(x0, y0, w, h, "house", color=random.choice(ROOFS)))
    return True


# --- lampu lalu lintas: deteksi persimpangan otomatis dari data jalan ---------------------------
#   simpang-T  : ujung sebuah jalan menempel pada jalan lain
#   simpang ×  : dua polyline saling memotong
# Tiap lengan (arah datang) mendapat garis henti + tiang lampu di sisi kiri (lalu lintas lajur kiri).
# Fase 0 = jalan terlebar (biasanya jalan raya), fase 1 = jalan lainnya.
def _seg_inter(p1, p2, p3, p4):
    d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
    if abs(d) < 1e-9:
        return None
    t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
    u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
    if 0 <= t <= 1 and 0 <= u <= 1:
        return (p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1]))
    return None


def _project(pts, x, y):
    """(jarak, arc-length s) titik terdekat pada polyline."""
    best, bs, acc = 1e18, 0.0, 0.0
    for i in range(len(pts) - 1):
        (ax, ay), (bx2, by2) = pts[i], pts[i + 1]
        dx, dy = bx2 - ax, by2 - ay
        L = math.hypot(dx, dy) or 1e-9
        t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (L * L)))
        d = math.hypot(x - (ax + t * dx), y - (ay + t * dy))
        if d < best:
            best, bs = d, acc + t * L
        acc += L
    return best, bs


def _at(pts, s):
    """titik & arah satuan pada arc-length s."""
    acc = 0.0
    for i in range(len(pts) - 1):
        (ax, ay), (bx2, by2) = pts[i], pts[i + 1]
        L = math.hypot(bx2 - ax, by2 - ay) or 1e-9
        if acc + L >= s or i == len(pts) - 2:
            t = max(0.0, min(1.0, (s - acc) / L))
            return (ax + (bx2 - ax) * t, ay + (by2 - ay) * t), ((bx2 - ax) / L, (by2 - ay) / L)
        acc += L
    return tuple(pts[-1]), (1.0, 0.0)


def _length(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))


SIG_ROADS = [r for r in roads if r["kind"] != "toll"]
_cands = []
for ia, A in enumerate(SIG_ROADS):
    for ib, B in enumerate(SIG_ROADS):
        if ia == ib:
            continue
        for e in (A["pts"][0], A["pts"][-1]):                       # simpang-T
            d, sb = _project(B["pts"], e[0], e[1])
            if d < B["w"] / 2 + 25:
                p, _ = _at(B["pts"], sb)
                _cands.append((p, {A["id"], B["id"]}))
        if ia < ib:                                                   # simpang silang
            for i in range(len(A["pts"]) - 1):
                for j in range(len(B["pts"]) - 1):
                    q = _seg_inter(A["pts"][i], A["pts"][i + 1], B["pts"][j], B["pts"][j + 1])
                    if q:
                        _cands.append((q, {A["id"], B["id"]}))
junctions = []
for p, ids in _cands:
    if p[0] < 40 or p[1] < 40 or p[0] > W - 40 or p[1] > H - 40:
        continue
    for jn in junctions:
        if math.hypot(jn["x"] - p[0], jn["y"] - p[1]) < 90:
            jn["roads"] |= ids
            break
    else:
        junctions.append({"x": p[0], "y": p[1], "roads": set(ids)})

signals = []
byid = {r["id"]: r for r in roads}
for k, jn in enumerate(junctions):
    rs = [byid[i] for i in sorted(jn["roads"])]
    wide = max(rs, key=lambda r: (r["kind"] == "main", r["w"]))
    arms = []
    for R in rs:
        others = [Q for Q in rs if Q is not R]
        clear = max(Q["w"] for Q in others) / 2 + 12
        _, s0 = _project(R["pts"], jn["x"], jn["y"])
        Lr = _length(R["pts"])
        for sgn in (1, -1):                       # +1: datang dari awal polyline, -1: dari ujung
            room = s0 if sgn > 0 else Lr - s0
            if room < clear + 40:
                continue
            sp, tan = _at(R["pts"], s0 - sgn * clear)
            ux, uy = tan[0] * sgn, tan[1] * sgn   # arah masuk ke persimpangan
            lx, ly = uy, -ux                      # kiri dari arah datang
            off = R["w"] / 2 + 10
            arms.append({"road": R["id"], "w": R["w"], "sx": round(sp[0], 1), "sy": round(sp[1], 1),
                         "ux": round(ux, 4), "uy": round(uy, 4), "phase": 0 if R is wide else 1,
                         "px": round(sp[0] + lx * off, 1), "py": round(sp[1] + ly * off, 1)})
    if len(arms) >= 2 and len({a["phase"] for a in arms}) == 2:
        signals.append({"id": f"sig-{k}", "x": round(jn["x"], 1), "y": round(jn["y"], 1),
                        "offset": round(random.uniform(0, 32), 2), "arms": arms})

# tiang lampu = rintangan kecil (bisa ditabrak); dilewati bila menimpa bangunan lain
for sg in signals:
    for a in sg["arms"]:
        box = rect(a["px"] - 3, a["py"] - 3, 6, 6, "signal")
        if all(not (box["x"] < o["x"] + o["w"] and box["x"] + 6 > o["x"] and box["y"] < o["y"] + o["h"] and box["y"] + 6 > o["y"])
               for o in obstacles) and all(poly_dist(a["px"], a["py"], r["pts"]) > r["w"] / 2 + 2 for r in roads):
            obstacles.append(box)
            a["pole"] = True
        reserve(a["px"] - 6, a["py"] - 6, 12, 12, 8)


place_estate()
for r in roads:
    if r["kind"] in ("access", "estate", "toll"):
        continue
    for (x, y, ux, uy) in walk(r["pts"], 60):
        city = y < 2300
        rural = y > 4350
        if random.random() > (0.95 if city else 0.6 if not rural else 0.38):
            continue
        for side in (-1, 1):
            nx, ny = -uy * side, ux * side
            w, h = random.uniform(44, 74), random.uniform(36, 56)
            off = r["w"] / 2 + 24 + max(w, h) / 2 + random.uniform(0, 18)
            try_house(x + nx * off, y + ny * off, w, h)
            if city and random.random() < 0.7:
                off2 = off + max(w, h) + 22
                try_house(x + nx * off2, y + ny * off2, random.uniform(44, 74), random.uniform(36, 56))

trees = 0
for _ in range(6000):
    if trees >= 330:
        break
    x, y = random.uniform(30, W - 30), random.uniform(30, H - 30)
    if free_rect(x - 16, y - 16, x + 16, y + 16, 20):
        overl = any(x - 16 < c + 6 and x + 16 > a - 6 and y - 16 < d + 6 and y + 16 > b - 6 for (a, b, c, d) in houses)
        if not overl:
            obstacles.append(rect(x - 15, y - 15, 30, 30, "tree"))
            houses.append((x - 16, y - 16, x + 16, y + 16))
            trees += 1

# --- lalu lintas NPC di jalan utama (lajur kiri)
COLORS = ["#16a34a", "#a855f7", "#eab308", "#0ea5e9", "#f97316", "#64748b", "#be123c", "#f8fafc"]
traffic = []
for i in range(10):
    traffic.append({"type": "box" if i % 3 == 1 else "car", "color": COLORS[i % len(COLORS)],
                    "road": "main", "dir": 1 if i % 2 == 0 else -1, "t": (i * 0.097 + 0.03) % 1})
traffic.append({"type": "car", "color": "#facc15", "road": "muwardi", "dir": 1, "t": 0.3})
traffic.append({"type": "car", "color": "#22d3ee", "road": "suruh", "dir": 1, "t": 0.5})
# pick-up & truk mini ikut ramai di jalan raya
PICKUP_SPEC = {"model": "pickup", "wb": 30, "front": 46, "rear": -18, "hw": 12}
traffic.append({"type": "car", "color": "#e5e7eb", "road": "main", "dir": 1, "t": 0.62, **PICKUP_SPEC})
traffic.append({"type": "car", "color": "#1d4ed8", "road": "main", "dir": -1, "t": 0.41, **PICKUP_SPEC})
traffic.append({"type": "minitruck", "color": "#16a34a", "road": "main", "dir": -1, "t": 0.81})
traffic.append({"type": "minitruck", "color": "#f97316", "road": "main", "dir": 1, "t": 0.22})
# sepeda motor — paling ramai di jalan biasa (tidak boleh masuk tol)
MOTOR_COLORS = ["#111827", "#dc2626", "#1d4ed8", "#f8fafc", "#16a34a", "#7c3aed", "#f59e0b", "#0891b2", "#be123c", "#334155"]
for i in range(10):
    traffic.append({"type": "motor", "model": "matic" if i % 2 else "bebek", "color": MOTOR_COLORS[i],
                    "road": "main", "dir": 1 if i % 2 == 0 else -1, "t": (i * 0.103 + 0.075) % 1})
traffic.append({"type": "motor", "model": "bebek", "color": "#f97316", "road": "muwardi", "dir": -1, "t": 0.62})
traffic.append({"type": "motor", "model": "matic", "color": "#facc15", "road": "suruh", "dir": -1, "t": 0.15})
# lalu lintas jalan tol (lebih cepat)
for i, (tp, col) in enumerate([("car", "#0f172a"), ("box", "#e2e8f0"), ("car", "#dc2626"), ("minitruck", "#2563eb"),
                               ("car", "#d1d5db"), ("box", "#f59e0b")]):
    traffic.append({"type": tp, "color": col, "road": "tol", "dir": 1 if i % 2 == 0 else -1, "t": (i * 0.17 + 0.05) % 1, "fast": True})

# id unik untuk setiap tempat (dipakai simpanan saat sopir berada di dalam bangunan)
_seen = set()
for _p in places:
    if "id" not in _p:
        base = "".join(ch if ch.isalnum() else "-" for ch in _p["label"].lower()).strip("-")
        pid, k = base, 2
        while pid in _seen:
            pid, k = f"{base}-{k}", k + 1
        _p["id"] = pid
    _seen.add(_p["id"])

LEVEL = {
    "name": "Salatiga – Tengaran",
    "world": {"w": W, "h": H},
    "roads": roads,
    "pads": pads,
    "sawah": sawah,
    "places": places,
    "decor": decor,
    "labels": labels,
    "regions": regions,
    "spawn": spawn,
    "vehicles": vehicles,
    "traffic": traffic,
    "money": 90_000_000,         # uang bekal sopir
    "lamps": lamps,
    "signals": signals,
    "bengkel": bengkel,
    "signalCycle": {"g0": 14, "y0": 3, "r0": 1.5, "g1": 10, "y1": 3, "r1": 1.5},   # detik
    "tollGates": toll_gates,
    "tollFare": {"car": 25500, "minitruck": 38500, "box": 38500, "tractor": 51500},   # tarif per golongan
    "displayCars": display_cars,
    "dealer": dealer,
    "clockStart": 7.0,           # jam saat main baru (07.00)
    "bays": bays,
    "zones": zones,
    "obstacles": obstacles,
}

if __name__ == "__main__":
    kinds = {}
    for o in obstacles:
        kinds[o["kind"]] = kinds.get(o["kind"], 0) + 1
    print("roads", len(roads), "pads", len(pads), "obstacles", len(obstacles), kinds, "sawah", len(sawah))
