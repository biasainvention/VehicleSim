"""
Penyuntingan peta (halaman /editor).

Hasil editan disimpan lengkap di mapedit.json dan diterapkan di atas peta dasar setiap kali game
meminta /api/level, sehingga level_salatiga.py dan level_world.py tetap menjadi sumber peta dasar.
Isi file:

  objects : objek baru   {id, kind, x, y, w, h, label, color}      (pohon, bangunan, pagar, ...)
  removed : kunci objek bawaan yang dihapus   ("tree@6543,1780")
  moved   : kunci objek bawaan -> {x, y}      (dipindah)
  roads   : jalan spline {id, name, kind, w, pts:[[x, y, z], ...]}
            z = tinggi permukaan jalan (px, 10 px = 1 m). Jalan dihaluskan dengan spline Hermite
            (sama persis dengan static/mapedit-core.js), lalu tanah di sekitarnya otomatis
            dinaikkan (timbunan) atau diturunkan (galian) mengikuti jalan.
            Bila "ref" diisi (id jalan bawaan), jalan bawaan itu DIGANTI bentuk & tingginya oleh vektor ini.
  Rumah misi (Rumah Sopir, Puri Wahid, GT Boyolali) boleh dipindah lewat "moved"; pintu (place),
  jalan masuk (driveway), kendaraan parkir, dan titik spawn di sekitarnya ikut bergeser.
"""
import copy
import json
import math
import re

CELL = 40                 # ukuran sel grid tanah (px) - sama dengan level_world.py
SAMPLE_STEP = 30.0        # jarak antar titik hasil spline (px)
FLAT_MARGIN = 18.0        # bahu rata di kiri-kanan badan jalan (px)
MIN_FALL, MAX_FALL = 80.0, 600.0   # panjang lereng timbunan/galian (px)
FALL_RATIO = 6.0          # lereng ~ 1 : 6 (tiap 1 px beda tinggi butuh 6 px mendatar)
Z_MIN, Z_MAX = -1000.0, 2500.0     # batas tinggi jalan (px)

ROAD_KINDS = ("local", "estate", "access")
MAX_OBJECTS, MAX_REMOVED, MAX_ROADS, MAX_ROAD_PTS = 3000, 6000, 60, 300

# Objek yang boleh ditambah dari editor (semua digambar generik oleh render3d dari x,y,w,h,label,color).
CATALOG = [
    {"kind": "tree", "name": "Pohon", "group": "Pohon", "w": 30, "h": 30, "min": 12, "max": 90},
    {"kind": "pine", "name": "Pinus", "group": "Pohon", "w": 20, "h": 20, "min": 10, "max": 60},
    {"kind": "house", "name": "Rumah", "group": "Bangunan", "w": 60, "h": 50, "color": "#57534e", "min": 30, "max": 320},
    {"kind": "building", "name": "Gedung", "group": "Bangunan", "w": 160, "h": 90, "color": "#0284c7", "label": "GEDUNG", "min": 40, "max": 600},
    {"kind": "warung", "name": "Warung", "group": "Bangunan", "w": 120, "h": 70, "label": "WARUNG", "min": 50, "max": 300},
    {"kind": "shop", "name": "Toko", "group": "Bangunan", "w": 105, "h": 60, "label": "TOKO", "min": 50, "max": 300},
    {"kind": "store", "name": "Toserba", "group": "Bangunan", "w": 270, "h": 100, "color": "#15803d", "label": "TOSERBA", "min": 100, "max": 600},
    {"kind": "hotel", "name": "Hotel", "group": "Bangunan", "w": 200, "h": 120, "color": "#7c2d12", "label": "HOTEL", "min": 100, "max": 500},
    {"kind": "school", "name": "Sekolah", "group": "Bangunan", "w": 300, "h": 70, "color": "#166534", "label": "SEKOLAH", "min": 100, "max": 600},
    {"kind": "mosque", "name": "Masjid", "group": "Bangunan", "w": 90, "h": 90, "label": "MASJID", "min": 60, "max": 240},
    {"kind": "factory", "name": "Pabrik", "group": "Bangunan", "w": 150, "h": 330, "label": "PABRIK", "min": 80, "max": 800},
    {"kind": "market", "name": "Pasar", "group": "Bangunan", "w": 330, "h": 210, "label": "PASAR", "min": 120, "max": 800},
    {"kind": "fence", "name": "Pagar", "group": "Lainnya", "w": 200, "h": 10, "min": 4, "max": 1500},
    {"kind": "cart", "name": "Gerobak", "group": "Lainnya", "w": 34, "h": 18, "color": "#b45309", "min": 16, "max": 80},
    {"kind": "monument", "name": "Tugu", "group": "Lainnya", "w": 44, "h": 44, "label": "TUGU", "min": 20, "max": 200},
]
CATALOG_BY_KIND = {c["kind"]: c for c in CATALOG}

# Objek bawaan yang boleh dipindah/dihapus (tidak terhubung ke pintu, interior, atau misi)
# Bangunan hasil editan yang bisa dimasuki seperti Warung Kopeng / Toko Luwes:
# kind objek -> (kind place, interior, nama bawaan). Pintu = tengah dinding selatan.
ENTERABLE = {
    "warung": ("warung", "warung", "Warung"),
    "shop": ("shop", "toko", "Toko"),
    "store": ("oleh", "luwes", "Toserba"),
    "hotel": ("hotel", "hotel", "Hotel"),
    "market": ("warung", "pasar", "Pasar"),
}
FREE_KINDS = {"tree", "pine", "fence", "house", "cart"}

_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_ID_RE = re.compile(r"[^A-Za-z0-9_-]")


# ----------------------------------------------------------------------------- util
def empty_edit():
    return {"objects": [], "removed": [], "moved": {}, "roads": [], "bridges": []}


def _num(v, lo, hi, default):
    if isinstance(v, bool):
        return default
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(n):
        return default
    return max(lo, min(hi, n))


def _rnd(v):
    return round(v, 1)


def sanitize(raw, world):
    """Bersihkan & batasi data editan dari klien / mapedit.json."""
    out = empty_edit()
    if not isinstance(raw, dict):
        return out
    W, H = float(world["w"]), float(world["h"])

    ids = set()
    for o in (raw.get("objects") or [])[:MAX_OBJECTS]:
        if not isinstance(o, dict) or o.get("kind") not in CATALOG_BY_KIND:
            continue
        cat = CATALOG_BY_KIND[o["kind"]]
        oid = _ID_RE.sub("", str(o.get("id", "")))[:24] or f"o{len(out['objects']) + 1}"
        if oid in ids:
            continue
        ids.add(oid)
        w = _num(o.get("w"), cat["min"], cat["max"], cat["w"])
        h = _num(o.get("h"), cat["min"], cat["max"], cat["h"])
        item = {"id": oid, "kind": o["kind"],
                "x": _rnd(_num(o.get("x"), 0, W - w, 0)), "y": _rnd(_num(o.get("y"), 0, H - h, 0)),
                "w": _rnd(w), "h": _rnd(h), "label": str(o.get("label", ""))[:40]}
        if isinstance(o.get("color"), str) and _COLOR_RE.match(o["color"]):
            item["color"] = o["color"].lower()
        out["objects"].append(item)

    out["removed"] = sorted({str(k)[:60] for k in (raw.get("removed") or [])[:MAX_REMOVED] if isinstance(k, str)})
    moved = raw.get("moved") if isinstance(raw.get("moved"), dict) else {}
    for k, v in list(moved.items())[:MAX_REMOVED]:
        if isinstance(v, dict) and isinstance(k, str) and len(k) <= 60:
            out["moved"][k] = {"x": _rnd(_num(v.get("x"), -50, W, 0)), "y": _rnd(_num(v.get("y"), -50, H, 0))}

    rids, refs = set(), set()
    for r in (raw.get("roads") or [])[:MAX_ROADS]:
        if not isinstance(r, dict) or not isinstance(r.get("pts"), list):
            continue
        pts = []
        for p in r["pts"][:MAX_ROAD_PTS]:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                pts.append([_rnd(_num(p[0], 0, W, 0)), _rnd(_num(p[1], 0, H, 0)),
                            _rnd(_num(p[2] if len(p) > 2 else 0, Z_MIN, Z_MAX, 0))])
        # buang titik kembar berurutan
        pts = [p for i, p in enumerate(pts) if i == 0 or math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) >= 1.0]
        if len(pts) < 2:
            continue
        rid = _ID_RE.sub("", str(r.get("id", "")))[:24] or f"r{len(out['roads']) + 1}"
        if rid in rids:
            continue
        rids.add(rid)
        ref = _ID_RE.sub("", str(r.get("ref", "")))[:40]
        if ref:                                   # menimpa jalan bawaan
            if ref in refs:
                continue
            refs.add(ref)
            out["roads"].append({"id": rid, "ref": ref, "w": _rnd(_num(r.get("w"), 40, 260, 100)), "pts": pts})
            continue
        out["roads"].append({"id": rid, "name": (str(r.get("name", "")).strip()[:40] or "Jalan baru"),
                             "kind": r.get("kind") if r.get("kind") in ROAD_KINDS else "local",
                             "w": _rnd(_num(r.get("w"), 40, 200, 100)), "pts": pts})

    out["bridges"] = []
    for b in (raw.get("bridges") or [])[:200]:
        if not isinstance(b, dict):
            continue
        try:
            bid = _ID_RE.sub("", str(b.get("id", "")))[:32] or f"br{len(out['bridges']) + 1}"
            br = {
                "id": bid,
                "x": _rnd(_num(b.get("x"), 0, W, 0)),
                "y": _rnd(_num(b.get("y"), 0, H, 0)),
                "angle": _rnd(_num(b.get("angle"), -math.pi * 2, math.pi * 2, 0)),
                "lowerAngle": _rnd(_num(b.get("lowerAngle"), -math.pi * 2, math.pi * 2, math.pi / 2)),
                "length": _rnd(_num(b.get("length"), 20, 2000, 200)),
                "width": _rnd(_num(b.get("width"), 30, 400, 100)),
                "lowerWidth": _rnd(_num(b.get("lowerWidth"), 30, 400, 100)),
                "upperZ": _rnd(_num(b.get("upperZ"), Z_MIN, Z_MAX, 50)),
                "lowerZ": _rnd(_num(b.get("lowerZ"), Z_MIN, Z_MAX, 0)),
                "upperRoad": str(b.get("upperRoad", "")).strip()[:40],
                "lowerRoad": str(b.get("lowerRoad", "")).strip()[:40],
            }
            out["bridges"].append(br)
        except Exception:
            continue
    return out


def is_empty(edit):
    return not (edit["objects"] or edit["removed"] or edit["moved"] or edit["roads"] or edit.get("bridges"))


# ----------------------------------------------------------------------------- spline
def spline_samples(pts, step=SAMPLE_STEP):
    """Spline Hermite (tangen Catmull-Rom berbobot jarak) melalui titik [x, y, z]."""
    n = len(pts)
    if n < 2:
        return [list(p) for p in pts]
    d = [max(1e-6, math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])) for i in range(n - 1)]
    v = []
    for i in range(n):
        if i == 0:
            a, b, den = pts[0], pts[1], d[0]
        elif i == n - 1:
            a, b, den = pts[n - 2], pts[n - 1], d[n - 2]
        else:
            a, b, den = pts[i - 1], pts[i + 1], d[i - 1] + d[i]
        v.append([(b[k] - a[k]) / den for k in range(3)])
    out = []
    for i in range(n - 1):
        steps = max(1, math.ceil(d[i] / step))
        for s in range(steps):
            t = s / steps
            t2, t3 = t * t, t * t * t
            h00, h10, h01, h11 = 2 * t3 - 3 * t2 + 1, t3 - 2 * t2 + t, -2 * t3 + 3 * t2, t3 - t2
            out.append([h00 * pts[i][k] + h10 * d[i] * v[i][k] + h01 * pts[i + 1][k] + h11 * d[i] * v[i + 1][k]
                        for k in range(3)])
    out.append(list(pts[-1]))
    return out


# ----------------------------------------------------------------------------- tanah
def _smooth01(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def carve(h, nx, ny, roads, cell=CELL):
    """Ubah grid tinggi `h` (list datar, baris-demi-baris) agar mengikuti jalan.

    roads: [{"w": lebar, "samples": [[x, y, z], ...]}]. Di badan jalan (+ bahu) tanah dipaksa
    setinggi jalan; menjauh darinya tanah melandai kembali ke tinggi aslinya (timbunan bila
    jalan lebih tinggi, galian bila lebih rendah)."""
    best = {}
    for road in roads:
        half = road["w"] / 2 + FLAT_MARGIN
        reach = half + MAX_FALL
        exclusions = [(x, y, math.cos(angle), math.sin(angle), length / 2, width / 2, min_z)
                      for x, y, angle, length, width, min_z in road.get("bridgeExclusions", [])]
        s = road["samples"]
        for k in range(len(s) - 1):
            ax, ay, az = s[k]
            bx, by, bz = s[k + 1]
            dx, dy = bx - ax, by - ay
            l2 = dx * dx + dy * dy or 1e-9
            i0, i1 = max(0, int((min(ax, bx) - reach) / cell)), min(nx - 1, int((max(ax, bx) + reach) / cell) + 1)
            j0, j1 = max(0, int((min(ay, by) - reach) / cell)), min(ny - 1, int((max(ay, by) + reach) / cell) + 1)
            for j in range(j0, j1 + 1):
                py = j * cell
                for i in range(i0, i1 + 1):
                    px = i * cell
                    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
                    dist = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
                    sample_z = az + (bz - az) * t
                    if any(abs((px - ex) * co + (py - ey) * si) <= el
                           and abs(-(px - ex) * si + (py - ey) * co) <= ew
                           and sample_z > min_z
                           for ex, ey, co, si, el, ew, min_z in exclusions):
                        continue
                    dd = dist - half                    # jarak dari tepi bahu rata
                    if dd > MAX_FALL:
                        continue
                    key = j * nx + i
                    cur = best.get(key)
                    if (cur is None or dd < cur[0] - 1
                            or (dd <= 0 and cur[0] <= 0 and az + (bz - az) * t < cur[1])):
                        best[key] = (dd, az + (bz - az) * t)
    for key, (dd, zc) in best.items():
        base = h[key]
        fall = min(MAX_FALL, max(MIN_FALL, abs(zc - base) * FALL_RATIO))
        t = _smooth01(dd / fall) if dd > 0 else 0.0
        h[key] = zc * (1 - t) + base * t


BRIDGE_HEIGHT_THRESHOLD = 50.0   # satuan tinggi = 0,1 m (editor menampilkan z/10), jadi 50 = 5 m
# Geladak jembatan otomatis dibuat lebih panjang dari zona tanah yang tidak ditimbun, di tiap ujung,
# supaya tidak ada celah antara geladak dan badan jalan di atas timbunan (sel tanah 40 px berinterpolasi).
BRIDGE_APPROACH = 50.0


def _terrain_height(terrain, x, y):
    if not terrain:
        return 0.0
    fx = (x - terrain["x0"]) / terrain["cell"]
    fy = (y - terrain["y0"]) / terrain["cell"]
    if fx < 0 or fy < 0 or fx > terrain["nx"] - 1 or fy > terrain["ny"] - 1:
        return 0.0
    i, j = min(terrain["nx"] - 2, int(fx)), min(terrain["ny"] - 2, int(fy))
    tx, ty, n, heights = fx - i, fy - j, terrain["nx"], terrain["h"]
    a, b = heights[j * n + i], heights[j * n + i + 1]
    c, d = heights[(j + 1) * n + i], heights[(j + 1) * n + i + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def _road_z(road, si, t, terrain, x, y):
    """Tinggi permukaan jalan di titik persilangan.
    Jalan yang punya profil `h` (satu nilai per titik) diinterpolasi, termasuk bila nilainya 0;
    jalan tanpa profil mengikuti tinggi tanah."""
    h, pts = road.get("h") or [], road.get("pts") or []
    if len(h) >= len(pts) and len(h) > si + 1:
        t = max(0.0, min(1.0, t))
        return h[si] + (h[si + 1] - h[si]) * t
    return _terrain_height(terrain, x, y)


def _at_road_end(road, si, t, tol=0.05):
    """True bila titik berada di ujung jalan (sambungan, bukan persilangan)."""
    last = len(road.get("pts", [])) - 2
    return (si == 0 and t <= tol) or (si == last and t >= 1 - tol)


def _road_intersections(roads, terrain=None):
    """Temukan persilangan centerline jalan dengan beda elevasi yang layak dijembatani."""
    bridges = []
    cell = 120.0
    segments, cells = [], {}
    for ri, road in enumerate(roads):
        pts, heights = road.get("pts", []), road.get("h", [])
        for si in range(len(pts) - 1):
            p, q = pts[si], pts[si + 1]
            dx, dy = q[0] - p[0], q[1] - p[1]
            length = math.hypot(dx, dy)
            if length < 1:
                continue
            segment = (ri, si, p, q, dx, dy, length,
                       heights[si] if si < len(heights) else 0,
                       heights[si + 1] if si + 1 < len(heights) else 0)
            segment_index = len(segments)
            segments.append(segment)
            for gx in range(math.floor(min(p[0], q[0]) / cell), math.floor(max(p[0], q[0]) / cell) + 1):
                for gy in range(math.floor(min(p[1], q[1]) / cell), math.floor(max(p[1], q[1]) / cell) + 1):
                    cells.setdefault((gx, gy), []).append(segment_index)

    candidates = set()
    for bucket in cells.values():
        for i, si in enumerate(bucket):
            for sj in bucket[i + 1:]:
                a, b = segments[si], segments[sj]
                if a[0] == b[0] and abs(a[1] - b[1]) < 10:
                    continue
                candidates.add((min(si, sj), max(si, sj)))

    pair_hits = {}
    for si, sj in sorted(candidates):
        ai, abi, p, p2, adx, ady, alen, az0, az1 = segments[si]
        bi, bsi, q, q2, bdx, bdy, blen, bz0, bz1 = segments[sj]
        a, b = roads[ai], roads[bi]
        if (max(p[0], p2[0]) < min(q[0], q2[0]) or max(q[0], q2[0]) < min(p[0], p2[0])
                or max(p[1], p2[1]) < min(q[1], q2[1]) or max(q[1], q2[1]) < min(p[1], p2[1])):
            continue
        denom = adx * bdy - ady * bdx
        if abs(denom) < 1e-6:
            continue
        qpx, qpy = q[0] - p[0], q[1] - p[1]
        ta = (qpx * bdy - qpy * bdx) / denom
        tb = (qpx * ady - qpy * adx) / denom
        if not (-0.05 <= ta <= 1.05 and -0.05 <= tb <= 1.05):
            continue
        x, y = p[0] + max(0.0, min(1.0, ta)) * adx, p[1] + max(0.0, min(1.0, ta)) * ady
        # Persimpangan/sambungan jalan (ujung bertemu jalan lain) bukan jembatan.
        if (_at_road_end(a, abi, ta) or _at_road_end(b, bsi, tb)):
            continue
        za = _road_z(a, abi, ta, terrain, x, y)
        zb = _road_z(b, bsi, tb, terrain, x, y)
        # Jembatan hanya terbentuk bila beda tinggi >= BRIDGE_HEIGHT_THRESHOLD (5 m = 50 unit).
        if abs(za - zb) < BRIDGE_HEIGHT_THRESHOLD:
            continue
        upper, lower = (a, b) if za > zb else (b, a)
        ux, uy = (adx / alen, ady / alen) if upper is a else (bdx / blen, bdy / blen)
        lx, ly = (bdx / blen, bdy / blen) if upper is a else (adx / alen, ady / alen)
        crossing_angle = abs(ux * ly - uy * lx)
        if crossing_angle < 0.2:
            continue
        pair_key = (upper["id"], lower["id"])
        if any(math.hypot(x - hx, y - hy) < 50 for hx, hy in pair_hits.get(pair_key, [])):
            continue
        pair_hits.setdefault(pair_key, []).append((x, y))
        span = min(700.0, max(70.0, (lower["w"] / 2 + upper["w"] / 2 + 40) / crossing_angle))
        bridges.append({
            "id": f"bridge-{upper['id']}-{lower['id']}-{len(bridges) + 1}",
            "upperRoad": upper["id"], "lowerRoad": lower["id"],
            "x": _rnd(x), "y": _rnd(y), "angle": math.atan2(uy, ux),
            "lowerAngle": math.atan2(ly, lx),
            "upperZ": _rnd(max(za, zb)), "lowerZ": _rnd(min(za, zb)),
            "length": _rnd(span + 2 * BRIDGE_APPROACH), "width": upper["w"],
            "lowerWidth": lower["w"], "approach": BRIDGE_APPROACH,
        })
    return bridges


def _extend_terrain(terrain, need_nx):
    """Lebarkan grid ke timur (diisi 0 = tanah datar) bila jalan baru keluar dari grid lama."""
    nx, ny = terrain["nx"], terrain["ny"]
    if need_nx <= nx:
        return
    old = terrain["h"]
    new = []
    for j in range(ny):
        new.extend(old[j * nx:(j + 1) * nx])
        new.extend([0.0] * (need_nx - nx))
    terrain["h"], terrain["nx"] = new, need_nx


# ----------------------------------------------------------------------------- objek bawaan
def obstacle_keys(obstacles):
    """Kunci stabil tiap objek bawaan: 'jenis@x,y' (diberi #n bila kembar)."""
    seen, keys = {}, []
    for o in obstacles:
        k = f"{o.get('kind')}@{o['x']:g},{o['y']:g}"
        seen[k] = seen.get(k, 0) + 1
        keys.append(k if seen[k] == 1 else f"{k}#{seen[k]}")
    return keys


def _overlap(r, R, m=0):
    return (r["x"] < R["x"] + R["w"] + m and r["x"] + r["w"] > R["x"] - m
            and r["y"] < R["y"] + R["h"] + m and r["y"] + r["h"] > R["y"] - m)


def house_pad_indices(level, o):
    """Indeks pad 'driveway' (jalan masuk/carport) milik rumah misi `o`."""
    return [i for i, p in enumerate(level.get("pads", [])) if p.get("kind") == "driveway" and _overlap(p, o, 20)]


def locked_flags(level):
    """Status tiap objek bawaan: 0 bebas, 1 terkunci (terhubung ke pintu/interior/misi),
    2 rumah misi (boleh dipindah beserta pintu & isinya, tidak boleh dihapus)."""
    spots = [(p["x"], p["y"]) for p in level.get("places", [])]
    spots += [(p["door"]["x"], p["door"]["y"]) for p in level.get("places", []) if isinstance(p.get("door"), dict)]
    flags = []
    for o in level["obstacles"]:
        if o.get("kind") == "house" and o.get("home"):
            flags.append(2)
            continue
        if o.get("kind") not in FREE_KINDS or o.get("home"):
            flags.append(1)
            continue
        if o["kind"] in ("tree", "pine", "fence"):
            flags.append(0)
            continue
        m = 30
        flags.append(1 if any(o["x"] - m <= sx <= o["x"] + o["w"] + m and o["y"] - m <= sy <= o["y"] + o["h"] + m
                              for sx, sy in spots) else 0)
    return flags


def _seg_dist(px, py, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy or 1e-9
    t = max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / l2))
    return math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))


# ----------------------------------------------------------------------------- terapkan ke level
def _shift_place(p, dx, dy):
    for key in ("x", "y"):
        if key in p:
            p[key] = _rnd(p[key] + (dx if key == "x" else dy))
    if isinstance(p.get("door"), dict):
        p["door"]["x"], p["door"]["y"] = _rnd(p["door"]["x"] + dx), _rnd(p["door"]["y"] + dy)


def _move_mission_house(level, lv, o, dx, dy, moved_pads, moved_veh):
    """Geser pintu, jalan masuk, kendaraan parkir, dan spawn milik rumah misi sebesar (dx, dy).
    `level` = data asli (posisi lama), `lv` = salinan yang diubah, `o` = obstacle rumah (posisi lama)."""
    if not (dx or dy):
        return
    pad_idx = house_pad_indices(level, o)
    old_pads = [dict(level["pads"][i]) for i in pad_idx]
    for i in pad_idx:
        if i not in moved_pads:
            moved_pads.add(i)
            lv["pads"][i]["x"] = _rnd(lv["pads"][i]["x"] + dx)
            lv["pads"][i]["y"] = _rnd(lv["pads"][i]["y"] + dy)
    for p in lv.get("places", []):
        if p.get("id") == o.get("home"):
            _shift_place(p, dx, dy)
    zone = {"x": o["x"] - 120, "y": o["y"] - 120, "w": o["w"] + 240, "h": o["h"] + 240}
    for v in lv.get("vehicles", []):
        if v["id"] in moved_veh:
            continue
        spot = {"x": v["x"], "y": v["y"], "w": 0, "h": 0}
        if _overlap(spot, zone) or any(_overlap(spot, pr) for pr in old_pads):
            moved_veh.add(v["id"])
            v["x"], v["y"] = _rnd(v["x"] + dx), _rnd(v["y"] + dy)
    sp = lv.get("spawn")
    if isinstance(sp, dict) and _overlap({"x": sp["x"], "y": sp["y"], "w": 0, "h": 0}, o, 60):
        sp["x"], sp["y"] = _rnd(sp["x"] + dx), _rnd(sp["y"] + dy)


def apply_edits(level, edit):
    """Kembalikan salinan level dengan editan diterapkan (level asli tidak diubah)."""
    if is_empty(edit):
        bridges = _road_intersections(level["roads"], level.get("terrain"))
        if level.get("bridges") == bridges:
            return level
        lv = copy.deepcopy(level)
        lv["bridges"] = bridges
        return lv
    lv = copy.deepcopy(level)
    obs = lv["obstacles"]

    keys = obstacle_keys(obs)
    locked = locked_flags(lv)
    removed = set(edit["removed"])
    kept = []
    moved_pads, moved_veh = set(), set()
    for o, k, lk in zip(obs, keys, locked):
        if lk == 2:                                   # rumah misi: pindah beserta isinya
            mv = edit["moved"].get(k)
            if mv:
                _move_mission_house(level, lv, o, mv["x"] - o["x"], mv["y"] - o["y"], moved_pads, moved_veh)
                o["x"], o["y"] = mv["x"], mv["y"]
            kept.append(o)
            continue
        if lk:
            kept.append(o)
            continue
        if k in removed:
            continue
        mv = edit["moved"].get(k)
        if mv:
            o["x"], o["y"] = mv["x"], mv["y"]
        kept.append(o)
    obs = kept

    for o in edit["objects"]:
        item = {"x": o["x"], "y": o["y"], "w": o["w"], "h": o["h"], "kind": o["kind"], "label": o.get("label", "")}
        if o.get("color"):
            item["color"] = o["color"]
        obs.append(item)
        ent = ENTERABLE.get(o["kind"])
        if ent:                                         # bangunan baru bisa dimasuki (tekan A di depan pintu)
            pkind, interior, default = ent
            label = (o.get("label") or "").strip()
            label = default if (not label or label.upper() == CATALOG_BY_KIND[o["kind"]].get("label", "")) else label.title()
            lv.setdefault("places", []).append({
                "id": "edit-" + str(o.get("id", len(lv.get("places", [])))), "kind": pkind, "label": label,
                "interior": interior, "x": _rnd(o["x"] + o["w"] / 2), "y": _rnd(o["y"] + o["h"] + 12),
                "r": 42 + min(10, int(o["w"] // 60)),
            })

    roads_for_terrain = []
    for r in edit["roads"]:
        samples = spline_samples(r["pts"])
        pts = [[_rnd(p[0]), _rnd(p[1])] for p in samples]
        if r.get("ref"):                                # ganti bentuk jalan bawaan
            base = next((x for x in lv["roads"] if x["id"] == r["ref"]), None)
            if base is None:
                continue
            base["pts"], base["h"], base["w"] = pts, [_rnd(p[2]) for p in samples], r["w"]
            road_id = base["id"]
        else:
            road_id = "edit-" + r["id"]
            lv["roads"].append({"id": road_id, "name": r["name"], "w": r["w"], "kind": r["kind"],
                                "pts": pts, "h": [_rnd(p[2]) for p in samples]})
        roads_for_terrain.append({"id": road_id, "w": r["w"], "samples": samples, "bridgeExclusions": []})
        # pohon di badan jalan baru disingkirkan
        clear = r["w"] / 2 + 12
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        bx0, bx1, by0, by1 = min(xs) - clear, max(xs) + clear, min(ys) - clear, max(ys) + clear
        survivors = []
        for o in obs:
            if o["kind"] in ("tree", "pine"):
                cx, cy = o["x"] + o["w"] / 2, o["y"] + o["h"] / 2
                if bx0 <= cx <= bx1 and by0 <= cy <= by1 and any(
                        _seg_dist(cx, cy, pts[i], pts[i + 1]) < clear for i in range(len(pts) - 1)):
                    continue
            survivors.append(o)
        obs = survivors
    lv["obstacles"] = obs

    auto_bridges = _road_intersections(lv["roads"], lv.get("terrain"))
    manual_bridges = edit.get("bridges", [])
    lv["bridges"] = auto_bridges + manual_bridges
    terrain_roads = {r["id"]: r for r in roads_for_terrain}
    for bridge in lv["bridges"]:
        u_id = bridge.get("upperRoad", "")
        l_id = bridge.get("lowerRoad", "")
        target_ids = set()
        if u_id:
            for cand in [u_id, "edit-" + u_id]:
                if cand in terrain_roads:
                    target_ids.add(cand)
        for tr in roads_for_terrain:
            if any(math.hypot(p[0] - bridge["x"], p[1] - bridge["y"]) < bridge["length"] / 2 + 50
                   and p[2] > bridge["lowerZ"] + 3 for p in tr["samples"]):
                target_ids.add(tr["id"])
        for tr_id in target_ids:
            tr = terrain_roads.get(tr_id)
            if tr:
                tr["bridgeExclusions"].append((
                    bridge["x"], bridge["y"], bridge["angle"],
                    bridge["length"] - 2 * bridge.get("approach", 0) + 30,
                    (bridge.get("width") or tr["w"]) + 2 * FLAT_MARGIN,
                    bridge["lowerZ"] + 3.0,
                ))

    if roads_for_terrain:
        T = lv["terrain"]
        reach = max(r["w"] / 2 + FLAT_MARGIN + MAX_FALL for r in roads_for_terrain)
        max_x = max(p[0] for r in roads_for_terrain for p in r["samples"])
        _extend_terrain(T, min(int(math.ceil(lv["world"]["w"] / T["cell"])) + 1,
                               int(math.ceil((max_x + reach) / T["cell"])) + 1))
        carve(T["h"], T["nx"], T["ny"], roads_for_terrain, T["cell"])
        T["h"] = [round(v, 1) for v in T["h"]]

    feat = lv.setdefault("features", {})
    feat["mapEdit"] = {"objects": len(edit["objects"]), "removed": len(edit["removed"]),
                       "moved": len(edit["moved"]), "roads": len(edit["roads"]),
                       "bridges": len(edit.get("bridges", []))}
    return lv


_cache = {"key": None, "level": None}


def apply_cached(level, edit):
    """Seperti apply_edits, tetapi hasilnya disimpan agar /api/level tidak menghitung ulang."""
    key = json.dumps(edit, sort_keys=True)
    if _cache["key"] != key or _cache["level"] is None:
        _cache["level"], _cache["key"] = apply_edits(level, edit), key
    return _cache["level"]


# ----------------------------------------------------------------------------- data untuk editor
def editor_payload(level):
    """Data peta asli (tanpa editan) yang diperlukan halaman editor."""
    keys, locked = obstacle_keys(level["obstacles"]), locked_flags(level)
    obstacles = []
    for o, k, lk in zip(level["obstacles"], keys, locked):
        item = {"k": k, "kind": o["kind"], "x": o["x"], "y": o["y"], "w": o["w"], "h": o["h"]}
        if o.get("label"):
            item["label"] = o["label"]
        if o.get("color"):
            item["color"] = o["color"]
        if lk == 1:
            item["lock"] = 1
        elif lk == 2:
            item["grp"] = 1
            item["pads"] = house_pad_indices(level, o)
        obstacles.append(item)
    return {
        "name": level.get("name", ""),
        "world": level["world"],
        "terrain": level["terrain"],
        "roads": [{"id": r["id"], "name": r.get("name", r["id"]), "kind": r.get("kind", "local"), "w": r["w"], "pts": r["pts"]}
                  for r in level["roads"]],
        "pads": [{"x": p["x"], "y": p["y"], "w": p["w"], "h": p["h"], "kind": p.get("kind", "")} for p in level.get("pads", [])],
        "sawah": [{"x": s["x"], "y": s["y"], "w": s["w"], "h": s["h"]} for s in level.get("sawah", [])],
        "places": [{"x": p["x"], "y": p["y"], "label": p.get("label", ""), "kind": p.get("kind", "")} for p in level.get("places", [])],
        "regions": level.get("regions", []),
        "obstacles": obstacles,
        "catalog": CATALOG,
        "limits": {"zMin": Z_MIN, "zMax": Z_MAX, "cell": CELL},
    }
