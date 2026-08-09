import io, math, os, struct
from PIL import Image, ImageDraw

BASE = r"E:\MarkdownNote"
OUT_PNG = os.path.join(BASE, "build", "icon.png")
OUT_ICO = os.path.join(BASE, "build", "icon.ico")

C_TOP = (79, 70, 229)      # #4f46e5 indigo
C_BOT = (124, 58, 237)     # #7c3aed purple
C_WHITE = (255, 255, 255)
C_CYAN = (34, 211, 238)    # #22d3ee

# 每个目标尺寸的笔画宽度（px），小尺寸刻意加粗保证清晰
STROKES = {
    16: 3.0, 24: 3.6, 32: 4.6, 48: 6.2,
    64: 7.6, 128: 14.0, 256: 27.0, 512: 54.0,
}

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def render(size, stroke=None, with_glow=True):
    if stroke is None:
        stroke = STROKES.get(size, max(3.0, size * 0.11))
    ss = 4  # 超采样倍数
    S = size * ss
    st = stroke * ss
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角方块
    margin = max(1.0, size * 0.05) * ss
    r = max(3.0, size * 0.22) * ss
    box = [margin, margin, S - margin, S - margin]
    # 渐变背景（135 度：左上 -> 右下）
    steps = 96
    for i in range(steps):
        t0 = i / steps
        t1 = (i + 1) / steps
        # 沿对角方向插值
        c0 = lerp(C_TOP, C_BOT, t0)
        c1 = lerp(C_TOP, C_BOT, t1)
        y0 = margin + t0 * (S - 2 * margin)
        y1 = margin + t1 * (S - 2 * margin)
        d.line([(margin, y0), (S - margin, y1)], fill=c0, width=2 * ss)
    # 用圆角遮罩裁切
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(box, radius=r, fill=255)
    img.putalpha(Image.composite(img.split()[3], Image.new("L", (S, S), 0), mask))

    # 柔和左上高光（大尺寸才有，避免小尺寸发灰）
    if with_glow and size >= 48:
        glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        cx, cy = margin + (S - 2 * margin) * 0.30, margin + (S - 2 * margin) * 0.28
        rr = (S - 2 * margin) * 0.62
        for i in range(40, 0, -1):
            a = int(26 * (i / 40) ** 2)
            gd.ellipse([cx - rr * i / 40, cy - rr * i / 40, cx + rr * i / 40, cy + rr * i / 40], fill=(255, 255, 255, a))
        glow.putalpha(Image.composite(glow.split()[3], Image.new("L", (S, S), 0), mask))
        img = Image.alpha_composite(img, glow)

    # 井号：两条白色竖线 + 上白横线 + 下青色横线
    x1, x2 = 0.38, 0.62
    y1, y2 = 0.26, 0.74
    hx1, hx2 = 0.26, 0.74
    hy1, hy2 = 0.40, 0.60
    d = ImageDraw.Draw(img)
    d.line([(int(x1 * S), int(y1 * S)), (int(x1 * S), int(y2 * S))], fill=C_WHITE, width=int(st))
    d.line([(int(x2 * S), int(y1 * S)), (int(x2 * S), int(y2 * S))], fill=C_WHITE, width=int(st))
    d.line([(int(hx1 * S), int(hy1 * S)), (int(hx2 * S), int(hy1 * S))], fill=C_WHITE, width=int(st))
    d.line([(int(hx1 * S), int(hy2 * S)), (int(hx2 * S), int(hy2 * S))], fill=C_CYAN, width=int(st))

    # 圆角遮罩再次作用，避免笔画溢出方块
    img.putalpha(Image.composite(img.split()[3], Image.new("L", (S, S), 0), mask))
    return img.resize((size, size), Image.LANCZOS)

def pack_ico(pngs, path):
    """手工打包多帧 ICO（PNG 压缩帧，Vista+ 支持）"""
    count = len(pngs)
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    blobs = b""
    offset = 6 + 16 * count
    for w, h, png in pngs:
        data = png  # frames ??? bytes
        entries += struct.pack("<BBBBHHII", w if w < 256 else 0, h if h < 256 else 0, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    with open(path, "wb") as f:
        f.write(header + entries + blobs)

def main():
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = []
    for s in sizes:
        png = io.BytesIO()
        render(s).save(png, format="PNG")
        frames.append((s, s, png.getvalue()))
        print("rendered", s)
    pack_ico(frames, OUT_ICO)
    # 512 主图（PNG 形式给窗口/网页用）
    render(512).save(OUT_PNG, format="PNG")
    # 同步到 dist（npm run build 也会做，这里直接复制一份）
    import shutil
    shutil.copyfile(OUT_PNG, os.path.join(BASE, "dist", "icon.png"))
    print("icon.ico + icon.png written")

if __name__ == "__main__":
    main()
