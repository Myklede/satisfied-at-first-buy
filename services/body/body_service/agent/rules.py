"""Deterministic size-chart parser for HTML tables (provider "none"/rules). No network, no LLM.

It finds the size table, maps column headers to chart fields, detects the unit, doubles flat
half-width columns, and classifies the chart as GARMENT or BODY measurements from printed
evidence (KE-HOACH-KY-THUAT §4.2: many Amazon charts are body charts). When the evidence does
not decide, it raises ChartUnclear instead of guessing.
"""

from __future__ import annotations

import re
from datetime import date
from statistics import median

from . import agent_config as ac
from .models import (
    ChartField,
    ChartValue,
    ExtractedSize,
    Extraction,
    PageContent,
    PageTable,
    Provenance,
)
from .numbers import parse_cell

RULES_VERSION = "rules-v1"


class ChartNotFound(ValueError):
    """No table on the page looks like a size chart."""


class ChartUnclear(ValueError):
    """A size chart was found but garment-vs-body (or the unit) cannot be decided from the page."""

    def __init__(self, message: str, partial: dict | None = None) -> None:
        super().__init__(message)
        self.partial = partial or {}


_SIZE_WORDS = [
    (r"^(?:xxxxx-?large|5x-?large|5xl|5x)$", "5XL"),
    (r"^(?:xxxx-?large|4x-?large|4xl|4x)$", "4XL"),
    (r"^(?:xxx-?large|3x-?large|3xl|3x|xxxl)$", "3XL"),
    (r"^(?:xx-?large|2x-?large|2xl|2x|xxl)$", "2XL"),
    (r"^(?:x-?large|extra[- ]large|xl)$", "XL"),
    (r"^(?:large|l|lg)$", "L"),
    (r"^(?:medium|m|md|med)$", "M"),
    (r"^(?:small|s|sm)$", "S"),
    (r"^(?:x-?small|extra[- ]small|xs)$", "XS"),
    (r"^(?:xx-?small|2x-?small|xxs|2xs)$", "XXS"),
]


def canonical_size(label: str) -> str | None:
    """'X-Large' → 'XL', 'XX-Large' → '2XL', 'M' → 'M', '10' → '10'; None if not a size label.

    The extension uses the same table (apps/extension/src/sizes.ts) to match chart rows to the
    page's size selector.
    """
    text = re.sub(r"\s+", " ", label).strip().lower()
    # Check before dropping annotations: M (Tall) is NOT the regular M row.
    if re.search(r"(?<![a-z])(?:tall|big|petite|long)(?![a-z])", text):
        return None
    text = re.sub(r"\s*\(.*?\)\s*", "", text)  # "M (38-40)" → "m"
    text = re.sub(r"\b(?:us|uk|eu|size)\b[: ]*", "", text).strip()
    for pattern, name in _SIZE_WORDS:
        if re.fullmatch(pattern, text):
            return name
    if re.fullmatch(r"\d{1,2}(?:\.\d)?", text):
        return text
    return None


_FIELDS: list[tuple[ChartField, str]] = [
    ("sleeve_cb", r"(?:center|centre)\s*back|\bcb\b|back\s*neck\s*to|neck\s*to\s*(?:wrist|cuff)"),
    ("bicep", r"bicep|upper\s*arm|sleeve\s*width|arm\s*width"),
    ("shoulder", r"shoulder"),
    ("sleeve", r"sleeve|arm\s*length"),
    ("chest", r"chest|bust|pit\s*to\s*pit|\bp2p\b|\bbreast"),
    ("waist", r"waist"),
    ("hip", r"\bhips?\b|\bseat\b"),
    ("hem", r"\bhem\b|bottom\s*width|sweep"),
    ("length", r"length|\blong\b|\bhps\b"),
]
_IGNORE = r"height|weight|neck|collar|inseam|\bage\b|\bus\b|\buk\b|\beu\b|cup"
_FLAT = r"1/2|½|half|\bflat\b|pit\s*to\s*pit|\bp2p\b|laid"
_BODY_WORDS = [
    (r"body\s*measure", "says 'body measurements'"),
    (r"\bto\s*fit\b|\bfits?\s+(?:chest|bust|waist)", "says 'to fit' / 'fits chest'"),
    (r"\byour\s+(?:chest|bust|waist|body)", "talks about 'your chest/body'"),
    (
        r"measure\s+(?:around|under)\s+(?:the\s+)?(?:fullest|your)",
        "explains how to measure your body",
    ),
]
_GARMENT_WORDS = [
    (
        r"garment\s*measure|product\s*measure|item\s*measure|clothing\s*measure|apparel\s*measure",
        "says 'garment/product measurements'",
    ),
    (r"laid\s*flat|measured\s*flat|\bflat\b", "says the item was measured flat"),
    (r"pit\s*to\s*pit|1/2\s*chest|½\s*chest|half\s*chest", "has a half-chest / pit-to-pit column"),
    (r"actual\s*(?:size|measure)", "says 'actual measurements'"),
]


def _field(header: str) -> ChartField | None:
    text = header.lower()
    if (
        not text.strip()
        or re.search(_IGNORE, text)
        and not re.search(r"chest|shoulder|sleeve", text)
    ):
        return None
    for name, pattern in _FIELDS:
        if re.search(pattern, text):
            return name
    return None


def _unit_of(text: str) -> str | None:
    text = text.lower()
    has_cm = bool(re.search(r"\bcm\b|centimet", text))
    has_in = bool(re.search(r"\binch|\bin\b|\bin\.|\"|″", text))
    if has_cm and not has_in:
        return "cm"
    if has_in and not has_cm:
        return "in"
    return None


def _orient(table: PageTable) -> tuple[list[str], list[list[str]]] | None:
    """Return (headers, rows) with sizes down the first column, or None if not a size table."""
    rows = [row for row in table.rows if row]
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    first_size = next((i for i, row in enumerate(rows) if canonical_size(row[0])), 0)
    if first_size > 1:
        header = [
            " ".join(dict.fromkeys(row[col] for row in rows[:first_size] if row[col]))
            for col in range(width)
        ]
        rows = [header, *rows[first_size:]]

    def sizes_in(cells: list[str]) -> int:
        return sum(canonical_size(cell) is not None for cell in cells)

    first_col = [row[0] for row in rows[1:]]
    if sizes_in(first_col) >= 2 and sum(_field(h) is not None for h in rows[0][1:]) >= 1:
        return rows[0], rows[1:]
    if sizes_in(rows[0][1:]) >= 2 and sum(_field(r[0]) is not None for r in rows[1:]) >= 1:
        transposed = [list(col) for col in zip(*rows, strict=True)]
        return transposed[0], transposed[1:]
    return None


def _candidates(page: PageContent):
    for table in page.tables:
        oriented = _orient(table)
        if oriented is None:
            continue
        headers, rows = oriented
        fields = {i: _field(h) for i, h in enumerate(headers) if i and _field(h)}
        sizes = [r for r in rows if canonical_size(r[0])]
        unit = _unit_of(table.heading + " " + " ".join(headers)) or _unit_of(
            " ".join(c for r in rows for c in r[1:])
        )
        yield table, headers, sizes, fields, unit


def classify(
    page: PageContent,
    table: PageTable,
    headers: list[str],
    fields: dict,
    rows: list[list[str]] | None = None,
) -> tuple[str | None, list[str]]:
    text = " ".join([table.heading, *headers, page.title, *page.bullets, page.description])
    body = [why for pattern, why in _BODY_WORDS if re.search(pattern, text, re.IGNORECASE)]
    garment = [why for pattern, why in _GARMENT_WORDS if re.search(pattern, text, re.IGNORECASE)]
    names = set(fields.values())
    if any(re.search(r"height|weight", h, re.IGNORECASE) for h in headers):
        body.append("has height/weight columns (fit guidance for bodies)")
    girth_cols = [i for i, name in fields.items() if name in ("chest", "waist", "hip")]
    cells = [parse_cell(r[i]) for r in rows or [] for i in girth_cols if i < len(r)]
    cells = [c for c in cells if c != (None, None, None)]
    if len(cells) >= 4 and sum(c[0] is None for c in cells) / len(cells) >= 0.8:
        # A garment has one chest measurement; "38 - 40" describes the bodies a size fits.
        body.append("girths are printed as ranges (a range describes the bodies a size fits)")
    single = len(cells) >= 4 and sum(c[0] is not None for c in cells) / len(cells) >= 0.8
    extra = [n for n in ("shoulder", "length") if n in names]
    if single and extra:
        # Printed structure of a garment spec: one value per girth plus a column bodies lack.
        garment.append(
            "girths are single values (not ranges) with a "
            + " and ".join(n.capitalize() for n in extra)
            + " column (measurements of the garment, not of bodies)"
        )
    if "length" in names:
        garment.append("has a garment length column (bodies have no 'length')")
    if {"shoulder", "sleeve"} <= names and "length" in names:
        garment.append("lists shoulder, sleeve and length (a flat-lay garment spec)")
    evidence = [f"body: {w}" for w in body] + [f"garment: {w}" for w in garment]
    if garment and body:
        # Printed evidence points both ways: do not guess.
        return None, evidence
    if garment:
        return "garment", evidence
    if body:
        return "body", evidence
    return None, evidence


_CATEGORY_WORDS = [
    ("hoodie", r"hoodie|hooded\s*sweatshirt"),
    ("sweatshirt", r"sweatshirt|crewneck\s*fleece"),
    ("coat", r"\bcoat\b|parka|trench|overcoat"),
    ("jacket", r"jacket|puffer|windbreaker|anorak|bomber|shell"),
    ("t-shirt", r"t-?shirt|\btee\b"),
    ("polo", r"\bpolo\b"),
    ("sweater", r"sweater|cardigan|pullover|jumper"),
    ("shirt", r"\bshirt\b|button[- ]down|oxford"),
    ("top", r"\btop\b|tank|blouse"),
]


def category_of(page: PageContent) -> str | None:
    title = page.title.lower()
    if any(word in f" {title} " for word in ac.UNSUPPORTED_WORDS):
        return None
    for name, pattern in _CATEGORY_WORDS:
        if re.search(pattern, title):
            return name
    return None


def _fit_type_row(page: PageContent, assumptions: list[str]) -> str | None:
    """fit_intent from a two-column 'Fit Type | Relaxed' attribute row, if the page prints one."""
    for table in page.tables:
        for row in table.rows:
            if len(row) >= 2 and row[0].strip().lower() == "fit type":
                intent = ac.FIT_TYPE_TO_INTENT.get(row[1].strip().lower())
                if intent:
                    assumptions.append(
                        f"Fit intent '{intent}' from the page's 'Fit Type: {row[1].strip()}'"
                    )
                    return intent
    return None


def product_traits(page: PageContent) -> tuple[str, str, str, list[str]]:
    """fit_intent, construction, fabric, assumptions — read from the page text only."""
    text = " ".join([page.title, *page.bullets, page.description]).lower()
    assumptions: list[str] = []
    fit = _fit_type_row(page, assumptions)
    fit = fit or next(
        (
            name
            for name, pattern in (
                ("oversized", r"oversized?"),
                ("loose", r"loose|relaxed\s*fit"),
                ("slim", r"slim|athletic\s*fit|muscle\s*fit"),
                ("regular", r"regular\s*fit|classic\s*fit|standard\s*fit"),
            )
            if re.search(pattern, text)
        ),
        None,
    )
    if fit is None:
        fit = "regular"
        assumptions.append("Fit intent not stated on the page; assumed regular")
    construction = (
        "raglan"
        if "raglan" in text
        else "drop_shoulder"
        if re.search(r"drop(?:ped)?[- ]shoulder", text)
        else "set_in"
    )
    if construction == "set_in":
        assumptions.append("Sleeve construction not stated; assumed set-in shoulder seam")
    fabric = next((b for b in page.bullets if re.search(r"\d+\s*%", b)), "")
    match = re.search(r"[^.;|]*\d+\s*%\s*[a-z]+[^.;|]*", text) if not fabric else None
    return (
        fit,
        construction,
        (fabric or (match.group(0).strip() if match else ""))[:1000],
        assumptions,
    )


def _title_of(table: PageTable) -> str:
    """Table title without the CSS class tokens the saved DOM leaves in the caption."""
    words = [w for w in table.heading.split() if not re.fullmatch(r"[a-z]+(?:-[a-z0-9]+)+", w)]
    return " ".join(w for i, w in enumerate(words) if i == 0 or w != words[i - 1])


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]{3,}", text.lower()) if w not in ac.CHART_TITLE_STOPWORDS}


def _size_span(sizes: list[list[str]]) -> str:
    names = [canonical_size(r[0]) for r in sizes]
    return f"{names[0]}-{names[-1]}" if len(names) > 1 else str(names[0])


def choose_table(page: PageContent, found: list) -> tuple[tuple, str | None]:
    """Pick one chart table, deterministically: title words, then size rows, then 'Regular'.

    Returns (candidate, evidence line); raises ChartUnclear listing the tables if still tied.
    """
    unique, seen = [], set()
    for cand in found:  # identical tables repeated in the DOM count once
        key = tuple(tuple(r) for r in cand[2]) + (cand[4],)
        if key not in seen:
            seen.add(key)
            unique.append(cand)
    if len(unique) == 1:
        return unique[0], None
    names = [_title_of(c[0]) or "(untitled)" for c in unique]
    reasons: list[str] = []
    pool = unique

    def keep(best: list, reason: str) -> None:
        nonlocal pool
        if best and len(best) < len(pool):
            pool = best
            reasons.append(reason)

    product_words = _words(page.title)
    hits = [c for c in pool if _words(_title_of(c[0])) & product_words]
    if hits and len(hits) < len(pool):
        keep(hits, "its title words appear in the product title")
    elif len(pool) > 1:
        page_sizes = {canonical_size(o) for o in page.size_options} - {None}

        def score(cand) -> int:
            table_sizes = {canonical_size(r[0]) for r in cand[2]}
            if not page_sizes:
                return 0
            return 2 if table_sizes == page_sizes else 1 if page_sizes <= table_sizes else 0

        top = max(score(c) for c in pool)
        if top:
            best = [c for c in pool if score(c) == top]
            keep(
                best,
                "its sizes "
                + _size_span(best[0][2])
                + (" are exactly" if top == 2 else " include all of")
                + " the page's size options",
            )
    if len(pool) > 1:
        default = [c for c in pool if _words_all(_title_of(c[0])) & ac.CHART_DEFAULT_TITLE_WORDS]
        keep(default, "it is the 'Regular'/'Standard' table")
    if len(pool) > 1:
        listed = "; ".join(f"'{n}'" for n in names)
        raise ChartUnclear(
            f"The page has {len(unique)} different size-chart tables and nothing printed picks "
            f"one ({listed})",
            {"tables": names},
        )
    chosen = names[unique.index(pool[0])]
    line = f"Chart table '{chosen}' chosen among {len(unique)} ({'; '.join(names)}): " + "; ".join(
        reasons
    )
    return pool[0], line[:300]  # Extraction.evidence lines are capped at 300 characters


def _words_all(text: str) -> set[str]:
    return set(re.findall(r"[a-z]+", text.lower()))


def parse_rules(page: PageContent, chart_type_override: str | None = None) -> Extraction:
    found = list(_candidates(page))
    if not found:
        raise ChartNotFound("No size table on this page (rows of sizes × measurement columns)")
    (table, headers, rows, fields, unit), chosen_why = choose_table(page, found)
    chart_type, evidence = classify(page, table, headers, fields, rows)
    if chosen_why:
        evidence.insert(0, chosen_why)
    if chart_type_override:
        evidence.append(f"shopper chose '{chart_type_override}' for this chart")
        chart_type = chart_type_override
    assumptions: list[str] = []
    values = {fields[i]: [parse_cell(r[i]) for r in rows if i < len(r)] for i in fields}
    if unit is None:
        raise ChartUnclear(
            "Chart unit is missing or ambiguous. Show the size chart's cm or inches label; "
            "numerical magnitudes alone are not evidence."
        )
    flat: list[ChartField] = []
    for i, name in fields.items():
        if re.search(_FLAT, headers[i], re.IGNORECASE):
            flat.append(name)
        elif name in ("chest", "hem", "waist", "hip", "bicep") and re.search(
            r"width", headers[i], re.I
        ):
            numbers = [v or lo for v, lo, _ in values[name] if v or lo]
            # No adult chest/waist/hip girth is below 70 cm (28 in); no upper arm below 20 cm.
            limit = (20 if name == "bicep" else 70) / (1 if unit == "cm" else ac.IN_TO_CM)
            if numbers and median(numbers) < limit:
                flat.append(name)
                assumptions.append(f"'{headers[i]}' values are below any adult girth; read as flat")
    sizes = []
    for row in rows:
        measurements = {}
        for i, name in fields.items():
            if i >= len(row) or name in measurements:
                continue
            value, low, high = parse_cell(row[i])
            if value is not None:
                measurements[name] = ChartValue(value=value, raw=row[i])
            elif low is not None:
                measurements[name] = ChartValue(min=low, max=high, raw=row[i])
        if measurements:
            sizes.append(ExtractedSize(name=canonical_size(row[0]), measurements=measurements))
    if not sizes:
        raise ChartNotFound("The size table has no numeric measurement cells")
    category = category_of(page)
    partial = {"sizes": len(sizes), "fields": sorted(set(fields.values())), "unit": unit}
    if category is None:
        raise ChartUnclear(
            "Product category is not a supported top (jacket, coat, hoodie, shirt, sweater…)",
            partial,
        )
    if chart_type is None:
        raise ChartUnclear(
            "The page does not say whether these are body or garment measurements", partial
        )
    fit, construction, fabric, traits = product_traits(page)
    return Extraction(
        asin=page.asin,
        title=page.title,
        brand=page.brand,
        category=category,
        chart_type=chart_type,
        unit=unit,
        flat_fields=sorted(set(flat)),
        fit_intent=fit,
        construction=construction,
        fabric=fabric,
        sizes=sizes,
        headers={name: headers[i][: ac.MAX_CELL_CHARS] for i, name in fields.items()},
        evidence=evidence[:20],
        assumptions=(assumptions + traits)[:20],
        provenance=Provenance(
            source="rules", provider=None, extracted_by=RULES_VERSION, date=date.today().isoformat()
        ),
    )
