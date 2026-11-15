"""Builds a plain .docx (no third-party packages) with every Devpost field for the user to paste."""

import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

story_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
story = story_path.read_text(encoding="utf-8").strip().splitlines()

blocks: list[tuple[str, str]] = []  # (kind, text): title | h1 | h2 | p | note | code


def add(kind: str, text: str = "") -> None:
    blocks.append((kind, text))


add("title", "Satisfied at First Buy — Devpost submission (HackPrinceton)")
add(
    "note",
    "Submission text in English, ready to paste. "
    "Fill in the university, Discord, track and rookie placeholders before submitting.",
)

add("h1", "Project name")
add("p", "Satisfied at First Buy")
add("h1", "Elevator pitch (tagline)")
add(
    "p",
    "See if it fits before you buy: a photoreal live try-on next to a 3D Fit Lab "
    "you can see through and touch.",
)

add("h1", "Project Story — About the project (paste as Markdown)")
add(
    "note",
    "Copy everything in the grey block below exactly as it is (the # and ** marks are Markdown).",
)
for line in story:
    add("code", line)

add("h1", "Built with (tags)")
add(
    "p",
    "typescript, three.js, react, vite, python, fastapi, pydantic, pytorch, mediapipe, "
    "webassembly, web-workers, webrtc, decart, anny, makehuman, opencv, node.js, "
    "vitest, pytest, playwright, claude",
)

add("h1", "Sponsor / Special Prizes (select)")
add(
    "p",
    "Recommended: [Amazon] Best Practical AI Innovation — the project targets online-clothing "
    "returns and includes an Amazon Fit Agent browser extension that reads a product page's "
    "size chart and runs our fit engine.",
)
add(
    "p",
    "Also recommended: [Justin Bojarski] Best Physical AI Hack — pinch gestures in front of the "
    "camera drive a real cloth simulation (zip, hood, hem), and the demo compares the "
    "prediction with the physical jacket on the wearer.",
)
add(
    "p",
    "Do not select: Gemini, Solana, Tiger Data, Vultr, MongoDB, GoDaddy, ChatOverflow, Photon, "
    "Capital One Nessie, CoStar, Peri, Arlequin AI, LangChain, SpaceXSI (not used). "
    "DEV Writing Challenge only if you also publish a DEV post.",
)

add("h1", "Public Git Repository")
add("p", "https://github.com/Myklede/satisfied-at-first-buy")

add("h1", "Universities / schools of team members")
add("p", "[Your university]")

add("h1", "Technology feedback #1 — Decart Lucy V-TON realtime API (@decartai/sdk)")
add(
    "p",
    "We used Decart's Lucy V-TON realtime model through @decartai/sdk as the photoreal renderer "
    "for our try-on. A small local server mints short-lived client tokens so the API key never "
    "reaches the browser. The WebRTC connection carries the generated video into the Studio. "
    "The result on our cream puffer and white parka looked convincing on a live camera. "
    "Pain points: our first sessions connected but ended with an immediate generation-ended "
    "error and no reason, so we added SDK logger hooks and the connectivity preflight to "
    "diagnose; later sessions worked and we never learned the cause. Clearer errors and credit "
    "information would help during onboarding. Our integration controls the appearance through "
    "a prompt and a reference image, so we map the zipper to discrete closed/open states. "
    "Half-zipped and hood-off appearances would benefit from state-specific reference photos. "
    "A structure-preserving control (e.g. a depth or mask input) would "
    "let developers keep their own garment geometry.",
)

add("h1", "Technology feedback #2 — Google MediaPipe Tasks (Pose and Hand Landmarker, web)")
add(
    "p",
    "MediaPipe pose and hand processing ran on-device in the browser, while the separately "
    "started Decart session sends camera video to the cloud. The Hand Landmarker supplies "
    "the pinch events we map to a virtual zipper; scripted tests verified the interaction path, "
    "while real-person reliability remains to be measured. The hard part was turning: during "
    "a body turn the pose can swap left and right or hold a stale heading for a few frames, "
    "so we wrote our own heading hysteresis, filtering and sanity checks on top. A built-in "
    "body-orientation estimate with a confidence value "
    "would help a lot for try-on apps.",
)

add("h1", "Did you implement a generative AI model or API? (select: Anthropic, Other)")
add(
    "p",
    "Yes. (1) Decart Lucy V-TON (Other): realtime generative video renders the photoreal jacket "
    "on the shopper's camera feed. It only provides the look; it never decides fit. Our own fit "
    "engine (Anny body model + measured garment data + per-zone ease) produces the size verdict, "
    "and our cloth solver handles the zipper and hood physics, whose state we pass to Decart "
    "as discrete prompt/reference updates. (2) Anthropic Claude (Anthropic): in our Amazon "
    "Fit Agent browser extension, Claude (via the Claude Code CLI) reads the size chart from "
    "a product page and turns it into structured garment measurements for our fit engine. "
    "Only product-page content is sent to the model — never body data.",
)

add("h1", "Gemini Project Number")
add("p", "N/A")

add("h1", "Discord usernames and names")
add("p", "[discord-username] - [Your Name]")

add("h1", "Main HackPrinceton track")
add("p", "[Choose from the dropdown — the track closest to e-commerce / consumer AI]")

add("h1", "Fraction of the team who are rookies")
add("p", '[Solo team: choose "all" if this is your first hackathon, otherwise "none"]')

add("h1", "Checkboxes")
add(
    "p",
    'Tick: "I have read and agree to all of HackPrinceton\'s rules" and '
    '"I acknowledge that I have opted into all '
    'opt-in sponsor tracks I want to be considered for" (after selecting the prizes above).',
)

add("h1", "Domain names registered with GoDaddy Registry")
add("p", "None")

FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>'
MONO = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'


def para(kind: str, text: str) -> str:
    t = escape(text)
    run_text = f'<w:t xml:space="preserve">{t}</w:t>'
    if kind == "title":
        return (
            '<w:p><w:pPr><w:spacing w:after="200"/></w:pPr><w:r><w:rPr>'
            f'{FONT}<w:b/><w:sz w:val="36"/></w:rPr>{run_text}</w:r></w:p>'
        )
    if kind == "h1":
        return (
            '<w:p><w:pPr><w:spacing w:before="320" w:after="120"/></w:pPr><w:r><w:rPr>'
            f'{FONT}<w:b/><w:color w:val="1D1D1F"/><w:sz w:val="28"/></w:rPr>'
            f"{run_text}</w:r></w:p>"
        )
    if kind == "note":
        return (
            '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr>'
            f'{FONT}<w:i/><w:color w:val="6E6E73"/><w:sz w:val="20"/></w:rPr>'
            f"{run_text}</w:r></w:p>"
        )
    if kind == "code":
        return (
            '<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>'
            '<w:spacing w:after="0" w:line="260" w:lineRule="auto"/></w:pPr>'
            f'<w:r><w:rPr>{MONO}<w:sz w:val="19"/></w:rPr>{run_text}</w:r></w:p>'
        )
    return (
        '<w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:rPr>'
        f'{FONT}<w:sz w:val="22"/></w:rPr>{run_text}</w:r></w:p>'
    )


body = "".join(para(k, t) for k, t in blocks)
document = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    f'<w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
    '<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" '
    'w:header="720" w:footer="720" w:gutter="0"/>'
    "</w:sectPr></w:body></w:document>"
)
content_types = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" '
    'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)
rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    "</Relationships>"
)
with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", rels)
    z.writestr("word/document.xml", document)
print(out_path, out_path.stat().st_size, "bytes,", len(blocks), "blocks")
