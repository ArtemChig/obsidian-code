"""Generate the Obsidian Code app icons (owner: platform).

The glyph is an obsidian shard: a tilted, faceted, dark volcanic-glass crystal lit from the upper right, with an
ice-blue (#8FB8DE) glint along its top-right edge. The same geometry is written to icon.svg (design source) and
rasterised with Pillow at 4x supersampling:

    icon.png  512x512   (BrowserWindow / notifications / electron-builder)
    icon.ico  16..256   (Windows exe, installer, taskbar, tray)
    tray.png  32x32     (non-Windows tray)

Run:  python resources/icons/generate_icons.py      (needs Pillow: pip install pillow)
"""

from __future__ import annotations

import math
import os
import sys

from PIL import Image, ImageChops, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

# ── geometry: upright shard in a 512 design space, then tilted and fitted ───────────────────────────────────────────
RAW = {
    "TOP": (318, 6),
    "R_UP": (374, 196),
    "R_LOW": (346, 420),
    "BOTTOM": (252, 506),
    "B_L": (166, 450),
    "L_LOW": (126, 302),
    "L_NOTCH": (174, 236),
    "L_UP": (196, 110),
    "CORE": (262, 292),
}
TILT_DEG = 12  # clockwise lean
MARGIN = 20
ORDER = ("TOP", "R_UP", "R_LOW", "BOTTOM", "B_L", "L_LOW", "L_NOTCH", "L_UP")


def _transform() -> dict[str, tuple[float, float]]:
    a = math.radians(TILT_DEG)
    cx, cy = 256.0, 256.0
    rot = {}
    for k, (x, y) in RAW.items():
        dx, dy = x - cx, y - cy
        rot[k] = (cx + dx * math.cos(a) - dy * math.sin(a), cy + dx * math.sin(a) + dy * math.cos(a))
    xs = [p[0] for p in rot.values()]
    ys = [p[1] for p in rot.values()]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    s = (512 - 2 * MARGIN) / max(w, h)
    ox = (512 - w * s) / 2 - min(xs) * s
    oy = (512 - h * s) / 2 - min(ys) * s
    return {k: (round(x * s + ox, 1), round(y * s + oy, 1)) for k, (x, y) in rot.items()}


P = _transform()
TOP, R_UP, R_LOW, CORE = P["TOP"], P["R_UP"], P["R_LOW"], P["CORE"]
L_UP = P["L_UP"]
OUTLINE = [P[k] for k in ORDER]

# one facet per outline edge, fanned from CORE: (polygon, top colour, bottom colour) — lit from the upper right
_FACET_COLOURS = [
    ("#46647F", "#2C4357"),  # TOP → R_UP (lit face)
    ("#30475A", "#1D2C38"),  # R_UP → R_LOW
    ("#1D2B36", "#111B22"),  # R_LOW → BOTTOM
    ("#10191F", "#0A1115"),  # BOTTOM → B_L
    ("#0C1418", "#080D10"),  # B_L → L_LOW
    ("#131C22", "#0D151A"),  # L_LOW → L_NOTCH
    ("#19242D", "#121C23"),  # L_NOTCH → L_UP
    ("#27394B", "#1B2836"),  # L_UP → TOP
]
FACETS = [
    ([OUTLINE[i], OUTLINE[(i + 1) % len(OUTLINE)], CORE], c_top, c_bot)
    for i, (c_top, c_bot) in enumerate(_FACET_COLOURS)
]
RIDGES = [(p, CORE) for p in OUTLINE]
GLINT = (143, 184, 222)  # #8FB8DE


def rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def render(size: int) -> Image.Image:
    ss = 4
    canvas = size * ss
    small = size <= 48
    scale = canvas / 512.0

    def pt(p: tuple[float, float]) -> tuple[float, float]:
        return (p[0] * scale, p[1] * scale)

    def stroke(final_px: float, design_px: float) -> int:
        return max(1, round(max(final_px * ss, design_px * scale)))

    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))

    # facets with a vertical gradient each
    for poly, c_top, c_bot in FACETS:
        pts = [pt(p) for p in poly]
        y0 = min(p[1] for p in pts)
        y1 = max(p[1] for p in pts)
        grad = Image.new("RGBA", (1, canvas))
        a, b = rgb(c_top), rgb(c_bot)
        for y in range(canvas):
            t = 0.0 if y1 <= y0 else min(1.0, max(0.0, (y - y0) / (y1 - y0)))
            grad.putpixel((0, y), tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,))
        grad = grad.resize((canvas, canvas))
        mask = Image.new("L", (canvas, canvas), 0)
        ImageDraw.Draw(mask).polygon(pts, fill=255)
        img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img, "RGBA")
    if not small:
        for a, b in RIDGES:
            d.line([pt(a), pt(b)], fill=GLINT + (46,), width=stroke(0.6, 2.5))

    # rim (keeps the dark glass visible on dark taskbars)
    d.line([pt(p) for p in OUTLINE + [OUTLINE[0]]], fill=(86, 101, 115, 255 if small else 190),
           width=stroke(1.0 if small else 0.7, 5), joint="curve")

    # soft glints on the upper-left edge and the central ridge
    d.line([pt(L_UP), pt(TOP)], fill=GLINT + (120,), width=stroke(1.0 if small else 0.7, 5), joint="curve")
    if not small:
        d.line([pt(TOP), pt(CORE)], fill=GLINT + (95,), width=stroke(0.7, 4))
    d.line([pt(R_UP), pt(R_LOW)], fill=GLINT + (110,), width=stroke(1.0 if small else 0.7, 5))

    # main glint: a tapered highlight along TOP → R_UP, widest at the tip
    tx, ty = pt(TOP)
    rx, ry = pt(R_UP)
    length = math.hypot(rx - tx, ry - ty)
    nx, ny = -(ry - ty) / length, (rx - tx) / length  # normal (points into the shard)
    w_tip = (2.6 if small else 1.6) * ss if small else 16 * scale
    w_end = (1.2 * ss) if small else 5 * scale
    glint_poly = [
        (tx - nx * w_tip * 0.35, ty - ny * w_tip * 0.35),
        (rx - nx * w_end * 0.35, ry - ny * w_end * 0.35),
        (rx + nx * w_end * 0.65, ry + ny * w_end * 0.65),
        (tx + nx * w_tip * 0.65, ty + ny * w_tip * 0.65),
    ]
    d.polygon(glint_poly, fill=GLINT + (255,))
    # a short bright core of the glint near the tip
    mx, my = tx + (rx - tx) * 0.28, ty + (ry - ty) * 0.28
    d.line([(tx, ty), (mx, my)], fill=(220, 234, 246, 235), width=max(1, round(w_tip * 0.45)))

    # clip everything to the shard silhouette (+ rim)
    clip = Image.new("L", (canvas, canvas), 0)
    cd = ImageDraw.Draw(clip)
    cd.polygon([pt(p) for p in OUTLINE], fill=255)
    cd.line([pt(p) for p in OUTLINE + [OUTLINE[0]]], fill=255, width=stroke(1.0, 5), joint="curve")
    alpha = ImageChops.multiply(img.getchannel("A"), clip)
    img.putalpha(alpha)

    return img.resize((size, size), Image.LANCZOS)


def write_svg(path: str) -> None:
    def pts(poly: list[tuple[float, float]]) -> str:
        return " ".join(f"{x:g},{y:g}" for x, y in poly)

    defs, facets = [], []
    for i, (poly, c_top, c_bot) in enumerate(FACETS):
        y0 = min(p[1] for p in poly)
        y1 = max(p[1] for p in poly)
        defs.append(
            f'    <linearGradient id="f{i}" gradientUnits="userSpaceOnUse" x1="0" y1="{y0:g}" x2="0" y2="{y1:g}">'
            f'<stop offset="0" stop-color="{c_top}"/><stop offset="1" stop-color="{c_bot}"/></linearGradient>'
        )
        facets.append(f'  <polygon points="{pts(poly)}" fill="url(#f{i})"/>')
    ridges = "\n".join(
        f'  <line x1="{a[0]:g}" y1="{a[1]:g}" x2="{b[0]:g}" y2="{b[1]:g}" stroke="#8FB8DE" stroke-opacity="0.18" stroke-width="2.5"/>'
        for a, b in RIDGES
    )
    nl = "\n"
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>Obsidian Code</title>
  <defs>
    <clipPath id="shard"><polygon points="{pts(OUTLINE)}"/></clipPath>
{nl.join(defs)}
  </defs>
  <g clip-path="url(#shard)">
{nl.join(facets)}
{ridges}
    <line x1="{TOP[0]:g}" y1="{TOP[1]:g}" x2="{CORE[0]:g}" y2="{CORE[1]:g}" stroke="#8FB8DE" stroke-opacity="0.37" stroke-width="4"/>
    <polyline points="{pts([L_UP, TOP])}" fill="none" stroke="#8FB8DE" stroke-opacity="0.47" stroke-width="5"/>
    <polyline points="{pts([R_UP, R_LOW])}" fill="none" stroke="#8FB8DE" stroke-opacity="0.43" stroke-width="5"/>
    <polyline points="{pts([TOP, R_UP])}" fill="none" stroke="#8FB8DE" stroke-width="12" stroke-linecap="round"/>
  </g>
  <polygon points="{pts(OUTLINE)}" fill="none" stroke="#566573" stroke-opacity="0.75" stroke-width="5" stroke-linejoin="round"/>
</svg>
"""
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(svg)


def main() -> int:
    out = HERE
    write_svg(os.path.join(out, "icon.svg"))
    render(512).save(os.path.join(out, "icon.png"))
    render(32).save(os.path.join(out, "tray.png"))
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [render(s) for s in sizes]
    frames[-1].save(
        os.path.join(out, "icon.ico"),
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=frames[:-1],
    )
    with Image.open(os.path.join(out, "icon.ico")) as ico:
        got = sorted(ico.info.get("sizes", set()))
    print("icon.ico sizes:", got)
    return 0


if __name__ == "__main__":
    sys.exit(main())
