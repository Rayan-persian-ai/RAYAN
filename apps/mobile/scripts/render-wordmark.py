#!/usr/bin/env python3
"""Render the Persian wordmark «رایان» to resources/wordmark.png.

ImageMagick's plain text renderer does not shape Arabic script (letters come
out unjoined and reversed), so the wordmark is rendered once with Pillow +
libraqm (HarfBuzz/FriBiDi) and committed. Re-run only if the name changes.

Usage: python3 scripts/render-wordmark.py <path-to-Vazirmatn-ExtraBold(.ttf|.woff)>
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, features

if not features.check("raqm"):
    sys.exit("Pillow was built without libraqm; Persian text would not be shaped.")
font_path = sys.argv[1] if len(sys.argv) > 1 else None
if not font_path:
    sys.exit(__doc__)
font = ImageFont.truetype(font_path, 260, layout_engine=ImageFont.Layout.RAQM)
text = "رایان"
bbox = font.getbbox(text, direction="rtl", language="fa")
w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
img = Image.new("RGBA", (w + 40, h + 40), (0, 0, 0, 0))
ImageDraw.Draw(img).text((20 - bbox[0], 20 - bbox[1]), text, font=font,
                         fill=(255, 255, 255, 255), direction="rtl", language="fa")
out = Path(__file__).resolve().parent.parent / "resources" / "wordmark.png"
img.save(out)
print(f"wrote {out} ({img.size[0]}x{img.size[1]})")
