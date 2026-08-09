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

def base_bg():
    m = int(M * 0.045)
    r = int(M * 0.22)
    img = make_gradient(M, [(0.0, hexc('#4338CA')), (0.5, hexc('#7C3AED')), (1.0, hexc('#0EA5E9'))])
    img = apply_mask(img, rounded_mask(M, (m, m, M - m, M - m), r))
    return img, m, r

def add_highlight(img):
    hl = Image.new('RGBA', (M, M), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.ellipse([int(M*0.13), int(M*0.08), int(M*0.63), int(M*0.45)], fill=(255, 255, 255, 48))
    hl = hl.filter(ImageFilter.GaussianBlur(int(M * 0.05)))
    return Image.alpha_composite(img, hl)

def add_ring(img, m, r):
    ring = Image.new('RGBA', (M, M), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle([m + int(M*0.012), m + int(M*0.012), M - m - int(M*0.012), M - m - int(M*0.012)],
                                           radius=r, outline=(255, 255, 255, 50), width=int(M * 0.014))
    ring = apply_mask(ring, rounded_mask(M, (m, m, M - m, M - m), r))
    return Image.alpha_composite(img, ring)

def text_layer(text, font, cy, fill, stops=None):
    mask = Image.new('L', (M, M), 0)
    d = ImageDraw.Draw(mask)
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]; h = bbox[3] - bbox[1]
    d.text((M / 2 - w / 2 - bbox[0], cy - h / 2 - bbox[1]), text, font=font, fill=255)
    if stops is not None:
        grad = make_gradient(M, stops)
        grad.putalpha(mask)
        return grad
    lay = Image.new('RGBA', (M, M), fill + (0,))
    lay.putalpha(mask)
    return lay

def cyan_bar(cx, by, bw, bh, color=(34, 211, 238, 255)):
    bar = Image.new('RGBA', (M, M), (0, 0, 0, 0))
    ImageDraw.Draw(bar).rounded_rectangle([cx - bw / 2, by, cx + bw / 2, by + bh], radius=bh // 2, fill=color)
    return bar

def variant_minimal():
    img, m, r = base_bg()
    img = add_highlight(img)
    font = ImageFont.truetype(FONT_PATH, int(M * 0.34))
    img = Image.alpha_composite(img, text_layer('#', font, int(M * 0.43), (255, 255, 255)))
    img = Image.alpha_composite(img, cyan_bar(M / 2, int(M * 0.63), int(M * 0.19), int(M * 0.024)))
    return add_ring(img, m, r)

def variant_paper():
    img, m, r = base_bg()
    img = add_highlight(img)
    x0, y0, x2, y3 = int(M*0.19), int(M*0.17), int(M*0.80), int(M*0.79)
    pr = int(M * 0.045)
    fold = int(M * 0.16)
    sh = Image.new('RGBA', (M, M), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([x0, y0 + int(M*0.02), x2, y3 + int(M*0.025)], radius=pr, fill=(30, 27, 75, 150))
    sh = sh.filter(ImageFilter.GaussianBlur(int(M * 0.03)))
    img = Image.alpha_composite(img, sh)
    paper = Image.new('RGBA', (M, M), (0, 0, 0, 0))
    pd = ImageDraw.Draw(paper)
    pd.rounded_rectangle([x0, y0, x2, y3], radius=pr, fill=(255, 255, 255, 255))
    pd.polygon([(x2, y3), (x2, y3 - fold), (x2 - fold, y3)], fill=(226, 232, 240, 255))
    pd.line([(x2 - fold, y3), (x2, y3 - fold)], fill=(203, 213, 225, 255), width=int(M * 0.006))
    img = Image.alpha_composite(img, paper)
    font = ImageFont.truetype(FONT_PATH, int(M * 0.30))
    gl = text_layer('#', font, int(M * 0.41), None, [(0.0, hexc('#4F46E5')), (1.0, hexc('#7C3AED'))])
    img = Image.alpha_composite(img, gl)
    img = Image.alpha_composite(img, cyan_bar(M / 2, int(M * 0.70), int(M * 0.17), int(M * 0.02), (6, 182, 212, 255)))
    return add_ring(img, m, r)

a = variant_minimal().resize((512, 512), Image.LANCZOS)
a.save(BASE + r'\icon-preview-A.png')
b = variant_paper().resize((512, 512), Image.LANCZOS)
b.save(BASE + r'\icon-preview-B.png')
print('saved A and B')
