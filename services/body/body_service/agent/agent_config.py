"""Fit Agent (M5) constants. Every value that affects a recommendation has its source here.

Units: centimetres. Inch charts keep their printed numbers in the extraction (so each number can
be checked against the page) and are converted with IN_TO_CM in convert.py.
"""

from pathlib import Path

from .. import config

ROOT: Path = config.ROOT

# --- Storage (all gitignored) -------------------------------------------------------------
# Personal data (opt-in profile, feedback) and non-reviewed extraction cache: `.cache/` is
# gitignored (AGENTS.md §3). FIT_AGENT_STORE_DIR overrides it (tests and the e2e use a temp dir).
STORE_DIR_ENV = "FIT_AGENT_STORE_DIR"
DEFAULT_STORE_DIR = ROOT / ".cache" / "fit-agent"
# Saved Amazon pages (third-party content, gitignored by `data/amazon-pages/`).
PAGES_DIR = ROOT / "data" / "amazon-pages"
# Reviewed extractions, one `<ASIN>.json` each, written by the coordinator after checking every
# number against the saved page. Kept next to the pages so they inherit the same gitignore rule.
REVIEWED_DIR = PAGES_DIR / "reviewed"

# --- Kiosk privacy --------------------------------------------------------------------------
# When set to 1 the service never writes a profile or feedback to disk (judge kiosk). Profile
# writes are also refused from any http(s) web origin (the kiosk page included), see router.py.
KIOSK_MODE_ENV = "SATISFY_KIOSK_MODE"
# Optional: pin the unpacked extension's ID; then only that chrome-extension:// origin may write.
EXTENSION_ID_ENV = "FIT_AGENT_EXTENSION_ID"

# --- LLM providers ---------------------------------------------------------------------------
# User rule 2026-11-12 (docs/USER-RULES.md): no money outside the paid Claude plan. Paid
# providers need credentials AND this flag set to 1; the default is off.
ALLOW_PAID_ENV = "FIT_AGENT_ALLOW_PAID_LLM"
PAID_DISABLED_MESSAGE = "paid provider disabled by user rule"
# Order after the reviewed cache and the rules parser. claude_cli uses the logged-in Claude Code
# subscription; bedrock/anthropic are paid API paths (disabled by default).
PROVIDER_ORDER = ("claude_cli", "bedrock", "anthropic")
# Model IDs exactly as the claude-api skill gives them (default: Claude Opus 5.5).
LLM_MODEL_ENV = "FIT_AGENT_LLM_MODEL"
ANTHROPIC_MODEL = "claude-opus-5-5"
BEDROCK_MODEL = "anthropic.claude-opus-5-5"
BEDROCK_REGION_ENV = "AWS_REGION"
# Opus 5.5 defaults to "medium" effort; set explicitly (skill: set it explicitly on this model).
LLM_EFFORT = "medium"
LLM_MAX_TOKENS = 16000  # skill default for non-streaming requests
# claude -p: executable, timeout and a quota guard (calls per rolling minute).
CLAUDE_CLI_ENV = "FIT_AGENT_CLAUDE_CLI"
CLAUDE_CLI_DEFAULT = "claude"
CLAUDE_CLI_TIMEOUT_S = 180.0
CLAUDE_CLI_AUTH_TIMEOUT_S = 30.0
CLAUDE_CLI_MAX_CALLS_PER_MINUTE = 3
# Removed from the child environment so `claude -p` cannot fall back to API-key / cloud billing.
CLAUDE_CLI_STRIPPED_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_BEARER_TOKEN_BEDROCK",
)

# --- Page content bounds (API boundary validation) ------------------------------------------
MAX_TABLES = 12
MAX_TABLE_ROWS = 60
MAX_TABLE_COLS = 20
MAX_CELL_CHARS = 120
MAX_TEXT_CHARS = 6000
MAX_BULLETS = 20

# --- Unit conversion ----------------------------------------------------------------------
IN_TO_CM = 2.54  # exact by definition (international inch, 1959)

# --- Body-chart → estimated garment ------------------------------------------------------
# A retailer BODY chart says which bodies a size is meant for; the garment is larger by the
# design ease. Standard ease by fit intent is the engine's own fallback design ease
# (config.DESIGN_EASE_FALLBACK_CM; KE-HOACH-KY-THUAT §4.3, to be calibrated with real garments).
STANDARD_CHEST_EASE_CM = config.DESIGN_EASE_FALLBACK_CM
STANDARD_BICEP_EASE_CM = config.BICEP_DESIGN_EASE_CM

# --- Garment assumptions for non-catalogue products -----------------------------------------
# Thin knit/woven tops: fabric thickness is neglected (≈1 mm, below the 1.5 cm girth tolerance).
# Insulated garments get no loft (None): chest/bicep/hem ease are then reported unknown rather
# than invented, unless the ASIN is in the tape-measured catalogue (its loft is used).
THIN_LOFT_CM = 0.0
INSULATED_WORDS = ("puffer", "down ", "insulated", "padded", "quilted", "parka", "thermal fill")
SUPPORTED_CATEGORIES = (
    "jacket",
    "coat",
    "hoodie",
    "sweatshirt",
    "t-shirt",
    "shirt",
    "polo",
    "sweater",
    "top",
)
# Words that identify an unsupported (lower-body / one-piece / footwear) listing.
UNSUPPORTED_WORDS = (
    "pant",
    "jean",
    "trouser",
    "short",
    "legging",
    "skirt",
    "dress",
    "shoe",
    "sneaker",
    "boot",
    "sock",
    "jumpsuit",
    "romper",
    "swim",
    "bra ",
)

# --- Learning from feedback ---------------------------------------------------------------
# One disagreement between the prediction and the shopper's answer moves that zone's personal
# offset by one step; offsets are clamped to ±LEARN_MAX_CM. Steps are a third of the engine's
# fit tolerance per zone (config.EASE_TOLERANCE_CM / OFFSET_BANDS_CM width), so one answer nudges
# and three consistent answers are needed to move a size boundary. Uncalibrated (no user data yet).
LEARN_STEP_CM = {"chest": 2.0, "hem": 2.5, "bicep": 1.5, "shoulder": 0.8, "sleeve": 1.2}
LEARN_MAX_CM = {"chest": 6.0, "hem": 8.0, "bicep": 5.0, "shoulder": 2.5, "sleeve": 3.5}
FEEDBACK_ZONES = tuple(LEARN_STEP_CM)
ZONE_LABELS = {
    "shoulder": "Shoulders",
    "chest": "Chest",
    "hem": "Hem / hip",
    "sleeve": "Sleeve length",
    "bicep": "Upper arm",
    "collar": "Collar / estimated neck",
}
MAX_FEEDBACK_EVENTS = 200

# --- Web app link ("See 3D / X-ray") ------------------------------------------------------
WEB_APP_ORIGIN = "http://127.0.0.1:5710"
# Ranking basis shown on the panel when a matched catalogue jacket is ranked by
# GarmentService.fit (the 3D studio's own computation) instead of the printed chart.
CATALOGUE_ENGINE_BASIS = "Tape-measured catalogue · full engine"

# --- Rules parser: choosing among several chart tables, and the "Fit Type" row ---------------
# Words that every jacket chart title shares with the product title; they cannot tell tables apart.
# Plain English vocabulary, not calibrated.
CHART_TITLE_STOPWORDS = frozenset(
    "us uk eu size sizes chart guide men mens women womens unisex adult jacket jackets coat "
    "coats parka hoodie shirt sweater top tops outerwear measurement measurements for and the "
    "with".split()
)
# A chart table whose title is one of these wins a tie that title words and size rows left open.
CHART_DEFAULT_TITLE_WORDS = frozenset({"regular", "standard"})
# Amazon "Fit Type" attribute value -> fit_intent (the Extraction vocabulary). Printed words only.
FIT_TYPE_TO_INTENT = {
    "relaxed": "loose",
    "loose": "loose",
    "slim": "slim",
    "regular": "regular",
    "oversized": "oversized",
}
