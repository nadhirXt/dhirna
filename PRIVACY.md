# Éthique et politique de vie privée — Dhirna

**Date de mise à jour :** 24 novembre 2026

Dhirna est un logiciel libre (licence MIT) conçu strictement comme un **outil personnel d'auto-contrôle et de concentration pour vos propres appareils**.

---

## 1. Engagement éthique (zéro surveillance cachée)

- **Usage strictement personnel :** Dhirna ne doit être installé et configuré que sur des ordinateurs et téléphones qui vous appartiennent.
- **Consentement explicite sur mobile :** le QR Code du Bouclier Mobile configure uniquement un profil DNS chiffré natif iOS (`.mobileconfig`) ou un nom d'hôte DNS privé Android (`DNS-over-TLS`), toujours validé manuellement dans les réglages système du téléphone.
- **Visibilité permanente :** sur PC, l'icône de barre système Dhirna reste visible en permanence.
- **Arrêt immédiat garanti :** vous pouvez couper Dhirna à tout instant via `--kill`, `--safe-mode`, `scripts/kill.sh`, `scripts/kill.ps1` ou les réglages natifs iOS/Android ([KILL.md](KILL.md)).

---

## 2. Collecte de données : zéro télémétrie

- **Aucune télémétrie, aucun traceur, aucun compte utilisateur.**
- **Aucun serveur tiers :** l'historique de concentration, vos règles, vos objectifs et vos sons personnalisés restent intégralement sur votre machine locale. La synchronisation entre Dhirna Desktop et l'extension navigateur s'effectue exclusivement en boucle locale (`127.0.0.1:47821`).
- **Filtrage DNS optionnel :** si vous activez le Bouclier DNS famille (`CleanBrowsing`, `Cloudflare for Families` ou `AdGuard Family`), vos requêtes DNS transitent directement vers le résolveur public sans compte que vous avez sélectionné.

---

## 3. Stockage local

- **Application Desktop (Linux / Windows) :** configuration, sons importés et base SQLite enregistrés localement dans `~/.config/dhirna/` / `~/.local/share/com.dhirna.app/` (Linux) ou `%APPDATA%\com.dhirna.app\` (Windows). Vous pouvez tout exporter (CSV/JSON) ou effacer définitivement depuis **Historique → Réinitialiser**.
- **Extension Navigateur (Chrome / Brave / Edge) :** réglages enregistrés dans `chrome.storage.local` uniquement.

---

## 4. Permissions minimales justifiées

| Composant | Permission | Justification stricte |
| --- | --- | --- |
| Extension MV3 | `declarativeNetRequest` | Rediriger localement un domaine distrayant vers la page de rappel locale `blocked.html`. |
| Extension MV3 | `tabs` | Vérifier en mémoire si un onglet de travail est ouvert pour le retour automatique (aucun historique transmis). |
| Extension MV3 | `storage`, `alarms`, `notifications` | Sauvegarder vos règles localement et terminer les minuteurs de session à l'heure. |
| Desktop (Linux / Windows) | Titre de fenêtre active (X11 / Win32) | Identifier localement vos applications de travail et distractions configurées. |
| iOS / Android (optionnel) | Profil `.mobileconfig` DoH / DNS privé DoT | Filtrage anti-pornographie DNS chiffré système, révocable à tout moment dans les Réglages du téléphone. |
