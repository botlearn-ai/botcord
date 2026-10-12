"""Outline text in Geist (instanced at a weight) to an SVG path, shaped with HarfBuzz."""
import sys, json
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb

font_path, text, weight, tracking_em = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
vf = TTFont(font_path)
inst = instancer.instantiateVariableFont(vf, {"wght": weight})
upm = inst["head"].unitsPerEm
glyphset = inst.getGlyphSet()
order = inst.getGlyphOrder()

blob = hb.Blob.from_file_path(font_path)
face = hb.Face(blob)
hbfont = hb.Font(face)
hbfont.set_variations({"wght": weight})
buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
hb.shape(hbfont, buf, {"kern": True, "liga": True})

pen = SVGPathPen(glyphset)
x = 0
track = tracking_em * upm
n = len(buf.glyph_infos)
for i, (info, pos) in enumerate(zip(buf.glyph_infos, buf.glyph_positions)):
    name = order[info.codepoint]
    # flip y: font units are y-up, SVG is y-down; baseline at y=0
    tp = TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, -pos.y_offset))
    glyphset[name].draw(tp)
    x += pos.x_advance + (track if i < n - 1 else 0)
os2 = inst["OS/2"]
print(json.dumps({"d": pen.getCommands(), "width": x, "upm": upm,
                  "capHeight": getattr(os2, "sCapHeight", None), "xHeight": getattr(os2, "sxHeight", None),
                  "ascender": inst["hhea"].ascent, "descender": inst["hhea"].descent}))
