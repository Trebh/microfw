"""Builds docs/one-page.html from template.html, the figures drawn by hero.py and parts.py and the
fonts of fonts.py, then docs/one-page.png, the image README.md shows, with snapshot.mjs.

Run with `python3 docs/one-page/build.py`; the image needs `pnpm exec playwright install chromium` once.
"""
import subprocess
import sys
from pathlib import Path

import fonts
import hero
import parts

HERE = Path(__file__).parent
OUTPUT = HERE.parent / "one-page.html"


def render():
    """The poster with every {{NAME}} placeholder of the template replaced: the fonts, then each figure's SVG."""
    html = (HERE / "template.html").read_text(encoding="utf-8")
    parts_by_name = {"FONTS": fonts.font_faces(), **parts.build_all(), "HERO": hero.build()}
    for name, part in parts_by_name.items():
        html = html.replace("{{" + name + "}}", part)
    return html


def main():
    """Writes the poster and its image; stops before writing when a character has no Plex glyph."""
    html = render()
    missing = fonts.uncovered(html)
    if missing:
        sys.exit(f"one-page: no IBM Plex glyph for {' '.join(missing)}; use another character")
    OUTPUT.write_text(html, encoding="utf-8")
    subprocess.run(["node", str(HERE / "snapshot.mjs")], check=True)


if __name__ == "__main__":
    main()
