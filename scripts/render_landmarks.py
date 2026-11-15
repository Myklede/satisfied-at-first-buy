"""Render actual reference meshes/landmarks as PNGs; no browser or personal data required."""

import os

from body_service.config import ROOT

os.environ["MPLCONFIGDIR"] = str(ROOT / ".cache/matplotlib")

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from body_service.fit import Fitter  # noqa: E402
from body_service.model import BodyEngine  # noqa: E402
from body_service.schemas import FitRequest  # noqa: E402
from matplotlib.collections import PolyCollection  # noqa: E402


def draw_mesh(ax, mesh, view: str, color=(0.64, 0.76, 0.74), alpha=1.0, values=None):
    v, f = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    axes = {"front": (0, 1, 2), "back": (0, 1, 2), "side": (2, 1, 0)}[view]
    sign = -1 if view == "back" else 1
    projected = v[:, axes[:2]].copy()
    projected[:, 0] *= sign
    depth = v[:, axes[2]] * sign
    order = np.argsort(depth[f].mean(axis=1))
    normals = mesh.face_normals
    light = np.clip(0.45 + 0.55 * abs(normals @ np.array([0.2, 0.5, 0.84])), 0.25, 1)
    colors = np.tile(color, (len(f), 1)) * light[:, None]
    if values is not None:
        colors = values[f].mean(axis=1) * light[:, None]
    collection = PolyCollection(
        projected[f][order],
        facecolors=colors[order],
        edgecolors="none",
        alpha=alpha,
        rasterized=True,
    )
    ax.add_collection(collection)
    ax.set_aspect("equal")
    ax.set_xlim(-0.7, 0.7)
    ax.set_ylim(-0.04, 2.05)
    ax.set_facecolor("#151c21")
    ax.axis("off")
    return lambda p: np.array(p)[..., axes[:2]] * np.array([sign, 1])


def main():
    fitter = Fitter(BodyEngine())
    cases = [("male", 175, 75), ("male", 185, 92), ("female", 158, 52)]
    bodies = [fitter.fit(FitRequest(sex=sex, height_cm=h, weight_kg=w)) for sex, h, w in cases]
    directory = ROOT / "docs/validation"
    directory.mkdir(parents=True, exist_ok=True)
    for view in ("front", "back", "side"):
        fig, axes = plt.subplots(1, 3, figsize=(12, 8), facecolor="#151c21")
        for ax, body, (sex, h, w) in zip(axes, bodies, cases, strict=True):
            project = draw_mesh(ax, body.mesh, view)
            for tape in body.geometry.tapes.values():
                p = project(np.vstack((tape.points, tape.points[0])))
                ax.plot(p[:, 0], p[:, 1], lw=1, alpha=0.7, color="#91e0c3")
            for route, color in (("shoulder_arc", "#ffb563"), ("back_length", "#8cb9ff")):
                p = project(body.geometry.surface_paths[route])
                ax.plot(p[:, 0], p[:, 1], lw=1.8, color=color, zorder=4)
            for name in ("acromion_L", "acromion_R", "C7", "jugular_notch", "HPS_L", "HPS_R"):
                x, y = project(body.geometry.landmarks[name])
                ax.scatter([x], [y], s=12, color="#ffd4a1", zorder=5)
                if view != "side" or name in ("C7", "jugular_notch"):
                    ax.annotate(
                        name.replace("acromion", "acro"),
                        (x, y),
                        xytext=(4, 5),
                        textcoords="offset points",
                        color="#ffd4a1",
                        fontsize=7,
                    )
            m = body.response.measurements
            ax.set_title(
                f"{sex} {h}cm / {w}kg\nstraight {m['shoulder_width'].value_cm:.1f}cm | "
                f"via C7 {m['shoulder_arc'].value_cm:.1f}cm\nneck {m['neck_base'].value_cm:.1f}cm",
                color="#d9e7df",
                fontsize=10,
            )
        fig.suptitle(
            f"Anny anatomical regression - {view.upper()} - computed reference bodies",
            color="#d9e7df",
        )
        fig.text(
            0.5,
            0.025,
            "Orange: posterior shoulder via C7. Blue: C7-to-waist. Green: girths / inclined neck. "
            "Not real-person accuracy validation.",
            ha="center",
            color="#98afa3",
            fontsize=9,
        )
        fig.savefig(directory / f"landmarks-{view}.png", dpi=150, facecolor=fig.get_facecolor())
        plt.close(fig)
    for case, body in zip(cases, bodies, strict=True):
        print(
            case,
            {
                name: round(body.response.measurements[name].value_cm, 3)
                for name in ("shoulder_width", "shoulder_arc", "neck_base")
            },
        )


if __name__ == "__main__":
    main()
