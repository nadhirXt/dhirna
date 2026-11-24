# Dhirna

Application desktop pour Windows et Linux (Tauri 2) et extension navigateur pour Chrome, Brave et Edge (Manifest V3), distribuées sous licence MIT. Tout tourne en local sur votre machine, sans compte et sans télémétrie.

[![License: MIT](https://img.shields.io/badge/License-MIT-6A98F0.svg)](LICENSE)
[![Desktop: Windows & Linux](https://img.shields.io/badge/Desktop-Windows%20%7C%20Linux%20(Tauri%202)-1B202C.svg)](desktop/)
[![Extension: Chrome, Brave, Edge](https://img.shields.io/badge/Extension-Chrome%20%7C%20Brave%20%7C%20Edge-245194.svg)](extension/)
[![Privacy: 100% Local](https://img.shields.io/badge/Privacy-100%25%20Local-6A98F0.svg)](PRIVACY.md)

[Pourquoi j'ai créé Dhirna](#pourquoi-jai-créé-dhirna) · [Fonctionnalités](#fonctionnalités) · [Téléchargement et installation](#téléchargement-et-installation) · [Forcer l'arrêt (Windows et Linux)](#forcer-larrêt-windows-et-linux) · [Compiler depuis les sources](#compiler-depuis-les-sources) · [Architecture](#architecture)

## Pourquoi j'ai créé Dhirna

Je suis étudiant. En plein travail sur un projet, un code ou une révision, il m'arrivait tout le temps d'ouvrir Instagram ou TikTok par pur réflexe, sur mon PC ou sur mon téléphone. Je pensais y rester deux minutes et je perdais une heure sans m'en rendre compte.

J'ai développé Dhirna d'abord pour moi et pour les étudiants qui vivent la même chose, mais l'application sert à toute personne qui veut rester concentrée sur ses tâches. Au lieu de simplement bloquer une page et de vous laisser devant un écran vide, Dhirna ferme la distraction et vous ramène directement sur la fenêtre où vous étiez en train de travailler.

## Fonctionnalités

### Retour au travail en 3 secondes

Vous déclarez vos outils de travail (VS Code, LibreOffice, Overleaf, Google Docs, terminal, etc.) et les sites ou applications qui vous font perdre du temps. Dès qu'une distraction s'ouvre, Dhirna affiche un court rappel de 3 secondes, joue un son discret, ferme l'onglet ou l'application distrayante et remet le focus sur votre dernière fenêtre de travail ouverte. L'application desktop et l'extension navigateur communiquent uniquement en local sur `127.0.0.1:47821`.

### Sessions de focus, horaires et garde anti-absence

Vous pouvez lancer une session verrouillée de 25, 50 ou 90 minutes, avec un affichage sobre qui masque la barre latérale (mode Silence) pour éviter tout bruit visuel. Les règles restent verrouillées jusqu'à la fin du minuteur. La protection peut aussi s'activer toute seule dès que vous ouvrez un de vos outils de travail, ou suivre un horaire fixe que vous définissez par jour et par plage horaire. Si vous quittez votre clavier pendant 1, 2 ou 5 minutes en pleine session, une garde anti-absence déclenche un rappel sonore pour vous ramener au bureau.

### Détection Instagram, TikTok, Reels et Snapchat par câble USB

Si vous avez tendance à attraper votre téléphone pendant que vous travaillez sur PC, vous pouvez le brancher en USB. Dhirna détecte l'ouverture des réseaux sociaux cochés (Instagram, TikTok, Snapchat, YouTube Shorts, etc.) sur Android (via `adb` en lecture seule) et sur iPhone (via `usbmuxd` et `pcapd`). L'alarme sonne sur le PC, même si le son du PC était coupé, puis s'arrête toute seule dès que vous quittez l'application ou verrouillez l'écran du téléphone. Cette fonction est totalement optionnelle : si aucun téléphone n'est branché, vous pouvez démarrer vos sessions sur PC normalement.

### Mode Messages uniquement pendant le focus

Sur le navigateur, Dhirna peut couper les flux addictifs (Reels, YouTube Shorts, TikTok) pendant vos sessions tout en laissant vos messages privés accessibles, pour répondre à un camarade ou un collègue sans tomber dans le scroll infini.

### Bouclier anti-pornographie sur PC et téléphone

Sur PC, Dhirna permet d'activer un filtrage permanent via un DNS famille gratuit et sans compte (CleanBrowsing, Cloudflare for Families ou AdGuard Family), avec SafeSearch forcé sur Google, Bing, DuckDuckGo, Qwant et Ecosia, un mode restreint YouTube optionnel et un Mode Strict basé sur le fichier `hosts`. Un verrouillage anti-impulsion (24 h, 7 j ou 30 j) et une pause obligatoire de 60 secondes avec phrase de confirmation empêchent de couper le bouclier sur un coup de tête. Un diagnostic réseau intégré vérifie que le DNS actif filtre bien.

Pour le téléphone, l'onglet Bouclier génère hors ligne un QR Code adapté à iOS ou Android. Sur iPhone, le scan installe un profil DNS chiffré `.mobileconfig` servi localement sur votre réseau Wi-Fi (ou exportable en fichier). Sur Android, il affiche le nom d'hôte DNS privé (`DNS-over-TLS`) à copier dans les réglages système. Aucune application tierce n'est à installer sur le téléphone.

### Sons de retour au travail personnalisables

Quatre sons discrets sont synthétisés localement hors ligne (`Chime`, `Soft Bell`, `Focus Pulse`, `Minimal Tap`). Vous pouvez aussi importer votre propre fichier audio `.mp3`, `.wav` ou `.ogg` (5 Mo maximum), copié dans le dossier local de Dhirna pour rester disponible même si vous déplacez le fichier d'origine. Le volume est réglable de 0 à 100 %, avec mode muet et bouton d'essai immédiat.

### Historique local en SQLite

Dhirna enregistre votre temps de concentration par jour, votre taux de focus, les sites et applications les plus interceptés, le temps passé par outil et vos heures de pic de distraction entre 0h et 23h. Vous pouvez exporter ces données en CSV ou JSON et tout réinitialiser en un clic. Rien ne quitte votre ordinateur.

### Exécution native sous Windows et interface claire

Sous Windows, l'application utilise directement les API Win32 et COM natives : aucune fenêtre noire PowerShell ou `cmd.exe` ne clignote à l'écran, et aucun script `.ps1` temporaire n'est généré. L'interface propose un mode sombre par défaut, un mode clair, le français et l'anglais, ainsi qu'une palette d'actions rapides accessible avec `Ctrl K`.

## Téléchargement et installation

Tous les paquets prêts à l'emploi sont publiés sur la page [GitHub Releases](https://github.com/nadhirXt/dhirna/releases/latest) avec leur fichier d'empreintes `SHA256SUMS.txt` :

- Windows : installeur `.exe` (NSIS) ou `.msi`
- Linux : `.AppImage` (toutes distributions), `.deb` (Ubuntu, Debian, Linux Mint) ou archive `.tar.gz`
- Extension navigateur : archive `dhirna-extension-v1.0.0.zip`

### Installer sur Windows (10 / 11)

1. Téléchargez `Dhirna_*_x64-setup.exe` ou `Dhirna_*_x64_en-US.msi` depuis [GitHub Releases](https://github.com/nadhirXt/dhirna/releases/latest).
2. Vérifiez l'empreinte si besoin :
   ```powershell
   Get-FileHash .\Dhirna_*_x64-setup.exe -Algorithm SHA256
   Get-Content .\SHA256SUMS.txt | Select-String "x64-setup.exe"
   ```
3. Lancez l'installeur en utilisateur standard. Si Windows SmartScreen affiche un avertissement (binaire open source non signé par un certificat payant), cliquez sur Informations complémentaires puis Exécuter quand même.
4. Ouvrez Dhirna depuis le menu Démarrer. Les droits administrateur (UAC) ne sont demandés que si vous activez volontairement le Mode Strict `hosts` ou le Bouclier DNS PC.

Guide complet et désinstallation propre : [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md).

### Installer sur Linux (Ubuntu, Debian, Mint, Fedora)

Avec AppImage (fonctionne sur presque toutes les distributions) :

```bash
chmod +x dhirna-desktop_*_amd64.AppImage
./dhirna-desktop_*_amd64.AppImage
```

Avec le paquet `.deb` (Ubuntu, Debian, Linux Mint) :

```bash
sudo apt-get update && sudo apt-get install -y ./dhirna-desktop_*_amd64.deb
dhirna-desktop
```

Guide complet, vérification SHA256, note Wayland/X11 et désinstallation : [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md).

### Installer l'extension navigateur (Chrome, Brave, Edge)

1. Téléchargez et décompressez `dhirna-extension-v1.0.0.zip` (ou utilisez directement le dossier `extension/` du dépôt).
2. Ouvrez `chrome://extensions`, `brave://extensions` ou `edge://extensions`.
3. Activez le Mode développeur, cliquez sur Charger l'extension non empaquetée et choisissez le dossier extrait.

## Forcer l'arrêt (Windows et Linux)

Une application de blocage ne doit jamais vous laisser coincé en cas de bug ou d'urgence. Dhirna intègre un watchdog qui vérifie toutes les 5 secondes si le processus tourne toujours et libère les blocages automatiquement après un plantage. Vous disposez aussi de plusieurs méthodes d'arrêt forcé immédiat.

### Commandes intégrées (Windows et Linux)

```bash
# Arrête Dhirna, coupe le démarrage automatique, supprime le verrou watchdog et nettoie hosts
dhirna-desktop --kill

# Relance Dhirna avec tous les blocages, alarmes et verrous désactivés
dhirna-desktop --safe-mode
```

### Forcer le kill sur Linux

Via le script fourni :

```bash
# Arrêt forcé immédiat
bash scripts/kill.sh

# Arrêt forcé + restauration de /etc/hosts et du DNS système (demande sudo)
bash scripts/kill.sh --restore-dns
```

Ou manuellement dans un terminal :

```bash
systemctl --user stop dhirna-guardian.service
systemctl --user disable dhirna-guardian.service
rm -f ~/.config/systemd/user/dhirna-guardian.service ~/.config/autostart/dhirna-guardian.desktop
systemctl --user daemon-reload
pkill -9 -f dhirna-desktop
sudo rm -f /etc/NetworkManager/conf.d/99-dhirna-shield.conf /etc/systemd/resolved.conf.d/99-dhirna-shield.conf
sudo systemctl restart systemd-resolved 2>/dev/null || true
sudo systemctl reload NetworkManager 2>/dev/null || true
```

### Forcer le kill sur Windows

Via le script PowerShell fourni :

```powershell
# Arrêt forcé immédiat
.\scripts\kill.ps1

# Arrêt forcé + restauration du fichier hosts et du DNS automatique (en Administrateur)
.\scripts\kill.ps1 -RestoreDns
```

Ou manuellement dans PowerShell / Invite de commandes :

```powershell
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "DhirnaGuardian" /f
taskkill /F /IM dhirna-desktop.exe /T
```

Procédure complète (y compris pour retirer le DNS privé Android ou le profil `.mobileconfig` iOS) : [KILL.md](KILL.md).

## Compiler depuis les sources

Prérequis : Node.js 20+ et Rust stable (`rustup`).

Sur Ubuntu / Debian, installez d'abord les bibliothèques Tauri :

```bash
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev patchelf
```

Sous Windows, installez Visual Studio Build Tools C++ (WebView2 est déjà présent dans Windows 11).

Lancer les tests et construire les paquets :

```bash
# 1. Synchroniser core/ et exécuter les tests JS
npm test
npm run check-core

# 2. Construire le zip de l'extension (dist/dhirna-extension-v1.0.0.zip)
npm run package

# 3. Tester et compiler le binaire Desktop Rust
cd desktop/src-tauri
cargo test
cargo build --release
```

Pour générer les installeurs complets (`.AppImage` et `.deb` sur Linux ; `.exe` et `.msi` sur Windows) :

```bash
npx --yes @tauri-apps/cli@2 build --config desktop/src-tauri/tauri.conf.json
```

## Architecture

```text
dhirna/
├── core/                 # Logique partagée JS/CSS (état, règles, bouclier, sons, QR, i18n, analytics)
├── desktop/
│   ├── ui/               # Interface Desktop (Focus, Bouclier, Sons, Règles, Historique, Overlay 3s)
│   └── src-tauri/        # Backend Rust Tauri 2 (Win32/COM, X11, SQLite, capteur USB, sons, serveur QR LAN)
├── extension/            # Extension Chromium Manifest V3 synchronisée sur 127.0.0.1:47821
├── scripts/              # Sync core/, génération d'icônes, build zip extension et scripts de kill
├── tests/                # Tests unitaires Node.js (node --test)
└── .github/workflows/    # CI multi-OS (ci.yml) et publication automatique des releases (release.yml)
```

## Vie privée, captures et licence

Tout reste stocké localement dans `~/.config/dhirna/` (Linux) ou `%APPDATA%\com.dhirna.app\` (Windows). Plus de détails dans [PRIVACY.md](PRIVACY.md) et [SECURITY.md](SECURITY.md). Les règles pour ajouter des captures d'écran propres (sans métadonnées EXIF) sont dans [docs/images/README.md](docs/images/README.md).

Les contributions sont les bienvenues via [CONTRIBUTING.md](CONTRIBUTING.md). Ce projet est distribué sous licence [MIT](LICENSE).
