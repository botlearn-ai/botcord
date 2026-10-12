# -*- coding: utf-8 -*-
"""Emit BotCord design tokens as W3C DTCG JSON (2025.10) and CSS custom properties."""
import json, sys
src, out_dir = sys.argv[1], sys.argv[2]
P = json.load(open(src))
pal, agents = P["palette"], P["agents"]

def color(hexv, desc=None, oklch=None):
    t = {"$type": "color", "$value": hexv}
    ext = {}
    if oklch: ext["oklch"] = oklch
    if ext: t["$extensions"] = {"ai.botcord": ext}
    if desc: t["$description"] = desc
    return t

def ref(path): return "{" + path + "}"

tokens = {
  "$description": "BotCord design tokens · VI v1.0 (Node·Cord). Hex values are canonical; OKLCH sources are in $extensions.",
  "color": {
    "palette": {name: {k: color(v["hex"], oklch=v["oklch"]) for k, v in steps.items()} for name, steps in pal.items()},
    "agent": {k: color(v["hex"], oklch=v["oklch"]) for k, v in agents.items()},
  },
}

# Semantic roles per theme: (light, dark) as palette references.
ROLES = {
  "bg":               ("neutral.25",  "neutral.950", "页面背景"),
  "surface":          ("neutral.0",   "neutral.850", "卡片、面板"),
  "surface-raised":   ("neutral.0",   "neutral.800", "弹层、菜单"),
  "surface-sunken":   ("neutral.50",  "neutral.1000", "输入框底、代码块"),
  "border":           ("neutral.200", "neutral.800", "默认边框"),
  "border-strong":    ("neutral.300", "neutral.700", "强调边框、分隔"),
  "text":             ("neutral.900", "neutral.50",  "主文字"),
  "text-secondary":   ("neutral.600", "neutral.400", "次要文字"),
  "text-tertiary":    ("neutral.500", "neutral.500", "占位、禁用"),
  "brand":            ("cyan.500",    "cyan.400",    "品牌色：logo 信号点、装饰，不用于小字"),
  "accent":           ("cyan.600",    "cyan.400",    "主按钮填充、选中态"),
  "accent-hover":     ("cyan.700",    "cyan.300",    "主按钮 hover"),
  "accent-text":      ("cyan.700",    "cyan.300",    "链接、强调文字"),
  "accent-soft":      ("cyan.50",     "cyan.950",    "选中背景、提示条"),
  "on-accent":        ("neutral.0",   "neutral.950", "accent 填充上的文字"),
  "success":          ("green.600",   "green.400",   "成功、已送达"),
  "success-soft":     ("green.50",    "green.950",   ""),
  "warning":          ("amber.600",   "amber.400",   "警告、等待授权"),
  "warning-soft":     ("amber.50",    "amber.950",   ""),
  "danger":           ("red.600",     "red.400",     "错误、危险操作"),
  "danger-soft":      ("red.50",      "red.950",     ""),
  "focus-ring":       ("cyan.500",    "cyan.400",    "键盘焦点环"),
}
for theme, idx in (("light", 0), ("dark", 1)):
    tokens["color"][theme] = {k: {"$type": "color", "$value": ref("color.palette." + v[idx]), **({"$description": v[2]} if v[2] else {})} for k, v in ROLES.items()}

tokens["font"] = {
  "family": {
    "sans": {"$type": "fontFamily", "$value": ["Geist", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", "system-ui", "sans-serif"]},
    "mono": {"$type": "fontFamily", "$value": ["Geist Mono", "SFMono-Regular", "Menlo", "monospace"]},
  },
  "weight": {k: {"$type": "fontWeight", "$value": v} for k, v in {"regular": 400, "medium": 500, "semibold": 600}.items()},
}
TYPE = [  # name, size, line-height, weight, tracking(em)
  ("display", 56, 1.05, 600, -0.04), ("h1", 36, 1.15, 600, -0.03), ("h2", 28, 1.2, 600, -0.025),
  ("h3", 22, 1.3, 600, -0.02), ("h4", 18, 1.4, 600, -0.01), ("body-lg", 16, 1.6, 400, 0),
  ("body", 14, 1.6, 400, 0), ("body-sm", 13, 1.5, 400, 0), ("caption", 12, 1.45, 500, 0), ("mono", 13, 1.5, 400, 0),
]
tokens["typography"] = {n: {"$type": "typography", "$value": {
    "fontFamily": ref("font.family.mono" if n == "mono" else "font.family.sans"),
    "fontSize": {"value": s, "unit": "px"}, "lineHeight": lh, "fontWeight": w,
    "letterSpacing": {"value": t, "unit": "em"} if t else {"value": 0, "unit": "px"}}} for n, s, lh, w, t in TYPE}
tokens["radius"] = {k: {"$type": "dimension", "$value": {"value": v, "unit": "px"}} for k, v in
                    {"xs": 4, "sm": 6, "md": 8, "lg": 12, "xl": 16, "2xl": 24, "full": 9999}.items()}
tokens["space"] = {str(k): {"$type": "dimension", "$value": {"value": k * 4, "unit": "px"}} for k in (0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24)}
tokens["shadow"] = {
  "sm": {"$type": "shadow", "$value": [{"color": "#13161A0F", "offsetX": {"value": 0, "unit": "px"}, "offsetY": {"value": 1, "unit": "px"}, "blur": {"value": 2, "unit": "px"}, "spread": {"value": 0, "unit": "px"}}]},
  "md": {"$type": "shadow", "$value": [{"color": "#13161A14", "offsetX": {"value": 0, "unit": "px"}, "offsetY": {"value": 4, "unit": "px"}, "blur": {"value": 16, "unit": "px"}, "spread": {"value": -2, "unit": "px"}}]},
  "lg": {"$type": "shadow", "$value": [{"color": "#13161A1F", "offsetX": {"value": 0, "unit": "px"}, "offsetY": {"value": 16, "unit": "px"}, "blur": {"value": 40, "unit": "px"}, "spread": {"value": -8, "unit": "px"}}]},
}
tokens["motion"] = {
  "duration": {k: {"$type": "duration", "$value": {"value": v, "unit": "ms"}} for k, v in
               {"instant": 80, "fast": 140, "base": 220, "slow": 360, "state-loop": 1400}.items()},
  "easing": {
    "standard": {"$type": "cubicBezier", "$value": [0.2, 0, 0, 1]},
    "enter": {"$type": "cubicBezier", "$value": [0, 0, 0, 1]},
    "exit": {"$type": "cubicBezier", "$value": [0.4, 0, 1, 1]},
  },
}
json.dump(tokens, open(f"{out_dir}/botcord.tokens.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)

# ---- CSS -------------------------------------------------------------------
def pal_hex(path):
    name, step = path.split(".")
    return pal[name][step]["hex"]

lines = ["/*", " * BotCord design tokens · VI v1.0 (Node·Cord)", " * Generated from botcord.tokens.json — do not edit by hand.",
         " * Theme switch: html[data-theme=\"dark\"] (matches the dashboard).", " */", "", ":root {"]
for name, steps in pal.items():
    for k, v in steps.items():
        lines.append(f"  --bc-{name}-{k}: {v['hex']};")
for k, v in agents.items():
    lines.append(f"  --bc-agent-{k}: {v['hex']};")
lines.append("")
for k, v in ROLES.items():
    lines.append(f"  --bc-{k}: var(--bc-{v[0].replace('.', '-')});")
lines += ["",
  '  --bc-font-sans: "Geist", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;',
  '  --bc-font-mono: "Geist Mono", SFMono-Regular, Menlo, monospace;']
for n, s, lh, w, t in TYPE:
    lines.append(f"  --bc-text-{n}: {w} {s}px/{lh} var(--bc-font-{'mono' if n == 'mono' else 'sans'});")
    if t:
        lines.append(f"  --bc-tracking-{n}: {t}em;")
for k, v in {"xs": 4, "sm": 6, "md": 8, "lg": 12, "xl": 16, "2xl": 24, "full": 9999}.items():
    lines.append(f"  --bc-radius-{k}: {v}px;")
lines += ["  --bc-shadow-sm: 0 1px 2px #13161A0F;", "  --bc-shadow-md: 0 4px 16px -2px #13161A14;", "  --bc-shadow-lg: 0 16px 40px -8px #13161A1F;",
          "  --bc-ease-standard: cubic-bezier(0.2, 0, 0, 1);", "  --bc-ease-enter: cubic-bezier(0, 0, 0, 1);", "  --bc-ease-exit: cubic-bezier(0.4, 0, 1, 1);",
          "  --bc-duration-fast: 140ms;", "  --bc-duration-base: 220ms;", "  --bc-duration-slow: 360ms;", "}", "", 'html[data-theme="dark"] {']
for k, v in ROLES.items():
    lines.append(f"  --bc-{k}: var(--bc-{v[1].replace('.', '-')});")
lines += ["  --bc-shadow-sm: 0 1px 2px #0000004D;", "  --bc-shadow-md: 0 4px 16px -2px #00000066;", "  --bc-shadow-lg: 0 16px 40px -8px #00000080;", "}", "",
          "@media (prefers-reduced-motion: reduce) {", "  :root { --bc-duration-fast: 0ms; --bc-duration-base: 0ms; --bc-duration-slow: 0ms; }", "}", ""]
open(f"{out_dir}/botcord.css", "w", encoding="utf-8").write("\n".join(lines))

# Tailwind v4 bridge: semantic colour utilities (bg-surface, text-text-secondary, border-border…).
# Colours only. Radius / shadow / font names would override Tailwind's own scale
# (e.g. rounded-xl 12px → 16px) and next/font's --font-sans, so those stay as
# --bc-* variables; see VI.md §9 for the VI → Tailwind class mapping.
tw = ["/*", " * Tailwind CSS v4 bridge for BotCord colour tokens. Import after botcord.css:", " *   @import \"./botcord.css\";", " *   @import \"./botcord.tailwind.css\";", " */", "@theme inline {"]
for k in ROLES:
    tw.append(f"  --color-{k}: var(--bc-{k});")
for k in agents:
    tw.append(f"  --color-agent-{k}: var(--bc-agent-{k});")
tw += ["}", ""]
open(f"{out_dir}/botcord.tailwind.css", "w", encoding="utf-8").write("\n".join(tw))
print("tokens ok", len(ROLES), "roles")
