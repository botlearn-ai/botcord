# -*- coding: utf-8 -*-
import math, json, sys

def oklch_to_rgb(L, C, h):
    a = C * math.cos(math.radians(h)); b = C * math.sin(math.radians(h))
    l_ = L + 0.3963377774*a + 0.2158037573*b
    m_ = L - 0.1055613458*a - 0.0638541728*b
    s_ = L - 0.0894841775*a - 1.2914855480*b
    l, m, s = l_**3, m_**3, s_**3
    r = 4.0767416621*l - 3.3077115913*m + 0.2309699292*s
    g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
    bb = -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
    return r, g, bb

def in_gamut(rgb):
    return all(-1e-4 <= c <= 1 + 1e-4 for c in rgb)

def to_hex(L, C, h):
    # reduce chroma until in sRGB gamut
    c = C
    while c > 0 and not in_gamut(oklch_to_rgb(L, c, h)):
        c -= 0.002
    rgb = oklch_to_rgb(L, max(c, 0), h)
    def enc(x):
        x = min(max(x, 0), 1)
        return 12.92*x if x <= 0.0031308 else 1.055*x**(1/2.4) - 0.055
    return "#" + "".join("%02X" % round(enc(x)*255) for x in rgb), round(max(c, 0), 3)

def lum(hexs):
    v = [int(hexs[i:i+2], 16)/255 for i in (1, 3, 5)]
    v = [x/12.92 if x <= 0.04045 else ((x+0.055)/1.055)**2.4 for x in v]
    return 0.2126*v[0] + 0.7152*v[1] + 0.0722*v[2]

def contrast(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True)
    return round((la + 0.05)/(lb + 0.05), 2)

STEPS = [(50, .97), (100, .93), (200, .87), (300, .79), (400, .71), (500, .62), (600, .54), (700, .46), (800, .38), (900, .30), (950, .22)]
def taper(l):
    return max(.25, 1 - (l - .75)*3.5) if l > .75 else (.6 if l < .3 else 1)

def ramp(hue, chroma, steps=STEPS, tap=True):
    out = {}
    for k, l in steps:
        c = chroma * (taper(l) if tap else 1)
        hx, cc = to_hex(l, c, hue)
        out[str(k)] = {"hex": hx, "oklch": "oklch(%s %s %s)" % (l, cc, hue)}
    return out

NEUTRAL_STEPS = [(0, 1.0), (25, .985), (50, .97), (100, .94), (200, .9), (300, .84), (400, .72), (500, .58), (600, .48), (700, .38), (800, .28), (850, .22), (900, .2), (950, .15), (1000, .12)]
palette = {
  "cyan": ramp(205, .13),
  "neutral": ramp(250, .008, NEUTRAL_STEPS, tap=False),
  "green": ramp(150, .15),
  "amber": ramp(70, .15),
  "red": ramp(25, .19),
}
json.dump(palette, open(sys.argv[1], "w"), indent=1)
W = "#FFFFFF"
for name, r in palette.items():
    print(name, " ".join("%s:%s" % (k, v["hex"]) for k, v in r.items()))
c = palette["cyan"]; n = palette["neutral"]
print("\ncontrast on white:", {k: contrast(v["hex"], W) for k, v in c.items()})
print("contrast on n950:", {k: contrast(v["hex"], n["950"]["hex"]) for k, v in c.items()})
print("white on cyan600:", contrast(W, c["600"]["hex"]), "white on cyan700:", contrast(W, c["700"]["hex"]))
print("n950 on cyan400:", contrast(n["950"]["hex"], c["400"]["hex"]))
print("neutral on white:", {k: contrast(v["hex"], W) for k, v in n.items()})
for s in ("green", "amber", "red"):
    print(s, "on white:", {k: contrast(v["hex"], W) for k, v in palette[s].items() if k in ("500","600","700")},
          "on n950:", {k: contrast(v["hex"], n["950"]["hex"]) for k, v in palette[s].items() if k in ("300","400")})
# agent avatar palette: fixed L/C, 8 hues
agents = {}
for name, h in [("coral",25),("amber",65),("lime",115),("green",150),("cyan",205),("blue",250),("violet",290),("pink",335)]:
    hx, cc = to_hex(.6, .13, h)
    agents[name] = {"hex": hx, "oklch": "oklch(0.6 %s %s)" % (cc, h), "on_white": contrast(W, hx)}
print("\nagents", agents)
json.dump({"palette": palette, "agents": agents}, open(sys.argv[1], "w"), indent=1)
