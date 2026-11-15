from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import config, scan_config

Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Point = tuple[float, float, float]
ShapeReference = Literal["neutral", "african", "asian", "caucasian"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KnownMeasurements(StrictModel):
    chest_cm: Annotated[Number | None, Field(ge=45, le=200)] = None
    waist_cm: Annotated[Number | None, Field(ge=40, le=200)] = None
    hip_cm: Annotated[Number | None, Field(ge=50, le=200)] = None
    shoulder_width_cm: Annotated[Number | None, Field(ge=20, le=65)] = None
    shoulder_arc_cm: Annotated[Number | None, Field(ge=20, le=100)] = None
    arm_length_cm: Annotated[Number | None, Field(ge=30, le=100)] = None
    back_length_cm: Annotated[Number | None, Field(ge=25, le=80)] = None
    upper_arm_cm: Annotated[Number | None, Field(ge=12, le=70)] = None
    wrist_cm: Annotated[Number | None, Field(ge=10, le=35)] = None
    neck_base_cm: Annotated[Number | None, Field(ge=20, le=65)] = None


# --- Webcam scan soft constraints (milestone 3; constants in scan_config.py) ----------
ScanSigma = Annotated[
    Number,
    Field(ge=scan_config.SCAN_SIGMA_RANGE_CM[0], le=scan_config.SCAN_SIGMA_RANGE_CM[1]),
]


class ScanValue(StrictModel):
    """One @satisfy/vision ScanMeasurement: value and 1-sigma uncertainty in cm."""

    value_cm: Annotated[Number, Field(gt=0)]
    sigma_cm: ScanSigma
    method: Annotated[str, Field(max_length=400)] = ""


class ScanMeasurements(StrictModel):
    """Names match @satisfy/vision ScanMeasurementName. Fitted with weight 1/sigma^2."""

    shoulder_width_cm: ScanValue | None = None
    chest_cm: ScanValue | None = None
    waist_cm: ScanValue | None = None
    hip_cm: ScanValue | None = None
    arm_length_cm: ScanValue | None = None
    calibration: Annotated[str, Field(pattern=r"^[A-Za-z0-9_.:-]{1,64}$")] = "uncalibrated"

    @model_validator(mode="after")
    def physical_ranges(self) -> "ScanMeasurements":
        for name, (low, high) in scan_config.SCAN_VALUE_RANGES_CM.items():
            entry = getattr(self, name)
            if entry is not None and not low <= entry.value_cm <= high:
                raise ValueError(f"{name}.value_cm must be within {low}-{high} cm")
        return self

    def entries(self) -> dict[str, ScanValue]:
        return {
            name: entry
            for name in scan_config.SCAN_VALUE_RANGES_CM
            if (entry := getattr(self, name)) is not None
        }


class FitRequest(StrictModel):
    height_cm: Annotated[Number, Field(ge=120, le=220)]
    weight_kg: Annotated[Number, Field(ge=30, le=200)]
    sex: Literal["female", "male"]
    known_measurements: KnownMeasurements = Field(default_factory=KnownMeasurements)
    shape_reference: ShapeReference = "neutral"
    density_kg_m3: Literal[980.0, 1010.0] = config.DENSITY_KG_M3
    # Optional webcam scan: soft constraints weighted by 1/sigma^2 (fit.py, scan_config.py).
    scan_measurements: ScanMeasurements | None = None


class PersonData(FitRequest):
    person_id: Annotated[str, Field(pattern=r"^[a-zA-Z0-9_-]{1,48}$")]
    notes: Annotated[str, Field(max_length=2000)]


class MeasurementBand(StrictModel):
    lower_cm: float
    upper_cm: float
    accepted_samples: int
    attempted_samples: int
    method: str = "conditional phenotype ensemble q10-q90; not calibrated population confidence"


class Measurement(StrictModel):
    value_cm: float
    method: str
    uncertainty: MeasurementBand | None = None


class ScanFitEntry(StrictModel):
    value_cm: float
    sigma_cm: float
    fitted_cm: float
    residual_cm: float
    method: str


class ScanFitReport(StrictModel):
    """Records that, and how, a webcam scan influenced this body."""

    source: Literal["webcam_scan"] = "webcam_scan"
    calibration: str
    weighting: str
    entries: dict[str, ScanFitEntry]
    # Scan names ignored because a tape known_measurement of the same name wins.
    overridden_by_tape: list[str]
    # Body fitted from the same request without the scan (anchor of the soft solve).
    base_body_id: str


class FitResponse(StrictModel):
    body_id: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    phenotypes: dict[str, float]
    local_changes: dict[str, float]
    measurements: dict[str, Measurement]
    mass_kg: float
    volume_m3: float
    density_kg_m3: float = config.DENSITY_KG_M3
    targets: dict[str, float]
    residuals: dict[str, float]
    fit_ms: float
    converged: bool
    warnings: list[str]
    # Present only when scan_measurements were supplied; omitted otherwise so clients
    # that predate the scan keep parsing the response unchanged.
    scan: ScanFitReport | None = Field(default=None, exclude_if=lambda value: value is None)


class LandmarkResponse(StrictModel):
    coordinate_frame: Literal["metres Y-up +Z-front A-pose"] = "metres Y-up +Z-front A-pose"
    landmarks: dict[str, Point]
    girth_polylines: dict[str, list[Point]]


class UncertaintyResponse(StrictModel):
    bands: dict[str, MeasurementBand | None]
    accepted_samples: int
    attempted_samples: int
    compute_ms: float
    note: str


class HealthResponse(StrictModel):
    model_loaded: bool
    anny_version: str
    engine_version: str


class CapabilitiesResponse(StrictModel):
    phenotype_labels: list[str]
    shape_reference_supported: bool
    shape_references: list[ShapeReference]
    measurements: list[str]
    default_density_kg_m3: Literal[980.0, 1010.0] = config.DENSITY_KG_M3


class ForgetResponse(StrictModel):
    """Kiosk reset result: how many in-memory cache entries were removed."""

    body_id: str
    removed: dict[str, int]
