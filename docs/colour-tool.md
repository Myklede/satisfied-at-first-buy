# Local photo colour tool (prompt 07 A)

Status: A implemented, 49 synthetic tests pass; targeted ruff lint/format pass and
web typecheck passes. Offline lock check passes; no `uv sync` run. Repo-wide lint
was red on the foreign E2 `BakeQueue.test.ts`; Round 2 explicitly permits targeted
gates. Real-photo calibration is the separate A2 step below.

This estimates **paper-relative diffuse albedo** under D65. It does not edit photos,
product data, materials or shaders, contact any service, or upload an image.

From PowerShell in the repository root, using the existing Python environment:

```powershell
$env:PIP_NO_INDEX = $null
$env:PYTHONPATH = "$PWD/services/body"
.venv/Scripts/python.exe -m body_service.lookdev.colour data/reference-photos/parka/front.jpg --paper 10,20,100,80 --region front:200,100,120,100 --region sleeve:400,150,60,100 --json
```

Replace the example path and rectangles with actual local files and measured pixel
coordinates. Omit `--json` for a readable report. The path above is illustrative,
not a bundled photo. No real photograph is required by the tests or committed.

- Rectangles are `x,y,width,height`, top-left origin, on the **EXIF-oriented** image,
  before any UI/display resize. A rectangle must fit entirely inside the image.
- Pick an unprinted, matte white sheet area and cloth regions under the **same light**.
  Avoid seams, deep folds, specular highlights, flash and mixed light. Multiple
  regions expose variation; they are not automatically averaged into one colour.
- Embedded ICC profiles are converted locally to sRGB. Untagged RGB/grayscale is
  explicitly labelled as assumed sRGB. CMYK without a profile, transparency,
  unsupported image modes and images larger than 40 MP are rejected.
- sRGB is decoded to linear light. Any pixel with any channel within one 8-bit
  code of black or white is excluded. On paper only, componentwise median/MAD
  rejection drops outliers. Too little usable paper or dark paper is an error.
- The paper median estimates the source white. Bradford adapts its chromaticity
  to D65; exposure is scaled so the paper maps to the assumed 0.90 reflectance.
  Ordinary copy paper's **0.88–0.92 range comes from prompt 07**, not a measurement
  of this particular sheet. Constants, standards and heuristic thresholds live
  in `services/body/body_service/lookdev/config.py`.
- Each garment region reports linear RGB and D65 CIELAB median, quartiles and IQR,
  sRGB hex, counts and warnings. Cloth texture/shadow variation is retained.
  Linear RGB is not gamut-clamped; only the display hex is clipped, with a warning.
- `paper_uncertainty` recomputes both reflectance endpoints and their maximum
  CIEDE2000 distance from nominal. This is **paper-only sensitivity**, not a total
  confidence interval. Camera tone mapping, paper tint/brighteners, unequal light,
  shadows and non-Lambertian cloth can introduce larger errors. A white sheet
  cannot recover spectral reflectance or remove those effects from one photo.

Test command (dedicated repository-local temporary directory; use a fresh suffix):

```powershell
.venv/Scripts/python.exe -m pytest services/body/tests/test_colour.py -q --basetemp=.cache/codex07/pytest-colour-new -o cache_dir=.cache/codex07/pytest-cache
```

Create `.cache/codex07` first if it does not exist. This uses synthetic arrays and
temporary synthetic images only. Published Sharma/Wu/Dalal CIEDE2000 reference
pairs test the formula separately from the synthetic illumination model.

## A2: unknown-reflectance neutral background

Use `--neutral x,y,w,h` instead of `--paper`; the two are mutually exclusive.
This performs the same Bradford chromatic adaptation but assumes background
reflectance 0.80, with 0.65–0.90 sensitivity endpoints (explicit look-dev assumptions,
not a measured material range). JSON uses `reference_kind: neutral`, `neutral`
and `neutral_uncertainty`; the original paper keys are preserved in paper mode.

Status: 51 tests pass, targeted ruff lint/format clean. All ten current photos were
inspected; 20 patch measurements and the qualified puffer recommendation are in
[the numeric report](look/colour-measurements.md). Five parka photos have no usable
independent neutral reference; their numbers are raw appearance only. A measured
parka albedo and real-paper rerun remain pending the user's A4 photos. No images,
product data or shaders were committed/changed for this step. Web typecheck was
already green for A; A2 changes Python only. No performance claim under shared load.
