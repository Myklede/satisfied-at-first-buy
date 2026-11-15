import json

from body_service.app import app
from body_service.config import ROOT

(ROOT / "packages/api-types/openapi.json").write_text(json.dumps(app.openapi(), indent=2) + "\n")
