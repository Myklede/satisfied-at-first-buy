"""Read the numbers printed in a size-chart cell: 38, 38.5, 38 1/2, 38½, 36-38, 36 – 38, 36~38.

Pure functions; the same tokenizer reads the page text for the "every number appears on the page"
check, so an extraction can only contain numbers that are literally printed there.
"""

import re
from fractions import Fraction

_VULGAR = {
    "½": "1/2",
    "¼": "1/4",
    "¾": "3/4",
    "⅓": "1/3",
    "⅔": "2/3",
    "⅛": "1/8",
    "⅜": "3/8",
    "⅝": "5/8",
    "⅞": "7/8",
}
# A number: integer or decimal, optionally followed by a fraction ("38 1/2", "38-1/2" is a range
# guard below) or a lone fraction ("1/2").
_NUMBER = r"(?:\d+(?:[.,]\d+)?(?:\s+\d+/\d+)?|\d+/\d+)"
_RANGE = re.compile(rf"({_NUMBER})\s*(?:-|–|—|~|to)\s*({_NUMBER})", re.IGNORECASE)
_SINGLE = re.compile(_NUMBER)


def _normalise(text: str) -> str:
    for glyph, ascii_fraction in _VULGAR.items():
        text = text.replace(glyph, f" {ascii_fraction}")
    return text.replace(" ", " ")


def to_float(token: str) -> float:
    token = token.strip().replace(",", ".")
    parts = token.split()
    total = Fraction(0)
    for part in parts:
        total += Fraction(part) if "/" in part else Fraction(part)
    return float(total)


def parse_cell(text: str) -> tuple[float | None, float | None, float | None]:
    """Return (value, min, max) for one chart cell; all None when the cell holds no number."""
    text = _normalise(text)
    match = _RANGE.search(text)
    if match:
        low, high = to_float(match.group(1)), to_float(match.group(2))
        if low <= high:
            return None, low, high
    single = _SINGLE.search(text)
    if single:
        return to_float(single.group(0)), None, None
    return None, None, None


def all_numbers(text: str) -> set[float]:
    """Every number printed in text, including both ends of ranges and mixed fractions."""
    text = _normalise(text)
    found: set[float] = set()
    for match in _SINGLE.finditer(text):
        token = match.group(0)
        found.add(round(to_float(token), 4))
        # "38 1/2" also contains the plain 38 and 1/2 as printed tokens.
        for part in token.split():
            found.add(round(to_float(part), 4))
    return found


def printed(value: float, page_numbers: set[float]) -> bool:
    return round(value, 4) in page_numbers
