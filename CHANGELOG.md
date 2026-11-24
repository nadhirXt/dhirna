# Changelog

Toutes les évolutions notables de **Dhirna** sont documentées dans ce fichier selon [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le versionnage sémantique.

## [1.0.0] - 2026-11-24

### Ajouté
- **Identité officielle Dhirna (`com.dhirna.app`)** : application Desktop Tauri 2 (Windows & Linux) et extension navigateur Manifest V3 (Chrome, Brave, Edge) distribuées sous licence MIT.
- **Sons « Retour au travail » personnalisables** :
  - 4 alertes intégrées synthétisées hors-ligne via Web Audio API (`Chime`, `Soft Bell`, `Focus Pulse`, `Minimal Tap`).
  - Import de fichier audio personnalisé (`.mp3`, `.wav`, `.ogg` ≤ 5 Mo) validé par extension, taille et octets magiques (`RIFF/WAVE`, `OggS`, `ID3`/MPEG), copié dans le dossier local `<appData>/sounds/` pour survivre au déplacement du fichier d'origine.
  - Contrôle du volume (`0–100 %`), mode muet, test en direct et persistance complète.
- **Bouclier PC & QR Code Mobile épuré** :
  - Protection PC 24h/24 (DNS famille `CleanBrowsing`, `Cloudflare`, `AdGuard`, SafeSearch forcé, mode « Messages uniquement » pendant les sessions Focus, Mode Strict `hosts`, verrouillage temporaire et diagnostic réseau en direct).
  - Sélecteur mobile intégré **iPhone (iOS)** / **Android** affichant directement dans l'application le QR Code anti-pornographie (`.mobileconfig` DNS-over-HTTPS servi localement sur le LAN ou exportable, et nom d'hôte DNS-over-TLS Android) en 3 étapes courtes.
- **Exécution Windows 100 % native (zéro PowerShell)** :
  - Remplacement intégral de tous les appels `powershell.exe`, `cmd.exe`, `reg.exe`, `schtasks.exe` et scripts `.ps1` temporaires par les API Win32 / COM natives (`ShellExecuteExW` avec `SW_HIDE`, registre Win32 `advapi32`, presse-papiers natif `user32`, `IAudioEndpointVolume` CoreAudio et `CREATE_NO_WINDOW`).
- **Interface Graphite Studio & Mineral Paper** :
  - Navigation latérale claire en 5 vues (**Focus**, **Bouclier**, **Sons**, **Règles**, **Historique**), palette `Ctrl K`, mode sombre par défaut et mode clair haute lisibilité (WCAG AA+).
  - Suppression de tout écran bloquant au premier lancement pour un accès immédiat à la vue **Focus**.
- **Packaging multi-plateforme & Release automatisée** :
  - Workflow `.github/workflows/release.yml` compilant et publiant automatiquement sur tag `v*.*.*` les installeurs Windows (`.exe` NSIS, `.msi`), Linux (`.AppImage`, `.deb`, `.tar.gz`), l'archive extension (`.zip`) et `SHA256SUMS.txt`.
