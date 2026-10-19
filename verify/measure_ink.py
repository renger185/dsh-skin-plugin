"""量作者截图：底色亮不亮、字是什么颜色、两者对比度。
用来判「蓝色字到底是该黑还是该白」这件事 —— 不看截图不下结论。

用法: python verify/measure_ink.py <截图路径> [x0 y0 x1 y1]
"""
import sys
from PIL import Image

path = sys.argv[1]
im = Image.open(path).convert('RGB')
W, H = im.size
print('图', W, 'x', H)
box = [int(v) for v in sys.argv[2:6]] if len(sys.argv) >= 6 else [0, int(H * 0.55), W, H]
print('分析区域', box)


def lum(rgb):
    def f(v):
        v /= 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


pixels = []
for y in range(box[1], box[3], 2):
    for x in range(box[0], box[2], 2):
        pixels.append(im.getpixel((x, y)))
n = len(pixels)
lums = [lum(c) for c in pixels]
lums.sort()
mean = sum(lums) / n
print('区域平均亮度 %.3f  中位 %.3f  p10 %.3f  p90 %.3f' % (mean, lums[n // 2], lums[int(n * 0.1)], lums[int(n * 0.9)]))
bright = sum(1 for v in lums if v > 0.5) / n
dark = sum(1 for v in lums if v < 0.2) / n
print('亮像素占比 %.1f%%  暗像素占比 %.1f%%' % (bright * 100, dark * 100))

# 背景色 = 出现最多的那种（降采样）
hist = {}
for c in pixels:
    k = (c[0] // 8 * 8, c[1] // 8 * 8, c[2] // 8 * 8)
    hist[k] = hist.get(k, 0) + 1
top = sorted(hist.items(), key=lambda kv: -kv[1])[:6]
print('最常见的颜色：')
for c, k in top:
    print('   #%02x%02x%02x  %.1f%%  (亮度 %.3f)' % (c[0], c[1], c[2], 100.0 * k / n, lum(c)))
bg = top[0][0]

# 文字色 = 偏蓝且和背景差得远的那批像素（蓝色字的特征：B 明显大于 R）
bluish = [c for c in pixels if c[2] - c[0] > 30 and lum(c) < 0.75]
whitish = [c for c in pixels if min(c) > 225]
darkish = [c for c in pixels if max(c) < 70]
print('')
print('偏蓝像素 %d 个（%.2f%%）' % (len(bluish), 100.0 * len(bluish) / n))
if bluish:
    avg = tuple(sum(c[i] for c in bluish) // len(bluish) for i in range(3))
    print('   平均 #%02x%02x%02x  对比度 vs 最常见底色 %.2f:1' % (avg[0], avg[1], avg[2], ratio(avg, bg)))
print('近白像素 %d 个（%.2f%%）' % (len(whitish), 100.0 * len(whitish) / n))
print('近黑像素 %d 个（%.2f%%）' % (len(darkish), 100.0 * len(darkish) / n))
print('')
print('参考：纯黑字压这个底的对比度 %.2f:1 ；纯白字 %.2f:1' % (ratio((0, 0, 0), bg), ratio((255, 255, 255), bg)))
