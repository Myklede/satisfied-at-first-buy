"""F5: side-by-side A/B strip of two AR recordings of the same clip window (look-lane jobs).

py scripts/ar-judge-abstrip.py <A ar.webm> <B ar.webm> <out.jpg> <t0> <step_s> <n> [crop x0,x1] [labelA,labelB]
Each column = one clip time: arm A on top, arm B below, same crop, same time (recording t=0 is the
window start for both). Private pixels: write under .cache only.
"""

import sys

import cv2
import numpy as np


def frames(path):
    c = cv2.VideoCapture(path)
    out = []
    while True:
        ok = c.grab()
        if not ok:
            break
        t = c.get(cv2.CAP_PROP_POS_MSEC) / 1000
        ok, f = c.retrieve()
        if ok:
            out.append((t, f))
    return out


def main():
    a, b, out, t0, step, n = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]), int(sys.argv[6])
    fx0, fx1 = (float(v) for v in (sys.argv[7] if len(sys.argv) > 7 else "0.28,0.72").split(","))
    la, lb = (sys.argv[8] if len(sys.argv) > 8 else "A,B").split(",")
    A, B = frames(a), frames(b)
    tiles = []
    for k in range(n):
        t = k * step
        fa = min(A, key=lambda x: abs(x[0] - t))
        fb = min(B, key=lambda x: abs(x[0] - t))
        col = []
        for name, (tt, f) in ((la, fa), (lb, fb)):
            h, w = f.shape[:2]
            crop = f[:, int(fx0 * w) : int(fx1 * w)]
            crop = cv2.resize(crop, (240, int(240 * crop.shape[0] / crop.shape[1])))
            cv2.putText(crop, f"{name} {t0 + tt:.2f}s", (4, 16), 0, 0.5, (0, 255, 255), 1)
            col.append(crop)
        tiles.append(np.vstack(col))
    cols = 8
    while len(tiles) % cols:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.hstack(tiles[r : r + cols]) for r in range(0, len(tiles), cols)]
    cv2.imwrite(out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(out, len(A), len(B))


if __name__ == "__main__":
    main()
