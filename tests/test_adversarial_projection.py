"""Adversarial checks of the projection math and .prj parsing in scripts/import_shp.py.

Reference values were computed independently of the Krüger series, by analytic continuation
of the exact ellipsoidal TM (mpmath, 40 digits): northing + i*easting = k0 * (M(phi_c) - M(lat0))
with psi(phi_c) = psi(lat) + i*dlon, M the meridian arc integral continued to complex latitude.
That method reproduces the PROJ builtins.gie tmerc/GRS80 cases to < 1e-8 m and NOAA NCAT UTM 52
to 0.5 mm. The 5186/5179 campus-centre values also agree with the epsg.io values in
tests/test_import_shp.py to < 1e-8 m.
"""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import import_shp as imp  # noqa: E402

EXACT = [  # EPSG, lat, lon, easting, northing
    (5186, 35.85, 128.476, 333337.838999601, 362406.9972560312),
    (5186, 35.85, 128.4935, 334918.8543181954, 362430.9974256601),
    (5186, 35.8635, 128.476, 333315.2283813137, 363905.0652940218),
    (5186, 35.8635, 128.4935, 334895.9754409651, 363929.0692157101),
    (5186, 35.8567, 128.4849, 334130.6093816251, 363162.6538535377),
    (5186, 37.5665, 126.978, 198056.3667370282, 551885.0305887158),  # Seoul City Hall
    (5179, 35.85, 128.476, 1088132.188762615, 1761936.097789524),
    (5179, 35.85, 128.4935, 1089712.477541628, 1761952.006405793),
    (5179, 35.8635, 128.476, 1088117.246308562, 1763433.478099773),
    (5179, 35.8635, 128.4935, 1089697.267085493, 1763449.389204468),
    (5179, 35.8567, 128.4849, 1088928.395246015, 1762687.297636733),
    (5179, 37.5665, 126.978, 953901.1653121522, 1952032.080979087),
]


class AdversarialProjectionTest(unittest.TestCase):
    def test_forward_and_inverse_against_exact_tm(self):
        for code, lat, lon, e, n in EXACT:
            tm, _ = imp.crs_from_code(code)
            x, y = imp.tm_forward(tm, lat, lon)
            self.assertLess(math.hypot(x - e, y - n), 1e-6, (code, lat, lon))
            la, lo = imp.tm_inverse(tm, e, n)
            self.assertLess(abs(la - lat) * 111e3 + abs(lo - lon) * 111e3, 1e-6, (code, lat, lon))

    def test_prefilter_box_covers_dense_bbox_boundary(self):
        s, w, n, e = imp.BBOX
        for code in (5179, 5181, 5185, 5186, 5187, 5188):
            tm, _ = imp.crs_from_code(code)
            box = imp.projected_bbox(tm, imp.BBOX, 0)
            for k in range(401):
                t = k / 400
                for lat, lon in ((s, w + (e - w) * t), (n, w + (e - w) * t),
                                 (s + (n - s) * t, w), (s + (n - s) * t, e)):
                    x, y = imp.tm_forward(tm, lat, lon)
                    self.assertTrue(box[0] <= x <= box[2] and box[1] <= y <= box[3], (code, lat, lon))

    def test_prj_whitespace_bom_and_5179_esri(self):
        esri = ('PROJCS["Korea_2000_Korea_Unified_Coordinate_System",GEOGCS["GCS_Korea_2000",'
                'DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],'
                'UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],'
                'PARAMETER["False_Easting",1000000.0],PARAMETER["False_Northing",2000000.0],'
                'PARAMETER["Central_Meridian",127.5],PARAMETER["Scale_Factor",0.9996],'
                'PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]')
        for wkt in (esri, "﻿" + esri, esri.replace(",", " ,\r\n  ")):
            tm, label = imp.crs_from_prj(wkt)
            self.assertEqual(label, "EPSG:5179")
            self.assertEqual((tm["a"], tm["rf"]), (6378137.0, 298.257222101))


if __name__ == "__main__":
    unittest.main()
