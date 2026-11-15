import json

from body_service.config import ROOT
from body_service.garment.models import GarmentSpec
from body_service.schemas import PersonData

directory = ROOT / "data/schemas"
directory.mkdir(parents=True, exist_ok=True)
schema = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    **PersonData.model_json_schema(),
}
(directory / "person.schema.json").write_text(json.dumps(schema, indent=2) + "\n")
(directory / "garment.schema.json").write_text(
    json.dumps(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            **GarmentSpec.model_json_schema(),
        },
        indent=2,
    )
    + "\n"
)
