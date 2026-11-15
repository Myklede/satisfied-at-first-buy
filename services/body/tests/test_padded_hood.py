"""Agent H's padded-hood gate: the baked GLBs are readable and the gate skips hoodless shells."""

import numpy as np
import trimesh
from body_service import config
from body_service.garment.quality import HOOD_GLB, _read_glb, padded_hood_rest


def test_baked_hoods_read_with_attach_seam_and_states():
    for kind, name in HOOD_GLB.items():
        info, attrs, targets = _read_glb(config.ROOT / "apps/web/public/assets/hoods" / name)
        assert info["removable"] is (kind == 2)
        n = len(attrs["POSITION"])
        assert attrs["POSITION"].shape == (n, 3)
        sigma, attach = attrs["_SIGMA"][:, 0], attrs["_ATTACH"][:, 0]
        assert sigma.min() >= 0 and sigma.max() <= 1
        assert (attach > 0.5).sum() >= 3  # an attach seam row exists
        expected = ["peel25", "peel50", "peel75", "detached"] if kind == 2 else []
        assert list(targets) == expected
        for delta in targets.values():
            assert delta.shape == (n, 3) and np.isfinite(delta).all()


def test_hoodless_shell_is_not_gated():
    tri = trimesh.creation.box()
    asset = {"render_details": {"hood_kind": 0}}
    result = padded_hood_rest(asset, tri.vertices, tri, np.zeros(len(tri.vertices)), tri)
    assert result == {"pass": True, "present": False}
