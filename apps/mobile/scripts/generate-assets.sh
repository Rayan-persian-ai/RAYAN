#!/usr/bin/env bash
# Generate RAYAN app icons + splash screens with ImageMagick (open source).
#
#   bash scripts/generate-assets.sh [path/to/font]
#
# Inputs : resources/wordmark.png (pre-rendered, shaped Persian «رایان»)
#          font for the «ر» mark — default: Vazirmatn ExtraBold from the web
#          app's @fontsource package, else DejaVu Sans Bold (has Arabic glyphs).
# Outputs: resources/{icon,icon-foreground,splash}.png
#          android/app/src/main/res/{mipmap-*,drawable*}/...   (if android/ exists)
#          ../desktop/src-tauri/icons/*                         (Windows .ico + PNGs)
# The design is symmetric/centred so it reads the same in RTL and LTR layouts.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v magick >/dev/null && IM=magick || IM=convert
BG_INNER='#1e3a8a'; BG_OUTER='#0f172a'; ACCENT='#38bdf8'

FONT="${1:-}"
if [[ -z "$FONT" ]]; then
  for f in ../web/node_modules/@fontsource/vazirmatn/files/vazirmatn-arabic-800-normal.woff \
           ../../node_modules/@fontsource/vazirmatn/files/vazirmatn-arabic-800-normal.woff \
           /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf; do
    [[ -f "$f" ]] && FONT="$f" && break
  done
fi
[[ -n "$FONT" && -f "$FONT" ]] || { echo "No font found; pass one as \$1" >&2; exit 1; }
echo "font: $FONT"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p resources

# 1) The mark: «ر» glyph (white) + accent dot, trimmed, on transparent 1024².
$IM -size 1400x1400 xc:none -font "$FONT" -pointsize 900 -fill white \
    -gravity center -annotate +0+0 'ر' -trim +repage "$TMP/glyph.png"
$IM "$TMP/glyph.png" -resize x420 "$TMP/glyph-s.png"
GW=$($IM identify -format '%w' "$TMP/glyph-s.png" 2>/dev/null || identify -format '%w' "$TMP/glyph-s.png")
# Mark canvas 1024: glyph centred slightly left/down, dot above its right tip.
$IM -size 1024x1024 xc:none \
    "$TMP/glyph-s.png" -gravity center -geometry -30+40 -composite \
    -fill "$ACCENT" -draw "circle $((512 + GW/2 + 10)),330 $((512 + GW/2 + 10)),378" \
    "$TMP/mark.png"

# 2) Full-bleed square icon (legacy launchers, Windows, store listing).
$IM -size 1024x1024 radial-gradient:"$BG_INNER"-"$BG_OUTER" "$TMP/bg.png"
$IM "$TMP/bg.png" "$TMP/mark.png" -composite resources/icon.png

# 3) Adaptive-icon foreground: mark scaled into the 66/108 safe zone.
$IM -size 1024x1024 xc:none \( "$TMP/mark.png" -resize 72% \) -gravity center -composite \
    resources/icon-foreground.png

# 4) Splash (2732², centred so any crop works): mark + wordmark.
$IM -size 2732x2732 radial-gradient:"$BG_INNER"-"$BG_OUTER" \
    \( "$TMP/mark.png" -resize 900x900 \) -gravity center -geometry +0-220 -composite \
    \( resources/wordmark.png -resize x210 \) -gravity center -geometry +0+420 -composite \
    resources/splash.png

# Round + rounded-square masks.
mask_round() { $IM "$1" \( -size "$2x$2" xc:black -fill white -draw "circle $(( $2/2 )),$(( $2/2 )) $(( $2/2 )),0" \) \
    -alpha off -compose CopyOpacity -composite "$3"; }
mask_rrect() { local r=$(( $2 * 22 / 100 )); $IM "$1" \( -size "$2x$2" xc:black -fill white \
    -draw "roundrectangle 0,0 $(( $2-1 )),$(( $2-1 )) $r,$r" \) -alpha off -compose CopyOpacity -composite "$3"; }

# 5) Android resources.
RES=android/app/src/main/res
if [[ -d "$RES" ]]; then
  declare -A LAUNCHER=([mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192)
  declare -A FG=([mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432)
  declare -A PORT=([mdpi]=320x480 [hdpi]=480x800 [xhdpi]=720x1280 [xxhdpi]=960x1600 [xxxhdpi]=1280x1920)
  for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
    s=${LAUNCHER[$d]}; mkdir -p "$RES/mipmap-$d"
    $IM resources/icon.png -resize "${s}x${s}" "$TMP/l.png"
    mask_rrect "$TMP/l.png" "$s" "$RES/mipmap-$d/ic_launcher.png"
    mask_round "$TMP/l.png" "$s" "$RES/mipmap-$d/ic_launcher_round.png"
    f=${FG[$d]}; $IM resources/icon-foreground.png -resize "${f}x${f}" "$RES/mipmap-$d/ic_launcher_foreground.png"
    p=${PORT[$d]}; w=${p%x*}; h=${p#*x}
    mkdir -p "$RES/drawable-port-$d" "$RES/drawable-land-$d"
    $IM resources/splash.png -resize "${w}x${h}^" -gravity center -extent "${w}x${h}" "$RES/drawable-port-$d/splash.png"
    $IM resources/splash.png -resize "${h}x${w}^" -gravity center -extent "${h}x${w}" "$RES/drawable-land-$d/splash.png"
  done
  $IM resources/splash.png -resize 480x320^ -gravity center -extent 480x320 "$RES/drawable/splash.png"
  # Adaptive icon background colour (foreground PNG defined in mipmap-anydpi-v26).
  cat > "$RES/values/ic_launcher_background.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">$BG_OUTER</color>
</resources>
XML
  echo "android resources updated"
fi

# 6) Desktop (Tauri) icons — Windows needs icon.ico; PNGs for the bundle list.
ICONS=../desktop/src-tauri/icons
if [[ -d ../desktop/src-tauri ]]; then
  mkdir -p "$ICONS"
  mask_rrect resources/icon.png 1024 "$TMP/rr.png"
  $IM "$TMP/rr.png" -resize 32x32   "$ICONS/32x32.png"
  $IM "$TMP/rr.png" -resize 128x128 "$ICONS/128x128.png"
  $IM "$TMP/rr.png" -resize 256x256 "$ICONS/128x128@2x.png"
  $IM "$TMP/rr.png" -resize 512x512 "$ICONS/icon.png"
  $IM "$TMP/rr.png" -define icon:auto-resize=256,128,64,48,32,24,16 "$ICONS/icon.ico"
  # NSIS installer sidebar/header artwork is optional; keep defaults.
  echo "desktop icons updated"
fi
echo "done"
