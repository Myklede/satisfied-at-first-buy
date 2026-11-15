"""Model lifecycle and explicit native → scene conversion."""

import logging
import os
from time import perf_counter

import numpy as np
import torch

from . import config

os.environ["ANNY_CACHE_DIR"] = str(config.ROOT / ".cache/anny")
os.environ["XDG_CACHE_HOME"] = str(config.ROOT / ".cache")

import anny  # noqa: E402
from anny.paths import set_anny_cache_path  # noqa: E402
from anny.shape_distribution import SimpleShapeDistribution  # noqa: E402

set_anny_cache_path(config.ROOT / ".cache/anny")

log = logging.getLogger(__name__)


def scene_points(native: np.ndarray, floor: float) -> np.ndarray:
    """Anny metres (X right, Z up, -Y front) → metres (X, Y up, +Z front)."""
    result = native[..., [0, 2, 1]].copy()
    result[..., 1] -= floor
    result[..., 2] *= -1
    return result


class BodyEngine:
    def __init__(self) -> None:
        torch.manual_seed(config.SEED)
        torch.use_deterministic_algorithms(True)
        torch.set_num_threads(config.TORCH_THREADS)
        started = perf_counter()
        log.warning("Loading Anny CPU model; first cache build may take several minutes...")
        self.model = anny.Anny(
            topology="anny",
            phenotypes="all",
            local_changes=config.LOCAL_LABELS,
            skinning_method="lbs",
            pose_parameterization="local-bone",
        ).float()
        self.anthropometry = anny.Anthropometry(self.model)
        self.shape_prior = SimpleShapeDistribution(self.model)
        self.faces = self.model.faces.numpy()
        self.neutral = self.model(phenotype_kwargs={"age": config.ADULT_AGE})
        self.floor = float(self.neutral["rest_vertices"][0, :, 2].min())
        self.vertices = scene_points(self.neutral["rest_vertices"][0].numpy(), self.floor)
        self.bones = scene_points(self.neutral["rest_bone_heads"][0].numpy(), self.floor)
        log.warning(
            "Anny ready: %s vertices / %s triangles in %.2fs",
            len(self.vertices),
            len(self.faces),
            perf_counter() - started,
        )

    def unobserved_shape(self, female: bool) -> dict[str, float]:
        """Anny's shipped adult means; not inferred from a person's tape targets."""
        prefix = "girls" if female else "boys"
        age = torch.tensor([config.ADULT_AGE])
        return {
            name: float(
                getattr(self.shape_prior, f"{prefix}_conditional_{name}_distribution")
                .get_torch_distribution(age)
                .mean[0]
            )
            for name in ("muscle", "proportions")
        } | {
            "cupsize": config.UNOBSERVED_SHAPE_DEFAULT,
            "firmness": config.UNOBSERVED_SHAPE_DEFAULT,
        }

    def rest(
        self,
        phenotypes: dict[str, torch.Tensor | float],
        local: dict[str, torch.Tensor | float] | None = None,
    ) -> torch.Tensor:
        """Skip skinning/rig SVD in the optimisation loop; Anny's exact rest blendshapes."""
        coefficients = self.model.get_phenotype_blendshape_coefficients(
            **phenotypes,
            local_changes=local,
        )
        return self.model.get_rest_vertices(coefficients)

    def rest_joints(self, phenotypes: dict, local: dict, floor: float) -> dict[str, np.ndarray]:
        coefficients = self.model.get_phenotype_blendshape_coefficients(
            **phenotypes, local_changes=local
        )
        with torch.no_grad():
            points = self.model.template_bone_heads + torch.einsum(
                "bk,kjd->bjd", coefficients, self.model.bone_heads_blendshapes
            )
        result = dict(
            zip(self.model.bone_labels, scene_points(points[0].numpy(), floor), strict=True)
        )
        ring = self.anthropometry.waist_vertex_indices
        with torch.no_grad():
            waist = self.model.template_vertices[ring] + torch.einsum(
                "bk,kvd->bvd", coefficients, self.model.blendshapes[:, ring]
            )
        result["waist_anchor"] = scene_points(waist[0].mean(0).numpy(), floor)
        return result
