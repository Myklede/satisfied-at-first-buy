"""P2 proposal 5: asset workers load bodies without importing torch / anny (seconds each)."""

import pickle
import subprocess
import sys
import textwrap

import numpy as np
from body_service.garment.workers import _dumps
from body_service.pose import display_body
from body_service.schemas import FitRequest

CHILD = textwrap.dedent(
    """
    import pickle, sys
    import body_service.garment.simulation  # the asset worker's import (initializer)
    message = pickle.loads(sys.stdin.buffer.read())
    assert "torch" not in sys.modules and "anny" not in sys.modules, sorted(
        m for m in sys.modules if m.split(".")[0] in ("torch", "anny")
    )[:5]
    _, _, (body, posed) = message
    sys.stdout.buffer.write(pickle.dumps((
        body.response.model_dump_json(), body.mesh.vertices.tobytes(),
        body.mesh.faces.tobytes(), posed.mesh.vertices.tobytes(), posed.transforms.tobytes(),
        posed.weights.tobytes(), {k: v.tobytes() for k, v in posed.landmarks.items()},
    )))
    """
)


def test_a_worker_loads_a_fitted_and_posed_body_without_torch(fitter):
    body = fitter.fit(FitRequest(height_cm=172, weight_kg=65, sex="male"))
    posed = display_body(fitter.engine, body)
    import dataclasses

    lite = dataclasses.replace(body, glb=b"")
    payload = _dumps(("job", None, (lite, posed)))  # the bytes a job message ships
    done = subprocess.run(
        [sys.executable, "-c", CHILD], input=payload, capture_output=True, timeout=300
    )
    assert done.returncode == 0, done.stderr.decode()[-2000:]
    response, vertices, faces, posed_vertices, transforms, weights, landmarks = pickle.loads(
        done.stdout
    )
    # Bit-identical inputs on the worker side (the meshes travel as vertices/faces).
    assert response == body.response.model_dump_json()
    assert vertices == np.asarray(body.mesh.vertices).tobytes()
    assert faces == np.asarray(body.mesh.faces).tobytes()
    assert posed_vertices == np.asarray(posed.mesh.vertices).tobytes()
    assert transforms == posed.transforms.tobytes()
    assert weights == posed.weights.tobytes()
    assert landmarks == {k: v.tobytes() for k, v in posed.landmarks.items()}


def test_fit_outputs_are_unchanged_by_the_lazy_imports(fitter):
    """Fit and display pose still run (torch imported inside them) and are deterministic:
    two fits of one request and two poses of one body are byte-identical."""
    request = FitRequest(height_cm=163, weight_kg=58, sex="female")
    first = fitter._fit(request, "f" * 64)
    second = fitter._fit(request, "f" * 64)
    assert first.response.model_dump_json(exclude={"fit_ms"}) == second.response.model_dump_json(
        exclude={"fit_ms"}
    )
    assert first.glb == second.glb
    a, b = display_body(fitter.engine, first), display_body(fitter.engine, second)
    assert np.array_equal(a.mesh.vertices, b.mesh.vertices)
    assert np.array_equal(a.transforms, b.transforms)
