# VI 生成脚本

从仓库根目录运行。需要 `uv`；字体文件（Geist 可变字体，OFL）不放进仓库，先下载到临时目录。

```bash
mkdir -p /tmp/bc-font && curl -sL -o /tmp/bc-font/Geist-VF.ttf \
  "https://github.com/google/fonts/raw/main/ofl/geist/Geist%5Bwght%5D.ttf"

VI=docs/brand/botcord-vi
# 1. 色阶（OKLCH → hex，含色域映射与对比度检查输出）
python3 -I $VI/scripts/colors.py /tmp/bc-palette.json
# 2. 设计 token：DTCG JSON + CSS 变量 + Tailwind v4 桥接
python3 -I $VI/scripts/tokens.py /tmp/bc-palette.json $VI/tokens
# 3. SVG 资产（字标用 Geist SemiBold 轮廓，HarfBuzz 排版）
uv run --no-project --python 3.12 python -I $VI/scripts/assets.py "$PWD/$VI/assets" \
  "$PWD/$VI/scripts/outline.py" /tmp/bc-font/Geist-VF.ttf
```

- 改色值、角色映射：改 `colors.py` / `tokens.py`，不要手改 `tokens/` 下的生成文件。
- 改 logo 几何：改 `assets.py` 顶部的 `CORD / N1 / N2 / R / STROKE`，并同步 `VI.md` 2.1 节和 `index.html` 里的同名常量。
