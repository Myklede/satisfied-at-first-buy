import numpy as np
from body_service.garment.pattern import build_pattern
from body_service.garment.products import load_products
from body_service.garment.rendering import fabric_render_data, transported_puff
from scipy.spatial.transform import Rotation


def test_outer_reference_transport_preserves_tapes_loft_and_rigid_motion():
    for product in load_products().values():
        pattern = build_pattern(product, "S", quilted=False)
        data = fabric_render_data(pattern, product)
        puff = transported_puff(data, pattern.mesh.vertices)
        np.testing.assert_allclose(puff, pattern.render_offsets, atol=1e-12)
        assert np.isfinite(data.uv).all()
        assert (data.stitch_distance >= 0).all()
        assert np.linalg.norm(puff, axis=1).max() <= product.loft_cm / 100 + 1e-12
        matrix = Rotation.from_rotvec([0.2, -0.3, 0.1]).as_matrix()
        moved = pattern.mesh.vertices @ matrix.T + [1, 2, 3]
        np.testing.assert_allclose(transported_puff(data, moved), puff @ matrix.T, atol=1e-12)
        np.testing.assert_allclose(
            moved + transported_puff(data, moved),
            pattern.reference_vertices @ matrix.T + [1, 2, 3],
            atol=1e-12,
        )
