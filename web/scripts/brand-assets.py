#!/usr/bin/env python3
"""Бренд-файли NextCryptoJob: знак «Печатка» (варіант 1), текстовий логотип, іконки, аватари, банери.

Запуск (потрібні fonttools і Pillow, Chrome для PNG):
  python3 brand-assets.py <BigShoulders[opsz,wght].ttf> <вихідна тека>

Знак: розетка-гіпотрохоїда x=(R+r)cos t+(r+p)cos((R+r)/r t), y=(R+r)sin t-(r+p)sin((R+r)/r t),
ті самі шари, що в макеті варіантів лого; один помаранчевий центр. Текст переводиться в криві,
тож SVG не залежать від встановлених шрифтів.
"""
import math
import os
import subprocess
import sys
import tempfile

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

INK, PAPER, GROUND, ACCENT = "#121418", "#ffffff", "#eceef1", "#bb340e"
INK_D, NAVY, ACCENT_D = "#eef1f6", "#0f1829", "#ff7a4d"
LAYERS = [(-3, 20), (-4.2, 28), (-2.6, 16), (-5.4, 34), (-3.6, 24)]
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def rosette(r, p, scale, step, R=60):
    k = (R + r) / r
    pts, t = [], 0.0
    while t <= math.pi * 2 + step:
        x = ((R + r) * math.cos(t) + (r + p) * math.cos(k * t)) * scale
        y = ((R + r) * math.sin(t) - (r + p) * math.sin(k * t)) * scale
        pts.append(f"{x:.2f} {y:.2f}")
        t += step
    return "M" + "L".join(pts) + "Z"


# Три ступені деталізації: повний знак, малий (до 48 px), крихітний (16 px).
DETAIL = {
    "full": dict(layers=5, radius=84, stroke=1.4, dot=10, step=0.006),
    "small": dict(layers=3, radius=84, stroke=4.2, dot=12, step=0.02),
    "tiny": dict(layers=2, radius=80, stroke=7.0, dot=16, step=0.03),
}


def seal_paths(ink, detail):
    d = DETAIL[detail]
    out = []
    for i in range(d["layers"]):
        r, p = LAYERS[i % len(LAYERS)]
        reach = (60 + r) + abs(r + p)
        s = d["radius"] * (1 - i * 0.11) / reach
        out.append(
            f'<path d="{rosette(r, p, s, d["step"])}" fill="none" stroke="{ink}" '
            f'stroke-width="{d["stroke"]}" stroke-linejoin="round"/>'
        )
    return "".join(out)


def mark_group(ink, dot, detail="full"):
    return f'{seal_paths(ink, detail)}<circle r="{DETAIL[detail]["dot"]}" fill="{dot}"/>'


def svg(w, h, body, vb=None):
    vb = vb or f"0 0 {w} {h}"
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vb}">{body}</svg>\n'


def mark_svg(ink, dot, detail="full", bg=None, circle_bg=None, size=200):
    back = ""
    if bg:
        back = f'<rect x="-100" y="-100" width="200" height="200" fill="{bg}"/>'
    if circle_bg:
        back += f'<circle r="100" fill="{circle_bg}"/>'
    return svg(size, size, back + mark_group(ink, dot, detail), "-100 -100 200 200")


def avatar_svg(ink, dot, bg, size=512):
    # Квадрат на всю площу (Telegram і X обрізають колом); знак у безпечному колі 70%.
    body = f'<rect x="-100" y="-100" width="200" height="200" fill="{bg}"/><g transform="scale(0.7)">{mark_group(ink, dot)}</g>'
    return svg(size, size, body, "-100 -100 200 200")


class Type:
    """Big Shoulders 900 у кривих: рядок тексту як SVG path."""

    def __init__(self, path):
        font = TTFont(path)
        self.font = instantiateVariableFont(font, {"wght": 900, "opsz": 72})
        self.gs = self.font.getGlyphSet()
        self.cmap = self.font.getBestCmap()
        self.upm = self.font["head"].unitsPerEm
        self.cap = getattr(self.font["OS/2"], "sCapHeight", 0) or int(self.upm * 0.7)

    def run(self, text, x, baseline, size, fill, tracking=0.01):
        scale = size / self.upm
        parts, cursor = [], x
        for ch in text:
            name = self.cmap.get(ord(ch))
            if name is None:
                continue
            pen = SVGPathPen(self.gs)
            tp = TransformPen(pen, (scale, 0, 0, -scale, cursor, baseline))
            self.gs[name].draw(tp)
            d = pen.getCommands()
            if d:
                parts.append(f'<path d="{d}" fill="{fill}"/>')
            cursor += self.gs[name].width * scale + tracking * size
        return "".join(parts), cursor - tracking * size

    def width(self, text, size, tracking=0.01):
        return self.run(text, 0, 0, size, "none", tracking)[1]


def wordmark_svg(t, ink, accent, dot, with_mark=True, height=120):
    # Висота знака = висота великих літер x 1.5; текст по центру знака.
    size = height / 1.0
    cap = t.cap * size / t.upm
    mark_h = cap * 1.55
    pad = height * 0.12
    x = pad
    body = ""
    if with_mark:
        s = mark_h / 200
        body += f'<g transform="translate({x + mark_h / 2:.2f} {height / 2:.2f}) scale({s:.4f})">{mark_group(ink, dot, "small" if mark_h < 60 else "full")}</g>'
        x += mark_h + cap * 0.45
    baseline = height / 2 + cap / 2
    for word, fill in (("NEXT", ink), ("CRYPTO", accent), ("JOB", ink)):
        paths, x = t.run(word, x, baseline, size, fill)
        body += paths
        x += 0.01 * size
    return svg(round(x + pad), round(height), body), round(x + pad), round(height)


def stacked_svg(t, ink, accent, dot, width=600):
    words = [("NEXT", ink), ("CRYPTO", accent), ("JOB", ink)]
    # Кегль підбираємо так, щоб назва займала 86% ширини.
    unit = sum(t.width(w, 100) for w, _ in words) + 0.02 * 100
    size = width * 0.86 / unit * 100
    cap = t.cap * size / t.upm
    mark = width * 0.42
    total = sum(t.width(w, size) for w, _ in words) + 0.02 * size
    x = (width - total) / 2
    top = width * 0.06
    body = f'<g transform="translate({width / 2:.2f} {top + mark / 2:.2f}) scale({mark / 200:.4f})">{mark_group(ink, dot)}</g>'
    baseline = top + mark + width * 0.08 + cap
    for w, fill in words:
        paths, x = t.run(w, x, baseline, size, fill)
        body += paths
        x += 0.01 * size
    h = baseline + width * 0.06
    return svg(width, round(h), body), width, round(h)


def og_svg(t, w=1200, h=630):
    size = 118
    cap = t.cap * size / t.upm
    body = f'<rect width="{w}" height="{h}" fill="{GROUND}"/>'
    body += f'<g transform="translate({w - 250} {h / 2}) scale(1.9)" opacity="1">{mark_group(INK, ACCENT)}</g>'
    lines = ["RATED ON", "WHAT YOU", "SHIPPED."]
    y = 150 + cap
    for line in lines:
        paths, _ = t.run(line, 80, y, size, INK)
        body += paths
        y += size * 0.9
    wm, _ = t.run("NEXT", 80, h - 70, 40, INK)
    body += wm
    x = 80 + t.width("NEXT", 40) + 0.4
    p2, x = t.run("CRYPTO", x + 0.4, h - 70, 40, ACCENT)
    p3, _ = t.run("JOB", x + 0.8, h - 70, 40, INK)
    body += p2 + p3
    return svg(w, h, body)


def x_header_svg(t, w=1500, h=500):
    body = f'<rect width="{w}" height="{h}" fill="{NAVY}"/>'
    body += f'<g transform="translate({w - 260} {h / 2 + 20}) scale(3.2)" opacity="0.9">{seal_paths("#2b3a55", "full")}</g>'
    body += f'<g transform="translate({w - 260} {h / 2 + 20}) scale(1.35)">{mark_group(INK_D, ACCENT_D)}</g>'
    size = 96
    cap = t.cap * size / t.upm
    y = h / 2 + cap / 2
    x = 120
    for word, fill in (("NEXT", INK_D), ("CRYPTO", ACCENT_D), ("JOB", INK_D)):
        paths, x = t.run(word, x, y, size, fill)
        body += paths
        x += 0.01 * size
    tag, _ = t.run("RATED ON WHAT YOU SHIPPED.", 122, y + 64, 34, "#a8b3c4", 0.03)
    return svg(w, h, body + tag)


def png(svg_text, out_png, w, h):
    with tempfile.TemporaryDirectory() as tmp:
        html = os.path.join(tmp, "a.html")
        with open(html, "w") as f:
            f.write(
                "<!doctype html><html><head><style>html,body{margin:0;background:transparent}"
                f"svg{{display:block;width:{w}px;height:{h}px}}</style></head><body>{svg_text}</body></html>"
            )
        subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--default-background-color=00000000", f"--window-size={w},{h}",
             f"--screenshot={out_png}", f"file://{html}"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )


def main():
    font_path, out = sys.argv[1], sys.argv[2]
    t = Type(font_path)
    S, P = os.path.join(out, "svg"), os.path.join(out, "png")
    for d in (S, P, os.path.join(out, "favicon"), os.path.join(out, "social")):
        os.makedirs(d, exist_ok=True)

    files = {
        "mark.svg": mark_svg(INK, ACCENT),
        "mark-on-dark.svg": mark_svg(INK_D, ACCENT_D),
        "mark-black.svg": mark_svg("#000000", "#000000"),
        "mark-white.svg": mark_svg("#ffffff", "#ffffff"),
        "mark-small.svg": mark_svg(INK, ACCENT, "small"),
        "mark-tiny.svg": mark_svg(INK, ACCENT, "tiny"),
        "avatar.svg": avatar_svg(INK, ACCENT, PAPER),
        "avatar-dark.svg": avatar_svg(INK_D, ACCENT_D, NAVY),
    }
    wm = {
        "wordmark.svg": wordmark_svg(t, INK, ACCENT, ACCENT),
        "wordmark-on-dark.svg": wordmark_svg(t, INK_D, ACCENT_D, ACCENT_D),
        "wordmark-black.svg": wordmark_svg(t, "#000000", "#000000", "#000000"),
        "wordmark-white.svg": wordmark_svg(t, "#ffffff", "#ffffff", "#ffffff"),
        "wordmark-text-only.svg": wordmark_svg(t, INK, ACCENT, ACCENT, with_mark=False),
        "logo-stacked.svg": stacked_svg(t, INK, ACCENT, ACCENT),
        "logo-stacked-on-dark.svg": stacked_svg(t, INK_D, ACCENT_D, ACCENT_D),
    }
    for name, text in files.items():
        open(os.path.join(S, name), "w").write(text)
    for name, (text, _, _) in wm.items():
        open(os.path.join(S, name), "w").write(text)

    # PNG: знак, аватари, логотипи.
    png(files["mark.svg"], os.path.join(P, "mark-1024.png"), 1024, 1024)
    png(files["mark.svg"], os.path.join(P, "mark-512.png"), 512, 512)
    png(files["mark-on-dark.svg"], os.path.join(P, "mark-on-dark-1024.png"), 1024, 1024)
    png(files["avatar.svg"], os.path.join(P, "avatar-1024.png"), 1024, 1024)
    png(files["avatar.svg"], os.path.join(P, "avatar-512.png"), 512, 512)
    png(files["avatar-dark.svg"], os.path.join(P, "avatar-dark-1024.png"), 1024, 1024)
    for name in ("wordmark.svg", "wordmark-on-dark.svg", "logo-stacked.svg"):
        text, w, h = wm[name]
        base = name[:-4]
        png(text, os.path.join(P, f"{base}.png"), w, h)
        png(text.replace(f'width="{w}" height="{h}"', f'width="{w * 2}" height="{h * 2}"'),
            os.path.join(P, f"{base}@2x.png"), w * 2, h * 2)

    # Іконки сайту: коло паперу під знаком, щоб знак читався і на темних вкладках.
    F = os.path.join(out, "favicon")
    fav_small = mark_svg(INK, ACCENT, "small", circle_bg=PAPER)
    fav_tiny = mark_svg(INK, ACCENT, "tiny", circle_bg=PAPER)
    open(os.path.join(F, "icon.svg"), "w").write(fav_small)
    png(fav_tiny, os.path.join(F, "favicon-16.png"), 16, 16)
    png(fav_small, os.path.join(F, "favicon-32.png"), 32, 32)
    png(fav_small, os.path.join(F, "favicon-48.png"), 48, 48)
    apple = mark_svg(INK, ACCENT, "full", bg=PAPER).replace("<g", "<g")
    apple_body = f'<rect x="-100" y="-100" width="200" height="200" fill="{PAPER}"/><g transform="scale(0.78)">{mark_group(INK, ACCENT)}</g>'
    png(svg(180, 180, apple_body, "-100 -100 200 200"), os.path.join(F, "apple-touch-icon.png"), 180, 180)
    png(svg(192, 192, apple_body, "-100 -100 200 200"), os.path.join(F, "icon-192.png"), 192, 192)
    png(svg(512, 512, apple_body, "-100 -100 200 200"), os.path.join(F, "icon-512.png"), 512, 512)
    from PIL import Image
    imgs = [Image.open(os.path.join(F, f"favicon-{s}.png")).convert("RGBA") for s in (16, 32, 48)]
    imgs[2].save(os.path.join(F, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)], append_images=imgs[:2])

    # Соцмережі: картинка посилання за замовчуванням і шапка X.
    O = os.path.join(out, "social")
    og = og_svg(t)
    open(os.path.join(O, "og-default.svg"), "w").write(og)
    png(og, os.path.join(O, "og-default-1200x630.png"), 1200, 630)
    xh = x_header_svg(t)
    open(os.path.join(O, "x-header.svg"), "w").write(xh)
    png(xh, os.path.join(O, "x-header-1500x500.png"), 1500, 500)
    png(files["avatar.svg"], os.path.join(O, "telegram-bot-avatar-640.png"), 640, 640)
    png(files["avatar.svg"], os.path.join(O, "x-avatar-400.png"), 400, 400)
    print("done:", out)


if __name__ == "__main__":
    main()
