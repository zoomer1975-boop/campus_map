#!/usr/bin/env python3
"""Replace campus building footprints with MOLIT "GIS건물통합정보" (VWorld) shapefile data.

Reads the building register footprint shapefile for 대구광역시 (.shp/.shx/.dbf/.prj, optional
.cpg), keeps the OSM roads, areas and campus outline in data/campus.json and swaps the
buildings. Standard library only (no pyproj/pyshp/GDAL).

Usage:
    python3 scripts/import_shp.py /path/to/AL_D010_27_YYYYMMDD.shp --dry-run
    python3 scripts/import_shp.py /path/to/AL_D010_27_YYYYMMDD.shp
Options: --out data/campus.json, --date YYYY-MM-DD, --crs 5186 (only if the .prj is missing),
--encoding cp949, and field overrides --id-field/--name-field/--dong-field/--floors-field/
--height-field/--use-field when the DBF column names are not detected.

CRS: the .prj WKT is parsed (Transverse Mercator parameters, ellipsoid, prime meridian).
GRS80/WGS84 TM systems on Greenwich work (EPSG:5186 Central Belt 2010, 5179 UTM-K,
5185/5187/5188, ...). Bessel (old EPSG:5174 files), a non-Greenwich prime meridian and
anything unknown stop with an error, because they need a datum shift or longitude offset
that this script does not do. Projection math is the Krüger n-series to 6th order (Karney
2011), accurate to far below a millimetre here.

Merge rules:
1. The OSM data comes from data/campus.json, or from data/campus.osm.json if campus.json was
   already imported (it then has "buildingSource"). OSM buildings whose centroid lies inside
   the campus bbox are removed; SHP buildings whose centroid lies inside it are added. OSM
   buildings outside the bbox are kept. Roads, areas and campusOutline are kept as they are.
   At the bbox edge in/out is decided once per matched pair, because register and OSM
   outlines are often 2-6 m apart: an SHP building whose centroid is just outside the bbox
   is still added when it matches a removed OSM building, and a kept OSM building is dropped
   when an added SHP building covers it.
2. Each SHP building gets outer/holes as [lat, lon] rounded to 7 decimals and tags:
   building:levels (A26 rounded, if >= 1), height (A16 if > 0, metres, as a string like
   OSM), reg:name (A24), reg:dong (A25), reg:use (A9), reg:approved (A13), reg:underground
   (A27 rounded, if >= 1), reg:id (A1, or "#<record index>" when there is no A1 value, so
   every register building carries it), plus building (OSM value of the match, else derived
   from A9). When A26 or A16 is missing or 0 and the matched OSM building has
   building:levels or height, that value is copied and marked levels:source=osm or
   height:source=osm. id = "m" + A1 ("m<record index>" if A1 is empty); extra outer rings
   of one record get "-2", "-3", ... appended.
3. Names: each SHP building is matched to the original OSM buildings by overlap, estimated
   with a grid of sample points (a match needs at least half of either polygon inside the
   other). If a named OSM building matches, the building takes the OSM name (so
   data/buildings_meta.json keys keep working) and the OSM name:en/amenity tags. Otherwise
   the name is A25 (dong name) unless it is generic ("주동", "1동", "제1동", "A동",
   "주건축물제1동", "경비실", ...). The fallback is A24 (building name) only when no other
   imported register building has the same A24, because the front end groups buildings by
   name: a shared A24 such as "계명대학교" becomes "A24 A25" when that is unique, else the
   name stays null. tags["osm:id"] records the matched OSM element. One OSM building may give
   its name to several SHP buildings.
4. campus: an SHP building that matches a campus OSM building is campus. Otherwise it needs
   its centroid inside a campusOutline ring AND an A9 that is not residential, religious or
   neighbourhood-commercial (공동주택, 단독주택, 종교, 근린생활), unless A9/A24/A25 mention
   대학, 기숙사 or 생활관 (a university chapel or dormitory). Without A9 the matched OSM
   building's flag is used; without a match only the outline test counts. Finally all
   buildings that share a name get the same flag (campus if any of them is), so the front
   end's name groups do not depend on record order.
5. attribution gains the register credit, and "buildingSource" records file, crs, count and
   importedAt.
6. Before overwriting, the OSM version is saved to data/campus.osm.json, so re-running the
   import or restoring OSM is always possible. An existing backup is never overwritten: if
   campus.json is a different pure-OSM file (fetch_osm.py was run again), the old backup is
   first renamed to campus.osm.<its date and time>.json.
"""
import argparse
import codecs
import datetime
import json
import math
import mmap
import re
import struct
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_osm import BBOX, point_in_poly  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "data" / "campus.json"
REGISTER_CREDIT = "건물: 국토교통부 GIS건물통합정보 (브이월드), CC BY"
BBOX_MARGIN_M = 150  # projected prefilter margin; the final test uses the centroid
MATCH_FRACTION = 0.5
EXCLUDED_USES = ("공동주택", "단독주택", "종교", "근린생활")
CAMPUS_HINTS = ("대학", "기숙사", "생활관")  # in A9/A24/A25: university-owned despite EXCLUDED_USES

# Korean GRS80 TM systems, used to label the CRS and for --crs when the .prj is missing.
KNOWN_CRS = {
    5179: ("Korea 2000 / Unified CS (UTM-K)", 38, 127.5, 0.9996, 1000000, 2000000),
    5181: ("Korea 2000 / Central Belt", 38, 127, 1, 200000, 500000),
    5185: ("Korea 2000 / West Belt 2010", 38, 125, 1, 200000, 600000),
    5186: ("Korea 2000 / Central Belt 2010", 38, 127, 1, 200000, 600000),
    5187: ("Korea 2000 / East Belt 2010", 38, 129, 1, 200000, 600000),
    5188: ("Korea 2000 / East Sea Belt 2010", 38, 131, 1, 200000, 600000),
}
GRS80 = (6378137.0, 298.257222101)

# Logical key -> DBF column candidates. AL_D010 files use A0..A28; the rest are guesses for
# files exported with Korean or English column names (a DBF name holds at most 10 bytes).
FIELD_CANDIDATES = {
    # Full Korean names do not fit in 10 bytes, so exporters truncate them ("건물통합식").
    "id": ["A1", "GIS건물통합식별번호", "건물통합식별번호", "통합식별번호", "건물통합식", "GIS건물통",
           "통합식별번", "식별번호", "BD_ID", "BLD_ID"],
    "dongcode": ["A3", "법정동코드", "BJD_CD", "BJDONG_CD"],
    "use": ["A9", "건축물용도명", "건축물용도", "용도명", "주용도명", "주용도", "BDTYP_NM", "MAIN_PURPS"],
    "area": ["A12", "건축물면적", "BLDG_AREA"],
    "approved": ["A13", "사용승인일자", "사용승인일", "USEAPR_DAY", "USE_APR_DAY"],
    "height": ["A16", "높이", "HEIGHT", "HEIT", "BLD_HGT"],
    "name": ["A24", "건물명", "BLD_NM", "BULD_NM", "BLDG_NM"],
    "dong": ["A25", "건물동명", "동명", "DONG_NM", "BULD_NM_DC"],
    "floors": ["A26", "지상층수", "지상층_수", "지상층", "GRND_FLR", "GRO_FLO_CO"],
    "underground": ["A27", "지하층수", "지하층_수", "지하층", "UGRND_FLR", "UND_FLO_CO"],
}
OVERRIDABLE = ("id", "name", "dong", "floors", "height", "use")

# Registry dong names that say nothing about the building (compared after NFKC, so "１동"
# counts as "1동"). Multi-syllable names such as 본관 or 별관 are kept: they are real names.
GENERIC_DONG = {"주동", "본동", "별동", "부속동", "주건물", "부속건물", "동", "-", "0", "없음",
                "관리동", "관리실", "경비동", "경비실", "경비초소", "초소", "기계실", "기계동",
                "전기실", "변전실", "발전기실", "펌프실", "보일러실", "창고", "화장실", "주차장",
                "쓰레기집하장", "부속사", "주사"}
GENERIC_DONG_RE = [
    # 1동, 제1동, 2-1동, 3호, A동, B-1동, AB2호동, 1관 ...
    re.compile(r"^(제\s*)?([0-9]+(-[0-9]+)?|[A-Za-z]{1,2}(\s*-?\s*[0-9]+)?)\s*(동|호|호동|관|블록|블럭)?$"),
    re.compile(r"^[가-힣]\s*동$"),  # 가동, 나동, ...
    re.compile(r"^(주|부속)?\s*(건축물|건물)\s*(제\s*)?[0-9]*\s*(동|호)?$"),  # 주건축물제1동, 부속건축물제2동
]

USE_TO_BUILDING = [("기숙사", "dormitory"),  # before 공동주택: "공동주택(기숙사)" is a dormitory
                   ("공동주택", "apartments"), ("단독주택", "house"), ("근린생활", "commercial"),
                   ("종교", "religious"), ("의료", "hospital"), ("교육연구", "school"),
                   ("업무", "office"), ("판매", "retail"), ("공장", "industrial"),
                   ("창고", "warehouse"), ("운동", "sports_hall")]


# ---------------------------------------------------------------------------- projection

def make_tm(a, rf, lat0, lon0, k0, fe, fn):
    """Transverse Mercator parameters with Krüger series coefficients (Karney 2011, n^6)."""
    f = 1 / rf
    n = f / (2 - f)
    n2, n3, n4, n5, n6 = n ** 2, n ** 3, n ** 4, n ** 5, n ** 6
    tm = {
        "a": a, "rf": rf, "lat0": lat0, "lon0": lon0, "k0": k0, "fe": fe, "fn": fn,
        "e": math.sqrt(f * (2 - f)),
        "A": a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256),
        "alpha": (
            n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
            13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
            61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
            49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
            34729 * n5 / 80640 - 3418889 * n6 / 1995840,
            212378941 * n6 / 319334400,
        ),
        "beta": (
            n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
            n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
            17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
            4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
            4583 * n5 / 161280 - 108847 * n6 / 3991680,
            20648693 * n6 / 638668800,
        ),
    }
    tm["xi0"] = _xi_eta(tm, lat0, 0.0)[0]  # meridian arc to the origin latitude, over A
    return tm


def _conformal_tan(e, tau):
    sigma = math.sinh(e * math.atanh(e * tau / math.hypot(1, tau)))
    return tau * math.hypot(1, sigma) - sigma * math.hypot(1, tau)


def _xi_eta(tm, lat, dlon):
    tau_c = _conformal_tan(tm["e"], math.tan(math.radians(lat)))
    lam = math.radians(dlon)
    xi_c = math.atan2(tau_c, math.cos(lam))
    eta_c = math.asinh(math.sin(lam) / math.hypot(tau_c, math.cos(lam)))
    xi, eta = xi_c, eta_c
    for j, a in enumerate(tm["alpha"], 1):
        xi += a * math.sin(2 * j * xi_c) * math.cosh(2 * j * eta_c)
        eta += a * math.cos(2 * j * xi_c) * math.sinh(2 * j * eta_c)
    return xi, eta


def tm_forward(tm, lat, lon):
    """(lat, lon) degrees -> (easting, northing) metres."""
    xi, eta = _xi_eta(tm, lat, lon - tm["lon0"])
    scale = tm["k0"] * tm["A"]
    return tm["fe"] + scale * eta, tm["fn"] + scale * (xi - tm["xi0"])


def tm_inverse(tm, x, y):
    """(easting, northing) metres -> (lat, lon) degrees."""
    scale = tm["k0"] * tm["A"]
    xi = (y - tm["fn"]) / scale + tm["xi0"]
    eta = (x - tm["fe"]) / scale
    xi_c, eta_c = xi, eta
    for j, b in enumerate(tm["beta"], 1):
        xi_c -= b * math.sin(2 * j * xi) * math.cosh(2 * j * eta)
        eta_c -= b * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
    tau_c = math.sin(xi_c) / math.hypot(math.sinh(eta_c), math.cos(xi_c))
    e2 = tm["e"] ** 2
    tau = tau_c
    for _ in range(10):  # Newton iteration for tan(lat) from the conformal latitude
        tau_i = _conformal_tan(tm["e"], tau)
        d = (tau_c - tau_i) / math.hypot(1, tau_i) * (1 + (1 - e2) * tau * tau) / (
            (1 - e2) * math.hypot(1, tau))
        tau += d
        if abs(d) < 1e-14:
            break
    lon = tm["lon0"] + math.degrees(math.atan2(math.sinh(eta_c), math.cos(xi_c)))
    return math.degrees(math.atan(tau)), lon


# ---------------------------------------------------------------------------- CRS (.prj)

def _norm(s):
    return re.sub(r"[^0-9a-z가-힣]", "", s.lower())


def _num(s):
    return float(s)


def parse_prj(wkt):
    """Pull TM parameters out of WKT1 (ESRI or OGC flavour) or WKT2. Returns a dict."""
    info = {"name": None, "projection": None, "spheroid": None, "a": None, "rf": None,
            "primem": None, "unit": 1.0, "params": {}}
    m = re.search(r'(?:PROJCS|PROJCRS)\[\s*"([^"]*)"', wkt)
    info["name"] = m.group(1) if m else None
    m = re.search(r'(?:PROJECTION|METHOD)\[\s*"([^"]*)"', wkt)
    info["projection"] = m.group(1) if m else None
    m = re.search(r'(?:SPHEROID|ELLIPSOID)\[\s*"([^"]*)"\s*,\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)', wkt)
    if m:
        info["spheroid"], info["a"], info["rf"] = m.group(1), _num(m.group(2)), _num(m.group(3))
    m = re.search(r'PRIMEM\[\s*"([^"]*)"\s*,\s*([-+0-9.eE]+)', wkt)
    if m:
        info["primem"] = (m.group(1), _num(m.group(2)))
    units =re.findall(r'LENGTHUNIT\[\s*"[^"]*"\s*,\s*([-+0-9.eE]+)', wkt) or \
        re.findall(r'(?<![A-Z])UNIT\[\s*"[^"]*"\s*,\s*([-+0-9.eE]+)', wkt)
    if units:
        info["unit"] = _num(units[-1])  # WKT1: the last UNIT is the projected (linear) one
    for name, value in re.findall(r'PARAMETER\[\s*"([^"]*)"\s*,\s*([-+0-9.eE]+)', wkt):
        info["params"][_norm(name)] = _num(value)
    return info


PARAM_KEYS = {
    "lat0": ("latitudeoforigin", "latitudeofnaturalorigin", "latitudeofcenter"),
    "lon0": ("centralmeridian", "longitudeofnaturalorigin", "longitudeofcenter", "longitudeoforigin"),
    "k0": ("scalefactor", "scalefactoratnaturalorigin"),
    "fe": ("falseeasting",),
    "fn": ("falsenorthing",),
}
PARAM_DEFAULTS = {"lat0": 0.0, "k0": 1.0, "fe": 0.0, "fn": 0.0}


def crs_from_prj(wkt):
    """Validate a .prj and return (tm, label). Exits for Bessel/unknown datums."""
    info = parse_prj(wkt)
    if info["name"] is None:
        raise SystemExit(
            "The .prj is not a projected CRS (no PROJCS). Expected Transverse Mercator such as "
            f"EPSG:5186.\n.prj: {wkt[:300]}")
    sph = (info["spheroid"] or "").lower()
    a = info["a"]
    if "bessel" in sph or (a is not None and abs(a - 6377397.155) < 1):
        raise SystemExit(
            f"The shapefile uses the Bessel 1841 ellipsoid ({info['name']}), i.e. the old "
            "Korean 1985 datum such as EPSG:5174. Converting it needs a datum shift, which this "
            "script does not do.\nDownload the current file from VWorld (EPSG:5186, distributed "
            "since 2023-08) or reproject first, e.g.\n  ogr2ogr -t_srs EPSG:5186 out.shp in.shp")
    if a is None or abs(a - 6378137) > 1 or not (298.2572 < (info["rf"] or 0) < 298.2573):
        raise SystemExit(
            f"Unknown ellipsoid {info['spheroid']!r} (a={a}, 1/f={info['rf']}). Only GRS80/WGS84 "
            "based CRSs (e.g. EPSG:5186, 5179) are supported.")
    if info["primem"] and abs(info["primem"][1]) > 1e-12:
        pm_name, pm_value = info["primem"]
        raise SystemExit(
            f"The .prj uses the prime meridian {pm_name!r} ({pm_value:g}), not Greenwich. Every "
            "longitude would be shifted by that amount; reproject first, e.g.\n"
            "  ogr2ogr -t_srs EPSG:5186 out.shp in.shp")
    if _norm(info["projection"] or "") not in ("transversemercator", "gausskruger"):
        raise SystemExit(f"Unsupported projection {info['projection']!r}; expected Transverse Mercator.")
    if abs(info["unit"] - 1) > 1e-9:
        raise SystemExit(f"Unsupported linear unit factor {info['unit']} (expected metres).")
    params = {}
    for key, names in PARAM_KEYS.items():
        found = [info["params"][n] for n in names if n in info["params"]]
        if found:
            params[key] = found[0]
        elif key in PARAM_DEFAULTS:
            params[key] = PARAM_DEFAULTS[key]
        else:
            raise SystemExit(f"The .prj has no central meridian parameter:\n{wkt[:300]}")
    tm = make_tm(info["a"], info["rf"], params["lat0"], params["lon0"], params["k0"],
                 params["fe"], params["fn"])
    return tm, crs_label(tm, info["name"])


def crs_label(tm, name=None):
    for code, (title, lat0, lon0, k0, fe, fn) in KNOWN_CRS.items():
        if all(abs(u - v) < 1e-9 for u, v in zip(
                (tm["lat0"], tm["lon0"], tm["k0"], tm["fe"], tm["fn"]), (lat0, lon0, k0, fe, fn))):
            return f"EPSG:{code}"
    return (f"TM lat0={tm['lat0']:g} lon0={tm['lon0']:g} k={tm['k0']:g} FE={tm['fe']:g} "
            f"FN={tm['fn']:g} a={tm['a']:g}" + (f" ({name})" if name else ""))


def crs_from_code(code):
    if code not in KNOWN_CRS:
        raise SystemExit(f"--crs must be one of {sorted(KNOWN_CRS)}")
    _, lat0, lon0, k0, fe, fn = KNOWN_CRS[code]
    return make_tm(*GRS80, lat0, lon0, k0, fe, fn), f"EPSG:{code}"


# ---------------------------------------------------------------------------- shapefile

def sibling(shp, ext):
    """Sibling file with the given extension, case-insensitively (.dbf or .DBF)."""
    for cand in (shp.with_suffix(ext), shp.with_suffix(ext.upper())):
        if cand.exists():
            return cand
    for cand in shp.parent.glob(shp.stem + ".*"):
        if cand.suffix.lower() == ext:
            return cand
    return None


def open_mmap(path):
    if Path(path).stat().st_size == 0:
        raise SystemExit(f"{path} is empty (incomplete download or unzip?).")
    with open(path, "rb") as f:
        return mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)


def is_main_or_index(mm):
    """True if `mm` starts with a shapefile header (.shp and .shx share it)."""
    return len(mm) >= 100 and struct.unpack_from(">i", mm, 0)[0] == 9994


def file_end(mm):
    """End of the data: the header's file length (16-bit words), capped at the real size.
    Bytes after it (zero padding from some tools) are not records."""
    declared = 2 * struct.unpack_from(">i", mm, 24)[0]
    return declared if 100 <= declared <= len(mm) else len(mm)


def shp_header(mm):
    if not is_main_or_index(mm):
        raise SystemExit("Not a shapefile (bad file code in .shp header).")
    shape_type = struct.unpack_from("<i", mm, 32)[0]
    if shape_type not in (0, 5, 15, 25):
        raise SystemExit(f"Shape type {shape_type} is not a polygon type (5, 15 or 25).")
    return {"type": shape_type, "bbox": struct.unpack_from("<4d", mm, 36)}


def record_offsets(shp_mm, shx_mm=None):
    """Byte offsets of each record header in the .shp, in record order (= DBF row order).
    Uses the .shx index when given, else walks the .shp record headers."""
    if shx_mm is not None and is_main_or_index(shx_mm):
        count = (file_end(shx_mm) - 100) // 8
        return [struct.unpack_from(">i", shx_mm, 100 + 8 * i)[0] * 2 for i in range(count)]
    offsets, pos, end = [], 100, file_end(shp_mm)
    while pos + 8 <= end:
        content_len = struct.unpack_from(">i", shp_mm, pos + 4)[0]  # 16-bit words
        if content_len < 2 or pos + 8 + 2 * content_len > end:
            raise SystemExit(
                f"Corrupt or truncated .shp: record at byte {pos} has content length {content_len} "
                f"words, but the data ends at byte {end}.")
        offsets.append(pos)
        pos += 8 + 2 * content_len
    return offsets


def record_end(mm, off):
    """Byte after the record at `off`, from its header; exits if it runs past the file."""
    end = off + 8 + 2 * struct.unpack_from(">i", mm, off + 4)[0]
    if end > len(mm):
        raise SystemExit(f"Truncated .shp: record at byte {off} runs past the end ({len(mm)} bytes).")
    return end


def record_type_bbox(mm, off):
    """(shape type, bbox or None) of the record at header offset `off`."""
    if off < 100 or off + 12 > len(mm):
        raise SystemExit(f"Truncated .shp: record at byte {off} runs past the end ({len(mm)} bytes).")
    shape_type = struct.unpack_from("<i", mm, off + 8)[0]
    if shape_type not in (5, 15, 25):
        return shape_type, None
    if record_end(mm, off) < off + 52:  # type, bbox, part and point counts
        raise SystemExit(f"Corrupt .shp: polygon record at byte {off} is too short.")
    return shape_type, struct.unpack_from("<4d", mm, off + 12)


def read_parts(mm, off):
    """Rings of a Polygon/PolygonZ/PolygonM record as lists of (x, y). Z/M are ignored."""
    end = record_end(mm, off)
    if end < off + 52:
        raise SystemExit(f"Corrupt .shp: polygon record at byte {off} is too short.")
    nparts, npoints = struct.unpack_from("<2i", mm, off + 44)
    start = off + 52
    if nparts < 0 or npoints < 0 or start + 4 * nparts + 16 * npoints > end:
        raise SystemExit(f"Corrupt or truncated .shp: polygon at byte {off} has {nparts} parts and "
                         f"{npoints} points, which do not fit in the record.")
    parts = list(struct.unpack_from(f"<{nparts}i", mm, start)) + [npoints]
    if any(not 0 <= a <= b <= npoints for a, b in zip(parts, parts[1:])):
        raise SystemExit(f"Corrupt .shp: polygon at byte {off} has invalid part indexes.")
    xy = struct.unpack_from(f"<{2 * npoints}d", mm, start + 4 * nparts)
    return [[(xy[2 * k], xy[2 * k + 1]) for k in range(parts[p], parts[p + 1])]
            for p in range(nparts)]


def signed_area(ring):
    """Shoelace area; positive for counter-clockwise rings in x/y (east/north)."""
    x0, y0 = ring[0]
    s = 0.0
    for (xa, ya), (xb, yb) in zip(ring, ring[1:] + ring[:1]):
        s += (xa - x0) * (yb - y0) - (xb - x0) * (ya - y0)
    return s / 2


def ring_inside(inner, outer):
    """True if most vertices of `inner` fall inside `outer` (robust to touching edges)."""
    hits = sum(point_in_poly(x, y, outer) for x, y in inner)
    return hits * 2 >= len(inner)


def group_rings(parts):
    """ESRI rule: clockwise rings are outers, counter-clockwise rings are holes. Each hole
    goes to the smallest outer containing it; a hole with no outer is kept as an outer."""
    rings = [p for p in parts if len(p) >= 4]
    outers = [r for r in rings if signed_area(r) < 0]
    holes = [r for r in rings if signed_area(r) > 0]
    groups = [(o, []) for o in outers]
    for h in holes:
        owners = [g for g in groups if ring_inside(h, g[0])]
        if owners:
            min(owners, key=lambda g: abs(signed_area(g[0])))[1].append(h)
        else:
            groups.append((h, []))
    return groups


# ---------------------------------------------------------------------------- DBF

def dbf_header(mm):
    if len(mm) < 32:
        raise SystemExit("The .dbf is too short to hold a header.")
    nrec, hlen, rlen = struct.unpack_from("<IHH", mm, 4)
    descs, pos = [], 32
    while pos + 32 <= min(hlen, len(mm)) and mm[pos] != 0x0D:
        descs.append(mm[pos:pos + 32])
        pos += 32

    # Character fields wider than 255 bytes: shapelib/GDAL/Clipper store the width as
    # len byte + 256 * decimals byte. Use that reading unless only the plain one fits rlen.
    def widths(wide):
        return [d[16] + 256 * d[17] if wide and chr(d[11]) == "C" else d[16] for d in descs]
    wide = widths(True)
    if 1 + sum(wide) != rlen and 1 + sum(widths(False)) == rlen:
        wide = widths(False)
    if 1 + sum(wide) != rlen:
        print(f"  warning: DBF record length {rlen} != sum of field lengths {1 + sum(wide)}", file=sys.stderr)

    fields, off = [], 1
    for d, width in zip(descs, wide):
        fields.append({"raw": d[:11].split(b"\0")[0].rstrip(b" "), "type": chr(d[11]), "len": width,
                       "dec": 0 if width != d[16] else d[17], "off": off})
        off += width
    return {"count": nrec, "hlen": hlen, "rlen": rlen, "fields": fields, "ldid": mm[29]}


def dbf_raw(mm, hdr, i):
    """(deleted, [field bytes]) for record i, read by random access."""
    pos = hdr["hlen"] + i * hdr["rlen"]
    if i >= hdr["count"] or pos + hdr["rlen"] > len(mm):
        return True, None
    deleted = mm[pos] == 0x2A  # '*'
    return deleted, [mm[pos + f["off"]:pos + f["off"] + f["len"]].rstrip(b" \0") for f in hdr["fields"]]


def normalize_encoding(text):
    """Python codec name for a .cpg or --encoding value ("EUC-KR", "ANSI 949", "65001", ...).
    EUC-KR is widened to cp949, its superset, because such files often hold UHC-only
    syllables (똠, 햏, 뷁). Raises LookupError for unknown names."""
    text = re.sub(r"^ansi\s*", "", text.strip().lower())
    if text.isdigit():
        text = "utf-8" if text == "65001" else "cp" + text
    name = codecs.lookup(text).name
    return "cp949" if name == "euc_kr" else name


def cpg_encoding(path):
    if path is None:
        return None
    text = path.read_text(encoding="ascii", errors="ignore")
    try:
        return normalize_encoding(text)
    except LookupError:
        print(f"  warning: unknown .cpg encoding {text.strip()!r}; detecting instead", file=sys.stderr)
        return None


def decode_stats(samples, enc):
    """(values that do not decode strictly, Hangul syllables) for `samples` in `enc`."""
    errors = hangul = 0
    for b in samples:
        try:
            hangul += sum("가" <= c <= "힣" for c in b.decode(enc))
        except UnicodeDecodeError:
            errors += 1
    return errors, hangul


def detect_encoding(samples, candidates=("cp949", "utf-8")):
    """Pick the candidate that decodes every sample strictly, preferring more Hangul."""
    def score(enc):
        errors, hangul = decode_stats(samples, enc)
        return errors, -hangul, candidates.index(enc)
    best = min(candidates, key=score)
    return best, score(best)[0]


def text_samples(dbf_mm, dbf, rows):
    """Non-ASCII field names and character values of the given rows (for encoding checks)."""
    samples = [f["raw"] for f in dbf["fields"]]
    for i in rows:
        _, raw = dbf_raw(dbf_mm, dbf, i)
        samples += [v for v, f in zip(raw or [], dbf["fields"]) if f["type"] == "C" and v]
    return [s for s in samples if any(ch >= 0x80 for ch in s)]


def choose_encoding(samples, flag=None, cpg=None):
    """(encoding, where it came from). --encoding is used as given (with a warning if values
    do not decode). A .cpg is checked against the data: when it fails on values that another
    candidate decodes with fewer errors, the .cpg is wrong and detection wins."""
    if flag:
        try:
            enc = normalize_encoding(flag)
        except LookupError:
            raise SystemExit(f"Unknown --encoding {flag!r}; use e.g. cp949 or utf-8.")
        errors = decode_stats(samples, enc)[0]
        if errors:
            print(f"  warning: {errors} of {len(samples)} text values do not decode as {enc}",
                  file=sys.stderr)
        return enc, "--encoding" + (f", {errors} undecodable values replaced" if errors else "")
    detected, det_errors = detect_encoding(samples)
    if cpg:
        errors = decode_stats(samples, cpg)[0]
        if not errors or cpg == detected or det_errors >= errors:
            return cpg, ".cpg" + (f", {errors} undecodable values replaced" if errors else "")
        print(f"  warning: the .cpg says {cpg}, but {errors} of {len(samples)} text values do not "
              f"decode as {cpg}; using {detected} instead ({det_errors} errors). Pass --encoding "
              "to override.", file=sys.stderr)
        return detected, f"detected; .cpg said {cpg} but {errors} values did not decode"
    return detected, "detected" + (f", {det_errors} undecodable values replaced" if det_errors else "")


def map_fields(names, overrides):
    """Map logical keys to DBF column names (auto-detected, then CLI overrides)."""
    by_norm = {}
    for n in names:
        by_norm.setdefault(_norm(n), n)
    mapping = {}
    for key, cands in FIELD_CANDIDATES.items():
        for c in cands:
            if _norm(c) in by_norm:
                mapping[key] = by_norm[_norm(c)]
                break
    for key, value in overrides.items():
        if value is None:
            continue
        if value in names:
            mapping[key] = value
        elif _norm(value) in by_norm:
            mapping[key] = by_norm[_norm(value)]
        else:
            raise SystemExit(f"--{key}-field {value!r} not in DBF columns: {', '.join(names)}")
    return mapping


def parse_number(s):
    s = (s or "").strip().replace(",", "")
    if s in ("", "-", ".", "+"):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def fmt_number(v):
    return f"{round(v, 2):g}"


def count_value(v):
    """Whole count (floors) from a parsed number, rounded half up; None unless >= 1."""
    if v is None:
        return None
    n = math.floor(v + 0.5)
    return n if n >= 1 else None


# ---------------------------------------------------------------------------- geometry

def centroid(ring):
    """Area centroid of a ring (closed or open) in its own coordinates."""
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    x0, y0 = pts[0]
    a = cx = cy = 0.0
    for (xa, ya), (xb, yb) in zip(pts, pts[1:] + pts[:1]):
        xa, ya, xb, yb = xa - x0, ya - y0, xb - x0, yb - y0
        c = xa * yb - xb * ya
        a += c
        cx += (xa + xb) * c
        cy += (ya + yb) * c
    if abs(a) < 1e-18:
        return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    return x0 + cx / (3 * a), y0 + cy / (3 * a)


def in_polygon(x, y, outer, holes):
    return point_in_poly(x, y, outer) and not any(point_in_poly(x, y, h) for h in holes)


def bounds(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def boxes_overlap(a, b):
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def sample_points(outer, holes, n=20):
    """Cell centres of an n x n grid over the bbox that fall inside the polygon."""
    x0, y0, x1, y1 = bounds(outer)
    pts = [(x0 + (i + 0.5) * (x1 - x0) / n, y0 + (j + 0.5) * (y1 - y0) / n)
           for i in range(n) for j in range(n)]
    inside = [p for p in pts if in_polygon(p[0], p[1], outer, holes)]
    return inside or [centroid(outer)]


def projected_bbox(tm, bbox, margin):
    south, west, north, east = bbox
    pts = [tm_forward(tm, south + (north - south) * i / 4, west + (east - west) * j / 4)
           for i in range(5) for j in range(5)]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin


def in_bbox(lat, lon, bbox=BBOX):
    south, west, north, east = bbox
    return south <= lat <= north and west <= lon <= east


# ---------------------------------------------------------------------------- reading

def read_buildings(shp_path, tm, bbox, encoding=None, overrides=None, verbose=True, near=False):
    """Read SHP records whose bbox meets the campus bbox. Returns (buildings, report).

    Only parts whose centroid lies inside `bbox` are returned, unless `near` is true: then
    parts just outside (within the prefilter margin) come too, marked "inBbox": False, so
    merge() can pair them with OSM buildings at the edge."""
    shx_path, dbf_path = sibling(shp_path, ".shx"), sibling(shp_path, ".dbf")
    if dbf_path is None:
        raise SystemExit(f"No .dbf next to {shp_path}")
    shp_mm = open_mmap(shp_path)
    shx_mm = open_mmap(shx_path) if shx_path and shx_path.stat().st_size >= 100 else None
    if shx_path and (shx_mm is None or not is_main_or_index(shx_mm)):
        print(f"  warning: {shx_path.name} is empty or not a shapefile index; scanning the .shp instead",
              file=sys.stderr)
        shx_mm = None
    dbf_mm = open_mmap(dbf_path)
    header = shp_header(shp_mm)
    dbf = dbf_header(dbf_mm)
    offsets = record_offsets(shp_mm, shx_mm)
    report = {"records": len(offsets), "dbfRecords": dbf["count"], "null": 0, "other": 0,
              "candidates": 0, "deleted": 0, "outsideBbox": 0, "shapeType": header["type"],
              "fileBbox": header["bbox"]}
    if len(offsets) != dbf["count"]:
        print(f"  warning: .shp has {len(offsets)} records but .dbf has {dbf['count']}", file=sys.stderr)

    pbox = projected_bbox(tm, bbox, BBOX_MARGIN_M)
    hits = []
    for i, off in enumerate(offsets):
        shape_type, box = record_type_bbox(shp_mm, off)
        if box is None:
            report["null" if shape_type == 0 else "other"] += 1
        elif boxes_overlap(box, pbox):
            hits.append((i, off))
    report["candidates"] = len(hits)

    # Encoding: --encoding, else the .cpg if the data agrees with it, else detected from the
    # field names and string values of sampled rows.
    samples = text_samples(dbf_mm, dbf, [i for i, _ in hits[:300]] + list(range(min(50, dbf["count"]))))
    cpg = None if encoding else cpg_encoding(sibling(shp_path, ".cpg"))
    encoding, enc_source = choose_encoding(samples, encoding, cpg)
    names =[f["raw"].decode(encoding, errors="replace") for f in dbf["fields"]]
    mapping = map_fields(names, overrides or {})
    report.update(encoding=encoding, encodingSource=enc_source, fields=names, mapping=mapping)

    def decoded(i):
        deleted, raw = dbf_raw(dbf_mm, dbf, i)
        if raw is None:
            return deleted, None
        return deleted, {n: v.decode(encoding, errors="replace").strip() for n, v in zip(names, raw)}

    if verbose:
        print_schema(dbf, names, mapping, encoding, enc_source,
                     [decoded(i)[1] for i, _ in hits[:3]] or
                     [decoded(i)[1] for i in range(min(3, dbf["count"]))])

    buildings = []
    for i, off in hits:
        deleted, row = decoded(i)
        if deleted or row is None:
            report["deleted"] += 1
            continue
        attrs = {k: row.get(col, "") for k, col in mapping.items()}
        groups = group_rings(read_parts(shp_mm, off))
        for part, (outer, holes) in enumerate(groups):
            ll_outer = to_latlon(tm, outer)
            if len(ll_outer) < 4:
                continue
            inside = in_bbox(*centroid(ll_outer), bbox)
            if not inside:
                report["outsideBbox"] += 1
                if not near:
                    continue
            buildings.append({
                "index": i, "part": part, "attrs": attrs,
                "outer": ll_outer,
                "holes": [h for h in (to_latlon(tm, h) for h in holes) if len(h) >= 4],
                "xy": (outer, holes),
                "inBbox": inside,
            })
    return buildings, report


def to_latlon(tm, ring):
    out = []
    for x, y in ring:
        lat, lon = tm_inverse(tm, x, y)
        p = [round(lat, 7), round(lon, 7)]
        if not out or p != out[-1]:
            out.append(p)
    if out and out[0] != out[-1]:
        out.append(list(out[0]))
    return out


# ---------------------------------------------------------------------------- merging

def is_generic_dong(s):
    s = unicodedata.normalize("NFKC", s or "").strip()
    return not s or s in GENERIC_DONG or any(r.match(s) for r in GENERIC_DONG_RE)


def registry_name(reg_name, reg_dong):
    """Name from one register row: A25 unless generic, else A24. merge() then drops or
    extends A24 names that several records share."""
    if not is_generic_dong(reg_dong):
        return reg_dong.strip()
    return (reg_name or "").strip() or None


def osm_polygons(osm_buildings, tm):
    """OSM buildings projected into the SHP CRS, with bbox, area and sample points."""
    polys = []
    for b in osm_buildings:
        outer = [tm_forward(tm, lat, lon) for lat, lon in b["outer"]]
        holes = [[tm_forward(tm, lat, lon) for lat, lon in h] for h in b.get("holes", [])]
        polys.append({"b": b, "outer": outer, "holes": holes, "box": bounds(outer),
                      "area": abs(signed_area(outer)) - sum(abs(signed_area(h)) for h in holes),
                      "samples": sample_points(outer, holes)})
    return polys


def overlap_fractions(outer, holes, samples, p):
    """(share of the SHP polygon inside OSM polygon p, share of p inside the SHP polygon)."""
    f_shp = sum(in_polygon(x, y, p["outer"], p["holes"]) for x, y in samples) / len(samples)
    f_osm = sum(in_polygon(x, y, outer, holes) for x, y in p["samples"]) / len(p["samples"])
    return f_shp, f_osm


def match_osm(outer, holes, polys):
    """Best OSM match for one SHP polygon (named matches win), or None."""
    box = bounds(outer)
    area = abs(signed_area(outer)) - sum(abs(signed_area(h)) for h in holes)
    samples = None
    best = None
    for p in polys:
        if not boxes_overlap(box, p["box"]):
            continue
        samples = samples or sample_points(outer, holes)
        f_shp, f_osm = overlap_fractions(outer, holes, samples, p)
        if max(f_shp, f_osm) < MATCH_FRACTION:
            continue
        overlap = (f_shp * area + f_osm * p["area"]) / 2
        key = (bool(p["b"].get("name")), overlap)
        if best is None or key > best[0]:
            best = (key, p["b"])
    return best[1] if best else None


def covered(p, shp_polys):
    """True if OSM polygon p overlaps one of the SHP polygons as much as a match would."""
    for outer, holes in shp_polys:
        if boxes_overlap(bounds(outer), p["box"]) and max(
                overlap_fractions(outer, holes, sample_points(outer, holes), p)) >= MATCH_FRACTION:
            return True
    return False


def building_type(use, campus, match):
    osm_type = (match or {}).get("tags", {}).get("building")
    if osm_type and osm_type != "yes":
        return osm_type
    for needle, value in USE_TO_BUILDING:
        if needle in (use or ""):
            return "university" if value == "school" and campus else value
    return osm_type or "yes"


def campus_flag(attrs, match, in_outline):
    """Rule 4 for one building; merge() then unifies the flag per name."""
    if match and match.get("campus"):
        return True
    use = attrs.get("use") or ""
    if not use:
        return bool(match.get("campus")) if match else in_outline
    if not in_outline:
        return False
    if not any(k in use for k in EXCLUDED_USES):
        return True
    text = " ".join(attrs.get(k) or "" for k in ("use", "name", "dong"))
    return any(k in text for k in CAMPUS_HINTS)


def make_building(shp, match, outline):
    """Output building for one SHP part and its OSM match (or None). Returns (building, name
    source: "osm", "registry" or None); merge() may still change the name and campus flag."""
    a = shp["attrs"]
    reg_id = (a.get("id") or "").strip()
    base_id = f"m{reg_id}" if reg_id else f"m{shp['index']}"
    osm_tags = (match or {}).get("tags", {})
    tags = {}
    floors = count_value(parse_number(a.get("floors")))
    osm_floors = count_value(parse_number(osm_tags.get("building:levels")))
    if floors or osm_floors:
        tags["building:levels"] = str(floors or osm_floors)
        if not floors:
            tags["levels:source"] = "osm"
    height = parse_number(a.get("height"))
    osm_height = parse_number(osm_tags.get("height"))
    if height and height > 0:
        tags["height"] = fmt_number(height)
    elif osm_height and osm_height > 0:
        tags["height"] = fmt_number(osm_height)
        tags["height:source"] = "osm"
    for tag, key in (("reg:name", "name"), ("reg:dong", "dong"), ("reg:use", "use"),
                     ("reg:approved", "approved")):
        if a.get(key):
            tags[tag] = a[key]
    tags["reg:id"] = reg_id or f"#{shp['index']}"  # always set: marks register buildings
    under = count_value(parse_number(a.get("underground")))
    if under:
        tags["reg:underground"] = str(under)

    if match and match.get("name"):
        name, source = match["name"], "osm"
        tags.update({k: v for k, v in osm_tags.items() if k in ("name:en", "amenity")})
    else:
        name = registry_name(a.get("name"), a.get("dong"))
        source = "registry" if name else None
    if match:
        tags["osm:id"] = match["id"]

    lat, lon = centroid(shp["outer"])
    in_outline = any(point_in_poly(lat, lon, r) for r in outline)
    campus = campus_flag(a, match, in_outline)
    tags["building"] = building_type(a.get("use"), campus, match)
    return {
        "id": base_id + (f"-{shp['part'] + 1}" if shp["part"] else ""),
        "name": name,
        "tags": dict(sorted(tags.items())),
        "outer": shp["outer"],
        "holes": shp["holes"],
        "campus": campus,
    }, source


def fix_shared_names(chosen, new, sources):
    """Rule 3: an A24 fallback name must belong to one register record, because the front end
    groups buildings by name. If other records share the A24 ("계명대학교"), use "A24 A25"
    when that is unique, else no name."""
    def a24(shp):
        return (shp["attrs"].get("name") or "").strip()

    records = defaultdict(set)  # A24 -> record indexes
    for shp, _ in chosen:
        if a24(shp):
            records[a24(shp)].add(shp["index"])
    fallback = [k for k, (shp, _) in enumerate(chosen)
                if sources[k] == "registry" and is_generic_dong(shp["attrs"].get("dong"))]
    taken = {b["name"] for k, b in enumerate(new) if b["name"] and k not in fallback}
    alts = {}
    for k in fallback:
        shp = chosen[k][0]
        if len(records[a24(shp)]) == 1 and a24(shp) not in taken:
            continue
        dong = unicodedata.normalize("NFKC", shp["attrs"].get("dong") or "").strip()
        useful = re.search(r"[0-9A-Za-z가-힣]", dong) and dong not in ("0", "없음")
        alts[k] = f"{a24(shp)} {dong}" if useful else None
    alt_records = defaultdict(set)
    for k, alt in alts.items():
        if alt:
            alt_records[alt].add(chosen[k][0]["index"])
    for k, alt in alts.items():
        ok = alt is not None and len(alt_records[alt]) == 1 and alt not in taken
        new[k]["name"] = alt if ok else None
        sources[k] = "registry" if ok else None


def unify_campus(chosen, new):
    """Rule 4, last step: buildings that share a name share the flag (campus if any is)."""
    campus_names = {b["name"] for b in new if b["name"] and b["campus"]}
    for (shp, match), b in zip(chosen, new):
        if b["name"] in campus_names and not b["campus"]:
            b["campus"] = True
            tags = dict(b["tags"], building=building_type(shp["attrs"].get("use"), True, match))
            b["tags"] = dict(sorted(tags.items()))


def merge(osm, shp_buildings, tm, source_info, bbox=BBOX):
    """New campus dict: OSM data with in-bbox buildings replaced. Returns (data, stats).
    shp_buildings may include parts just outside the bbox ("inBbox": False, see rule 1)."""
    osm_in, osm_out = [], []
    for b in osm["buildings"]:
        (osm_in if in_bbox(*centroid(b["outer"]), bbox) else osm_out).append(b)
    removed = {b["id"] for b in osm_in}
    polys = osm_polygons(osm_in + osm_out, tm)

    # Rule 1: inside the bbox, or the twin of a removed OSM building.
    chosen = []
    for shp in shp_buildings:
        match = match_osm(*shp["xy"], polys)
        if shp.get("inBbox", True) or (match and match["id"] in removed):
            chosen.append((shp, match))
    matched = {m["id"] for _, m in chosen if m}
    added_xy = [shp["xy"] for shp, _ in chosen]
    replaced = {p["b"]["id"] for p in polys if p["b"]["id"] not in removed and (
        p["b"]["id"] in matched or covered(p, added_xy))}
    kept = [b for b in osm_out if b["id"] not in replaced]

    new, sources = [], []
    for shp, match in chosen:
        b, source = make_building(shp, match, osm.get("campusOutline", []))
        new.append(b)
        sources.append(source)
    fix_shared_names(chosen, new, sources)
    unify_campus(chosen, new)

    attribution = osm.get("attribution", "")
    if REGISTER_CREDIT not in attribution:
        attribution = f"{attribution}; {REGISTER_CREDIT}" if attribution else REGISTER_CREDIT
    data = {"attribution": attribution,
            "buildingSource": dict(source_info, count=len(new))}
    data.update({k: v for k, v in osm.items() if k not in ("attribution", "buildingSource", "buildings")})
    data["buildings"] = new + kept
    order = ["attribution", "buildingSource", "center", "campusOutline", "buildings", "roads", "areas"]
    data = {k: data[k] for k in order if k in data} | {k: v for k, v in data.items() if k not in order}
    stats = {
        "added": len(new), "removed": len(osm_in), "kept": len(kept),
        "edgeAdded": sum(not shp.get("inBbox", True) for shp, _ in chosen),
        "edgeReplaced": sorted(replaced),
        "viaOsm": sources.count("osm"), "viaRegistry": sources.count("registry"),
        "unnamed": sources.count(None),
        "floors": sum("building:levels" in b["tags"] and "levels:source" not in b["tags"] for b in new),
        "floorsOsm": sum("levels:source" in b["tags"] for b in new),
        "height": sum("height" in b["tags"] and "height:source" not in b["tags"] for b in new),
        "heightOsm": sum("height:source" in b["tags"] for b in new),
        "campus": [b for b in new if b["campus"]],
        "lostNames": sorted({b["name"] for b in osm_in if b.get("name") and b["id"] not in matched}),
    }
    return data, stats


def load_osm(out):
    """(osm data, backup path, current file is pure OSM)."""
    backup = out.with_name(out.stem + ".osm.json")
    if not out.exists():
        raise SystemExit(f"{out} not found; run scripts/fetch_osm.py first.")
    current = json.loads(out.read_text(encoding="utf-8"))
    if "buildingSource" not in current:
        return current, backup, True
    if not backup.exists():
        raise SystemExit(f"{out} was already imported but {backup} is missing; "
                         "run scripts/fetch_osm.py to get the OSM data back first.")
    return json.loads(backup.read_text(encoding="utf-8")), backup, False


def save_backup(out, backup):
    """Rule 6: keep the pure-OSM `out` in `backup`. An existing, different backup is renamed
    to <backup stem>.<its mtime>.json first, never overwritten."""
    osm_text = out.read_text(encoding="utf-8")
    if backup.exists():
        old_text = backup.read_text(encoding="utf-8")
        if old_text == osm_text:
            return
        stamp = datetime.datetime.fromtimestamp(backup.stat().st_mtime).strftime("%Y%m%d-%H%M%S")
        old = backup.with_name(f"{backup.stem}.{stamp}.json")
        k = 2
        while old.exists():
            old = backup.with_name(f"{backup.stem}.{stamp}-{k}.json")
            k += 1
        backup.rename(old)
        print(f"Previous OSM backup kept as {old}")
        try:
            n_old = len(json.loads(old_text).get("buildings", []))
            n_new = len(json.loads(osm_text).get("buildings", []))
        except ValueError:
            n_old = n_new = 0
        if n_new < 0.8 * n_old:
            print(f"  warning: {out.name} has {n_new} OSM buildings, the previous backup had {n_old}. "
                  f"If the Overpass download was incomplete, restore with: cp {old} {out}", file=sys.stderr)
    backup.write_text(osm_text, encoding="utf-8")
    print(f"Saved OSM version to {backup}")


# ---------------------------------------------------------------------------- output

def text_width(s):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def pad(s, width):
    s = "" if s is None else str(s)
    return s + " " * max(1, width - text_width(s))


def print_schema(dbf, names, mapping, encoding, enc_source, samples):
    keys = {col: key for key, col in mapping.items()}
    print(f"DBF: {dbf['count']} records, {len(names)} fields, encoding {encoding} ({enc_source})")
    print(f"  {pad('field', 22)}{pad('type', 6)}{pad('len', 6)}mapped to")
    for n, f in zip(names, dbf["fields"]):
        print(f"  {pad(n, 22)}{pad(f['type'], 6)}{pad(f['len'], 6)}{keys.get(n, '')}")
    missing = [k for k in OVERRIDABLE if k not in mapping]
    if missing:
        print("  not found: " + ", ".join(missing) + " (use --<key>-field to set them)")
    for k, row in enumerate(s for s in samples if s):
        print(f"  sample {k + 1}: " + ", ".join(f"{n}={v}" for n, v in row.items() if v))


def print_summary(report, stats, crs, dry_run):
    print(f"SHP: {report['records']} records (shape type {report['shapeType']}), CRS {crs}")
    print(f"  null shapes {report['null']}, non-polygon {report['other']}, "
          f"bbox candidates {report['candidates']}, deleted rows {report['deleted']}, "
          f"parts with centroid outside bbox {report['outsideBbox']}")
    n = stats["added"] or 1
    print(f"Buildings: +{stats['added']} from SHP (campus {len(stats['campus'])}), "
          f"-{stats['removed']} OSM in bbox, {stats['kept']} OSM outside bbox kept")
    if stats["edgeAdded"] or stats["edgeReplaced"]:
        print(f"  bbox edge: {stats['edgeAdded']} SHP buildings just outside added as twins of removed "
              f"OSM buildings; OSM outside the bbox replaced: {', '.join(stats['edgeReplaced']) or '-'}")
    print(f"  names: {stats['viaOsm']} via OSM match, {stats['viaRegistry']} via registry, "
          f"{stats['unnamed']} unnamed")
    print(f"  floors (A26>0): {stats['floors']}/{stats['added']} ({100 * stats['floors'] / n:.0f}%), "
          f"height (A16>0): {stats['height']}/{stats['added']} ({100 * stats['height'] / n:.0f}%)")
    if stats["floorsOsm"] or stats["heightOsm"]:
        print(f"  copied from the OSM match where the register has none: floors {stats['floorsOsm']}, "
              f"height {stats['heightOsm']}")
    if stats["lostNames"]:
        print("  OSM names with no SHP match (check buildings_meta.json): " + ", ".join(stats["lostNames"]))
    rows = sorted(stats["campus"], key=lambda b: (b["name"] is None, b["name"] or "", b["id"]))
    print(f"Campus buildings ({len(rows)}):")
    print(f"  {pad('name', 26)}{pad('floors', 8)}{pad('height', 8)}{pad('reg:name / reg:dong', 34)}id")
    for b in rows:
        t = b["tags"]
        reg = " / ".join(v for v in (t.get("reg:name"), t.get("reg:dong")) if v)
        print(f"  {pad(b['name'] or '-', 26)}{pad(t.get('building:levels', '-'), 8)}"
              f"{pad(t.get('height', '-'), 8)}{pad(reg or '-', 34)}{b['id']}")
    if dry_run:
        print("Dry run: nothing written.")


# ---------------------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("shp", type=Path, help="path to the .shp file")
    ap.add_argument("--dry-run", action="store_true", help="print schema and summary, write nothing")
    ap.add_argument("--out", type=Path, default=OUT, help="campus.json to update (default: data/campus.json)")
    ap.add_argument("--date", default=None, help="importedAt date (default: today)")
    ap.add_argument("--crs", type=int, default=None, help="EPSG code if the .prj is missing (e.g. 5186)")
    ap.add_argument("--encoding", default=None, help="DBF text encoding (default: .cpg or detected)")
    for key in OVERRIDABLE:
        ap.add_argument(f"--{key}-field", default=None, help=f"DBF column for {key}")
    args = ap.parse_args(argv)

    shp = args.shp
    if shp.suffix.lower() != ".shp":
        shp = sibling(shp, ".shp") or shp
    if not shp.exists():
        raise SystemExit(f"{shp} not found")
    prj = sibling(shp, ".prj")
    if prj is not None:
        tm, crs = crs_from_prj(prj.read_text(encoding="utf-8", errors="replace"))
        if args.crs and crs != f"EPSG:{args.crs}":
            print(f"  warning: .prj says {crs}; ignoring --crs {args.crs}", file=sys.stderr)
    elif args.crs:
        tm, crs = crs_from_code(args.crs)
    else:
        raise SystemExit(f"No .prj next to {shp}. Pass --crs 5186 if you know the CRS.")
    try:
        date = datetime.date.fromisoformat(args.date).isoformat() if args.date else \
            datetime.date.today().isoformat()
    except ValueError:
        raise SystemExit(f"--date must be YYYY-MM-DD, got {args.date!r}")

    overrides = {k: getattr(args, f"{k}_field") for k in OVERRIDABLE}
    shp_buildings, report = read_buildings(shp, tm, BBOX, args.encoding, overrides, near=True)
    if not any(b["inBbox"] for b in shp_buildings):
        x0, y0, x1, y1 = report["fileBbox"]
        sw, ne = tm_inverse(tm, x0, y0), tm_inverse(tm, x1, y1)
        raise SystemExit(
            f"No SHP buildings inside the campus bbox {BBOX}. The file covers x {x0:.0f}..{x1:.0f}, "
            f"y {y0:.0f}..{y1:.0f}, i.e. lat {sw[0]:.4f}..{ne[0]:.4f}, lon {sw[1]:.4f}..{ne[1]:.4f} "
            f"if {crs} is right. Wrong region file or wrong CRS?")

    osm, backup, current_is_osm = load_osm(args.out)
    data, stats = merge(osm, shp_buildings, tm, {"file": shp.name, "crs": crs, "importedAt": date})
    print_summary(report, stats, crs, args.dry_run)
    if args.dry_run:
        return 0

    if current_is_osm:
        save_backup(args.out, backup)
    args.out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
