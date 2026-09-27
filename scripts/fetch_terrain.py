#!/usr/bin/env python3
"""Build terrain heightmaps around the campus from open Terrain Tiles (terrarium PNG).

Downloads AWS/Mapzen Terrain Tiles once (cached in scripts/.cache/terrain), decodes the PNGs
with the standard library, and resamples them onto two regular grids in the same local metric
frame the front end uses (x = east, y = north, meters from data/campus.json "center"):

  inner: 4.8 km square, 12 m spacing (campus and the hills right behind it)
  outer: 36 km square, 150 m spacing (distant mountains for the horizon)

Writes assets/terrain/terrain.json plus inner.bin / outer.bin (little-endian int16, decimeters
relative to `ref`, rows from south to north, columns west to east).

Data: Terrain Tiles by Mapzen (AWS Open Data); Korea is covered by SRTM / GMTED2010 (USGS)
and ETOPO1 (NOAA). Usage: python3 scripts/fetch_terrain.py
"""
import json
import math
import struct
import sys
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "scripts" / ".cache" / "terrain"
OUT = ROOT / "assets" / "terrain"
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
R = 6378137.0
GRIDS = {
    "inner": {"half": 2400.0, "step": 12.0, "zoom": 14},
    "outer": {"half": 18000.0, "step": 150.0, "zoom": 11},
}
CAMPUS_BBOX = (35.8500, 128.4760, 35.8635, 128.4935)  # south, west, north, east
ATTRIBUTION = "지형: Terrain Tiles (Mapzen, AWS Open Data) · SRTM, GMTED2010 (USGS), ETOPO1 (NOAA)"


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def decode_png(data):
    """Decode an 8-bit RGB/RGBA non-interlaced PNG into (width, height, channels, bytes)."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, width = 8, [], None
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or ctype not in (2, 6) or interlace:
                raise ValueError(f"unsupported PNG (depth {depth}, color {ctype}, interlace {interlace})")
            ch = 3 if ctype == 2 else 4
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
        pos += 12 + length
    raw = zlib.decompress(b"".join(idat))
    stride = width * ch
    out = bytearray(height * stride)
    prev = bytearray(stride)
    for row in range(height):
        f = raw[row * (stride + 1)]
        line = bytearray(raw[row * (stride + 1) + 1:(row + 1) * (stride + 1)])
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                left = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                left = line[i - ch] if i >= ch else 0
                upleft = prev[i - ch] if i >= ch else 0
                line[i] = (line[i] + paeth(left, prev[i], upleft)) & 255
        out[row * stride:(row + 1) * stride] = line
        prev = line
    return width, height, ch, out


def fetch_tile(z, x, y):
    path = CACHE / f"{z}_{x}_{y}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(TILE_URL.format(z=z, x=x, y=y), headers={"User-Agent": "kmu-campus-3d/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            path.write_bytes(r.read())
    w, h, ch, px = decode_png(path.read_bytes())
    # terrarium encoding: meters = R * 256 + G + B / 256 - 32768
    return [[px[(j * w + i) * ch] * 256 + px[(j * w + i) * ch + 1] + px[(j * w + i) * ch + 2] / 256 - 32768
             for i in range(w)] for j in range(h)]


def world_px(lat, lon, z):
    n = 2 ** z * 256
    lr = math.radians(lat)
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n


class Sampler:
    """Bilinear elevation lookup over lazily loaded tiles at one zoom."""

    def __init__(self, z):
        self.z, self.tiles = z, {}

    def pixel(self, px, py):
        tx, ty = int(px // 256), int(py // 256)
        if (tx, ty) not in self.tiles:
            print(f"  tile z{self.z} {tx},{ty}")
            self.tiles[(tx, ty)] = fetch_tile(self.z, tx, ty)
        return self.tiles[(tx, ty)][int(py) - ty * 256][int(px) - tx * 256]

    def at(self, lat, lon):
        px, py = world_px(lat, lon, self.z)
        px, py = px - 0.5, py - 0.5  # pixel centers
        x0, y0 = math.floor(px), math.floor(py)
        fx, fy = px - x0, py - y0
        v00, v10 = self.pixel(x0, y0), self.pixel(x0 + 1, y0)
        v01, v11 = self.pixel(x0, y0 + 1), self.pixel(x0 + 1, y0 + 1)
        return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy


def despike(rows, limit):
    """Replace isolated glitches (a few tiles contain -300..-600 m voids) with the 3x3 median."""
    n = len(rows)
    fixed = 0
    out = [row[:] for row in rows]
    for j in range(n):
        for i in range(n):
            nb = sorted(rows[b][a] for b in range(max(0, j - 1), min(n, j + 2)) for a in range(max(0, i - 1), min(n, i + 2)))
            med = nb[len(nb) // 2]
            if abs(rows[j][i] - med) > limit or rows[j][i] < 0:
                out[j][i] = med
                fixed += 1
    return out, fixed


def main():
    campus = json.loads((ROOT / "data" / "campus.json").read_text(encoding="utf-8"))
    lat0, lon0 = campus["center"]
    kx = math.cos(math.radians(lat0)) * math.pi * R / 180  # must match src/geo.js makeProjector
    ky = math.pi * R / 180
    to_latlon = lambda x, y: (lat0 + y / ky, lon0 + x / kx)

    grids = {}
    for name, g in GRIDS.items():
        print(f"{name}: {g['half'] * 2 / 1000:.1f} km, {g['step']} m spacing, zoom {g['zoom']}")
        s = Sampler(g["zoom"])
        n = int(round(g["half"] * 2 / g["step"])) + 1
        rows = [[s.at(*to_latlon(-g["half"] + i * g["step"], -g["half"] + j * g["step"])) for i in range(n)] for j in range(n)]
        rows, fixed = despike(rows, 40 if name == "inner" else 120)
        print(f"  despiked {fixed} samples")
        grids[name] = (n, rows)

    # Reference level: low end of the campus so campus ground sits near y = 0.
    inner_s = Sampler(GRIDS["inner"]["zoom"])
    s_, w_, n_, e_ = CAMPUS_BBOX
    samples = sorted(inner_s.at(s_ + (n_ - s_) * a / 20, w_ + (e_ - w_) * b / 20) for a in range(21) for b in range(21))
    ref = round(samples[len(samples) // 50], 1)

    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"attribution": ATTRIBUTION, "center": [lat0, lon0], "ref": ref, "grids": {}}
    for name, (n, rows) in grids.items():
        vals = [max(-32768, min(32767, round((v - ref) * 10))) for row in rows for v in row]
        (OUT / f"{name}.bin").write_bytes(struct.pack(f"<{len(vals)}h", *vals))
        flat = [v for row in rows for v in row]
        meta["grids"][name] = {"file": f"{name}.bin", "n": n, "half": GRIDS[name]["half"], "step": GRIDS[name]["step"],
                               "min": round(min(flat), 1), "max": round(max(flat), 1)}
        print(f"  {name}: {n}x{n}, elevation {min(flat):.0f}..{max(flat):.0f} m")
    (OUT / "terrain.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"ref elevation {ref} m (campus low point); campus range {samples[0]:.0f}..{samples[-1]:.0f} m")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    sys.exit(main())
