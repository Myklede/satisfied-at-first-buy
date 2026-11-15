"""Collar tape/section conventions; comfort thresholds await a larger worn study."""

COLLAR_FIT_VERSION = "neck-only-axis-section-v2"
# Anny 0.6.2 default MakeHuman rig. neck01 is the cervical base joint; the head
# bone's head is the upper cervical/head-base joint. These are skeletal datums,
# not a measured garment seam location. No anthropometric target enters them.
NECK_BONE_LABELS = ("neck01", "neck02", "neck03")
NECK_BASE_BONE = "neck01"
HEAD_BASE_BONE = "head"
# Prompt 09 A4b supplies the seam-position sensitivity band, not a confidence CI.
NECK_SENSITIVITY_BAND_CM = (5.0, 9.0)
NECK_BAND_STEP_CM = 0.5  # Report 5–9 cm in 5 mm increments.
NECK_SECTION_STEP_CM = 0.1  # 1 mm numerical search for the last closed neck-only ring.
NECK_AXIS_ENCLOSURE_EPS_M = 1e-9  # Floating-point point-in-hull tolerance only.
# Prompt 09 A4b's approved external-tape case passes the <=2 cm validation gate
# with the neck-only cap explicitly reported (see docs/STATUS.md). One case is
# not population calibration. No person's target is evaluated at runtime.
NECK_LABEL_VALIDATED = True
# Input sanity guards for adult jacket collar tapes, not anatomical fit thresholds.
INNER_RANGE_CM = (10.0, 100.0)
HEIGHT_RANGE_CM = (1.0, 30.0)
NECK_RANGE_CM = (10.0, 80.0)

# At/below zero ease the uncompressed tape cannot enclose the computed section.
# The comfort label is uncalibrated; no material-compression law is inferred.
TIGHT_EASE_MAX_CM = 0.0
# One worn/tape observation (2026-11-12): about +2 cm collar ease on a 35 cm collar
# felt "slightly tight". Including 2 cm in snug is supported by this one point;
# the boundary and all other values remain uncalibrated, not a fitted study.
SNUG_EASE_MAX_CM = 2.0
# Provisional engineering display boundary, not derived from anthropometry or
# validated comfort data. Never claim that >2 cm was measured comfortable.
REGULAR_EASE_MAX_CM = 4.0
