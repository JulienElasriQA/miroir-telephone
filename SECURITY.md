# Sécurité

## Signaler une vulnérabilité

Merci de **ne pas ouvrir d'issue publique**. Utilisez le signalement privé de GitHub : onglet **Security → Report a vulnerability** de ce dépôt.

## Points d'attention

- **Mode sans fil (Android)** : adb écoute sur le port 5555 du réseau Wi-Fi. Chaque nouvel ordinateur doit être autorisé sur le téléphone, mais ce mode est à éviter sur un réseau public. Recliquez sur le bouton ou redémarrez le téléphone pour le couper.
- **Partage sur le réseau local** : la commande copiée donne à un collègue le contrôle complet du téléphone. Ne la partagez qu'avec des personnes de confiance.
- **Exécutables Windows / Linux** : ils ne sont pas signés. Téléchargez-les uniquement depuis les Releases de ce dépôt ; ils sont construits par GitHub Actions à partir des sources.
- **scrcpy** : l'installation automatique télécharge la version officielle depuis GitHub et vérifie sa somme SHA-256.
- L'app n'envoie aucune donnée sur Internet et ne contient aucun identifiant.
