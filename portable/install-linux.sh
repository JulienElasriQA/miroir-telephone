#!/bin/sh
# Installe Miroir Téléphone pour l'utilisateur courant (sans sudo) : binaire dans ~/.local/bin,
# raccourci dans le menu des applications. Usage : ./install-linux.sh [chemin/vers/MiroirTelephone-linux-x86_64]
set -eu

SRC=${1:-./MiroirTelephone-linux-x86_64}
HERE=$(cd "$(dirname "$0")" && pwd)
BIN="$HOME/.local/bin"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"

[ -f "$SRC" ] || { echo "Binaire introuvable : $SRC" >&2; exit 1; }
mkdir -p "$BIN" "$APPS" "$ICONS"
install -m 755 "$SRC" "$BIN/miroir-telephone"
[ -f "$HERE/assets/icon.png" ] && cp "$HERE/assets/icon.png" "$ICONS/miroir-telephone.png"

cat >"$APPS/miroir-telephone.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Miroir Téléphone
Comment=Afficher, capturer et filmer un téléphone (expérimental)
Exec=$BIN/miroir-telephone
Icon=miroir-telephone
Categories=Development;Utility;
Terminal=false
EOF

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
echo "✓ Installé : $BIN/miroir-telephone (menu : « Miroir Téléphone »)"
