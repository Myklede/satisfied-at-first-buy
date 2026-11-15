"""Actual reference geometry renders and CPU measurements, without personal data."""

import matplotlib.pyplot as plt
import numpy as np
from body_service import config
from body_service.fit import Fitter
from body_service.garment.builder import clearance_samples
from body_service.garment.models import GarmentFitRequest
from body_service.garment.service import GarmentService
from body_service.model import BodyEngine
from body_service.schemas import FitRequest
from render_landmarks import draw_mesh


def heat_colours(gaps: np.ndarray) -> np.ndarray:
    t = np.clip(
        (gaps - config.HEATMAP_TIGHT_CM) / (config.HEATMAP_LOOSE_CM - config.HEATMAP_TIGHT_CM), 0, 1
    )
    red, green, blue = (
        np.array([0.95, 0.2, 0.16]),
        np.array([0.2, 0.8, 0.4]),
        np.array([0.2, 0.48, 0.96]),
    )
    return np.where(
        (t < 0.5)[:, None],
        red[None] * (1 - 2 * t[:, None]) + green[None] * 2 * t[:, None],
        green[None] * (2 - 2 * t[:, None]) + blue[None] * (2 * t[:, None] - 1),
    )


def main() -> None:
    fitter = Fitter(BodyEngine())
    service = GarmentService(fitter)
    directory = config.ROOT / "docs/validation"
    slow_builds: list[tuple[str, float]] = []
    lines = [
        "# Garment geometry regression",
        "",
        f"Engine {config.MODEL_VERSION}; density {config.DENSITY_KG_M3:g} kg/m3.",
        "",
        "Actual owned S dimensions, t-shirt layer, regular preference. "
        "Reference bodies are synthetic model inputs, not volunteers.",
        "",
        "| Body | Product / size | Build ms | Min outer gap cm | Inside samples |",
        "| --- | --- | ---: | ---: | ---: |",
    ]
    for sex, h, w in [
        ("female", 158, 52),
        ("female", 170, 68),
        ("male", 172, 65),
        ("male", 185, 92),
    ]:
        body = fitter.fit(FitRequest(sex=sex, height_cm=h, weight_kg=w))
        for product in service.products.values():
            result = service.fit(
                GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
            )
            owned = product.owned_size
            built = service.get_mesh(result.response.fit_id, owned)
            if built.build_ms >= 1500:
                slow_builds.append((product.style, built.build_ms))
            points, _, _ = clearance_samples(built.mesh, body.mesh)
            inside = int(body.mesh.contains(points).sum())
            lines.append(
                f"| {sex} {h}/{w} | {product.style} {owned} | {built.build_ms:.1f} | "
                f"{built.min_gap_cm:.3f} | {inside}/{len(points)} |"
            )
            print(
                sex, h, w, product.style, round(built.build_ms, 1), "ms; inside", inside, flush=True
            )
            if inside:
                raise RuntimeError("Garment collision regression failed")
            if (sex, h, w) != ("male", 172, 65):
                continue
            metrics = result.response.sizes[owned]
            for mode in ("normal", "xray", "heatmap"):
                fig, axes = plt.subplots(1, 3, figsize=(12, 5.5), facecolor="#151c21")
                for ax, view in zip(axes, ("front", "back", "side"), strict=True):
                    project = draw_mesh(ax, body.mesh, view)
                    colours = (
                        heat_colours(built.mesh.vertex_attributes["inner_gap_cm"])
                        if mode == "heatmap"
                        else np.asarray(built.mesh.visual.vertex_colors)[:, :3] / 255
                    )
                    draw_mesh(
                        ax, built.mesh, view, values=colours, alpha=0.3 if mode == "xray" else 1
                    )
                    for side in ("L", "R"):
                        for kind, colour in (
                            ("acromion", "#ffffff"),
                            ("seam", "#ffcd87"),
                            ("wrist", "#ffffff"),
                            ("cuff", "#9ab9ff"),
                        ):
                            point = metrics.anchors.get(f"{kind}_{side}")
                            if point:
                                x, y = project(point)
                                ax.scatter([x], [y], s=13, color=colour, zorder=5)
                        for a, b in (("acromion", "seam"), ("wrist", "cuff")):
                            p = project(
                                [metrics.anchors[f"{a}_{side}"], metrics.anchors[f"{b}_{side}"]]
                            )
                            ax.plot(p[:, 0], p[:, 1], color="#ffcd87", lw=1, zorder=5)
                    ax.set_title(view.upper(), color="#c7e1d5", fontsize=10)
                    ax.set_ylim(0.35, 1.85)
                fig.suptitle(
                    f"{product.style} / owned {owned} - {mode.upper()}\n"
                    "Computed reference M172/65, native A-pose; diagnostic CPU render",
                    color="#deeee5",
                    fontsize=13,
                )
                fig.text(
                    0.5,
                    0.06,
                    f"Seam {metrics.zones['shoulder'].value_cm:+.2f} cm | "
                    f"cuff {metrics.zones['sleeve'].value_cm:+.2f} cm | "
                    f"hem {metrics.zones['hem'].position_vs_hip_cm:+.2f} cm vs hip",
                    ha="center",
                    color="#b9d4c7",
                    fontsize=10,
                )
                fig.text(
                    0.5,
                    0.025,
                    "Heatmap: estimated inner gap (outer gap - insulation - layer), "
                    f"red <= {config.HEATMAP_TIGHT_CM} cm / blue >= {config.HEATMAP_LOOSE_CM} cm. "
                    "Shape proxy, not cloth simulation.",
                    ha="center",
                    color="#94a99e",
                    fontsize=8,
                )
                fig.savefig(
                    directory / f"garment-{product.style}-{owned}-{mode}.png",
                    dpi=140,
                    facecolor=fig.get_facecolor(),
                )
                plt.close(fig)
    lines += [
        "",
        "FPS: not measured by this CPU rendering script. "
        "Use the viewer's live counter in the local browser.",
        "",
        "Both owned sizes are S in different products. "
        "No second size-label geometry is claimed: non-owned sizes lack "
        "shoulder / sleeve / HPS length / bicep. Their derived girths remain labelled estimated.",
        "",
    ]
    (directory / "garment-reference.md").write_text("\n".join(lines), encoding="utf-8")
    if slow_builds:
        raise SystemExit(f"Garment build-time gate failed (ms): {slow_builds}")


if __name__ == "__main__":
    main()
