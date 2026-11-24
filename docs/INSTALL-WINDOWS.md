# Installation sur Windows (10 / 11)

## 1. Téléchargement et vérification SHA256

1. Ouvrez la page [GitHub Releases](https://github.com/nadhirXt/dhirna/releases/latest).
2. Téléchargez `Dhirna_*_x64-setup.exe` (installeur NSIS) ou `Dhirna_*_x64_en-US.msi`, ainsi que `SHA256SUMS.txt`.
3. Vérifiez l'empreinte du fichier avant de l'exécuter :
   ```powershell
   Get-FileHash .\Dhirna_*_x64-setup.exe -Algorithm SHA256
   Get-Content .\SHA256SUMS.txt | Select-String "x64-setup.exe"
   ```

## 2. Installer l'application desktop

1. Exécutez le fichier `.exe` ou `.msi` en tant qu'utilisateur standard.
2. Si Windows SmartScreen affiche "Windows a protégé votre ordinateur" (le binaire open source n'est pas signé par un certificat commercial payant), cliquez sur Informations complémentaires puis Exécuter quand même.
3. Lancez Dhirna depuis le menu Démarrer. Aucune fenêtre noire PowerShell ou `cmd.exe` ne s'ouvre pendant l'utilisation. L'élévation administrateur (UAC) n'est demandée que si vous activez volontairement le Mode Strict `hosts` ou le Bouclier DNS PC.

## 3. Installer l'extension navigateur (Chrome, Brave, Edge)

1. Téléchargez et décompressez `dhirna-extension-v1.0.0.zip`.
2. Ouvrez `edge://extensions`, `chrome://extensions` ou `brave://extensions`.
3. Activez le Mode développeur, cliquez sur Charger l'extension non empaquetée et sélectionnez le dossier extrait.

## 4. Compiler depuis les sources

Prérequis : Node.js 20+, Rust (`rustup`), Visual Studio Build Tools C++ (charge de travail Développement Desktop en C++) et WebView2 (déjà inclus dans Windows 11).

```powershell
git clone https://github.com/nadhirXt/dhirna.git
cd dhirna
npm test
npm run check-core
cd desktop\src-tauri
cargo test
cargo build --release
```

## 5. Désinstallation propre

1. Si le Bouclier PC ou le Mode Strict était activé, restaurez d'abord `hosts` et le DNS en PowerShell administrateur :
   ```powershell
   .\scripts\kill.ps1 -RestoreDns
   ```
2. Ouvrez Paramètres, Applications, Applications installées, choisissez Dhirna et cliquez sur Désinstaller.
3. Pour supprimer aussi l'historique SQLite et vos sons importés, supprimez le dossier `%APPDATA%\com.dhirna.app\`.

## 6. Forcer l'arrêt en cas d'urgence

Exécutez `.\scripts\kill.ps1 -RestoreDns` ou `dhirna-desktop.exe --kill`. Pour ouvrir l'application sans aucun blocage actif, lancez `dhirna-desktop.exe --safe-mode`. Toutes les commandes manuelles sont dans [KILL.md](../KILL.md).
