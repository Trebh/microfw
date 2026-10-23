"""Generates the pillar 2, pillar 3 and strip SVGs of the µFW poster, in the hero's vocabulary."""

INK, MUTED, FAINT = "#1b1f2a", "#5b6372", "#9aa1ad"
PURE, EFFECT, DATA, SEAM, ADAPTER, OK = "#2563eb", "#e8590c", "#7c3aed", "#d6336c", "#64748b", "#2f9e44"
MONO = "ui-monospace, 'SF Mono', Menlo, monospace"
SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"


def text(x, y, s, size=3, weight=400, fill=INK, anchor="middle", family=None, extra=""):
    fam = f' font-family="{family}"' if family else ""
    return (f'<text x="{x:.2f}" y="{y:.2f}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
            f'text-anchor="{anchor}"{fam} {extra}>{s}</text>')


def svg(view_box, body, cls="natural", extra=""):
    return f'<svg class="{cls}" viewBox="{view_box}" font-family="{SANS}" xmlns="http://www.w3.org/2000/svg" {extra}>{body}</svg>'


ICON_DEFS = f"""
  <linearGradient id="cylPure" x1="0" x2="1"><stop offset="0" stop-color="#9db8f5"/><stop offset=".5" stop-color="#d7e3fd"/><stop offset="1" stop-color="#7a9ff0"/></linearGradient>
  <linearGradient id="cylEff" x1="0" x2="1"><stop offset="0" stop-color="#ff9f5f"/><stop offset=".5" stop-color="#ffd2b0"/><stop offset="1" stop-color="#f07a2e"/></linearGradient>
  <filter id="pshadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy=".5" stdDeviation=".7" flood-color="#1b1f2a" flood-opacity=".12"/></filter>
  <g id="i-view"><ellipse cx="0" cy="3.2" rx="7" ry="3" fill="#fff" fill-opacity=".6" stroke="{ADAPTER}" stroke-width=".45" stroke-dasharray="1.2 .8"/>
    <path d="M-4.4,-1.6 v4.4 a4.4,2 0 0 0 8.8,0 v-4.4" fill="url(#cylPure)" stroke="{PURE}" stroke-width=".5"/>
    <ellipse cx="0" cy="-1.6" rx="4.4" ry="2" fill="#f2f6ff" stroke="{PURE}" stroke-width=".5"/>
    <text y="-0.85" text-anchor="middle" font-size="2.3" font-weight="800" fill="{PURE}">V</text></g>
  <g id="i-act"><path d="M-4.4,-1.6 v4.4 a4.4,2 0 0 0 8.8,0 v-4.4" fill="url(#cylEff)" stroke="{EFFECT}" stroke-width=".6"/>
    <ellipse cx="0" cy="-1.6" rx="4.4" ry="2" fill="#fff3ea" stroke="{EFFECT}" stroke-width=".6"/>
    <text y="-0.85" text-anchor="middle" font-size="2.3" font-weight="800" fill="{EFFECT}">A</text></g>
  <g id="i-model"><path d="M-5,-0.6 h8.4 v4.6 h-8.4 z" fill="#e6dafd" stroke="{DATA}" stroke-width=".5"/>
    <path d="M3.4,-0.6 l2,-2.4 v4.6 l-2,2.4 z" fill="#cdb8fa" stroke="{DATA}" stroke-width=".5"/>
    <path d="M-5,-0.6 l2,-2.4 h8.4 l-2,2.4 z" fill="#fff" stroke="{DATA}" stroke-width=".5"/>
    <text x="-0.8" y="2.9" text-anchor="middle" font-size="2.6" font-weight="800" fill="{DATA}">M</text></g>
  <g id="i-bang"><circle r="1.9" fill="{SEAM}" stroke="#fff" stroke-width=".4"/><text y=".95" text-anchor="middle" font-size="2.6" font-weight="900" fill="#fff">!</text></g>
"""

LANE_Y = (3, 34)       # top of browser lane, top of server lane
LANE_H = 25
SEAM_Y = 31

PLACEMENTS = [
    {"name": "browser-only", "top": ["view", "model", "act!"], "bottom": [], "seam": None,
     "rpcs": ["no RPC"], "cost": "0 calls per intent · offline"},
    {"name": "server-owned", "top": ["view"], "bottom": ["model", "act"], "seam": "Submit",
     "rpcs": ["Submit · Representations", "History"], "cost": "1 call per intent"},
    {"name": "server-model", "top": ["view", "act!"], "bottom": ["model"], "seam": "Present",
     "rpcs": ["Present · Representations", "History"], "cost": "1 call per intent"},
    {"name": "server-actions", "top": ["view", "model"], "bottom": ["act"], "seam": "Dispatch",
     "rpcs": ["Dispatch"], "cost": "1 call per action, ticks too"},
    {"name": "worker", "top": ["view"], "bottom": ["model", "act!"], "seam": "Submit · postMessage", "worker": True,
     "rpcs": ["Submit · Representations", "History · TravelTo"], "cost": "1 message per intent"},
]

ICON_ID = {"view": "i-view", "model": "i-model", "act": "i-act"}


def lane_chips(x, lane_top, chips):
    """Chips spread across one lane, with a ! badge on the permissive ones."""
    slots = {1: [20], 2: [14, 27], 3: [9, 20, 31]}.get(len(chips), [])
    cy = lane_top + LANE_H / 2 + 1
    out = ""
    for chip, dx in zip(chips, slots):
        kind = chip.rstrip("!")
        out += f'<use href="#{ICON_ID[kind]}" x="{x + dx:.2f}" y="{cy:.2f}"/>'
        if chip.endswith("!"):
            out += f'<use href="#i-bang" x="{x + dx + 5:.2f}" y="{cy - 4.6:.2f}"/>'
    return out


def seam_band(x, label):
    """The cut between the two lanes: a wire, or nothing."""
    if label is None:
        out = f'<line x1="{x + 2}" y1="{SEAM_Y}" x2="{x + 38}" y2="{SEAM_Y}" stroke="{FAINT}" stroke-width=".45"/>'
        out += f'<rect x="{x + 11}" y="{SEAM_Y - 2.2}" width="18" height="4.4" rx="2.2" fill="#fff" stroke="{FAINT}" stroke-width=".4"/>'
        return out + text(x + 20, SEAM_Y + 0.95, "no wire", 2.4, 700, MUTED)
    width = 5 + len(label) * 1.42
    out = f'<line x1="{x + 2}" y1="{SEAM_Y}" x2="{x + 38}" y2="{SEAM_Y}" stroke="{SEAM}" stroke-width=".7" stroke-dasharray="1.6 1"/>'
    out += f'<rect x="{x + 20 - width / 2:.2f}" y="{SEAM_Y - 2.4}" width="{width:.2f}" height="4.8" rx="2.4" fill="url(#seamPill)"/>'
    return out + text(x + 20, SEAM_Y + 0.95, label, 2.45, 800, "#fff")


def placement_column(i, p):
    x = 16 + i * 42.5
    worker = p.get("worker", False)
    bottom_fill = "url(#laneW)" if worker else "url(#laneS)"
    out = f'<rect x="{x}" y="1" width="40" height="60" rx="3" fill="#fff" stroke="#e7e1d6" stroke-width=".35" filter="url(#pshadow)"/>'
    out += f'<rect x="{x + 2}" y="{LANE_Y[0]}" width="36" height="{LANE_H}" rx="2" fill="url(#laneB)"/>'
    out += f'<rect x="{x + 2}" y="{LANE_Y[1]}" width="36" height="{LANE_H}" rx="2" fill="{bottom_fill}"/>'
    if worker:
        out += text(x + 3.6, LANE_Y[0] + 3.4, "page", 2.3, 700, PURE, "start", extra='font-style="italic"')
        out += text(x + 3.6, LANE_Y[1] + 3.4, "web worker", 2.3, 700, OK, "start", extra='font-style="italic"')
    out += lane_chips(x, LANE_Y[0], p["top"]) + lane_chips(x, LANE_Y[1], p["bottom"])
    out += seam_band(x, p["seam"])
    out += text(x + 20, 67, p["name"], 3.1, 800, INK, family=MONO)
    for j, line in enumerate(p["rpcs"]):
        out += text(x + 20, 71.4 + 3.6 * j, line, 2.35, 700, SEAM if line != "no RPC" else MUTED)
    out += text(x + 20, 79.8, p["cost"], 2.35, 400, MUTED)
    return out


def placements():
    defs = (f'<defs>{ICON_DEFS}'
            '<linearGradient id="laneB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef4ff"/><stop offset="1" stop-color="#dce8ff"/></linearGradient>'
            '<linearGradient id="laneS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4efe6"/><stop offset="1" stop-color="#e9e1d2"/></linearGradient>'
            '<linearGradient id="laneW" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9f8ee"/><stop offset="1" stop-color="#d3f0dc"/></linearGradient>'
            f'<linearGradient id="seamPill" x1="0" x2="1"><stop offset="0" stop-color="#e64980"/><stop offset="1" stop-color="#c2255c"/></linearGradient>'
            '</defs>')
    rows = (text(6, LANE_Y[0] + LANE_H / 2, "BROWSER", 2.5, 800, PURE, extra=f'letter-spacing=".5" transform="rotate(-90 6 {LANE_Y[0] + LANE_H / 2})" dominant-baseline="middle"')
            + text(6, LANE_Y[1] + LANE_H / 2, "SERVER", 2.5, 800, "#8a7a5c", extra=f'letter-spacing=".5" transform="rotate(-90 6 {LANE_Y[1] + LANE_H / 2})" dominant-baseline="middle"'))
    body = defs + rows + "".join(placement_column(i, p) for i, p in enumerate(PLACEMENTS))
    return svg("0 0 228 82", body)


STATES = [("opening", 8), ("open", 66), ("closing", 124), ("sold", 182)]


def state_box(name, x, terminal=False):
    y, w, h = 10, 38, 10.5
    if terminal:
        out = f'<rect x="{x - 1}" y="{y - 1}" width="{w + 2}" height="{h + 2}" rx="3.2" fill="none" stroke="{DATA}" stroke-width=".45"/>'
        out += f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="2.6" fill="url(#stateDark)" filter="url(#pshadow)"/>'
        return out + text(x + w / 2, y + 6.9, name, 3.4, 800, "#fff", family=MONO)
    out = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="2.6" fill="url(#stateFill)" stroke="{DATA}" stroke-width=".6" filter="url(#pshadow)"/>'
    return out + text(x + w / 2, y + 6.9, name, 3.4, 800, "#4c1d95", family=MONO)


def target_icon(kind, cx, cy):
    """Small line icons for the five ways a path reaches the system."""
    s = f'stroke="{OK}" stroke-width=".7" fill="none" stroke-linecap="round" stroke-linejoin="round"'
    icons = {
        "loop": f'<path d="M{cx + 3.2},{cy - 1.4} A3.4,3.4 0 1 0 {cx + 3.3},{cy + 1.2}" {s}/><path d="M{cx + 3.4},{cy - 3.6} v2.4 h-2.4" {s}/>',
        "rpc": f'<path d="M{cx - 4},{cy - 1.4} h7.4 M{cx + 1.6},{cy - 3.2} l1.8,1.8 l-1.8,1.8 M{cx + 4},{cy + 1.8} h-7.4 M{cx - 1.6},{cy + 0} l-1.8,1.8 l1.8,1.8" {s}/>',
        "worker": f'<rect x="{cx - 4}" y="{cy - 3.4}" width="8" height="6.8" rx="1.4" {s}/><path d="M{cx - 2},{cy - 0.9} h4 M{cx - 2},{cy + 1.1} h2.6" {s}/>',
        "dom": f'<rect x="{cx - 4.4}" y="{cy - 3.4}" width="8.8" height="6.8" rx="1" {s}/><path d="M{cx - 4.4},{cy - 1.5} h8.8" {s}/><circle cx="{cx - 3.3}" cy="{cy - 2.45}" r=".35" fill="{OK}"/><circle cx="{cx - 2.2}" cy="{cy - 2.45}" r=".35" fill="{OK}"/>',
        "server": f'<rect x="{cx - 4}" y="{cy - 3.6}" width="8" height="3.2" rx=".8" {s}/><rect x="{cx - 4}" y="{cy + 0.4}" width="8" height="3.2" rx=".8" {s}/><circle cx="{cx + 2.4}" cy="{cy - 2}" r=".45" fill="{OK}"/><circle cx="{cx + 2.4}" cy="{cy + 2}" r=".45" fill="{OK}"/>',
    }
    return icons[kind]


TARGETS = [
    ("loop", "the local loop", "layerLoopLocal"),
    ("rpc", "RPC, in-process", "Rpc.layerClientTest"),
    ("worker", "a web worker", "the worker's protocol"),
    ("dom", "the rendered DOM", "domDriver · Chromium"),
    ("server", "a live server", "test/live.ts"),
]


def oracle():
    defs = (f'<defs>{ICON_DEFS}'
            '<linearGradient id="stateFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#efe7ff"/></linearGradient>'
            '<linearGradient id="stateDark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#4c1d95"/></linearGradient>'
            '<linearGradient id="okFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eaf8ee"/></linearGradient>'
            '<linearGradient id="okBar" x1="0" x2="1"><stop offset="0" stop-color="#2f9e44"/><stop offset="1" stop-color="#0ca678"/></linearGradient>'
            f'<marker id="ah3" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="3.4" markerHeight="3.4" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{INK}"/></marker>'
            f'<marker id="ah3ok" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="3.4" markerHeight="3.4" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{OK}"/></marker>'
            '<linearGradient id="pill" x1="0" x2="1"><stop offset="0" stop-color="#1f2436"/><stop offset="1" stop-color="#2d3452"/></linearGradient>'
            '</defs>')
    graph = ""
    edges = [(46, 66, "Opened"), (104, 124, "Tick"), (162, 182, "Close")]
    for x0, x1, label in edges:
        graph += f'<line x1="{x0 + 0.6}" y1="15.25" x2="{x1 - 1}" y2="15.25" stroke="{INK}" stroke-width=".6" marker-end="url(#ah3)"/>'
        graph += text((x0 + x1) / 2, 13.2, label, 2.4, 600, MUTED, family=MONO)
    for x in (66, 124):
        graph += f'<path d="M{x + 12},{9.8} C{x + 9},2.2 {x + 29},2.2 {x + 26},9.4" stroke="{INK}" stroke-width=".6" fill="none" marker-end="url(#ah3)"/>'
        graph += text(x + 19, 2.6, "Bid · BidRejected · Tick", 2.3, 600, MUTED, family=MONO)
    for name, x in STATES:
        graph += state_box(name, x, terminal=name == "sold")
    graph += text(201, 26.4, "terminal", 2.3, 600, DATA, extra='font-style="italic"')

    pipeline = ""
    pills = [(4, 66, "exploreGraph(def, explore)"), (80, 70, "createTestModel(Auction, Ports, …)"), (164, 60, "shortestPaths · simplePaths")]
    for x, w, label in pills:
        pipeline += f'<rect x="{x}" y="0" width="{w}" height="8.4" rx="4.2" fill="url(#pill)"/>'
        pipeline += text(x + w / 2, 5.3, label, 2.55, 600, "#e6e8ee", family=MONO)
    pipeline += f'<line x1="70.6" y1="4.2" x2="79" y2="4.2" stroke="{INK}" stroke-width=".6" marker-end="url(#ah3)"/>'
    pipeline += f'<line x1="150.6" y1="4.2" x2="163" y2="4.2" stroke="{INK}" stroke-width=".6" marker-end="url(#ah3)"/>'
    pipeline += text(4, 13.6, "offline, from the pure step", 2.3, 600, MUTED, "start", extra='font-style="italic"')

    replay = f'<path d="M194,0 V5 M24,5 H200.8" stroke="{OK}" stroke-width=".7" fill="none"/>'
    for i, (kind, title, code) in enumerate(TARGETS):
        x = 4 + i * 44.2
        cx = x + 20
        replay += f'<line x1="{cx}" y1="5" x2="{cx}" y2="9.4" stroke="{OK}" stroke-width=".7" marker-end="url(#ah3ok)"/>'
        replay += f'<rect x="{x}" y="10.2" width="40" height="23" rx="2.8" fill="url(#okFill)" stroke="{OK}" stroke-width=".55" filter="url(#pshadow)"/>'
        replay += f'<g transform="translate({cx},17.4) scale(1.3) translate({-cx},-17.4)">{target_icon(kind, cx, 17.4)}</g>'
        replay += text(cx, 26.6, title, 3, 800)
        replay += text(cx, 30.5, code, 2.3, 500, MUTED, family=MONO)
    replay += f'<rect x="22" y="38" width="184" height="7.6" rx="3.8" fill="url(#okBar)"/>'
    replay += text(114, 42.9, "✓  one path test · five ways to reach the system · the same assertion at every node", 2.8, 700, "#fff")

    out = defs + graph + f'<g transform="translate(0,34)">{pipeline}</g>' + f'<g transform="translate(0,47)">{replay}</g>'
    return svg("0 0 228 93", out)


def rings():
    out = ('<defs>'
           f'<marker id="ah4" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="3" markerHeight="3" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{INK}"/></marker>'
           '<linearGradient id="core" x1="0" x2="1"><stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#4f46e5"/></linearGradient>'
           '</defs>')
    cx, cy = 41, 22
    layers = [(82, 44, "#fff", FAINT, ".45", "1.4 .9"), (70, 34, "#fbfaf7", ADAPTER, ".5", ""), (52, 22, "#e8f0ff", PURE, ".55", ""), (32, 10, "url(#core)", PURE, "0", "")]
    for w, h, fill, stroke, sw, dash in layers:
        da = f'stroke-dasharray="{dash}"' if dash else ""
        out += f'<rect x="{cx - w / 2}" y="{cy - h / 2}" width="{w}" height="{h}" rx="{h / 2}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {da}/>'
    out += text(cx, 3.6, "composition roots choose the layers", 2.35, 600, MUTED)
    out += text(cx, 9.4, "rpc · view-uhtml", 2.4, 600, INK, family=MONO)
    out += text(cx, 38.6, "devtools · test", 2.4, 600, INK, family=MONO)
    out += text(cx, 15.6, "ports · @mufw/core", 2.4, 700, PURE)
    out += text(cx, 23, "domain", 2.8, 800, "#fff")
    out += text(cx, 25.9, "SamDefinition", 2.1, 500, "#dbe6ff", family=MONO)
    for x0, x1 in ((0.6, 13.5), (81.4, 68.5)):
        out += f'<line x1="{x0}" y1="{cy}" x2="{x1}" y2="{cy}" stroke="{INK}" stroke-width=".55" marker-end="url(#ah4)"/>'
    return svg("0 0 82 44", out)


def history():
    out = ('<defs>'
           f'<marker id="ah5" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="2.8" markerHeight="2.8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{DATA}"/></marker>'
           '<linearGradient id="rec" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f1eaff"/></linearGradient>'
           '<linearGradient id="recHot" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#6d28d9"/></linearGradient>'
           '</defs>')
    tags = ["init", "Opened", "Bid", "Bid", "Tick", "Bid"]
    for i, tag in enumerate(tags):
        x = 1 + i * 13.3
        hot = i == 2
        out += f'<rect x="{x}" y="10" width="11" height="12.5" rx="1.8" fill="url(#rec)" stroke="{DATA}" stroke-width="{".85" if hot else ".45"}"/>'
        out += text(x + 5.5, 15.4, str(i), 3, 800 if hot else 700, DATA if hot else INK, family=MONO)
        out += text(x + 5.5, 19.9, tag, 2.1, 600, MUTED, family=MONO)
    x6 = 1 + 6 * 13.3
    out += f'<rect x="{x6}" y="10" width="11" height="12.5" rx="1.8" fill="url(#recHot)"/>'
    out += text(x6 + 5.5, 15.4, "6", 3, 800, "#fff", family=MONO)
    out += text(x6 + 5.5, 19.9, "travel", 2.1, 700, "#ede4ff", family=MONO)
    out += f'<path d="M85,9.6 C80,2.6 37,2.6 33,9.2" stroke="{DATA}" stroke-width=".55" fill="none" stroke-dasharray="1.4 .8" marker-end="url(#ah5)"/>'
    out += text(59, 4.2, "travelTo(2)", 2.6, 800, DATA, family=MONO)
    return svg("0 0 94 24", out)


def build_all():
    return {"PLACEMENTS": placements(), "ORACLE": oracle(), "RINGS": rings(), "HISTORY": history()}
