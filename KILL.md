# Arrêt forcé et récupération d'urgence (KILL.md)

Aucun appareil (Windows, Linux, Android ou iPhone) ne doit rester bloqué en cas de bug, de plantage ou d'urgence. Voici les commandes et scripts pour arrêter Dhirna immédiatement et remettre votre réseau à zéro.

## 1. Options intégrées dans Dhirna (Linux et Windows)

Arrêt d'urgence complet (désactive le démarrage automatique, tue toute instance active, supprime le verrou watchdog et retire les blocs Dhirna du fichier `hosts`) :

```bash
dhirna-desktop --kill
```

Mode sans échec (lance Dhirna avec tous les blocages, overlays, alarmes et verrous coupés pour modifier vos règles) :

```bash
dhirna-desktop --safe-mode
```

Watchdog anti-blocage : pendant qu'un blocage est actif, Dhirna met à jour `dhirna_watchdog.json` toutes les 5 secondes. Si le processus plante ou est tué brutalement, le lancement suivant détecte cet arrêt anormal et libère automatiquement les verrous.

## 2. Forcer le kill sur Linux

### Avec le script fourni (`scripts/kill.sh`)

```bash
# Arrêt forcé immédiat (utilisateur)
bash scripts/kill.sh

# Arrêt forcé + nettoyage de /etc/hosts et des fichiers DNS système (demande sudo)
bash scripts/kill.sh --restore-dns

# Vérifier les commandes exécutées sans rien modifier
bash scripts/kill.sh --dry-run
```

### Commandes manuelles pas à pas

```bash
# 1. Arrêter et supprimer le service gardien utilisateur systemd
systemctl --user stop dhirna-guardian.service
systemctl --user disable dhirna-guardian.service
rm -f ~/.config/systemd/user/dhirna-guardian.service ~/.config/autostart/dhirna-guardian.desktop
systemctl --user daemon-reload

# 2. Tuer immédiatement tout processus Dhirna
pkill -9 -f dhirna-desktop

# 3. Supprimer le verrou watchdog local
rm -f ~/.config/dhirna/dhirna_watchdog.json

# 4. Si le Mode Strict ou le Bouclier DNS était actif, retirer les règles DNS et recharger le réseau
sudo rm -f /etc/NetworkManager/conf.d/99-dhirna-shield.conf /etc/systemd/resolved.conf.d/99-dhirna-shield.conf
sudo systemctl restart systemd-resolved 2>/dev/null || true
sudo systemctl reload NetworkManager 2>/dev/null || true
```

Si vous avez aussi des lignes entre `# Dhirna BEGIN` et `# Dhirna END` (ou `# Dhirna Shield SafeSearch BEGIN` et `END`) dans `/etc/hosts`, ouvrez `/etc/hosts` avec `sudo nano /etc/hosts` et supprimez ces blocs, ou lancez directement `bash scripts/kill.sh --restore-dns`.

## 3. Forcer le kill sur Windows

### Avec le script fourni (`scripts/kill.ps1`)

```powershell
# Arrêt forcé immédiat
.\scripts\kill.ps1

# Arrêt forcé + nettoyage de hosts et réinitialisation du DNS DHCP (en PowerShell Administrateur)
.\scripts\kill.ps1 -RestoreDns

# Simulation sans modification
.\scripts\kill.ps1 -DryRun
```

### Commandes manuelles pas à pas (PowerShell ou CMD)

```powershell
# 1. Supprimer le démarrage automatique utilisateur
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "DhirnaGuardian" /f

# 2. Tuer immédiatement l'application et ses processus enfants
taskkill /F /IM dhirna-desktop.exe /T

# 3. Supprimer le verrou watchdog local
Remove-Item "$env:APPDATA\Dhirna\dhirna_watchdog.json" -Force -ErrorAction SilentlyContinue
```

Si le Bouclier DNS Windows était actif, ouvrez PowerShell en Administrateur puis remettez le DNS en automatique :

```powershell
Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | ForEach-Object {
  Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses
}
ipconfig /flushdns
```

Pour nettoyer le fichier `hosts` manuellement, éditez `C:\Windows\System32\drivers\etc\hosts` en Administrateur et retirez tout bloc compris entre `# Dhirna BEGIN` / `# Dhirna END` et `# Dhirna Shield SafeSearch BEGIN` / `END`.

## 4. Android

Ouvrez Paramètres, Réseau et Internet, DNS privé, sélectionnez Automatique (ou Désactivé), puis Enregistrer.

## 5. iPhone / iPad (iOS)

Ouvrez Réglages, Général, VPN et gestion de l'appareil, choisissez Dhirna Bouclier, appuyez sur Supprimer le profil et saisissez votre code iPhone.
