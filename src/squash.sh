#!/bin/zsh -f
# Client Squash TM en LECTURE SEULE : « squash.sh GET <chemin relatif de l'API> » écrit le JSON sur la sortie standard.
# Environnement (non secret, fourni par l'app) : MIROIR_SQUASH_URL = base de l'API, saisie dans les Paramètres. Aucune valeur par défaut.
# Codes de sortie : 0 = HTTP 2xx ; 2 = usage / méthode / chemin refusé ; 3 = token absent du trousseau ;
#                   4 = URL de base absente ou invalide ; 22 = HTTP d'erreur (message « HTTP <code> » sur la sortie d'erreur) ; autre = code curl (réseau).
#
# Endpoints utilisés (GET) :
#   projects?size=N&fields=name              liste paginée (_embedded.projects, page.totalElements)
#   projects/<id>/test-cases-library/content racine d'un projet : dossiers et cas (_embedded.test-case-library-content)
#   test-case-folders/<id>/content           enfants directs d'un dossier (_embedded.content), type = test-case-folder | test-case
#   test-cases/<id>?fields=...               cas complet (steps[action,expected_result], prerequisite, reference…)
#
# Sécurité : le token est lu dans le trousseau (service miroir-telephone-squash, compte = hôte[:port] de l'URL) DANS ce script, puis
# transmis à curl par la configuration lue sur l'entrée standard (-K -) : jamais dans un argv (ps), jamais dans l'environnement,
# jamais écrit. Le token d'un hôte n'est donc jamais envoyé à un autre hôte.
umask 077
export PATH=/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin
# Le token ne doit jamais passer par un proxy hérité de l'environnement
unset http_proxy https_proxy all_proxy no_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY

[[ $# -eq 2 ]] || { print -u2 "usage : squash.sh GET <chemin>"; exit 2; }
[[ $1 == GET ]] || { print -u2 "méthode refusée : lecture seule (GET uniquement)"; exit 2; }
P=$2

# Liste blanche des chemins (chaque motif accepte une chaîne de requête restreinte)
# Paramètres de requête : seulement size, page, fields, sort
PQ='(size|page|fields|sort)=[]A-Za-z0-9_,.[-]*'
QS="(\\?${PQ}(&${PQ})*)?"
OK=0
for re in \
  "projects$QS" \
  "projects/[0-9]+$QS" \
  "projects/[0-9]+/test-cases-library/content$QS" \
  "test-case-folders/[0-9]+$QS" \
  "test-case-folders/[0-9]+/content$QS" \
  "test-cases/[0-9]+$QS"; do
  [[ $P =~ "^${re}$" ]] && { OK=1; break; }
done
[[ $OK -eq 1 ]] || { print -u2 "chemin refusé (hors liste blanche)"; exit 2; }
[[ $P != *..* ]] || { print -u2 "chemin refusé"; exit 2; }

# Tomcat refuse les crochets bruts (HTTP 400) : on les encode après validation
P=${P//\[/%5B}; P=${P//\]/%5D}

BASE=${MIROIR_SQUASH_URL:-}
BASE=${BASE%/}
[[ -n $BASE ]] || { print -u2 "URL Squash non configurée (Paramètres)"; exit 4; }
# Validation générique : https://, hôte = nom DNS (lettres, chiffres, tirets, points), port facultatif 1-65535 (ni userinfo, ni ?, ni #),
# chemin terminé par /api/rest/latest
URE='^https://(([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:([0-9]{1,5}))?((/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*/api/rest/latest)$'
BAD() { print -u2 "URL Squash refusée (https://, nom d'hôte valide, port facultatif, chemin terminé par /api/rest/latest)"; exit 4; }
[[ $BASE =~ $URE ]] || BAD
HOST=${(L)match[1]}; PORT=${match[6]}
[[ ${#HOST} -le 253 && $HOST != token ]] || BAD
if [[ -n $PORT ]]; then (( PORT >= 1 && PORT <= 65535 )) || BAD; ACCT="$HOST:$((PORT))"; else ACCT=$HOST; fi

TOKEN=$(security find-generic-password -s miroir-telephone-squash -a "$ACCT" -w 2>/dev/null)
[[ -n $TOKEN && $TOKEN =~ '^[A-Za-z0-9._~+/=-]+$' ]] || { print -u2 "token Squash absent ou invalide pour cet hôte (Paramètres)"; exit 3; }

BODY=$(mktemp -t squash.XXXXXX) || exit 1
trap 'rm -f "$BODY"' EXIT

# print est un builtin : le token ne passe par aucun argv. -g : crochets non interprétés par curl.
CODE=$(print -r -- "url = \"$BASE/$P\"
header = \"Authorization: Bearer $TOKEN\"
header = \"Accept: application/json\"
output = \"$BODY\"
proto = \"=https\"
noproxy = \"*\"
silent
globoff
connect-timeout = 8
max-time = 25
write-out = \"%{http_code}\"" | curl -q -K - 2>/dev/null)
RC=$?
unset TOKEN
[[ $RC -eq 0 ]] || { print -u2 "réseau : curl code $RC"; exit $RC; }
if [[ $CODE == 2<-> ]]; then cat "$BODY"; exit 0; fi
print -u2 "HTTP $CODE"
exit 22
