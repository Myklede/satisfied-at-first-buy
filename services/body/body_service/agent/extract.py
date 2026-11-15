"""Size-chart resolution: reviewed cache → rules parser → LLM (claude_cli, then paid if allowed).

Every result says which source answered ("reviewed extraction" / "rules" / "LLM (provider)"),
and every number in it must be printed on the page.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from pydantic import ValidationError

from . import agent_config as ac
from . import store
from .models import (
    ChartValue,
    ExtractedSize,
    Extraction,
    PageContent,
    Provenance,
    TraceStep,
)
from .numbers import all_numbers, printed
from .pagetext import page_content_text
from .providers import PROVIDERS, LLMProvider, ProviderFailed, ProviderUnavailable
from .rules import ChartNotFound, ChartUnclear, canonical_size, parse_rules


class ExtractionFailed(ValueError):
    def __init__(
        self, message: str, trace: list[TraceStep], notes: list[str], unclear: bool
    ) -> None:
        super().__init__(message)
        self.trace, self.notes, self.unclear = trace, notes, unclear


@dataclass
class Resolved:
    extraction: Extraction
    label: str
    trace: list[TraceStep]
    notes: list[str] = field(default_factory=list)


def page_hash(page: PageContent) -> str:
    return hashlib.sha256(
        json.dumps(page.model_dump(mode="json"), sort_keys=True).encode()
    ).hexdigest()


def missing_numbers(extraction: Extraction, page_text: str) -> list[str]:
    """Every chart number must be printed in the page text; returns those that are not."""
    numbers = all_numbers(page_text)
    missing = []
    for size in extraction.sizes:
        for name, value in size.measurements.items():
            for number in value.numbers():
                if not printed(number, numbers):
                    missing.append(f"{size.name}.{name}={number:g}")
    return missing


def from_llm(raw: dict[str, Any], page: PageContent, provider: str) -> Extraction:
    """Validate structured LLM output into an Extraction (schema + every number on the page)."""
    if not raw.get("found"):
        raise ChartNotFound("The LLM found no size chart on the page")
    if raw.get("category") == "unsupported":
        raise ChartUnclear("The LLM classified the product as not an upper-body top")
    if raw.get("chart_type") == "unclear":
        raise ChartUnclear("The LLM could not tell whether this is a body or a garment chart")
    sizes = []
    excluded = 0
    for item in raw.get("sizes", []):
        # Same regular-size recognition as the rules table path. Never strip a variant suffix
        # or turn an unknown row into a different size to satisfy the API name pattern.
        name = canonical_size(str(item.get("name", "")))
        if name is None:
            excluded += 1
            continue
        measurements = {}
        for m in item.get("measurements", []):
            measurements[m["field"]] = ChartValue(
                value=m.get("value"),
                min=m.get("min"),
                max=m.get("max"),
                raw=str(m.get("raw", ""))[: ac.MAX_CELL_CHARS],
            )
        sizes.append(ExtractedSize(name=name, measurements=measurements))
    if not sizes:
        raise ChartUnclear("The LLM returned no recognizable regular sizes; variant sizes refused")
    extraction = Extraction(
        asin=page.asin,
        title=page.title,
        brand=page.brand,
        category=raw["category"],
        chart_type=raw["chart_type"],
        unit=raw["unit"],
        flat_fields=raw.get("flat_fields", []),
        fit_intent=raw.get("fit_intent", "regular"),
        construction=raw.get("construction", "set_in"),
        fabric=str(raw.get("fabric", ""))[:1000],
        sizes=sizes,
        headers={h["field"]: str(h["header"])[: ac.MAX_CELL_CHARS] for h in raw.get("headers", [])},
        evidence=[str(e)[:300] for e in raw.get("evidence", [])][:20],
        assumptions=["Read by an LLM; every number was checked against the page text"]
        + (
            [f"Excluded {excluded} variant or unrecognized size rows; regular sizes only"]
            if excluded
            else []
        ),
        provenance=Provenance(
            source="llm", provider=provider, extracted_by=provider, date=date.today().isoformat()
        ),
    )
    missing = missing_numbers(extraction, page_content_text(page))
    if missing:
        raise ProviderFailed(
            "LLM output has numbers not printed on the page: " + ", ".join(missing[:8])
        )
    return extraction


def _summary(extraction: Extraction) -> str:
    fields = sorted({f for s in extraction.sizes for f in s.measurements})
    return (
        f"{len(extraction.sizes)} sizes ({', '.join(s.name for s in extraction.sizes)}) × "
        f"{', '.join(fields)} in {extraction.unit}"
    )


def resolve(
    page: PageContent,
    chart_type_override: str | None = None,
    providers: dict[str, LLMProvider] | None = None,
) -> Resolved:
    trace = [
        TraceStep(
            step="read_page",
            status="done",
            detail=f"ASIN {page.asin}: {len(page.tables)} table(s), {len(page.size_options)} size "
            f"option(s), chart {page.chart_origin.replace('_', ' ')}",
        )
    ]
    notes: list[str] = []

    def classified(extraction: Extraction, label: str) -> Resolved:
        why = "; ".join(extraction.evidence[:3]) or "no printed evidence"
        trace.append(
            TraceStep(
                step="classify_chart",
                status="done",
                detail=f"{extraction.chart_type.upper()} chart via {label}: "
                f"{_summary(extraction)}. "
                f"Evidence: {why}",
            )
        )
        return Resolved(extraction, label, trace, notes)

    # 1. Reviewed extraction (checked by hand against the saved page).
    reviewed = store.load_reviewed(page.asin)
    if reviewed is not None:
        if chart_type_override and chart_type_override != reviewed.chart_type:
            notes.append(
                "Reviewed extraction kept; the chart-type choice applies to rules/LLM only"
            )
        return classified(reviewed, "reviewed extraction")

    # 2. Rules parser.
    unclear = False
    try:
        extraction = parse_rules(page, chart_type_override)
        store.cache_extraction(page, extraction, "rules", page_hash(page))
        return classified(extraction, "rules")
    except ChartUnclear as error:
        unclear = True
        notes.append(f"rules: {error}")
    except ChartNotFound as error:
        notes.append(f"rules: {error}")

    # 3. Cached LLM answer for this exact page content.
    cached = store.cached_extraction(page.asin)
    digest = page_hash(page)
    if cached is not None and cached[3] == digest and cached[2].startswith("LLM"):
        return classified(cached[1], f"{cached[2]}, cached")

    # 4. LLM providers in order (claude_cli first; paid ones only if explicitly enabled).
    pool = (
        providers
        if providers is not None
        else {name: PROVIDERS[name]() for name in ac.PROVIDER_ORDER}
    )
    for name in ac.PROVIDER_ORDER:
        provider = pool.get(name)
        if provider is None:
            continue
        try:
            raw = provider.extract(page)
            extraction = from_llm(raw, page, name)
            if chart_type_override:
                extraction = extraction.model_copy(update={"chart_type": chart_type_override})
            label = f"LLM ({name})"
            store.cache_extraction(page, extraction, label, digest)
            return classified(extraction, label)
        except ProviderUnavailable as error:
            notes.append(f"{name}: {error}")
        except (
            ProviderFailed,
            ChartNotFound,
            ChartUnclear,
            ValidationError,
            KeyError,
            TypeError,
        ) as error:
            unclear = unclear or isinstance(error, ChartUnclear)
            notes.append(f"{name}: failed ({str(error)[:200]}); fell back")
    trace.append(TraceStep(step="classify_chart", status="failed", detail="; ".join(notes)))
    raise ExtractionFailed("No usable size chart: " + "; ".join(notes), trace, notes, unclear)


def resolve_cached(asin: str) -> Resolved:
    """For compare: a product already read on this machine (reviewed file or extraction cache)."""
    reviewed = store.load_reviewed(asin)
    if reviewed is not None:
        return Resolved(reviewed, "reviewed extraction", [])
    cached = store.cached_extraction(asin)
    if cached is None:
        raise KeyError(asin)
    return Resolved(cached[1], cached[2], [])


def cached_page(asin: str) -> PageContent | None:
    cached = store.cached_extraction(asin)
    return cached[0] if cached else None
