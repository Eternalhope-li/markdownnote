# -*- coding: utf-8 -*-
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = r'E:\MarkdownNote'
M = 2048
FONT_PATH = r'C:\Windows\Fonts\seguibl.ttf'

def hexc(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def make_gradient(size, stops):
    yy, xx = np.mgrid[0:size, 0:size]
    t = (xx + yy) / (2.0 * (size - 1))
    cols = np.zeros((size, size, 3), dtype=np.float32)
    for i in range(len(stops) - 1):
        p0, c0 = stops[i]
        p1, c1 = stops[i + 1]
        m = (t >= p0) & (t <= p1)
        tt = np.clip((t[m] - p0) / max(p1 - p0, 1e-9), 0, 1)
        c0a = np.array(c0, dtype=np.float32)
        c1a = np.array(c1, dtype=np.float32)
        cols[m] = c0a[None, :] + tt[:, None] * (c1a - c0a)[None, :]
    arr = np.dstack([cols, np.full((size, size), 255, dtype=np.float32)])
    return Image.fromarray(arr.astype(np.uint8), 'RGBA')

def rounded_mask(size, xy, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(xy, radius=radius, fill=255)
    return m

def apply_mask(img, mask):
    img.putalpha(Image.composite(img.split()[3], Image.new('L', img.size, 0), mask))
    return img

def text_mask(text, font, cy):
    mask = Image.new('L', (M, M), 0)
    d = ImageDraw.Draw(mask)
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]; h = bbox[3] - bbox[1]
    d.text((M / 2 - w / 2 - bbox[0], cy - h / 2 - bbox[1]), text, font=font, fill=255)
    return mask

def final_icon():
    m = int(M * 0.045)
    r = int(M * 0.22)
    # background rounded square, diagonal gradient indigo -> violet -> sky
    img = make_gradient(M, [(0.0, hexc('#3730A3')), (0.42, hexc('#6D28D9')), (0.78, hexc('#2563EB')), (1.0, hexc('#0EA5E9'))])
    img = apply_mask(img, rounded_mask(M, (m, m, M - m, M - m), r))
    # top-left glass highlight
    hl = Image.new('RGBA', (M, M), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.ellipse([int(M*0.13), int(M*0.08), int(M*0.63), int(M*0.45)], fill=(255, 255, 255, 52))
    hl = hl.filter(ImageFilter.GaussianBlur(int(M * 0.05)))
    img = Image.alpha_composite(img, hl)
    # soft bottom-right cyan glow
    glow = Image.new('RGBA', (M, M), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([int(M*0.55), int(M*0.60), int(M*1.05), int(M*1.10)], fill=(34, 211, 238, 60))
    glow = glow.filter(ImageFilter.GaussianBlur(int(M * 0.08)))
    img = Image.alpha_composite(img, glow)
    # white '#' glyph
    font = ImageFont.truetype(FONT_PATH, int(M * 0.36))
    white = Image.new('RGBA', (M, M), (255, 255, 255, 255))
    white.putalpha(text_mask('#', font, int(M * 0.42)))
    img = Image.alpha_composite(img, white)
    # cyan underline bar
    bar = Image.new('RGBA', (M, M), (0, 0, 0, 0))
    bw = int(M * 0.20); bh = int(M * 0.024)
    by = int(M * 0.63)
    ImageDraw.Draw(bar).rounded_rectangle([M / 2 - bw / 2, by, M / 2 + bw / 2, by + bh], radius=bh // 2, fill=(34, 211, 238, 255))
    img = Image.alpha_composite(img, bar)
    # thin inner ring
    ring = Image.new('RGBA', (M, M), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle([m + int(M*0.012), m + int(M*0.012), M - m - int(M*0.012), M - m - int(M*0.012)],
                                           radius=r, outline=(255, 255, 255, 56), width=int(M * 0.014))
    ring = apply_mask(ring, rounded_mask(M, (m, m, M - m, M - m), r))
    img = Image.alpha_composite(img, ring)
    return img

img = final_icon()
build = BASE + r'\build'
img512 = img.resize((512, 512), Image.LANCZOS)
img512.save(build + r'\icon.png')
img256 = img.resize((256, 256), Image.LANCZOS)
img256.save(BASE + r'\dist\icon.png')
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img256.save(build + r'\icon.ico', sizes=sizes)
print('done: build/icon.png, build/icon.ico, dist/icon.png')
