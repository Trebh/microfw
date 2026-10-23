"""Builds docs/one-page.html from template.html and the figures drawn by hero.py and parts.py.

Run with `python3 docs/one-page/build.py`.
"""
from pathlib import Path

import hero
import parts

HERE = Path(__file__).parent
OUTPUT = HERE.parent / "one-page.html"


def render():
    """The poster with every {{FIGURE}} placeholder of the template replaced by its SVG."""
    html = (HERE / "template.html").read_text(encoding="utf-8")
    figures = {**parts.build_all(), "HERO": hero.build()}
    for name, figure in figures.items():
        html = html.replace("{{" + name + "}}", figure)
    return html


if __name__ == "__main__":
    OUTPUT.write_text(render(), encoding="utf-8")
