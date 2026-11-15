"""Webcam-scan soft-constraint constants (kept apart from config.py on purpose).

Scan values arrive from @satisfy/vision with a 1-sigma uncertainty. They are fitted as
soft residuals ((measured - value) / sigma)^2, i.e. weighted by 1/sigma^2, next to the
hard height/mass targets. Tape `known_measurements` keep their stronger tolerance
scale (config.GIRTH_TOLERANCE). See docs/MEASUREMENTS.md "Webcam scan constraints".
None of the values below is calibrated against people; each is labelled.
"""

SCAN_SOURCE = "webcam_scan"

# Physical value ranges (cm) per scan measurement. Same ranges as KnownMeasurements in
# schemas.py so a scan can never request a body a tape value could not.
SCAN_VALUE_RANGES_CM: dict[str, tuple[float, float]] = {
    "shoulder_width_cm": (20.0, 65.0),
    "chest_cm": (45.0, 200.0),
    "waist_cm": (40.0, 200.0),
    "hip_cm": (50.0, 200.0),
    "arm_length_cm": (30.0, 100.0),
}

# Sigma bounds. @satisfy/vision never sends sigma < 0.1 cm (scan.ts clamps to 0.1).
# The upper bound only rejects absurd payloads; a very large sigma is valid and simply
# carries almost no weight (tests use 1e4 cm to prove it reproduces the no-scan body).
SCAN_SIGMA_RANGE_CM = (0.1, 1.0e5)

# The scan solve starts from the no-scan body (same height/weight/sex/tapes) and releases
# the shape coordinates the scan can inform. A Gaussian anchor to that body keeps the
# solution continuous: as every sigma -> infinity the scan terms vanish and the anchor's
# minimum is the no-scan body itself. Units: sigmoid phenotype units [0,1] and Anny
# local-change units [-1,1]. Heuristic widths (not population statistics): wide enough
# that a 2 cm-sigma scan visibly moves shoulders/chest, narrow enough to stop the
# released coordinates drifting where the scan says nothing.
SCAN_ANCHOR_PHENOTYPE_SIGMA = 0.25
SCAN_ANCHOR_LOCAL_SIGMA = 0.5

# Uncertainty ensemble: a sample is consistent with the scan when every scan value is
# within this many sigmas (but never tighter than config.GIRTH_TOLERANCE). 2 sigma keeps
# ~95 % of a Gaussian; heuristic, matching the q10-q90 band's sensitivity framing.
SCAN_UNCERTAINTY_ACCEPT_SIGMAS = 2.0
