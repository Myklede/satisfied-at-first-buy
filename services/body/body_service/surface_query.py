"""Vectorised triangle queries; exact mode certifies pruning with enclosing spheres."""

import numpy as np
import trimesh
from scipy.spatial import cKDTree

from . import config


class SurfaceQuery:
    def __init__(self, body: trimesh.Trimesh) -> None:
        if not len(body.faces):
            raise ValueError("Surface queries need non-empty triangles")
        self.body = body
        self.tree = cKDTree(body.triangles_center)
        self.max_radius = float(
            np.linalg.norm(body.triangles - body.triangles_center[:, None, :], axis=2).max()
        )
        self.edge_normals = np.zeros((len(body.edges_unique), 3))
        np.add.at(
            self.edge_normals, body.edges_unique_inverse, np.repeat(body.face_normals, 3, axis=0)
        )
        self.edge_normals /= np.maximum(
            np.linalg.norm(self.edge_normals, axis=1)[:, None], config.SECTION_EPS
        )

    def pseudonormals(self, closest: np.ndarray, faces: np.ndarray) -> np.ndarray:
        """Use face, two-face edge, or angle-weighted vertex normals as appropriate.

        A single arbitrary incident face is ambiguous at the closest edge/vertex.
        Independent acceptance still uses exact closest queries and ray parity.
        """
        bary = trimesh.triangles.points_to_barycentric(self.body.triangles[faces], closest)
        normals = self.body.face_normals[faces].copy()
        boundary = (bary <= config.CLOTH_QUALITY_BARY_EPS).sum(1)
        vertex = boundary >= 2
        ids = self.body.faces[faces[vertex], bary[vertex].argmax(1)]
        normals[vertex] = self.body.vertex_normals[ids]
        edge = boundary == 1
        local = (bary[edge].argmin(1) + 1) % 3
        edge_ids = self.body.edges_unique_inverse.reshape(-1, 3)[faces[edge], local]
        normals[edge] = self.edge_normals[edge_ids]
        return normals

    def closest(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Fast candidate query; an upper bound on the true nearest distance."""
        count = min(config.SURFACE_CANDIDATE_FACES, len(self.body.faces))
        _, ids = self.tree.query(points, k=count)
        if count == 1:
            ids = ids[:, None]
        repeated = np.repeat(points, count, axis=0)
        closest = trimesh.triangles.closest_point(self.body.triangles[ids.reshape(-1)], repeated)
        closest = closest.reshape(len(points), count, 3)
        distance = np.linalg.norm(closest - points[:, None, :], axis=2)
        best = distance.argmin(axis=1)
        rows = np.arange(len(points))
        return closest[rows, best], distance[rows, best], ids[rows, best]

    def exact_closest(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Include every triangle that could beat the candidate distance.

        A triangle lies inside its centre/radius sphere. Thus a face with centre
        farther than best_distance + max_radius cannot contain a closer point.
        This is a conservative mathematical bound, not a k-neighbour approximation.
        """
        closest = np.empty((len(points), 3), dtype=np.float64)
        distances = np.empty(len(points), dtype=np.float64)
        faces = np.empty(len(points), dtype=np.int64)
        for start in range(0, len(points), config.SURFACE_EXACT_CHUNK_SIZE):
            batch = points[start : start + config.SURFACE_EXACT_CHUNK_SIZE]
            _, bound, _ = self.closest(batch)
            candidates = self.tree.query_ball_point(
                batch, bound + self.max_radius + config.SURFACE_BOUND_EPS_M
            )
            counts = np.fromiter((len(row) for row in candidates), dtype=np.int64)
            ids = np.concatenate(candidates).astype(np.int64)
            repeated = np.repeat(batch, counts, axis=0)
            projected = trimesh.triangles.closest_point(self.body.triangles[ids], repeated)
            squared = np.einsum("ij,ij->i", projected - repeated, projected - repeated)
            starts = np.r_[0, np.cumsum(counts)[:-1]]
            best = np.minimum.reduceat(squared, starts)
            winners = np.minimum.reduceat(
                np.where(squared == np.repeat(best, counts), np.arange(len(ids)), len(ids)), starts
            )
            end = start + len(batch)
            closest[start:end] = projected[winners]
            distances[start:end] = np.sqrt(best)
            faces[start:end] = ids[winners]
        return closest, distances, faces
