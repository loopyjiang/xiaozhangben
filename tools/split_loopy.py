#!/usr/bin/env python3
"""把 Loopy 精灵图拆成界面要用的素材。

输入：一张 3x3 的 Loopy 表情图（透明底），默认从 LOOPY_SRC 环境变量读取。
输出：
  public/loopy/01..09-<name>.webp   九种姿态，界面里当分类图标和插图
  public/loopy/avatar.webp/.png     圆形头像（顶栏、我的页）
  tools/loopy-head.webp             1024px 头部素材，给 tools/gen_icons.py 画 App 图标

精灵图不在仓库里（版权与体积原因），需要时去最初的设计稿站下载
/loopy.png 再用本脚本处理，日常构建不依赖它。
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get("LOOPY_SRC", "loopy.png")
OUT = os.path.join(ROOT, "public", "loopy")
ASSETS = os.path.join(ROOT, "tools")
SIZE = 256
PAD = 0.08  # 内容四周留白比例

NAMES = [
    "smile",    # 微笑站立
    "eat",      # 厨师帽 + 饭碗
    "car",      # 小汽车
    "bag",      # 购物袋
    "home",     # 抱房子
    "music",    # 耳机
    "flower",   # 花
    "study",    # 眼镜 + 笔记本
    "gift",     # 礼物盒
]


def fit_square(img, size, pad=PAD):
    """按内容裁掉透明边，等比缩放后居中放进正方形画布。"""
    bbox = img.getchannel("A").point(lambda v: 255 if v > 12 else 0).getbbox()
    if bbox:
        img = img.crop(bbox)
    w, h = img.size
    side = int(max(w, h) * (1 + pad * 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas.resize((size, size), Image.LANCZOS)


def head_crop(img, ratio=0.74, top_ratio=0.03):
    """从全身像里切出头部正方形区域。"""
    w, h = img.size
    side = int(w * ratio)
    left = (w - side) // 2
    top = int(h * top_ratio)
    return img.crop((left, top, left + side, top + side))


def main():
    im = Image.open(SRC).convert("RGBA")
    W, H = im.size
    cw, ch = W / 3, H / 3
    os.makedirs(OUT, exist_ok=True)
    print(f"源图 {W}x{H}，单格 {cw:.0f}x{ch:.0f}")

    first = None
    for i, name in enumerate(NAMES):
        r, c = divmod(i, 3)
        cell = im.crop((int(c * cw), int(r * ch), int((c + 1) * cw), int((r + 1) * ch)))
        frame = fit_square(cell, SIZE)
        idx = f"{i + 1:02d}-{name}"
        frame.save(os.path.join(OUT, f"{idx}.webp"), "WEBP", quality=86, method=6)
        if i == 0:
            first = frame
            # 登录页主图放大一档，2x 屏也不糊
            hero = fit_square(cell, 400)
            hero.save(os.path.join(OUT, "hero.webp"), "WEBP", quality=88, method=6)
            print(f"  hero.webp  {os.path.getsize(os.path.join(OUT, 'hero.webp')) / 1024:.1f}KB")
        print(f"  {idx}.webp  {os.path.getsize(os.path.join(OUT, f'{idx}.webp')) / 1024:.1f}KB")

    # 圆形头像：取第一帧的头部
    head = head_crop(first).resize((SIZE, SIZE), Image.LANCZOS)
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, SIZE - 1, SIZE - 1), fill=255)
    avatar = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    avatar.paste(head, (0, 0), mask)
    avatar.save(os.path.join(OUT, "avatar.webp"), "WEBP", quality=88)
    avatar.save(os.path.join(OUT, "avatar.png"), "PNG", optimize=True)

    # 高分辨率头部（不裁圆），给 App 图标用
    os.makedirs(ASSETS, exist_ok=True)
    big_src = fit_square(im.crop((0, 0, int(cw), int(ch))), 1400, pad=0.02)
    head_big = head_crop(big_src, ratio=0.80, top_ratio=0.02).resize((1024, 1024), Image.LANCZOS)
    head_path = os.path.join(ASSETS, "loopy-head.webp")
    head_big.save(head_path, "WEBP", quality=92, method=6)
    print(f"  assets/loopy-head.webp {os.path.getsize(head_path) / 1024:.1f}KB")


if __name__ == "__main__":
    main()
