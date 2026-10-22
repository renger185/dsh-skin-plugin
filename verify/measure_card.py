"""精确量boss截图里那张「交付文件卡片」的底色和字色 —— 修前取证。
用法: python verify/measure_card.py <截图路径>
"""
import sys
from PIL import Image

path = sys.argv[1]
im = Image.open(path).convert('RGB')
W, H = im.size
print('图', W, 'x', H)


def runs_in_row(y, thresh=200, min_len=200):
    out = []
    start = None
    for x in range(W):
        c = im.getpixel((x, y))
        is_light = min(c) > thresh
        if is_light and start is None:
            start = x
        elif not is_light and start is not None:
            if x - start >= min_len:
                out.append((start, x))
            start = None
    if start is not None and W - start >= min_len:
        out.append((start, W))
    return out


# 找出现「最宽浅色条」的那一行 = 卡片的中间
best = None
for y in range(int(H * 0.68), int(H * 0.95)):
    for a, b in runs_in_row(y):
        if best is None or (b - a) > (best[2] - best[1]):
            best = (y, a, b)
if not best:
    print('没找到卡片')
    sys.exit(0)
y0, x0, x1 = best
print(f'卡片中线 y={y0}，横向 {x0}..{x1}（宽 {x1 - x0}px）')

# 卡的上下边界：从中线往上/下找，直到浅色条消失
top = y0
while top > 0 and runs_in_row(top - 1, 200, 200):
    top -= 1
bot = y0
while bot < H - 1 and runs_in_row(bot + 1, 200, 200):
    bot += 1
print(f'卡片上下 {top}..{bot}（高 {bot - top + 1}px）')

# 卡里的颜色分布（去掉左右各 6px 圆角）
hist = {}
for y in range(top + 4, bot - 3):
    for x in range(x0 + 8, x1 - 8, 2):
        c = im.getpixel((x, y))
        k = (c[0] // 4 * 4, c[1] // 4 * 4, c[2] // 4 * 4)
        hist[k] = hist.get(k, 0) + 1
total = sum(hist.values())
top_colors = sorted(hist.items(), key=lambda kv: -kv[1])[:8]
print('卡内颜色分布：')
for c, n in top_colors:
    print('   RGB %-16s %s  %.1f%%' % (str(c), '#%02x%02x%02x' % c, 100.0 * n / total))

bg = top_colors[0][0]
# 字色 = 卡内离底色最远、且占比 > 0.3% 的那种
def lum(rgb):
    def f(v):
        v /= 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


far = max((c for c, n in hist.items() if n > total * 0.003), key=lambda c: ratio(bg, c), default=bg)
print('')
print('  卡底色(最多那种)  #%02x%02x%02x' % bg)
print('  卡内离底色最远那种 #%02x%02x%02x' % far)
print('  两者对比度        %.2f : 1' % ratio(bg, far))
wall = im.getpixel((x0 + 30, max(0, top - 40)))
print('  卡片上方壁纸       #%02x%02x%02x' % wall)
