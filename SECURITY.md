# Politique de sécurité — Dhirna

## 1. Modèle de menace et périmètre

Dhirna est conçu exclusivement comme un **outil personnel d'auto-contrôle** exécuté sur **vos propres appareils** (Windows, Linux, iPhone, Android).

Garanties architecturales :
- **Stockage 100 % local** : base SQLite WAL, sons personnalisés validés par octets magiques (`RIFF/WAVE`, `OggS`, `ID3`/MPEG ≤ 5 Mo) et état JSON stockés localement.
- **Exécution native Windows sans shell** : aucune commande `powershell.exe`, `cmd.exe`, `reg.exe`, `schtasks.exe` ni script `.ps1` temporaire n'est invoqué par le binaire Rust — toutes les intégrations Windows reposent sur les API Win32 et COM natives (`ShellExecuteExW`, registre `advapi32`, presse-papiers Win32, `IAudioEndpointVolume`).
- **Zéro secret dans les QR Codes** : les QR Codes générés hors-ligne encodent uniquement le nom d'hôte DNS-over-TLS public (Android) ou l'URL éphémère sur réseau local servant le profil `.mobileconfig` Apple (iOS).
- **Sécurité anti-verrouillage** : options `--kill`, `--safe-mode`, watchdog de reprise après plantage (`dhirna_watchdog.json`) et scripts d'urgence documentés dans [KILL.md](KILL.md).
- **Chaîne CI/CD durcie** : GitHub Actions épinglées par SHA complet, permissions `GITHUB_TOKEN` minimales (`contents: read` par défaut), analyse CodeQL (JS + Rust), scan de secrets (`gitleaks`), empreintes `SHA256SUMS.txt` et SBOM CycloneDX.

## 2. Versions prises en charge

| Version | Support sécurité |
| --- | --- |
| `1.x` (dernière release sur `main`) | Prise en charge |
| `< 1.0` | Non prise en charge |

## 3. Signaler une vulnérabilité

**Ne publiez jamais une faille de sécurité dans une issue publique.**

1. Utilisez l'onglet **Security → Advisories → Report a vulnerability** sur GitHub (`https://github.com/nadhirXt/dhirna/security/advisories/new`).
2. Indiquez : version concernée, système d'exploitation, étapes de reproduction minimales et impact estimé.
3. Accusé de réception visé sous **72 heures** et correctif publié dans une release dédiée avec empreintes SHA256 vérifiables.
