"""Generates the isometric racetrack hero SVG for the µFW poster."""
import math

TH = math.radians(18)
T = 0.58
KZ = 0.87
OX, OY = 165, 129
S = 1.18               # world units to viewBox units
A, R = 72, 40          # straight half-length, track radius
ROAD = 8               # road half-width
H = 64                 # height of the wire layer
STEP_Z = 4.5           # height of the step platform

COS, SIN = math.cos(TH), math.sin(TH)

INK = "#1b1f2a"
MUTED = "#5b6372"
PURE, EFFECT, DATA, SEAM, ADAPTER = "#2563eb", "#e8590c", "#7c3aed", "#d6336c", "#64748b"
MONO = "ui-monospace, 'SF Mono', Menlo, monospace"


def P(u, v, z=0.0):
    """Projects a world point (u along the track, v across it, z up) to screen."""
    x = OX + (u * COS - v * SIN) * S
    y = OY + ((u * SIN + v * COS) * T - z * KZ) * S
    return (x, y)


def depth(u, v):
    """Screen depth: larger is closer to the viewer."""
    return u * SIN + v * COS


def path_d(points, closed=True):
    head, *rest = points
    d = f"M{head[0]:.2f},{head[1]:.2f} " + " ".join(f"L{x:.2f},{y:.2f}" for x, y in rest)
    return d + (" Z" if closed else "")


def stadium(a, r, n=28):
    """World points of a stadium outline, clockwise from the back-left."""
    pts = [(-a, -r), (a, -r)]
    pts += [(a + r * math.cos(t), r * math.sin(t)) for t in (math.radians(-90 + 180 * i / n) for i in range(1, n))]
    pts += [(a, r), (-a, r)]
    pts += [(-a + r * math.cos(t), r * math.sin(t)) for t in (math.radians(90 + 180 * i / n) for i in range(1, n))]
    return pts


def rounded_rect(u0, u1, v0, v1, rad, n=8):
    """World points of a rounded rectangle in the ground plane."""
    corners = [(u1 - rad, v0 + rad, -90), (u1 - rad, v1 - rad, 0), (u0 + rad, v1 - rad, 90), (u0 + rad, v0 + rad, 180)]
    pts = []
    for cu, cv, start in corners:
        for i in range(n + 1):
            t = math.radians(start + 90 * i / n)
            pts.append((cu + rad * math.cos(t), cv + rad * math.sin(t)))
    return pts


def hull(points):
    """Convex hull (monotone chain) of screen points."""
    pts = sorted(set((round(x, 3), round(y, 3)) for x, y in points))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def extrusion(world_pts, z0, z1, top_fill, side_fill, stroke, sw=0.5, extra=""):
    """A convex prism: side silhouette, then the top face."""
    top = [P(u, v, z1) for u, v in world_pts]
    bottom = [P(u, v, z0) for u, v in world_pts]
    side = hull(top + bottom)
    return (
        f'<path d="{path_d(side)}" fill="{side_fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round" {extra}/>'
        f'<path d="{path_d(top)}" fill="{top_fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round" {extra}/>'
    )


def text(x, y, s, size=3, weight=400, fill=INK, anchor="middle", family=None, extra=""):
    fam = f' font-family="{family}"' if family else ""
    return (f'<text x="{x:.2f}" y="{y:.2f}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
            f'text-anchor="{anchor}"{fam} {extra}>{s}</text>')


def floor_text(u, v, z, s, size, weight=700, fill=INK, spacing=0):
    """Text lying on a horizontal plane, its baseline along the track."""
    x, y = P(u, v, z)
    m = f"matrix({COS:.4f},{SIN * T:.4f},{-SIN:.4f},{COS * T:.4f},{x:.2f},{y:.2f})"
    return (f'<text transform="{m}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
            f'text-anchor="middle" letter-spacing="{spacing}">{s}</text>')


def face_text(u, v, z, s, size, weight=700, fill=INK, anchor="middle", family=None):
    """Text on a vertical face that runs along the track."""
    x, y = P(u, v, z)
    m = f"matrix({COS:.4f},{SIN * T:.4f},0,1,{x:.2f},{y:.2f})"
    fam = f' font-family="{family}"' if family else ""
    return (f'<text transform="{m}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
            f'text-anchor="{anchor}"{fam}>{s}</text>')


def shadow(u, v, z, r):
    x, y = P(u, v, z)
    return f'<ellipse cx="{x:.2f}" cy="{y + 0.6:.2f}" rx="{r * 1.25 * S:.2f}" ry="{r * T * 1.15 * S:.2f}" fill="#1b1f2a" opacity=".16" filter="url(#blur)"/>'


def cylinder(u, v, z, r, h, top, side, stroke, sw=0.7, dashed=False):
    circle = [(u + r * math.cos(2 * math.pi * i / 40), v + r * math.sin(2 * math.pi * i / 40)) for i in range(40)]
    dash = 'stroke-dasharray="1.6 1"' if dashed else ""
    return shadow(u, v, z, r) + extrusion(circle, z, z + h, top, side, stroke, sw, dash)


def function_node(u, v, z, name, sig, kind="pure", r=10, h=7):
    """A function: name on the top disc, signature on its side."""
    styles = {
        "pure": ("url(#pureTop)", "url(#pureSide)", PURE),
        "effect": ("url(#effTop)", "url(#effSide)", EFFECT),
    }
    top, side, stroke = styles[kind]
    out = cylinder(u, v, z, r, h, top, side, stroke, sw=0.8 if kind == "pure" else 1.0)
    cx, cy = P(u, v, z + h)
    out += text(cx, cy + 1.3, name, size=3.9 if len(name) < 8 else 3.5, weight=800)
    sx, sy = P(u + r * SIN, v + r * COS, z + h * 0.5)
    out += text(sx, sy + 1.1, sig, size=2.6 if len(sig) < 12 else 2.4, fill="#24325a", family=MONO, weight=600)
    return out


def slab(u, v, z, lu, lv, h, stroke=DATA, sw=0.7, top="#ffffff", front="url(#dataFront)", right="#e3d7ff"):
    """A cuboid; its visible faces are the top, the front (+v) and the right (+u)."""
    u0, u1, v0, v1 = u - lu / 2, u + lu / 2, v - lv / 2, v + lv / 2
    front_face = [P(u0, v1, z), P(u1, v1, z), P(u1, v1, z + h), P(u0, v1, z + h)]
    right_face = [P(u1, v0, z), P(u1, v1, z), P(u1, v1, z + h), P(u1, v0, z + h)]
    top_face = [P(u0, v0, z + h), P(u1, v0, z + h), P(u1, v1, z + h), P(u0, v1, z + h)]
    common = f'stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round"'
    return (f'<path d="{path_d(front_face)}" fill="{front}" {common}/>'
            f'<path d="{path_d(right_face)}" fill="{right}" {common}/>'
            f'<path d="{path_d(top_face)}" fill="{top}" {common}/>')


def data_node(u, v, z, lu, name, lines, stack=1, lines_du=0):
    """A schema'd value: name on the top face, its tags on the front face, older records stacked behind."""
    lv, h = 15, 10
    out = shadow(u, v, z, lu * 0.45)
    for i in range(stack - 1, 0, -1):
        out += slab(u + i * 2.2, v - i * 1.8, z, lu, lv, h, stroke="#a78bfa", sw=0.45, top="#f6f1ff", front="#efe7ff", right="#e7dcff")
    out += slab(u, v, z, lu, lv, h)
    tx, ty = P(u, v, z + h)
    out += text(tx, ty + 1.4, name, size=4 if len(name) < 10 else 3.6, weight=800)
    for i, line in enumerate(lines):
        out += face_text(u + lines_du, v + lv / 2, z + h - 3.6 - 3.1 * i, line, 2.3, 600, "#4c3a86", family=MONO)
    return out


def centerline(segment, s0, s1, z, n=24):
    """World points along a stretch of the track centreline."""
    if segment == "back":
        return [P(s0 + (s1 - s0) * i / n, -R, z) for i in range(n + 1)]
    if segment == "front":
        return [P(s0 + (s1 - s0) * i / n, R, z) for i in range(n + 1)]
    cu = A if segment == "right" else -A
    return [P(cu + R * math.cos(math.radians(s0 + (s1 - s0) * i / n)), R * math.sin(math.radians(s0 + (s1 - s0) * i / n)), z) for i in range(n + 1)]


def flow(points, color=INK, marker="ah", sw=0.9, dash=""):
    d = path_d(points, closed=False)
    da = f'stroke-dasharray="{dash}"' if dash else ""
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round" {da} marker-end="url(#{marker})"/>'


def pane_corners(seam):
    """World corners of a seam pane at ground level, across the road."""
    w = ROAD + 5
    if seam["at"] == "back":
        return (seam["u"], -R - w), (seam["u"], -R + w)
    cu = A + R if seam["at"] == "right" else -A - R
    return (cu - w, 0), (cu + w, 0)


def pane(seam):
    (u0, v0), (u1, v1) = pane_corners(seam)
    quad = [P(u0, v0, 0), P(u1, v1, 0), P(u1, v1, H), P(u0, v0, H)]
    out = f'<path d="{path_d(quad)}" fill="url(#paneFill)" stroke="none"/>'
    out += f'<path d="{path_d(quad)}" fill="none" stroke="{SEAM}" stroke-width="1.6" opacity=".22" filter="url(#glow)"/>'
    out += f'<path d="{path_d(quad)}" fill="none" stroke="{SEAM}" stroke-width=".55"/>'
    mid0, mid1 = P(u0, v0, 0), P(u1, v1, 0)
    out += f'<line x1="{mid0[0]:.2f}" y1="{mid0[1]:.2f}" x2="{mid1[0]:.2f}" y2="{mid1[1]:.2f}" stroke="{SEAM}" stroke-width="1.1" stroke-dasharray="1.8 1"/>'
    return out


def seam_top(seam):
    (u0, v0), (u1, v1) = pane_corners(seam)
    return P((u0 + u1) / 2, (v0 + v1) / 2, H)


def seam_card(seam):
    """A floating tag on top of a pane: the RPC, the port it stands for, the placements that wire it."""
    tx, ty = seam_top(seam)
    dx, dy = seam["card"]
    cx, cy = tx + dx, ty + dy
    width = seam["w"]
    top = cy - 10
    out = f'<line x1="{tx:.2f}" y1="{ty:.2f}" x2="{cx:.2f}" y2="{top + 16:.2f}" stroke="{SEAM}" stroke-width=".45" opacity=".8"/>'
    out += f'<circle cx="{tx:.2f}" cy="{ty:.2f}" r="1.1" fill="#fff" stroke="{SEAM}" stroke-width=".6"/>'
    out += (f'<rect x="{cx - width / 2:.2f}" y="{top:.2f}" width="{width}" height="16" rx="2.4" '
            f'fill="#fff" stroke="{SEAM}" stroke-width=".5" filter="url(#card)"/>')
    out += (f'<path d="M{cx - width / 2:.2f},{top + 5.6:.2f} v-3.2 a2.4,2.4 0 0 1 2.4,-2.4 h{width - 4.8:.2f} '
            f'a2.4,2.4 0 0 1 2.4,2.4 v3.2 z" fill="url(#seamHead)"/>')
    out += text(cx, top + 4.2, seam["name"], size=3.5, weight=800, fill="#fff", extra='letter-spacing=".2"')
    out += text(cx, top + 9.6, seam["port"], size=2.5, fill=INK, family=MONO, weight=600)
    out += text(cx, top + 13.5, seam["used"], size=2.3, fill=SEAM, extra='font-style="italic"')
    return out


SEAMS = [
    {"name": "Submit", "port": "IntentPort", "used": "server-owned · worker", "at": "back", "u": -45, "w": 32, "card": (-16, -6)},
    {"name": "Dispatch", "port": "ActionRunner", "used": "server-actions", "at": "back", "u": 1, "w": 28, "card": (6, -6)},
    {"name": "Present", "port": "ModelPort.present", "used": "server-model", "at": "right", "w": 32, "card": (18, -8)},
    {"name": "Representations", "port": "ModelPort.representations", "used": "server-owned · server-model · worker", "at": "left", "w": 44, "card": (-4, -8)},
]


def defs():
    return f"""<defs>
  <marker id="ah" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="3.6" markerHeight="3.6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{INK}"/></marker>
  <marker id="ah-pure" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="3.6" markerHeight="3.6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{PURE}"/></marker>
  <marker id="ah-faint" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="2.8" markerHeight="2.8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#b8a99a"/></marker>
  <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.1"/></filter>
  <filter id="soft" x="-20%" y="-20%" width="140%" height="160%"><feGaussianBlur stdDeviation="2.4"/></filter>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2"/></filter>
  <filter id="card" x="-20%" y="-30%" width="140%" height="180%"><feDropShadow dx="0" dy=".6" stdDeviation=".8" flood-color="#1b1f2a" flood-opacity=".14"/></filter>
  <linearGradient id="plateTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f3f0fa"/></linearGradient>
  <linearGradient id="plateSide" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dcd6ea"/><stop offset="1" stop-color="#c9c1dd"/></linearGradient>
  <linearGradient id="road" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef1f8"/><stop offset="1" stop-color="#e3e7f2"/></linearGradient>
  <linearGradient id="stepTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eaf1ff" stop-opacity=".92"/><stop offset="1" stop-color="#d7e4ff" stop-opacity=".92"/></linearGradient>
  <linearGradient id="stepSide" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b6fe0"/><stop offset="1" stop-color="#2557d6"/></linearGradient>
  <linearGradient id="pureTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e3ecff"/></linearGradient>
  <linearGradient id="pureSide" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#c5d6fb"/><stop offset=".55" stop-color="#e9f0ff"/><stop offset="1" stop-color="#a9c1f6"/></linearGradient>
  <linearGradient id="effTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff8f2"/><stop offset="1" stop-color="#ffe2cc"/></linearGradient>
  <linearGradient id="effSide" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffb27e"/><stop offset=".55" stop-color="#ffd9bd"/><stop offset="1" stop-color="#f58c45"/></linearGradient>
  <linearGradient id="dataFront" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1eaff"/><stop offset="1" stop-color="#ddd0fb"/></linearGradient>
  <linearGradient id="paneFill" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="{SEAM}" stop-opacity=".30"/><stop offset=".7" stop-color="{SEAM}" stop-opacity=".08"/><stop offset="1" stop-color="{SEAM}" stop-opacity=".16"/></linearGradient>
  <radialGradient id="effGlow"><stop offset="0" stop-color="#ff8a3d" stop-opacity=".55"/><stop offset="1" stop-color="#ff8a3d" stop-opacity="0"/></radialGradient>
  <linearGradient id="seamHead" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e64980"/><stop offset="1" stop-color="#c2255c"/></linearGradient>
</defs>"""


def ground():
    plate = stadium(A, R + ROAD + 10)
    out = f'<path d="{path_d(hull([P(u, v, -6) for u, v in plate] + [P(u, v, 0) for u, v in plate]))}" fill="#1b1f2a" opacity=".10" filter="url(#soft)" transform="translate(0,4)"/>'
    out += extrusion(plate, -5, 0, "url(#plateTop)", "url(#plateSide)", "#bfb6d6", 0.5)
    outer = [P(u, v) for u, v in stadium(A, R + ROAD)]
    inner = [P(u, v) for u, v in stadium(A, R - ROAD)]
    out += f'<path d="{path_d(outer)} {path_d(inner)}" fill="url(#road)" fill-rule="evenodd" stroke="#cfd5e3" stroke-width=".45"/>'
    out += face_text(38, R + ROAD + 10, -3.2, "@mufw/core · THE LOOP · one definition, every placement", 2.6, 700, "#7a7290")
    return out


def step_platform():
    region = rounded_rect(-84, 74, 4, R + ROAD + 4, 7)
    out = extrusion(region, 0, STEP_Z, "url(#stepTop)", "url(#stepSide)", "#5b8def", 0.5)
    face_v = R + ROAD + 4
    out += face_text(-80, face_v, 1.0, "THE STEP", 3.4, 900, "#ffffff", "start")
    out += face_text(-59, face_v, 1.15, "acceptors, then reactors · state · nap  —  pure · synchronous · under the model's permit · one record per proposal", 2.45, 600, "#ffffff", "start")
    return out


def ghost_layer():
    outer = [P(u, v, H) for u, v in stadium(A, R + ROAD)]
    inner = [P(u, v, H) for u, v in stadium(A, R - ROAD)]
    out = f'<path d="{path_d(outer)} {path_d(inner)}" fill="{SEAM}" fill-opacity=".05" fill-rule="evenodd" stroke="{SEAM}" stroke-width=".4" stroke-opacity=".45" stroke-dasharray="2 1.4"/>'
    out += floor_text(52, -R - ROAD - 3, H, "@mufw/rpc · THE WIRE LAYER", 3.6, 800, SEAM, 0.6)
    return out


def flows():
    zb, zf = 0.4, STEP_Z + 0.4
    out = ""
    out += flow(centerline("back", -51.5, -39.5, zb))
    out += flow(centerline("back", -5, 7.5, zb))
    out += flow(centerline("back", 30.5, 38.5, zb))
    right = centerline("back", 71, A, zb, 2) + centerline("right", -90, 90, zb)[1:]
    out += flow(right)
    out += flow(centerline("front", 49, 39.5, zf))
    out += flow(centerline("front", 5, -3, zf))
    out += flow(centerline("front", -25, -34, zf))
    out += flow(centerline("left", 94, 266, zb))
    return out


def nap_arc():
    pts = []
    u0, v0, z0 = -2, 10, STEP_Z + 6
    u1, v1, z1 = -7.5, -R, 10.6
    for i in range(41):
        t = i / 40
        u = u0 + (u1 - u0) * t
        v = v0 + (v1 - v0) * t
        z = z0 + (z1 - z0) * t + 12 * math.sin(math.pi * t)
        pts.append(P(u, v, z))
    out = f'<path d="{path_d(pts, closed=False)}" fill="none" stroke="{PURE}" stroke-width="2.6" opacity=".2" filter="url(#glow)"/>'
    out += flow(pts, PURE, "ah-pure", 0.9, "2.2 1.3")
    mx, my = pts[5]
    out += text(mx - 2.6, my + 0.6, "automatic intent", 2.8, 700, PURE, "end", extra='font-style="italic"')
    return out


def rep_to_nap():
    return flow([P(-35, R - 7.5, STEP_Z + 9), P(-10, 11, STEP_Z + 4)])


def actions_glow():
    x, y = P(19, -R)
    return f'<ellipse cx="{x:.2f}" cy="{y:.2f}" rx="30" ry="14" fill="url(#effGlow)"/>'


def view_node():
    u, v = -62, -R
    ring = [P(u + 14 * math.cos(2 * math.pi * i / 48), v + 14 * math.sin(2 * math.pi * i / 48), 0.2) for i in range(48)]
    out = f'<path d="{path_d(ring)}" fill="#ffffff" fill-opacity=".7" stroke="{ADAPTER}" stroke-width=".7" stroke-dasharray="1.8 1.1"/>'
    out += function_node(u, v, 0, "view", "rep ⇒ html")
    return out


def items():
    """Every object with its depth, painted far to near."""
    scene = [
        (depth(-62, -R), view_node()),
        (depth(-22, -R), data_node(-22, -R, 0, 32, "Intent", ["Open · PlaceBid", "Tick · Close"], lines_du=-4)),
        (depth(19, -R), function_node(19, -R, 0, "actions", "i ⇒ Effect&lt;p&gt;", "effect", r=10.5, h=11)),
        (depth(56, -R), data_node(56, -R, 0, 32, "Proposal", ["Bid · BidRejected", "Opened · Tick · Close"])),
        (depth(-2, 10), function_node(-2, 10, STEP_Z, "nap", "rep ⇒ i?", r=7.5, h=6)),
        (depth(60, R), function_node(60, R, STEP_Z, "acceptors", "(m, p) ⇒ m")),
        (depth(22, R), data_node(22, R, STEP_Z, 32, "Model", ["status · bids", "endsAt"], stack=3)),
        (depth(-14, R), function_node(-14, R, STEP_Z, "state", "m ⇒ rep")),
        (depth(-54, R), data_node(-54, R, STEP_Z, 38, "Representation", ["controlState", "highest"])),
    ]
    for seam in SEAMS:
        (u0, v0), (u1, v1) = pane_corners(seam)
        scene.append((depth((u0 + u1) / 2, (v0 + v1) / 2) + 0.5, pane(seam)))
    return "".join(svg for _, svg in sorted(scene, key=lambda item: item[0]))


KEY = [
    ("view", PURE, ["A pure function of the", "representation, mounted by an", "adapter. It renders and emits", "intents; it never decides."]),
    ("acceptors", PURE, ["Decide what the model becomes.", "A business “no” is a proposal", "(BidRejected), never an error."]),
    ("Model", DATA, ["Mutated only in layerModelLocal,", "under its permit. The slabs", "behind it are the history:", "one record per proposal."]),
    ("state", PURE, ["Derives the control state,", "never declared: opening · open", "· closing · sold."]),
    ("nap", PURE, ["At most one automatic intent,", "skipped while its intentKey is", "in flight. It joins after Submit,", "so it never crosses that wire."]),
    ("seams", SEAM, ["Each pane is a port a remote", "adapter from @mufw/rpc can cut.", "Italics: the placements that", "wire it. The domain never changes."]),
]


KEY_Y = 197


def key_row():
    """Notes for the nodes, in one row under the plate."""
    out = f'<line x1="4" y1="{KEY_Y}" x2="326" y2="{KEY_Y}" stroke="#ddd6c8" stroke-width=".3"/>'
    for i, (name, color, lines) in enumerate(KEY):
        x = 4 + i * 54.4
        out += f'<circle cx="{x + 1.4:.2f}" cy="{KEY_Y + 5.2}" r="1.4" fill="{color}"/>'
        out += text(x + 4.2, KEY_Y + 6.3, name, 3.1, 800, INK, "start")
        for j, line in enumerate(lines):
            out += text(x, KEY_Y + 11 + 3.6 * j, line, 2.6, 400, MUTED, "start")
    return out


def callouts():
    ax, ay = P(22, -R - 10.5, 10)
    c = [f'<path d="M294,57 Q{ax + 22:.2f},{ay - 14:.2f} {ax + 7:.2f},{ay - 2:.2f}" fill="none" stroke="#b8a99a" stroke-width=".45" marker-end="url(#ah-faint)"/>']
    c.append(text(326, 40, "The only effects.", 3.2, 800, EFFECT, "end"))
    c.append(text(326, 44.4, "CreditCheck and CurrentBidder are", 2.8, anchor="end"))
    c.append(text(326, 48.4, "services in R; time comes from", 2.8, anchor="end"))
    c.append(text(326, 52.4, "Effect's Clock. Never imports.", 2.8, anchor="end"))
    return "".join(c)


def build():
    body = (defs() + ground() + actions_glow() + ghost_layer() + step_platform() + flows() + rep_to_nap() + items()
            + nap_arc() + "".join(seam_card(s) for s in SEAMS) + callouts() + key_row())
    return (f'<svg class="fig" viewBox="0 0 330 228" font-family="-apple-system, \'Segoe UI\', Helvetica, Arial, sans-serif" '
            f'xmlns="http://www.w3.org/2000/svg">{body}</svg>')

