#!/bin/zsh
# Construit « Miroir Téléphone.app » dans build/. Avec --install, la copie dans ~/Applications.
set -euo pipefail

ROOT=${0:A:h}
NAME="Miroir Téléphone"
BUILD="$ROOT/build"
APP="$BUILD/$NAME.app"
VERSION=$(cat "$ROOT/VERSION")

rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$BUILD/AppIcon.iconset"

echo "→ Icône"
osascript -l JavaScript "$ROOT/scripts/make-icon.js" "$BUILD/icon-1024.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$BUILD/icon-1024.png" --out "$BUILD/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$BUILD/icon-1024.png" --out "$BUILD/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

echo "→ Bundle"
cp "$ROOT/src/miroir.js" "$APP/Contents/Resources/"
cat >"$APP/Contents/MacOS/miroir" <<'EOF'
#!/bin/zsh
# Lance le panneau JXA. exec garde le PID : le Dock et le menu affichent bien l'app.
export MIROIR_RES="${0:A:h:h}/Resources"
exec /usr/bin/osascript -l JavaScript "$MIROIR_RES/miroir.js" 2>>"$HOME/Library/Logs/MiroirTelephone.log"
EOF
chmod +x "$APP/Contents/MacOS/miroir"

cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>io.github.julienelasriqa.miroir-telephone</string>
  <key>CFBundleExecutable</key><string>miroir</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Miroir Téléphone pilote QuickTime Player pour afficher et filmer l’iPhone.</string>
</dict>
</plist>
EOF

codesign --force --deep --sign - "$APP" 2>/dev/null || echo "  (signature ad hoc ignorée)"
echo "✓ $APP"

if [[ ${1:-} == --install ]]; then
  DEST="$HOME/Applications/$NAME.app"
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" || true
  echo "✓ Installée : $DEST (Spotlight : « Miroir »)"
fi
