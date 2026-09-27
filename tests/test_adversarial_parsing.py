"""Adversarial SHP/SHX/DBF parsing cases for scripts/import_shp.py.

Run: python3 -m unittest discover -s tests
Cases marked @unittest.expectedFailure reproduce known defects (see the comment on each);
remove the decorator once the defect is fixed.
"""
import contextlib
import io
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_import_shp as T  # noqa: E402  (stdlib writers and fixture)

imp = T.imp
rect = T.rect


def area(ring):
    return round(abs(imp.signed_area(ring)))


def summary(groups):
    return [(area(o), [area(h) for h in hs]) for o, hs in groups]


def write_dbf(path, fields, rows, encoding="cp949", extra_header=b"", count=None,
              name_pad=b"\0", fill=None, wide_c=False):
    """Variant of T.write_dbf with header/padding knobs. Values may be bytes."""
    hlen = 32 + 32 * len(fields) + 1 + len(extra_header)
    rlen = 1 + sum(f[2] for f in fields)
    out = [struct.pack("<BBBBIHH20x", 3, 126, 9, 27, len(rows) if count is None else count, hlen, rlen)]
    for name, ftype, length, dec in fields:
        nb = name.encode(encoding)
        nb += name_pad * (11 - len(nb))
        if wide_c and ftype == "C":  # shapelib/Clipper: width = len byte + 256 * decimals byte
            length, dec = length % 256, length // 256
        out.append(struct.pack("<11sc4xBB14x", nb, ftype.encode(), length, dec))
    out.append(b"\r" + extra_header)
    for row in rows:
        out.append(b" ")
        for (name, ftype, length, dec), value in zip(fields, row):
            raw = (value if isinstance(value, bytes) else str(value).encode(encoding))[:length]
            if fill is not None:
                out.append(raw + fill * (length - len(raw)))
            else:
                out.append(raw.rjust(length) if ftype == "N" else raw.ljust(length))
    Path(path).write_bytes(b"".join(out) + b"\x1a")


FIELDS = [("A1", "C", 20, 0), ("A16", "N", 19, 9), ("A24", "C", 40, 0), ("A25", "C", 40, 0),
          ("A26", "N", 9, 0), ("A27", "N", 9, 0)]


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def small(self, fields, rows, **kw):
        """One 20 m square per row inside the campus bbox."""
        recs = [[T.ll_rect(35.856 + 0.0005 * i, 128.484, 20, 20)] for i in range(len(rows))]
        T.write_shapefile(self.dir / "f", 5, recs)
        write_dbf(self.dir / "f.dbf", fields, rows, **kw)
        (self.dir / "f.prj").write_text(T.PRJ_5186_ESRI)
        return self.dir / "f.shp"

    def read(self, shp, **kw):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return imp.read_buildings(shp, T.TM5186, imp.BBOX, **kw)


class RingTest(unittest.TestCase):
    def test_two_outers_each_with_hole_holes_first(self):
        o1, h1 = rect(0, 0, 40, 40), rect(0, 0, 10, 10, ccw=True)
        o2, h2 = rect(100, 0, 60, 60), rect(100, 0, 20, 20, ccw=True)
        self.assertEqual(summary(imp.group_rings([h2, h1, o2, o1])), [(3600, [400]), (1600, [100])])

    def test_island_inside_hole(self):
        a, ha = rect(0, 0, 100, 100), rect(0, 0, 60, 60, ccw=True)
        b, hb = rect(0, 0, 30, 30), rect(0, 0, 10, 10, ccw=True)
        self.assertEqual(summary(imp.group_rings([hb, b, ha, a])), [(900, [100]), (10000, [3600])])

    def test_hole_touching_outer_at_start_vertex(self):
        outer = rect(0, 0, 40, 40)
        tri = [(20.0, 0.0), (5.0, 5.0), (5.0, -5.0), (20.0, 0.0)]  # (20, 0) lies on the outer edge
        tri = tri if imp.signed_area(tri) > 0 else tri[::-1]
        self.assertEqual(summary(imp.group_rings([outer, tri])), [(1600, [75])])


class ShapeTest(Tmp):
    def test_z_without_m_polygon_m_multipoint_and_split_multipart(self):
        x, y = T.xy(35.857, 128.485)
        fx, fy = T.xy(35.8480, 128.485)  # ~220 m south of the bbox
        ring = rect(x, y, 30, 30)
        pts = ring
        contents = []

        def poly(st, rings, z=False, m=False):
            flat = [p for r in rings for p in r]
            xs, ys = [p[0] for p in flat], [p[1] for p in flat]
            c = struct.pack("<i4d2i", st, min(xs), min(ys), max(xs), max(ys), len(rings), len(flat))
            k, parts = 0, []
            for r in rings:
                parts.append(k)
                k += len(r)
            c += struct.pack(f"<{len(parts)}i", *parts) + b"".join(struct.pack("<2d", *p) for p in flat)
            if z:
                c += struct.pack(f"<{2 + len(flat)}d", 0, 9, *([5.0] * len(flat)))
            if m:
                c += struct.pack(f"<{2 + len(flat)}d", 0, 1, *([0.5] * len(flat)))
            return c

        contents.append(poly(15, [ring, rect(x, y, 10, 10, ccw=True)], z=True))  # Z, M omitted
        contents.append(poly(25, [ring], m=True))
        contents.append(struct.pack("<i4di", 8, x, y, x, y, 1) + struct.pack("<2d", x, y))  # multipoint
        contents.append(struct.pack("<i", 0))
        contents.append(poly(5, [rect(fx, fy, 20, 20), rect(x - 60, y, 20, 20)]))
        body, index, off = b"", b"", 100
        for i, c in enumerate(contents, 1):
            body += struct.pack(">2i", i, len(c) // 2) + c
            index += struct.pack(">2i", off // 2, len(c) // 2)
            off += 8 + len(c)
        hdr = lambda n: (struct.pack(">7i", 9994, 0, 0, 0, 0, 0, n // 2) + struct.pack("<2i", 1000, 15)
                         + struct.pack("<8d", fx - 50, fy - 50, x + 50, y + 50, 0, 0, 0, 0))
        (self.dir / "z.shp").write_bytes(hdr(100 + len(body)) + body)
        (self.dir / "z.shx").write_bytes(hdr(100 + len(index)) + index)
        T.write_dbf(self.dir / "z.dbf", [("A1", "C", 10, 0)], [[str(i)] for i in range(5)])
        (self.dir / "z.prj").write_text(T.PRJ_5186_ESRI)
        del pts
        buildings, report = self.read(self.dir / "z.shp")
        self.assertEqual((report["null"], report["other"], report["outsideBbox"]), (1, 1, 1))
        self.assertEqual([(b["index"], b["part"], len(b["holes"])) for b in buildings],
                         [(0, 0, 1), (1, 0, 0), (4, 1, 0)])

    def test_trailing_padding_with_shx_is_ignored(self):
        shp, _ = T.build_fixture(self.dir)
        with open(shp, "ab") as f:
            f.write(b"\0" * 16)
        buildings, report = self.read(shp)
        self.assertEqual((report["records"], len(buildings)), (12, 9))

    # DEFECT: without a .shx, record_offsets() scans to len(file) instead of the header's
    # file-length field (bytes 24..27, 16-bit words), so zero padding at the end becomes
    # phantom records; with 8 or 16 bytes of padding record_type_bbox() stops the run with
    # "Truncated .shp: record at byte ... runs past the end".
    @unittest.expectedFailure
    def test_trailing_padding_without_shx(self):
        shp, _ = T.build_fixture(self.dir)
        with open(shp, "ab") as f:
            f.write(b"\0" * 8)
        (self.dir / "fixture.shx").unlink()
        buildings, report = self.read(shp)
        self.assertEqual((report["records"], len(buildings)), (12, 9))

    # DEFECT: a .shp cut inside a record's bbox raises struct.error (the bound check in
    # record_type_bbox is off + 12, but it reads 32 bytes from off + 12).
    @unittest.expectedFailure
    def test_truncated_shp_is_a_clean_error(self):
        shp, _ = T.build_fixture(self.dir)
        data = shp.read_bytes()
        shp.write_bytes(data[:-100])
        with self.assertRaises(SystemExit):
            self.read(shp)

    # DEFECT: a zero-byte .shx (e.g. a failed unzip) raises ValueError from mmap before the
    # "len(shx) < 100 -> scan the .shp" fallback is reached.
    @unittest.expectedFailure
    def test_empty_shx_falls_back_to_scan(self):
        shp, _ = T.build_fixture(self.dir)
        (self.dir / "fixture.shx").write_bytes(b"")
        buildings, _ = self.read(shp)
        self.assertEqual(len(buildings), 9)


class DbfVariantTest(Tmp):
    ROWS = [["1", " 12.500000000", "계명대학교", "바우어관", "   5", "  -"],
            ["2", "  -", "계명대학교", "의양관", "  5.0", "0"],
            ["3", "*" * 19, "x", "y", "*" * 9, ""],
            ["4", "12.5 ", "a", "b", " 3 ", "1 "],
            ["5", "  1.5E+01", "a", "b", "  +7", "-2"]]

    def tags(self, shp, **kw):
        buildings, _ = self.read(shp, **kw)
        return [{k: v for k, v in imp.make_building(b, None, [])[0]["tags"].items()
                 if k in ("height", "building:levels", "reg:underground", "reg:dong")} for b in buildings]

    def test_numeric_spaces_decimals_dash_overflow(self):
        self.assertEqual(self.tags(self.small(FIELDS, self.ROWS)), [
            {"building:levels": "5", "height": "12.5", "reg:dong": "바우어관"},
            {"building:levels": "5", "reg:dong": "의양관"},
            {"reg:dong": "y"},
            {"building:levels": "3", "height": "12.5", "reg:underground": "1", "reg:dong": "b"},
            {"building:levels": "7", "height": "15", "reg:dong": "b"}])

    def test_header_padding_nul_fill_and_space_padded_names(self):
        expected = self.tags(self.small(FIELDS, self.ROWS[:2]))
        for kw in ({"extra_header": b"\0" * 263}, {"fill": b"\0"}, {"name_pad": b" "}):
            with self.subTest(**{k: repr(v)[:12] for k, v in kw.items()}):
                self.assertEqual(self.tags(self.small(FIELDS, self.ROWS[:2], **kw)), expected)

    def test_cp949_truncated_mid_character_still_cp949(self):
        fields = [("A1", "C", 20, 0), ("A24", "C", 9, 0), ("A25", "C", 40, 0)]  # 9 bytes: 4.5 syllables
        buildings, report = self.read(self.small(fields, [["1", "계명대학교", "바우어관"]]))
        self.assertEqual(report["encoding"], "cp949")
        self.assertEqual(buildings[0]["attrs"]["name"], "계명대학�")
        self.assertEqual(buildings[0]["attrs"]["dong"], "바우어관")

    def test_uhc_only_syllables_detected_and_with_cpg_euc_kr(self):
        fields = [("A1", "C", 20, 0), ("A24", "C", 40, 0), ("A25", "C", 40, 0)]
        shp = self.small(fields, [["1", "똠방각하", "햏관"]])
        self.assertEqual(self.read(shp)[0][0]["attrs"]["name"], "똠방각하")
        shp.with_suffix(".cpg").write_text("EUC-KR")
        self.assertEqual(self.read(shp)[0][0]["attrs"]["name"], "똠방각하")

    # DEFECT: .cpg "EUC-KR" is widened to cp949, but --encoding euc-kr is used verbatim, so
    # UHC-only syllables (똠, 햏, 뷁, ...) come out as U+FFFD.
    @unittest.expectedFailure
    def test_encoding_flag_euc_kr_is_widened_to_cp949(self):
        fields = [("A1", "C", 20, 0), ("A24", "C", 40, 0), ("A25", "C", 40, 0)]
        shp = self.small(fields, [["1", "똠방각하", "햏관"]])
        self.assertEqual(self.read(shp, encoding="euc-kr")[0][0]["attrs"]["name"], "똠방각하")

    # DEFECT: an unknown --encoding value escapes as a LookupError traceback.
    @unittest.expectedFailure
    def test_unknown_encoding_flag_is_a_clean_error(self):
        shp = self.small(FIELDS, self.ROWS[:1])
        with self.assertRaises(SystemExit):
            self.read(shp, encoding="bogus")

    # DEFECT: a .cpg that does not match the data (says UTF-8, bytes are cp949) is trusted
    # without any check: every Korean value becomes U+FFFD, so A9 "공동주택" no longer
    # excludes apartments from the campus and generic dong names like "101동" become names.
    @unittest.expectedFailure
    def test_mislabelled_cpg_is_detected_or_warned(self):
        shp, _ = T.build_fixture(self.dir)
        (self.dir / "fixture.cpg").write_text("UTF-8")
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            buildings, report = imp.read_buildings(shp, T.TM5186, imp.BBOX)
        ok = buildings[0]["attrs"]["use"] == "교육연구시설" or "warning" in err.getvalue()
        self.assertTrue(ok, (report["encoding"], buildings[0]["attrs"]["use"]))

    # DEFECT: shapelib/Clipper store C widths > 255 as (len byte + 256 * decimals byte);
    # dbf_header() uses only the len byte, so every later field is read at the wrong offset
    # (only a stderr warning about the record length is printed).
    @unittest.expectedFailure
    def test_character_field_wider_than_255(self):
        fields = [("A1", "C", 20, 0), ("A24", "C", 300, 0), ("A25", "C", 40, 0), ("A26", "N", 9, 0)]
        buildings, _ = self.read(self.small(fields, [["1", "계명대학교", "바우어관", "5"]], wide_c=True))
        self.assertEqual((buildings[0]["attrs"]["dong"], buildings[0]["attrs"]["floors"]), ("바우어관", "5"))

    # DEFECT: A26 = "0.5" passes the "> 0" test but is written as building:levels "0"
    # (int(round(0.5)) == 0); same for reg:underground.
    @unittest.expectedFailure
    def test_fractional_floors_never_become_zero(self):
        tags = self.tags(self.small(FIELDS, [["1", "", "a", "b", "0.5", "0.4"]]))[0]
        self.assertNotEqual(tags.get("building:levels"), "0")
        self.assertNotEqual(tags.get("reg:underground"), "0")


if __name__ == "__main__":
    unittest.main()
