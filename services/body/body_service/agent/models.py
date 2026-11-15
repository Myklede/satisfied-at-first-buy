"""Fit Agent API and extraction models. Validated at the boundary; unknown fields are rejected."""

from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from ..garment.models import SizeName
from ..schemas import FitRequest, Number, StrictModel
from . import agent_config as ac

Asin = Annotated[str, Field(pattern=r"^[A-Z0-9]{10}$")]
Short = Annotated[str, Field(max_length=ac.MAX_CELL_CHARS)]
Zone = Literal["shoulder", "chest", "hem", "sleeve", "bicep", "collar"]
Status = Literal["tight", "fit", "relaxed", "too_big", "unknown"]
ChartField = Literal[
    "chest", "waist", "hip", "hem", "shoulder", "sleeve", "sleeve_cb", "length", "bicep"
]
Category = Literal[
    "jacket", "coat", "hoodie", "sweatshirt", "t-shirt", "shirt", "polo", "sweater", "top"
]
Answer = Literal["tight", "right", "loose"]


# --- Page content sent by the extension (product content only, never body data) -----------
class PageTable(StrictModel):
    heading: Annotated[str, Field(max_length=300)] = ""
    rows: Annotated[
        list[Annotated[list[Short], Field(max_length=ac.MAX_TABLE_COLS)]],
        Field(min_length=1, max_length=ac.MAX_TABLE_ROWS),
    ]


class PageContent(StrictModel):
    asin: Asin
    url: Annotated[str, Field(pattern=r"^https://www\.amazon\.com/[^\s]*$", max_length=2000)]
    title: Annotated[str, Field(max_length=400)] = ""
    brand: Annotated[str, Field(max_length=200)] = ""
    bullets: Annotated[list[Annotated[str, Field(max_length=1000)]], Field(max_length=20)] = []
    description: Annotated[str, Field(max_length=ac.MAX_TEXT_CHARS)] = ""
    size_options: Annotated[list[Short], Field(max_length=40)] = []
    tables: Annotated[list[PageTable], Field(max_length=ac.MAX_TABLES)] = []
    # How the chart got into the DOM: already present, or the content script opened Amazon's
    # "Size chart" popover itself.
    chart_origin: Literal["in_dom", "popover_opened", "not_found", "saved_page"] = "in_dom"


# --- Extraction (one shape for reviewed files, rules and LLM output) ----------------------
class ChartValue(StrictModel):
    """A chart cell in the chart's own unit, exactly as printed (checked against the page)."""

    value: Annotated[Number | None, Field(gt=0, le=300)] = None
    min: Annotated[Number | None, Field(gt=0, le=300)] = None
    max: Annotated[Number | None, Field(gt=0, le=300)] = None
    raw: Short = ""

    @model_validator(mode="after")
    def one_value_or_range(self) -> Self:
        scalar = self.value is not None
        interval = self.min is not None and self.max is not None
        if scalar == interval or (scalar and (self.min is not None or self.max is not None)):
            raise ValueError("Give one value or a complete min/max range")
        if interval and self.min > self.max:
            raise ValueError("min must not exceed max")
        return self

    def numbers(self) -> list[float]:
        return [v for v in (self.value, self.min, self.max) if v is not None]


class ExtractedSize(StrictModel):
    name: SizeName
    measurements: dict[ChartField, ChartValue]


class Provenance(StrictModel):
    source: Literal["reviewed", "rules", "llm"]
    provider: Annotated[str, Field(max_length=40)] | None = None
    extracted_by: Annotated[str, Field(min_length=1, max_length=200)]
    reviewed: bool = False
    date: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}")]
    source_page: Annotated[str, Field(pattern=r"^[^/\\:*?\"<>|]{1,200}$")] | None = None


class Extraction(StrictModel):
    asin: Asin
    title: Annotated[str, Field(max_length=400)] = ""
    brand: Annotated[str, Field(max_length=200)] = ""
    category: Category
    chart_type: Literal["garment", "body"]
    unit: Literal["cm", "in"]
    # Columns printed as a half-width laid flat ("pit to pit", "1/2 chest"); doubled in code.
    flat_fields: list[ChartField] = []
    fit_intent: Literal["slim", "regular", "loose", "oversized"] = "regular"
    construction: Literal["set_in", "drop_shoulder", "raglan"] = "set_in"
    fabric: Annotated[str, Field(max_length=1000)] = ""
    sizes: Annotated[list[ExtractedSize], Field(min_length=1, max_length=30)]
    headers: dict[ChartField, Short] = {}
    evidence: Annotated[list[Annotated[str, Field(max_length=300)]], Field(max_length=20)] = []
    assumptions: Annotated[list[Annotated[str, Field(max_length=300)]], Field(max_length=20)] = []
    provenance: Provenance

    @model_validator(mode="after")
    def unique_sizes(self) -> Self:
        names = [size.name for size in self.sizes]
        if len(set(names)) != len(names):
            raise ValueError("Duplicate size names")
        if self.provenance.reviewed and self.provenance.source != "reviewed":
            raise ValueError("Only reviewed extractions may set reviewed=true")
        return self


class ReviewedExtraction(Extraction):
    """File format of data/amazon-pages/reviewed/<ASIN>.json (schema: fit-agent-extraction)."""

    @model_validator(mode="after")
    def reviewed_provenance(self) -> Self:
        p = self.provenance
        if p.source != "reviewed" or not p.reviewed or p.source_page is None:
            raise ValueError(
                "A reviewed extraction needs source=reviewed, reviewed=true, source_page"
            )
        return self


# --- Body: opt-in profile or a per-request session body -----------------------------------
class ProfileBody(StrictModel):
    mode: Literal["profile"]


class SessionBody(StrictModel):
    mode: Literal["session"]
    fit_request: FitRequest


class FitChoices(StrictModel):
    preference: Literal["fitted", "regular", "relaxed"] = "regular"
    layer: Literal["t-shirt", "hoodie"] = "t-shirt"


class ExtractRequest(StrictModel):
    page: PageContent
    chart_type_override: Literal["garment", "body"] | None = None


class RecommendRequest(FitChoices):
    page: PageContent
    body: ProfileBody | SessionBody = Field(discriminator="mode")
    chart_type_override: Literal["garment", "body"] | None = None


class CompareRequest(FitChoices):
    asins: Annotated[list[Asin], Field(min_length=2, max_length=2)]
    body: ProfileBody | SessionBody = Field(discriminator="mode")


class ProfileIn(StrictModel):
    consent: Literal[True]  # opt-in is explicit
    fit_request: FitRequest
    choices: FitChoices = FitChoices()


class ZoneSnapshot(StrictModel):
    status: Status
    value_cm: Annotated[Number | None, Field(ge=-100, le=100)] = None


class PurchaseIn(StrictModel):
    asin: Asin
    size: SizeName
    title: Annotated[str, Field(max_length=400)] = ""


class FeedbackIn(StrictModel):
    purchase_id: Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]
    answers: Annotated[dict[Zone, Answer], Field(min_length=1)]

    @model_validator(mode="after")
    def learning_supported(self) -> Self:
        if any(zone not in ac.FEEDBACK_ZONES for zone in self.answers):
            raise ValueError("Collar preference learning is not calibrated; collar is display-only")
        return self


# --- Responses --------------------------------------------------------------------------
class TraceStep(StrictModel):
    step: Literal["read_page", "classify_chart", "compute_fit", "choose", "explain"]
    status: Literal["done", "skipped", "failed"]
    detail: str


class ZoneView(StrictModel):
    zone: Zone
    label: str
    status: Status
    value_cm: float | None
    value_in: float | None
    metric: str
    adjusted_status: Status | None = None
    adjusted_value_cm: float | None = None
    personal_offset_cm: float = 0.0
    estimated: bool
    text: str
    display_delta_cm: float | None = None
    display_scale_cm: float | None = None


class SizeView(StrictModel):
    size: str
    score: float | None
    coverage: float
    zones: list[ZoneView]
    estimated_garment_cm: dict[str, list[float]] = {}


class ExtractionView(StrictModel):
    extraction: Extraction
    source_label: str
    garment_estimated: bool
    notes: list[str]


class RecommendResponse(StrictModel):
    asin: str
    title: str
    recommended_size: str | None
    sizes: list[SizeView]
    comparison_zones: list[str]
    explanation: list[str]
    trace: list[TraceStep]
    extraction: ExtractionView
    personal_offsets_cm: dict[str, float]
    preference: str
    layer: str
    three_d: dict[str, str] | None = None


class CompareResponse(StrictModel):
    products: list[RecommendResponse]
    summary: list[str]
