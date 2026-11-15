from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from .. import collar_config, config
from ..schemas import Number, Point, StrictModel
from .visual import ProductVisual

ProductId = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
SizeName = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$")]


class SourcedMeasurement(StrictModel):
    value_cm: Annotated[Number | None, Field(gt=0, le=300)] = None
    min_cm: Annotated[Number | None, Field(gt=0, le=300)] = None
    max_cm: Annotated[Number | None, Field(gt=0, le=300)] = None
    source: Literal["tape_measured", "retailer_chart", "web_lookup", "derived_grading"]
    source_detail: Annotated[str, Field(min_length=1, max_length=1000)]
    uncertainty_cm: Annotated[Number | None, Field(ge=0, le=100)] = None

    @model_validator(mode="after")
    def one_value_or_range(self) -> Self:
        scalar = self.value_cm is not None
        interval = self.min_cm is not None and self.max_cm is not None
        if scalar == interval or (scalar and (self.min_cm is not None or self.max_cm is not None)):
            raise ValueError("Provide one exact value or a complete range, never invent a midpoint")
        if interval and self.min_cm > self.max_cm:
            raise ValueError("min_cm must not exceed max_cm")
        return self


class GarmentSize(StrictModel):
    shoulder: SourcedMeasurement | None = None
    chest: SourcedMeasurement | None = None
    hem: SourcedMeasurement | None = None
    length_hps: SourcedMeasurement | None = None
    length_back: SourcedMeasurement | None = None
    sleeve: SourcedMeasurement | None = None
    bicep: SourcedMeasurement | None = None
    sleeve_cb: SourcedMeasurement | None = None
    chest_inner: SourcedMeasurement | None = None
    hem_inner: SourcedMeasurement | None = None
    collar_inner: SourcedMeasurement | None = None
    collar_height: SourcedMeasurement | None = None

    @model_validator(mode="after")
    def measured_collar_pair(self) -> Self:
        if (self.collar_inner is None) != (self.collar_height is None):
            raise ValueError("Collar inner tape and height must both be present or both absent")
        for name, limits in (
            ("collar_inner", collar_config.INNER_RANGE_CM),
            ("collar_height", collar_config.HEIGHT_RANGE_CM),
        ):
            value = getattr(self, name)
            if value is None:
                continue
            if value.source != "tape_measured" or value.value_cm is None:
                raise ValueError("Collar fields require exact measured garment tapes; no grading")
            if not limits[0] <= value.value_cm <= limits[1]:
                raise ValueError(f"{name} must be between {limits[0]} and {limits[1]} cm")
            if value.uncertainty_cm is not None and value.uncertainty_cm >= value.value_cm:
                raise ValueError("Collar uncertainty cannot imply a zero or negative dimension")
        return self


class BodyChartSize(StrictModel):
    chest: SourcedMeasurement | None = None
    waist: SourcedMeasurement | None = None
    hip: SourcedMeasurement | None = None


class Fabric(StrictModel):
    composition: Annotated[str, Field(min_length=1, max_length=1000)]
    elastane_pct: Annotated[Number | None, Field(ge=0, le=100)] = None
    stretch_max: Annotated[Number | None, Field(ge=1, le=3)] = None


class GarmentSpec(StrictModel):
    product_id: ProductId
    url: Annotated[str, Field(pattern=r"^https://[^\s]+$", max_length=2000)]
    brand: Annotated[str, Field(min_length=1, max_length=128)]
    category: Literal["jacket"]
    chart_type: Literal["garment", "body"]
    unit: Literal["cm"] = "cm"
    owned_size: SizeName | None = None
    sizes: Annotated[dict[SizeName, GarmentSize], Field(min_length=1, max_length=30)]
    fabric: Fabric
    notes: Annotated[str, Field(max_length=3000)] = ""
    title: Annotated[str, Field(max_length=200)] = ""
    style: Annotated[str, Field(max_length=100)] = ""
    colourway: Annotated[str, Field(max_length=100)] = ""
    url_aliases: list[Annotated[str, Field(pattern=r"^https://[^\s]+$", max_length=2000)]] = Field(
        default_factory=list, max_length=10
    )
    construction: Literal["set_in", "drop_shoulder", "raglan"] = "set_in"
    fit_intent: Literal["slim", "regular", "loose", "oversized"] = "regular"
    loft_cm: Annotated[Number | None, Field(ge=0, le=10)] = None
    loft_uncertainty_cm: Annotated[Number, Field(ge=0, le=2)] = 0.0
    hem_elastic: bool = False
    body_chart_type: Literal["body"] = "body"
    body_chart: dict[SizeName, BodyChartSize] = Field(default_factory=dict)
    visual: ProductVisual | None = None

    @model_validator(mode="after")
    def owned_exists(self) -> Self:
        if self.owned_size is not None and self.owned_size not in self.sizes:
            raise ValueError("Owned size must exist in sizes")
        if self.loft_cm is not None and self.loft_uncertainty_cm > self.loft_cm:
            raise ValueError("Loft uncertainty cannot imply negative thickness")
        return self


class GarmentFitRequest(StrictModel):
    body_id: ProductId
    product_id: ProductId
    layer_cm: Annotated[Number, Field(ge=0, le=2)] = config.LAYER_PRESETS_CM["t-shirt"]
    preference: Literal["fitted", "regular", "relaxed"] = "regular"


class ZoneMetric(StrictModel):
    value_cm: float | None = None
    lower_cm: float | None = None
    upper_cm: float | None = None
    metric: str
    status: Literal["tight", "fit", "relaxed", "too_big", "unknown"]
    explanation: str
    estimated: bool = False
    design_ease_cm: float | None = None
    position_vs_hip_cm: float | None = None


class SizeFit(StrictModel):
    size: str
    zones: dict[str, ZoneMetric]
    score: float | None
    coverage: float
    estimated: bool
    geometry_available: bool
    missing_fields: list[str]
    anchors: dict[str, Point]
    polylines: dict[str, list[Point]]
    warnings: list[str]
    build_ms: float | None = None
    elastic_zones: list[str] = Field(default_factory=list)


class GarmentFitResponse(StrictModel):
    fit_id: ProductId
    body_id: ProductId
    product_id: ProductId
    sizes: dict[str, SizeFit]
    recommended_size: str | None
    comparison_zones: list[str] = Field(default_factory=list)
    explanation: str
    layer_cm: float
    preference: str
    loft_cm: float | None
    loft_uncertainty_cm: float
    heatmap_tight_cm: float = config.HEATMAP_TIGHT_CM
    heatmap_loose_cm: float = config.HEATMAP_LOOSE_CM
    note: str


class GarmentOptions(StrictModel):
    layer_presets_cm: dict[str, float] = config.LAYER_PRESETS_CM
    preferences: list[str] = ["fitted", "regular", "relaxed"]
