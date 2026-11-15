"""Read a saved Amazon product page (HTML on disk) into PageContent, with the stdlib parser.

This mirrors what the extension's content script reads from the live DOM (apps/extension/src/
extract.ts): title, brand, bullets, description, size options and every <table>. It never fetches
anything. Script/style text is skipped, except that we report whether a script mentions a size
chart, which tells us if Amazon shipped the chart as data rather than as a rendered table.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

from . import agent_config as ac
from .models import PageContent, PageTable

_VOID = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "source",
    "track",
    "wbr",
}
_SKIP_TEXT = {"script", "style", "noscript", "template"}
_BLOCK = {
    "p",
    "div",
    "li",
    "tr",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "section",
    "ul",
    "ol",
    "td",
    "th",
    "span",
}


@dataclass(eq=False)  # identity equality: nodes link to their parent, so field equality recurses
class Node:
    tag: str
    attrs: dict[str, str]
    parent: Node | None = None
    children: list[Node | str] = field(default_factory=list)

    def text(self) -> str:
        if self.tag in _SKIP_TEXT:
            return ""
        out: list[str] = []
        for child in self.children:
            if isinstance(child, str):
                out.append(child)
            else:
                piece = child.text()
                out.append(f" {piece} " if child.tag in _BLOCK else piece)
        return re.sub(r"\s+", " ", "".join(out)).strip()

    def iter(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.iter()

    def find_all(self, tag: str) -> list[Node]:
        return [node for node in self.iter() if node.tag == tag]

    def by_id(self, element_id: str) -> Node | None:
        return next((n for n in self.iter() if n.attrs.get("id") == element_id), None)


class _TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", {})
        self.current = self.root
        self.script_mentions_chart = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag, {k: v or "" for k, v in attrs}, self.current)
        self.current.children.append(node)
        if tag not in _VOID:
            self.current = node

    def handle_endtag(self, tag: str) -> None:
        node = self.current
        while node is not self.root and node.tag != tag:
            node = node.parent  # tolerate unclosed tags
        if node is not self.root and node.parent is not None:
            self.current = node.parent

    def handle_data(self, data: str) -> None:
        if self.current.tag in ("script", "style") and re.search(
            r"size[\s_-]?chart", data, re.IGNORECASE
        ):
            self.script_mentions_chart = True
        self.current.children.append(data)


@dataclass
class SavedPage:
    content: PageContent
    text: str  # visible text, for the number check
    table_count: int
    script_mentions_chart: bool
    mentions_size_chart: bool


def _heading(table: Node) -> str:
    caption = next((c for c in table.children if isinstance(c, Node) and c.tag == "caption"), None)
    parts = [caption.text()] if caption else []
    node: Node | None = table
    for _ in range(4):
        if node is None:
            break
        marker = " ".join(v for k, v in node.attrs.items() if k in ("id", "class", "aria-label"))
        if re.search(r"size|chart|inch|\bcm\b|\bin\b", marker, re.IGNORECASE):
            parts.append(marker)
        # Text just before the table, e.g. a heading "Body measurements (cm)". Same rule as the
        # extension (apps/extension/src/extract.ts: headingOf).
        if node.parent is not None:
            siblings = node.parent.children
            texts = [
                re.sub(r"\s+", " ", s.text() if isinstance(s, Node) else s).strip()
                for s in siblings[: siblings.index(node)]
            ]
            text = " ".join([t for t in texts if t][-3:])  # last 3 non-blank siblings
            if text:
                parts.append(text[-200:])
                break
        node = node.parent
    return " ".join(parts)[:300]


def clean_brand(text: str) -> str:
    """'Visit the X Store' / 'Brand: X' → 'X' (same rule as the extension's cleanBrand)."""
    text = re.sub(r"^\s*(?:visit the|brand:)\s*", "", text, flags=re.IGNORECASE)
    return re.sub(r"\s+store\s*$", "", text, flags=re.IGNORECASE).strip()


def table_rows(table: Node) -> list[list[str]]:
    grid: dict[tuple[int, int], str] = {}
    for r, tr in enumerate(table.find_all("tr")[: ac.MAX_TABLE_ROWS]):
        col = 0
        for cell in [c for c in tr.children if isinstance(c, Node) and c.tag in ("td", "th")]:
            while (r, col) in grid and col < ac.MAX_TABLE_COLS:
                col += 1
            try:
                height = max(1, min(int(cell.attrs.get("rowspan") or 1), ac.MAX_TABLE_ROWS - r))
                width = max(1, min(int(cell.attrs.get("colspan") or 1), ac.MAX_TABLE_COLS - col))
            except ValueError:
                height = width = 1
            for y in range(height):
                for x in range(width):
                    if col + x < ac.MAX_TABLE_COLS:
                        grid[r + y, col + x] = cell.text()[: ac.MAX_CELL_CHARS]
            col += width
    return [
        [grid.get((r, c), "") for c in range(max(c for rr, c in grid if rr == r) + 1)]
        for r in sorted({r for r, _ in grid})
    ]


def _asin(root: Node, fallback: str | None) -> str | None:
    for node in root.iter():
        if node.tag == "input" and node.attrs.get("name") == "ASIN":
            value = node.attrs.get("value", "")
            if re.fullmatch(r"[A-Z0-9]{10}", value):
                return value
    for node in root.iter():
        if node.tag == "link" and node.attrs.get("rel") == "canonical":
            match = re.search(r"/dp/([A-Z0-9]{10})", node.attrs.get("href", ""))
            if match:
                return match.group(1)
    return fallback


def size_options(root: Node) -> list[str]:
    found: list[str] = []
    for node in root.iter():
        node_id = node.attrs.get("id", "")
        if node.tag == "select" and "size_name" in node_id:
            found += [o.text() for o in node.find_all("option") if o.attrs.get("value") != "-1"]
        elif node_id == "variation_size_name" or node_id.startswith("inline-twister-row-size_name"):
            found += [li.text() for li in node.find_all("li")]
    cleaned = []
    for item in found:
        item = re.sub(r"\s+", " ", item).strip()
        if item and item not in cleaned and len(item) <= ac.MAX_CELL_CHARS:
            cleaned.append(item)
    return cleaned[:40]


def read_saved_page(html: str, asin_hint: str | None = None) -> SavedPage:
    builder = _TreeBuilder()
    builder.feed(html)
    root = builder.root
    asin = _asin(root, asin_hint)
    if asin is None:
        raise ValueError("No ASIN found in the page (input[name=ASIN] or canonical /dp/ link)")

    def text_of(element_id: str) -> str:
        node = root.by_id(element_id)
        return node.text() if node else ""

    bullets_node = root.by_id("feature-bullets")
    bullets = [li.text() for li in bullets_node.find_all("li")] if bullets_node else []
    tables = []
    for table in root.find_all("table"):
        rows = table_rows(table)
        if len(rows) >= 2:
            tables.append(PageTable(heading=_heading(table), rows=rows))
    text = root.text()
    content = PageContent(
        asin=asin,
        url=f"https://www.amazon.com/dp/{asin}",
        title=text_of("productTitle")[:400],
        brand=clean_brand(text_of("bylineInfo"))[:200],
        bullets=[b[:1000] for b in bullets if b][: ac.MAX_BULLETS],
        description=text_of("productDescription")[: ac.MAX_TEXT_CHARS],
        size_options=size_options(root),
        tables=tables[: ac.MAX_TABLES],
        chart_origin="saved_page",
    )
    return SavedPage(
        content=content,
        text=text,
        table_count=len(tables),
        script_mentions_chart=builder.script_mentions_chart,
        mentions_size_chart=bool(re.search(r"size\s*chart|size\s*guide", text, re.IGNORECASE)),
    )


def page_content_text(page: PageContent) -> str:
    """All product text the extension sent, cells separated so numbers never glue together."""
    parts = [page.title, page.brand, *page.bullets, page.description, " | ".join(page.size_options)]
    for table in page.tables:
        parts.append(table.heading)
        parts += [" | ".join(row) for row in table.rows]
    return "\n".join(parts)
