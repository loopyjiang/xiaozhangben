"""
生成桌宠用的表情帧。

现有素材是 9 张独立的 Loopy 姿势图，没法拿来做逐帧动画，
所以这里只从 ``01-smile.webp`` 派生出两张"闭眼"帧：

  loopy/blink.webp  —— 眨眼用，眼睛是一条向下弯的弧线
  loopy/happy.webp  —— 记完账/被摸头时的开心表情，弧线更弯一点

做法：用眼睛周围的皮肤色补掉眼珠（先填色再高斯模糊，接缝看不出来），
再画一条和 06-music 里同款的笑眼弧线。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "loopy" / "01-smile.webp"
OUT_DIR = ROOT / "public" / "loopy"

ARC_W = 11.0         # 笑眼弧线宽度
ARC_H = 7.4          # 笑眼弧线高度
ARC_W_PX = 3.0       # 线宽
INK = (28, 18, 24)


def find_eyes(im):
    """在脸部上半区找两块最小的深色连通块，返回它们的中心。"""
    px = im.convert("RGBA").load()
    dark = set()
    for y in range(70, 132):
        for x in range(60, 200):
            r, g, b, a = px[x, y]
            if a > 200 and (r * 0.3 + g * 0.6 + b * 0.1) < 80:
                dark.add((x, y))

    seen = set()
    blobs = []
    for p in dark:
        if p in seen:
            continue
        stack = [p]
        seen.add(p)
        pts = []
        while stack:
            cx, cy = stack.pop()
            pts.append((cx, cy))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    q = (cx + dx, cy + dy)
                    if q in dark and q not in seen:
                        seen.add(q)
                        stack.append(q)
        if 60 <= len(pts) <= 300:
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            cy = sum(ys) / len(ys)
            if cy < 125:  # 鼻子在 134 附近，排除掉
                blobs.append(((sum(xs) / len(xs), cy), len(pts)))

    blobs.sort(key=lambda b: b[0][1])  # 眼睛在鼻子上面，取最上面两颗
    centers = sorted([b[0] for b in blobs[:2]], key=lambda c: c[0])
    if len(centers) != 2:
        raise SystemExit(f"眼睛识别失败：{centers}")
    return centers


def skin_color(im, cx, cy, r0=8.0, r1=11.5):
    """取眼睛外圈环形区域的皮肤平均色，眼珠本身不参与计算。"""
    px = im.load()
    total = [0.0, 0.0, 0.0]
    n = 0
    for y in range(int(cy - r1), int(cy + r1) + 1):
        for x in range(int(cx - r1), int(cx + r1) + 1):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if not (r0 <= d <= r1):
                continue
            r, g, b, a = px[x, y]
            if a < 200 or (r * 0.3 + g * 0.6 + b * 0.1) < 110:
                continue
            total[0] += r
            total[1] += g
            total[2] += b
            n += 1
    if not n:
        return (238, 140, 160)
    return tuple(int(v / n) for v in total)


def cover_eye(im, cx, cy):
    """用一个羽化的圆把眼珠补掉：先填周围平均肤色，再局部模糊抹平接缝。"""
    S = 4
    size = im.width * S
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = 8.6
    d.ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], fill=255)
    mask = mask.resize(im.size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(1.6))

    color = skin_color(im, cx, cy)
    flat = Image.new("RGBA", im.size, color + (255,))
    im.paste(flat, (0, 0), mask)

    # 只在这块区域做一次模糊，让填色和周围渐变接上
    blurred = im.filter(ImageFilter.GaussianBlur(2.4))
    im.paste(blurred, (0, 0), mask)


def draw_happy_eye(im, cx, cy, openness=1.0):
    """画一条 ∩ 形的笑眼（二次贝塞尔 + 圆头，比 PIL 的 arc 更有弧度）。"""
    S = 4
    layer = Image.new("RGBA", (im.width * S, im.height * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    half = (ARC_W * openness) / 2
    rise = ARC_H * openness
    x0, y0 = cx - half, cy + rise * 0.42
    x1, y1 = cx, cy - rise * 0.58
    x2, y2 = cx + half, cy + rise * 0.42

    pts = []
    for i in range(41):
        t = i / 40
        x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * x1 + t ** 2 * x2
        y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * y1 + t ** 2 * y2
        pts.append((x * S, y * S))

    r = ARC_W_PX * S / 2
    for x, y in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=INK + (255,))

    layer = layer.resize(im.size, Image.LANCZOS)
    im.alpha_composite(layer.filter(ImageFilter.GaussianBlur(0.35)))


def build(suffix, openness):
    im = Image.open(SRC).convert("RGBA")
    centers = find_eyes(im)
    for cx, cy in centers:
        cover_eye(im, cx, cy)
        draw_happy_eye(im, cx, cy + 0.6, openness)

    out = OUT_DIR / f"{suffix}.webp"
    im.save(out, "WEBP", quality=90, method=6)
    print(f"{out.name}: {out.stat().st_size // 1024} KB, eyes={[(round(x, 1), round(y, 1)) for x, y in centers]}")


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    build("blink", openness=1.0)
    build("happy", openness=1.08)
