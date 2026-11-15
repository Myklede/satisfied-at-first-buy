"""Rebuild topology indices from the documented neutral adult selection rules."""

import json

from body_service import config
from body_service.landmarks import generate
from body_service.model import BodyEngine

engine = BodyEngine()
data = {
    "model": config.MODEL_VERSION,
    "vertex_count": len(engine.vertices),
    "landmarks": generate(engine.vertices, engine.bones, engine.model.bone_labels),
}
path = config.ROOT / "services/body/landmarks.json"
path.write_text(json.dumps(data, indent=2) + "\n")
print(path)
