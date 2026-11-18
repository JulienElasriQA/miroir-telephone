#!/bin/zsh -f
# Capture d'écran Android à chemin fixe (le dossier de travail du test est celui de ce script).
# Entrée : variable d'environnement MIROIR_SERIAL (validée). Seul argument accepté : N (deux chiffres) ou « ecran » (ou rien).
#   capture.sh NN    -> ./etapes/etape_NN.png (preuve d'étape)
#   capture.sh ecran -> ./ecran.png (observation ; c'est aussi le comportement sans argument)
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
umask 077
S=${MIROIR_SERIAL:-}
[[ $S =~ '^[A-Za-z0-9._:-]+$' ]] || { echo "capture.sh : MIROIR_SERIAL absent ou invalide" >&2; exit 2; }
W=${0:A:h}
if (( $# == 0 )) || [[ ${1:-} == ecran && $# == 1 ]]; then
  DEST="$W/ecran.png"
elif (( $# == 1 )) && [[ $1 =~ '^[0-9]{2}$' ]]; then
  mkdir -p "$W/etapes"
  DEST="$W/etapes/etape_$1.png"
else
  echo "capture.sh : argument invalide (attendu : deux chiffres ou « ecran »)" >&2
  exit 2
fi
TMP="$DEST.tmp"
adb -s "$S" exec-out screencap -p >"$TMP" 2>/dev/null
if [ -s "$TMP" ]; then mv -f "$TMP" "$DEST" && echo "$DEST"; else rm -f "$TMP"; echo "capture.sh : capture impossible" >&2; exit 1; fi
