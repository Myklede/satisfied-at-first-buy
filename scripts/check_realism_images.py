"""Read-only screenshot QA; catches an inactive tension shader, not cloth accuracy."""

import json

import matplotlib.image as mpimg
import numpy as np
from body_service.config import ROOT


def main() -> None:
    rows = []
    directory = ROOT / "docs/validation"
    for label in ("reference", "personal"):
        for style in ("FB7675-100", "DQ4920-206"):
            prefix = f"realism-{label}-{style}"
            # Matplotlib (already pinned) returns PNG channels in [0,1].
            normal = mpimg.imread(directory / f"{prefix}-normal-front.png")[:, :, :3] * 255
            tension = mpimg.imread(directory / f"{prefix}-tension-front.png")[:, :, :3] * 255
            # Exclude headers/footer so labels cannot make a broken map pass.
            a, b = normal[70:-60].astype(float), tension[70:-60].astype(float)
            difference = float(np.abs(a - b).mean())
            red = (b[:, :, 0] > 1.5 * b[:, :, 1]) & (b[:, :, 0] > 1.5 * b[:, :, 2])
            blue = (b[:, :, 2] > 1.5 * b[:, :, 0]) & (b[:, :, 2] > 1.3 * b[:, :, 1])
            coloured = int((red | blue).sum())
            # Screenshot QA thresholds, not a fit/strain calibration: a visible
            # map must change >3/255 mean intensity and >1000 canvas pixels.
            passed = difference > 3 and coloured > 1000
            rows.append(
                {
                    "label": label,
                    "style": style,
                    "mean_rgb_difference": difference,
                    "tension_colour_pixels": coloured,
                    "pass": passed,
                }
            )
    (directory / "realism-image-checks.json").write_text(json.dumps(rows, indent=2) + "\n")
    if not all(row["pass"] for row in rows):
        raise SystemExit("FAIL: tension screenshot colour check; see realism-image-checks.json")
    print("4/4 actual tension front screenshots differ visibly from Normal (canvas pixels only).")


if __name__ == "__main__":
    main()
