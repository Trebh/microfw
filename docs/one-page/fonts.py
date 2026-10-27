"""The poster's typefaces: IBM Plex Serif, Sans and Mono, embedded in the page as data URIs.

The files in fonts/ are IBM's own split woff2 files, unmodified, from the npm packages
@ibm/plex-sans 1.1.0, @ibm/plex-serif 2.0.0 and @ibm/plex-mono 2.5.0: the OFL reserves the name
"Plex", so a subset of our own would have to be renamed. Each face ships two files, Latin1 and Pi,
and each unicode-range below is the one IBM's CSS gives that file.
"""
import base64
from pathlib import Path
from typing import NamedTuple

FONTS = Path(__file__).parent / "fonts"

LATIN1 = ("U+0020-007E, U+00A0-00FF, U+0131, U+0152-0153, U+02C6, U+02DA, U+02DC, U+2013-2014, "
          "U+2018-201A, U+201C-201E, U+2020-2022, U+2026, U+2030, U+2039-203A, U+2044, U+20AC, U+2122, "
          "U+2212, U+FB01-FB02")

PI_SANS = ("U+0E3F, U+2000-200D, U+2015, U+2028-2029, U+202F, U+2032-2033, U+2070, U+2074-2079, "
           "U+2080-2089, U+2113, U+2116, U+2126, U+212E, U+2150-2151, U+2153-215E, U+2190-2199, "
           "U+21A9-21AA, U+21B0-21B3, U+21B6-21B7, U+21BA-21BB, U+21C4, U+21C6, U+2202, U+2206, U+220F, "
           "U+2211, U+2215, U+221A, U+221E, U+222B, U+2248, U+2260, U+2264-2265, U+25CA, U+2713, U+274C, "
           "U+2B0E-2B11, U+ECE0, U+EFCC, U+FEFF, U+FFFD")

PI_SERIF = ("U+0E3F, U+2000-200D, U+2010-2012, U+2015, U+2028-2029, U+202F, U+2032-2033, U+203E, U+2070, "
            "U+2074-2079, U+2080-2089, U+2113, U+2116, U+2126, U+212E, U+2150-2151, U+2153-215E, "
            "U+2190-2199, U+21A9-21AA, U+21B0-21B3, U+21B6-21B7, U+21BA-21BB, U+21C4, U+21C6, U+2202, "
            "U+2206, U+220F, U+2211, U+2215, U+2219-221A, U+221E, U+222B, U+2236, U+2248, U+2260, "
            "U+2264-2265, U+25CA, U+2713, U+274C, U+2B0E-2B11, U+ECE0, U+EFCC, U+FEFF, U+FFFD")

PI_MONO = ("U+03C0, U+0E3F, U+2000-200D, U+2010-2012, U+2015, U+2028-2029, U+202F, U+2032-2033, U+203E, "
           "U+205F, U+2070, U+2074-2079, U+2080-2089, U+2113, U+2116, U+2126, U+212E, U+2150-2151, "
           "U+2153-215E, U+2190-2199, U+21A9-21AA, U+21B0-21B3, U+21B6-21B7, U+21BA-21BB, U+21C4, U+21C6, "
           "U+2202, U+2206, U+220F, U+2211, U+2215, U+2219-221A, U+221E, U+222B, U+2236, U+2248, U+2260, "
           "U+2264-2265, U+2400-2421, U+2500-259F, U+25CA, U+2713, U+274C, U+2B0E-2B11, U+3000, U+FEFF, "
           "U+FFFD")


class Family(NamedTuple):
    name: str
    prefix: str
    pi: str


SANS = Family("IBM Plex Sans", "IBMPlexSans", PI_SANS)
SERIF = Family("IBM Plex Serif", "IBMPlexSerif", PI_SERIF)
MONO = Family("IBM Plex Mono", "IBMPlexMono", PI_MONO)


class Face(NamedTuple):
    family: Family
    style_name: str
    weight: int
    style: str


# The weights the poster asks for that Plex lacks (800, 900) resolve to Bold.
FACES = [
    Face(SANS, "Regular", 400, "normal"),
    Face(SANS, "SemiBold", 600, "normal"),
    Face(SANS, "Bold", 700, "normal"),
    Face(SANS, "Italic", 400, "italic"),
    Face(SANS, "SemiBoldItalic", 600, "italic"),
    Face(SANS, "BoldItalic", 700, "italic"),
    Face(SERIF, "Regular", 400, "normal"),
    Face(SERIF, "Bold", 700, "normal"),
    Face(MONO, "Regular", 400, "normal"),
    Face(MONO, "Medium", 500, "normal"),
    Face(MONO, "SemiBold", 600, "normal"),
    Face(MONO, "Bold", 700, "normal"),
]


def data_uri(file_name):
    """A woff2 file of fonts/ as a data URI."""
    encoded = base64.b64encode((FONTS / file_name).read_bytes()).decode("ascii")
    return f"data:font/woff2;base64,{encoded}"


def face_rule(face, subset, unicode_range):
    """The @font-face rule of one subset file of a face."""
    uri = data_uri(f"{face.family.prefix}-{face.style_name}-{subset}.woff2")
    return (f'@font-face {{ font-family: "{face.family.name}"; font-weight: {face.weight}; '
            f'font-style: {face.style}; src: url({uri}) format("woff2"); unicode-range: {unicode_range}; }}')


def font_faces():
    """Every @font-face rule of the poster, two per face."""
    rules = [face_rule(face, "Latin1", LATIN1) + "\n" + face_rule(face, "Pi", face.family.pi) for face in FACES]
    return "\n".join(rules)


def code_points(unicode_range):
    """The code points a CSS unicode-range lists."""
    points = set()
    for part in unicode_range.split(","):
        bounds = part.strip().removeprefix("U+").split("-")
        points.update(range(int(bounds[0], 16), int(bounds[-1], 16) + 1))
    return points


def family_points(family):
    """The code points a family's two files cover."""
    return code_points(LATIN1) | code_points(family.pi)


def uncovered(page):
    """The characters of the page some family has no glyph for: they would render in a system font."""
    covered_by_all = family_points(SANS) & family_points(SERIF) & family_points(MONO)
    return sorted({char for char in page if not char.isspace() and ord(char) not in covered_by_all})
