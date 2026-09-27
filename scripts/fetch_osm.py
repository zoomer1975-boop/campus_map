#!/usr/bin/env python3
"""Fetch Keimyung University Seongseo campus geometry from OpenStreetMap.

Writes data/campus.json. Data (c) OpenStreetMap contributors, ODbL.
Usage: python3 scripts/fetch_osm.py
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

CAMPUS_RELATION = 15098442
BBOX = (35.8500, 128.4760, 35.8635, 128.4935)  # south, west, north, east
CENTER = (35.8567, 128.4849)
MIRRORS = [
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
OUT = Path(__file__).resolve().parent.parent / "data" / "campus.json"

bbox = ",".join(str(v) for v in BBOX)
QUERY = f"""
[out:json][timeout:120];
(
  way["building"]({bbox});
  relation["building"]({bbox});
  way["highway"~"^(primary|secondary|tertiary|residential|service|unclassified|footway|pedestrian|path|steps|living_street)$"]({bbox});
  way["leisure"~"^(pitch|park|garden|track|stadium)$"]({bbox});
  way["landuse"~"^(grass|forest|meadow)$"]({bbox});
  way["natural"~"^(wood|water|scrub)$"]({bbox});
  way["amenity"="parking"]({bbox});
  relation({CAMPUS_RELATION});
);
out geom;
"""


def overpass(query):
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for url in MIRRORS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(
                    url, data=data,
                    headers={"User-Agent": "Mozilla/5.0 kmu-campus-3d/1.0",
                             "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=180) as r:
                    return json.loads(r.read().decode("utf-8"))
            except Exception as e:  # noqa: BLE001 - try the next mirror
                last = e
                print(f"  {url} failed ({e}); retrying", file=sys.stderr)
                time.sleep(3)
    raise SystemExit(f"All Overpass mirrors failed: {last}")


def ring(geom):
    return [[round(p["lat"], 7), round(p["lon"], 7)] for p in geom]


def point_in_poly(lat, lon, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        yi, xi = poly[i]
        yj, xj = poly[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def join_rings(ways):
    """Join relation member ways into closed rings."""
    segs = [ring(w) for w in ways if w]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]
                elif s[-1] == cur[-1]:
                    cur += s[::-1][1:]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[::-1][:-1] + cur
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        rings.append(cur)
    return rings


def centroid(poly):
    lat = sum(p[0] for p in poly) / len(poly)
    lon = sum(p[1] for p in poly) / len(poly)
    return lat, lon


def main():
    print("Querying Overpass...")
    elements = overpass(QUERY)["elements"]
    print(f"  {len(elements)} elements")

    campus_rings = []
    buildings, roads, areas = [], [], []

    for e in elements:
        tags = e.get("tags", {})
        if e["type"] == "relation" and e["id"] == CAMPUS_RELATION:
            outer = [m["geometry"] for m in e["members"] if m.get("role") == "outer" and "geometry" in m]
            campus_rings = join_rings(outer)
            continue

        if "building" in tags:
            if e["type"] == "way":
                outer, holes = [ring(e["geometry"])], []
            else:
                outer = join_rings([m["geometry"] for m in e["members"] if m.get("role") == "outer" and "geometry" in m])
                holes = join_rings([m["geometry"] for m in e["members"] if m.get("role") == "inner" and "geometry" in m])
            for o in outer:
                if len(o) < 4:
                    continue
                buildings.append({
                    "id": f"{e['type'][0]}{e['id']}",
                    "name": tags.get("name"),
                    "tags": {k: v for k, v in tags.items() if k in (
                        "building", "building:levels", "height", "name:en", "amenity", "roof:shape")},
                    "outer": o,
                    "holes": [h for h in holes if len(h) >= 4 and point_in_poly(*h[0], o)],
                })
        elif e["type"] == "way" and "highway" in tags:
            roads.append({"kind": tags["highway"], "name": tags.get("name"), "line": ring(e["geometry"])})
        elif e["type"] == "way":
            kind = tags.get("leisure") or tags.get("landuse") or tags.get("natural") or tags.get("amenity")
            geom = ring(e["geometry"])
            if len(geom) >= 4 and geom[0] == geom[-1]:
                areas.append({"kind": kind, "sport": tags.get("sport"), "poly": geom})

    if not campus_rings:
        raise SystemExit("Campus relation geometry missing")

    for b in buildings:
        c = centroid(b["outer"][:-1])
        b["campus"] = any(point_in_poly(*c, r) for r in campus_rings) and \
            b["tags"].get("building") not in ("apartments", "residential", "church", "cathedral", "commercial")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "attribution": "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)",
        "center": CENTER,
        "campusOutline": campus_rings,
        "buildings": buildings,
        "roads": roads,
        "areas": areas,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    campus = [b for b in buildings if b["campus"]]
    print(f"Wrote {OUT}")
    print(f"  buildings: {len(buildings)} (campus {len(campus)}), roads: {len(roads)}, areas: {len(areas)}")
    print("  named campus buildings:", ", ".join(sorted({b['name'] for b in campus if b['name']})))


if __name__ == "__main__":
    main()
