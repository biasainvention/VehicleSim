"""
Kendaraan buatan editor CAD (halaman /vehicle-editor).

Disimpan di settings.json (kunci "customVehicles") dan ditambahkan ke daftar kendaraan level setiap kali game
meminta /api/level, jadi file level_*.py tidak pernah diubah. Satu kendaraan berisi:

  id, name, base   : jenis fisika di game  (car | tractor | box | minitruck)
  color            : warna dasar (dipakai peta mini / HUD)
  spec             : performa, geometri fisik, dan kemampuan fifth wheel / crane towing
  prims            : model 3D sudah dikompilasi -> daftar primitif (satuan px) untuk render3d.bakeCad
  wheels, lamps    : posisi roda (r, w, steer) dan lampu
  parts            : proyek editor (satuan meter) agar kendaraan bisa dibuka & diedit lagi
  park             : titik parkir {x, y, angle} (opsional; kosong = dicarikan tempat kosong dekat Bengkel Rakit Tingkir)
"""
import math
import re

BASES = ("car", "tractor", "box", "minitruck")
FUELS = ("Pertalite", "Solar")
MAX_VEHICLES, MAX_PRIMS, MAX_PARTS, MAX_TRI_FLOATS, MAX_BYTES = 24, 1500, 800, 150000, 1_800_000
PRIM_KINDS = {"box", "boxC", "cylY", "cylY16", "cylX", "cylZ", "cone", "cone16", "sph", "sph12", "bevel", "tris"}
PART_TYPES = re.compile(r"^[A-Za-z0-9_]{1,32}$")
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
_ID = re.compile(r"[^A-Za-z0-9_-]")


# ----------------------------------------------------------------------------- util
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


def _nums(v, count, lo, hi):
    """Daftar angka persis `count` panjang, atau None bila tidak valid."""
    if not isinstance(v, (list, tuple)) or len(v) != count:
        return None
    out = []
    for a in v:
        if isinstance(a, bool) or not isinstance(a, (int, float)) or not math.isfinite(a):
            return None
        out.append(round(max(lo, min(hi, float(a))), 4))
    return out


def _color(v, default="#3b82f6"):
    return v.lower() if isinstance(v, str) and _COLOR.match(v) else default


def _part_point(part, point):
    sx, sy, sz = part["scale"]
    x, y, z = point[0] * sx, point[1] * sy, point[2] * sz
    rx, ry, rz = part["rotation"]
    cx, sxr, cy, syr, cz, szr = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    return [
        part["position"][0] + cy * cz * x - cy * szr * y + syr * z,
        part["position"][1] + (cx * szr + sxr * cz * syr) * x + (cx * cz - sxr * szr * syr) * y - sxr * cy * z,
        part["position"][2] + (sxr * szr - cx * syr * cz) * x + (cx * szr + sxr * syr * cz) * y + cx * cy * z,
    ]


def _crane_tow_pivot(parts, origin_x):
    wheel_x = []
    for part in parts:
        wheel = part.get("wheel")
        if not part.get("isWheel") or not isinstance(wheel, dict):
            continue
        tracks = [0] if wheel.get("single") else [wheel["track"], -wheel["track"]]
        wheel_x.extend(_part_point(part, [0, 0, track])[0] for track in tracks)
    if not wheel_x:
        return None
    x0 = origin_x if origin_x is not None else min(wheel_x)
    tip = [-1.75 * math.cos(math.pi / 6), -1.75 * math.sin(math.pi / 6), 0]
    pivot = None
    for part in parts:
        if part.get("type") == "payloadCrane":
            world = _part_point(part, tip)
            pivot = [round((world[0] - x0) * 10, 2), round(world[2] * 10, 2)]
    return pivot


# ----------------------------------------------------------------------------- validasi
def _prim(p):
    if not isinstance(p, dict) or p.get("k") not in PRIM_KINDS:
        return None
    out = {"k": p["k"], "c": _color(p.get("c"), "#888888")}
    if p["k"] == "tris":
        v = p.get("v")
        if not isinstance(v, list) or len(v) % 9 or len(v) > 30000:
            return None
        flat = _nums(v, len(v), -20000, 20000)
        if flat is None:
            return None
        out["v"] = [round(a, 2) for a in flat]
        return out
    m = _nums(p.get("m"), 16, -50000, 50000)
    if m is None:
        return None
    out["m"] = m
    if p["k"] == "bevel":
        d = _nums(p.get("d"), 3, 0.001, 100)
        if d is None:
            return None
        out["d"] = d
        out["r"] = round(_num(p.get("r"), 0.001, 50, 0.1), 4)
        out["n"] = int(_num(p.get("n"), 1, 12, 4))
        out["mode"] = "chamfer" if p.get("mode") == "chamfer" else "fillet"
    elif p.get("ao"):
        out["ao"] = round(_num(p.get("ao"), 0, 1, 0), 3)
    return out


def _part(p):
    if not isinstance(p, dict) or not isinstance(p.get("type"), str) or not PART_TYPES.match(p["type"]):
        return None
    pos, rot, sc = _nums(p.get("position"), 3, -1000, 1000), _nums(p.get("rotation"), 3, -20, 20), _nums(p.get("scale"), 3, -100, 100)
    if pos is None or rot is None or sc is None:
        return None
    out = {"name": str(p.get("name", ""))[:40], "type": p["type"], "isWheel": bool(p.get("isWheel")), "steerable": bool(p.get("steerable")),
           "isMoving": bool(p.get("isMoving")), "position": pos, "rotation": rot, "scale": sc, "color": _color(p.get("color"), "#888888")}
    cb = _nums(p.get("customBox"), 3, 0.005, 500)
    if cb:
        out["customBox"] = cb
    b = p.get("bevel")
    if isinstance(b, dict) and b.get("mode") in ("chamfer", "fillet"):
        out["bevel"] = {"mode": b["mode"], "r": round(_num(b.get("r"), 0, 50, 0.1), 4), "seg": int(_num(b.get("seg"), 1, 12, 4))}
    w = p.get("wheel")
    if isinstance(w, dict):
        out["wheel"] = {"r": round(_num(w.get("r"), 0.05, 10, 0.6), 4), "w": round(_num(w.get("w"), 0.02, 10, 0.4), 4),
                        "track": round(_num(w.get("track"), 0, 20, 1.1), 4)}
        if w.get("single"):
            out["wheel"]["single"] = True
    if p.get("ao"):
        out["ao"] = round(_num(p.get("ao"), 0, 1, 0), 3)
    t = p.get("tris")
    if isinstance(t, list) and len(t) % 9 == 0 and 0 < len(t) <= 30000:
        flat = _nums(t, len(t), -2000, 2000)
        if flat is not None:
            out["tris"] = flat
    return out


def sanitize(raw, rev=None):
    """Bersihkan satu kendaraan dari klien / settings.json. Mengembalikan dict bersih atau None."""
    if not isinstance(raw, dict):
        return None
    vid = _ID.sub("", str(raw.get("id", "")))[:32]
    if not vid:
        return None
    s = raw.get("spec") if isinstance(raw.get("spec"), dict) else {}
    spec = {
        "vf": round(_num(s.get("vf"), 20, 900, 150), 2), "acc": round(_num(s.get("acc"), 20, 900, 120), 2),
        "maxSteerDeg": round(_num(s.get("maxSteerDeg"), 5, 60, 34), 2), "tank": round(_num(s.get("tank"), 1, 1000, 80), 1),
        "burn": round(_num(s.get("burn"), 0.0005, 0.5, 0.02), 5), "mass": round(_num(s.get("mass"), 0.2, 30, 1.5), 2),
        "grip": round(_num(s.get("grip"), 0.1, 1.5, 0.4), 2),
        "fuelName": s.get("fuelName") if s.get("fuelName") in FUELS else "Pertalite", "door": round(_num(s.get("door"), 4, 150, 20), 1),
        "wb": round(_num(s.get("wb"), 4, 250, 30), 2), "front": round(_num(s.get("front"), 0, 400, 40), 2),
        "rear": round(_num(s.get("rear"), -400, 0, -10), 2), "hw": round(_num(s.get("hw"), 2, 120, 11), 2),
    }
    if s.get("vr") is not None:
        spec["vr"] = round(_num(s.get("vr"), 5, 200, 50), 1)
    if s.get("fifth") is not None:
        spec["fifth"] = round(_num(s.get("fifth"), -150, 150, 4), 2)
    tow_pivot = _nums(s.get("towPivot"), 2, -1000, 1000)
    if tow_pivot:
        spec["towPivot"] = tow_pivot
    spec["canTow"] = s.get("canTow") is True
    spec["canTowVehicle"] = s.get("canTowVehicle") is True
    prims = [q for q in (_prim(p) for p in (raw.get("prims") or [])[:MAX_PRIMS]) if q]
    movers = []                                       # bagian bergerak (wiper): titik tumpu, sumbu putar, sudut sapuan, prim
    for mv in (raw.get("movers") or [])[:8]:
        if not isinstance(mv, dict):
            continue
        pivot, axis = _nums(mv.get("pivot"), 3, -1000, 1000), _nums(mv.get("axis"), 3, -1, 1)
        mp = [q for q in (_prim(p) for p in (mv.get("prims") or [])[:12]) if q]
        if pivot and axis and mp:
            movers.append({"pivot": pivot, "axis": axis, "a": round(_num(mv.get("a"), -3, 3, 1.2), 3), "prims": mp})
    if sum(len(q.get("v", ())) for q in prims + [q for m in movers for q in m["prims"]]) > MAX_TRI_FLOATS:
        return None
    wheels = []
    for w in (raw.get("wheels") or [])[:24]:
        if isinstance(w, dict):
            item = {"x": round(_num(w.get("x"), -1000, 1000, 0), 2), "y": round(_num(w.get("y"), 0, 500, 5), 2), "z": round(_num(w.get("z"), -500, 500, 0), 2),
                    "r": round(_num(w.get("r"), 0.5, 100, 4), 2), "w": round(_num(w.get("w"), 0.2, 100, 3), 2)}
            if w.get("steer"):
                item["steer"] = True
            wheels.append(item)
    if len(wheels) < 2 or not prims:
        return None                                   # kendaraan tanpa roda / tanpa bodi tidak bisa dimainkan
    lamps = []
    for l in (raw.get("lamps") or [])[:24]:
        if isinstance(l, dict) and l.get("kind") in ("head", "tail"):
            lamps.append({"x": round(_num(l.get("x"), -1000, 1000, 0), 2), "y": round(_num(l.get("y"), 0, 500, 7), 2), "z": round(_num(l.get("z"), -500, 500, 0), 2),
                          "sx": round(_num(l.get("sx"), 0.2, 50, 1), 2), "sy": round(_num(l.get("sy"), 0.2, 50, 1.6), 2), "sz": round(_num(l.get("sz"), 0.2, 50, 3.4), 2), "kind": l["kind"]})
    parts = [q for q in (_part(p) for p in (raw.get("parts") or [])[:MAX_PARTS]) if q]
    out = {"id": vid, "name": (str(raw.get("name", "")).strip()[:30] or "Kendaraan CAD"), "base": raw.get("base") if raw.get("base") in BASES else "car",
           "color": _color(raw.get("color")), "spec": spec, "prims": prims, "movers": movers, "wheels": wheels, "lamps": lamps, "parts": parts,
           "rev": int(_num(rev if rev is not None else raw.get("rev"), 0, 10**9, 1))}
    if raw.get("originX") is not None:
        out["originX"] = round(_num(raw.get("originX"), -200, 200, 0), 4)       # titik acuan (m) di ruang editor; kosong = roda paling belakang
    if "towPivot" not in spec and any(p["type"] == "payloadCrane" for p in parts):
        pivot = _crane_tow_pivot(parts, out.get("originX"))
        if pivot:
            spec["towPivot"] = pivot
    pk = raw.get("park")
    if isinstance(pk, dict) and pk.get("x") is not None and pk.get("y") is not None:
        out["park"] = {"x": round(_num(pk.get("x"), 0, 20000, 0), 1), "y": round(_num(pk.get("y"), 0, 20000, 0), 1), "angle": round(_num(pk.get("angle"), -360, 360, 0), 1)}
    return out


def sanitize_list(raw):
    out, ids = [], set()
    for r in (raw if isinstance(raw, list) else [])[:MAX_VEHICLES]:
        v = sanitize(r)
        if v and v["id"] not in ids:
            ids.add(v["id"])
            out.append(v)
    return out


# ----------------------------------------------------------------------------- katalog aset yang bisa dimuat ke editor
def asset_catalog(level):
    """Semua kendaraan yang ada di game: yang ada di peta, stok dealer, dan model dasar."""
    keys = ("acc", "vf", "vr", "tank", "wb", "front", "rear", "hw", "door", "burn", "vTakeoff", "v0", "maxAlt", "climbRate", "maxSteer",
            "grip", "damageRate", "fifth", "canTow", "canTowVehicle", "fuelName", "price", "mass")
    cat, seen = [], set()

    def add(group, vid, name, vtype, model, color, over):
        if vid in seen:
            return
        seen.add(vid)
        cat.append({"id": vid, "group": group, "name": name, "type": vtype, "model": model or vtype, "color": color or "#3b82f6",
                    "over": {k: over[k] for k in keys if k in over and not isinstance(over[k], (dict, list))}})

    for v in level.get("vehicles", []):
        if v.get("model") == "cad":
            continue                                   # kendaraan hasil editor tidak ikut (agar tidak berantai)
        add("Kendaraan di peta", v["id"], v.get("name", v["id"]), v["type"], v.get("model"), v.get("color"), v)
    for s in (level.get("dealer") or {}).get("stock", []):
        over = dict(s.get("spec") or {})
        add("Stok dealer Mitsubishi", "dealer-" + s["id"], s.get("name", s["id"]), "car", s.get("model"), s.get("color"), over)
    add("Model dasar", "base-box", "Truk Box (bawaan)", "box", None, "#e5e7eb", {})
    return cat


# ----------------------------------------------------------------------------- parkir otomatis
def _seg_dist(px, py, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy or 1e-9
    t = max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / l2))
    return math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))


def find_parking(level, vehicles):
    """Kembalikan {id: (x, y, angle)}: titik parkir kosong terdekat dari Bengkel Rakit Tingkir untuk tiap kendaraan."""
    lot = (level.get("bengkel") or {}).get("lot") or []
    ax = sum(s["x"] for s in lot) / len(lot) + 160 if lot else level["spawn"]["x"]
    ay = sum(s["y"] for s in lot) / len(lot) if lot else level["spawn"]["y"]
    W, H = level["world"]["w"], level["world"]["h"]
    R = 700
    boxes = [(o["x"] - 6, o["y"] - 6, o["x"] + o["w"] + 6, o["y"] + o["h"] + 6) for o in level.get("obstacles", [])
             if o["x"] < ax + R + 400 and o["x"] + o["w"] > ax - R - 400 and o["y"] < ay + R + 400 and o["y"] + o["h"] > ay - R - 400]
    for p in level.get("pads", []):                    # SPBU, parkir, dll. jangan dipakai
        if p.get("kind") in ("spbu", "dock", "sawah") and p["x"] < ax + R and p["x"] + p["w"] > ax - R and p["y"] < ay + R and p["y"] + p["h"] > ay - R:
            boxes.append((p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"]))
    for v in level.get("vehicles", []):
        boxes.append((v["x"] - 50, v["y"] - 30, v["x"] + 70, v["y"] + 30))
    for s in lot:
        boxes.append((s["x"] - 70, s["y"] - 40, s["x"] + 70, s["y"] + 40))
    segs = []
    for r in level.get("roads", []):
        pts = r["pts"]
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            if min(a[0], b[0]) - r["w"] < ax + R + 300 and max(a[0], b[0]) + r["w"] > ax - R - 300 and min(a[1], b[1]) - r["w"] < ay + R + 300 and max(a[1], b[1]) + r["w"] > ay - R - 300:
                segs.append((a, b, r["w"] / 2))
    cand = [(ax + dx, ay + dy) for dx in range(-R, R + 1, 25) for dy in range(-R, R + 1, 25)]
    cand.sort(key=lambda c: (c[0] - ax) ** 2 + (c[1] - ay) ** 2)
    taken, out = [], {}
    for v in vehicles:
        sp = v["spec"]
        x0, x1, hw = sp["rear"] - 12, sp["front"] + 12, sp["hw"] + 12                # sedikit lega
        for cx, cy in cand:
            rect = (cx + x0, cy - hw, cx + x1, cy + hw)
            if rect[0] < 40 or rect[1] < 40 or rect[2] > W - 40 or rect[3] > H - 40:
                continue
            if any(rect[0] < b[2] and rect[2] > b[0] and rect[1] < b[3] and rect[3] > b[1] for b in boxes + taken):
                continue
            pts = [(rect[0], rect[1]), (rect[2], rect[1]), (rect[0], rect[3]), (rect[2], rect[3]), (cx, cy), ((rect[0] + rect[2]) / 2, rect[1]), ((rect[0] + rect[2]) / 2, rect[3])]
            if any(_seg_dist(px, py, a, b) < hr + 8 for px, py in pts for a, b, hr in segs):
                continue
            taken.append(rect)
            out[v["id"]] = (round(cx, 1), round(cy, 1), 0)
            break
        else:
            out[v["id"]] = (round(ax, 1), round(ay, 1), 0)                           # tak ada tempat kosong: taruh di titik acuan
    return out


# ----------------------------------------------------------------------------- terapkan ke level
def apply_vehicles(level, vehicles):
    """Salinan dangkal level dengan kendaraan CAD ditambahkan ke level["vehicles"] (level asli tidak diubah)."""
    if not vehicles:
        return level
    auto = find_parking(level, [v for v in vehicles if "park" not in v])
    lv = dict(level)
    items = list(level["vehicles"])
    for v in vehicles:
        s = v["spec"]
        part_types = {p["type"] for p in v["parts"] if isinstance(p, dict)}
        x, y, ang = (v["park"]["x"], v["park"]["y"], v["park"]["angle"]) if "park" in v else auto[v["id"]]
        d = {"id": "cad-" + v["id"], "name": v["name"], "type": v["base"], "model": "cad", "color": v["color"], "x": x, "y": y, "angle": ang, "fuel": 0.8,
             "wb": s["wb"], "front": s["front"], "rear": s["rear"], "hw": s["hw"], "door": s["door"], "vf": s["vf"], "acc": s["acc"], "tank": s["tank"],
             "burn": s["burn"], "mass": s["mass"], "grip": s.get("grip", 0.4), "fuelName": s["fuelName"], "maxSteer": round(math.radians(s["maxSteerDeg"]), 5),
             "canTow": bool(s.get("canTow") or v["base"] == "tractor" or "payloadFifthWheel" in part_types),
             "canTowVehicle": bool(s.get("canTowVehicle") or "payloadCrane" in part_types),
             "cad": {"id": v["id"], "rev": v["rev"], "prims": v["prims"], "movers": v.get("movers", []), "wheels": v["wheels"], "lamps": v["lamps"]}}
        if "towPivot" in s:
            d["towPivot"] = s["towPivot"]
        if "vr" in s:
            d["vr"] = s["vr"]
        if "fifth" in s:
            d["fifth"] = s["fifth"]
        items.append(d)
    lv["vehicles"] = items
    feat = dict(level.get("features") or {})
    feat["customVehicles"] = len(vehicles)
    lv["features"] = feat
    return lv