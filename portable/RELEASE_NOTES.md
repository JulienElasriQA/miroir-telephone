> ⚠️ **Version expérimentale.** Ce portage Windows / Linux est testé automatiquement (construction, interface, installation de scrcpy), mais **pas encore sur un vrai téléphone**. Les retours sont bienvenus.

## Ce qui marche

- **Android** via [scrcpy](https://github.com/Genymobile/scrcpy) : miroir piloté au clavier et à la souris, capture PNG, vidéo MP4.
- **Nouveau en 0.2 (fonctions inspirées de Vysor Pro)** : qualité Standard / Haute / Max, plein écran, mode sans fil avec reconnexion automatique, envoi de fichiers (APK installés), partage sur le réseau local.
- Si scrcpy est absent, le bouton **Installer** le télécharge dans le dossier de l'utilisateur (somme SHA-256 vérifiée). Aucun droit administrateur n'est nécessaire.
- **iPhone** : recopie d'écran AirPlay, seulement si [UxPlay](https://github.com/FDH2/UxPlay) est installé. Il n'y a pas de capture ni de vidéo iPhone pour l'instant.

## Installation (sans admin)

**Windows** : téléchargez `MiroirTelephone-windows-x64.exe` et lancez-le. L'exécutable n'est pas signé : SmartScreen affichera « Informations complémentaires → Exécuter quand même ». Pour avoir des raccourcis dans le Menu Démarrer et sur le Bureau, lancez :
`powershell -ExecutionPolicy Bypass -File install-windows.ps1`

**Linux (x86_64)** : téléchargez `MiroirTelephone-linux-x86_64`, puis lancez :
`chmod +x MiroirTelephone-linux-x86_64 && ./install-linux.sh`

## Quand faut-il un admin ?

- **Linux**, si la carte indique « Accès USB refusé » : il faut installer une règle udev, une seule fois (voir le README).
- **Windows**, si le téléphone n'apparaît pas : certains constructeurs (Samsung notamment) demandent leur pilote USB.
