"""生成小账本 App 图标：粉色圆角底 + 白色 ¥ 符号。

纯几何绘制，不依赖系统字体 —— 在 Windows / Linux / macOS 上输出一致，
所以 CI 里可以现场生成，仓库无需提交二进制图片。
"""
from PIL import Image, ImageDraw

SS = 4  # 超采样倍数，最后缩小以获得平滑边缘


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
    """在透明图层中心画白色 ¥。"""
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

    # 左侧斜线 + 竖线（一条折线，joint 让拐角圆滑）
    d.line([(cx - half, top_y), (cx, joint_y), (cx, bottom_y)], fill="white", width=w, joint="curve")
    # 右侧斜线
    d.line([(cx + half, top_y), (cx, joint_y)], fill="white", width=w, joint="curve")

    # 圆头收口
    for x, y in ((cx - half, top_y), (cx + half, top_y), (cx, bottom_y)):
        d.ellipse([x - r, y - r, x + r, y + r], fill="white")

    # 两道横杠
    bar_half = s * 0.185
    for by in (cy + s * 0.035, cy + s * 0.135):
        d.rounded_rectangle(
            [cx - bar_half, by - r, cx + bar_half, by + r],
            radius=r, fill="white",
        )

    return layer


def build(size, path, *, maskable=False, rounded=True):
    big = size * SS
    bg = gradient(big, (255, 154, 172), (232, 93, 124)).convert("RGBA")

    if rounded:
        canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        canvas.paste(bg, (0, 0), rounded_mask(big, int(big * 0.235)))
    else:
        canvas = bg

    canvas.alpha_composite(yen(big, scale=0.56 if maskable else 0.70))
    canvas.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)
    print("saved", path, size)


if __name__ == "__main__":
    import os
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    out = os.path.join(root, "public", "icons")
    os.makedirs(out, exist_ok=True)
    build(192, os.path.join(out, "icon-192.png"))
    build(512, os.path.join(out, "icon-512.png"))
    build(512, os.path.join(out, "icon-maskable-512.png"), maskable=True, rounded=False)
    build(180, os.path.join(out, "apple-touch-icon.png"), rounded=False)

    # 原生启动图标素材（交给 @capacitor/assets 生成各尺寸）
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)

    # 整块图标：直角满幅，工具会自动按平台裁圆角
    build(1024, os.path.join(assets, "icon-only.png"), rounded=False)

    # 自适应图标的前景与背景（安卓 8.0+）
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    fg.alpha_composite(yen(1024, scale=0.52))
    fg.save(os.path.join(assets, "icon-foreground.png"), "PNG", optimize=True)

    bg = gradient(1024, (255, 154, 172), (232, 93, 124)).convert("RGBA")
    bg.save(os.path.join(assets, "icon-background.png"), "PNG", optimize=True)
    print("saved assets/icon-*.png 1024")
