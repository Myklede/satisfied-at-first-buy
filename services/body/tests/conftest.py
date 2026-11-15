import pytest
from body_service.fit import Fitter
from body_service.model import BodyEngine


@pytest.fixture(scope="session")
def engine():
    return BodyEngine()


@pytest.fixture(scope="session")
def fitter(engine):
    return Fitter(engine)
