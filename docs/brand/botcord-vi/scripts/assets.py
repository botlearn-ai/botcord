# -*- coding: utf-8 -*-
"""Generate the BotCord VI SVG asset pack (A1 Node·Cord)."""
import json, os, random, subprocess, sys

OUT = sys.argv[1]
OUTLINE = sys.argv[2]          # path to outline.py
FONT = sys.argv[3]             # Geist variable TTF
os.makedirs(f"{OUT}/logo", exist_ok=True)
os.makedirs(f"{OUT}/brand", exist_ok=True)

INK, INK_ON_DARK = "#13161A", "#F1F6FA"
ACCENT, ACCENT_ON_DARK = "#0D98A4", "#0BB6C5"
BG_DARK, BG_LIGHT = "#090B0E", "#FFFFFF"

# Mark geometry on a 48 grid. Visual bbox: x 1.5..46.5, y 7..41.
CORD = "M8.5 34 C 24 34, 24 14, 39.5 14"
N1, N2, R, STROKE = (8.5, 34), (39.5, 14), 7, 5.5
BX0, BY0, BX1, BY1 = 1.5, 7, 46.5, 41

def mark_body(ink, accent):
    return (f'<path d="{CORD}" stroke="{ink}" stroke-width="{STROKE}" stroke-linecap="round" fill="none"/>'
            f'<circle cx="{N1[0]}" cy="{N1[1]}" r="{R}" fill="{ink}"/>'
            f'<circle cx="{N2[0]}" cy="{N2[1]}" r="{R}" fill="{accent}"/>')

def outline(text, weight, tracking):
    out = subprocess.check_output(["uv", "run", "--no-project", "--python", "3.12", "--with", "fonttools", "--with", "uharfbuzz",
                                   "python", "-I", OUTLINE, FONT, text, str(weight), str(tracking)])
    return json.loads(out)

def write(name, svg):
    with open(f"{OUT}/{name}", "w", encoding="utf-8") as f:
        f.write(svg.strip() + "\n")

def svg(view, body, w=None, h=None, title="BotCord"):
    size = f' width="{w}" height="{h}"' if w else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}"{size} fill="none" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>')

# --- mark -------------------------------------------------------------------
VARIANTS = {
    "light": (INK, ACCENT), "dark": (INK_ON_DARK, ACCENT_ON_DARK),
    "black": (INK, INK), "white": ("#FFFFFF", "#FFFFFF"), "mono": ("currentColor", "currentColor"),
}
for v, (ink, acc) in VARIANTS.items():
    write(f"logo/botcord-mark-{v}.svg", svg("0 0 48 48", mark_body(ink, acc)))

# --- wordmark + lockups -----------------------------------------------------
wm = outline("BotCord", 600, -0.03)
CAP, WM_W = wm["capHeight"], wm["width"]

def wordmark_path(color):
    return f'<path d="{wm["d"]}" fill="{color}"/>'

for v, (ink, acc) in VARIANTS.items():
    if v == "mono":
        continue
    write(f"logo/botcord-wordmark-{v}.svg", svg(f"0 {-CAP} {WM_W:.0f} {CAP}", wordmark_path(ink)))

def lockup_h(ink, acc):
    # Mark visual height = 1.45 × cap height; mark centred on the cap band.
    s = 1.45 * CAP / (BY1 - BY0)
    gap = 0.42 * CAP
    cy = -CAP / 2
    tx, ty = -BX0 * s, cy - (BY0 + BY1) / 2 * s
    mark_w = (BX1 - BX0) * s
    top, bottom = cy - (BY1 - BY0) / 2 * s, cy + (BY1 - BY0) / 2 * s
    body = (f'<g transform="translate({tx:.1f} {ty:.1f}) scale({s:.3f})">{mark_body(ink, acc)}</g>'
            f'<g transform="translate({mark_w + gap:.1f} 0)">{wordmark_path(ink)}</g>')
    return svg(f"0 {top:.0f} {mark_w + gap + WM_W:.0f} {bottom - top:.0f}", body)

def lockup_v(ink, acc):
    s = 2.4 * CAP / (BY1 - BY0)
    mark_w, mark_h = (BX1 - BX0) * s, (BY1 - BY0) * s
    gap = 0.55 * CAP
    width = max(mark_w, WM_W)
    mx = (width - mark_w) / 2 - BX0 * s
    my = -BY0 * s
    tx = (width - WM_W) / 2
    ty = mark_h + gap + CAP
    body = (f'<g transform="translate({mx:.1f} {my:.1f}) scale({s:.3f})">{mark_body(ink, acc)}</g>'
            f'<g transform="translate({tx:.1f} {ty:.1f})">{wordmark_path(ink)}</g>')
    return svg(f"0 0 {width:.0f} {ty:.0f}", body)

for v, (ink, acc) in VARIANTS.items():
    if v == "mono":
        continue
    write(f"logo/botcord-lockup-horizontal-{v}.svg", lockup_h(ink, acc))
    write(f"logo/botcord-lockup-stacked-{v}.svg", lockup_v(ink, acc))

# --- app icons + favicon ----------------------------------------------------
def app_icon(bg, ink, acc, border=None):
    # Mark occupies ~62% of the tile width, optically centred.
    s = 1024 * 0.62 / (BX1 - BX0)
    tx = (1024 - (BX1 - BX0) * s) / 2 - BX0 * s
    ty = (1024 - (BY1 - BY0) * s) / 2 - BY0 * s
    stroke = f' stroke="{border}" stroke-width="4"' if border else ""
    body = (f'<rect x="2" y="2" width="1020" height="1020" rx="228" fill="{bg}"{stroke}/>'
            f'<g transform="translate({tx:.1f} {ty:.1f}) scale({s:.3f})">{mark_body(ink, acc)}</g>')
    return svg("0 0 1024 1024", body)

write("logo/botcord-app-icon-dark.svg", app_icon(BG_DARK, INK_ON_DARK, ACCENT_ON_DARK))
write("logo/botcord-app-icon-light.svg", app_icon(BG_LIGHT, INK, ACCENT, border="#DADEE3"))
write("logo/botcord-app-icon-brand.svg", app_icon(ACCENT, "#FFFFFF", "#FFFFFF"))
# Browser tab backgrounds do not necessarily follow the OS colour scheme.
write("logo/botcord-favicon.svg", '''
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">
  <!-- An opaque tile keeps the mark readable on selected, inactive and tinted browser tabs. -->
  <rect x="0.5" y="0.5" width="47" height="47" rx="11" fill="#F1F6FA" stroke="#DADEE3"/>
  <g transform="translate(4.8 4.8) scale(0.8)">
    <path d="M8.5 34 C 24 34, 24 14, 39.5 14" stroke="#13161A" stroke-width="5.5" stroke-linecap="round"/>
    <circle cx="8.5" cy="34" r="7" fill="#13161A"/>
    <circle cx="39.5" cy="14" r="7" fill="#0D98A4"/>
  </g>
</svg>
''')

# --- cord field (auxiliary graphic) ------------------------------------------
def cord_field(w, h, step, ink, acc, seed=7, line_op=0.18, node_op=0.35, accent_every=9, r=3.2, sw=1.6):
    rnd = random.Random(seed)
    cols, rows = int(w / step) + 2, int(h / step) + 2
    pts = {}
    for i in range(cols):
        for j in range(rows):
            if rnd.random() < 0.55:
                jx, jy = rnd.uniform(-.25, .25) * step, rnd.uniform(-.25, .25) * step
                pts[(i, j)] = (i * step + jx - step / 2, j * step + jy - step / 2)
    cords, nodes = [], []
    for (i, j), (x, y) in pts.items():
        for di, dj in ((1, 0), (1, -1), (1, 1), (2, -1)):
            q = pts.get((i + di, j + dj))
            if q and rnd.random() < 0.38:
                mx = (x + q[0]) / 2
                cords.append(f'M{x:.1f} {y:.1f} C {mx:.1f} {y:.1f}, {mx:.1f} {q[1]:.1f}, {q[0]:.1f} {q[1]:.1f}')
    body = f'<path d="{" ".join(cords)}" stroke="{ink}" stroke-opacity="{line_op}" stroke-width="{sw}" stroke-linecap="round" fill="none"/>'
    for k, (x, y) in enumerate(pts.values()):
        is_acc = k % accent_every == 0
        op = "" if is_acc else ' fill-opacity="%s"' % node_op
        body += (f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r * (1.25 if is_acc else 1):.1f}" fill="{acc if is_acc else ink}"'
                 f'{op}/>')
    return body

write("brand/botcord-cord-field-dark.svg",
      svg("0 0 1200 800", f'<rect width="1200" height="800" fill="{BG_DARK}"/>' + cord_field(1200, 800, 96, INK_ON_DARK, ACCENT_ON_DARK), title="BotCord cord field"))
write("brand/botcord-cord-field-light.svg",
      svg("0 0 1200 800", f'<rect width="1200" height="800" fill="{BG_LIGHT}"/>' + cord_field(1200, 800, 96, INK, ACCENT, line_op=0.14, node_op=0.25), title="BotCord cord field"))

# --- OG / social card ---------------------------------------------------------
head = outline("Where agents connect.", 600, -0.035)
sub = outline("The open messaging network for AI agents.", 400, -0.01)

def og(bg, ink, acc, muted, field_ink, field_acc, line_op, node_op):
    W, H = 1200, 630
    field = cord_field(W, H, 88, field_ink, field_acc, seed=11, line_op=line_op, node_op=node_op)
    # Fade the field on the left so text stays readable.
    fade = (f'<defs><linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="{bg}"/>'
            f'<stop offset=".45" stop-color="{bg}" stop-opacity=".92"/><stop offset="1" stop-color="{bg}" stop-opacity="0"/></linearGradient></defs>')
    hs = 76 / head["upm"]
    ss = 30 / sub["upm"]
    s = 1.45 * CAP / (BY1 - BY0) * (34 / 1000)
    lock = (f'<g transform="translate(80 92)"><g transform="translate({-BX0 * 1.4:.1f} {-BY0 * 1.4:.1f}) scale(1.4)">{mark_body(ink, acc)}</g>'
            f'<g transform="translate(78 47) scale({34 / 1000:.4f})">{wordmark_path(ink)}</g></g>')
    text = (f'<g transform="translate(80 400) scale({hs:.4f})"><path d="{head["d"]}" fill="{ink}"/></g>'
            f'<g transform="translate(82 462) scale({ss:.4f})"><path d="{sub["d"]}" fill="{muted}"/></g>')
    return svg(f"0 0 {W} {H}", fade + f'<rect width="{W}" height="{H}" fill="{bg}"/>' + field +
               f'<rect width="{W}" height="{H}" fill="url(#fade)"/>' + lock + text, W, H, "BotCord — Where agents connect.")

write("brand/botcord-og-dark.svg", og(BG_DARK, INK_ON_DARK, ACCENT_ON_DARK, "#A1A5A9", INK_ON_DARK, ACCENT_ON_DARK, 0.22, 0.4))
write("brand/botcord-og-light.svg", og("#F7FAFE", INK, ACCENT, "#5A5E62", INK, ACCENT, 0.16, 0.28))

# --- "on BotCord" badge -------------------------------------------------------
on = outline("on BotCord", 500, -0.01)

def badge(bg, ink, acc, border):
    H = 36
    ts = 15 / on["upm"]
    tw = on["width"] * ts
    W = 12 + 22 + 8 + tw + 14
    ms = 22 / 48
    body = (f'<rect x=".5" y=".5" width="{W - 1:.1f}" height="{H - 1}" rx="{(H - 1) / 2}" fill="{bg}" stroke="{border}"/>'
            f'<g transform="translate(12 7) scale({ms:.4f})">{mark_body(ink, acc)}</g>'
            f'<g transform="translate({12 + 22 + 8} {18 + on["capHeight"] * ts / 2:.1f}) scale({ts:.5f})"><path d="{on["d"]}" fill="{ink}"/></g>')
    return svg(f"0 0 {W:.0f} {H}", body, f"{W:.0f}", H, "on BotCord")

write("brand/badge-on-botcord-light.svg", badge("#FFFFFF", INK, ACCENT, "#DADEE3"))
write("brand/badge-on-botcord-dark.svg", badge("#13161A", INK_ON_DARK, ACCENT_ON_DARK, "#26292D"))
print("done")
