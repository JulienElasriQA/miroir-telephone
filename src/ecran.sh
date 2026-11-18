#!/bin/zsh -f
# Structure allégée de l'écran Android : une ligne par élément utile (texte, description ou cliquable).
# Entrée : variable d'environnement MIROIR_SERIAL (aucun argument n'est interprété).
# Sortie : « Premier plan : <paquet> » puis « texte | resource-id court | clic:oui/non | x,y » (centre des bounds).
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
S=${MIROIR_SERIAL:-}
if [[ ! $S =~ '^[A-Za-z0-9._:-]+$' ]]; then
  echo "ecran.sh : MIROIR_SERIAL absent ou invalide" >&2
  exit 2
fi
command -v python3 >/dev/null || { echo "ecran.sh : python3 introuvable" >&2; exit 2; }

adb -s "$S" exec-out uiautomator dump /dev/tty 2>/dev/null | python3 -I -c '
import re, sys
from xml.etree import ElementTree as ET
raw = sys.stdin.read()
i, j = raw.find("<?xml"), raw.rfind("</hierarchy>")
if i < 0 or j < 0:
    sys.stderr.write("ecran.sh : dump uiautomator indisponible\n")
    sys.exit(1)
root = ET.fromstring(raw[i:j + len("</hierarchy>")])
nodes = list(root.iter("node"))
pkg = next((n.get("package") for n in nodes if n.get("package")), "inconnu")
print("Premier plan : " + pkg)
for n in nodes:
    txt = (n.get("text") or "").strip() or (n.get("content-desc") or "").strip()
    clic = n.get("clickable") == "true"
    m = re.match(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$", n.get("bounds") or "")
    if not m or not (txt or clic):
        continue
    x1, y1, x2, y2 = map(int, m.groups())
    rid = (n.get("resource-id") or "").split("/")[-1]
    txt = " ".join(txt.split())
    print("%s | %s | clic:%s | %d,%d" % (txt, rid, "oui" if clic else "non", (x1 + x2) // 2, (y1 + y2) // 2))
'
