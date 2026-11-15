"""Synthetic only: no reference photos or personal information in test fixtures."""

import argparse
import json

import numpy as np
import pytest
from body_service.lookdev import config as c
from body_service.lookdev.colour import (
    Rect,
    delta_e00,
    estimate_colours,
    linear_to_srgb,
    main,
    parse_rect,
    parse_region,
    read_image,
    srgb_to_linear,
    xyz_to_lab,
)
from PIL import Image, ImageCms


def photo(albedo=(0.35, 0.22, 0.12), white=(0.95047, 1, 1.08883), exposure=0.65):
    """Synthetic camera: Bradford from D65, uniform exposure, IEC sRGB encoding."""
    source_cones = c.BRADFORD @ np.asarray(white)
    to_source = (
        np.linalg.inv(c.BRADFORD) @ np.diag(source_cones / (c.BRADFORD @ c.D65)) @ c.BRADFORD
    )
    rgb = np.array([[c.PAPER_REFLECTANCE] * 3, albedo])
    observed = (rgb @ c.RGB_TO_XYZ.T @ to_source.T @ np.linalg.inv(c.RGB_TO_XYZ).T) * exposure
    assert np.all((observed > 0) & (observed < 1))
    image = np.empty((20, 40, 3))
    image[:, :20] = linear_to_srgb(observed[0])
    image[:, 20:] = linear_to_srgb(observed[1])
    return image


PAPER = Rect(0, 0, 20, 20)
REGIONS = {"cloth": Rect(20, 0, 20, 20)}


@pytest.mark.parametrize(
    "white", [(0.95047, 1, 1.08883), (1.0985, 1, 0.35585), (0.95682, 1, 0.92149)]
)
@pytest.mark.parametrize("exposure", [0.25, 0.5])
@pytest.mark.parametrize("albedo", [(0.35, 0.22, 0.12), (0.65, 0.65, 0.65), (0.04, 0.1, 0.25)])
def test_known_illuminant_and_albedo(white, exposure, albedo):
    result = estimate_colours(photo(albedo, white, exposure), PAPER, REGIONS)
    cloth = result["regions"]["cloth"]
    np.testing.assert_allclose(cloth["linear_rgb"]["median"], albedo, atol=2e-15)
    assert (
        delta_e00(np.array(cloth["lab_d65"]["median"]), xyz_to_lab(c.RGB_TO_XYZ @ albedo)) < 1e-10
    )
    assert not cloth["warnings"]


def test_noisy_paper_clipped_pixels_and_outliers_do_not_bias_estimate():
    image = photo()
    image[:2, :20] = 1  # Clipped: explicitly excluded.
    image[2:4, :20] = 0.15  # Ink/shadow: MAD outlier.
    image[4:5, :20] = [0.75, 0.3, 0.2]  # Coloured contamination.
    result = estimate_colours(image, PAPER, REGIONS)
    assert result["paper"]["clipped_pixels"] == 40
    assert result["paper"]["outlier_pixels"] == 60
    assert result["paper"]["used_pixels"] == 300
    assert set(result["paper"]["warnings"]) == {"clipped", "paper_outliers_removed"}
    np.testing.assert_allclose(
        result["regions"]["cloth"]["linear_rgb"]["median"], [0.35, 0.22, 0.12]
    )


def test_region_spread_retained_and_paper_uncertainty_is_sensitivity_only():
    image = photo()
    image[:10, 20:] = linear_to_srgb(srgb_to_linear(image[:10, 20:]) * 0.8)
    result = estimate_colours(image, PAPER, REGIONS)["regions"]["cloth"]
    np.testing.assert_allclose(result["linear_rgb"]["iqr"], np.array([0.35, 0.22, 0.12]) * 0.2)
    assert all(v > 0 for v in result["lab_d65"]["iqr"])
    nominal = np.array(result["linear_rgb"]["median"])
    low, high = result["paper_uncertainty"]["linear_rgb_endpoints"]
    np.testing.assert_allclose(low, nominal * 0.88 / 0.90)
    np.testing.assert_allclose(high, nominal * 0.92 / 0.90)
    assert result["paper_uncertainty"]["max_delta_e00_from_nominal"] > 0


def test_dark_small_clipped_region_warns_without_inventing_reliability():
    image = photo()
    image[:4, 20:24] = 0.025
    image[0, 20] = [0.025, 1, 0.025]  # A single clipped channel is enough.
    result = estimate_colours(image, PAPER, {"dark": Rect(20, 0, 4, 4)})["regions"]["dark"]
    assert set(result["warnings"]) == {"too_small", "clipped", "too_dark"}
    assert result["used_pixels"] == 15


@pytest.mark.parametrize("value", [0, 1, 0.025])
def test_unusable_paper_is_explicit_error(value):
    image = photo()
    image[:, :20] = value
    with pytest.raises(ValueError, match="clipped|dark"):
        estimate_colours(image, PAPER, REGIONS)


def test_small_paper_and_fully_clipped_garment_are_errors():
    image = photo()
    with pytest.raises(ValueError, match="small"):
        estimate_colours(image, Rect(0, 0, 4, 4), REGIONS)
    image[:, 20:] = 1
    with pytest.raises(ValueError, match="clipped"):
        estimate_colours(image, PAPER, REGIONS)


def test_paper_maps_to_assumed_reflectance_and_display_clipping_is_reported():
    image = photo()
    result = estimate_colours(image, PAPER, {"paper_check": PAPER})["regions"]["paper_check"]
    np.testing.assert_allclose(result["linear_rgb"]["median"], [0.9] * 3, atol=1e-14)
    image[:, 20:] = 0.99
    result = estimate_colours(image, PAPER, REGIONS)["regions"]["cloth"]
    assert "outside_srgb_gamut_hex_clipped" in result["warnings"]
    assert result["srgb_hex"] == "#ffffff"
    assert max(result["linear_rgb"]["median"]) > 1


def test_transfer_roundtrip_and_lab_primary_reference():
    encoded = np.array([0, 0.02, 0.04045, 0.1, 0.5, 1])
    np.testing.assert_allclose(linear_to_srgb(srgb_to_linear(encoded)), encoded, atol=3e-8)
    np.testing.assert_allclose(
        xyz_to_lab(c.RGB_TO_XYZ @ [1, 0, 0]), [53.2408, 80.0925, 67.2032], atol=1e-4
    )
    np.testing.assert_allclose(xyz_to_lab(c.D65), [100, 0, 0], atol=1e-12)
    np.testing.assert_allclose(xyz_to_lab(np.zeros(3)), [0, 0, 0], atol=1e-12)


# Published Sharma/Wu/Dalal supplementary data (2005), not produced by our function.
@pytest.mark.parametrize(
    "left,right,expected",
    [
        ([50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425),
        ([50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615),
        ([50, 2.8361, -74.0200], [50, 0, -82.7485], 3.4412),
        ([50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0000),
        ([50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0000),
        ([50, -0.9009, -85.5211], [50, 0, -82.7485], 1.0000),
        ([50, 0, 0], [50, -1, 2], 2.3669),
        ([50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792),
        ([50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195),
        ([50, 2.5, 0], [73, 25, -18], 27.1492),
        ([50, 2.5, 0], [61, -5, 29], 22.8977),
        ([50, 2.5, 0], [56, -27, -3], 31.9030),
        ([50, 2.5, 0], [58, 24, 15], 19.4535),
        ([2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082),
    ],
)
def test_delta_e00_reference(left, right, expected):
    assert delta_e00(left, right) == pytest.approx(expected, abs=5e-5)
    assert delta_e00(right, left) == pytest.approx(expected, abs=5e-5)
    assert delta_e00(left, left) == 0


@pytest.mark.parametrize("text", ["-1,0,2,2", "0,0,0,2", "0,0,2", "0,0,2,2,3", "0,0,2.5,3"])
def test_parse_invalid_rectangles(text):
    with pytest.raises(argparse.ArgumentTypeError):
        parse_rect(text)


def test_invalid_roi_input_and_names():
    assert parse_region("patch:1,2,3,4") == ("patch", Rect(1, 2, 3, 4))
    with pytest.raises(argparse.ArgumentTypeError):
        parse_region(":0,0,2,2")
    with pytest.raises(ValueError, match="within"):
        estimate_colours(photo(), Rect(0, 0, 41, 20), REGIONS)
    with pytest.raises(ValueError):
        estimate_colours(photo(), PAPER, {})
    for invalid in [float("nan"), float("inf"), -0.1, 1.1]:
        with pytest.raises(ValueError):
            srgb_to_linear(np.array([invalid]))
    with pytest.raises(ValueError):
        delta_e00([0, 0, float("nan")], [0, 0, 0])


def test_cli_json_and_human_output_use_only_local_synthetic_image(tmp_path, capsys):
    path = tmp_path / "synthetic.png"
    Image.fromarray(np.floor(photo() * 255 + 0.5).astype(np.uint8)).save(path)
    args = [str(path), "--paper", "0,0,20,20", "--region", "cloth:20,0,20,20"]
    assert main([*args, "--region", "second:20,0,10,10", "--json"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert set(result["regions"]) == {"cloth", "second"}
    assert result["image"]["notes"] == ["no_icc_profile_assumed_srgb"]
    np.testing.assert_allclose(
        result["regions"]["cloth"]["linear_rgb"]["median"], [0.35, 0.22, 0.12], atol=0.003
    )
    assert str(path) not in json.dumps(result)
    assert main(args) == 0
    human = capsys.readouterr().out
    assert "paper-only" in human
    assert "dE00 <= " in human
    human.encode("cp1252")  # Windows console must not fail on Delta/inequality glyphs.
    with pytest.raises(SystemExit) as error:
        main([*args, "--region", "cloth:20,0,10,10"])
    assert error.value.code == 2
    with pytest.raises(SystemExit) as error:
        main([str(tmp_path / "missing.jpg"), *args[1:]])
    assert error.value.code == 2


def test_image_orientation_icc_and_unsupported_inputs(tmp_path, monkeypatch):
    path = tmp_path / "image.png"
    image = Image.new("RGB", (40, 20), (100, 120, 140))
    exif = Image.Exif()
    exif[274] = 6
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    image.save(path, exif=exif, icc_profile=profile)
    pixels, notes = read_image(path)
    assert pixels.shape == (40, 20, 3)
    assert notes == ["embedded_icc_converted_to_srgb"]
    np.testing.assert_array_equal(pixels[0, 0], [100, 120, 140])
    monkeypatch.setattr(c, "MAX_IMAGE_PIXELS", 10)
    with pytest.raises(ValueError, match="exceeds"):
        read_image(path)
    monkeypatch.undo()
    Image.new("RGBA", (20, 20), (100, 100, 100, 128)).save(path)
    with pytest.raises(ValueError, match="Transparent"):
        read_image(path)
    path = tmp_path / "cmyk.jpg"
    Image.new("CMYK", (20, 20)).save(path)
    with pytest.raises(ValueError, match="CMYK"):
        read_image(path)


def test_neutral_unknown_reflectance_sensitivity_and_white_balance():
    image = photo(white=(0.95682, 1, 0.92149), exposure=0.5)
    result = estimate_colours(image, PAPER, REGIONS, reference_kind="neutral")
    assert result["reference_kind"] == "neutral" and "paper" not in result
    assert result["neutral"]["reflectance_is_measured"] is False
    cloth = result["regions"]["cloth"]
    expected = np.array([0.35, 0.22, 0.12]) * 0.80 / 0.90
    np.testing.assert_allclose(cloth["linear_rgb"]["median"], expected)
    endpoints = cloth["neutral_uncertainty"]["linear_rgb_endpoints"]
    np.testing.assert_allclose(endpoints, [expected * 0.65 / 0.80, expected * 0.90 / 0.80])
    assert any("unknown" in warning for warning in result["limitations"])
    with pytest.raises(ValueError, match="Reference kind"):
        estimate_colours(image, PAPER, REGIONS, reference_kind="unknown")


def test_cli_neutral_exclusive_with_paper(tmp_path, capsys):
    path = tmp_path / "neutral.png"
    Image.fromarray(np.floor(photo() * 255 + 0.5).astype(np.uint8)).save(path)
    args = [str(path), "--neutral", "0,0,20,20", "--region", "cloth:20,0,20,20"]
    assert main([*args, "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["reference_kind"] == "neutral"
    assert main(args) == 0
    assert "neutral-only" in capsys.readouterr().out
    with pytest.raises(SystemExit) as error:
        main([*args, "--paper", "0,0,20,20"])
    assert error.value.code == 2
