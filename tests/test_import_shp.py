"""Tests for scripts/import_shp.py. Run: python3 -m unittest discover -s tests

Synthetic shapefiles are written with the small stdlib writer below (no pyshp needed).
"""
import contextlib
import io
import json
import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import import_shp as imp  # noqa: E402

TM5186, _ = imp.crs_from_code(5186)

# .prj texts from https://epsg.io/5186.esriwkt, /5186.wkt, /5179.wkt, /5174.esriwkt (fetched 2026-09-27).
PRJ_5186_ESRI = (
    'PROJCS["Korea_2000_Korea_Central_Belt_2010",GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",'
    'SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",'
    '0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",200000.0],'
    'PARAMETER["False_Northing",600000.0],PARAMETER["Central_Meridian",127.0],'
    'PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]')
PRJ_5186_OGC = (
    'PROJCS["KGD2002 / Central Belt 2010",GEOGCS["KGD2002",DATUM["Korean_Geodetic_Datum_2002",'
    'SPHEROID["GRS 1980",6378137,298.257222101],TOWGS84[0,0,0,0,0,0,0]],PRIMEM["Greenwich",0,'
    'AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],'
    'AUTHORITY["EPSG","4737"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",38],'
    'PARAMETER["central_meridian",127],PARAMETER["scale_factor",1],PARAMETER["false_easting",200000],'
    'PARAMETER["false_northing",600000],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","5186"]]')
PRJ_5179_OGC = (
    'PROJCS["KGD2002 / Unified CS",GEOGCS["KGD2002",DATUM["Korean_Geodetic_Datum_2002",'
    'SPHEROID["GRS 1980",6378137,298.257222101],TOWGS84[0,0,0,0,0,0,0]],PRIMEM["Greenwich",0,'
    'AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],'
    'AUTHORITY["EPSG","4737"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",38],'
    'PARAMETER["central_meridian",127.5],PARAMETER["scale_factor",0.9996],'
    'PARAMETER["false_easting",1000000],PARAMETER["false_northing",2000000],'
    'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","5179"]]')
PRJ_5174_ESRI = (
    'PROJCS["Korean_1985_Modified_Korea_Central_Belt",GEOGCS["GCS_Korean_Datum_1985",'
    'DATUM["D_Korean_Datum_1985",SPHEROID["Bessel_1841",6377397.155,299.1528128]],'
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],'
    'PARAMETER["False_Easting",200000.0],PARAMETER["False_Northing",500000.0],'
    'PARAMETER["Central_Meridian",127.002890277778],PARAMETER["Scale_Factor",1.0],'
    'PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]')
PRJ_5186_WKT2 = (
    'PROJCRS["Korea 2000 / Central Belt 2010",BASEGEOGCRS["Korea 2000",DATUM["Geocentric datum of Korea",'
    'ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]]],CONVERSION["Korea Central Belt 2010",'
    'METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",38],'
    'PARAMETER["Longitude of natural origin",127],PARAMETER["Scale factor at natural origin",1],'
    'PARAMETER["False easting",200000],PARAMETER["False northing",600000]],CS[Cartesian,2],'
    'AXIS["northing (X)",north],AXIS["easting (Y)",east],LENGTHUNIT["metre",1],ID["EPSG",5186]]')


# ---------------------------------------------------------------------------- stdlib writers

def write_shapefile(base, shape_type, records):
    """Write base.shp/.shx. records: None (null shape) or a list of rings [(x, y), ...]."""
    contents = []
    for rec in records:
        if rec is None:
            contents.append(struct.pack("<i", 0))
            continue
        pts = [p for ring in rec for p in ring]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        parts, k = [], 0
        for ring in rec:
            parts.append(k)
            k += len(ring)
        c = struct.pack("<i4d2i", shape_type, min(xs), min(ys), max(xs), max(ys), len(rec), len(pts))
        c += struct.pack(f"<{len(parts)}i", *parts)
        c += b"".join(struct.pack("<2d", x, y) for x, y in pts)
        if shape_type == 15:  # Z range, Z values, then optional M range and M values
            zs = [30.0 + i for i in range(len(pts))]
            c += struct.pack("<2d", min(zs), max(zs)) + struct.pack(f"<{len(zs)}d", *zs)
        if shape_type in (15, 25):
            c += struct.pack("<2d", 0, 1) + struct.pack(f"<{len(pts)}d", *([0.5] * len(pts)))
        contents.append(c)
    allpts = [p for rec in records if rec for ring in rec for p in ring]
    box = (min(p[0] for p in allpts), min(p[1] for p in allpts),
           max(p[0] for p in allpts), max(p[1] for p in allpts))
    body, index, offset = [], [], 100
    for i, c in enumerate(contents, 1):
        body.append(struct.pack(">2i", i, len(c) // 2) + c)
        index.append(struct.pack(">2i", offset // 2, len(c) // 2))
        offset += 8 + len(c)
    body, index = b"".join(body), b"".join(index)

    def header(nbytes):
        return (struct.pack(">7i", 9994, 0, 0, 0, 0, 0, nbytes // 2) +
                struct.pack("<2i", 1000, shape_type) + struct.pack("<8d", *box, 0, 0, 0, 0))

    Path(f"{base}.shp").write_bytes(header(100 + len(body)) + body)
    Path(f"{base}.shx").write_bytes(header(100 + len(index)) + index)


def write_dbf(path, fields, rows, encoding="cp949", deleted=()):
    """fields: [(name, type, length, decimals)]; rows: lists of strings."""
    hlen = 32 + 32 * len(fields) + 1
    rlen = 1 + sum(f[2] for f in fields)
    out = [struct.pack("<BBBBIHH20x", 3, 126, 9, 27, len(rows), hlen, rlen)]
    for name, ftype, length, dec in fields:
        out.append(struct.pack("<11sc4xBB14x", name.encode(encoding), ftype.encode(), length, dec))
    out.append(b"\r")
    for i, row in enumerate(rows):
        out.append(b"*" if i in deleted else b" ")
        for (name, ftype, length, dec), value in zip(fields, row):
            raw = str(value).encode(encoding)[:length]
            out.append(raw.rjust(length) if ftype == "N" else raw.ljust(length))
    Path(path).write_bytes(b"".join(out) + b"\x1a")


# ---------------------------------------------------------------------------- fixture

def xy(lat, lon):
    return imp.tm_forward(TM5186, lat, lon)


def rect(cx, cy, w, h, ccw=False):
    """Axis-aligned closed ring in projected metres; clockwise (ESRI outer) unless ccw."""
    x0, x1, y0, y1 = cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2
    ring = [(x0, y0), (x0, y1), (x1, y1), (x1, y0), (x0, y0)]
    return ring[::-1] if ccw else ring


def ll_rect(lat, lon, w, h, dx=0.0):
    x, y = xy(lat, lon)
    return rect(x + dx, y, w, h)


def to_ll(ring):
    return [[round(v, 7) for v in imp.tm_inverse(TM5186, x, y)] for x, y in ring]


SHUTTUCK_LL = [[35.8559, 128.4838], [35.8561, 128.4838], [35.8561, 128.4842],
               [35.8559, 128.4842], [35.8559, 128.4838]]  # clockwise (lat up, then lon right)
OUTLINE = [[35.852, 128.480], [35.861, 128.480], [35.861, 128.490], [35.852, 128.490], [35.852, 128.480]]

FIELDS = [("A1", "C", 28, 0), ("A3", "C", 10, 0), ("A9", "C", 100, 0), ("A13", "C", 10, 0),
          ("A16", "N", 19, 9), ("A24", "C", 100, 0), ("A25", "C", 100, 0),
          ("A26", "N", 9, 0), ("A27", "N", 9, 0)]


def fixture_records():
    """(rings, dbf row) per record. Row: A1, A3, A9, A13, A16, A24, A25, A26, A27."""
    x2, y2 = xy(35.8575, 128.4860)
    x3, y3 = xy(35.8550, 128.4830)
    return [
        # 0: matches OSM 쉐턱관; registry dong is generic -> OSM name wins
        ([[xy(lat, lon) for lat, lon in SHUTTUCK_LL]],
         ["11110000000001", "2729010100", "교육연구시설", "19930301", "20.500000000", "계명대학교", "제1동", "5", "1"]),
        # 1: courtyard building (hole), no OSM match -> registry dong name
        ([rect(x2, y2, 60, 60), rect(x2, y2, 20, 20, ccw=True)],
         ["11110000000002", "2729010100", "교육연구시설", "", "", "계명대학교", "동영관", "6", "0"]),
        # 2: null shape
        (None, ["null-row", "", "", "", "", "", "", "", ""]),
        # 3: multipart; the hole is listed before its outer on purpose
        ([rect(x3, y3, 30, 15), rect(x3 + 50, y3, 10, 10, ccw=True), rect(x3 + 50, y3, 30, 30)],
         ["11110000000003", "2729010100", "업무시설", "20100505", "0", "대명빌딩", "1동", "-", ""]),
        # 4: deleted DBF row
        ([ll_rect(35.8565, 128.4870, 20, 20)],
         ["11110000000004", "", "교육연구시설", "", "", "삭제됨", "", "3", ""]),
        # 5: apartment inside the campus outline -> not campus
        ([ll_rect(35.8540, 128.4880, 20, 40)],
         ["11110000000005", "2729010100", "공동주택", "", "45", "성서아파트", "101동", "15", "2"]),
        # 6: far outside the bbox
        ([ll_rect(35.9000, 128.6000, 20, 20)],
         ["11110000000006", "", "업무시설", "", "", "먼건물", "", "3", ""]),
        # 7: straddles the south edge, centroid outside the bbox
        ([ll_rect(35.8497, 128.4850, 40, 40)],
         ["11110000000007", "", "업무시설", "", "", "경계건물", "", "3", ""]),
        # 8: no A9, matches an unnamed non-campus OSM building
        ([ll_rect(35.8580, 128.4830, 20, 20)],
         ["11110000000008", "", "", "", "", "", "", "", ""]),
        # 9, 10: two register buildings inside one OSM building (본관)
        ([ll_rect(35.8590, 128.4850, 35, 35, dx=-20)],
         ["11110000000009", "", "교육연구시설", "", "", "계명대학교", "본관동", "7", ""]),
        ([ll_rect(35.8590, 128.4850, 35, 35, dx=20)],
         ["11110000000010", "", "교육연구시설", "", "28.25", "계명대학교", "", "7", ""]),
        # 11: no A9, no OSM match, inside the outline
        ([ll_rect(35.8530, 128.4860, 20, 10)],
         ["11110000000011", "", "", "", "", "", "학군단", "2", ""]),
    ]


def fake_campus():
    def osm(bid, name, ring, campus, **tags):
        return {"id": bid, "name": name, "tags": {"building": tags.pop("building", "university"), **tags},
                "outer": ring, "holes": [], "campus": campus}
    return {
        "attribution": "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)",
        "center": [35.8567, 128.4849],
        "campusOutline": [OUTLINE],
        "buildings": [
            osm("w100", "쉐턱관", to_ll(ll_rect(35.8560, 128.4840, 38, 21, dx=1.5)), True,
                **{"name:en": "Shuttuck Hall"}),
            osm("w200", "본관", to_ll(ll_rect(35.8590, 128.4850, 80, 40)), True, amenity="university"),
            osm("w300", None, to_ll(ll_rect(35.8580, 128.4830, 21, 19)), False, building="yes"),
            osm("w400", "공학1호관", to_ll(ll_rect(35.8600, 128.4880, 30, 30)), True),
            osm("w500", "바깥건물", to_ll(ll_rect(35.8700, 128.4849, 20, 20)), False, building="yes"),
        ],
        "roads": [{"kind": "service", "name": None, "line": [[35.855, 128.483], [35.857, 128.485]]}],
        "areas": [{"kind": "grass", "sport": None, "poly": OUTLINE}],
    }


def build_fixture(directory):
    """Write fixture.shp/.shx/.dbf/.prj and campus.json into `directory`. Returns (shp, campus)."""
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    recs = fixture_records()
    write_shapefile(d / "fixture", 5, [r for r, _ in recs])
    write_dbf(d / "fixture.dbf", FIELDS, [row for _, row in recs], deleted={4})
    (d / "fixture.prj").write_text(PRJ_5186_ESRI)
    campus = d / "campus.json"
    campus.write_text(json.dumps(fake_campus(), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return d / "fixture.shp", campus


def run_main(*args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        imp.main([str(a) for a in args])
    return out.getvalue() + err.getvalue()


def metres(lat1, lon1, lat2, lon2):
    """Small distances between nearby lat/lon points, in metres."""
    k = math.pi * 6378137 / 180
    return math.hypot((lat1 - lat2) * k, (lon1 - lon2) * k * math.cos(math.radians(lat1)))


# ---------------------------------------------------------------------------- tests

class ProjectionTest(unittest.TestCase):
    # Source: https://epsg.io/transform#s_srs=4326&t_srs=5186&x=128.4849000&y=35.8567000 (and the
    # other x/y below); epsg.io's online converter (MapTiler Coordinates API, PROJ), read 2026-09-27.
    EPSG_IO_5186 = [
        # lat, lon -> easting, northing
        (35.8567, 128.4849, 334130.60938162147, 363162.65385353897),
        (35.8500, 128.4760, 333337.8389996006, 362406.9972560316),
        (35.8635, 128.4935, 334895.97544096236, 363929.06921571045),
    ]
    # https://epsg.io/transform#s_srs=4326&t_srs=5179&x=128.4849000&y=35.8567000
    EPSG_IO_5179 = (35.8567, 128.4849, 1088928.3952460114, 1762687.297636734)
    # Inverse, https://epsg.io/transform#s_srs=5186&t_srs=4326&x=334000.0000000&y=363000.0000000
    # shown as 128°29'0.338" E, 35°51'18.909" N (0.001" ~ 3 cm resolution).
    EPSG_IO_5186_INV = (334000.0, 363000.0, 35 + 51 / 60 + 18.909 / 3600, 128 + 29 / 60 + 0.338 / 3600)
    # NOAA NGS NCAT (UTM zone 52 on NAD83(2011) = GRS80), fetched 2026-09-27:
    # https://geodesy.noaa.gov/api/ncat/llh?lat=35.8567&lon=128.4849&inDatum=NAD83(2011)&outDatum=NAD83(2011)
    NCAT_UTM52 = (35.8567, 128.4849, 453491.220, 3968177.041)
    # PROJ test suite, +proj=tmerc +ellps=GRS80 (tolerance 50 nm there):
    # https://raw.githubusercontent.com/OSGeo/PROJ/master/test/gie/builtins.gie
    PROJ_GIE = [(1, 2, 222650.796797586, 110642.229411933),
                (35.37, 44.69, 4168136.489446198, 4985511.302287407)]  # 3900 km from the CM

    def test_epsg_io_forward_5186(self):
        for lat, lon, e, n in self.EPSG_IO_5186:
            x, y = imp.tm_forward(TM5186, lat, lon)
            self.assertLess(math.hypot(x - e, y - n), 0.05, (lat, lon, x - e, y - n))

    def test_epsg_io_forward_5179_from_prj(self):
        tm, label = imp.crs_from_prj(PRJ_5179_OGC)
        self.assertEqual(label, "EPSG:5179")
        lat, lon, e, n = self.EPSG_IO_5179
        x, y = imp.tm_forward(tm, lat, lon)
        self.assertLess(math.hypot(x - e, y - n), 0.05)

    def test_epsg_io_inverse_5186(self):
        x, y, lat, lon = self.EPSG_IO_5186_INV
        la, lo = imp.tm_inverse(TM5186, x, y)
        self.assertLess(metres(la, lo, lat, lon), 0.05)

    def test_ncat_utm52(self):
        lat, lon, e, n = self.NCAT_UTM52
        tm = imp.make_tm(6378137, 298.257222101, 0, 129, 0.9996, 500000, 0)
        x, y = imp.tm_forward(tm, lat, lon)
        self.assertLess(math.hypot(x - e, y - n), 0.005)  # NCAT prints millimetres

    def test_proj_gie_grs80(self):
        tm = imp.make_tm(6378137, 298.257222101, 0, 0, 1, 0, 0)
        for lat, lon, e, n in self.PROJ_GIE:
            x, y = imp.tm_forward(tm, lat, lon)
            self.assertLess(math.hypot(x - e, y - n), 1e-6)
            la, lo = imp.tm_inverse(tm, e, n)
            self.assertAlmostEqual(la, lat, places=11)
            self.assertAlmostEqual(lo, lon, places=11)

    def test_round_trip_over_campus_under_1cm(self):
        south, west, north, east = imp.BBOX
        worst = 0.0
        for i in range(11):
            for j in range(11):
                lat = south + (north - south) * i / 10
                lon = west + (east - west) * j / 10
                la, lo = imp.tm_inverse(TM5186, *imp.tm_forward(TM5186, lat, lon))
                worst = max(worst, metres(lat, lon, la, lo))
        self.assertLess(worst, 0.01)
        self.assertLess(worst, 1e-6)  # in practice nanometres


class PrjTest(unittest.TestCase):
    def test_5186_flavours(self):
        for wkt in (PRJ_5186_ESRI, PRJ_5186_OGC, PRJ_5186_WKT2):
            tm, label = imp.crs_from_prj(wkt)
            self.assertEqual(label, "EPSG:5186")
            self.assertEqual((tm["lat0"], tm["lon0"], tm["k0"], tm["fe"], tm["fn"]), (38, 127, 1, 200000, 600000))

    def test_bessel_is_rejected(self):
        with self.assertRaises(SystemExit) as cm:
            imp.crs_from_prj(PRJ_5174_ESRI)
        self.assertIn("Bessel", str(cm.exception))

    def test_unknown_projection_and_geographic_are_rejected(self):
        lcc = PRJ_5186_ESRI.replace("Transverse_Mercator", "Lambert_Conformal_Conic")
        with self.assertRaises(SystemExit):
            imp.crs_from_prj(lcc)
        with self.assertRaises(SystemExit):
            imp.crs_from_prj('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]]]')
        with self.assertRaises(SystemExit):
            imp.crs_from_prj(PRJ_5186_ESRI.replace("6378137.0", "6378388.0"))  # International 1924

    def test_unknown_tm_is_labelled_by_parameters(self):
        tm, label = imp.crs_from_prj(PRJ_5186_ESRI.replace("127.0", "127.5"))
        self.assertTrue(label.startswith("TM lat0=38 lon0=127.5"))


class ShapefileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_offsets_with_and_without_shx_and_null_shapes(self):
        shp, _ = build_fixture(self.dir)
        mm = imp.open_mmap(shp)
        with_shx = imp.record_offsets(mm, imp.open_mmap(shp.with_suffix(".shx")))
        self.assertEqual(with_shx, imp.record_offsets(mm))
        self.assertEqual(len(with_shx), 12)
        self.assertEqual(imp.record_type_bbox(mm, with_shx[2]), (0, None))

    def test_polygon_z_and_m_parse_like_polygon(self):
        rings = [rect(334000, 363000, 30, 20), rect(334000, 363000, 10, 10, ccw=True)]
        parsed = {}
        for st in (5, 15, 25):
            write_shapefile(self.dir / f"t{st}", st, [rings, None, rings])
            mm = imp.open_mmap(self.dir / f"t{st}.shp")
            self.assertEqual(imp.shp_header(mm)["type"], st)
            offs = imp.record_offsets(mm)
            parsed[st] = [imp.read_parts(mm, offs[0]), imp.read_parts(mm, offs[2])]
        self.assertEqual(parsed[5], parsed[15])
        self.assertEqual(parsed[5], parsed[25])
        self.assertEqual(parsed[5][0], rings)

    def test_group_rings_assigns_holes_by_containment(self):
        a, b = rect(0, 0, 30, 15), rect(50, 0, 30, 30)
        hole = rect(50, 0, 10, 10, ccw=True)
        groups = imp.group_rings([a, hole, b])
        self.assertEqual(groups, [(a, []), (b, [hole])])
        orphan = rect(200, 0, 10, 10, ccw=True)  # wrongly oriented outer: kept as an outer
        self.assertEqual(len(imp.group_rings([a, orphan])), 2)

    def test_bbox_prefilter_and_centroid_filter(self):
        shp, _ = build_fixture(self.dir)
        with contextlib.redirect_stdout(io.StringIO()):
            buildings, report = imp.read_buildings(shp, TM5186, imp.BBOX)
        self.assertEqual(report["null"], 1)
        self.assertEqual(report["candidates"], 10)  # 12 - null - far away
        self.assertEqual(report["deleted"], 1)
        self.assertEqual(report["outsideBbox"], 1)
        self.assertEqual(sorted({b["index"] for b in buildings}), [0, 1, 3, 5, 8, 9, 10, 11])
        self.assertEqual(len(buildings), 9)  # record 3 has two outer rings


class DbfTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, shp, **kw):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            buildings, report = imp.read_buildings(shp, TM5186, imp.BBOX, **kw)
        return buildings, report, out.getvalue()

    def test_cp949_detected_and_printed(self):
        shp, _ = build_fixture(self.dir)
        buildings, report, text = self.read(shp)
        self.assertEqual(report["encoding"], "cp949")
        self.assertEqual(report["mapping"]["name"], "A24")
        self.assertEqual(buildings[0]["attrs"]["use"], "교육연구시설")
        self.assertEqual(buildings[0]["attrs"]["dong"], "제1동")
        self.assertIn("sample 1: A1=11110000000001", text)
        self.assertIn("A24=계명대학교", text)
        self.assertIn("encoding cp949 (detected)", text)

    def test_utf8_with_cpg_and_without(self):
        fields = [("A1", "C", 20, 0), ("A24", "C", 60, 0), ("A25", "C", 60, 0)]
        write_shapefile(self.dir / "u", 5, [[ll_rect(35.856, 128.484, 20, 20)]])
        write_dbf(self.dir / "u.dbf", fields, [["1", "계명대학교 성서캠퍼스", "바우어관"]], encoding="utf-8")
        (self.dir / "u.prj").write_text(PRJ_5186_OGC)
        b, report, _ = self.read(self.dir / "u.shp")
        self.assertEqual(report["encoding"], "utf-8")
        self.assertEqual(b[0]["attrs"]["dong"], "바우어관")
        (self.dir / "u.cpg").write_text("UTF-8")
        b, report, _ = self.read(self.dir / "u.shp")
        self.assertEqual((report["encoding"], report["encodingSource"]), ("utf-8", ".cpg"))
        self.assertEqual(b[0]["attrs"]["name"], "계명대학교 성서캠퍼스")

    def test_cpg_names(self):
        for text, enc in (("EUC-KR", "cp949"), ("CP949", "cp949"), ("65001", "utf-8"), ("ANSI 949", "cp949"),
                          ("UTF-8\n", "utf-8"), ("nonsense", None)):
            (self.dir / "x.cpg").write_text(text)
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(imp.cpg_encoding(self.dir / "x.cpg"), enc, text)

    def test_korean_field_names_and_overrides(self):
        fields = [("건물명", "C", 60, 0), ("건물동명", "C", 60, 0), ("지상층수", "N", 5, 0),
                  ("높이", "N", 10, 2), ("건축물용도", "C", 60, 0), ("BLDG_H", "N", 10, 2)]
        write_shapefile(self.dir / "k", 5, [[ll_rect(35.856, 128.484, 20, 20)]])
        write_dbf(self.dir / "k.dbf", fields, [["계명대학교", "오산관", "4", "16.40", "교육연구시설", "99"]])
        (self.dir / "k.prj").write_text(PRJ_5186_ESRI)
        b, report, text = self.read(self.dir / "k.shp")
        self.assertEqual(report["mapping"]["floors"], "지상층수")
        self.assertEqual(report["mapping"]["use"], "건축물용도")
        self.assertEqual(b[0]["attrs"]["height"], "16.40")
        self.assertIn("not found: id", text)
        b, report, _ = self.read(self.dir / "k.shp", overrides={"height": "bldg_h"})
        self.assertEqual(b[0]["attrs"]["height"], "99")
        with self.assertRaises(SystemExit):
            self.read(self.dir / "k.shp", overrides={"name": "NOPE"})

    def test_parse_number(self):
        cases = {"": None, " ": None, "-": None, "0": 0.0, " 12.500000000": 12.5, "1,234": 1234.0, "abc": None}
        for s, v in cases.items():
            self.assertEqual(imp.parse_number(s), v, s)
        self.assertEqual(imp.fmt_number(20.0), "20")
        self.assertEqual(imp.fmt_number(28.25), "28.25")


class NameTest(unittest.TestCase):
    def test_generic_dong(self):
        for s in ("", "주동", "1동", "제1동", "제 2 동", "A동", "B", "가동", "101동", "2-1동", "부속동", "3호"):
            self.assertTrue(imp.is_generic_dong(s), s)
        for s in ("쉐턱관", "동영관", "본관동", "공학1호관", "학생회관", "아담스채플관"):
            self.assertFalse(imp.is_generic_dong(s), s)

    def test_registry_name(self):
        self.assertEqual(imp.registry_name("계명대학교", "영암관"), "영암관")
        self.assertEqual(imp.registry_name("대명빌딩", "1동"), "대명빌딩")
        self.assertIsNone(imp.registry_name("", "주동"))


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.shp, self.campus = build_fixture(self.dir)
        self.original = self.campus.read_text(encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def result(self):
        data = json.loads(self.campus.read_text(encoding="utf-8"))
        return data, {b["id"]: b for b in data["buildings"]}

    def test_dry_run_writes_nothing(self):
        text = run_main(self.shp, "--out", self.campus, "--dry-run", "--date", "2026-09-27")
        self.assertEqual(self.campus.read_text(encoding="utf-8"), self.original)
        self.assertFalse((self.dir / "campus.osm.json").exists())
        self.assertIn("Dry run", text)
        self.assertIn("names: 3 via OSM match, 5 via registry, 1 unnamed", text)
        self.assertIn("floors (A26>0): 6/9", text)
        self.assertIn("height (A16>0): 3/9", text)
        self.assertIn("OSM names with no SHP match (check buildings_meta.json): 공학1호관", text)

    def test_import_merges_and_backs_up(self):
        run_main(self.shp, "--out", self.campus, "--date", "2026-09-27")
        data, by_id = self.result()
        self.assertEqual((self.dir / "campus.osm.json").read_text(encoding="utf-8"), self.original)

        orig = fake_campus()
        for key in ("center", "campusOutline", "roads", "areas"):
            self.assertEqual(data[key], json.loads(json.dumps(orig[key])))
        self.assertIn("OpenStreetMap", data["attribution"])
        self.assertIn(imp.REGISTER_CREDIT, data["attribution"])
        self.assertEqual(data["buildingSource"], {"file": "fixture.shp", "crs": "EPSG:5186",
                                                  "importedAt": "2026-09-27", "count": 9})
        self.assertEqual(set(by_id), {
            "m11110000000001", "m11110000000002", "m11110000000003", "m11110000000003-2",
            "m11110000000005", "m11110000000008", "m11110000000009", "m11110000000010",
            "m11110000000011", "w500"})

        s = by_id["m11110000000001"]
        self.assertEqual(s["name"], "쉐턱관")
        self.assertEqual(s["outer"], SHUTTUCK_LL)  # exact after the TM round trip
        self.assertEqual(s["tags"], {
            "building": "university", "building:levels": "5", "height": "20.5", "name:en": "Shuttuck Hall",
            "osm:id": "w100", "reg:approved": "19930301", "reg:dong": "제1동", "reg:id": "11110000000001",
            "reg:name": "계명대학교", "reg:underground": "1", "reg:use": "교육연구시설"})
        self.assertTrue(s["campus"])

        court = by_id["m11110000000002"]
        self.assertEqual((court["name"], len(court["holes"])), ("동영관", 1))
        self.assertNotIn("height", court["tags"])
        self.assertNotIn("osm:id", court["tags"])
        self.assertEqual(court["holes"][0][0], court["holes"][0][-1])

        a, b = by_id["m11110000000003"], by_id["m11110000000003-2"]
        self.assertEqual((a["name"], b["name"]), ("대명빌딩", "대명빌딩"))
        self.assertEqual((len(a["holes"]), len(b["holes"])), (0, 1))
        self.assertNotIn("building:levels", a["tags"])
        self.assertNotIn("height", a["tags"])
        self.assertEqual(a["tags"]["building"], "office")

        apt = by_id["m11110000000005"]
        self.assertEqual((apt["name"], apt["campus"], apt["tags"]["building"]), ("성서아파트", False, "apartments"))

        unnamed = by_id["m11110000000008"]
        self.assertIsNone(unnamed["name"])
        self.assertEqual((unnamed["tags"]["osm:id"], unnamed["campus"]), ("w300", False))

        for bid in ("m11110000000009", "m11110000000010"):
            self.assertEqual(by_id[bid]["name"], "본관")
            self.assertEqual(by_id[bid]["tags"]["amenity"], "university")
        self.assertEqual(by_id["m11110000000010"]["tags"]["height"], "28.25")

        rotc = by_id["m11110000000011"]
        self.assertEqual((rotc["name"], rotc["campus"]), ("학군단", True))
        self.assertEqual(by_id["w500"], orig["buildings"][4])

    def test_rerun_uses_backup_and_is_idempotent(self):
        run_main(self.shp, "--out", self.campus, "--date", "2026-09-27")
        first = self.campus.read_text(encoding="utf-8")
        run_main(self.shp, "--out", self.campus, "--date", "2026-09-27")
        self.assertEqual(self.campus.read_text(encoding="utf-8"), first)
        self.assertEqual((self.dir / "campus.osm.json").read_text(encoding="utf-8"), self.original)

    def test_imported_file_without_backup_stops(self):
        run_main(self.shp, "--out", self.campus, "--date", "2026-09-27")
        (self.dir / "campus.osm.json").unlink()
        with self.assertRaises(SystemExit):
            run_main(self.shp, "--out", self.campus)

    def test_wrong_crs_or_region_and_bad_date_stop(self):
        (self.dir / "fixture.prj").write_text(PRJ_5179_OGC)  # same numbers read as UTM-K land elsewhere
        with self.assertRaises(SystemExit) as cm:
            run_main(self.shp, "--out", self.campus, "--dry-run")
        self.assertIn("Wrong region file or wrong CRS", str(cm.exception))
        (self.dir / "fixture.prj").write_text(PRJ_5186_ESRI)
        with self.assertRaises(SystemExit):
            run_main(self.shp, "--out", self.campus, "--dry-run", "--date", "27/09/2026")

    def test_missing_prj_needs_crs_flag(self):
        (self.dir / "fixture.prj").unlink()
        with self.assertRaises(SystemExit):
            run_main(self.shp, "--out", self.campus, "--dry-run")
        text = run_main(self.shp, "--out", self.campus, "--dry-run", "--crs", "5186")
        self.assertIn("CRS EPSG:5186", text)


if __name__ == "__main__":
    unittest.main()
