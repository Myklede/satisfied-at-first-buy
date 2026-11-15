import json

import numpy as np
from body_service import config
from body_service.garment.grading import prepare_product
from body_service.garment.pattern import build_pattern
from body_service.garment.products import load_products
from body_service.garment.seams import attach_accessories
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


def test_shared_cloth_seams_and_accessories_have_no_long_welds():
    for product in load_products().values():
        report = json.loads(
            (config.ROOT / "data/grading" / f"{product.product_id}.json").read_text()
        )
        pattern = build_pattern(prepare_product(product, report), "S", quilted=False)
        assert len(pattern.welds) == 0
        physical = (pattern.panels <= 7) | (pattern.panels == 13)
        faces = pattern.mesh.faces[physical[pattern.mesh.faces].all(1)]
        edges = np.sort(faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1)
        graph = coo_matrix((np.ones(len(edges)), edges.T), shape=(len(physical), len(physical)))
        _, labels = connected_components(graph, directed=False)
        assert len(np.unique(labels[np.unique(faces)])) == 1
        assert physical[pattern.attachments[:, 1:]].all()
        assert np.isfinite(pattern.attachment_offsets).all()
        np.testing.assert_allclose(
            attach_accessories(pattern, pattern.mesh.vertices), pattern.mesh.vertices, atol=1e-12
        )
        angle = 0.3
        rotation = np.array(
            [[np.cos(angle), 0, np.sin(angle)], [0, 1, 0], [-np.sin(angle), 0, np.cos(angle)]]
        )
        posed = pattern.mesh.vertices @ rotation.T + [0.3, 0.7, 0.1]
        np.testing.assert_allclose(attach_accessories(pattern, posed), posed, atol=1e-12)
        hood = pattern.mesh.vertices[pattern.panels == 7]
        assert hood.mean(0)[1] < 0 and hood.mean(0)[2] < 0
