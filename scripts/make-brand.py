#!/usr/bin/env python3
"""Compose Telegram avatar + banner from the official King Kong Lab logo."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / 'public' / 'brand'
LOGO = BRAND / 'logo-source.png'
FONT = BRAND / 'Syne-Bold.ttf'
FONT_UA = Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
if not FONT_UA.exists():
    FONT_UA = Path('/System/Library/Fonts/Supplemental/Arial Bold.ttf')
OUT_AVA = BRAND / 'avatar.png'
OUT_BANNER = BRAND / 'banner.png'
PUBLIC_LOGO = ROOT / 'public' / 'img' / 'logo.png'

BLUE = (39, 0, 238)
BLUE2 = (74, 34, 255)
INK = (17, 17, 24)
PAPER = (244, 242, 250)


def load_font(size, ua=False):
    return ImageFont.truetype(str(FONT_UA if ua else FONT), size)


def logo_transparent():
    logo = Image.open(LOGO).convert('RGBA')
    px = logo.load()
    w, h = logo.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r > 245 and g > 245 and b > 245:
                px[x, y] = (r, g, b, 0)
    return logo


def glow(size, color, radius):
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = size[0] // 2, size[1] // 2
    d.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=(*color, 90))
    return layer.filter(ImageFilter.GaussianBlur(radius // 3))


def paper_bg(size):
    img = Image.new('RGBA', size, (255, 255, 255, 255))
    overlay = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    w, h = size
    d.rectangle((0, 0, w, h), fill=(251, 249, 255, 255))
    img = Image.alpha_composite(img, overlay)
    img = Image.alpha_composite(img, glow(size, BLUE, int(min(w, h) * 0.42)))
    pink = glow(size, (212, 0, 255), int(min(w, h) * 0.2))
    img = Image.alpha_composite(img, pink)
    return img


def fit_logo(box):
    logo = logo_transparent()
    logo.thumbnail((box, box), Image.Resampling.LANCZOS)
    return logo


def make_avatar():
    size = 640
    img = paper_bg((size, size))
    logo = fit_logo(430)
    x = (size - logo.width) // 2
    y = (size - logo.height) // 2 + 8
    img.paste(logo, (x, y), logo)
    img.convert('RGB').save(OUT_AVA, 'PNG', optimize=True)
    img.convert('RGB').save(PUBLIC_LOGO, 'PNG', optimize=True)
    print('avatar', OUT_AVA, img.size)


def make_banner():
    w, h = 1280, 720
    img = paper_bg((w, h))
    logo = fit_logo(420)
    img.paste(logo, (90, (h - logo.height) // 2), logo)

    d = ImageDraw.Draw(img)
    title = load_font(70)
    sub = load_font(40, ua=True)
    meta = load_font(22, ua=True)
    tx = 540
    ty = 228
    d.text((tx, ty), 'KING KONG LAB', font=title, fill=INK)
    d.text((tx, ty + 94), 'Бухгалтерія', font=sub, fill=BLUE)
    d.text((tx, ty + 164), 'каса  ·  проєкти  ·  P&L  ·  команда', font=meta, fill=(107, 110, 128))
    img.convert('RGB').save(OUT_BANNER, 'PNG', optimize=True)
    print('banner', OUT_BANNER, img.size)


if __name__ == '__main__':
    make_avatar()
    make_banner()
