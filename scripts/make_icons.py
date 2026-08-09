#!/usr/bin/env python3
"""
Render the application icon from the same geometry as resources/icon.svg.

There is no SVG rasteriser on this machine, and adding one as a build
dependency for an icon would be silly. This draws the mark directly with
Pillow at 4x and downsamples, which gives clean edges and keeps the output
reproducible.

    python3 scripts/make_icons.py

Writes resources/icon.png (512), resources/icon@256.png and resources/icon.ico
(the multi-resolution icon Windows and electron-builder want).
"""

from pathlib import Path
from PIL import Image, ImageDraw

S = 1024                      # supersample; the design is authored at 256
K = S / 256                   # scale factor from the SVG coordinate system

BG = (10, 13, 18, 255)        # #0a0d12
ACCENT = (76, 155, 255)       # #4c9bff
DIE_TOP = (90, 164, 255)      # #5aa4ff
DIE_BOT = (47, 111, 196)      # #2f6fc4
EDGE = (141, 192, 255, 230)   # #8dc0ff


def u(v: float) -> float:
    """SVG units -> supersampled pixels."""
    return v * K


def rounded(draw, box, radius, **kw):
    draw.rounded_rectangle([u(box[0]), u(box[1]), u(box[2]), u(box[3])],
                           radius=u(radius), **kw)


def dashed_rounded(img, box, radius, dash, gap, width, colour):
    """
    A dashed rounded rectangle.

    Each straight edge is dashed independently and the corner arcs stay solid.
    An earlier version masked a solid stroke with two full-canvas bands, which
    made the dashes land differently on each edge.
    """
    d = ImageDraw.Draw(img)
    w = int(u(width))
    x0, y0, x1, y1 = u(box[0]), u(box[1]), u(box[2]), u(box[3])
    r = u(radius)
    step, length = u(dash + gap), u(dash)
    half = w / 2

    def dashes(start, end):
        """Dash midpoints along one edge, inset by the corner radius."""
        pos = start
        while pos < end:
            yield pos, min(pos + length, end)
            pos += step

    for a, b in dashes(x0 + r, x1 - r):          # top and bottom
        d.line([a, y0 + half, b, y0 + half], fill=colour, width=w)
        d.line([a, y1 - half, b, y1 - half], fill=colour, width=w)
    for a, b in dashes(y0 + r, y1 - r):          # left and right
        d.line([x0 + half, a, x0 + half, b], fill=colour, width=w)
        d.line([x1 - half, a, x1 - half, b], fill=colour, width=w)

    # Solid corner arcs, so the outline still reads as one closed rectangle.
    box_tl = [x0 + half, y0 + half, x0 + 2 * r - half, y0 + 2 * r - half]
    box_tr = [x1 - 2 * r + half, y0 + half, x1 - half, y0 + 2 * r - half]
    box_br = [x1 - 2 * r + half, y1 - 2 * r + half, x1 - half, y1 - half]
    box_bl = [x0 + half, y1 - 2 * r + half, x0 + 2 * r - half, y1 - half]
    d.arc(box_tl, 180, 270, fill=colour, width=w)
    d.arc(box_tr, 270, 360, fill=colour, width=w)
    d.arc(box_br, 0, 90, fill=colour, width=w)
    d.arc(box_bl, 90, 180, fill=colour, width=w)


def gradient_die(box, radius):
    """Diagonal gradient for the die, matching the SVG's linearGradient."""
    x0, y0, x1, y1 = [u(v) for v in box]
    w, h = int(x1 - x0), int(y1 - y0)
    grad = Image.new('RGBA', (w, h))
    px = grad.load()
    for yy in range(h):
        for xx in range(w):
            t = (xx / max(1, w - 1) + yy / max(1, h - 1)) / 2
            px[xx, yy] = (
                round(DIE_TOP[0] + (DIE_BOT[0] - DIE_TOP[0]) * t),
                round(DIE_TOP[1] + (DIE_BOT[1] - DIE_TOP[1]) * t),
                round(DIE_TOP[2] + (DIE_BOT[2] - DIE_TOP[2]) * t),
                255,
            )
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=u(radius), fill=255)
    return grad, mask, (int(x0), int(y0))


def build() -> Image.Image:
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    rounded(d, (0, 0, 255, 255), 56, fill=BG)

    # Gross solution boundary — dashed, because it is an estimate.
    dashed_rounded(img, (40, 40, 216, 216), 14, dash=18, gap=13, width=6,
                   colour=ACCENT + (140,))

    # The die.
    grad, mask, pos = gradient_die((88, 88, 168, 168), 10)
    img.paste(grad, pos, mask)
    d = ImageDraw.Draw(img)
    rounded(d, (88, 88, 168, 168), 10, outline=EDGE, width=int(u(3)))

    # Pads: three per side.
    for x in (100, 121, 142):
        rounded(d, (x, 66, x + 10, 84), 3, fill=ACCENT + (255,))
        rounded(d, (x, 172, x + 10, 190), 3, fill=ACCENT + (255,))
    for y in (100, 121, 142):
        rounded(d, (66, y, 84, y + 10), 3, fill=ACCENT + (255,))
        rounded(d, (172, y, 190, y + 10), 3, fill=ACCENT + (255,))

    # Pin-1 marker.
    d.ellipse([u(96), u(96), u(108), u(108)], fill=BG)

    return img


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    out = root / 'resources'
    master = build()

    master.resize((512, 512), Image.LANCZOS).save(out / 'icon.png')
    master.resize((256, 256), Image.LANCZOS).save(out / 'icon@256.png')
    master.resize((256, 256), Image.LANCZOS).save(
        out / 'icon.ico',
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print('wrote', out / 'icon.png', out / 'icon.ico')


if __name__ == '__main__':
    main()
