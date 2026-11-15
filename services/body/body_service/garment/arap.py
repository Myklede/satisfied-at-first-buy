"""Static as-rigid-as-possible wrap projection; rest metrics remain unchanged.

Local rotations minimise edge distortion; a sparse global least-squares solve
balances those intrinsic edges with the body-conforming target. No time, gravity,
mass or material simulation is involved in this initialisation.
"""

import numpy as np
from scipy.sparse import coo_matrix, diags
from scipy.sparse.linalg import factorized

from .. import config


class MetricWrap:
    def __init__(
        self,
        rest: np.ndarray,
        edges: np.ndarray,
        target_weight: float | None = None,
        pinned: np.ndarray | None = None,
    ):
        self.rest = rest
        self.edges = edges
        self.delta = rest[edges[:, 0]] - rest[edges[:, 1]]
        squared = np.einsum("ij,ij->i", self.delta, self.delta)
        if (squared <= config.SECTION_EPS**2).any():
            raise ValueError("Merge zero-length seams before metric wrap")
        self.weights = np.median(squared) / squared
        a, b = edges.T
        adjacency = coo_matrix(
            (np.r_[self.weights, self.weights], (np.r_[a, b], np.r_[b, a])),
            shape=(len(rest), len(rest)),
        ).tocsc()
        degree = np.asarray(adjacency.sum(1)).ravel()
        if (degree <= 0).any():
            raise ValueError("Metric wrap requires non-orphaned cloth vertices")
        weight = config.WRAP_TARGET_WEIGHT if target_weight is None else target_weight
        if weight <= 0:
            raise ValueError("A positive target weight removes rigid translation ambiguity")
        self.anchor = degree * weight
        if pinned is not None:
            self.anchor[pinned] = degree[pinned] * config.WRAP_PIN_WEIGHT
        self.solve = factorized((diags(degree + self.anchor) - adjacency).tocsc())

    def project(
        self,
        target: np.ndarray,
        iterations: int | None = None,
        planes: tuple[np.ndarray, np.ndarray] | None = None,
    ) -> np.ndarray:
        count = config.WRAP_ARAP_ITERATIONS if iterations is None else iterations
        result = target.copy()
        a, b = self.edges.T
        for _ in range(count):
            deformed = result[a] - result[b]
            outer = np.einsum("ei,ej,e->eij", deformed, self.delta, self.weights)
            covariance = np.zeros((len(result), 3, 3))
            np.add.at(covariance, a, outer)
            np.add.at(covariance, b, outer)
            u, _, vh = np.linalg.svd(covariance)
            reflection = np.linalg.det(u @ vh) < 0
            u[reflection, :, 2] *= -1
            rotations = u @ vh
            transported = np.einsum(
                "eij,ej,e->ei", (rotations[a] + rotations[b]) * 0.5, self.delta, self.weights
            )
            rhs = target * self.anchor[:, None]
            np.add.at(rhs, a, transported)
            np.add.at(rhs, b, -transported)
            result = self.solve(rhs)
            if planes is not None:
                normal, bound = planes
                violation = np.maximum(0.0, bound - np.einsum("ij,ij->i", normal, result))
                result += normal * violation[:, None]
        if not np.isfinite(result).all():
            raise ValueError("Metric wrap produced non-finite positions")
        return result


class BoundedWrap:
    """Convex static projection onto material edge balls and contact halfspaces.

    ADMM splits the edge differences and body positions. Unlike a positional
    post-pass, both constraints participate in the same global solve. Compression
    is unrestricted; this is an initial wrap, not a material constitutive model.
    """

    def __init__(
        self,
        rest: np.ndarray,
        edges: np.ndarray,
        limits: np.ndarray,
        target_weight: float | np.ndarray,
    ):
        self.edges = edges
        lengths = np.linalg.norm(rest[edges[:, 0]] - rest[edges[:, 1]], axis=1)
        self.maximum = lengths * limits
        if (self.maximum <= config.SECTION_EPS).any() or (np.asarray(target_weight) <= 0).any():
            raise ValueError("Positive rest lengths and target weight are required")
        a, b = edges.T
        count = len(rest)
        scale = np.median(lengths) / lengths
        self.maximum *= scale
        incidence = coo_matrix(
            (
                np.r_[scale, -scale],
                (np.r_[np.arange(len(edges)), np.arange(len(edges))], np.r_[a, b]),
            ),
            shape=(len(edges), count),
        ).tocsc()
        self.incidence = incidence
        self.anchor = np.broadcast_to(target_weight, (count,))
        self.solve = factorized((incidence.T @ incidence + diags(1 + self.anchor)).tocsc())

    def project(
        self,
        target: np.ndarray,
        iterations: int,
        planes: tuple[np.ndarray, np.ndarray] | None = None,
    ) -> np.ndarray:
        result = target.copy()
        z = self.incidence @ result
        y = result.copy()
        edge_dual = np.zeros_like(z)
        body_dual = np.zeros_like(y)
        for _ in range(iterations):
            result = self.solve(
                self.anchor[:, None] * target + self.incidence.T @ (z - edge_dual) + y - body_dual
            )
            delta = self.incidence @ result
            relaxed_edge = (
                config.WRAP_ADMM_RELAXATION * delta + (1 - config.WRAP_ADMM_RELAXATION) * z
            )
            relaxed_body = (
                config.WRAP_ADMM_RELAXATION * result + (1 - config.WRAP_ADMM_RELAXATION) * y
            )
            z = relaxed_edge + edge_dual
            lengths = np.linalg.norm(z, axis=1)
            z *= np.minimum(1, self.maximum / np.maximum(lengths, config.SECTION_EPS))[:, None]
            y = relaxed_body + body_dual
            if planes is not None:
                normal, bound = planes
                violation = np.maximum(0, bound - np.einsum("ij,ij->i", normal, y))
                y += normal * violation[:, None]
            edge_dual += relaxed_edge - z
            body_dual += relaxed_body - y
        if not np.isfinite(result).all():
            raise ValueError("Bounded wrap produced non-finite positions")
        return result
