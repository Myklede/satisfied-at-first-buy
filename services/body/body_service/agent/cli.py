"""Fit Agent CLI for saved Amazon pages (no network, no LLM).

python -m body_service.agent.cli chart-text data/amazon-pages/<page>.html
    Print the product fields and every table as the extension would read them, plus whether
    the size-chart popover content is present in the saved DOM.
python -m body_service.agent.cli rules data/amazon-pages/<page>.html
    Run the rules parser and print its extraction (a draft for review, never auto-reviewed).
python -m body_service.agent.cli validate <ASIN>.json data/amazon-pages/<page>.html
    Check a hand-written reviewed extraction: schema, ASIN, source_page and that EVERY number
    is printed in the page text. Exit code 1 on any problem.
python -m body_service.agent.cli schema [--write]
    Print (or write data/schemas/fit-agent-extraction.schema.json) the reviewed-file schema.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from . import agent_config as ac
from .extract import missing_numbers
from .models import ReviewedExtraction
from .pagetext import read_saved_page
from .rules import ChartNotFound, ChartUnclear, parse_rules

SCHEMA_PATH = ac.ROOT / "data" / "schemas" / "fit-agent-extraction.schema.json"


def schema() -> dict:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **ReviewedExtraction.model_json_schema(),
    }


def _page(path: Path):
    return read_saved_page(path.read_text(encoding="utf-8", errors="replace"))


def chart_text(path: Path) -> int:
    page = _page(path)
    c = page.content
    print(f"ASIN: {c.asin}\nTitle: {c.title}\nBrand: {c.brand}")
    print(f"Size options: {', '.join(c.size_options) or '(none found)'}")
    print(f"Tables with 2+ rows: {page.table_count}")
    print(f"Visible text mentions 'size chart/guide': {page.mentions_size_chart}")
    print(
        f"A <script> mentions a size chart (chart shipped as data, not rendered): "
        f"{page.script_mentions_chart}"
    )
    for i, bullet in enumerate(c.bullets, 1):
        print(f"Bullet {i}: {bullet}")
    for i, table in enumerate(c.tables, 1):
        print(f"\n--- Table {i} [{table.heading}]")
        for row in table.rows:
            print(" | ".join(row))
    return 0


def rules(path: Path) -> int:
    page = _page(path)
    try:
        extraction = parse_rules(page.content)
    except (ChartNotFound, ChartUnclear) as error:
        print(f"rules parser: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(extraction.model_dump_json(indent=2))
    return 0


def validate(extraction_path: Path, page_path: Path) -> int:
    problems: list[str] = []
    try:
        extraction = ReviewedExtraction.model_validate_json(
            extraction_path.read_text(encoding="utf-8-sig")
        )
    except ValidationError as error:
        print(f"Schema: {error}", file=sys.stderr)
        return 1
    page = _page(page_path)
    if extraction.asin != page.content.asin:
        problems.append(f"ASIN {extraction.asin} does not match the page's {page.content.asin}")
    if extraction.provenance.source_page != page_path.name:
        problems.append(f"provenance.source_page must be '{page_path.name}'")
    if extraction_path.name != f"{extraction.asin}.json":
        problems.append(f"File must be named {extraction.asin}.json")
    missing = missing_numbers(extraction, page.text)
    if missing:
        problems.append("Numbers not printed on the page: " + ", ".join(missing))
    for problem in problems:
        print(f"PROBLEM: {problem}", file=sys.stderr)
    if not problems:
        count = sum(len(v.numbers()) for s in extraction.sizes for v in s.measurements.values())
        print(
            f"OK: {extraction.asin} {extraction.chart_type} chart, {len(extraction.sizes)} sizes, "
            f"{count} numbers all printed on {page_path.name}"
        )
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # chart cells contain ½ and similar glyphs
    parser = argparse.ArgumentParser(prog="fit-agent")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("chart-text", "rules"):
        sub.add_parser(name).add_argument("page", type=Path)
    check = sub.add_parser("validate")
    check.add_argument("extraction", type=Path)
    check.add_argument("page", type=Path)
    out = sub.add_parser("schema")
    out.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "chart-text":
        return chart_text(args.page)
    if args.command == "rules":
        return rules(args.page)
    if args.command == "validate":
        return validate(args.extraction, args.page)
    text = json.dumps(schema(), indent=2) + "\n"
    if args.write:
        SCHEMA_PATH.write_text(text, encoding="utf-8")
        print(f"wrote {SCHEMA_PATH.relative_to(ac.ROOT)}")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
