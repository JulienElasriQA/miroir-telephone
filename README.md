<p align="center"><img src="docs/icone.png" width="128" alt=""></p>

# Miroir Téléphone

Petit panneau macOS pour **afficher, capturer et filmer l'écran d'un Android et d'un iPhone** branchés en USB, sans rien installer sur les téléphones. Pratique pour la recette mobile et les rapports d'anomalie.

<p align="center"><img src="docs/apercu.png" width="380" alt="Aperçu du panneau"></p>

| | Android | iPhone |
|---|---|---|
| Miroir | [scrcpy](https://github.com/Genymobile/scrcpy) | QuickTime Player |
| Capture (PNG) | `adb screencap` | capture de la fenêtre QuickTime |
| Vidéo | `scrcpy --record` (MP4) | enregistrement QuickTime (MOV) |

## Fonctionnalités

- Détection automatique au branchement : le miroir s'ouvre tout seul.
- Captures et vidéos horodatées (`Android_2026-11-16_10-24-08.png`, `iPhone_….mov`), avec un son à l'enregistrement.
- Chronomètre et bouton rouge pendant une vidéo ; une vidéo Android est finalisée proprement si le téléphone est débranché.
- Dossier de sortie au choix (Bureau par défaut), mémorisé.
- Fenêtre flottante (épingle) pour rester au-dessus du miroir ; position mémorisée.
- Raccourcis : `⌘1` capture Android, `⌘2` vidéo Android, `⌘3` capture iPhone, `⌘4` vidéo iPhone, `⌘O` ouvrir le dossier, `⌘Q` quitter.
- Clair / sombre automatique.

## Installation

```sh
brew install scrcpy          # fournit aussi adb
git clone https://github.com/JulienElasriQA/miroir-telephone.git
cd miroir-telephone
./build.sh --install         # crée ~/Applications/Miroir Téléphone.app
```

Ensuite, lancez **Miroir Téléphone** depuis Spotlight, le Launchpad ou le Dock.

### Premier lancement

- **Android** : activez le débogage USB (Options pour les développeurs) et acceptez l'empreinte du Mac sur le téléphone.
- **iPhone** : dans QuickTime, cliquez sur la flèche ˅ à côté du bouton rouge, puis choisissez l'iPhone comme caméra et micro. Depuis macOS 27, la source n'est plus sélectionnable par script.
- macOS demande d'autoriser **Miroir Téléphone** à piloter QuickTime Player (Automatisation). Pour la capture iPhone, il faut aussi l'autoriser dans Réglages → Confidentialité → **Enregistrement de l'écran**.

## Fonctionnement

L'app est un script [JXA](https://developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/) (`src/miroir.js`) qui construit une interface Cocoa native. `build.sh` l'emballe dans un bundle `.app` avec une icône générée par `scripts/make-icon.js`. Il n'y a ni dépendance npm ni Xcode.

- Lancer sans bundle : `osascript -l JavaScript src/miroir.js`
- Vérifier le rendu sans écran : `MIROIR_SNAPSHOT=/tmp/ui.png osascript -l JavaScript src/miroir.js`
- Journaux : `~/Library/Logs/MiroirTelephone.log`

## Limites connues

- La vidéo iPhone passe par QuickTime, qui est sandboxé : le fichier est d'abord écrit dans `~/Movies/MiroirTelephone`, puis déplacé.
- Un seul appareil Android est géré à la fois (le premier listé par `adb devices`).
