"""Synthetic chart variants: no invented product data is presented to shoppers."""

import pytest
from body_service.agent.models import PageContent, PageTable
from body_service.agent.numbers import parse_cell
from body_service.agent.rules import ChartUnclear, parse_rules


def chart(unit: str) -> PageContent:
    return PageContent(
        asin="B0SYNTH001",
        title="Synthetic shirt",
        url="https://www.amazon.com/dp/B0SYNTH001",
        tables=[
            PageTable(
                heading=f"Body measurements {unit}",
                rows=[
                    ["Size", "Body measurements", "Body measurements"],
                    ["Size", "Chest", "Hip"],
                    ["S (4-6)", "38 1/2–40", "40–42"],
                    ["M", "40–42", "42–44"],
                    ["Small Tall", "41–42", "42–44"],
                ],
            )
        ],
    )


def test_merged_headers_fractions_ranges_and_regular_sizes():
    result = parse_rules(chart("inches"))
    assert [s.name for s in result.sizes] == ["S", "M"]
    assert result.sizes[0].measurements["chest"].min == 38.5
    assert parse_cell("38½") == (38.5, None, None)


def test_missing_or_conflicting_unit_is_refused_not_guessed():
    for unit in ("", "cm inches"):
        with pytest.raises(ChartUnclear, match="unit"):
            parse_rules(chart(unit))
