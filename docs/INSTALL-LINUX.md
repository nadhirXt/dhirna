# Installation sur Linux (Ubuntu, Debian, Linux Mint, Fedora)

## 1. Téléchargement et vérification SHA256

1. Ouvrez la page [GitHub Releases](https://github.com/nadhirXt/dhirna/releases/latest).
2. Téléchargez le format adapté à votre distribution : `.AppImage` (universel), `.deb` (Ubuntu, Debian, Linux Mint) ou `.tar.gz` (archive portable).
3. Téléchargez `SHA256SUMS.txt` dans le même dossier et vérifiez le fichier :
   ```bash
   sha256sum --ignore-missing -c SHA256SUMS.txt
   ```

## 2. Installer l'application desktop

### Option A : AppImage (toutes distributions)

```bash
chmod +x dhirna-desktop_*_amd64.AppImage
./dhirna-desktop_*_amd64.AppImage
```

Si votre distribution Ubuntu récente (22.04+) n'a pas FUSE 2 installé pour lancer les fichiers AppImage, installez `libfuse2` (ou `libfuse2t64` sur Ubuntu 24.04+) :

```bash
sudo apt-get install -y libfuse2t64 || sudo apt-get install -y libfuse2
```

### Option B : paquet .deb (Ubuntu, Debian, Linux Mint)

```bash
sudo apt-get update
sudo apt-get install -y ./dhirna-desktop_*_amd64.deb
dhirna-desktop
```

### Option C : archive portable .tar.gz

```bash
tar -xzf dhirna-desktop-linux-x86_64.tar.gz
./dhirna-desktop
```

### Option D : compiler depuis les sources

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev patchelf

git clone https://github.com/nadhirXt/dhirna.git
cd dhirna
npm test && npm run check-core
cd desktop/src-tauri && cargo test && cargo build --release
```

## 3. Installer l'extension navigateur (Chrome, Brave, Edge)

1. Téléchargez et décompressez `dhirna-extension-v1.0.0.zip` (ou générez-le avec `npm run package`).
2. Ouvrez `brave://extensions` ou `chrome://extensions`.
3. Activez le Mode développeur, cliquez sur Charger l'extension non empaquetée et sélectionnez le dossier extrait (ou le dossier `extension/`).

## 4. Note Wayland vs X11

La détection de fenêtre active utilise X11 (`x11rb`) et XWayland. Sous GNOME Wayland pur, l'extension navigateur gère l'interception des sites web. Si vous voulez aussi la détection complète des applications natives, utilisez une session X11.

## 5. Désinstallation propre

```bash
# 1. Couper le gardien, fermer les processus et restaurer /etc/hosts et le DNS si activés
bash scripts/kill.sh --restore-dns

# 2. Désinstaller le paquet .deb (si installé via apt)
sudo apt-get remove --purge -y dhirna-desktop

# 3. Supprimer les données locales (SQLite, configuration et sons importés) si souhaité
rm -rf ~/.config/dhirna ~/.local/share/com.dhirna.app
```

## 6. Forcer l'arrêt en cas d'urgence

Lancez `bash scripts/kill.sh --restore-dns` ou `dhirna-desktop --kill`. Pour redémarrer sans aucun blocage, lancez `dhirna-desktop --safe-mode`. Toutes les commandes manuelles sont détaillées dans [KILL.md](../KILL.md).
