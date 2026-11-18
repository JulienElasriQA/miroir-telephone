// Génère les rapports HTML des tests Squash rejoués (lot C4). Script JXA autonome :
//   osascript -l JavaScript rapport.js cas      <dossier de preuves>          -> <dossier>/rapport.html
//   osascript -l JavaScript rapport.js campagne <dossier de sortie> <campagne.json>  -> <sortie>/Campagne_<stamp>.html
// Entrées : <dossier de preuves>/cas.json (écrit par l'app), rapport.txt, etape_NN.png, fin.png, video.mp4 (écrits par le runner).
// Tout texte inséré dans le HTML passe par esc() (& < > " '). Aucun secret n'est lu ni écrit ; chemins des preuves RELATIFS.
ObjC.import('Foundation')

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function readFile(p) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null)
  return s.isNil() ? null : ObjC.unwrap(s)
}
function writeFile(p, text) {
  $(text).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null)
  $.NSFileManager.defaultManager.setAttributesOfItemAtPathError($({ NSFilePosixPermissions: 384 /* 0600 */ }), p, null)
}
function listDir(p) {
  const a = $.NSFileManager.defaultManager.contentsOfDirectoryAtPathError(p, null)
  return a.isNil() ? [] : ObjC.deepUnwrap(a)
}
function readJson(p) {
  const t = readFile(p)
  if (t == null) throw new Error('fichier illisible : ' + p)
  return JSON.parse(t)
}

const V = {
  SUCCES: { icon: '✅', label: 'Réussi', color: '#1a7f37', bg: '#dafbe1' },
  ECHEC: { icon: '❌', label: 'Échec', color: '#cf222e', bg: '#ffebe9' },
  BLOQUE: { icon: '⚠️', label: 'Bloqué', color: '#9a6700', bg: '#fff8c5' },
  NON_EXECUTE: { icon: '⏹', label: 'Non exécuté', color: '#57606a', bg: '#eaeef2' },
}
const verdictOf = (c) => V[c] || V.NON_EXECUTE
const dur = (s) => { s = Math.max(0, Math.round(Number(s) || 0)); return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` }

const CSS = `
body{font:14px/1.5 -apple-system,Helvetica,Arial,sans-serif;margin:0;background:#f6f8fa;color:#1f2328}
main{max-width:980px;margin:0 auto;padding:24px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #d0d7de;padding-bottom:4px}
.badge{display:inline-block;padding:4px 12px;border-radius:14px;font-weight:600}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}th{background:#eaeef2}
pre{background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:12px;white-space:pre-wrap;word-wrap:break-word}
.meta td:first-child{width:170px;font-weight:600;background:#f6f8fa}
.shots{display:flex;flex-wrap:wrap;gap:12px}.shots figure{margin:0;width:200px;text-align:center;font-size:12px}
.shots img{width:200px;border:1px solid #d0d7de;border-radius:6px;background:#fff}
.note{color:#57606a;font-size:12px}
`
const page = (title, body) => `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
${body}
<p class="note">Rapport généré par Miroir Téléphone. Le contenu des cas de test (Squash TM) et le déroulé de l'agent sont affichés tels quels, échappés : ce sont des données non fiables.</p>
</main></body></html>
`

// ---------- Rapport d'un cas ----------
function rapportCas(dir) {
  const c = readJson(dir + '/cas.json')
  const v = verdictOf(c.verdict)
  const files = listDir(dir)
  const etapes = files.filter((f) => /^etape_\d{1,3}\.png$/.test(f)).sort()
  const hasFin = files.includes('fin.png')
  const hasVideo = files.includes('video.mp4')
  const txt = readFile(dir + '/rapport.txt') || ''
  const i = txt.indexOf('===== Déroulé')
  const deroule = i >= 0 ? txt.slice(i) : '(aucun déroulé de l’agent : le test s’est arrêté avant ou sans réponse)'

  const meta = [
    ['ID Squash', c.id], ['Référence', c.reference || '—'], ['Projet', c.project || '—'],
    ['Mode / modèle', `${c.mode || '?'} · ${c.model || '?'}`], ['Date', c.date || '—'], ['Durée', dur(c.durationSec)],
    ['Raison', c.reason || '—'],
  ].map(([k, val]) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`).join('')
  const shots = etapes.concat(hasFin ? ['fin.png'] : [])
    .map((f) => `<figure><a href="${esc(f)}"><img src="${esc(f)}" alt="${esc(f)}" loading="lazy"></a><figcaption>${esc(f)}</figcaption></figure>`).join('')
  const body = `<h1>${esc(c.name)}</h1>
<p><span class="badge" style="color:${v.color};background:${v.bg}">${v.icon} ${esc(v.label)}</span></p>
<table class="meta">${meta}</table>
<h2>Consigne rejouée</h2><pre>${esc(c.consigne)}</pre>
<h2>Déroulé de l'agent</h2><pre>${esc(deroule)}</pre>
<h2>Preuves</h2>
${hasVideo ? '<p><a href="video.mp4">Vidéo de l\'exécution (video.mp4)</a></p>' : '<p class="note">Pas de vidéo.</p>'}
${shots ? `<div class="shots">${shots}</div>` : '<p class="note">Aucune capture.</p>'}`
  writeFile(dir + '/rapport.html', page(`Cas ${c.id} — ${c.name}`, body))
  return dir + '/rapport.html'
}

// ---------- Rapport de campagne ----------
function rapportCampagne(outDir, file) {
  const k = readJson(file)
  const cases = k.cases || []
  const count = (code) => cases.filter((c) => (V[c.verdict] ? c.verdict : 'NON_EXECUTE') === code).length
  const totals = Object.keys(V).map((code) => {
    const n = count(code), v = V[code]
    return `<span class="badge" style="color:${v.color};background:${v.bg}">${v.icon} ${esc(v.label)} : ${n}</span>`
  }).join(' ')
  const rows = cases.map((c) => {
    const v = verdictOf(c.verdict)
    const link = c.dir && /^[A-Za-z0-9._-]+$/.test(c.dir) ? `<a href="${esc(c.dir)}/rapport.html">rapport</a>` : '—'
    return `<tr><td>${esc(c.id)}</td><td>${esc(c.name)}${c.reference ? ` <span class="note">(${esc(c.reference)})</span>` : ''}</td>` +
      `<td style="color:${v.color};font-weight:600">${v.icon} ${esc(v.label)}</td><td>${esc(c.reason || '')}</td><td>${esc(dur(c.durationSec))}</td><td>${link}</td></tr>`
  }).join('')
  const body = `<h1>Campagne ${esc(k.stamp)}</h1>
<p>${esc(k.project || '')} · ${esc(k.mode || '')} · ${esc(k.model || '')} · ${esc(k.date || '')} · durée ${esc(dur(k.durationSec))}</p>
<p>Statut : <strong>${esc(k.status || '')}</strong>${k.note ? ' — ' + esc(k.note) : ''}</p>
<p>${totals}</p>
<table><tr><th>ID</th><th>Cas de test</th><th>Verdict</th><th>Raison</th><th>Durée</th><th>Détail</th></tr>${rows}</table>`
  const out = `${outDir}/Campagne_${k.stamp}.html`
  if (!/^[A-Za-z0-9._-]+$/.test(String(k.stamp))) throw new Error('horodatage invalide')
  writeFile(out, page(`Campagne ${k.stamp}`, body))
  return out
}

function run(argv) {
  if (argv[0] === 'cas' && argv.length === 2) return rapportCas(argv[1])
  if (argv[0] === 'campagne' && argv.length === 3) return rapportCampagne(argv[1], argv[2])
  throw new Error('usage : rapport.js cas <dossier> | rapport.js campagne <dossier de sortie> <campagne.json>')
}
