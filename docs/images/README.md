# Guide des captures d'écran (`docs/images/`)

Ce dossier accueille les captures d'écran illustrant l'interface Desktop **Dhirna** dans le `README.md`.

---

## 1. Captures recommandées

| # | Nom de fichier | Vue illustrée | Texte `alt` recommandé |
| --- | --- | --- | --- |
| 1 | `dhirna-focus.png` | Vue principale **Focus** (objectif actif + règle chronomètre horizontale) | `Interface Dhirna Desktop — Vue Focus` |
| 2 | `dhirna-shield.png` | Vue **Bouclier** (carte Protection PC + carte Bouclier Mobile QR Code iOS / Android) | `Dhirna — Bouclier PC et QR Code Mobile iOS et Android` |
| 3 | `dhirna-sounds.png` | Vue **Sons** (4 alertes intégrées, import audio personnalisé, volume et test) | `Dhirna — Personnalisation des sons de retour au travail` |
| 4 | `dhirna-history.png` | Vue **Historique** (indicateurs SQLite locaux et graphiques de concentration) | `Dhirna — Historique local de concentration` |

---

## 2. Règles de confidentialité avant commit

1. **Aucun nom de réseau Wi-Fi (SSID)** ni adresse IP personnelle réelle.
2. **Aucun nom d'utilisateur, e-mail ou notification privée** visible.
3. **Suppression systématique des métadonnées EXIF / PNG tEXt** :
   ```bash
   exiftool -all= -overwrite_original docs/images/*.png
   ```
