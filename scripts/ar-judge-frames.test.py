"""Tests for scripts/ar-judge-frames.py helpers: py scripts/ar-judge-frames.test.py"""

import importlib.util
import os
import unittest

import numpy as np

_spec = importlib.util.spec_from_file_location(
    "judge_frames", os.path.join(os.path.dirname(__file__), "ar-judge-frames.py")
)
jf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(jf)


class CanvasMode(unittest.TestCase):
    def test_overlay_is_never_inferred_from_pixels(self):
        # CX-DAY HIGH: a black border (or a bright person) must not switch to overlay mode
        overlay, note = jf.canvas_mode("composite", 3.0)
        self.assertFalse(overlay)
        self.assertIn("WARNING", note)

    def test_declared_overlay(self):
        self.assertEqual(jf.canvas_mode("overlay", 200.0), (True, None))

    def test_composite_normal_border(self):
        self.assertEqual(jf.canvas_mode("composite", 80.0), (False, None))


class Cadence(unittest.TestCase):
    def test_no_gap_across_disjoint_windows(self):
        rows = [{"i": 0, "t": 1.0, "distinct": True}, {"i": 1, "t": 1.05, "distinct": True},
                {"i": 50, "t": 9.0, "distinct": True}, {"i": 51, "t": 9.06, "distinct": True}]
        c = jf.cadence(rows)
        self.assertEqual(c["distinctGapMs"]["n"], 2)
        self.assertLess(c["distinctGapMs"]["max"], 100)


class Glitches(unittest.TestCase):
    def test_list_is_json_serialisable_with_numpy_times(self):
        import json
        fr = [{"i": k, "t": np.float64(k * 0.1), "distinct": True, "jacketPresent": 0.8, "jacketStrength": 50.0,
               "flickerPct": 0.0, "holePx": 0, "interiorPx": None, "cx": 100.0, "cy": 100.0} for k in range(30)]
        fr[20]["jacketPresent"] = 0.01
        g = jf.glitch_list(fr, 50.0)
        self.assertEqual([x["t"] for x in g], [fr[20]["t"]])
        json.dumps(g)  # must not raise (numpy bool)


class Wobble(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(3)
        self.p0 = rng.uniform(100, 300, (80, 2)).astype(np.float32)

    def test_rigid_motion_has_no_residual(self):
        th, s = np.deg2rad(3), 1.02
        R = s * np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
        p1 = (self.p0 @ R.T + np.array([4.0, -2.0])).astype(np.float32)
        rms, scale = jf.nonrigid(self.p0, p1)
        self.assertLess(rms, 0.05)
        self.assertAlmostEqual(scale, 2.0, places=1)

    def test_jelly_has_residual(self):
        p1 = self.p0.copy()
        p1[:, 0] += 3.0 * np.sin(self.p0[:, 1] / 15.0)  # wavy, non-rigid
        rms, _ = jf.nonrigid(self.p0, p1.astype(np.float32))
        self.assertGreater(rms, 1.0)

    def test_run_width_ignores_a_separate_arm(self):
        J = np.zeros((10, 40), bool)
        J[5, 10:20] = True  # torso
        J[5, 25:30] = True  # arm, separate run
        self.assertEqual(jf.run_width(J, 5, 15), 10)
        self.assertIsNone(jf.run_width(J, 5, 22))

    def test_zipper_bend(self):
        A = np.full((200, 200), 220, np.uint8)
        Jf = np.ones((200, 200), bool)
        tor = np.array([(60, 20), (140, 20), (140, 180), (60, 180)], np.int32)
        A[20:180, 99:102] = 10  # straight zip
        self.assertLess(jf.zipper_bend(A, Jf, tor), 0.5)
        B = np.full((200, 200), 220, np.uint8)
        for y in range(20, 180):
            x = int(100 + 4 * np.sin((y - 20) / 160 * 2 * np.pi))  # S-bend
            B[y, x - 1 : x + 2] = 10
        self.assertGreater(jf.zipper_bend(B, Jf, tor), 1.2)

    def test_too_few_points(self):
        self.assertIsNone(jf.nonrigid(self.p0[:5], self.p0[:5]))

    def test_highpass(self):
        t = np.arange(0, 3, 1 / 15)
        slow = 50 + 5 * np.sin(2 * np.pi * 0.5 * t)
        fast = slow + 2 * np.sin(2 * np.pi * 6 * t)
        self.assertLess(jf.highpass_rms(t, slow), 0.4)
        self.assertGreater(jf.highpass_rms(t, fast), 1.0)


class Stats(unittest.TestCase):
    def test_missing_is_none(self):
        self.assertIsNone(jf.stats([]))
        self.assertIsNone(jf.stats([None, float("nan")]))
        self.assertEqual(jf.stats([1.0, 3.0])["median"], 2.0)


if __name__ == "__main__":
    unittest.main()
