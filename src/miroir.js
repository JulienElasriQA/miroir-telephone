// Miroir Téléphone : panneau macOS pour afficher, capturer et filmer un Android (scrcpy)
// et un iPhone (QuickTime) branchés en USB. Écrit en JXA (JavaScript for Automation) + Cocoa.
ObjC.import('Cocoa')

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
const ding = () => sh('afplay /System/Library/Sounds/Glass.aiff >/dev/null 2>&1 &')
const fileOk = (f) => sh(`test -s ${q(f)} && echo ok`) === 'ok'
const alive = (pid) => !!pid && sh(`kill -0 ${pid} && echo ok`) === 'ok'
// Coupe une commande qui ne répond pas (serveur adb figé, etc.) pour ne jamais geler l'interface
const tmo = (sec, cmd) => `perl -e 'alarm shift; exec @ARGV' ${sec} ${cmd}`
const now = () => Date.now() / 1000
const fmt = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const outLabel = () => (OUT === HOME + '/Desktop' ? 'Bureau' : OUT.replace(HOME, '~').split('/').pop())

// ---------- État ----------
const st = {
  hasScrcpy: !!sh('command -v scrcpy'), hasAdb: !!sh('command -v adb'),
  serial: null, androidUnauth: false, mirrorPid: null, recPid: null, recFile: null, recStart: 0,
  ios: false, iosDoc: null, iosName: null, iosRec: false, iosStart: 0,
}

// ---------- Android ----------
function detectAndroid() {
  if (!st.hasAdb) return
  const lines = (sh(tmo(4, 'adb devices')) || '').split('\n').slice(1)
  const ready = lines.find((l) => /\tdevice$/.test(l))
  st.serial = ready ? ready.split('\t')[0] : null
  st.androidUnauth = lines.some((l) => /\tunauthorized$/.test(l))
}

function openAndroid() {
  if (!st.serial || !st.hasScrcpy || alive(st.mirrorPid)) return
  st.mirrorPid = sh(`scrcpy -s ${q(st.serial)} --stay-awake --window-title 'Android' >/dev/null 2>&1 & echo $!`)
}

function androidCapture() {
  const f = `${OUT}/Android_${stamp()}.png`
  sh(`${tmo(15, `adb -s ${q(st.serial)} exec-out screencap -p`)} > ${q(f)}`)
  if (fileOk(f)) { ding(); return '✅ Capture Android enregistrée' }
  sh(`rm -f ${q(f)}`)
  return '❌ Échec de la capture Android'
}

function androidVideoToggle() {
  if (st.recPid) return stopAndroidVideo()
  st.recFile = `${OUT}/Android_${stamp()}.mp4`
  st.recPid = sh(`scrcpy -s ${q(st.serial)} --no-playback --no-window --record ${q(st.recFile)} >/dev/null 2>&1 & echo $!`)
  st.recStart = now()
  return st.recPid ? '🔴 Vidéo Android en cours…' : '❌ Impossible de démarrer la vidéo Android'
}

// SIGTERM : scrcpy finalise le MP4 avant de quitter
function stopAndroidVideo() {
  if (!st.recPid) return ''
  sh(`kill -TERM ${st.recPid}; while kill -0 ${st.recPid} 2>/dev/null; do sleep 0.2; done`)
  st.recPid = null
  if (fileOk(st.recFile)) { ding(); return '✅ Vidéo Android enregistrée' }
  return '❌ Échec de la vidéo Android'
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
const W = 380, H = 424, CW = W - 32, CH = 116
const COLORS = {
  green: $.NSColor.systemGreenColor, orange: $.NSColor.systemOrangeColor,
  red: $.NSColor.systemRedColor, gray: $.NSColor.tertiaryLabelColor, blue: $.NSColor.systemBlueColor,
}
const rect = (x, y, w, h) => $.NSMakeRect(x, y, w, h)

ObjC.registerSubclass({
  name: 'MiroirController',
  superclass: 'NSObject',
  protocols: ['NSWindowDelegate'],
  methods: {
    // le tag arrive en objet Cocoa : conversion obligatoire
    'click:': { types: ['void', ['id']], implementation: (sender) => safe(() => onClick(Number(sender.tag))) },
    'tick:': { types: ['void', ['id']], implementation: () => safe(onTick) },
    'quitApp:': { types: ['void', ['id']], implementation: () => quit() },
    'windowWillClose:': { types: ['void', ['id']], implementation: () => quit() },
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
  if (img) { b.setImage(img); b.setImagePosition(7 /* à gauche du titre */); b.setImageHugsTitle(true) }
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

function mkCard(parent, y) {
  const box = $.NSBox.alloc.initWithFrame(rect(16, y, CW, CH))
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
function mkDevice(parent, y, title, icon, tint, tags, keys) {
  const c = mkCard(parent, y)
  mkImage(c, rect(14, 66, 36, 36), sym(icon[0], 26, 0.23) || sym(icon[1], 26, 0.23), tint)
  mkLabel(c, title, rect(58, 80, 220, 22), { size: 15, weight: 0.3 })
  const dot = mkImage(c, rect(58, 65, 10, 14), sym('circle.fill', 7), COLORS.gray)
  const status = mkLabel(c, '', rect(72, 63, CW - 72 - 44, 17), { size: 12, color: $.NSColor.secondaryLabelColor })
  const show = mkIconButton(c, 'macwindow', rect(CW - 42, 72, 30, 28), tags[2], 'Afficher le miroir')
  const bw = (CW - 38) / 2
  const cap = mkButton(c, 'Capture', 'camera', rect(14, 12, bw, 34), tags[0], keys[0], `Capture d’écran (⌘${keys[0]})`)
  const vid = mkButton(c, 'Vidéo', 'record.circle', rect(24 + bw, 12, bw, 34), tags[1], keys[1], `Démarrer / arrêter la vidéo (⌘${keys[1]})`)
  return { dot, status, show, cap, vid, key: keys[1] }
}

const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
  rect(0, 0, W, H), 1 | 2 | 4 | (1 << 15) /* titrée, fermable, réductible, contenu plein cadre */, $.NSBackingStoreBuffered, false)
win.setTitle('Miroir Téléphone')
win.setTitleVisibility(1)
win.setTitlebarAppearsTransparent(true)
win.setMovableByWindowBackground(true)
win.setReleasedWhenClosed(false)
win.setDelegate(ctrl)

const root = $.NSVisualEffectView.alloc.initWithFrame(rect(0, 0, W, H))
root.setMaterial(21) // fond de fenêtre translucide
root.setBlendingMode(0)
root.setState(1)
win.setContentView(root)

// En-tête
mkLabel(root, 'Miroir Téléphone', rect(20, H - 62, 260, 24), { size: 18, weight: 0.4 })
mkLabel(root, 'Afficher · capturer · filmer en USB', rect(20, H - 80, 260, 16), { size: 12, color: $.NSColor.secondaryLabelColor })
const pinBtn = mkIconButton(root, 'pin', rect(W - 48, H - 70, 30, 28), 11, 'Garder au premier plan')

// Appareils
const A = mkDevice(root, H - 92 - CH, 'Android', ['smartphone', 'candybarphone'], COLORS.green, [1, 2, 8], ['1', '2'])
const I = mkDevice(root, H - 92 - 2 * CH - 12, 'iPhone', ['iphone', 'iphone.gen3'], COLORS.blue, [3, 4, 9], ['3', '4'])

// Pied : message d'état puis dossier de sortie
const statusLbl = mkLabel(root, '', rect(20, 46, W - 40, 34), { size: 11.5, wrap: true, color: $.NSColor.secondaryLabelColor })
const folderBtn = mkButton(root, '', 'folder', rect(14, 10, 230, 32), 10, null, 'Choisir le dossier où enregistrer captures et vidéos')
mkButton(root, 'Ouvrir', 'arrow.up.forward.square', rect(W - 14 - 120, 10, 120, 32), 7, 'o', 'Ouvrir le dossier (⌘O)')

function setStatus(msg) { if (msg) { statusLbl.setStringValue(msg); statusLbl.display } }

function paintDevice(d, color, text, enabled, recording, recStart) {
  d.dot.setContentTintColor(COLORS[color])
  d.status.setStringValue(text)
  d.cap.setEnabled(enabled && !recording)
  d.vid.setEnabled(enabled)
  d.show.setEnabled(enabled)
  d.vid.setTitle(recording ? `Arrêter  ${fmt(now() - recStart)}` : 'Vidéo')
  d.vid.setImage(sym(recording ? 'stop.fill' : 'record.circle', 13, 0.23))
  d.vid.setBezelColor(recording ? COLORS.red : $())
  d.vid.setKeyEquivalent(d.key)
}

function render() {
  if (!st.hasScrcpy || !st.hasAdb) paintDevice(A, 'orange', 'scrcpy absent — brew install scrcpy', false, false)
  else if (st.serial && st.recPid) paintDevice(A, 'red', 'Enregistrement en cours', true, true, st.recStart)
  else if (st.serial) paintDevice(A, 'green', `Connecté · ${st.serial}`, true, false)
  else if (st.androidUnauth) paintDevice(A, 'orange', 'Accepte le débogage USB sur le téléphone', false, false)
  else paintDevice(A, 'gray', 'Non branché', false, false)

  if (st.ios && st.iosRec) paintDevice(I, 'red', 'Enregistrement en cours', true, true, st.iosStart)
  else if (st.ios) paintDevice(I, 'green', 'Connecté · via QuickTime', true, false)
  else paintDevice(I, 'gray', 'Non branché', false, false)

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
function poll(first) {
  const had = { serial: st.serial, ios: st.ios }
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
  if (st.recPid && !alive(st.recPid)) {
    st.recPid = null
    setStatus(fileOk(st.recFile) ? '✅ Vidéo Android enregistrée (appareil déconnecté)' : '❌ Vidéo Android interrompue')
  }
  if (ticks % 3 === 0) poll(false)
  else if (st.recPid || st.iosRec) render()
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
function quit() {
  if (quitting) return
  quitting = true
  safe(stopAndroidVideo)
  safe(stopIOSVideo)
  if (alive(st.mirrorPid)) sh(`kill ${st.mirrorPid}`)
  try { if (iosDocAlive()) st.iosDoc.close({ saving: 'no' }) } catch (e) {}
  $.NSApp.terminate(null)
}

function onClick(tag) {
  setStatus('…')
  switch (tag) {
    case 1: setStatus(androidCapture()); break
    case 2: setStatus(androidVideoToggle()); break
    case 3:
    case 4:
      // Fenêtre QuickTime fermée entre-temps : on la rouvre
      if (!iosDocAlive()) { st.iosRec = false; openIOS(); delay(1) }
      setStatus(tag === 3 ? iosCapture() : iosVideoToggle()); break
    case 7: sh(`open ${q(OUT)}`); hint(); break
    case 8: openAndroid(); hint(); break
    case 9: showIOS(); hint(); break
    case 10: chooseFolder(); break
    case 11: pinned = !pinned; setPref('pinned', pinned); hint(); break
  }
  render()
}

// ---------- Démarrage ----------
const app = $.NSApplication.sharedApplication
app.setActivationPolicy(0)
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
app.setMainMenu(mainMenu)

render()
hint()
// Position mémorisée, sinon en haut à droite de l'écran principal
const vf = $.NSScreen.mainScreen.visibleFrame
win.setFrameTopLeftPoint($.NSMakePoint(vf.origin.x + vf.size.width - W - 20, vf.origin.y + vf.size.height - 10))
win.setFrameAutosaveName('MiroirTelephone')
win.makeKeyAndOrderFront(null)
app.activateIgnoringOtherApps(true)
// Mode vérification : MIROIR_SNAPSHOT=fichier.png écrit le rendu de la fenêtre puis quitte
const snap = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('MIROIR_SNAPSHOT'))
if (snap) {
  delay(0.5)
  const v = win.contentView.superview, b = v.bounds
  const rep = v.bitmapImageRepForCachingDisplayInRect(b)
  v.cacheDisplayInRectToBitmapImageRep(b, rep)
  rep.representationUsingTypeProperties(4, $()).writeToFileAtomically(snap, true)
  ObjC.import('stdlib')
  $.exit(0)
}
poll(true)
$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(1, ctrl, 'tick:', $(), true)
app.run
