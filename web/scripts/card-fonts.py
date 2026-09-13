# Готує шрифти для картинок картки (next/og). Запуск із каталогу web/:
#
#   python3 -m venv /tmp/ncj-fonts && /tmp/ncj-fonts/bin/pip install fonttools
#   /tmp/ncj-fonts/bin/python scripts/card-fonts.py
#
# Satori читає лише статичні TTF/OTF/WOFF і не бачить шрифтів next/font, а Worker
# не має файлової системи. Тому беремо змінні TTF з github.com/google/fonts (OFL),
# робимо статичні копії (fontTools varLib.instancer), урізаємо до латиниці й
# кладемо в src/lib/card/fonts/*.ts як base64.
#
# Big Shoulders і Familjen Grotesk не мають кирилиці, а ім'я на картці може бути
# кирилицею (display-name.ts). Тому поруч лежить кирилична частина IBM Plex Sans
# 600, вирізана з попереднього plex-sans-600.ts: Satori бере її для літер, яких
# немає в першому шрифті. Тест fonts.test.ts перевіряє покриття.
#
# Ліцензія: усі три під SIL Open Font License 1.1, текст у src/lib/card/fonts/OFL.txt.
import base64
import io
import pathlib
import re
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "lib" / "card" / "fonts"
RAW = "https://github.com/google/fonts/raw/main/ofl"


def cps(*ranges):
    out = []
    for a, b in ranges:
        out.extend(range(a, b + 1))
    return out


# ASCII, Latin-1 і Latin Extended-A (імена), плюс знаки, які ставить сама картка.
LATIN = cps((0x20, 0x7E), (0xA0, 0x17F)) + [0x2013, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x00B7]
# Кирилиця і чотири латинські літери, яких немає в Big Shoulders (Ĳ ĳ ŉ ſ).
CYRILLIC = cps((0x400, 0x45F), (0x490, 0x491)) + [0x20, 0x132, 0x133, 0x149, 0x17F]

FONTS = [
    {
        "file": "big-shoulders-800",
        "src": f"{RAW}/bigshoulders/BigShoulders%5Bopsz,wght%5D.ttf",
        "axes": {"wght": 800, "opsz": 72},
        "unicodes": LATIN,
        "label": "Big Shoulders 800 (opsz 72)",
    },
    {
        "file": "familjen-grotesk-500",
        "src": f"{RAW}/familjengrotesk/FamiljenGrotesk%5Bwght%5D.ttf",
        "axes": {"wght": 500},
        "unicodes": LATIN,
        "label": "Familjen Grotesk 500",
    },
]


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as res:  # noqa: S310 (фіксовані адреси вище)
        return res.read()


def cut(font: TTFont, unicodes) -> bytes:
    opts = subset.Options()
    opts.layout_features = ["kern", "liga", "tnum", "lnum"]
    opts.hinting = False
    opts.desubroutinize = True
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def rename(font: TTFont, family: str) -> None:
    """Нова назва в таблиці name: підмножина є зміненою версією за OFL."""
    ps = family.replace(" ", "")
    for rec in font["name"].names:
        if rec.nameID in (1, 16):
            rec.string = family
        elif rec.nameID == 4:
            rec.string = f"{family} SemiBold"
        elif rec.nameID == 6:
            rec.string = f"{ps}-SemiBold"
        elif rec.nameID == 3:
            rec.string = f"{ps}-SemiBold;subset"


def write(file: str, label: str, data: bytes) -> None:
    body = (
        f"// Згенеровано scripts/card-fonts.py: {label}, статична підмножина TTF, SIL OFL 1.1 (див. OFL.txt).\n"
        "// Не редагувати вручну.\n"
        f'const ttfBase64 = "{base64.b64encode(data).decode()}";\n'
        "export default ttfBase64;\n"
    )
    (OUT / f"{file}.ts").write_text(body)
    print(f"{file}: {len(data)} bytes TTF")


def main() -> None:
    for spec in FONTS:
        var = TTFont(io.BytesIO(fetch(spec["src"])))
        static = instancer.instantiateVariableFont(var, spec["axes"])
        write(spec["file"], spec["label"], cut(static, spec["unicodes"]))

    # Кирилиця для імен: з наявного plex-sans-600.ts (підмножина Google Fonts API).
    plex_ts = OUT / "plex-sans-600.ts"
    if plex_ts.exists():
        b64 = re.search(r'"([A-Za-z0-9+/=]+)"', plex_ts.read_text()).group(1)
        plex = TTFont(io.BytesIO(base64.b64decode(b64)))
        # «Plex» зарезервована назва (OFL), тож змінена копія зветься інакше.
        rename(plex, "NCJ Card Cyrillic")
        write("ncj-cyrillic-600", "NCJ Card Cyrillic (кирилиця IBM Plex Sans 600)", cut(plex, CYRILLIC))
    elif not (OUT / "ncj-cyrillic-600.ts").exists():
        sys.exit("plex-sans-600.ts is gone and ncj-cyrillic-600.ts is missing: restore plex-sans-600.ts from git (commit before the redesign).")
    # Файл уже є (plex-sans-600.ts видалено після першого запуску): лишаємо як є.


if __name__ == "__main__":
    main()
