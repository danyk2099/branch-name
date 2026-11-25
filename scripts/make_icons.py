"""Render the extension icons (a git-branch glyph on a blue tile) without any
third-party libraries. Run: python3 scripts/make_icons.py"""

import math
import os
import struct
import zlib

BG = (12, 102, 228)
FG = (255, 255, 255)
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor per axis

# Geometry in a 0..1 unit square.
CORNER = 0.22
NODES = [(0.34, 0.24), (0.34, 0.76), (0.68, 0.36)]
NODE_R = 0.095
STROKE = 0.075


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def quad_dist(px, py, p0, p1, p2, steps=24):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
        pts.append((x, y))
    return min(seg_dist(px, py, *pts[i], *pts[i + 1]) for i in range(steps))


def in_tile(x, y):
    cx = min(max(x, CORNER), 1 - CORNER)
    cy = min(max(y, CORNER), 1 - CORNER)
    return math.hypot(x - cx, y - cy) <= CORNER


def in_glyph(x, y):
    (ax, ay), (bx, by), (cx, cy) = NODES
    if any(math.hypot(x - nx, y - ny) <= NODE_R for nx, ny in NODES):
        return True
    if seg_dist(x, y, ax, ay, bx, by) <= STROKE / 2:
        return True
    # branch curve from the side node down into the trunk
    return quad_dist(x, y, (cx, cy), (cx, 0.62), (ax, 0.66)) <= STROKE / 2


def render(size):
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter: none
        for px in range(size):
            tile = glyph = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    if in_tile(x, y):
                        tile += 1
                        if in_glyph(x, y):
                            glyph += 1
            n = SS * SS
            if tile == 0:
                row += bytes((0, 0, 0, 0))
                continue
            g = glyph / tile
            rgb = tuple(round(BG[i] * (1 - g) + FG[i] * g) for i in range(3))
            row += bytes((*rgb, round(255 * tile / n)))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out_dir, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(png(size, render(size)))
        print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
