import numpy as np
import pytest
import trimesh
from body_service import config
from body_service.garment.aperture import arm_profile, cuff_collider
from body_service.garment.models import GarmentFitRequest
from body_service.garment.quality import body_penetration, panel_crossings
from body_service.garment.service import GarmentService
from body_service.garment.shell import (
    ClosestMemo,
    ShellBodyCache,
    build_shell,
    clip_polygon_x,
    fitted_ring,
    hang_rings,
    offset_polygon,
    ray_sample,
    respace_sleeve,
    ring_perimeter,
    shell_measurements,
    shell_tethers,
    untangle,
)
from body_service.garment.shell_defects import shell_defects
from body_service.pose import display_body
from body_service.schemas import FitRequest
from body_service.surface_query import SurfaceQuery


def square(side=0.2):
    h = side / 2
    return np.array([[-h, -h], [h, -h], [h, h], [-h, h]])


def test_offset_polygon_adds_two_pi_d_to_a_convex_perimeter():
    poly = square()
    for d in (0.0, 0.005, 0.03):
        dense = offset_polygon(poly, d)
        # Corner arcs are chords (SHELL_OFFSET_ARC_STEPS); fitted_ring root-solves the real tape.
        assert abs(ring_perimeter(dense) - (0.8 + 2 * np.pi * d)) < 3e-3


def test_ray_sample_hits_the_polygon_at_requested_angles():
    angles = np.linspace(0, 2 * np.pi, 16, endpoint=False)
    ring = ray_sample(square(), np.zeros(2), angles)
    np.testing.assert_allclose(np.arctan2(ring[:, 1], ring[:, 0]) % (2 * np.pi), angles, atol=1e-9)
    assert np.allclose(np.abs(ring).max(1), 0.1)


def test_fitted_ring_matches_tape_or_reports_clamping():
    angles = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    ring, d, clamped = fitted_ring(square(), np.zeros(2), angles, 1.0, 0.004)
    assert not clamped and d > 0.004
    assert abs(ring_perimeter(ring) - 1.0) < 1e-5
    tight, d, clamped = fitted_ring(square(), np.zeros(2), angles, 0.5, 0.004)
    assert clamped and d == 0.004
    assert ring_perimeter(tight) > 0.8


def test_hang_rings_keep_tapes_and_clearance_and_fall_straight():
    # A body that narrows below a wide "bust" row, then widens again (a "seat"): the hung rows
    # keep their tape, never come nearer the body than the clearance, and below the bust they no
    # longer follow the narrow waist (L2).
    angles = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    centre, minimum = np.zeros(2), 0.004
    halves = [0.16, 0.12, 0.11, 0.15]  # bust, waist, waist, seat (square half-sides, m)
    levels = np.array([1.3, 1.2, 1.1, 1.0])
    hulls = [square(2 * h) for h in halves]
    tapes = [1.45, 1.4, 1.4, 1.42]
    rings = np.zeros((len(levels), len(angles), 3))
    for i, (hull, tape) in enumerate(zip(hulls, tapes, strict=True)):
        ring2, _, _ = fitted_ring(hull, centre, angles, tape, minimum)
        rings[i] = np.c_[ring2[:, 0], np.full(len(angles), levels[i]), ring2[:, 1]]
    before = rings.copy()
    info = [(h, t, (-np.inf, np.inf)) for h, t in zip(hulls, tapes, strict=True)]
    hang_rings(rings, levels, info, centre, angles, minimum, 2.0)
    np.testing.assert_array_equal(rings[0], before[0])  # the seed row is unchanged
    for i in range(1, len(levels)):
        ring2 = rings[i][:, [0, 2]]
        assert abs(ring_perimeter(ring2) - tapes[i]) < 1e-6
        floor, _, _ = fitted_ring(hulls[i], centre, angles, None, minimum)
        assert (np.linalg.norm(ring2, axis=1) >= np.linalg.norm(floor, axis=1) - 1e-9).all()

    # Waist row: the bust row above scaled (it hangs), not the fitted waist ring's own shape.
    def radius(r):
        return np.linalg.norm(r[:, [0, 2]], axis=1)

    hung = radius(rings[1]) / radius(rings[0])
    fitted = radius(before[1]) / radius(before[0])
    assert hung.std() < 0.2 * fitted.std()


@pytest.fixture(scope="module")
def reference_shells(fitter):
    garments = GarmentService(fitter)
    body = fitter.fit(FitRequest(height_cm=172, weight_kg=65, sex="male"))
    posed = display_body(fitter.engine, body)
    shells = {}
    for product in garments.products.values():
        fit = garments.fit(
            GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
        ).response
        stops = {}
        for side in ("L", "R"):
            collider = cuff_collider(
                arm_profile(posed.mesh, posed.hand_routes[side]),
                config.CLOTH_CUFF_INNER_M,
                fit.layer_cm / 100,
                config.CLOTH_CONFIG["stretchMax"],
            )
            upper = float(np.linalg.norm(np.diff(posed.arm_centres[side][:2], axis=0)))
            stops[side] = upper + (collider.stop_distance_m or collider.distances_m[-1])
        shell = build_shell(product, "S", fit.sizes["S"], body, posed, fit.layer_cm / 100, stops)
        shells[product.style] = (product, fit, shell, posed)
    return shells


def test_shell_rest_reproduces_garment_tapes(reference_shells):
    for product, _fit, shell, _posed in reference_shells.values():
        size = product.sizes["S"]
        measured = shell_measurements(shell, product)
        assert abs(measured["chest"] - size.chest.value_cm) < 0.5
        for side in ("L", "R"):
            if not any("bicep" in w for w in shell.warnings):
                assert abs(measured[f"bicep_{side}"] - size.bicep.value_cm) < 0.5
            cuff = measured[f"cuff_{side}"] - config.CLOTH_CUFF_INNER_M * 100
            assert cuff > -0.5
            if cuff > 0.5:  # held open by the hand section: must be reported, never silent
                assert any(f"Sleeve {side} cuff opening" in w for w in shell.warnings)
        if not any("tighter than body" in w and "0.8" in w for w in shell.warnings):
            assert measured["hem"] >= size.hem.value_cm - 0.5


def test_shell_is_one_clean_connected_surface(reference_shells):
    for _product, _fit, shell, posed in reference_shells.values():
        cloth = trimesh.Trimesh(shell.initial, shell.faces, process=False)
        assert len(trimesh.graph.connected_components(cloth.edges)) == 1
        edges = cloth.edges_unique
        ratio = np.linalg.norm(
            shell.initial[edges[:, 0]] - shell.initial[edges[:, 1]], axis=1
        ) / np.linalg.norm(shell.rest[edges[:, 0]] - shell.rest[edges[:, 1]], axis=1)
        assert ratio.max() <= 1.10
        assert not any(panel_crossings(cloth, shell.panels).values())
        assert body_penetration(cloth, posed.mesh)["inside_samples"] == 0
        pairs, lengths = shell_tethers(shell)
        assert len(pairs) == len(lengths) and np.isfinite(lengths).all()


def _min_angle_deg(positions, faces):
    tri = positions[faces]
    worst = np.full(len(faces), 180.0)
    for k in range(3):
        a = tri[:, (k + 1) % 3] - tri[:, k]
        b = tri[:, (k + 2) % 3] - tri[:, k]
        cos = np.einsum("ij,ij->i", a, b) / (np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1))
        worst = np.minimum(worst, np.degrees(np.arccos(np.clip(cos, -1, 1))))
    return worst


def test_shell_exposes_the_zip_line_and_the_detachable_hood_seam(reference_shells):
    # Agent Z contract (L2): the CF zip line runs collar top -> hem with u = 0 on the torso and
    # collar charts; the removable hood (panel 7) meets the rest of the shell only on hood_zip.
    for product, _fit, shell, _posed in reference_shells.values():
        cf = np.array(shell.paths["center_front"])
        assert len(np.unique(cf)) == len(cf)
        assert np.isin(shell.panels[cf], [0, 1, 3, 6]).all()
        np.testing.assert_allclose(shell.uv[cf, 0], 0.0, atol=1e-9)
        assert cf[-1] in shell.paths["hem"]
        assert shell.initial[cf[0], 1] > shell.initial[cf[-1], 1]
        removable = product.visual.hood.value == "removable"
        assert ("hood_zip" in shell.paths) == removable
        if removable:
            zip_ids = set(shell.paths["hood_zip"])
            hood = shell.panels == 7
            assert not hood[list(zip_ids)].any()  # the zip row is the collar's top edge
            touching = shell.faces[hood[shell.faces].any(1)]
            outside = {int(i) for i in touching.ravel() if not hood[i]}
            assert outside <= zip_ids


def test_shell_sleeves_and_hood_root_have_no_slivers(reference_shells):
    # Before the ring-preserving push the caps had 0.26 mm edges and the hood root 0.45 deg
    # triangles (S2's report); measured after: sleeves >= 2.0 mm, hood root >= 4 deg.
    for _product, _fit, shell, _posed in reference_shells.values():
        cloth = trimesh.Trimesh(shell.initial, shell.faces, process=False)
        edges = cloth.edges_unique
        length = np.linalg.norm(shell.initial[edges[:, 0]] - shell.initial[edges[:, 1]], axis=1)
        sleeve = np.isin(shell.panels[edges], [4, 5]).all(1)
        assert length[sleeve].min() > 0.0015
        if shell.hood_grid is not None:
            root = set(shell.hood_grid[:2].ravel().tolist())
            faces = shell.faces[[set(f) <= root for f in shell.faces.tolist()]]
            assert len(faces) and _min_angle_deg(shell.initial, faces).min() > 3.0


def test_respace_sleeve_grades_cap_rows_on_their_columns():
    m, cap_rows = 8, 4
    theta = np.arange(m) * 2 * np.pi / m
    heights = np.r_[0.0, 0.10, 0.17, 0.19, 0.195, 0.20, 0.25]  # crowded next to the bicep ring
    grid = np.arange(len(heights) * m).reshape(len(heights), m)
    positions = np.concatenate(
        [np.c_[np.cos(theta), np.full(m, h), np.sin(theta)] for h in heights]
    )
    delta = np.zeros_like(positions)
    delta[:, 1] = positions[:, 1] * 2  # affine along the column: interpolated exactly
    out, out_delta = respace_sleeve(positions, delta, grid, cap_rows)
    # a 0.20 m column is long: even spacing (grading is for short underarm columns)
    graded = 0.20 * np.arange(1, 5) / 5
    np.testing.assert_allclose(out[grid[:, 0], 1], [0, *graded, 0.20, 0.25])
    np.testing.assert_allclose(out_delta[:, 1], out[:, 1] * 2)
    np.testing.assert_array_equal(out[grid[0]], positions[grid[0]])  # loop and bicep ring fixed
    np.testing.assert_array_equal(out[grid[cap_rows + 1 :]], positions[grid[cap_rows + 1 :]])
    # A short (underarm) column, 2 cm loop -> bicep ring: rows graded, longest gap at the loop.
    short = positions.copy()
    short[:, 1] *= 0.1
    out, _ = respace_sleeve(short, delta, grid, cap_rows)
    graded = 0.02 * (np.arange(1, 5) / 5) ** config.SHELL_CAP_ROW_GRADING
    np.testing.assert_allclose(out[grid[1:5, 0], 1], graded)


def test_fitted_ring_clip_flattens_the_sides_and_keeps_the_tape():
    # Hanging arms 2 cm outside a 20 cm square torso: the ring stays clear of them (side
    # flattened) and the 1.0 m tape goes front and back instead.
    angles = np.linspace(0, 2 * np.pi, 192, endpoint=False)
    free, d_free, _ = fitted_ring(square(), np.zeros(2), angles, 1.0, 0.004)
    ring, d, clamped = fitted_ring(square(), np.zeros(2), angles, 1.0, 0.004, (-0.12, 0.12))
    assert not clamped and abs(ring_perimeter(ring) - 1.0) < 1e-5
    assert np.abs(free[:, 0]).max() > 0.13 and np.abs(ring[:, 0]).max() <= 0.12 + 1e-9
    assert d > d_free and np.abs(ring[:, 1]).max() > np.abs(free[:, 1]).max()
    # A bound inside the body clearance yields to it (body + minimum wins).
    tight, _, _ = fitted_ring(square(), np.zeros(2), angles, 1.0, 0.004, (-0.101, 0.101))
    assert np.abs(tight[:, 0]).max() == pytest.approx(0.104, abs=1e-9)


def test_clip_polygon_x_matches_the_per_edge_sutherland_hodgman_loop():
    def reference(poly, low, high):
        for sign, bound in ((1.0, high), (-1.0, -low)):
            inside = sign * poly[:, 0] <= bound
            if inside.all():
                continue
            out = []
            for i in range(len(poly)):
                a, b = poly[i], poly[(i + 1) % len(poly)]
                if inside[i]:
                    out.append(a)
                if inside[i] != inside[(i + 1) % len(poly)]:
                    t = (bound - sign * a[0]) / (sign * (b[0] - a[0]))
                    out.append(a + t * (b - a))
            poly = np.array(out)
        return poly

    rng = np.random.default_rng(3)
    angles = np.linspace(0, 2 * np.pi, 40, endpoint=False)
    for _ in range(200):
        poly = np.c_[np.cos(angles), np.sin(angles)] * rng.uniform(0.05, 0.3, (40, 1))
        poly = poly[np.argsort(np.arctan2(poly[:, 1], poly[:, 0]))]
        low, high = np.sort(rng.uniform(-0.1, 0.1, 2))
        np.testing.assert_array_equal(clip_polygon_x(poly, low, high), reference(poly, low, high))


def test_closest_memo_returns_exactly_the_query_answer():
    body = trimesh.creation.icosphere(subdivisions=2)
    query = SurfaceQuery(body)
    memo = ClosestMemo(query)
    rng = np.random.default_rng(5)
    first = rng.normal(size=(50, 3))
    second = np.vstack((first[::2], rng.normal(size=(30, 3)), first[:3]))  # repeats + new
    for points in (first, second, first):
        for got, want in zip(memo.closest(points), query.closest(points), strict=True):
            np.testing.assert_array_equal(got, want)
    assert len(memo.distances) == 80  # each distinct point queried once


def test_untangle_state_reuse_equals_a_fresh_run(reference_shells):
    # Carrying the crossing pairs between calls re-tests only moved primitives; the result
    # must equal re-testing everything.
    for _product, _fit, shell, posed in reference_shells.values():
        faces, panels = shell.faces, shell.panels
        centre2 = np.array([0.0, float(shell.initial[:, 2].mean())])
        query = SurfaceQuery(posed.mesh)
        rng = np.random.default_rng(7)
        start = shell.initial + rng.normal(scale=0.002, size=shell.initial.shape)
        state: dict = {}
        once = untangle(start, faces, panels, centre2, posed.mesh, 0.0, query, state=state)
        assert state["hits"][0] is not None
        moved = once.copy()
        moved[::5] += 0.003
        np.testing.assert_array_equal(
            untangle(moved, faces, panels, centre2, posed.mesh, 0.0, query, state=state),
            untangle(moved, faces, panels, centre2, posed.mesh, 0.0, query),
        )


def test_clip_polygon_x_cuts_a_convex_polygon():
    poly = clip_polygon_x(square(), -0.05, np.inf)
    assert poly[:, 0].min() == pytest.approx(-0.05) and poly[:, 0].max() == pytest.approx(0.1)
    assert ring_perimeter(poly) == pytest.approx(0.2 * 2 + 0.15 * 2)


# Kiosk soak bodies (K3 run 2) that showed the defects (scripts/kiosk-soak.mjs inputs, scan
# skipped): cycle 18 female 178 cm/73 kg (wings on both jackets), cycle 1 male 5'6"/133 lb
# (parka wings), cycle 2 male 162 cm/57 kg (frayed puffer hem at XS), cycle 12 female
# 172 cm/67 kg (dark inside-out patches on the parka's upper sleeve).
DEFECT_BODIES = {
    "c18": ((178.0, 73.0, "female"), [("FB7675-100", "M"), ("DQ4920-206", "M")]),
    "c01": ((66 * 2.54, 133 * 0.45359237, "male"), [("FB7675-100", "M")]),
    "c02": ((162.0, 57.0, "male"), [("DQ4920-206", "XS")]),
    "c12": ((172.0, 67.0, "female"), [("FB7675-100", "M")]),
}


@pytest.fixture(scope="module")
def defect_shells(fitter):
    garments = GarmentService(fitter)
    by_style = {p.style: p for p in garments.products.values()}
    shells = []
    for (height, weight, sex), items in DEFECT_BODIES.values():
        body = fitter.fit(FitRequest(height_cm=height, weight_kg=weight, sex=sex))
        posed = display_body(fitter.engine, body)
        cache = ShellBodyCache(posed)
        for style, size in items:
            product = by_style[style]
            fit = garments.fit(
                GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
            ).response
            stops = _cuff_stops(posed, fit.layer_cm / 100)
            shell = build_shell(
                product, size, fit.sizes[size], body, posed, fit.layer_cm / 100, stops, cache
            )
            shells.append(
                (f"{sex} {height:.0f}/{weight:.0f} {style} {size}", product, shell, posed)
            )
    return shells


def _cuff_stops(posed, layer):
    stops = {}
    for side in ("L", "R"):
        collider = cuff_collider(
            arm_profile(posed.mesh, posed.hand_routes[side]),
            config.CLOTH_CUFF_INNER_M,
            layer,
            config.CLOTH_CONFIG["stretchMax"],
        )
        upper = float(np.linalg.norm(np.diff(posed.arm_centres[side][:2], axis=0)))
        stops[side] = upper + (collider.stop_distance_m or collider.distances_m[-1])
    return stops


def test_soak_bodies_have_no_wings_inverted_faces_or_frayed_hem(defect_shells):
    # Before G3: cycle 18 parka M flap 30 cm beyond the ease, 100s of inverted faces; puffer
    # hem bands drawn gathered at 10 % stretch.
    for label, product, shell, posed in defect_shells:
        report = shell_defects(
            shell.initial,
            shell.faces,
            shell.panels,
            shell.paths,
            posed.mesh,
            shell.elastic,
            posed.arm_faces,
        )
        assert report["flap"]["pass"], (label, report["flap"])
        assert report["inverted"]["pass"], (label, report["inverted"])
        assert report["hem"]["pass"], (label, report["hem"])
        size = product.sizes[shell_size(label)]
        measured = shell_measurements(shell, product)
        if not any("tighter than body" in w for w in shell.warnings):
            assert abs(measured["chest"] - size.chest.value_cm) < 0.5, label


def shell_size(label: str) -> str:
    return label.rsplit(" ", 1)[1]


def test_soak_body_shells_stay_clean(defect_shells):
    for label, _product, shell, posed in defect_shells:
        cloth = trimesh.Trimesh(shell.initial, shell.faces, process=False)
        # G4: the folded hood no longer crosses the yoke/back (160-260 crossings here before).
        crossings = panel_crossings(cloth, shell.panels)
        assert crossings == {"sleeve_torso": 0, "hood_back": 0}, (label, crossings)
        assert body_penetration(cloth, posed.mesh)["inside_samples"] == 0, label


# G4: heavy/short female grid bodies whose hanging arm presses on the torso below the armhole
# (arm-torso gap below torso clearance + separation + sleeve clearance). Before G4: puffer S
# 11 cm^2 visible inside-out underarm crease and 151 sleeve/torso crossings; parka XL chest
# ring 5.8 cm over its tape without a warning (the arm pushed it out).
PINCH_BODY = ((150.0, 110.0, "female"), [("DQ4920-206", "S"), ("FB7675-100", "XL")])


@pytest.fixture(scope="module")
def pinch_shells(fitter):
    garments = GarmentService(fitter)
    by_style = {p.style: p for p in garments.products.values()}
    (height, weight, sex), items = PINCH_BODY
    body = fitter.fit(FitRequest(height_cm=height, weight_kg=weight, sex=sex))
    posed = display_body(fitter.engine, body)
    cache = ShellBodyCache(posed)
    shells = []
    for style, size in items:
        product = by_style[style]
        fit = garments.fit(
            GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
        ).response
        stops = _cuff_stops(posed, fit.layer_cm / 100)
        shell = build_shell(
            product, size, fit.sizes[size], body, posed, fit.layer_cm / 100, stops, cache
        )
        shells.append((f"{style} {size}", product, shell, posed))
    return shells


def test_arm_pressing_on_the_torso_leaves_a_clean_underarm(pinch_shells):
    for label, product, shell, posed in pinch_shells:
        report = shell_defects(
            shell.initial,
            shell.faces,
            shell.panels,
            shell.paths,
            posed.mesh,
            shell.elastic,
            posed.arm_faces,
        )
        assert report["pass"], (label, report["inverted"], report["flap"])
        cloth = trimesh.Trimesh(shell.initial, shell.faces, process=False)
        crossings = panel_crossings(cloth, shell.panels)
        # Before G4 151 sleeve/torso crossings on puffer S; about 30 remain where the cap meets
        # the armhole bottom inside the pinched armpit (hidden: no visible patch above).
        assert crossings["sleeve_torso"] <= 40 and crossings["hood_back"] == 0, (label, crossings)
        assert any("presses on the torso" in w for w in shell.warnings), label
        size = product.sizes[shell_size(label)]
        if not any("tighter than body" in w for w in shell.warnings):
            assert abs(shell_measurements(shell, product)["chest"] - size.chest.value_cm) < 0.5


def test_funnel_collar_does_not_shrink_with_size(fitter):
    # L3 (agent H's report): the puffer's collar top / hood zip came out ~22 cm on the male
    # soak bodies and ~32 cm on the female reference. Cause: body, not size (the funnel's top
    # section reaches the jaw/chin and is held there; a forward-reaching ring leaves a short back
    # arc for the hood). Sizes without their own collar tape now use the owned size's funnel
    # (no grade assumed), so a larger size never has a narrower collar on any body.
    garments = GarmentService(fitter)
    product = next(p for p in garments.products.values() if p.style == "DQ4920-206")
    order = [s for s in ("XS", "S", "M", "L", "XL", "2XL") if s in product.sizes]
    for height, weight, sex in ((66 * 2.54, 133 * 0.45359237, "male"), (168.0, 62.0, "female")):
        body = fitter.fit(FitRequest(height_cm=height, weight_kg=weight, sex=sex))
        posed = display_body(fitter.engine, body)
        cache = ShellBodyCache(posed)
        fit = garments.fit(
            GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
        ).response
        stops = _cuff_stops(posed, fit.layer_cm / 100)
        tops, arcs = [], []
        for size in order:
            shell = build_shell(
                product, size, fit.sizes[size], body, posed, fit.layer_cm / 100, stops, cache
            )
            measured = shell_measurements(shell, product)
            tops.append(measured["collar_top"])
            zip_row = shell.rest[shell.paths["hood_zip"]]
            arcs.append(float(np.linalg.norm(np.diff(zip_row, axis=0), axis=1).sum()) * 100)
            if size != product.owned_size:
                assert any("Collar tape for" in w and "not measured" in w for w in shell.warnings)
        assert all(b >= a - 0.05 for a, b in zip(tops, tops[1:], strict=False)), tops
        assert all(b >= a - 0.05 for a, b in zip(arcs, arcs[1:], strict=False)), arcs


def test_dropped_shoulder_cap_is_drawn_in_the_body_chart(reference_shells):
    # L3: the parka's 60 cm shoulder tape puts the seam ~7.5 cm down the arm on the 172/65 body;
    # the cap above that seam ring is body panel in the render charts (positions unchanged).
    # The puffer's 1 cm drop leaves its seam at the armhole: no cap.
    for product, _fit, shell, _posed in reference_shells.values():
        for side in ("L", "R"):
            cap = shell.paths.get(f"dropped_cap_{side}", [])
            if product.style == "DQ4920-206":
                assert not cap
                continue
            assert cap
            assert (shell.panels[cap] == (4 if side == "L" else 5)).all()
            grid = shell.sleeve_grids[side]
            seam_row = int(np.flatnonzero((grid == shell.landmarks[f"seam_{side}"]).any(1))[0])
            assert np.isin(cap, grid[1 : seam_row + 1]).all()
            np.testing.assert_allclose(shell.material_v[cap], 0.0)
            assert (shell.quilt[cap, 2] == product.visual.yoke_depth.value_cm / 100).all()


def test_parka_stand_reaches_the_chin_and_the_funnel_covers_it(reference_shells):
    # CH, 2026-11-13. User: "fully zipped, the parka's collar top reaches the chin, no
    # higher" (its zip top sat 2 cm below the chin and the band rose beside the jaw to the ear
    # lobes). The puffer's funnel, zipped, covers the chin up to the lower lip (video 5-41 s;
    # V2's registered AR: a funnel top 4-6 cm below the lip did not match).
    for product, _fit, shell, posed in reference_shells.values():
        lm = posed.landmarks
        acromion = float((lm["acromion_L"][1] + lm["acromion_R"][1]) / 2)
        profile = trimesh.intersections.mesh_plane(posed.mesh, [1, 0, 0], [0, 0, 0]).reshape(-1, 3)
        head = profile[profile[:, 1] > acromion + 0.05]
        nose = head[np.argmax(head[:, 2])]
        lower = head[(head[:, 1] < nose[1] - 0.035) & (head[:, 1] > nose[1] - 0.09)]
        pogonion = lower[np.argmax(lower[:, 2])]
        chin = head[(head[:, 2] >= pogonion[2] - 0.02) & (head[:, 1] < pogonion[1])]
        menton = chin[np.argmin(chin[:, 1])]
        top = shell.initial[shell.paths["center_front"][0]]
        if product.visual.hood.value == "removable":
            assert top[1] > menton[1], (product.style, top, menton)
            continue
        assert menton[1] - 0.02 < top[1] < menton[1] + 0.01, (product.style, top, menton)
        ring = shell.initial[shell.paths["collar_top"][:-1]]
        front_sides = (np.abs(ring[:, 0]) > 0.75 * np.abs(ring[:, 0]).max()) & (
            ring[:, 2] > ring[:, 2].mean()
        )
        sides = ring[front_sides]
        assert sides[:, 1].max() < menton[1] + 0.04, (sides[:, 1].max(), menton)
