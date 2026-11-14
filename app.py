"""
Lintas Salatiga (dulu Trailer Yard) - game sopir trailer dunia terbuka berbasis Flask.

Flask menyajikan halaman game, data level (layout dock, drop zone, rintangan),
dan papan skor (disimpan di scores.json). Game & input gamepad berjalan di browser
lewat HTML5 Canvas + Gamepad API.

Jalankan:
    pip install -r requirements.txt
    python app.py
lalu buka http://127.0.0.1:5000
"""
import json
import math
import os
import threading
import time

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SCORE_FILE = os.path.join(BASE_DIR, "scores.json")
SAVE_FILE = os.path.join(BASE_DIR, "saves.json")      # simpanan permainan per nama pemain
MAX_SAVE_BYTES = 400_000
_lock = threading.Lock()

# Layout level: rute Salatiga -> Tengaran (level_salatiga.py) + wilayah barat baru:
# jalan naik-turun ke Kopeng, AMP aspal, lahan kosong (level_world.py).
from level_world import LEVEL  # noqa: E402
import mapedit  # noqa: E402  (editor peta: objek & jalan spline, disimpan di mapedit.json)
import customveh  # noqa: E402  (editor kendaraan CAD: kendaraan buatan sendiri, disimpan di settings.json)

# File pengaturan: channel TV, jalan buatan paver, dan parameter suspensi.
SETTINGS_FILE = os.path.join(BASE_DIR, "settings.json")
MAPEDIT_FILE = os.path.join(BASE_DIR, "mapedit.json")
DEFAULT_SETTINGS = {
    "_catatan": ("File pengaturan game. tv.channels: daftar channel YouTube untuk TV di dalam game "
                 "(isi 'channelId' UC..., 'playlist' PL..., atau 'uploads' nama pengguna YouTube lama). builtRoads: jalan aspal buatan pemain "
                 "(dibuat oleh asphalt paver); hapus isinya untuk mengosongkan lagi lahan. "
                 "suspension: stiffness (rad/s), damping (rasio), travelCm (cm), pitchLimitDeg dan rollLimitDeg. "
                 "edit peta disimpan terpisah di mapedit.json; kosongkan file itu lewat editor untuk mengembalikan peta asli. "
                 "customVehicles: kendaraan buatan halaman /vehicle-editor (model 3D + spesifikasi); hapus lewat editornya."),
    "tv": {"channels": [
        {"name": "Kids Tv Prasekolah — huruf, angka, warna", "channelId": "UC3ogtOXhPdkJkr1YGp__bkA"},
        {"name": "YuBimba — belajar calistung", "channelId": "UCFuXWy14mWziGXCT0ZITgmg"},
        {"name": "Kok Bisa? — sains & pengetahuan", "channelId": "UCu0yQD7NFMyLu_-TmKa4Hqg"},
        {"name": "Nussa Official — animasi edukasi", "channelId": "UCV2jNjJEtO0Hr3b1Es3xPJg"},
        {"name": "Yufid Kids — unggahan kanal", "uploads": "YufidKids"},
    ]},
    "builtRoads": [],
    "customVehicles": [],
    "suspension": {"stiffness": 15.0, "damping": 1.2, "travelCm": 60.0, "pitchLimitDeg": 7.0, "rollLimitDeg": 13.0},
}
MAX_BUILT_ROADS = 2000

# Versi game: dipakai untuk memastikan browser memuat file terbaru (cache-busting) dan untuk
# mendeteksi server lama yang masih berjalan. Naikkan setiap rilis.
GAME_VERSION = "2026.11.14-underpass-towing-b"
LEVEL["version"] = GAME_VERSION
LEVEL["features"] = {"signals": len(LEVEL.get("signals", [])), "bengkel": "bengkel" in LEVEL,
                     "mosques": sum(p.get("kind") == "mosque" for p in LEVEL.get("places", [])),
                     "tingkirBusTerminal": any(o.get("id") == "terminal-bus-tingkir" for o in LEVEL.get("places", []))}


def load_settings():
    """Baca settings.json; buat dengan nilai bawaan bila belum ada / rusak."""
    data = None
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            data = None
    if not isinstance(data, dict):
        data = json.loads(json.dumps(DEFAULT_SETTINGS))
        write_settings(data)
    data.setdefault("tv", DEFAULT_SETTINGS["tv"])
    data.setdefault("builtRoads", [])
    data["customVehicles"] = customveh.sanitize_list(data.get("customVehicles"))
    saved_suspension = data.get("suspension")
    if not isinstance(saved_suspension, dict):
        saved_suspension = {}
    data["suspension"] = {
        "stiffness": _setting_number(saved_suspension.get("stiffness"), 4, 25, 15.0),
        "damping": _setting_number(saved_suspension.get("damping"), 0.3, 2.0, 1.2),
        "travelCm": _setting_number(saved_suspension.get("travelCm"), 0, 100, 60.0),
        "pitchLimitDeg": _setting_number(saved_suspension.get("pitchLimitDeg"), 1, 25, 7.0),
        "rollLimitDeg": _setting_number(saved_suspension.get("rollLimitDeg"), 1, 30, 13.0),
    }
    return data


def _setting_number(value, minimum, maximum, default):
    if isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number) or not minimum <= number <= maximum:
        return default
    return number


def write_settings(data):
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(tmp, SETTINGS_FILE)


def load_mapedit(settings=None):
    """Muat edit peta dari file khusus; migrasikan editan lama dari settings.json sekali."""
    if os.path.exists(MAPEDIT_FILE):
        try:
            with open(MAPEDIT_FILE, encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            raise RuntimeError(f"Gagal membaca {os.path.basename(MAPEDIT_FILE)}: {exc}") from exc
        if not isinstance(data, dict):
            raise RuntimeError(f"Format {os.path.basename(MAPEDIT_FILE)} tidak valid")
        edit = mapedit.sanitize(data, LEVEL["world"])
        if settings is not None and "mapEdit" in settings:
            settings.pop("mapEdit")
            write_settings(settings)
        return edit

    st = settings if settings is not None else load_settings()
    legacy = st.pop("mapEdit", None)
    edit = mapedit.sanitize(legacy, LEVEL["world"])
    write_mapedit(edit)
    if legacy is not None:
        write_settings(st)
    return edit


def write_mapedit(edit):
    tmp = MAPEDIT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(edit, f, indent=1, ensure_ascii=False)
    os.replace(tmp, MAPEDIT_FILE)


def load_scores():
    if not os.path.exists(SCORE_FILE):
        return []
    try:
        with open(SCORE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_scores(scores):
    with open(SCORE_FILE, "w", encoding="utf-8") as f:
        json.dump(scores, f, indent=2, ensure_ascii=False)


@app.route("/")
@app.route("/3d")
def index():
    """Game sekarang penuh 3D (WebGL2). /3d tetap ada agar tautan lama tidak rusak."""
    return render_template("index.html", mode3d=True, version=GAME_VERSION)


@app.get("/api/level")
def get_level():
    """Level dasar dari level_salatiga/level_world + editan persisten dari mapedit.json."""
    with _lock:
        st = load_settings()
        edit = load_mapedit(st)
    lv = mapedit.apply_cached(LEVEL, edit)
    return jsonify(_with_custom_vehicles(lv, st["customVehicles"]))


_veh_cache = {"key": None, "base": None, "level": None}


def _with_custom_vehicles(lv, vehicles):
    """Tambahkan kendaraan buatan editor CAD ke level (hasil di-cache selama editan tidak berubah)."""
    if not vehicles:
        return lv
    key = json.dumps([(v["id"], v["rev"], v.get("park")) for v in vehicles])
    if _veh_cache["key"] != key or _veh_cache["base"] is not lv:
        _veh_cache.update(key=key, base=lv, level=customveh.apply_vehicles(lv, vehicles))
    return _veh_cache["level"]


@app.route("/vehicle-editor")
def vehicle_editor():
    """Editor kendaraan CAD: bangun kendaraan dari nol atau dari aset game, simpan ke game."""
    return render_template("vehicle_editor.html", version=GAME_VERSION)


@app.get("/api/vehicles")
def get_vehicles():
    with _lock:
        vehicles = load_settings()["customVehicles"]
    lv = _with_custom_vehicles(LEVEL, vehicles)
    park = {v["id"][4:]: [v["x"], v["y"], v["angle"]] for v in lv["vehicles"] if v.get("model") == "cad"}
    slim = [{k: v[k] for k in ("id", "name", "base", "color", "spec", "parts", "park", "rev", "originX") if k in v} for v in vehicles]
    return jsonify(vehicles=slim, catalog=customveh.asset_catalog(LEVEL), parking=park, bases=list(customveh.BASES))


@app.post("/api/vehicles")
def post_vehicle():
    if request.content_length and request.content_length > 3_000_000:
        return jsonify(error="data kendaraan terlalu besar"), 413
    body = request.get_json(silent=True, force=True) or {}
    raw = body.get("vehicle")
    with _lock:
        st = load_settings()
        old = {v["id"]: v for v in st["customVehicles"]}
        rev = old.get(str((raw or {}).get("id", "")), {}).get("rev", 0) + 1 if isinstance(raw, dict) else 1
        v = customveh.sanitize(raw, rev)
        if not v:
            return jsonify(error="kendaraan tidak valid (minimal harus punya bodi dan 2 roda)"), 400
        if v["id"] not in old and len(old) >= customveh.MAX_VEHICLES:
            return jsonify(error=f"maksimal {customveh.MAX_VEHICLES} kendaraan buatan"), 400
        old[v["id"]] = v
        st["customVehicles"] = list(old.values())
        write_settings(st)
        vehicles = st["customVehicles"]
    lv = _with_custom_vehicles(LEVEL, vehicles)
    me = next(d for d in lv["vehicles"] if d["id"] == "cad-" + v["id"])
    return jsonify(ok=True, id=v["id"], rev=v["rev"], park={"x": me["x"], "y": me["y"], "angle": me["angle"]})


@app.delete("/api/vehicles/<vid>")
def delete_vehicle(vid):
    with _lock:
        st = load_settings()
        st["customVehicles"] = [v for v in st["customVehicles"] if v["id"] != vid]
        write_settings(st)
    return jsonify(ok=True)


@app.route("/editor")
def editor():
    """Editor peta: tambah/pindah objek, gambar jalan spline, atur tinggi jalan & tanah."""
    return render_template("editor.html", version=GAME_VERSION)


@app.get("/api/mapedit")
def get_mapedit():
    with _lock:
        st = load_settings()
        edit = load_mapedit(st)
    return jsonify(edit=edit, base=mapedit.editor_payload(LEVEL))


@app.post("/api/mapedit")
def post_mapedit():
    body = request.get_json(silent=True, force=True) or {}
    if not isinstance(body.get("edit"), dict):
        return jsonify(error="data editan tidak valid"), 400
    edit = mapedit.sanitize(body["edit"], LEVEL["world"])
    with _lock:
        st = load_settings()
        load_mapedit(st)
        write_mapedit(edit)
    return jsonify(ok=True, edit=edit, counts={"objects": len(edit["objects"]), "removed": len(edit["removed"]),
                                               "moved": len(edit["moved"]), "roads": len(edit["roads"])})


@app.delete("/api/mapedit")
def delete_mapedit():
    with _lock:
        st = load_settings()
        load_mapedit(st)
        write_mapedit(mapedit.empty_edit())
    return jsonify(ok=True)


@app.get("/api/settings")
def get_settings():
    with _lock:
        return jsonify(load_settings())


@app.post("/api/settings/suspension")
def update_suspension_settings():
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("suspension"), dict):
        return jsonify(error="pengaturan suspensi tidak valid"), 400
    values = body["suspension"]
    bounds = {
        "stiffness": (4, 25), "damping": (0.3, 2.0), "travelCm": (0, 100),
        "pitchLimitDeg": (1, 25), "rollLimitDeg": (1, 30),
    }
    suspension = {}
    for key, (minimum, maximum) in bounds.items():
        value = values.get(key)
        if isinstance(value, bool):
            return jsonify(error=f"{key} harus berupa angka"), 400
        try:
            number = float(value)
        except (TypeError, ValueError):
            return jsonify(error=f"{key} harus berupa angka"), 400
        if not math.isfinite(number) or not minimum <= number <= maximum:
            return jsonify(error=f"{key} harus antara {minimum} dan {maximum}"), 400
        suspension[key] = number
    with _lock:
        settings = load_settings()
        settings["suspension"] = suspension
        write_settings(settings)
    return jsonify(ok=True, suspension=suspension)


@app.post("/api/roads")
def post_road():
    """Tambahkan satu ruas jalan aspal buatan paver ke settings.json."""
    body = request.get_json(silent=True, force=True) or {}
    pts = body.get("pts")
    try:
        w = float(body.get("w", 70))
        pts = [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in pts][:2000]
    except (TypeError, ValueError, IndexError):
        return jsonify(error="data tidak valid"), 400
    if len(pts) < 2:
        return jsonify(error="ruas terlalu pendek"), 400
    road = {"pts": pts, "w": max(30.0, min(w, 160.0)), "by": str(body.get("by", ""))[:20], "at": time.strftime("%Y-%m-%d %H:%M:%S")}
    with _lock:
        st = load_settings()
        st["builtRoads"] = (st.get("builtRoads") or [])[-MAX_BUILT_ROADS + 1:] + [road]
        write_settings(st)
    return jsonify(ok=True, count=len(st["builtRoads"]))


@app.put("/api/roads")
def put_roads():
    """Ganti seluruh daftar jalan buatan (dipakai road milling setelah mengupas aspal)."""
    body = request.get_json(silent=True, force=True) or {}
    raw = body.get("roads")
    if not isinstance(raw, list):
        return jsonify(error="data tidak valid"), 400
    roads = []
    for r in raw[:MAX_BUILT_ROADS]:
        try:
            pts = [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in r["pts"]][:2000]
            w = float(r.get("w", 70))
        except (TypeError, ValueError, IndexError, KeyError, AttributeError):
            continue
        if len(pts) < 2:
            continue
        roads.append({"pts": pts, "w": max(30.0, min(w, 160.0)), "by": str(r.get("by", ""))[:20],
                      "at": str(r.get("at", ""))[:19]})
    with _lock:
        st = load_settings()
        st["builtRoads"] = roads
        write_settings(st)
    return jsonify(ok=True, count=len(roads))


@app.delete("/api/roads")
def delete_roads():
    with _lock:
        st = load_settings()
        st["builtRoads"] = []
        write_settings(st)
    return jsonify(ok=True)


@app.get("/api/scores")
def get_scores():
    with _lock:
        scores = load_scores()
    scores.sort(key=lambda s: s.get("score", 0), reverse=True)
    return jsonify(scores[:10])


@app.post("/api/scores")
def post_score():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "Pemain")).strip()[:20] or "Pemain"
    try:
        score = int(data.get("score", 0))
        elapsed = float(data.get("time", 0))
        damage = int(data.get("damage", 0))
        mission = int(data.get("mission", 0))
    except (TypeError, ValueError):
        return jsonify(error="data tidak valid"), 400

    entry = {
        "name": name,
        "score": max(0, min(score, 10000)),
        "time": round(max(0.0, elapsed), 1),
        "damage": max(0, damage),
        "mission": mission,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    with _lock:
        scores = load_scores()
        scores.append(entry)
        scores.sort(key=lambda s: s.get("score", 0), reverse=True)
        scores = scores[:100]
        save_scores(scores)
        rank = scores.index(entry) + 1 if entry in scores else None
    return jsonify(ok=True, rank=rank)


def _load_saves():
    if not os.path.exists(SAVE_FILE):
        return {}
    try:
        with open(SAVE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save_key(name):
    return (str(name or "").strip()[:20] or "Pemain").lower()


@app.get("/api/save")
def get_save():
    with _lock:
        entry = _load_saves().get(_save_key(request.args.get("name")))
    if not entry:
        return jsonify(data=None)            # belum ada simpanan
    return jsonify(entry)


@app.post("/api/save")
def post_save():
    """Simpan keadaan permainan (dipanggil berkala & saat tab ditutup lewat sendBeacon)."""
    if request.content_length and request.content_length > MAX_SAVE_BYTES:
        return jsonify(error="simpanan terlalu besar"), 413
    body = request.get_json(silent=True, force=True) or {}
    data = body.get("data")
    if not isinstance(data, dict):
        return jsonify(error="data tidak valid"), 400
    with _lock:
        saves = _load_saves()
        saves[_save_key(body.get("name"))] = {"data": data, "savedAt": time.time()}
        tmp = SAVE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(saves, f, ensure_ascii=False)
        os.replace(tmp, SAVE_FILE)
    return jsonify(ok=True)

@app.route("/telemetry")
def telemetry():
    """Halaman dashboard telemetri real-time kendaraan."""
    return render_template("telemetry.html")

@app.delete("/api/save")
def delete_save():
    with _lock:
        saves = _load_saves()
        if saves.pop(_save_key(request.args.get("name")), None) is not None:
            with open(SAVE_FILE, "w", encoding="utf-8") as f:
                json.dump(saves, f, ensure_ascii=False)
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
