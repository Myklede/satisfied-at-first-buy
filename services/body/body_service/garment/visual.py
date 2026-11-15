"""Sourced appearance inputs, independent of measured product identity."""

from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from ..schemas import Number, StrictModel

VisualSource = Literal["retailer_copy", "photo_estimate", "model_assumption"]


class VisualFact(StrictModel):
    value: Annotated[str, Field(min_length=1, max_length=200)]
    source: VisualSource
    approximate: bool
    source_detail: Annotated[str, Field(min_length=1, max_length=1200)]


class VisualMeasure(StrictModel):
    value_cm: Annotated[Number, Field(gt=0, le=200)]
    source: VisualSource
    approximate: bool
    uncertainty_cm: Annotated[Number, Field(ge=0, le=100)]
    source_detail: Annotated[str, Field(min_length=1, max_length=1200)]


class ProductVisual(StrictModel):
    quilting: VisualFact
    chamber_height: VisualMeasure
    chamber_width: VisualMeasure | None = None
    yoke_depth: VisualMeasure
    sleeve_chamber_height: VisualMeasure
    hood: VisualFact
    hood_features: list[VisualFact]
    front: VisualFact
    storm_flap_width: VisualMeasure | None = None
    pockets: VisualFact
    pocket_top: VisualMeasure | None = None
    pocket_length: VisualMeasure | None = None
    cuffs: VisualFact
    hem: VisualFact
    finish: VisualFact
    colour_hex: VisualFact
    logo: Literal["omitted"] = "omitted"

    @model_validator(mode="after")
    def feature_kinds(self) -> Self:
        for name, choices in {
            "quilting": {"box", "horizontal"},
            "hood": {"attached", "removable"},
            "front": {"two_way_zip", "storm_flap"},
            "pockets": {"vertical_zip", "angled_welt"},
            "cuffs": {"inner_elastic", "hook_and_loop"},
            "hem": {"open", "elastic"},
            "finish": {"satin_matte", "glossy_ripstop"},
        }.items():
            if getattr(self, name).value not in choices:
                raise ValueError(f"Unsupported {name} visual feature")
        import re

        if re.fullmatch(r"#[0-9a-fA-F]{6}", self.colour_hex.value) is None:
            raise ValueError("Colour must be a six-digit approximate hex colour")
        return self
