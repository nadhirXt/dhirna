# Contribuer à Dhirna

Merci de contribuer à Dhirna. Ce guide résume l'organisation du dépôt, les tests requis et le flux de Pull Request.

## Règles d'architecture

1. **Source unique dans `core/`** : toute la logique JS/CSS partagée (domaines, règles, état, sons, analytics, bouclier, QR Code ISO/IEC 18004, traductions FR/EN, tokens CSS) vit dans `core/`. Ne modifiez jamais directement les copies synchronisées dans `extension/src/lib/` ou `desktop/ui/lib/`. Exécutez `npm run sync-core` après chaque modification dans `core/`.
2. **100 % local et sans télémétrie** : aucun compte obligatoire, aucun serveur tiers de collecte, aucune surveillance cachée.
3. **Zéro appel PowerShell/shell sous Windows** : dans `desktop/src-tauri/src/`, utilisez exclusivement les API Win32 / COM natives (`windows-rs`) afin d'éviter toute fenêtre console furtive et tout faux positif antivirus.
4. **Arrêt d'urgence inviolable** : tout mécanisme de blocage doit être intégralement libéré par `--kill`, `--safe-mode`, `scripts/kill.sh` et `scripts/kill.ps1`.

## Prérequis locaux

- Node.js 20+
- Rust stable (`rustup`)
- Linux : paquets système détaillés dans [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md)
- Windows : Visual Studio Build Tools C++ et WebView2 ([docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md))

## Vérifications obligatoires avant toute Pull Request

```bash
# 1. Synchroniser core/ et exécuter tous les tests unitaires JS
npm test
npm run check-core

# 2. Empaqueter l'extension navigateur
npm run package

# 3. Exécuter les tests unitaires Rust
cd desktop/src-tauri
cargo test
```

Sous Linux, vérifiez également le script d'arrêt d'urgence :

```bash
bash -n scripts/kill.sh
bash scripts/kill.sh --dry-run
```

## Processus de Pull Request

1. Ouvrez une issue avant tout changement majeur d'architecture.
2. Créez une branche dédiée depuis `main` (`feat/nom-court`, `fix/nom-court`, `docs/nom-court`).
3. Respectez les Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
4. Ajoutez ou mettez à jour les tests unitaires dans `tests/` ou `desktop/src-tauri/src/`.

## Sécurité et code de conduite

- Pour toute faille de sécurité, suivez la divulgation privée décrite dans [SECURITY.md](SECURITY.md).
- Les échanges dans ce dépôt respectent le [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
