"""生成 App 图标：粉色渐变底 + Loopy 头部。

头部素材来自 tools/loopy-head.webp（由 tools/split_loopy.py 从精灵图裁出）。
素材缺失时退回旧的「粉底 + 白色 ¥」图标，保证任何环境都能出图。
"""
import os
from PIL import Image, ImageDraw, ImageFilter

SS = 4  # 超采样倍数，最后缩小以获得平滑边缘

LOOPY_PINK_TOP = (255, 226, 238)
LOOPY_PINK_BOTTOM = (243, 168, 197)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
HEAD_PATH = os.path.join(ROOT, "tools", "loopy-head.webp")


def gradient(size, top, bottom):
    img = Image.new("RGB", (1, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img.resize((size, size), Image.BILINEAR)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def yen(size, scale=0.70):
    """旧的 ¥ 图标（素材缺失时兜底）。"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    s = size * scale
    cx = cy = size / 2
    w = max(2, int(s * 0.085))
    r = w / 2

    half = s * 0.20
    top_y = cy - s * 0.30
    joint_y = cy - s * 0.02
    bottom_y = cy + s * 0.28

    d.line([(cx - half, top_y), (cx, joint_y), (cx, bottom_y)], fill="white", width=w, joint="curve")
    d.line([(cx + half, top_y), (cx, joint_y)], fill="white", width=w, joint="curve")

    for x, y in ((cx - half, top_y), (cx + half, top_y), (cx, bottom_y)):
        d.ellipse([x - r, y - r, x + r, y + r], fill="white")

    bar_half = s * 0.185
    for by in (cy + s * 0.035, cy + s * 0.135):
        d.rounded_rectangle([cx - bar_half, by - r, cx + bar_half, by + r], radius=r, fill="white")

    return layer


def loopy_head(size, scale):
    """把头部素材等比缩放到 size*scale，并加一点柔和投影。"""
    head = Image.open(HEAD_PATH).convert("RGBA")
    side = int(size * scale)
    head = head.resize((side, side), Image.LANCZOS)

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.paste((176, 96, 126, 90), ((size - side) // 2, (size - side) // 2 + int(size * 0.02)), head)
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.018))

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.alpha_composite(shadow)
    layer.alpha_composite(head, ((size - side) // 2, (size - side) // 2))
    return layer


def build(size, path, *, maskable=False, rounded=True, head=True):
    big = size * SS
    bg = gradient(big, LOOPY_PINK_TOP, LOOPY_PINK_BOTTOM).convert("RGBA")

    if rounded:
        canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        canvas.paste(bg, (0, 0), rounded_mask(big, int(big * 0.235)))
    else:
        canvas = bg

    if head and os.path.exists(HEAD_PATH):
        # 安卓自适应图标要留安全区，主体缩到 62%
        canvas.alpha_composite(loopy_head(big, 0.62 if maskable else 0.77))
    else:
        canvas.alpha_composite(yen(big, scale=0.56 if maskable else 0.70))

    canvas.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)
    print("saved", path, size)


if __name__ == "__main__":
    out = os.path.join(ROOT, "public", "icons")
    os.makedirs(out, exist_ok=True)
    build(192, os.path.join(out, "icon-192.png"))
    build(512, os.path.join(out, "icon-512.png"))
    build(512, os.path.join(out, "icon-maskable-512.png"), maskable=True, rounded=False)
    build(180, os.path.join(out, "apple-touch-icon.png"), rounded=False)

    # 原生启动图标素材（交给 @capacitor/assets 生成各尺寸）
    assets = os.path.join(ROOT, "assets")
    os.makedirs(assets, exist_ok=True)

    # 整块图标：直角满幅，工具会自动按平台裁圆角
    build(1024, os.path.join(assets, "icon-only.png"), rounded=False)

    # 自适应图标的前景与背景（安卓 8.0+）
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    if os.path.exists(HEAD_PATH):
        fg.alpha_composite(loopy_head(1024, 0.56))
    else:
        fg.alpha_composite(yen(1024, scale=0.52))
    fg.save(os.path.join(assets, "icon-foreground.png"), "PNG", optimize=True)

    bg = gradient(1024, LOOPY_PINK_TOP, LOOPY_PINK_BOTTOM).convert("RGBA")
    bg.save(os.path.join(assets, "icon-background.png"), "PNG", optimize=True)
    print("saved assets/icon-*.png 1024")
