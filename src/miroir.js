// Miroir Téléphone : panneau macOS pour afficher, capturer et filmer un Android (scrcpy)
// et un iPhone (QuickTime) branchés en USB. Écrit en JXA (JavaScript for Automation) + Cocoa.
ObjC.import('Cocoa')
ObjC.import('CoreGraphics')
ObjC.import('Foundation')

const sys = Application.currentApplication()
sys.includeStandardAdditions = true
const qt = Application('QuickTime Player')

const HOME = ObjC.unwrap($.NSHomeDirectory())
const RES = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('MIROIR_RES')) || null

// ---------- Préférences ----------
const prefs = $.NSUserDefaults.alloc.initWithSuiteName('io.github.julienelasriqa.miroir-telephone')
function pref(key, dflt) {
  const v = prefs.objectForKey(key)
  return v.isNil() ? dflt : ObjC.unwrap(v)
}
const setPref = (key, value) => prefs.setObjectForKey($(value), key)
let OUT = pref('outputDir', HOME + '/Desktop')
let pinned = pref('pinned', true)

// ---------- Utilitaires ----------
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
function sh(cmd) {
  try {
    return sys.doShellScript('export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; ' + cmd, { alteringLineEndings: false }).trim()
  } catch (e) {
    return null
  }
}
const stamp = () => sh("date '+%Y-%m-%d_%H-%M-%S'")
// Mode silencieux : runner factice ou capture (MIROIR_SNAPSHOT*) -> ni son ni notification macOS. Seule une vraie exécution notifie.
const QUIET = !!ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('MIROIR_RUNNER')) || !!ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('MIROIR_SNAPSHOT'))
const ding = () => { if (!QUIET) sh('afplay /System/Library/Sounds/Glass.aiff >/dev/null 2>&1 &') }
const notify = (title, text) => { if (!QUIET) sh(`osascript -e ${q(`display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`)} >/dev/null 2>&1 &`) }
const fileOk = (f) => sh(`test -s ${q(f)} && echo ok`) === 'ok'
const alive = (pid) => !!pid && sh(`kill -0 ${pid} && echo ok`) === 'ok'
// Coupe une commande qui ne répond pas (serveur adb figé, etc.) pour ne jamais geler l'interface
const tmo = (sec, cmd) => `perl -e 'alarm shift; exec @ARGV' ${sec} ${cmd}`
const now = () => Date.now() / 1000
// Crée (700) un dossier de cache, uniquement sous ~/Library/Caches/MiroirTelephone/…, seulement si aucun composant du chemin
// (Library, Caches, MiroirTelephone, dossier) n'est un lien symbolique et si le chemin réel de chacun est exactement
// (HOME réel résolu + chemin attendu). Contrôle avant ET après mkdir ; true si prêt.
function safeDir(d) {
  if (!d.startsWith(HOME + '/Library/Caches/MiroirTelephone/')) return false
  const segs = d.slice(HOME.length + 1).split('/')
  return sh(`umask 077; H=$(cd -P ${q(HOME)} && pwd -P) || exit 1; segs=${q(segs.join(' '))}
    chk() { cur=${q(HOME)}; exp=$H; for g in $segs; do cur="$cur/$g"; exp="$exp/$g"
      if [ -e "$cur" ] || [ -L "$cur" ]; then [ ! -L "$cur" ] && [ "$(cd -P "$cur" && pwd -P)" = "$exp" ] || return 1; fi; done; }
    chk && mkdir -p ${q(d)} && chmod 700 ${q(d)} && chk && [ -d ${q(d)} ] && echo ok`) === 'ok'
}
const fmt = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const outLabel = () => (OUT === HOME + '/Desktop' ? 'Bureau' : OUT.replace(HOME, '~').split('/').pop())

// ---------- État ----------
const st = {
  hasScrcpy: !!sh('command -v scrcpy'), hasAdb: !!sh('command -v adb'),
  serial: null, androidUnauth: false, mirrorPid: null, mirrorStart: 0, mirrorRetries: 0, recPid: null, recFile: null, finalFile: null, recStart: 0,
  micPid: null, micFile: null, micStart: 0, micName: null, micLost: false, micLog: null, recTimes: null, watchPid: null, merges: [],
  ios: false, iosDoc: null, iosName: null, iosRec: false, iosStart: 0,
  testPid: null, testDir: null, testStart: 0, testStamp: null,
}

// ---------- Android ----------
function detectAndroid() {
  if (!st.hasAdb) return
  const lines = (sh(tmo(4, 'adb devices')) || '').split('\n').slice(1)
  const ready = lines.filter((l) => /\tdevice$/.test(l)).map((l) => l.split('\t')[0])
  st.serial = ready.includes(st.wifi) ? st.wifi : ready.includes(st.serial) ? st.serial : ready[0] || null
  st.androidUnauth = lines.some((l) => /\tunauthorized$/.test(l))
}

const SCRCPY_LOG = HOME + '/Library/Logs/MiroirTelephone-scrcpy.log'

// Nombre de fenêtres visibles d'un processus (sans permission particulière)
function visibleWindows(pid) {
  try {
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16 /* visibles, hors bureau */, 0)))
    return list.filter((w) => w.kCGWindowOwnerPID === Number(pid) && w.kCGWindowLayer === 0).length
  } catch (e) { return -1 }
}

function activatePid(pid) {
  const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pid))
  if (!a.isNil()) a.activateWithOptions(3 /* toutes les fenêtres, au premier plan */)
}

function killMirror() {
  if (alive(st.mirrorPid)) sh(`kill ${st.mirrorPid}; sleep 0.5`)
  st.mirrorPid = null
}

function startMirror(extra) {
  // Réveille l'écran : en veille (Doze), certains Samsung n'envoient aucune image et la fenêtre ne s'ouvre pas
  sh(tmo(3, `adb -s ${q(st.serial)} shell input keyevent KEYCODE_WAKEUP`))
  // Après un échec, bascule sur le tunnel adb « forward » (contourne « Server connection failed »)
  if (st.mirrorRetries > 0 && !/--force-adb-forward/.test(extra || '')) extra = `${extra || ''} --force-adb-forward`
  st.mirrorPid = sh(`scrcpy -s ${q(st.serial)} --stay-awake ${QUALITY[quality].args} ${extra || ''} --window-title 'Android' >>${q(SCRCPY_LOG)} 2>&1 & echo $!`)
  st.mirrorStart = now()
}

// Lancement automatique au branchement
function openAndroid() {
  if (!st.serial || !st.hasScrcpy || alive(st.mirrorPid)) return
  st.mirrorRetries = 0
  startMirror()
}

// Bouton « Miroir » : ramène la fenêtre au premier plan, sinon (fermée, réduite ou figée) relance scrcpy
function showAndroid() {
  if (!st.serial || !st.hasScrcpy) return '❌ Aucun Android prêt'
  if (alive(st.mirrorPid) && visibleWindows(st.mirrorPid) > 0) { activatePid(st.mirrorPid); return '🤖 Miroir Android au premier plan' }
  killMirror()
  st.mirrorRetries = 0
  startMirror()
  return '🤖 Ouverture du miroir Android…'
}

// Surveillance : scrcpy lancé mais sans fenêtre après 15 s (adb figé) → relance ; scrcpy mort au démarrage → erreur
function watchMirror() {
  if (!st.serial || !st.mirrorPid) return
  const age = now() - st.mirrorStart
  if (!alive(st.mirrorPid)) {
    st.mirrorPid = null
    if (age < 30 && st.mirrorRetries < 2) {
      st.mirrorRetries++
      startMirror()
      setStatus('🔄 Connexion au téléphone échouée : nouvel essai…')
    } else if (age < 30) setStatus('❌ Le miroir Android s’est fermé. Détails : ~/Library/Logs/MiroirTelephone-scrcpy.log')
  } else if (age > 15 && age < 60 && visibleWindows(st.mirrorPid) === 0 && st.mirrorRetries < 2) {
    st.mirrorRetries++
    killMirror()
    startMirror()
    setStatus('🔄 Miroir Android bloqué : relance en cours…')
  }
}

// ---------- Fonctions « Pro » : qualité, plein écran, sans fil, envoi de fichiers, partage ----------
const QUALITY = {
  standard: { label: 'Qualité standard', args: '--max-size 1024 --video-bit-rate 4M --max-fps 30' },
  haute: { label: 'Haute qualité', args: '--max-size 1920 --video-bit-rate 12M --max-fps 60' },
  max: { label: 'Qualité max', args: '--video-bit-rate 24M --max-fps 120' },
}
const QKEYS = ['standard', 'haute', 'max']
let quality = QUALITY[pref('quality', 'haute')] ? pref('quality', 'haute') : 'haute'
st.wifi = pref('wifiAddr', '') || null
const isWifi = (s) => !!s && s.includes(':')

function setQuality(i) {
  quality = QKEYS[i] || 'haute'
  setPref('quality', quality)
  if (alive(st.mirrorPid)) { killMirror(); startMirror() }
  return `🎚 ${QUALITY[quality].label} (${QUALITY[quality].args.replace(/--/g, '').replace(/ (\d)/g, ' $1')})`
}

function fullscreenAndroid() {
  killMirror()
  st.mirrorRetries = 0
  startMirror('--fullscreen')
  return '⛶ Plein écran : ⌘F dans le miroir pour en sortir'
}

function deviceIp() {
  const s = q(st.serial)
  return sh(`${tmo(5, `adb -s ${s} shell ip -f inet addr show wlan0`)} | awk '/inet /{print $2}' | cut -d/ -f1 | head -1`) ||
    sh(`${tmo(5, `adb -s ${s} shell ip route`)} | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}' | head -1`) || null
}

// Passe le téléphone en adb Wi-Fi (port 5555) puis s'y connecte ; un second clic revient à l'USB
function wirelessToggle() {
  if (isWifi(st.serial)) {
    killMirror()
    sh(tmo(5, `adb disconnect ${q(st.serial)}`))
    st.wifi = null; st.serial = null
    setPref('wifiAddr', '')
    return '📶 Mode sans fil désactivé : rebranche le câble USB'
  }
  const ip = deviceIp()
  if (!ip) return '✗ Adresse Wi-Fi introuvable : le téléphone est-il connecté au Wi-Fi ?'
  killMirror()
  sh(tmo(10, `adb -s ${q(st.serial)} tcpip 5555`))
  const addr = `${ip}:5555`
  let ok = false
  for (let i = 0; i < 6 && !ok; i++) { delay(1.5); ok = /connected to/.test(sh(tmo(5, `adb connect ${addr}`)) || '') }
  if (!ok) return `✗ Connexion sans fil impossible (${addr}) : Mac et téléphone sont-ils sur le même réseau ?`
  st.wifi = addr; st.serial = addr
  setPref('wifiAddr', addr)
  st.mirrorRetries = 0
  startMirror()
  return `📶 Sans fil actif (${addr}) : tu peux débrancher le câble`
}

// APK → installé ; autres fichiers → dossier Téléchargements du téléphone (le miroir accepte aussi le glisser-déposer)
function sendFiles() {
  const p = $.NSOpenPanel.openPanel
  p.setCanChooseFiles(true); p.setCanChooseDirectories(false); p.setAllowsMultipleSelection(true)
  p.setPrompt('Envoyer'); p.setMessage('APK : installé sur le téléphone. Autres fichiers : copiés dans Téléchargements.')
  if (Number(p.runModal) !== 1) return ''
  const urls = p.URLs
  let okCount = 0, ko = 0
  for (let i = 0; i < Number(urls.count); i++) {
    const f = ObjC.unwrap(urls.objectAtIndex(i).path)
    setStatus(`⬆️ Envoi de ${f.split('/').pop()}…`)
    const out = /\.apk$/i.test(f)
      ? sh(`${tmo(300, `adb -s ${q(st.serial)} install -r ${q(f)}`)} 2>&1`)
      : sh(`${tmo(600, `adb -s ${q(st.serial)} push ${q(f)} /sdcard/Download/`)} 2>&1`)
    if (out !== null && /\d+ files? pushed|^Success/m.test(out)) okCount++; else ko++
  }
  if (okCount) ding()
  return ko ? `⚠️ ${okCount} fichier(s) envoyé(s), ${ko} en échec` : `✅ ${okCount} fichier(s) envoyé(s) (APK installés, autres dans Téléchargements)`
}

// Partage sur le réseau local : copie la commande qu'un collègue lance pour voir et piloter le téléphone
function shareAndroid() {
  if (!isWifi(st.serial)) return 'ℹ️ Active d’abord le mode sans fil (bouton Wi-Fi) pour partager le téléphone sur le réseau local.'
  const cmd = `scrcpy --tcpip=${st.serial}`
  const pb = $.NSPasteboard.generalPasteboard
  pb.clearContents
  pb.setStringForType($(cmd), $.NSPasteboardTypeString)
  return `🔗 Copié : « ${cmd} ». À lancer sur un poste du même réseau ; le téléphone demandera d’autoriser ce poste.`
}

function androidCapture() {
  const f = `${OUT}/Android_${stamp()}.png`
  sh(`${tmo(15, `adb -s ${q(st.serial)} exec-out screencap -p`)} > ${q(f)}`)
  if (fileOk(f)) { ding(); return '✅ Capture Android enregistrée' }
  sh(`rm -f ${q(f)}`)
  return '❌ Échec de la capture Android'
}

// ---------- Micro du Mac pour les vidéos Android (ffmpeg + avfoundation, fusionné après coup avec la vidéo scrcpy) ----------
// Les micros sont choisis par leur NOM (les index avfoundation changent). Préférence micName : '' = désactivé, absente = défaut.
const MIC_DIR = HOME + '/Library/Caches/MiroirTelephone/micro'
const DEFAULT_MIC = 'Micro MacBook Pro'
const MIC_UNAVAILABLE = '🎙 Micro indisponible : autorise « Miroir Téléphone » dans Réglages Système → Confidentialité → Micro'
const MIC_AWK = String.raw`/audio devices:/{a=1;next} a&&match($0,/\] \[[0-9]+\] /){print substr($0,RSTART+RLENGTH)}`
// Surveille en arrière-plan (40 s max) l'instant où scrcpy crée le MP4 (début de son enregistrement) et celui où ffmpeg crée
// le m4a (début de la voix) : sert à mesurer le décalage entre la vidéo et la voix. (Le journal de scrcpy ne convient pas :
// redirigé vers un fichier, il n'est écrit qu'à la fin.)
const WATCH_PL = 'my ($mp4,$m4a,$out)=@ARGV; my ($r,$m); my $end=time+40; ' +
  'while (time<$end and !($r and $m)) { ' +
  '$r=time if !$r and -e $mp4; ' +
  '$m=time if !$m and -e $m4a; ' +
  'if ($r or $m) { open(O,">",$out.".tmp"); printf O "rec %.3f\nmic %.3f\n",$r||0,$m||0; close O; rename($out.".tmp",$out) } ' +
  'select(undef,undef,undef,0.03) }'
const hasFfmpeg = () => !!sh('command -v ffmpeg')

// Micros détectés par ffmpeg (noms exacts), jamais d'exception : liste vide si ffmpeg est absent
function detectMics() {
  if (!hasFfmpeg()) return []
  const out = sh(`${tmo(8, "ffmpeg -hide_banner -f avfoundation -list_devices true -i ''")} 2>&1 | awk ${q(MIC_AWK)}`) || ''
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
}

// Micro à utiliser : { name } | { off: true } (désactivé) | { missing: true } (choisi mais introuvable)
function micChoice(list) {
  const saved = pref('micName', null)
  if (saved === '') return { off: true }
  if (saved === null) return list.includes(DEFAULT_MIC) ? { name: DEFAULT_MIC } : list.length ? { name: list[0] } : { missing: true }
  return list.includes(saved) ? { name: saved } : { missing: true }
}

const isPid = (p) => /^\d+$/.test(String(p || ''))
const APP_PID = String(Number($.NSProcessInfo.processInfo.processIdentifier))
const MIC_MAX_SEC = 10800 // 3 h max par enregistrement micro
// Chien de garde : ffmpeg ne doit jamais survivre à l'app (Quitter depuis le Dock, Forcer à quitter, crash d'osascript).
// Il vérifie chaque seconde que l'app ET ffmpeg vivent ; si l'app disparaît, SIGTERM à ffmpeg (finalise le m4a), SIGKILL 5 s
// plus tard. Il s'arrête de lui-même dès que ffmpeg se termine. $F = PID de ffmpeg (défini juste avant dans la même commande).
const micWatchdog = (appPid) => `( while kill -0 ${appPid} 2>/dev/null && kill -0 $F 2>/dev/null; do sleep 1; done
  if kill -0 $F 2>/dev/null; then kill -TERM $F 2>/dev/null; i=0
    while [ $i -lt 5 ] && kill -0 $F 2>/dev/null; do sleep 1; i=$((i+1)); done
    kill -0 $F 2>/dev/null && kill -9 $F 2>/dev/null; fi ) </dev/null >/dev/null 2>&1 &`

function androidVideoToggle() {
  if (st.recPid) return stopAndroidVideo()
  const ts = stamp()
  // finalFile = fichier livré dans le dossier de sortie ; recFile = fichier écrit par scrcpy (le cache quand le micro est actif)
  st.finalFile = `${OUT}/Android_${ts}.mp4`
  st.ts = ts
  st.recFile = st.finalFile
  st.micPid = null; st.micFile = null; st.micName = null; st.micLost = false; st.watchPid = null
  const mic = micChoice(detectMics())
  let note = ''
  const cmds = []
  if (mic.name && isPid(APP_PID) && safeDir(MIC_DIR)) {
    st.micName = mic.name
    st.micFile = `${MIC_DIR}/micro_${ts}.m4a`
    st.micLog = `${MIC_DIR}/micro_${ts}.log`
    cmds.push(`umask 077; ffmpeg -nostdin -loglevel error -f avfoundation -i ${q(':' + mic.name)} -t ${MIC_MAX_SEC} -ac 1 -c:a aac ${q(st.micFile)} >/dev/null 2>${q(st.micLog)} & F=$!; echo $F
${micWatchdog(APP_PID)}`)
  } else if (mic.name || mic.missing) note = MIC_UNAVAILABLE
  const hasMic = cmds.length > 0
  if (hasMic) st.recFile = `${MIC_DIR}/video_${ts}.mp4`
  if (hasMic) st.recTimes = `${MIC_DIR}/temps_${ts}.txt`
  cmds.push(`scrcpy -s ${q(st.serial)} ${QUALITY[quality].args} --no-playback --no-window --record ${q(st.recFile)} >/dev/null 2>&1 & echo $!`)
  if (hasMic) cmds.push(`perl -MTime::HiRes=time -e ${q(WATCH_PL)} ${q(st.recFile)} ${q(st.micFile)} ${q(st.recTimes)} >/dev/null 2>&1 & echo $!`)
  st.micStart = now()
  const pids = (sh(cmds.join('\n')) || '').split('\n').map((l) => l.trim()).filter(isPid)
  st.recStart = now()
  if (hasMic) {
    st.micPid = pids[0] || null
    st.recPid = pids[1] || null
    st.watchPid = pids[2] || null
    if (!st.micPid) { st.micFile = null; note = MIC_UNAVAILABLE }
  } else st.recPid = pids[0] || null
  if (!st.recPid && (st.micPid || st.watchPid)) {
    // scrcpy n'a pas démarré : arrêt de ffmpeg et du watcher, nettoyage des fichiers temporaires
    killRec()
    ;[st.micFile, st.micLog, st.recTimes, st.recTimes && st.recTimes + '.tmp', st.recFile !== st.finalFile && st.recFile].forEach((f) => { if (f) sh(`rm -f ${q(f)}`) })
    st.micPid = null; st.watchPid = null; st.micFile = null
  }
  return st.recPid ? (note || (st.micPid ? '🔴 Vidéo Android + micro en cours…' : '🔴 Vidéo Android en cours…')) : '❌ Impossible de démarrer la vidéo Android'
}

// SIGTERM à scrcpy ET à ffmpeg, puis attente de la fin des deux. SIGTERM (et non SIGINT : un processus lancé en arrière-plan
// par un shell non interactif ignore SIGINT) : scrcpy finalise le MP4, ffmpeg finalise le m4a. Si ffmpeg reste bloqué plus de 4 s
// (autorisation micro en attente), SIGKILL ; pour scrcpy, 30 s.
// Le watcher perl de décalage (st.watchPid) est aussi arrêté ici : il ne doit plus écrire temps_*.txt après l'arrêt.
function killRec() {
  const pids = [st.recPid, st.micPid, st.watchPid].filter(isPid)
  st.watchPid = null
  if (!pids.length) return
  const L = pids.join(' ')
  const mic = isPid(st.micPid) ? st.micPid : ''
  sh(`for p in ${L}; do kill -TERM $p 2>/dev/null; done; i=0
    while [ $i -lt 150 ]; do
      live=0; for p in ${L}; do kill -0 $p 2>/dev/null && live=1; done
      [ $live = 0 ] && break
      if [ $i -eq 20 ] && [ -n "${mic}" ]; then kill -9 ${mic} 2>/dev/null; fi
      i=$((i+1)); sleep 0.2
    done
    for p in ${L}; do kill -0 $p 2>/dev/null && kill -9 $p 2>/dev/null; done; true`)
}

// Livraison : copie src -> dst puis vérifie que dst existe, n'est pas vide et a la même taille (code 0 si tout est bon).
// Seule opération faite dans le dossier de sortie : UNE création (cp). Jamais de renommage ni de suppression là-bas.
// dl crée la destination de façon atomique (noclobber : O_EXCL, refuse un fichier existant ou un lien, même cassé, sans écrire la cible) ; P=1 si cp a échoué après avoir créé un fichier (partiel, non supprimé).
const DELIVER_SH = `dl() { P=0; if [ -e "$2" ] || [ -L "$2" ]; then return 1; fi
  if ( set -C; cat "$1" > "$2" ) 2>/dev/null && [ -s "$2" ] && [ "$(stat -f%z "$1")" = "$(stat -f%z "$2")" ]; then return 0; fi
  [ -e "$2" ] && P=1; return 1; }`
// Livraison synchrone d'une vidéo seule : 'ok' | 'partial' (copie ratée, fichier partiel laissé dans la sortie) | '' (refusée ou ratée)
function deliverNow(src, dst) {
  const r = sh(`${DELIVER_SH}; if dl ${q(src)} ${q(dst)}; then rm -f ${q(src)}; echo ok; elif [ $P = 1 ]; then echo partial; fi`)
  return r || ''
}

// Fusion en arrière-plan (suivie par onTick), ENTIÈREMENT dans le cache : voix + son du téléphone (amix) ou voix seule si la vidéo
// n'a pas de son. Seul le fichier final est copié dans le dossier de sortie (final). Résultats : ok | novoice (vidéo seule livrée,
// m4a et journal gardés dans le cache) | fail (rien n'a pu être livré, tout reste dans le cache).
// Premier essai : amix ; second essai (filtre plus simple) : voix seule réencodée, sans amix ni recalage. Le stderr de ffmpeg est
// gardé dans fusion_<date>.log, supprimé en cas de succès.
function startMerge(video, final, m4a, offset, ts) {
  const probe = (f, args) => sh(`ffprobe -v error ${args} -of csv=p=0 ${q(f)}`) || ''
  const hasPhone = probe(video, '-select_streams a -show_entries stream=index') !== ''
  const align = offset >= 0 ? `adelay=${Math.round(offset * 1000)}:all=1` : `atrim=start=${(-offset).toFixed(3)},asetpts=PTS-STARTPTS`
  const micF = `[1:a]aresample=48000,aformat=channel_layouts=stereo,${align}[m]`
  const filter = hasPhone
    ? `${micF};[0:a]aresample=48000,aformat=channel_layouts=stereo[p];[p][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97[a]`
    : `${micF};[m]anull[a]`
  const filterSimple = '[1:a]aresample=48000,aformat=channel_layouts=stereo[a]'
  const tmp = `${MIC_DIR}/fusion_${ts}.mp4`
  const log = `${MIC_DIR}/fusion_${ts}.log`
  const res = m4a.replace(/\.m4a$/, '.res')
  sh(`rm -f ${q(res)}`)
  const ff = tmo(120, `ffmpeg -nostdin -loglevel error -y -i "$V" -i "$M" -filter_complex "$1" -map 0:v:0 -map '[a]' -c:v copy -c:a aac -b:a 160k -movflags +faststart "$T"`)
  sh(`( V=${q(video)}; F=${q(final)}; M=${q(m4a)}; T=${q(tmp)}; L=${q(log)}; R=${q(res)}; F1=${q(filter)}; F2=${q(filterSimple)}
      ${DELIVER_SH}
      ck() { [ -s "$T" ] && ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "$T" | grep -q audio \\
        && ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "$T" | grep -q video \\
        && ffprobe -v error -show_entries format=duration -of csv=p=0 "$T" | awk 'NF && $1+0>0 {ok=1} END{exit !ok}'; }
      mg() { rm -f "$T"; ${ff} 2>>"$L" && ck; }
      : >"$L"
      pf() { if [ $P = 1 ]; then echo " partial"; fi; }
      if mg "$F1" || mg "$F2"; then
        if dl "$T" "$F"; then rm -f "$T" "$V" "$M" "$L"; echo ok >"$R"
        else echo "deliverfail$(pf)" >"$R"; fi
      else
        rm -f "$T"; if dl "$V" "$F"; then rm -f "$V"; echo novoice >"$R"; else echo "fail$(pf)" >"$R"; fi
      fi ) >/dev/null 2>&1 &`)
  st.merges.push({ res, t0: now(), video, m4a, log, tmp, final })
  return hasPhone
}

// Appelée par onTick : fusions terminées → message final
function mergePoll() {
  for (let i = st.merges.length - 1; i >= 0; i--) {
    const m = st.merges[i]
    let r = (sh(`cat ${q(m.res)} 2>/dev/null`) || '').trim()
    if (!r && now() - m.t0 > 600) r = 'timeout'
    if (!r) continue
    st.merges.splice(i, 1)
    sh(`rm -f ${q(m.res)}`)
    ding()
    const part = / partial/.test(r) ? `\nAttention : un fichier partiel a pu être créé dans le dossier de sortie (${m.final}), il n'est pas supprimé par l'app.` : ''
    const k = r.split(' ')[0]
    if (k === 'ok') setStatus('✅ Vidéo Android enregistrée avec le son du micro')
    else if (k === 'novoice') setStatus(`⚠️ Vidéo enregistrée sans la voix (fusion impossible)\nVoix gardée 7 jours : ${m.m4a}\nJournal : ${m.log}`)
    else if (k === 'deliverfail') setStatus(`❌ Livraison impossible dans le dossier de sortie (fichier existant, lecture seule, disque plein…)\nVidéo fusionnée gardée 24 h dans ${m.tmp}\nVidéo sans voix (24 h) : ${m.video}\nVoix gardée 7 jours : ${m.m4a}${part}`)
    else setStatus(`❌ Livraison de la vidéo impossible : fichiers gardés dans ${MIC_DIR} (vidéos 24 h, voix 7 jours)\nJournal : ${m.log}${part}`)
  }
}
// Attend la fin des fusions (quitter l'app, mode vérification)
function mergePump(maxSec) {
  const t = now()
  while (st.merges.length && now() - t < maxSec) { mergePoll(); delay(0.2) }
}

function stopAndroidVideo(disconnected) {
  if (!st.recPid) return ''
  const mic = { file: st.micFile, name: st.micName, lost: st.micLost, active: !!st.micPid, times: st.recTimes, micLog: st.micLog }
  killRec()
  st.recPid = null; st.micPid = null
  const video = st.recFile, final = st.finalFile
  const cached = video !== final // micro actif : scrcpy a écrit dans le cache, la livraison dans le dossier de sortie se fait ici
  const gotVideo = fileOk(video)
  let msg = disconnected ? (gotVideo ? '✅ Vidéo Android enregistrée (appareil déconnecté)' : '❌ Vidéo Android interrompue') : (gotVideo ? '✅ Vidéo Android enregistrée' : '❌ Échec de la vidéo Android')
  let merging = false
  if (gotVideo && cached && mic.file && fileOk(mic.file)) {
    // Un m4a non vide mais corrompu part quand même en fusion : elle échouera, la vidéo seule sera livrée et le m4a gardé dans le cache
    const t = {}
    ;(sh(`cat ${q(mic.times)} 2>/dev/null`) || '').split('\n').forEach((l) => { const [k, v] = l.split(' '); if (k && Number(v) > 0) t[k] = Number(v) })
    // décalage (s) : instant de départ du micro moins instant de départ de l'enregistrement scrcpy ; heures de lancement en repli
    let off = (t.mic || st.micStart) - (t.rec || st.recStart)
    if (!isFinite(off) || Math.abs(off) > 20) off = 0
    startMerge(video, final, mic.file, off, st.ts)
    merging = true
    msg = '⏳ Ajout du son…'
  } else {
    // Pas de fusion : le m4a inutilisable est supprimé du cache, la vidéo du cache (si elle existe) est livrée telle quelle
    if (mic.file) sh(`rm -f ${q(mic.file)}`)
    if (gotVideo && mic.file) msg += '\n' + MIC_UNAVAILABLE
    if (cached) {
      const d = gotVideo ? deliverNow(video, final) : 'ok'
      if (d !== 'ok') msg = `❌ Livraison impossible dans le dossier de sortie (fichier existant, lecture seule, disque plein…) : vidéo gardée 24 h dans ${video}` + (d === 'partial' ? `\nAttention : un fichier partiel a pu être créé dans la sortie (${final}), il n'est pas supprimé par l'app.` : '')
      else if (!gotVideo) sh(`rm -f ${q(video)}`)
    }
  }
  // temps_*.txt (et son .tmp) supprimés après l'arrêt du watcher par killRec
  ;[mic.micLog, mic.times, mic.times && mic.times + '.tmp'].forEach((f) => { if (f) sh(`rm -f ${q(f)}`) })
  st.micFile = null
  if (gotVideo && !merging) ding()
  return msg
}

// ---------- Test automatique : consigne en langage naturel rejouée sur l'Android par Claude Code ----------
const SRC = RES || HOME + '/Developer/miroir-telephone/src'
// MIROIR_RUNNER : remplace le runner (tests de l'enchaînement avec un runner factice, sans Claude ni téléphone)
// Ignoré dans le bundle (RES défini) : le lanceur neutralise aussi ces variables de test
const ENV_RUNNER = RES ? null : ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('MIROIR_RUNNER')) || null
const RUNNER = ENV_RUNNER || SRC + '/test-runner.sh'
const SQUASH = SRC + '/squash.sh'
// Purge du cache des tests : dossiers de plus de 30 jours, uniquement directement sous TEST_ROOT (garde-fou sur le chemin)
function purgeOldTests() {
  if (TEST_ROOT !== HOME + '/Library/Caches/MiroirTelephone/tests' || !/^\/Users\/[^/]+\/Library\/Caches\/MiroirTelephone\/tests$/.test(TEST_ROOT)) return
  sh(`[ -d ${q(TEST_ROOT)} ] && find ${q(TEST_ROOT)} -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +`)
}
// Purge du cache micro, uniquement des fichiers ordinaires directement sous MIC_DIR (garde-fou sur le chemin fixe).
// Règle : tout ce qui est temporaire (vidéos video_*.mp4 et fusion_*.mp4, journaux *.log dont fusion_*.log, *.res, temps_*.txt)
// est supprimé au bout de 24 h ; les m4a micro_*.m4a (dont le m4a de repli d'une fusion échouée) au bout de 7 jours.
function purgeOldMic() {
  if (MIC_DIR !== HOME + '/Library/Caches/MiroirTelephone/micro' || !/^\/Users\/[^/]+\/Library\/Caches\/MiroirTelephone\/micro$/.test(MIC_DIR)) return
  const D = q(MIC_DIR)
  sh(`[ -d ${D} ] && [ ! -L ${D} ] && find ${D} -mindepth 1 -maxdepth 1 -type f \\( -name 'video_*.mp4' -o -name 'fusion_*.mp4' -o -name '*.log' -o -name '*.res' -o -name 'temps_*.txt' -o -name 'temps_*.txt.tmp' \\) -mmin +1440 -delete
    [ -d ${D} ] && [ ! -L ${D} ] && find ${D} -mindepth 1 -maxdepth 1 -type f -name 'micro_*.m4a' -mmin +10080 -delete; true`)
}
// Purge du cache Squash : fichiers ordinaires (r*.json/.err/.rc laissés par un arrêt brutal) de plus de 24 h, directement sous SQ_DIR
// (chemin fixe vérifié, dossier non lié, find ne suit pas les liens)
function purgeOldSq() {
  if (SQ_DIR !== HOME + '/Library/Caches/MiroirTelephone/squash' || !/^\/Users\/[^/]+\/Library\/Caches\/MiroirTelephone\/squash$/.test(SQ_DIR)) return
  sh(`[ -d ${q(SQ_DIR)} ] && [ ! -L ${q(SQ_DIR)} ] && find ${q(SQ_DIR)} -mindepth 1 -maxdepth 1 -type f -mmin +1440 -delete; true`)
}
const RAPPORT = SRC + '/rapport.js'
const TEST_ROOT = HOME + '/Library/Caches/MiroirTelephone/tests'

// Modes : liste blanche codée en dur (le runner la revalide). Rapide = Sonnet, Précis = Opus.
const TEST_MODES = [
  { key: 'rapide', label: 'Rapide', model: 'claude-sonnet-5-5' },
  { key: 'precis', label: 'Précis', model: 'claude-opus-5-5' },
]
const modeIndex = () => Math.max(0, TEST_MODES.findIndex((m) => m.key === pref('testMode', 'rapide')))

// ---------- PIN du téléphone (trousseau macOS : service « miroir-telephone-pin », compte = numéro de série) ----------
// Écriture via « security -i » : la commande (donc le PIN) est lue sur l'entrée standard d'un NSTask, jamais dans un argv
// visible par ps. Le trousseau garde ainsi le binaire « security » comme application de confiance, ce qui permet au
// runner de relire le PIN (security find-generic-password -w) sans fenêtre d'autorisation. Le PIN n'est jamais journalisé.
const PIN_SERVICE = 'miroir-telephone-pin'
const validSerial = (s) => /^[A-Za-z0-9._:-]+$/.test(s || '')
const validPin = (p) => /^[A-Za-z0-9]{4,16}$/.test(p || '')
const pinExists = (serial) => validSerial(serial) && sh(`security find-generic-password -s ${PIN_SERVICE} -a ${q(serial)} >/dev/null 2>&1 && echo ok`) === 'ok'

function pinSave(serial, pin) {
  if (!validSerial(serial)) return false
  if (!validPin(pin)) return false
  const task = $.NSTask.alloc.init
  task.setLaunchPath('/usr/bin/security')
  task.setArguments($(['-i']))
  const inPipe = $.NSPipe.pipe
  task.setStandardInput(inPipe)
  task.setStandardOutput($.NSPipe.pipe)
  task.setStandardError($.NSPipe.pipe)
  task.launch
  // identifiants restreints à [A-Za-z0-9._:-] : aucun caractère à échapper
  const cmd = `add-generic-password -U -s ${PIN_SERVICE} -a "${serial}" -w "${pin}"\nquit\n`
  inPipe.fileHandleForWriting.writeData($(cmd).dataUsingEncoding($.NSUTF8StringEncoding))
  inPipe.fileHandleForWriting.closeFile
  task.waitUntilExit
  return pinExists(serial)
}
const pinClear = (serial) => !validSerial(serial) || sh(`security delete-generic-password -s ${PIN_SERVICE} -a ${q(serial)} >/dev/null 2>&1; echo ok`) === 'ok'

// Une consigne ne doit jamais contenir de code : il serait envoyé à l'IA, gardé en clair (préférences, rapport, cache)
const CODE_RE = /(pin|code|mot de passe|password|mdp)\D{0,20}(?=[A-Za-z0-9]{0,15}\d)[A-Za-z0-9]{4,16}/i
const CODE_MSG = '⚠️ La consigne semble contenir un code : retire-le et enregistre le PIN dans Paramètres ⚙︎'
const consigneHasCode = (t) => CODE_RE.test(t)

function startTest() {
  const text = ObjC.unwrap(TT.view.string).trim()
  if (consigneHasCode(text)) return CODE_MSG
  if (!text) return '✍️ Colle d’abord la consigne du test (étapes et résultats attendus).'
  if (!st.serial) return '❌ Aucun Android prêt pour le test.'
  if (!sh('command -v claude')) return '❌ Claude Code (commande « claude ») est introuvable sur ce Mac.'
  st.testStamp = stamp()
  prepareTestDir(`${TEST_ROOT}/${st.testStamp}`, text)
  launchRunner(st.testDir, st.testStamp)
  return st.testPid ? '▶️ Test en cours : l’agent rejoue la consigne sur le téléphone…' : '❌ Impossible de lancer le test'
}

// Dossier de travail (700) et consigne.txt (600) d'un test
function prepareTestDir(dir, text) {
  st.testDir = dir
  sh(`umask 077; mkdir -p ${q(TEST_ROOT)} && chmod 700 ${q(TEST_ROOT)} && mkdir -p ${q(dir)} && chmod 700 ${q(dir)}`)
  $(text).writeToFileAtomicallyEncodingError(dir + '/consigne.txt', true, $.NSUTF8StringEncoding, null)
  sh(`chmod 600 ${q(dir + '/consigne.txt')}`)
}

// Lance le runner en arrière-plan ; ts donne le nom du dossier de preuves : Test_<ts>
function launchRunner(dir, ts) {
  // Nouveau groupe de processus : « Stop » arrête aussi Claude et ses commandes adb
  st.testPid = sh(`perl -e 'setpgrp(0,0); exec @ARGV' /bin/zsh -f ${q(RUNNER)} ${q(st.serial || 'FAKE')} ${q(dir)} ${q(OUT)} ${q(ts)} ${TEST_MODES[modeIndex()].key} >${q(dir + '/runner.log')} 2>&1 & echo $!`)
  st.testStart = now()
}

function stopTest() {
  if (st.testPid) sh(`kill -TERM -- -${st.testPid} 2>/dev/null; kill -TERM ${st.testPid} 2>/dev/null`)
  st.testPid = null
  return '⏹ Test arrêté'
}

function finishTest() {
  st.testPid = null
  const res = (sh(`cat ${q(st.testDir + '/resultat.txt')} 2>/dev/null`) || '').split('\n')
  const VERDICTS = {
    SUCCES: ['✅', 'Test réussi'],
    ECHEC: ['❌', 'Test en échec'],
    BLOQUE: ['⚠️', 'Test bloqué'],
  }
  const [icon, title] = VERDICTS[res[0]] || VERDICTS.BLOQUE
  const reason = res[1] || 'le test s’est arrêté sans conclusion (voir le rapport)'
  ding()
  notify(title, reason)
  return `${icon} ${title} : ${reason}\nPreuves (rapport, vidéo, captures par étape) : dossier Test_${st.testStamp} dans « ${outLabel()} »`
}

// ---------- Squash TM (lot C) : LECTURE SEULE ----------
// Toutes les requêtes passent par squash.sh (GET uniquement, liste blanche de chemins, token lu du trousseau dans le script).
// Endpoints validés par GET réels :
//   projects?size=N&fields=name                         -> _embedded.projects[], page.totalElements
//   projects/<id>/test-cases-library/content            -> _embedded.test-case-library-content[] (racine du projet, sans « include=nested »)
//   test-case-folders/<id>/content                      -> _embedded.content[] (enfants directs ; _type = test-case-folder | test-case…)
//   test-cases/<id>?fields=name,reference,prerequisite,steps[action,expected_result,called_test_case[name,reference]]
// Pagination : page.totalPages, paramètres size/page. Le contenu des cas (HTML) est une DONNÉE non fiable.
const SQ_DIR = HOME + '/Library/Caches/MiroirTelephone/squash'
const SQ_SERVICE = 'miroir-telephone-squash'
// Aucune adresse par défaut : l'URL est une préférence locale (NSUserDefaults squashUrl), saisie dans Paramètres.
// Validation générique : https:// obligatoire, hôte = nom DNS (lettres, chiffres, tirets, points ; une IPv4 en clair passe aussi),
// ni userinfo (@), ni espace, ni ? ni #, port facultatif 1-65535, chemin (préfixe facultatif) terminé par /api/rest/latest.
const SQ_URL_RE = /^https:\/\/((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?::([0-9]{1,5}))?((?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*\/api\/rest\/latest)$/
// Compte du trousseau = hôte (en minuscules) [+ « :port » s'il est saisi] : le token n'est lié qu'à cette adresse. null si l'URL est invalide.
// « token » est refusé comme hôte : c'est le nom de l'ancien compte (v1.5.0), jamais réutilisé.
function squashAccount(u) {
  const m = SQ_URL_RE.exec(u || '')
  if (!m || m[1].length > 253 || m[1].toLowerCase() === 'token') return null
  if (m[2] !== undefined && !(Number(m[2]) >= 1 && Number(m[2]) <= 65535)) return null
  return m[1].toLowerCase() + (m[2] !== undefined ? ':' + Number(m[2]) : '')
}
const validSquashUrl = (u) => squashAccount(u) !== null
const squashUrlError = (u) => !String(u || '').trim() ? 'Saisis l’adresse de l’API Squash'
  : !/^https:\/\//.test(u || '') ? 'URL invalide : elle doit commencer par https://'
  : 'URL refusée : https://, nom d’hôte valide (sans @, espace, ? ni #), port 1-65535 facultatif et chemin terminé par /api/rest/latest'
const validSquashToken = (t) => /^[A-Za-z0-9._~+\/=-]{20,2000}$/.test(t || '')
// URL enregistrée et valide, sinon '' (non configuré : aucune requête n'est faite)
const squashUrl = () => { const u = String(pref('squashUrl', '')).trim().replace(/\/+$/, ''); return validSquashUrl(u) ? u : '' }
const kcHas = (acct) => sh(`security find-generic-password -s ${SQ_SERVICE} -a ${q(acct)} >/dev/null 2>&1 && echo ok`) === 'ok'
const squashTokenExists = (url) => { const a = squashAccount(url === undefined ? squashUrl() : url); return !!a && kcHas(a) }
// Ancien élément (compte « token », v1.5.0) : jamais utilisé, supprimé à l'enregistrement d'un token ou à « Effacer »
const squashLegacyExists = () => kcHas('token')
const squashLegacyDelete = () => sh(`security delete-generic-password -s ${SQ_SERVICE} -a token >/dev/null 2>&1; true`)
const SQ_CASE_FIELDS = 'name,reference,prerequisite,steps[action,expected_result,called_test_case[name,reference]]'

// Écriture dans le trousseau comme pour le PIN : « security -i », commande sur l'entrée standard, jamais dans un argv.
// Le token est validé avant (aucun caractère à échapper) ; il n'est jamais journalisé.
function squashTokenSave(url, token) {
  const acct = squashAccount(url)
  if (!acct || !validSquashToken(token)) return false
  const task = $.NSTask.alloc.init
  task.setLaunchPath('/usr/bin/security')
  task.setArguments($(['-i']))
  const inPipe = $.NSPipe.pipe
  task.setStandardInput(inPipe)
  task.setStandardOutput($.NSPipe.pipe)
  task.setStandardError($.NSPipe.pipe)
  task.launch
  const cmd = `add-generic-password -U -s ${SQ_SERVICE} -a "${acct}" -w "${token}"\nquit\n`
  inPipe.fileHandleForWriting.writeData($(cmd).dataUsingEncoding($.NSUTF8StringEncoding))
  inPipe.fileHandleForWriting.closeFile
  task.waitUntilExit
  const ok = kcHas(acct)
  if (ok) squashLegacyDelete()
  return ok
}
// Efface le token de chaque URL donnée (si valide) et l'ancien élément « token »
function squashTokenClear(urls) {
  const accts = [...new Set(urls.map(squashAccount).filter(Boolean))]
  accts.forEach((a) => sh(`security delete-generic-password -s ${SQ_SERVICE} -a ${q(a)} >/dev/null 2>&1; true`))
  squashLegacyDelete()
  return !accts.some(kcHas) && !squashLegacyExists()
}

// Message clair pour un résultat de squash.sh {rc, err}
function squashErrText(r) {
  const err = String(r.err || '').trim()
  if (r.rc === 3) return 'Aucun token Squash enregistré pour cette adresse (Paramètres ⚙︎)'
  if (r.rc === 4) return 'URL Squash absente ou invalide (Paramètres ⚙︎)'
  if (r.rc === 22) {
    const m = err.match(/HTTP (\d+)/), c = m ? m[1] : '?'
    if (c === '401') return 'Token invalide ou expiré (HTTP 401)'
    if (c === '403') return 'Accès refusé par Squash (HTTP 403)'
    if (c === '404') return 'Ressource introuvable (HTTP 404)'
    return `Squash a répondu une erreur (HTTP ${c})`
  }
  if (r.rc === 124 || r.rc === 142) return 'Squash ne répond pas (délai dépassé)'
  return `Squash injoignable (réseau, code ${r.rc})`
}

// Appels asynchrones : fichiers de sortie dans le cache (700), lus par sqPoll() (timer + onTick). Ne gèle jamais l'interface.
const sqPending = []
let sqSeq = 0
function squashBg(path, cb, url) {
  const u = url || squashUrl()
  if (!u) { safe(() => cb({ rc: 4, body: '', err: '' })); return } // non configuré : aucune requête
  if (!safeDir(SQ_DIR)) { safe(() => cb({ rc: 1, body: '', err: 'cache' })); return }
  const n = `${SQ_DIR}/r${Date.now()}_${sqSeq++}`
  sh(`(umask 077; MIROIR_SQUASH_URL=${q(u)} /bin/zsh -f ${q(SQUASH)} GET ${q(path)} >${q(n + '.json')} 2>${q(n + '.err')}; echo $? >${q(n + '.rc')}) >/dev/null 2>&1 &`)
  sqPending.push({ n, cb, t0: now() })
}
function sqPoll() {
  for (let i = sqPending.length - 1; i >= 0; i--) {
    const p = sqPending[i]
    let rc = (sh(`cat ${q(p.n + '.rc')} 2>/dev/null`) || '').trim()
    if (!rc && now() - p.t0 > 60) rc = '124'
    if (!rc) continue
    sqPending.splice(i, 1)
    const body = sh(`cat ${q(p.n + '.json')} 2>/dev/null`) || '', err = sh(`cat ${q(p.n + '.err')} 2>/dev/null`) || ''
    sh(`rm -f ${q(p.n + '.json')} ${q(p.n + '.err')} ${q(p.n + '.rc')}`)
    safe(() => p.cb({ rc: Number(rc), body, err }))
  }
}
// Attend la fin des appels en cours (mode vérification sans boucle d'événements)
function sqPump(maxSec) {
  const t = now()
  while (sqPending.length && now() - t < maxSec) { sqPoll(); delay(0.15) }
}

// ---------- HTML Squash -> texte ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', ugrave: 'ù', icirc: 'î', euro: '€', hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—' }
function htmlToText(h) {
  let t = String(h == null ? '' : h).replace(/\r\n?/g, '\n')
  t = t.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/\s*(p|div|h[1-6]|tr|ul|ol|table|blockquote|pre)\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ').replace(/<\/\s*(td|th)\s*>/gi, ' | ')
    .replace(/<[^>]*>/g, '')
  t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m
  })
  return t.replace(/[ \t ]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
// Le contenu Squash reste une donnée : on retire seulement les balises qui fermeraient le bloc <consigne> du prompt
// Texte Squash neutralisé : NFKC (ramène le pleine largeur ＜ à <), suppression des caractères invisibles, puis tous les < et >
// deviennent ‹ et › : aucune balise ne peut survivre, quelle que soit la variante. Le délimiteur du prompt est en plus aléatoire.
const defang = (t) => t.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/</g, '‹').replace(/>/g, '›')

// Consigne d'un cas Squash (réponse de test-cases/<id>) : nom, référence / ID, prérequis, étapes. Pas de CODE_RE ici
// (« code APE 1234 » est légitime dans un cas) ; aucun secret de l'app n'y entre.
function buildConsigne(tc, projectName) {
  const L = [`Cas de test Squash : ${htmlToText(tc.name)}`, `Référence : ${tc.reference ? htmlToText(tc.reference) : '(aucune)'} · ID Squash : ${tc.id}`]
  if (projectName) L.push(`Projet : ${projectName}`)
  const pre = htmlToText(tc.prerequisite)
  L.push('', 'Prérequis :', pre || '(aucun)')
  const steps = []
  ;(tc.steps || []).forEach((s, i) => {
    const n = i + 1
    let action = htmlToText(s.action)
    if (!action && s.called_test_case) action = `Exécuter le cas de test appelé « ${htmlToText(s.called_test_case.name)} »${s.called_test_case.reference ? ` (${htmlToText(s.called_test_case.reference)})` : ''}`
    const expected = htmlToText(s.expected_result)
    steps.push({ n, action: action || '(étape sans action)', expected: expected || '(aucun résultat attendu)' })
  })
  steps.forEach((s) => L.push('', `Étape ${s.n} : ${s.action}`, `Résultat attendu : ${s.expected}`))
  return { text: defang(L.join('\n')), steps }
}

// ---------- Arbre Squash (état) ----------
// sq.nodes : clé -> nœud. Clés : 'root', 'f<id>' (dossier), 'c<id>' (cas). Les NSString clés sont gardées dans KEYOBJ :
// NSOutlineView compare les items par identité, il faut renvoyer toujours le même objet.
const sq = { open: false, projects: [], projectId: null, projectName: '', nodes: {}, checked: {}, verdicts: {}, filter: '', gen: 0, info: '', loadedProjects: false }
const KEYOBJ = {}
const keyObj = (k) => KEYOBJ[k] || (KEYOBJ[k] = $(k))
const okId = (id) => Number.isSafeInteger(id) && id > 0 // un id Squash sert à construire des chemins : entier positif sûr seulement
const idPath = (id) => { if (!/^\d+$/.test(String(id))) throw new Error('id Squash invalide'); return String(id) }
const SQV = { PENDING: '⏳', NON_EXECUTE: '–', SUCCES: '✅', ECHEC: '❌', BLOQUE: '⚠️' }

function sqResetTree() {
  sq.gen++
  sq.nodes = { root: { key: 'root', kind: 'folder', id: null, name: sq.projectName, children: null, loading: false } }
  sq.checked = {}
  sq.verdicts = {}
}
function sqSetInfo(t) { sq.info = t; sqRefreshUI() }

function sqLoadProjects() {
  if (sq.loadedProjects || sq.loadingProjects) return
  if (!squashUrl()) { sqSetInfo("Configure l'adresse de Squash dans Paramètres ⚙︎"); return }
  if (!squashTokenExists()) { sqSetInfo(squashLegacyExists() ? 'Ressaisis le token Squash dans Paramètres ⚙︎ (il est lié à l’adresse saisie)' : 'Aucun token Squash pour cette adresse : ouvre Paramètres ⚙︎ pour l’enregistrer.'); return }
  sq.loadingProjects = true
  sqSetInfo('Chargement des projets…')
  squashBg('projects?size=200&fields=name', (r) => {
    sq.loadingProjects = false
    if (r.rc !== 0) { sqSetInfo('❌ ' + squashErrText(r)); return }
    const d = JSON.parse(r.body)
    sq.projects = ((d._embedded && d._embedded.projects) || []).filter((p) => okId(p.id)).map((p) => ({ id: p.id, name: p.name }))
    sq.projects.sort((a, b) => a.name.localeCompare(b.name))
    sq.loadedProjects = true
    sqFillProjectMenu()
    const saved = Number(pref('squashProject', 0))
    const p = sq.projects.find((x) => x.id === saved) || sq.projects[0]
    if (p) sqSelectProject(p.id)
    else sqSetInfo('Aucun projet visible avec ce token.')
  })
}

function sqSelectProject(id) {
  const p = sq.projects.find((x) => x.id === id)
  if (!p) return
  sq.projectId = p.id; sq.projectName = p.name
  setPref('squashProject', p.id)
  sqResetTree()
  sqFillProjectMenu()
  sqLoadChildren('root')
}

// Charge (paresseusement) les enfants directs d'un dossier ou de la racine du projet, toutes pages
function sqLoadChildren(key) {
  const node = sq.nodes[key]
  if (!node || node.children || node.loading) return
  node.loading = true
  const gen = sq.gen
  const base = key === 'root' ? `projects/${idPath(sq.projectId)}/test-cases-library/content` : `test-case-folders/${idPath(node.id)}/content`
  const items = []
  const page = (n) => squashBg(`${base}?size=200&page=${n}&fields=name,reference`, (r) => {
    if (gen !== sq.gen) return
    if (r.rc !== 0) { node.loading = false; sqSetInfo('❌ ' + squashErrText(r)); return }
    const d = JSON.parse(r.body), emb = d._embedded || {}
    items.push(...(emb['test-case-library-content'] || emb.content || []).filter((it) => okId(it.id)))
    if (d.page && n + 1 < d.page.totalPages && n < 50) return page(n + 1)
    const mk = (it) => {
      const isFolder = it._type === 'test-case-folder'
      const k = (isFolder ? 'f' : 'c') + it.id
      sq.nodes[k] = { key: k, kind: isFolder ? 'folder' : 'case', id: it.id, name: String(it.name || ''), reference: it.reference || '', parent: key, children: null, loading: false }
      return k
    }
    const keys = items.map(mk)
    node.children = keys.filter((k) => k[0] === 'f').concat(keys.filter((k) => k[0] === 'c'))
    node.loading = false
    const nCases = keys.filter((k) => k[0] === 'c').length
    sqSetInfo(key === 'root' ? `${sq.projectName} : ${node.children.length} éléments à la racine` : `${node.name} : ${keys.length - nCases} dossier(s), ${nCases} cas`)
    sqReloadOutline(key)
  })
  page(0)
}

// Filtre par nom sur les nœuds chargés : un nœud est montré s'il correspond ou si un descendant chargé correspond ;
// si le dossier correspond lui-même, tout son contenu est montré.
const nameMatch = (n) => n.name.toLowerCase().includes(sq.filter)
function hasMatch(k) {
  const n = sq.nodes[k]
  return nameMatch(n) || (!!n.children && n.children.some(hasMatch))
}
function visibleChildren(k) {
  const n = sq.nodes[k]
  if (!n || !n.children) return []
  return !sq.filter || (k !== 'root' && nameMatch(n)) ? n.children : n.children.filter(hasMatch)
}

function caseKeysUnder(k) {
  const n = sq.nodes[k]
  if (!n) return []
  if (n.kind === 'case') return [k]
  return (n.children || []).reduce((a, c) => a.concat(caseKeysUnder(c)), [])
}
function checkState(k) {
  const n = sq.nodes[k]
  if (n.kind === 'case') return sq.checked[k] ? 1 : 0
  const cs = caseKeysUnder(k), on = cs.filter((c) => sq.checked[c]).length
  return !cs.length || !on ? 0 : on === cs.length ? 1 : -1
}
// Coche / décoche : un cas, ou tous les cas déjà chargés d'un dossier
function sqToggle(k) {
  const n = sq.nodes[k]
  if (!n || camp) return
  const cs = caseKeysUnder(k)
  const want = n.kind === 'case' ? !sq.checked[k] : !(cs.length && cs.every((c) => sq.checked[c]))
  cs.forEach((c) => { if (want) sq.checked[c] = true; else delete sq.checked[c] })
  sqReloadOutline()
}
const checkedCount = () => Object.keys(sq.checked).length

// ---------- Rejeu des cas cochés (n°11) ----------
// camp : campagne en cours ou null. Un ÉCHEC n'interrompt pas la suite ; un BLOQUÉ (ou une lecture Squash impossible) l'arrête.
let camp = null
let lastReport = null
const FAKE = !!ENV_RUNNER

const localDate = (t) => { const d = new Date(t * 1000), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` }
function campLine() {
  const done = camp.cases.filter((c) => c.verdict).length
  const n = (v) => camp.cases.filter((c) => c.verdict === v).length
  const parts = [`${done}/${camp.cases.length}`]
  if (n('SUCCES')) parts.push(`${n('SUCCES')} ✅`)
  if (n('ECHEC')) parts.push(`${n('ECHEC')} ❌`)
  if (n('BLOQUE')) parts.push(`${n('BLOQUE')} ⚠️`)
  return parts.join(' · ')
}

function campStart() {
  if (camp) return campStop()
  if (st.testPid) return '⏳ Un test est déjà en cours.'
  const keys = Object.keys(sq.checked).filter((k) => sq.nodes[k])
  if (!keys.length) return '☑️ Coche au moins un cas de test dans le panneau Squash.'
  if (!FAKE && !st.serial) return '❌ Aucun Android prêt pour le test.'
  if (!FAKE && !sh('command -v claude')) return '❌ Claude Code (commande « claude ») est introuvable sur ce Mac.'
  const m = TEST_MODES[modeIndex()]
  camp = {
    stamp: stamp(), mode: m.key, model: m.model, project: sq.projectName, t0: now(), idx: -1, phase: 'fetch', stopped: false,
    cases: keys.map((k) => ({ id: sq.nodes[k].id, name: sq.nodes[k].name, reference: sq.nodes[k].reference, verdict: null, reason: '', dir: null, durationSec: 0 })),
  }
  camp.cases.forEach((c) => { sq.verdicts[c.id] = 'PENDING' })
  lastReport = null
  campNext()
  return `▶️ Campagne de ${camp.cases.length} cas : ${campLine()}`
}

function campNext() {
  camp.idx++
  if (camp.idx >= camp.cases.length) return campFinish('terminée')
  const c = camp.cases[camp.idx], me = camp
  if (!/^\d+$/.test(String(c.id))) return campCaseEnd(c, 'BLOQUE', 'identifiant de cas invalide')
  camp.phase = 'fetch'
  setStatus(`⏳ ${campLine()} · lecture du cas ${c.id} dans Squash…`)
  squashBg(`test-cases/${idPath(c.id)}?fields=${SQ_CASE_FIELDS}`, (r) => {
    if (camp !== me || me.stopped) return
    if (r.rc !== 0) return campCaseEnd(c, 'BLOQUE', 'Lecture du cas dans Squash impossible : ' + squashErrText(r))
    const tc = JSON.parse(r.body)
    const built = buildConsigne(tc, me.project)
    if (!built.steps.length) return campCaseEnd(c, 'BLOQUE', 'Le cas ne contient aucune étape')
    c.name = htmlToText(tc.name) || c.name
    c.reference = tc.reference || c.reference
    c.prerequisite = htmlToText(tc.prerequisite)
    c.steps = built.steps
    c.consigne = built.text
    c.date = localDate(now())
    c.start = now()
    c.ts = `${me.stamp}_TC${c.id}`
    prepareTestDir(`${TEST_ROOT}/${me.stamp}/TC${c.id}`, built.text)
    c.workdir = st.testDir
    st.testStamp = c.ts
    launchRunner(c.workdir, c.ts)
    if (!st.testPid) return campCaseEnd(c, 'BLOQUE', 'Impossible de lancer le runner')
    me.phase = 'run'
    setStatus(`▶️ ${campLine()} · cas ${c.id} « ${c.name} » en cours…`)
    sqRefreshUI()
  })
}

// Appelée par le timer : le runner du cas courant a-t-il fini ?
function campTick() {
  if (!camp || camp.phase !== 'run') return
  if (st.testPid && alive(st.testPid)) return
  st.testPid = null
  const c = camp.cases[camp.idx]
  const res = (sh(`cat ${q(c.workdir + '/resultat.txt')} 2>/dev/null`) || '').split('\n')
  const v = ['SUCCES', 'ECHEC', 'BLOQUE'].includes(res[0]) ? res[0] : 'BLOQUE'
  campCaseEnd(c, v, res[1] || 'le test s’est arrêté sans conclusion (voir le rapport)')
}

function campCaseEnd(c, verdict, reason) {
  if (!/^\d+$/.test(String(c.id))) { c.id = 0; verdict = 'BLOQUE'; reason = 'identifiant de cas invalide' } // jamais d'id douteux dans un chemin
  c.verdict = verdict
  c.reason = reason
  c.durationSec = c.start ? now() - c.start : 0
  sq.verdicts[c.id] = verdict
  camp.phase = 'between'
  const dirName = `Test_${camp.stamp}_TC${c.id}`
  const pdir = `${OUT}/${dirName}` // même dossier que celui du runner (Test_<ts>) ; on ne reprend pas le chemin lu dans resultat.txt
  // Un dossier de preuves par cas, même quand le runner n'a rien produit (lecture Squash impossible…) : cas.json + rapport.html
  sh(`umask 077; mkdir -p ${q(pdir)}`)
  c.dir = pdir.split('/').pop()
  const cj = { id: c.id, name: c.name, reference: c.reference || '', project: camp.project, projectId: sq.projectId, prerequisite: c.prerequisite || '',
    steps: c.steps || [], consigne: c.consigne || '', verdict: verdict, reason: reason, durationSec: Math.round(c.durationSec), mode: camp.mode, model: camp.model,
    date: c.date || '', campaign: camp.stamp }
  writeJson(pdir + '/cas.json', cj)
  sh(`osascript -l JavaScript ${q(RAPPORT)} cas ${q(pdir)} >/dev/null 2>&1`)
  sqReloadOutline()
  if (verdict === 'BLOQUE') return campFinish('bloquée')
  campNext()
}

function writeJson(path, obj) {
  $(JSON.stringify(obj, null, 1)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)
  sh(`chmod 600 ${q(path)}`)
}

function campStop() {
  if (!camp) return ''
  camp.stopped = true
  if (st.testPid) sh(`kill -TERM -- -${st.testPid} 2>/dev/null; kill -TERM ${st.testPid} 2>/dev/null`)
  st.testPid = null
  return campFinish('arrêtée')
}

function campFinish(status) {
  const k = camp
  camp = null
  // Les cas non exécutés perdent leur ⏳
  k.cases.forEach((c) => { if (!c.verdict) { sq.verdicts[c.id] = 'NON_EXECUTE'; c.verdict = 'NON_EXECUTE'; c.reason = status === 'bloquée' ? 'campagne arrêtée par un test bloqué' : 'campagne arrêtée' } })
  const cj = { stamp: k.stamp, project: k.project, mode: k.mode, model: k.model, date: localDate(k.t0),
    durationSec: Math.round(now() - k.t0), status: status, cases: k.cases.map((c) => ({ id: c.id, name: c.name, reference: c.reference || '', verdict: c.verdict, reason: c.reason, dir: c.dir, durationSec: Math.round(c.durationSec) })) }
  const cfile = `${TEST_ROOT}/${k.stamp}/campagne.json`
  sh(`umask 077; mkdir -p ${q(TEST_ROOT + '/' + k.stamp)}`)
  writeJson(cfile, cj)
  sh(`osascript -l JavaScript ${q(RAPPORT)} campagne ${q(OUT)} ${q(cfile)} >/dev/null 2>&1`)
  lastReport = `${OUT}/Campagne_${k.stamp}.html`
  if (!fileOk(lastReport)) lastReport = null
  const n = (v) => k.cases.filter((c) => c.verdict === v).length
  const summary = `${k.cases.filter((c) => c.verdict !== 'NON_EXECUTE').length}/${k.cases.length} · ${n('SUCCES')} ✅ ${n('ECHEC')} ❌ ${n('BLOQUE')} ⚠️`
  const msg = `Campagne ${status} : ${summary}`
  ding()
  notify('Campagne ' + status, summary)
  sqReloadOutline()
  const full = `${status === 'terminée' ? '🏁' : '⏹'} ${msg}\n${lastReport ? 'Rapport : bouton « Rapport de campagne » (Squash)' : 'Rapport de campagne non généré'}`
  setStatus(full)
  return full
}

// ---------- iPhone ----------
function detectIOS() {
  st.ios = /iPhone|iPad/.test(sh('ioreg -p IOUSB -w0') || '')
}

function iosDocAlive() {
  try { return !!st.iosDoc && st.iosDoc.exists() } catch (e) { return false }
}

// Ouvre un enregistrement QuickTime. La source se choisit à la main dans QuickTime : depuis macOS 27,
// les noms des caméras ne sont plus exposés aux scripts, la sélection automatique est impossible.
function openIOS() {
  if (!st.ios || iosDocAlive()) return
  try {
    qt.activate()
    st.iosDoc = qt.newMovieRecording()
    delay(1)
    st.iosName = st.iosDoc.name()
  } catch (e) {
    st.iosDoc = null
  }
}

function showIOS() {
  if (iosDocAlive()) qt.activate()
  else { st.iosRec = false; openIOS() }
}

function iosCapture() {
  const f = `${OUT}/iPhone_${stamp()}.png`
  let winId = null
  try { winId = qt.windows.whose({ name: st.iosName })[0].id() } catch (e) {}
  if (winId) sh(`screencapture -o -x -l ${winId} ${q(f)}`)
  if (fileOk(f)) { ding(); return '✅ Capture iPhone enregistrée' }
  sh(`rm -f ${q(f)}`)
  return '❌ Échec de la capture iPhone : autorise « Miroir Téléphone » dans Réglages → Confidentialité → Enregistrement de l’écran'
}

function iosVideoToggle() {
  if (st.iosRec) return stopIOSVideo()
  try {
    st.iosDoc.start()
    st.iosRec = true
    st.iosStart = now()
    return '🔴 Vidéo iPhone en cours…'
  } catch (e) {
    return '❌ Impossible de démarrer la vidéo iPhone'
  }
}

// À l'arrêt, QuickTime ouvre l'enregistrement dans un nouveau document. QuickTime est sandboxé : il ne peut
// écrire que dans ~/Movies quand c'est un script qui donne le chemin. On y enregistre puis on déplace.
function stopIOSVideo() {
  if (!st.iosRec) return ''
  st.iosRec = false
  const name = `iPhone_${stamp()}.mov`
  const tmpDir = HOME + '/Movies/MiroirTelephone'
  const f = `${OUT}/${name}`
  const tmp = `${tmpDir}/${name}`
  sh(`mkdir -p ${q(tmpDir)}`)
  try {
    st.iosDoc.stop()
    // Attendre la fin de la « Finalisation de l'enregistrement » : le film apparaît avec une durée connue
    let movie = null
    for (let i = 0; i < 120 && !movie; i++) {
      delay(0.5)
      movie = qt.documents().find((d) => d.name() !== st.iosName && d.duration() > 0) || null
    }
    if (movie) {
      movie.save({ in: Path(tmp) })
      // Selon le cas QuickTime écrit un .mov simple ou un paquet .qtpxcomposition contenant le .mov
      for (let i = 0; i < 120; i++) {
        delay(0.5)
        // On ne déplace qu'une fois la taille stable (écriture terminée)
        const done = sh(`if [ -f ${q(tmp)} ]; then src=${q(tmp)}
          else src=$(find ${q(tmp + '.qtpxcomposition')} -name '*.mov' 2>/dev/null | head -1); fi
          [ -n "$src" ] || exit 0
          s1=$(stat -f%z "$src"); sleep 1; s2=$(stat -f%z "$src")
          [ "$s1" -gt 0 ] && [ "$s1" = "$s2" ] && mv "$src" ${q(f)} && rm -rf ${q(tmp + '.qtpxcomposition')} && echo ok`)
        if (done === 'ok') break
      }
      movie.close({ saving: 'no' })
    }
  } catch (e) {}
  openIOS() // l'enregistreur peut avoir été remplacé par le film : on le rouvre si besoin
  if (fileOk(f)) { ding(); return '✅ Vidéo iPhone enregistrée' }
  return '⚠️ Vidéo iPhone : enregistre-la à la main dans QuickTime (⌘S)'
}

// ---------- Interface ----------
const W = 380, H = 630, CW = W - 32, CH = 116, CHA = 160, CT = 150
const COLORS = {
  green: $.NSColor.systemGreenColor, orange: $.NSColor.systemOrangeColor,
  red: $.NSColor.systemRedColor, gray: $.NSColor.tertiaryLabelColor, blue: $.NSColor.systemBlueColor,
}
const rect = (x, y, w, h) => $.NSMakeRect(x, y, w, h)

ObjC.registerSubclass({
  name: 'MiroirController',
  superclass: 'NSObject',
  protocols: ['NSWindowDelegate', 'NSApplicationDelegate'],
  methods: {
    // le tag arrive en objet Cocoa : conversion obligatoire
    'click:': { types: ['void', ['id']], implementation: (sender) => safe(() => onClick(Number(sender.tag))) },
    'tick:': { types: ['void', ['id']], implementation: () => safe(onTick) },
    'quitApp:': { types: ['void', ['id']], implementation: () => safe(quit) },
    'windowWillClose:': { types: ['void', ['id']], implementation: () => safe(quit) },
    // Quitter depuis le Dock, déconnexion, redémarrage : nettoyage (ffmpeg, scrcpy, fusions…) puis NSTerminateNow (1).
    // quit(true) n'appelle pas NSApp.terminate : pas de boucle. Si quit() est déjà en cours (c'est lui qui a appelé
    // terminate), quit(true) ne fait rien et l'app se termine.
    'applicationShouldTerminate:': { types: ['unsigned long', ['id']], implementation: () => { safe(() => quit(true)); return 1 } },
    'sqtick:': { types: ['void', ['id']], implementation: () => safe(() => { if (sqPending.length) sqPoll() }) },
    // Case à cocher de l'arbre Squash : on retrouve la ligne, donc le nœud, à partir du bouton
    'check:': { types: ['void', ['id']], implementation: (sender) => safe(() => sqToggle(ObjC.unwrap(outline.itemAtRow(outline.rowForView(sender))))) },
    // Source de données et délégué de l'arbre (NSOutlineView)
    'outlineView:numberOfChildrenOfItem:': { types: ['long', ['id', 'id']], implementation: (ov, item) => { try { return visibleChildren(item.isNil() ? 'root' : ObjC.unwrap(item)).length } catch (e) { console.log('Erreur : ' + e); return 0 } } },
    'outlineView:child:ofItem:': { types: ['id', ['id', 'long', 'id']], implementation: (ov, i, item) => { try { return keyObj(visibleChildren(item.isNil() ? 'root' : ObjC.unwrap(item))[Number(i)]) } catch (e) { console.log('Erreur : ' + e); return keyObj('root') } } },
    'outlineView:isItemExpandable:': { types: ['bool', ['id', 'id']], implementation: (ov, item) => { try { return !item.isNil() && sq.nodes[ObjC.unwrap(item)].kind === 'folder' } catch (e) { return false } } },
    'outlineView:shouldExpandItem:': { types: ['bool', ['id', 'id']], implementation: (ov, item) => { try { sqLoadChildren(ObjC.unwrap(item)) } catch (e) { console.log('Erreur : ' + e) } return true } },
    'outlineView:viewForTableColumn:item:': { types: ['id', ['id', 'id', 'id']], implementation: (ov, col, item) => { try { return sqCellView(ObjC.unwrap(col.identifier), ObjC.unwrap(item)) } catch (e) { console.log('Erreur : ' + e); return $.NSView.alloc.init } } },
  },
})
const ctrl = $.MiroirController.alloc.init

function safe(fn) {
  try { fn() } catch (e) { console.log('Erreur : ' + e) }
}

function sym(name, size, weight) {
  let img = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription(name, $())
  if (img.isNil()) return null
  if (size) img = img.imageWithSymbolConfiguration($.NSImageSymbolConfiguration.configurationWithPointSizeWeight(size, weight || 0))
  return img
}

function mkLabel(parent, text, frame, opts) {
  opts = opts || {}
  const l = opts.wrap ? $.NSTextField.wrappingLabelWithString(text) : $.NSTextField.labelWithString(text)
  l.setFrame(frame)
  l.setFont($.NSFont.systemFontOfSizeWeight(opts.size || 13, opts.weight || 0))
  if (opts.color) l.setTextColor(opts.color)
  if (!opts.wrap) l.setLineBreakMode(4) // tronque en fin de ligne
  parent.addSubview(l)
  return l
}

function mkImage(parent, frame, img, tint) {
  const v = $.NSImageView.alloc.initWithFrame(frame)
  if (img) v.setImage(img)
  if (tint) v.setContentTintColor(tint)
  parent.addSubview(v)
  return v
}

function mkButton(parent, title, symbol, frame, tag, key, tip) {
  const b = $.NSButton.alloc.initWithFrame(frame)
  b.setBezelStyle(1)
  b.setTitle(title)
  const img = symbol && sym(symbol, 13, 0.23)
  if (img) { b.setImage(img); b.setImagePosition(title ? 7 /* à gauche du titre */ : 1 /* image seule */); b.setImageHugsTitle(true) }
  b.setTarget(ctrl); b.setAction('click:'); b.setTag(tag)
  if (key) { b.setKeyEquivalent(key); b.setKeyEquivalentModifierMask(1 << 20 /* ⌘ */) }
  if (tip) b.setToolTip(tip)
  parent.addSubview(b)
  return b
}

function mkIconButton(parent, symbol, frame, tag, tip) {
  const b = $.NSButton.alloc.initWithFrame(frame)
  b.setBordered(false)
  b.setImage(sym(symbol, 15, 0.23))
  b.setImagePosition(1 /* image seule */)
  b.setContentTintColor($.NSColor.secondaryLabelColor)
  b.setTarget(ctrl); b.setAction('click:'); b.setTag(tag)
  b.setToolTip(tip)
  parent.addSubview(b)
  return b
}

function mkCard(parent, y, h) {
  const box = $.NSBox.alloc.initWithFrame(rect(16, y, CW, h))
  box.setBoxType(4) // personnalisé
  box.setTitlePosition(0)
  box.setCornerRadius(14)
  box.setBorderWidth(1)
  box.setBorderColor($.NSColor.separatorColor)
  box.setFillColor($.NSColor.controlBackgroundColor.colorWithAlphaComponent(0.6))
  box.setContentViewMargins($.NSMakeSize(0, 0))
  parent.addSubview(box)
  return box.contentView
}

// Carte d'un appareil : icône, nom, pastille d'état, bouton « afficher », boutons capture / vidéo
function mkDevice(parent, y, h, title, icon, tint, tags, keys) {
  const c = mkCard(parent, y, h)
  mkImage(c, rect(14, h - 50, 36, 36), sym(icon[0], 26, 0.23) || sym(icon[1], 26, 0.23), tint)
  mkLabel(c, title, rect(58, h - 36, 220, 22), { size: 15, weight: 0.3 })
  const dot = mkImage(c, rect(58, h - 51, 10, 14), sym('circle.fill', 7), COLORS.gray)
  const status = mkLabel(c, '', rect(72, h - 53, CW - 72 - 14, 17), { size: 12, color: $.NSColor.secondaryLabelColor })
  const bw = (CW - 28 - 16) / 3, by = h - 104
  const show = mkButton(c, 'Miroir', 'macwindow', rect(14, by, bw, 34), tags[2], keys[2], `Afficher la vue miroir, contrôle clavier et souris (⌘${keys[2]})`)
  const cap = mkButton(c, 'Capture', 'camera', rect(22 + bw, by, bw, 34), tags[0], keys[0], `Capture d’écran (⌘${keys[0]})`)
  const vid = mkButton(c, 'Vidéo', 'record.circle', rect(30 + 2 * bw, by, bw, 34), tags[1], keys[1], `Démarrer / arrêter la vidéo (⌘${keys[1]})`)
  return { c, dot, status, show, cap, vid, key: keys[1] }
}

// Ligne d'options Android : qualité + sans fil, plein écran, envoi de fichiers, partage
function mkAndroidTools(c) {
  const pop = $.NSPopUpButton.alloc.initWithFramePullsDown(rect(14, 12, 140, 32), false)
  pop.addItemsWithTitles($(QKEYS.map((k) => QUALITY[k].label)))
  pop.selectItemAtIndex(QKEYS.indexOf(quality))
  pop.setTarget(ctrl); pop.setAction('click:'); pop.setTag(12)
  pop.setToolTip('Qualité du miroir et des vidéos (définition, débit, images/s)')
  c.addSubview(pop)
  const x0 = 162, bw = (CW - 14 - x0 - 3 * 6) / 4
  const mk = (i, symbol, alt, tag, tip) => mkButton(c, '', sym(symbol) ? symbol : alt, rect(x0 + i * (bw + 6), 12, bw, 32), tag, null, tip)
  return {
    pop,
    wifi: mk(0, 'wifi', 'antenna.radiowaves.left.and.right', 13, 'Sans fil : passer en Wi-Fi (puis débrancher le câble). Re-cliquer pour revenir à l’USB.'),
    full: mk(1, 'arrow.up.left.and.arrow.down.right', 'rectangle.expand.vertical', 14, 'Miroir en plein écran (⌘F dans le miroir pour en sortir)'),
    send: mk(2, 'square.and.arrow.up', 'arrow.up.doc', 15, 'Envoyer des fichiers : APK installés, autres fichiers dans Téléchargements. Le glisser-déposer sur le miroir marche aussi.'),
    share: mk(3, 'person.2.wave.2', 'link', 16, 'Partager sur le réseau local : copie la commande pour un collègue (mode sans fil requis)'),
  }
}

// Carte « Test automatique » : zone de consigne + bouton Lecture / Stop
let lastTestBlocked = false
function mkTestCard(parent, y) {
  const c = mkCard(parent, y, CT)
  mkImage(c, rect(14, CT - 34, 22, 22), sym('checklist', 16, 0.23) || sym('play.circle', 16, 0.23), COLORS.green)
  mkLabel(c, 'Test auto', rect(42, CT - 32, 76, 20), { size: 13, weight: 0.3 })
  const mode = $.NSPopUpButton.alloc.initWithFramePullsDown(rect(118, CT - 40, 104, 30), false)
  mode.addItemsWithTitles($(TEST_MODES.map((m) => m.label)))
  mode.selectItemAtIndex(modeIndex())
  mode.setTarget(ctrl); mode.setAction('click:'); mode.setTag(18)
  mode.setToolTip('Rapide : modèle Sonnet (économique). Précis : modèle Opus (plus fiable sur les parcours délicats, plus lent et plus coûteux).')
  c.addSubview(mode)
  const play = mkButton(c, 'Lancer', 'play.fill', rect(CW - 14 - 104, CT - 40, 104, 30), 17, null,
    'Rejouer la consigne sur l’Android : un agent Claude exécute les étapes et vérifie les résultats attendus')
  const sv = $.NSTextView.scrollableTextView
  sv.setFrame(rect(14, 12, CW - 28, CT - 58))
  sv.setBorderType(3) // bordure biseautée discrète
  const view = sv.documentView
  view.setRichText(false)
  view.setFont($.NSFont.systemFontOfSize(12))
  view.setAutomaticQuoteSubstitutionEnabled(false)
  view.setAutomaticDashSubstitutionEnabled(false)
  // Une consigne mémorisée qui ressemble à un code n'est pas rechargée (la préférence n'est pas supprimée)
  const last = pref('lastTest', '')
  lastTestBlocked = consigneHasCode(last)
  view.setString($(lastTestBlocked ? '' : last))
  const tip = 'Colle ici la consigne : étapes (« Ouvre Paramètres », « Touche Wi-Fi »…) et résultats attendus.\nNe mets jamais de code ni de mot de passe ici.'
  sv.setToolTip(tip); view.setToolTip(tip)
  c.addSubview(sv)
  return { c, play, mode, view }
}

const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
  rect(0, 0, W, H), 1 | 2 | 4 | (1 << 15) /* titrée, fermable, réductible, contenu plein cadre */, $.NSBackingStoreBuffered, false)
win.setTitle('Miroir Téléphone')
win.setTitleVisibility(1)
win.setTitlebarAppearsTransparent(true)
win.setMovableByWindowBackground(true)
win.setReleasedWhenClosed(false)
win.setDelegate(ctrl)

// Coque translucide > « root » (le panneau d'origine, W × H, déplacé à droite quand le panneau Squash est ouvert) + « side » (panneau Squash à gauche)
const SQW = 380
const shell = $.NSVisualEffectView.alloc.initWithFrame(rect(0, 0, W, H))
shell.setMaterial(21) // fond de fenêtre translucide
shell.setBlendingMode(0)
shell.setState(1)
win.setContentView(shell)
const root = $.NSView.alloc.initWithFrame(rect(0, 0, W, H))
shell.addSubview(root)
const side = $.NSView.alloc.initWithFrame(rect(0, 0, SQW, H))
side.setHidden(true)
shell.addSubview(side)

// En-tête
mkLabel(root, 'Miroir Téléphone', rect(20, H - 62, 240, 24), { size: 18, weight: 0.4 })
mkLabel(root, 'Afficher · piloter · capturer · filmer', rect(20, H - 80, 240, 16), { size: 12, color: $.NSColor.secondaryLabelColor })
const sqBtn = mkIconButton(root, sym('sidebar.left') ? 'sidebar.left' : 'list.bullet.indent', rect(W - 112, H - 70, 30, 28), 23, 'Panneau Squash : cas de test à rejouer')
const pinBtn = mkIconButton(root, 'pin', rect(W - 48, H - 70, 30, 28), 11, 'Garder au premier plan')
mkIconButton(root, 'gearshape', rect(W - 80, H - 70, 30, 28), 19, 'Paramètres (PIN du téléphone, Squash, son des vidéos)')

// Appareils
const A = mkDevice(root, H - 92 - CHA, CHA, 'Android', ['smartphone', 'candybarphone'], COLORS.green, [1, 2, 8], ['1', '2', '5'])
const AT = mkAndroidTools(A.c)
const I = mkDevice(root, H - 92 - CHA - CH - 12, CH, 'iPhone', ['iphone', 'iphone.gen3'], COLORS.blue, [3, 4, 9], ['3', '4', '6'])
const TT = mkTestCard(root, H - 92 - CHA - CH - CT - 24)

// Pied : message d'état puis dossier de sortie
const statusLbl = mkLabel(root, '', rect(20, 46, W - 40, 40), { size: 11.5, wrap: true, color: $.NSColor.secondaryLabelColor })
const folderBtn = mkButton(root, 'Dossier', 'folder', rect(14, 10, 230, 32), 10, null, 'Choisir le dossier où enregistrer captures et vidéos')
mkButton(root, 'Ouvrir', 'arrow.up.forward.square', rect(W - 14 - 120, 10, 120, 32), 7, 'o', 'Ouvrir le dossier (⌘O)')

// ---------- Panneau Squash (à gauche) ----------
// Choix technique : NSOutlineView « view-based » (vraie case à cocher NSButton dans chaque ligne, colonne verdict), données chargées
// paresseusement à l'ouverture d'un dossier. Source de données = le contrôleur ; items = NSString clés ('f12', 'c34'), gardées dans KEYOBJ.
mkLabel(side, 'Squash TM', rect(20, H - 62, 200, 24), { size: 18, weight: 0.4 })
mkLabel(side, 'Cas de test · lecture seule', rect(20, H - 80, 220, 16), { size: 12, color: $.NSColor.secondaryLabelColor })
const sqProjectPop = $.NSPopUpButton.alloc.initWithFramePullsDown(rect(16, H - 118, SQW - 32, 26), false)
sqProjectPop.setTarget(ctrl); sqProjectPop.setAction('click:'); sqProjectPop.setTag(27)
sqProjectPop.setToolTip('Projet Squash')
side.addSubview(sqProjectPop)
const sqSearch = $.NSSearchField.alloc.initWithFrame(rect(16, H - 148, SQW - 32, 24))
sqSearch.setPlaceholderString($('Filtrer par nom (nœuds chargés)'))
sqSearch.setTarget(ctrl); sqSearch.setAction('click:'); sqSearch.setTag(28)
sqSearch.setSendsSearchStringImmediately(true)
side.addSubview(sqSearch)
const sqInfoLbl = mkLabel(side, '', rect(16, H - 170, SQW - 32, 16), { size: 11, color: $.NSColor.secondaryLabelColor })

const sqScroll = $.NSScrollView.alloc.initWithFrame(rect(16, 100, SQW - 32, H - 176 - 100))
sqScroll.setHasVerticalScroller(true)
sqScroll.setBorderType(3)
sqScroll.setDrawsBackground(false)
const outline = $.NSOutlineView.alloc.initWithFrame(rect(0, 0, SQW - 32, 300))
const colName = $.NSTableColumn.alloc.initWithIdentifier($('name'))
colName.setWidth(250)
const colVerdict = $.NSTableColumn.alloc.initWithIdentifier($('verdict'))
colVerdict.setWidth(52)
outline.addTableColumn(colName)
outline.addTableColumn(colVerdict)
outline.setOutlineTableColumn(colName)
outline.setHeaderView($())
outline.setRowHeight(22)
outline.setIndentationPerLevel(14)
outline.setBackgroundColor($.NSColor.clearColor)
outline.setColumnAutoresizingStyle(0) // largeurs fixes : nom 250 + verdict 52 tiennent dans le cadre de 344
outline.setDataSource(ctrl)
outline.setDelegate(ctrl)
sqScroll.setDocumentView(outline)
side.addSubview(sqScroll)

const sqReplay = mkButton(side, 'Rejouer la sélection (0)', 'play.fill', rect(16, 56, 214, 32), 25, null,
  'Rejouer un à un les cas cochés sur l’Android. Un échec continue la suite, un test bloqué l’arrête.')
const sqUncheck = mkButton(side, 'Tout décocher', null, rect(238, 56, SQW - 16 - 238, 32), 26, null)
const sqReport = mkButton(side, 'Rapport de campagne', 'doc.text', rect(16, 14, 214, 32), 32, null, 'Ouvrir le dernier rapport de campagne (HTML)')
const sepLine = $.NSBox.alloc.initWithFrame(rect(SQW - 1, 0, 1, H))
sepLine.setBoxType(2)
side.addSubview(sepLine)

// Cellule d'une ligne : « name » = case à cocher + nom ; « verdict » = pastille. Vues gardées par nœud (références fortes).
const CELLS = {}
function sqCellView(col, key) {
  const n = sq.nodes[key]
  const ck = col + ':' + key
  let c = CELLS[ck]
  if (col === 'name') {
    if (!c) {
      const v = $.NSView.alloc.initWithFrame(rect(0, 0, 250, 22))
      const b = $.NSButton.alloc.initWithFrame(rect(0, 1, 250, 20))
      b.setButtonType(3) // case à cocher
      b.setAllowsMixedState(true)
      b.setTarget(ctrl); b.setAction('check:')
      b.setFont($.NSFont.systemFontOfSize(12))
      b.setAutoresizingMask(2) // largeur extensible
      b.cell.setLineBreakMode(4)
      v.addSubview(b)
      c = CELLS[ck] = { v, b }
    }
    c.b.setTitle($((n.kind === 'folder' ? '📁 ' : '') + n.name + (n.loading ? '  …' : '')))
    c.b.setState(checkState(key))
    c.b.setEnabled(!camp)
    return c.v
  }
  if (!c) {
    const l = $.NSTextField.labelWithString('')
    l.setFrame(rect(0, 1, 52, 20))
    l.setAlignment(2) // centré
    l.setFont($.NSFont.systemFontOfSize(14))
    c = CELLS[ck] = { v: l }
  }
  const vd = n.kind === 'case' ? sq.verdicts[n.id] : null
  c.v.setStringValue($(SQV[vd] || ''))
  c.v.setTextColor(vd === 'NON_EXECUTE' ? $.NSColor.tertiaryLabelColor : $.NSColor.labelColor) // « – » grisé : cas non exécuté
  return c.v
}

function expandLoaded() {
  Object.keys(sq.nodes).forEach((k) => { const n = sq.nodes[k]; if (n.kind === 'folder' && n.children && k !== 'root' && hasMatch(k)) outline.expandItem(keyObj(k)) })
}
// Recharge l'arbre (tout, ou un dossier après le chargement de ses enfants)
function sqReloadOutline(key) {
  if (key && key !== 'root' && sq.nodes[key]) outline.reloadItemReloadChildren(keyObj(key), true)
  else outline.reloadData
  if (sq.filter) expandLoaded()
  sqRefreshUI()
}

function sqFillProjectMenu() {
  sqProjectPop.removeAllItems
  sqProjectPop.addItemsWithTitles($(sq.projects.map((p) => p.name)))
  const i = sq.projects.findIndex((p) => p.id === sq.projectId)
  if (i >= 0) sqProjectPop.selectItemAtIndex(i)
}

function sqRefreshUI() {
  sqInfoLbl.setStringValue($(sq.info || ''))
  const n = checkedCount()
  sqReplay.setTitle(camp ? `Stop la campagne ${camp.idx + 1}/${camp.cases.length}` : `Rejouer la sélection (${n})`)
  sqReplay.setImage(sym(camp ? 'stop.fill' : 'play.fill', 13, 0.23))
  sqReplay.setBezelColor(camp ? COLORS.red : $())
  sqReplay.setEnabled(!!camp || (n > 0 && !st.testPid))
  sqUncheck.setEnabled(!camp && n > 0)
  sqReport.setEnabled(!!lastReport)
  sqProjectPop.setEnabled(!camp && sq.projects.length > 0)
  sqSearch.setEnabled(true)
  sqBtn.setContentTintColor(sq.open ? $.NSColor.controlAccentColor : $.NSColor.secondaryLabelColor)
}

// Ouvre / ferme le panneau : la fenêtre s'élargit vers la gauche (bord droit fixe), le panneau d'origine reste identique à droite
function applySquashLayout() {
  side.setHidden(!sq.open)
  root.setFrameOrigin($.NSMakePoint(sq.open ? SQW : 0, 0))
}
function setSquash(open) {
  sq.open = open
  setPref('squashOpen', open)
  const f = win.frame, w = open ? W + SQW : W, dx = w - f.size.width
  if (dx !== 0) {
    const vf = $.NSScreen.mainScreen.visibleFrame
    let x = f.origin.x - dx
    if (open) x = Math.max(x, vf.origin.x)
    win.setFrameDisplay(rect(x, f.origin.y, w, f.size.height), true)
  }
  applySquashLayout()
  if (open) sqLoadProjects()
  sqRefreshUI()
}

// ---------- Paramètres (fenêtre séparée, sans délégué : la fermer ne quitte pas l'app) ----------
// Structure : une section par bloc (mkSettingsSection) : PIN du téléphone, Squash (URL + token, lecture seule), puis Son des vidéos (micro du Mac).
const SW = 360, SH = 594
const settingsWin = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
  rect(0, 0, SW, SH), 1 | 2, $.NSBackingStoreBuffered, false)
settingsWin.setTitle('Paramètres')
settingsWin.setReleasedWhenClosed(false)
const settingsRoot = settingsWin.contentView

function mkSettingsSection(y, title) {
  mkLabel(settingsRoot, title, rect(20, y, SW - 40, 18), { size: 13, weight: 0.4 })
}

mkSettingsSection(SH - 38, 'PIN du téléphone')
const setPhone = mkLabel(settingsRoot, '', rect(20, SH - 60, SW - 40, 16), { size: 12, color: $.NSColor.secondaryLabelColor })
const pinField = $.NSSecureTextField.alloc.initWithFrame(rect(20, SH - 96, SW - 40, 24))
pinField.setPlaceholderString($('PIN (4 à 16 chiffres ou lettres)'))
settingsRoot.addSubview(pinField)
mkButton(settingsRoot, 'Enregistrer', null, rect(20, SH - 136, 110, 30), 20, null, 'Enregistrer le PIN dans le trousseau macOS')
mkButton(settingsRoot, 'Effacer', null, rect(138, SH - 136, 90, 30), 21, null, 'Supprimer le PIN de ce téléphone du trousseau')
const setState = mkLabel(settingsRoot, '', rect(20, SH - 164, SW - 40, 16), { size: 12 })
mkLabel(settingsRoot, 'Le PIN est gardé dans le trousseau macOS, jamais dans un fichier. Il sert à déverrouiller le téléphone avant un test.',
  rect(20, SH - 204, SW - 40, 34), { size: 11, wrap: true, color: $.NSColor.tertiaryLabelColor })

// Section Squash : URL de l'API, token (trousseau, service miroir-telephone-squash), test de connexion
mkSettingsSection(SH - 232, 'Squash TM (lecture seule)')
const sqUrlField = $.NSTextField.alloc.initWithFrame(rect(20, SH - 264, SW - 40, 24))
sqUrlField.setPlaceholderString($('Adresse de l’API Squash (https://…/api/rest/latest)'))
sqUrlField.setToolTip('Base de l’API REST de Squash TM (https:// obligatoire)')
settingsRoot.addSubview(sqUrlField)
const sqTokenField = $.NSSecureTextField.alloc.initWithFrame(rect(20, SH - 298, SW - 40, 24))
sqTokenField.setPlaceholderString($('Token API Squash (laisser vide pour le conserver)'))
settingsRoot.addSubview(sqTokenField)
mkButton(settingsRoot, 'Enregistrer', null, rect(20, SH - 338, 92, 30), 29, null, 'Enregistrer l’adresse et, si rempli, le token (lié à cet hôte) dans le trousseau macOS')
mkButton(settingsRoot, 'Effacer', null, rect(118, SH - 338, 80, 30), 30, null, 'Supprimer le token Squash du trousseau')
mkButton(settingsRoot, 'Tester la connexion', null, rect(204, SH - 338, SW - 20 - 204, 30), 31, null, 'Lit la liste des projets pour vérifier l’URL et le token (lecture seule)')
const sqState = mkLabel(settingsRoot, '', rect(20, SH - 376, SW - 40, 32), { size: 12, wrap: true })
mkLabel(settingsRoot, 'Le token Squash est gardé dans le trousseau macOS, jamais dans un fichier ni sur GitHub. L’app ne fait que lire Squash (GET) : elle n’y écrit rien.',
  rect(20, SH - 436, SW - 40, 46), { size: 11, wrap: true, color: $.NSColor.tertiaryLabelColor })

// Section Son des vidéos : micro du Mac ajouté aux vidéos Android (préférence micName, '' = désactivé)
mkSettingsSection(SH - 464, 'Son des vidéos')
const micPop = $.NSPopUpButton.alloc.initWithFramePullsDown(rect(20, SH - 498, SW - 40, 26), false)
micPop.setTarget(ctrl); micPop.setAction('click:'); micPop.setTag(33)
micPop.setToolTip('Micro du Mac enregistré avec les vidéos Android')
settingsRoot.addSubview(micPop)
mkLabel(settingsRoot, 'Ta voix est ajoutée aux vidéos Android, mixée avec le son du téléphone',
  rect(20, 56, SW - 40, 32), { size: 11, wrap: true, color: $.NSColor.tertiaryLabelColor })
mkButton(settingsRoot, 'Fermer', null, rect(SW - 20 - 90, 10, 90, 30), 22, null)

// Choix du menu : '' (Désactivé) puis les micros détectés ; un micro choisi mais absent reste listé « (absent) »
let micChoices = ['']
function micFillPopup() {
  const list = detectMics()
  const saved = pref('micName', null)
  const cur = micChoice(list)
  micChoices = ['', ...list]
  if (saved && !list.includes(saved)) micChoices.push(saved)
  micPop.removeAllItems
  micPop.addItemsWithTitles($(micChoices.map((n, i) => (i === 0 ? 'Désactivé' : list.includes(n) ? n : n + ' (absent)'))))
  micPop.selectItemAtIndex(Math.max(0, cur.off ? 0 : micChoices.indexOf(cur.name || saved || '')))
}

function setSettingsStatus(msg) {
  setState.setStringValue(msg.text)
  setState.setTextColor(COLORS[msg.color])
}

function setSquashStatus(msg) {
  sqState.setStringValue($(msg.text))
  sqState.setTextColor(COLORS[msg.color])
}

const sqFieldUrl = () => String(ObjC.unwrap(sqUrlField.stringValue)).trim().replace(/\/+$/, '')

// Après un changement d'adresse ou de token : l'arbre est vidé et les projets sont rechargés (si le panneau est ouvert)
function sqReconfigured() {
  sq.gen++
  sq.loadedProjects = false; sq.loadingProjects = false
  sq.projects = []; sq.projectId = null; sq.projectName = ''
  sqResetTree()
  sqFillProjectMenu()
  sq.info = ''
  safe(sqReloadOutline)
  if (sq.open) sqLoadProjects()
  sqRefreshUI()
}

// État du token pour l'adresse donnée (le token est lié à l'hôte : changer d'hôte oblige à le ressaisir)
function squashTokenState(url) {
  if (!url) return { text: 'Aucune adresse configurée', color: 'gray' }
  if (squashTokenExists(url)) return { text: 'Token enregistré pour cet hôte', color: 'green' }
  return squashLegacyExists()
    ? { text: 'Ressaisis le token : l’ancien token n’est pas réutilisé (il est lié à l’hôte saisi)', color: 'orange' }
    : { text: 'Aucun token pour cet hôte : saisis-le puis Enregistrer', color: 'gray' }
}

function squashSettingsSave() {
  const url = sqFieldUrl()
  if (!validSquashUrl(url)) return { text: squashUrlError(url), color: 'orange' }
  const changed = url !== squashUrl()
  setPref('squashUrl', url)
  const token = String(ObjC.unwrap(sqTokenField.stringValue)).trim()
  if (!token) {
    if (changed) sqReconfigured()
    const t = squashTokenState(url)
    return { text: 'Adresse enregistrée · ' + t.text, color: t.color }
  }
  if (!validSquashToken(token)) return { text: 'Token invalide : caractères A-Z a-z 0-9 . _ ~ + / = - seulement, 20 à 2000', color: 'orange' }
  const ok = squashTokenSave(url, token)
  sqTokenField.setStringValue($(''))
  sqReconfigured()
  return ok ? { text: 'Adresse et token enregistrés (trousseau, lié à cet hôte)', color: 'green' } : { text: 'Échec de l’enregistrement dans le trousseau', color: 'red' }
}

function squashSettingsClear() {
  sqTokenField.setStringValue($(''))
  const ok = squashTokenClear([squashUrl(), sqFieldUrl()])
  sqReconfigured()
  return ok ? { text: 'Token effacé', color: 'gray' } : { text: 'Échec de la suppression', color: 'red' }
}

// Lit « projects » (une ligne) avec l'URL du champ, en arrière-plan : « Test en cours… » est peint avant la réponse,
// puis « Connecté (N projets visibles) » ou une erreur claire
function squashSettingsTest() {
  const url = sqFieldUrl()
  if (!validSquashUrl(url)) return { text: squashUrlError(url), color: 'orange' }
  if (!squashTokenExists(url)) return { text: squashTokenState(url).text, color: 'orange' }
  setPref('squashUrl', url)
  squashBg('projects?size=1&fields=name', (r) => {
    if (r.rc !== 0) return setSquashStatus({ text: squashErrText(r), color: 'red' })
    try {
      const n = JSON.parse(r.body).page.totalElements
      setSquashStatus({ text: `Connecté (${n} projet${n > 1 ? 's' : ''} visible${n > 1 ? 's' : ''})`, color: 'green' })
    } catch (e) { setSquashStatus({ text: 'Réponse inattendue de Squash (pas du JSON)', color: 'red' }) }
  }, url)
  return { text: 'Test en cours…', color: 'gray' }
}

function settingsRefresh() {
  micFillPopup()
  sqUrlField.setStringValue($(squashUrl()))
  setSquashStatus(squashTokenState(squashUrl()))
  setPhone.setStringValue(st.serial ? `Téléphone : ${st.serial}` : 'Aucun téléphone Android connecté')
  setSettingsStatus(!st.serial ? { text: 'Branche un téléphone pour gérer son PIN', color: 'gray' }
    : pinExists(st.serial) ? { text: 'PIN enregistré', color: 'green' } : { text: 'Aucun PIN', color: 'gray' })
}

function settingsSave() {
  if (!st.serial) return { text: 'Aucun téléphone connecté', color: 'orange' }
  const pin = ObjC.unwrap(pinField.stringValue)
  if (!validPin(pin)) return { text: 'PIN invalide : 4 à 16 chiffres ou lettres', color: 'orange' }
  const ok = pinSave(st.serial, pin)
  pinField.setStringValue($(''))
  return ok ? { text: 'PIN enregistré', color: 'green' } : { text: 'Échec de l’enregistrement dans le trousseau', color: 'red' }
}

function settingsClear() {
  if (!st.serial) return { text: 'Aucun téléphone connecté', color: 'orange' }
  pinField.setStringValue($(''))
  return pinClear(st.serial) && !pinExists(st.serial) ? { text: 'Aucun PIN', color: 'gray' } : { text: 'Échec de la suppression', color: 'red' }
}

function openSettings() {
  settingsRefresh()
  settingsWin.setLevel(pinned ? 3 : 0)
  settingsWin.center
  settingsWin.makeKeyAndOrderFront(null)
}

function setStatus(msg) { if (msg) { statusLbl.setStringValue(msg); statusLbl.display } }

function paintDevice(d, color, text, enabled, recording, recStart, mic) {
  d.dot.setContentTintColor(COLORS[color])
  d.status.setStringValue(text)
  d.cap.setEnabled(enabled && !recording)
  d.vid.setEnabled(enabled)
  d.show.setEnabled(enabled)
  d.vid.setTitle(recording ? (mic ? '🎙 ' : '') + fmt(now() - recStart) : 'Vidéo')
  d.vid.setImage(sym(recording ? 'stop.fill' : 'record.circle', 13, 0.23))
  d.vid.setBezelColor(recording ? COLORS.red : $())
  d.vid.setKeyEquivalent(d.key)
}

function render() {
  if (!st.hasScrcpy || !st.hasAdb) paintDevice(A, 'orange', 'scrcpy absent — brew install scrcpy', false, false)
  else if (st.serial && st.recPid) paintDevice(A, 'red', 'Enregistrement en cours', true, true, st.recStart, !!st.micPid)
  else if (st.serial) paintDevice(A, 'green', isWifi(st.serial) ? `Sans fil · ${st.serial}` : `Connecté en USB · ${st.serial}`, true, false)
  else if (st.androidUnauth) paintDevice(A, 'orange', 'Accepte le débogage USB sur le téléphone', false, false)
  else paintDevice(A, 'gray', 'Non branché', false, false)
  const tools = !!st.serial && !st.recPid
  ;[AT.full, AT.send].forEach((b) => b.setEnabled(tools))
  AT.wifi.setEnabled(tools)
  AT.wifi.setContentTintColor(isWifi(st.serial) ? $.NSColor.controlAccentColor : $())
  AT.share.setEnabled(tools && isWifi(st.serial))
  AT.pop.setEnabled(!st.recPid)

  if (st.ios && st.iosRec) paintDevice(I, 'red', 'Enregistrement en cours', true, true, st.iosStart)
  else if (st.ios) paintDevice(I, 'green', 'Connecté · via QuickTime', true, false)
  else paintDevice(I, 'gray', 'Non branché', false, false)

  const testing = !!st.testPid || !!camp
  TT.play.setEnabled(testing || !!st.serial)
  TT.play.setTitle(testing ? `Stop ${fmt(now() - (camp ? camp.t0 : st.testStart))}` : 'Lancer')
  TT.play.setImage(sym(testing ? 'stop.fill' : 'play.fill', 13, 0.23))
  TT.play.setBezelColor(testing ? COLORS.red : $())
  TT.view.setEditable(!testing)
  TT.mode.setEnabled(!testing)

  folderBtn.setTitle(`Dossier : ${outLabel()}`)
  pinBtn.setImage(sym(pinned ? 'pin.fill' : 'pin', 15, 0.23))
  pinBtn.setContentTintColor(pinned ? $.NSColor.controlAccentColor : $.NSColor.secondaryLabelColor)
  win.setLevel(pinned ? 3 /* flottante */ : 0)
}

function hint() {
  if (!st.serial && !st.ios) setStatus('Branche un Android (débogage USB activé) ou un iPhone : il est détecté automatiquement.')
  else if (st.ios) setStatus('iPhone : dans QuickTime, flèche ˅ à côté du bouton rouge → choisis l’iPhone (caméra et micro).')
  else setStatus(`Prêt. Fichiers enregistrés dans « ${outLabel()} ».`)
}

// Détection automatique : un appareil qui vient d'être branché ouvre son miroir
let polls = 0
function poll(first) {
  const had = { serial: st.serial, ios: st.ios }
  // Mode sans fil mémorisé : on retente la connexion toutes les ~15 s tant que le téléphone n'est pas vu
  if (st.wifi && st.serial !== st.wifi && polls++ % 5 === 0) sh(tmo(3, `adb connect ${q(st.wifi)}`))
  detectAndroid(); detectIOS()
  const newAndroid = st.serial && st.serial !== had.serial
  const newIOS = st.ios && !had.ios
  if (newAndroid) openAndroid()
  if (newIOS) openIOS()
  if (first || newAndroid || newIOS || (had.serial && !st.serial) || (had.ios && !st.ios)) hint()
  render()
}

let ticks = 0
function onTick() {
  ticks++
  // Android débranché pendant une vidéo : scrcpy s'arrête de lui-même
  if (st.recPid && !alive(st.recPid)) setStatus(stopAndroidVideo(true))
  // ffmpeg s'arrête seul (autorisation refusée, micro absent) : la vidéo continue sans micro
  else if (st.recPid && st.micPid && !alive(st.micPid)) {
    st.micPid = null; st.micLost = true
    setStatus(MIC_UNAVAILABLE)
  }
  if (st.merges.length) mergePoll()
  if (!camp && st.testPid && !alive(st.testPid)) setStatus(finishTest())
  campTick()
  if (ticks % 3 === 0) { poll(false); watchMirror() }
  else if (st.recPid || st.iosRec || st.testPid || camp) render()
  if (camp && ticks % 5 === 0 && camp.phase === 'run') setStatus(`▶️ ${campLine()} · cas ${camp.cases[camp.idx].id} en cours (${fmt(now() - camp.cases[camp.idx].start)})`)
  if (sqPending.length) sqPoll()
}

function chooseFolder() {
  const p = $.NSOpenPanel.openPanel
  p.setCanChooseFiles(false); p.setCanChooseDirectories(true); p.setCanCreateDirectories(true)
  p.setPrompt('Choisir'); p.setMessage('Dossier où enregistrer les captures et vidéos')
  p.setDirectoryURL($.NSURL.fileURLWithPath(OUT))
  if (Number(p.runModal) === 1) {
    OUT = ObjC.unwrap(p.URL.path)
    setPref('outputDir', OUT)
    setStatus(`📁 Fichiers enregistrés dans « ${outLabel()} »`)
  }
}

let quitting = false
// viaTerminate : appelé par applicationShouldTerminate: (la terminaison est déjà en cours, ne pas rappeler terminate)
function quit(viaTerminate) {
  if (quitting) return
  quitting = true
  safe(stopAndroidVideo)
  safe(() => mergePump(60))
  safe(stopIOSVideo)
  safe(stopTest)
  safe(() => { if (camp) campStop() })
  killMirror()
  try { if (iosDocAlive()) st.iosDoc.close({ saving: 'no' }) } catch (e) {}
  if (viaTerminate === true) return
  try { $.NSApp.terminate(null) } catch (e) { console.log('Erreur : ' + e); ObjC.import('stdlib'); $.exit(0) }
}

function onClick(tag) {
  if (tag < 23) setStatus('…')
  switch (tag) {
    case 1: setStatus(androidCapture()); break
    case 2: setStatus(androidVideoToggle()); break
    case 3:
    case 4:
      // Fenêtre QuickTime fermée entre-temps : on la rouvre
      if (!iosDocAlive()) { st.iosRec = false; openIOS(); delay(1) }
      setStatus(tag === 3 ? iosCapture() : iosVideoToggle()); break
    case 7: sh(`open ${q(OUT)}`); hint(); break
    case 8: setStatus(showAndroid()); break
    case 9: showIOS(); setStatus('🍏 Miroir iPhone (QuickTime) au premier plan'); break
    case 10: chooseFolder(); break
    case 12: setStatus(setQuality(Number(AT.pop.indexOfSelectedItem))); break
    case 13: setStatus('📶 …'); setStatus(wirelessToggle()); break
    case 14: setStatus(fullscreenAndroid()); break
    case 15: setStatus(sendFiles()); break
    case 16: setStatus(shareAndroid()); break
    case 18: setPref('testMode', TEST_MODES[Math.max(0, Number(TT.mode.indexOfSelectedItem))].key); hint(); break
    case 19: openSettings(); break
    case 20: setSettingsStatus(settingsSave()); break
    case 21: setSettingsStatus(settingsClear()); break
    case 22: settingsWin.orderOut(null); break
    case 33: { const n = micChoices[Math.max(0, Number(micPop.indexOfSelectedItem))]; if (n !== undefined) setPref('micName', n) } break
    case 23: setSquash(!sq.open); break
    case 25: setStatus(campStart()); break
    case 26: if (!camp) { sq.checked = {}; sqReloadOutline() } break
    case 27: { const p = sq.projects[Math.max(0, Number(sqProjectPop.indexOfSelectedItem))]; if (p && !camp && p.id !== sq.projectId) sqSelectProject(p.id) } break
    case 28: sq.filter = String(ObjC.unwrap(sqSearch.stringValue)).trim().toLowerCase(); sqReloadOutline(); break
    case 29: setSquashStatus(squashSettingsSave()); break
    case 30: setSquashStatus(squashSettingsClear()); break
    case 31: setSquashStatus(squashSettingsTest()); break
    case 32: if (lastReport) sh(`open ${q(lastReport)}`); break
    case 11: pinned = !pinned; setPref('pinned', pinned); hint(); break
    case 17:
      if (camp) { setStatus(campStop()); break }
      if (st.testPid) { setStatus(stopTest()); break }
      // consigne avec un code : ni lancement ni sauvegarde
      if (consigneHasCode(ObjC.unwrap(TT.view.string))) { setStatus(CODE_MSG); break }
      setPref('lastTest', ObjC.unwrap(TT.view.string))
      setStatus(startTest()); break
  }
  render()
}

// ---------- Démarrage ----------
const app = $.NSApplication.sharedApplication
app.setActivationPolicy(0)
app.setDelegate(ctrl) // applicationShouldTerminate: (Quitter depuis le Dock, déconnexion)
if (RES) {
  const icon = $.NSImage.alloc.initWithContentsOfFile(RES + '/AppIcon.icns')
  if (!icon.isNil()) app.setApplicationIconImage(icon)
}

// Menu minimal pour ⌘Q
const mainMenu = $.NSMenu.alloc.init
const appItem = $.NSMenuItem.alloc.init
const appMenu = $.NSMenu.alloc.init
const quitItem = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent('Quitter Miroir Téléphone', 'quitApp:', 'q')
quitItem.setTarget(ctrl)
appMenu.addItem(quitItem)
appItem.setSubmenu(appMenu)
mainMenu.addItem(appItem)
// Menu Édition : sans lui, ⌘V / ⌘C / ⌘A ne fonctionnent pas dans les champs (coller un token ou une consigne)
const editItem = $.NSMenuItem.alloc.init
const editMenu = $.NSMenu.alloc.initWithTitle('Édition')
;[['Couper', 'cut:', 'x'], ['Copier', 'copy:', 'c'], ['Coller', 'paste:', 'v'], ['Tout sélectionner', 'selectAll:', 'a']].forEach(([t, a, k]) => {
  editMenu.addItem($.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(t, a, k))
})
editItem.setSubmenu(editMenu)
mainMenu.addItem(editItem)
app.setMainMenu(mainMenu)

render()
hint()
// Position mémorisée, sinon en haut à droite de l'écran principal
sq.open = !!pref('squashOpen', false)
const TW = sq.open ? W + SQW : W // largeur selon l'état du panneau Squash
const vf = $.NSScreen.mainScreen.visibleFrame
win.setFrameTopLeftPoint($.NSMakePoint(vf.origin.x + vf.size.width - TW - 20, vf.origin.y + vf.size.height - 10))
win.setFrameAutosaveName('MiroirTelephone')
// La position mémorisée peut venir d'une version plus petite de la fenêtre : on garde le coin haut-gauche, on remet la taille
const topLeft = $.NSMakePoint(win.frame.origin.x, win.frame.origin.y + win.frame.size.height)
win.setContentSize($.NSMakeSize(TW, H))
win.setFrameTopLeftPoint(topLeft)
applySquashLayout()
sqRefreshUI()
win.makeKeyAndOrderFront(null)
app.activateIgnoringOtherApps(true)
// Mode vérification : MIROIR_SNAPSHOT=fichier.png écrit le rendu de la fenêtre puis quitte
// Variantes : MIROIR_SNAPSHOT_SETTINGS=1 (fenêtre Paramètres ouverte) ; MIROIR_SNAPSHOT_SQUASH=1 (panneau ouvert, vrai projet chargé,
// MIROIR_SNAPSHOT_PROJECT=<id> et MIROIR_SNAPSHOT_FOLDER=<id de dossier à déplier>, MIROIR_SNAPSHOT_CHECK=<n> premiers cas du dossier cochés) ;
// MIROIR_SNAPSHOT_CAMPAIGN=1 (autonome : ouvre le panneau lui-même) : rejoue les cas cochés (avec MIROIR_RUNNER factice) jusqu'à la fin de la campagne avant la capture.
const penv = (k) => ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey(k))
const snap = penv('MIROIR_SNAPSHOT')
if (snap) {
  let target = win
  if (penv('MIROIR_SNAPSHOT_SETTINGS')) { settingsRefresh(); settingsWin.makeKeyAndOrderFront(null); target = settingsWin }
  if (penv('MIROIR_SNAPSHOT_SQUASH') || penv('MIROIR_SNAPSHOT_CAMPAIGN')) { // la campagne ouvre le panneau d'elle-même
    setSquash(true)
    sqPump(30)
    if (penv('MIROIR_SNAPSHOT_PROJECT')) { sqSelectProject(Number(penv('MIROIR_SNAPSHOT_PROJECT'))); sqPump(30) }
    const fid = penv('MIROIR_SNAPSHOT_FOLDER')
    if (fid && sq.nodes['f' + fid]) {
      outline.expandItem(keyObj('f' + fid)); sqPump(30)
      outline.reloadData
      outline.expandItem(keyObj('f' + fid))
      const cs = sq.nodes['f' + fid].children.filter((k) => k[0] === 'c').slice(0, Number(penv('MIROIR_SNAPSHOT_CHECK') || 0))
      cs.forEach((k) => { sq.checked[k] = true })
      sqReloadOutline()
    }
    if (penv('MIROIR_SNAPSHOT_CAMPAIGN')) {
      console.log('campagne : ' + campStart().split('\n')[0])
      for (let i = 0; i < 400 && camp; i++) { sqPoll(); campTick(); delay(0.25) }
      console.log('statut : ' + ObjC.unwrap(statusLbl.stringValue).split('\n')[0])
    }
  }
  delay(0.5)
  target.contentView.layoutSubtreeIfNeeded // applique les rechargements d'arbre en attente (pas de boucle d'événements ici)
  outline.displayIfNeeded
  const v = target.contentView.superview, b = v.bounds
  const rep = v.bitmapImageRepForCachingDisplayInRect(b)
  v.cacheDisplayInRectToBitmapImageRep(b, rep)
  rep.representationUsingTypeProperties(4, $()).writeToFileAtomically(snap, true)
  ObjC.import('stdlib')
  $.exit(0)
}
purgeOldTests()
purgeOldMic()
purgeOldSq()
poll(true)
if (lastTestBlocked) setStatus('⚠️ La dernière consigne contenait un code : elle n’a pas été rechargée')
$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(1, ctrl, 'tick:', $(), true)
$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.3, ctrl, 'sqtick:', $(), true)
if (sq.open) sqLoadProjects()
app.run
