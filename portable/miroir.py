#!/usr/bin/env python3
"""Miroir Téléphone, portage Windows / Linux (EXPÉRIMENTAL).

Afficher, capturer et filmer l'écran d'un Android branché en USB (scrcpy + adb).
iPhone : recopie d'écran AirPlay via UxPlay s'il est installé (pas de capture ni de vidéo).
Aucun droit administrateur requis : scrcpy est téléchargé dans le dossier de l'utilisateur.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import queue
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path
from tkinter import PhotoImage, filedialog

import customtkinter as ctk

APP_NAME = "Miroir Téléphone"
VERSION = "0.2.0-experimental"
IS_WIN = sys.platform == "win32"
NO_WINDOW = 0x08000000 if IS_WIN else 0  # CREATE_NO_WINDOW : aucune console ne s'ouvre
MIRROR_TITLE = "Android"
REC_TITLE = "Android - enregistrement"
SCRCPY_API = "https://api.github.com/repos/Genymobile/scrcpy/releases/latest"

QUALITY = {  # préréglages scrcpy : définition max, débit vidéo, images/s
    "Standard": ["--max-size", "1024", "--video-bit-rate", "4M", "--max-fps", "30"],
    "Haute": ["--max-size", "1920", "--video-bit-rate", "12M", "--max-fps", "60"],
    "Max": ["--video-bit-rate", "24M", "--max-fps", "120"],
}
GREEN, ORANGE, RED, GRAY = "#34C759", "#FF9500", "#FF3B30", "#8E8E93"


# ---------------------------------------------------------------- utilitaires
def resource(name: str) -> Path:
    """Fichier embarqué (exécutable PyInstaller) ou situé à côté du script."""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "assets" / name


def data_dir() -> Path:
    if IS_WIN:
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "MiroirTelephone"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "miroir-telephone"
    base.mkdir(parents=True, exist_ok=True)
    return base


DATA = data_dir()
CONFIG = DATA / "config.json"
LOG = DATA / "scrcpy.log"
LOCAL_SCRCPY = DATA / "scrcpy"


def run(args, timeout=5):
    """Lance une commande ; None si elle échoue ou dépasse le délai (adb figé…)."""
    try:
        return subprocess.run(args, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL,
                              creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return None


def stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def fmt(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"{s // 60}:{s % 60:02d}"


def default_output() -> Path:
    if IS_WIN:  # le Bureau peut être redirigé vers OneDrive : on lit le vrai chemin dans le registre
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                 r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
            p = Path(os.path.expandvars(winreg.QueryValueEx(key, "Desktop")[0]))
            if p.is_dir():
                return p
        except OSError:
            pass
    else:
        r = run(["xdg-user-dir", "DESKTOP"], timeout=2)
        if r and r.returncode == 0:
            p = Path(r.stdout.decode().strip())
            if p.is_dir() and p != Path.home():
                return p
    for p in (Path.home() / "Desktop", Path.home() / "Bureau", Path.home() / "Pictures"):
        if p.is_dir():
            return p
    return Path.home()


def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    CONFIG.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def open_path(p: Path) -> None:
    if IS_WIN:
        os.startfile(p)  # noqa: S606 (ouvre l'explorateur)
    else:
        subprocess.Popen(["xdg-open", str(p)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ------------------------------------------------------------- fenêtres OS
def raise_window(title: str) -> bool:
    """Ramène une fenêtre au premier plan par son titre exact."""
    if IS_WIN:
        import ctypes
        u = ctypes.windll.user32
        h = u.FindWindowW(None, title)
        if not h:
            return False
        u.ShowWindow(h, 9)  # SW_RESTORE
        u.SetForegroundWindow(h)
        return True
    for cmd in (["wmctrl", "-F", "-a", title], ["xdotool", "search", "--name", f"^{title}$", "windowactivate"]):
        if shutil.which(cmd[0]):
            r = run(cmd, timeout=3)
            if r and r.returncode == 0:
                return True
    return False


def close_window(title: str) -> bool:
    """Windows : WM_CLOSE sur la fenêtre scrcpy, qui finalise alors la vidéo proprement."""
    if not IS_WIN:
        return False
    import ctypes
    u = ctypes.windll.user32
    h = u.FindWindowW(None, title)
    if not h:
        return False
    u.PostMessageW(h, 0x0010, 0, 0)
    return True


# --------------------------------------------------------------------- outils
class Tools:
    """Localise scrcpy / adb (copie locale prioritaire, sinon PATH) et UxPlay."""

    def __init__(self) -> None:
        self.scrcpy = self.adb = self.uxplay = None
        self.refresh()

    def refresh(self) -> None:
        ext = ".exe" if IS_WIN else ""
        local = None
        if LOCAL_SCRCPY.exists():
            local = next((p for p in LOCAL_SCRCPY.rglob("scrcpy" + ext) if p.is_file()), None)
        if local:
            adb = local.parent / ("adb" + ext)
            self.scrcpy, self.adb = str(local), str(adb) if adb.exists() else shutil.which("adb")
        else:
            self.scrcpy, self.adb = shutil.which("scrcpy"), shutil.which("adb")
        self.uxplay = shutil.which("uxplay")

    def env(self) -> dict:
        e = dict(os.environ)
        if self.adb:
            e["ADB"] = self.adb  # scrcpy utilise le même adb que nous (sinon conflit de serveurs)
        return e


def _http(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "miroir-telephone"})
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 (URL GitHub fixe)
        return r.read()


def install_scrcpy() -> str:
    """Télécharge la dernière version officielle de scrcpy (avec adb) dans le dossier utilisateur."""
    machine = platform.machine().lower()
    if IS_WIN:
        key = "winarm64" if "arm" in machine else ("win64" if machine.endswith("64") else "win32")
    elif machine in ("x86_64", "amd64"):
        key = "linux-x86_64"
    else:
        raise RuntimeError(f"Pas de scrcpy officiel pour Linux {machine} : installe-le avec ta distribution "
                           "(ex. sudo apt install scrcpy).")
    rel = json.loads(_http(SCRCPY_API))
    asset = next(a for a in rel["assets"] if a["name"].startswith(f"scrcpy-{key}-"))
    sums = next((a for a in rel["assets"] if a["name"] == "SHA256SUMS.txt"), None)
    data = _http(asset["browser_download_url"])
    if sums:
        expected = next((line.split()[0] for line in _http(sums["browser_download_url"]).decode().splitlines()
                         if line.strip().endswith(asset["name"])), None)
        if expected and hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError("Téléchargement corrompu (somme SHA-256 invalide)")
    tmp = DATA / "scrcpy.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    if asset["name"].endswith(".zip"):
        zipfile.ZipFile(io.BytesIO(data)).extractall(tmp)
    else:
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            try:
                t.extractall(tmp, filter="data")
            except TypeError:  # Python < 3.12
                t.extractall(tmp)  # noqa: S202 (archive officielle vérifiée par SHA-256)
        for p in tmp.rglob("*"):
            if p.is_file() and p.name in ("scrcpy", "adb"):
                p.chmod(0o755)
    shutil.rmtree(LOCAL_SCRCPY, ignore_errors=True)
    tmp.rename(LOCAL_SCRCPY)
    return rel["tag_name"]


# ------------------------------------------------------------------- Android
def start_adb_server(tools: Tools) -> None:
    """Démarre le serveur adb sans capturer sa sortie (sinon le démon garde le tube ouvert et bloque)."""
    if tools.adb:
        try:
            subprocess.run([tools.adb, "start-server"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=20, creationflags=NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired):
            pass


def android_state(tools: Tools, prefer: tuple = ()) -> tuple[str, str | None]:
    if not tools.adb or not tools.scrcpy:
        return "missing", None
    r = run([tools.adb, "devices"], timeout=4)
    if r is None:
        return "adb-stuck", None
    lines = r.stdout.decode(errors="replace").splitlines()[1:]
    ready = [p[0] for p in (line.split("\t") for line in lines) if len(p) == 2 and p[1].strip() == "device"]
    for serial in [*[x for x in prefer if x], *ready]:
        if serial in ready:
            return "ready", serial
    if any("unauthorized" in line for line in lines):
        return "unauthorized", None
    if any("no permissions" in line for line in lines):
        return "noperm", None
    return "none", None


class Android:
    def __init__(self, tools: Tools) -> None:
        self.tools = tools
        self.state, self.serial = "none", None
        self.mirror: subprocess.Popen | None = None
        self.mirror_start = 0.0
        self.rec: subprocess.Popen | None = None
        self.rec_file: Path | None = None
        self.rec_start = 0.0
        self.quality = "Haute"
        self.wifi: str | None = None

    @property
    def wireless(self) -> bool:
        return bool(self.serial) and ":" in self.serial

    def _spawn(self, *extra: str, title: str = MIRROR_TITLE) -> subprocess.Popen:
        log = open(LOG, "ab")  # noqa: SIM115 (fermé par le processus fils)
        return subprocess.Popen([self.tools.scrcpy, "-s", self.serial, "--stay-awake", *QUALITY[self.quality],
                                 "--window-title", title, *extra],
                                stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                env=self.tools.env(), creationflags=NO_WINDOW)

    @staticmethod
    def _alive(p: subprocess.Popen | None) -> bool:
        return p is not None and p.poll() is None

    @property
    def recording(self) -> bool:
        return self._alive(self.rec)

    def open_mirror(self, *extra: str) -> None:
        if self.serial and not self._alive(self.mirror) and not (IS_WIN and self.recording):
            self.mirror = self._spawn(*extra)
            self.mirror_start = time.time()

    # ---- fonctions « Pro » : qualité, plein écran, sans fil, fichiers, partage
    def set_quality(self, q: str) -> str:
        self.quality = q if q in QUALITY else "Haute"
        if self._alive(self.mirror):
            self.stop_mirror()
            self.open_mirror()
        return f"Qualité {self.quality} : {' '.join(QUALITY[self.quality]).replace('--', '')}"

    def fullscreen(self) -> str:
        self.stop_mirror()
        self.open_mirror("--fullscreen")
        return "Plein écran : Alt+F dans le miroir pour en sortir"

    def _adb(self, *args: str, timeout: float = 10):
        return run([self.tools.adb, *args], timeout=timeout)

    def device_ip(self) -> str | None:
        for cmd, key in ((["ip", "-f", "inet", "addr", "show", "wlan0"], "inet"), (["ip", "route"], "src")):
            r = self._adb("-s", self.serial, "shell", *cmd, timeout=5)
            words = r.stdout.decode(errors="replace").split() if r else []
            for i, w in enumerate(words[:-1]):
                if w == key:
                    return words[i + 1].split("/")[0]
        return None

    def wireless_toggle(self) -> str:
        """Passe en adb Wi-Fi (port 5555) puis s'y connecte ; un second clic revient à l'USB."""
        if self.wireless:
            self.stop_mirror()
            self._adb("disconnect", self.serial, timeout=5)
            self.wifi = self.serial = None
            return "Mode sans fil désactivé : rebranche le câble USB"
        ip = self.device_ip()
        if not ip:
            return "✗ Adresse Wi-Fi introuvable : le téléphone est-il connecté au Wi-Fi ?"
        self.stop_mirror()
        self._adb("-s", self.serial, "tcpip", "5555")
        addr = f"{ip}:5555"
        for _ in range(6):
            time.sleep(1.5)
            r = self._adb("connect", addr, timeout=5)
            if r and b"connected to" in r.stdout:
                self.wifi = self.serial = addr
                self.open_mirror()
                return f"Sans fil actif ({addr}) : tu peux débrancher le câble"
        return f"✗ Connexion sans fil impossible ({addr}) : PC et téléphone sont-ils sur le même réseau ?"

    def send_files(self, files) -> str:
        """APK → installé ; autres fichiers → Téléchargements du téléphone."""
        ok = ko = 0
        for f in files:
            if f.lower().endswith(".apk"):
                r = self._adb("-s", self.serial, "install", "-r", f, timeout=300)
            else:
                r = self._adb("-s", self.serial, "push", f, "/sdcard/Download/", timeout=600)
            out = (r.stdout + r.stderr).decode(errors="replace") if r else ""
            if r and r.returncode == 0 and ("pushed" in out or "Success" in out):
                ok += 1
            else:
                ko += 1
        if ko:
            return f"⚠ {ok} fichier(s) envoyé(s), {ko} en échec"
        return f"✓ {ok} fichier(s) envoyé(s) (APK installés, autres dans Téléchargements)"

    def share_command(self) -> str | None:
        return f"scrcpy --tcpip={self.serial}" if self.wireless else None

    def stop_mirror(self) -> None:
        p, self.mirror = self.mirror, None
        if self._alive(p):
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()

    def show(self) -> str:
        """Bouton Miroir : premier plan si possible, sinon (re)lancement."""
        if not self.serial:
            return "✗ Aucun Android prêt"
        if IS_WIN and self.recording:
            raise_window(REC_TITLE)
            return "Miroir Android (enregistrement en cours)"
        if self._alive(self.mirror) and raise_window(MIRROR_TITLE):
            return "Miroir Android au premier plan"
        self.stop_mirror()
        self.open_mirror()
        return "Ouverture du miroir Android…"

    def capture(self, out: Path) -> str:
        f = out / f"Android_{stamp()}.png"
        r = run([self.tools.adb, "-s", self.serial, "exec-out", "screencap", "-p"], timeout=15)
        if r and r.returncode == 0 and r.stdout.startswith(b"\x89PNG"):
            f.write_bytes(r.stdout)
            return f"✓ Capture Android enregistrée : {f.name}"
        return "✗ Échec de la capture Android"

    def start_video(self, out: Path) -> str:
        self.rec_file = out / f"Android_{stamp()}.mp4"
        if IS_WIN:
            # Sous Windows on ne peut pas envoyer Ctrl+C à scrcpy : on enregistre depuis une fenêtre
            # de miroir, que l'on fermera (WM_CLOSE) pour finaliser le MP4.
            self.stop_mirror()
            self.rec = self._spawn("--record", str(self.rec_file), title=REC_TITLE)
        else:
            self.rec = self._spawn("--no-playback", "--no-window", "--record", str(self.rec_file))
        self.rec_start = time.time()
        return "● Vidéo Android en cours…"

    def stop_video(self) -> str:
        p, self.rec = self.rec, None
        if self._alive(p):
            if IS_WIN:
                if not close_window(REC_TITLE):
                    p.terminate()
            else:
                p.send_signal(signal.SIGINT)  # scrcpy finalise le MP4 avant de quitter
            try:
                p.wait(20)
            except subprocess.TimeoutExpired:
                p.kill()
        if IS_WIN:
            self.open_mirror()
        f = self.rec_file
        if f and f.exists() and f.stat().st_size > 0:
            return f"✓ Vidéo Android enregistrée : {f.name}"
        return "✗ Échec de la vidéo Android"

    def shutdown(self) -> None:
        if self.recording:
            self.stop_video()
        self.stop_mirror()


# -------------------------------------------------------------------- iPhone
class IPhone:
    """Récepteur AirPlay UxPlay : l'iPhone se recopie via Centre de contrôle → Recopie de l'écran."""

    def __init__(self, tools: Tools) -> None:
        self.tools = tools
        self.proc: subprocess.Popen | None = None

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def show(self) -> str:
        if not self.tools.uxplay:
            return "✗ UxPlay introuvable : voir le README pour l'installer"
        if not self.running:
            log = open(LOG, "ab")  # noqa: SIM115
            self.proc = subprocess.Popen([self.tools.uxplay, "-n", APP_NAME, "-nh"], stdout=log,
                                         stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
        return f"Sur l'iPhone : Centre de contrôle → Recopie de l'écran → « {APP_NAME} »"

    def shutdown(self) -> None:
        if self.running:
            self.proc.terminate()


# --------------------------------------------------------------- interface
class App:
    def __init__(self, root: ctk.CTk) -> None:
        self.root = root
        self.cfg = load_config()
        self.out = Path(self.cfg.get("output") or default_output())
        self.pinned = bool(self.cfg.get("pinned", True))
        self.tools = Tools()
        self.android = Android(self.tools)
        self.android.quality = self.cfg.get("quality", "Haute") if self.cfg.get("quality") in QUALITY else "Haute"
        self.android.wifi = self.cfg.get("wifi") or None
        self.iphone = IPhone(self.tools)
        self.events: queue.Queue = queue.Queue()
        self.busy = False
        self.closing = False

        root.title(APP_NAME)
        root.resizable(False, False)
        self._set_icon()
        self._build()
        self._bind_keys()
        root.protocol("WM_DELETE_WINDOW", self.quit)
        self.hint()

    # ---- construction
    def _set_icon(self) -> None:
        try:
            if IS_WIN and resource("icon.ico").exists():
                # customtkinter remplace l'icône au démarrage : on repasse derrière lui
                self.root.after(300, lambda: self.root.iconbitmap(str(resource("icon.ico"))))
            elif resource("icon.png").exists():
                self._icon = PhotoImage(file=str(resource("icon.png")))
                self.root.iconphoto(True, self._icon)
        except Exception:  # noqa: BLE001 (icône facultative)
            pass

    def _build(self) -> None:
        r = self.root
        head = ctk.CTkFrame(r, fg_color="transparent")
        head.pack(fill="x", padx=20, pady=(16, 6))
        title_row = ctk.CTkFrame(head, fg_color="transparent")
        title_row.pack(fill="x")
        ctk.CTkLabel(title_row, text=APP_NAME, font=ctk.CTkFont(size=22, weight="bold")).pack(side="left")
        ctk.CTkLabel(title_row, text=" EXPÉRIMENTAL ", font=ctk.CTkFont(size=10, weight="bold"),
                     fg_color=ORANGE, text_color="white", corner_radius=6).pack(side="left", padx=8)
        sub = ctk.CTkFrame(head, fg_color="transparent")
        sub.pack(fill="x")
        ctk.CTkLabel(sub, text="Afficher · capturer · filmer", text_color=GRAY,
                     font=ctk.CTkFont(size=13)).pack(side="left")
        self.pin = ctk.CTkSwitch(sub, text="Au premier plan", command=self.toggle_pin, font=ctk.CTkFont(size=12),
                                 switch_width=34, switch_height=18)
        self.pin.pack(side="right")
        if self.pinned:
            self.pin.select()

        self.a = self._card("A", GREEN, "Android", [("Miroir", "Ctrl+5", self.on_android_show),
                                                   ("Capture", "Ctrl+1", self.on_android_capture),
                                                   ("Vidéo", "Ctrl+2", self.on_android_video)])
        self._android_tools(self.a["frame"])
        self.i = self._card("i", "#0A84FF", "iPhone (AirPlay)", [("Miroir", "Ctrl+6", self.on_iphone_show)])

        self.status = ctk.CTkLabel(r, text="", text_color=GRAY, wraplength=380, justify="left",
                                   font=ctk.CTkFont(size=12), anchor="w")
        self.status.pack(fill="x", padx=22, pady=(6, 4))
        foot = ctk.CTkFrame(r, fg_color="transparent")
        foot.pack(fill="x", padx=16, pady=(0, 14))
        self.folder = ctk.CTkButton(foot, text="", command=self.choose_folder, width=200, height=34,
                                    fg_color=("gray80", "gray30"), text_color=("gray10", "gray95"),
                                    hover_color=("gray72", "gray38"))
        self.folder.pack(side="left", fill="x", expand=True)
        ctk.CTkButton(foot, text="↗ Ouvrir", width=96, height=34, command=lambda: open_path(self.out),
                      fg_color=("gray80", "gray30"), text_color=("gray10", "gray95"),
                      hover_color=("gray72", "gray38")).pack(side="left", padx=(8, 0))

    def _card(self, letter: str, color: str, title: str, buttons) -> dict:
        card = ctk.CTkFrame(self.root, corner_radius=14, border_width=1)
        card.pack(fill="x", padx=16, pady=6)
        top = ctk.CTkFrame(card, fg_color="transparent")
        top.pack(fill="x", padx=14, pady=(12, 8))
        # pastille dessinée (pas d'emoji : absents des polices de nombreuses distributions Linux)
        ctk.CTkLabel(top, text=letter, width=40, height=40, corner_radius=10, fg_color=color, text_color="white",
                     font=ctk.CTkFont(size=20, weight="bold")).pack(side="left", padx=(0, 12))
        txt = ctk.CTkFrame(top, fg_color="transparent")
        txt.pack(side="left", fill="x", expand=True)
        ctk.CTkLabel(txt, text=title, font=ctk.CTkFont(size=16, weight="bold"), anchor="w").pack(fill="x")
        line = ctk.CTkFrame(txt, fg_color="transparent")
        line.pack(fill="x")
        dot = ctk.CTkLabel(line, text="●", text_color=GRAY, font=ctk.CTkFont(size=11), width=14)
        dot.pack(side="left")
        st = ctk.CTkLabel(line, text="", text_color=GRAY, font=ctk.CTkFont(size=12), anchor="w")
        st.pack(side="left", fill="x", expand=True)
        row = ctk.CTkFrame(card, fg_color="transparent")
        row.pack(fill="x", padx=14, pady=(0, 10))
        btns = []
        for i, (label, key, cmd) in enumerate(buttons):
            b = ctk.CTkButton(row, text=label, command=cmd, width=100, height=36, corner_radius=8)
            b.grid(row=0, column=i, sticky="ew", padx=(0 if i == 0 else 8, 0))
            row.grid_columnconfigure(i, weight=1, uniform="b")
            btns.append(b)
        return {"frame": card, "dot": dot, "status": st, "buttons": btns}

    def _android_tools(self, card) -> None:
        """Options Android : qualité, sans fil, plein écran, envoi de fichiers, partage."""
        q = ctk.CTkFrame(card, fg_color="transparent")
        q.pack(fill="x", padx=14, pady=(0, 8))
        ctk.CTkLabel(q, text="Qualité", text_color=GRAY, font=ctk.CTkFont(size=12)).pack(side="left", padx=(0, 8))
        self.quality = ctk.CTkSegmentedButton(q, values=list(QUALITY), command=self.on_quality, width=240, height=28)
        self.quality.set(self.android.quality)
        self.quality.pack(side="left", fill="x", expand=True)
        row = ctk.CTkFrame(card, fg_color="transparent")
        row.pack(fill="x", padx=14, pady=(0, 14))
        self.tools_btns = {}
        for i, (key, label, cmd) in enumerate((("wifi", "Sans fil", self.on_wireless),
                                               ("full", "Plein écran", self.on_fullscreen),
                                               ("send", "Envoyer…", self.on_send),
                                               ("share", "Partager", self.on_share))):
            b = ctk.CTkButton(row, text=label, command=cmd, width=80, height=30, corner_radius=8,
                              font=ctk.CTkFont(size=12))
            b.grid(row=0, column=i, sticky="ew", padx=(0 if i == 0 else 6, 0))
            row.grid_columnconfigure(i, weight=1, uniform="t")
            self.tools_btns[key] = b

    def _bind_keys(self) -> None:
        keys = {"1": self.on_android_capture, "2": self.on_android_video, "5": self.on_android_show,
                "6": self.on_iphone_show}
        for k, fn in keys.items():
            self.root.bind(f"<Control-Key-{k}>", lambda _e, f=fn: f())
        self.root.bind("<Control-q>", lambda _e: self.quit())

    # ---- état
    def set_status(self, msg: str) -> None:
        if msg:
            self.status.configure(text=msg)

    def out_label(self) -> str:
        return "Bureau" if self.out == default_output() else self.out.name

    def hint(self) -> None:
        st = self.android.state
        if st == "missing":
            self.set_status("scrcpy n'est pas installé : clique sur « Installer » (aucun droit admin requis).")
        elif st == "noperm":
            self.set_status("Linux : accès USB refusé. Une règle udev est nécessaire (admin, une seule fois) : "
                            "voir le README.")
        elif st == "adb-stuck":
            self.set_status("adb ne répond pas : débranche et rebranche le téléphone.")
        elif self.android.serial:
            self.set_status(f"Prêt. Fichiers enregistrés dans « {self.out_label()} ».")
        else:
            self.set_status("Branche un Android (débogage USB activé) : il est détecté automatiquement.")

    @staticmethod
    def _enable(b: ctk.CTkButton, on: bool, text: str | None = None, danger: bool = False) -> None:
        """customtkinter ne grise que le texte d'un bouton désactivé : on grise aussi le fond."""
        theme = ctk.ThemeManager.theme["CTkButton"]
        if danger:
            fg, hover = RED, "#D70015"
        elif on:
            fg, hover = theme["fg_color"], theme["hover_color"]
        else:
            fg = hover = ("gray78", "gray28")
        key = (on, text, danger)
        if getattr(b, "_miroir_state", None) == key:  # évite de redessiner (et faire clignoter) à chaque tick
            return
        b._miroir_state = key
        b.configure(state="normal" if on else "disabled", fg_color=fg, hover_color=hover,
                    text_color_disabled=("gray55", "gray55"), **({"text": text} if text else {}))

    def _paint(self, card: dict, color: str, text: str) -> None:
        card["dot"].configure(text_color=color)
        card["status"].configure(text=text)

    def render(self) -> None:
        a = self.android
        miroir, cap, vid = self.a["buttons"]
        texts = {
            "missing": (ORANGE, "scrcpy introuvable"),
            "unauthorized": (ORANGE, "Accepte le débogage USB sur le téléphone"),
            "noperm": (ORANGE, "Accès USB refusé (règle udev)"),
            "adb-stuck": (ORANGE, "adb ne répond pas"),
            "none": (GRAY, "Non branché"),
        }
        if a.recording:
            self._paint(self.a, RED, "Enregistrement en cours")
        elif a.serial:
            self._paint(self.a, GREEN, f"{'Sans fil' if a.wireless else 'USB'} · {a.serial}")
        else:
            self._paint(self.a, *texts.get(a.state, texts["none"]))
        ready = bool(a.serial) and not self.busy
        if a.state == "missing":
            self._enable(miroir, not self.busy, "Installer scrcpy")
        else:
            self._enable(miroir, ready, "Miroir")
        self._enable(cap, ready and not a.recording)
        if a.recording:
            self._enable(vid, True, f"■  {fmt(time.time() - a.rec_start)}", danger=True)
        else:
            self._enable(vid, ready, "Vidéo")

        on = ready and not a.recording
        self._enable(self.tools_btns["wifi"], on, "USB" if a.wireless else "Sans fil")
        self._enable(self.tools_btns["full"], on)
        self._enable(self.tools_btns["send"], on)
        self._enable(self.tools_btns["share"], on and a.wireless)
        self.quality.configure(state="disabled" if a.recording else "normal")

        ip = self.iphone
        if not self.tools.uxplay:
            self._paint(self.i, GRAY, "UxPlay non installé (facultatif)")
        elif ip.running:
            self._paint(self.i, GREEN, "Récepteur AirPlay actif")
        else:
            self._paint(self.i, GRAY, "Prêt (UxPlay)")
        self._enable(self.i["buttons"][0], bool(self.tools.uxplay))

        self.folder.configure(text=f"Dossier : {self.out_label()}")
        self.root.attributes("-topmost", self.pinned)

    # ---- boucle : détection en tâche de fond, interface sur le fil principal
    def start(self) -> None:
        threading.Thread(target=self._poll_loop, daemon=True).start()
        self.root.after(500, self._tick)

    def _poll_loop(self) -> None:
        start_adb_server(self.tools)
        n = 0
        while not self.closing:
            a = self.android
            # mode sans fil mémorisé : nouvelle tentative de connexion toutes les ~15 s
            if a.wifi and a.serial != a.wifi and self.tools.adb and n % 5 == 0:
                run([self.tools.adb, "connect", a.wifi], timeout=3)
            n += 1
            self.events.put(("poll", android_state(self.tools, (a.wifi, a.serial))))
            time.sleep(3)

    def apply_poll(self, result) -> None:
        a = self.android
        had = a.serial
        a.state, a.serial = result
        if a.serial and a.serial != had:
            a.open_mirror()
            self.set_status("Android connecté : ouverture du miroir…")
        elif had and not a.serial:
            self.hint()
        self._watchdog()

    def _watchdog(self) -> None:
        a = self.android
        if a.mirror is not None and a.mirror.poll() is not None:
            age = time.time() - a.mirror_start
            a.mirror = None
            if age < 30:
                self.set_status(f"✗ Le miroir Android s'est fermé. Détails : {LOG}")
        if a.rec is not None and a.rec.poll() is not None:  # téléphone débranché pendant la vidéo
            self.set_status(a.stop_video())

    def _tick(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "poll":
                    self.apply_poll(payload)
                elif kind == "done":
                    self.busy = False
                    self.set_status(payload)
                    self.root.bell()
        except queue.Empty:
            pass
        self.render()
        if not self.closing:
            self.root.after(500, self._tick)

    def background(self, fn, *args) -> None:
        """Exécute une action longue sans figer l'interface."""
        self.busy = True
        self.set_status("…")

        def work():
            try:
                msg = fn(*args)
            except Exception as e:  # noqa: BLE001 (message à l'utilisateur)
                msg = f"✗ {e}"
            self.events.put(("done", msg))

        threading.Thread(target=work, daemon=True).start()

    # ---- actions
    def on_android_show(self) -> None:
        if self.busy:
            return
        if self.android.state == "missing":
            self.background(self._install)
        elif self.android.serial:
            self.set_status(self.android.show())

    def _install(self) -> str:
        tag = install_scrcpy()
        self.tools.refresh()
        start_adb_server(self.tools)
        return f"✓ scrcpy {tag} installé dans {LOCAL_SCRCPY}"

    def on_android_capture(self) -> None:
        if self.android.serial and not self.busy and not self.android.recording:
            self.background(self.android.capture, self.out)

    def on_android_video(self) -> None:
        if not self.android.serial or self.busy:
            return
        if self.android.recording:
            self.background(self.android.stop_video)
        else:
            self.set_status(self.android.start_video(self.out))

    def on_quality(self, value: str) -> None:
        self.cfg["quality"] = value
        save_config(self.cfg)
        self.set_status(self.android.set_quality(value))

    def on_fullscreen(self) -> None:
        if self.android.serial and not self.busy:
            self.set_status(self.android.fullscreen())

    def on_wireless(self) -> None:
        if not self.android.serial or self.busy:
            return

        def work():
            msg = self.android.wireless_toggle()
            self.cfg["wifi"] = self.android.wifi
            save_config(self.cfg)
            return msg

        self.background(work)

    def on_send(self) -> None:
        if not self.android.serial or self.busy:
            return
        files = filedialog.askopenfilenames(title="Envoyer au téléphone (APK : installés ; autres : Téléchargements)")
        if files:
            self.background(self.android.send_files, list(files))

    def on_share(self) -> None:
        cmd = self.android.share_command()
        if not cmd:
            self.set_status("Active d'abord le mode sans fil pour partager le téléphone sur le réseau local.")
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(cmd)
        self.set_status(f"Copié : « {cmd} ». À lancer sur un poste du même réseau ; "
                        "le téléphone demandera d'autoriser ce poste.")

    def on_iphone_show(self) -> None:
        self.set_status(self.iphone.show())

    def choose_folder(self) -> None:
        d = filedialog.askdirectory(initialdir=str(self.out), title="Dossier des captures et vidéos")
        if d:
            self.out = Path(d)
            self.cfg["output"] = str(self.out)
            save_config(self.cfg)
            self.set_status(f"Fichiers enregistrés dans « {self.out_label()} »")

    def toggle_pin(self) -> None:
        self.pinned = bool(self.pin.get())
        self.cfg["pinned"] = self.pinned
        save_config(self.cfg)

    def quit(self) -> None:
        self.closing = True
        self.set_status("Fermeture…")
        self.root.update_idletasks()
        self.android.shutdown()
        self.iphone.shutdown()
        self.root.destroy()


def _snapshot(root, path: str) -> None:
    from PIL import ImageGrab
    root.update()
    x, y = root.winfo_rootx(), root.winfo_rooty()
    ImageGrab.grab(bbox=(x, y, x + root.winfo_width(), y + root.winfo_height()), all_screens=IS_WIN).save(path)
    print("capture :", path)
    root.destroy()


def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # console Windows en cp1252 : on force l'UTF-8
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ctk.set_appearance_mode("system")
    ctk.set_default_color_theme("blue")
    if "--install-scrcpy" in sys.argv:  # vérification de l'installation sans interface
        print("scrcpy", install_scrcpy(), "→", LOCAL_SCRCPY)
        t = Tools()
        r = run([t.scrcpy, "--version"], timeout=20)
        print(t.scrcpy, t.adb, (r.stdout.decode(errors="replace").splitlines() or ["?"])[0] if r else "échec")
        return 0 if r and r.returncode == 0 else 1
    root = ctk.CTk()
    app = App(root)
    if "--snapshot" in sys.argv:  # capture PNG de la fenêtre (vérification visuelle en CI)
        path = sys.argv[sys.argv.index("--snapshot") + 1]
        start_adb_server(app.tools)
        app.apply_poll(android_state(app.tools))
        app.render()
        root.after(2000, lambda: _snapshot(root, path))
        root.mainloop()
        return 0
    if "--self-test" in sys.argv:
        # Vérification sans téléphone : construit l'interface, fait une détection, puis quitte
        start_adb_server(app.tools)
        app.apply_poll(android_state(app.tools))
        app.render()
        root.update()
        print(f"OK {APP_NAME} {VERSION} | {platform.system()} {platform.machine()} | "
              f"android={app.android.state} scrcpy={app.tools.scrcpy} uxplay={app.tools.uxplay} | sortie={app.out}")
        root.destroy()
        return 0
    app.start()
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
