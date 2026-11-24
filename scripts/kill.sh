#!/usr/bin/env bash
# Dhirna Emergency Kill & Recovery Script (Linux)
# Stops guardian service, terminates all Dhirna processes, clears watchdog locks,
# and optionally restores /etc/hosts and system DNS configurations.
#
# Usage:
#   bash scripts/kill.sh               # Force-stop Dhirna and clean user locks
#   bash scripts/kill.sh --restore-dns # Also remove Dhirna /etc/hosts & DNS drop-ins (uses sudo)
#   bash scripts/kill.sh --dry-run     # Print actions without modifying the system

set -euo pipefail

DRY_RUN=false
RESTORE_DNS=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --restore-dns) RESTORE_DNS=true ;;
    -h|--help)
      echo "Usage: bash scripts/kill.sh [--dry-run] [--restore-dns]"
      exit 0
      ;;
  esac
done

run_cmd() {
  if $DRY_RUN; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

echo "[1/4] Arrêt et désactivation du service gardien utilisateur systemd..."
if command -v systemctl >/dev/null 2>&1; then
  run_cmd systemctl --user stop dhirna-guardian.service 2>/dev/null || true
  run_cmd systemctl --user disable dhirna-guardian.service 2>/dev/null || true
fi
run_cmd rm -f "${HOME}/.config/systemd/user/dhirna-guardian.service"
run_cmd rm -f "${HOME}/.config/autostart/dhirna-guardian.desktop"
if command -v systemctl >/dev/null 2>&1; then
  run_cmd systemctl --user daemon-reload 2>/dev/null || true
fi

echo "[2/4] Arrêt forcé des processus dhirna-desktop..."
if command -v pkill >/dev/null 2>&1; then
  run_cmd pkill -9 -x "dhirna-desktop" 2>/dev/null || true
fi
if command -v pgrep >/dev/null 2>&1; then
  PIDS="$(pgrep -f "dhirna-desktop" || true)"
  if [ -n "$PIDS" ]; then
    for pid in $PIDS; do
      if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then
        continue
      fi
      CMDLINE="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
      case "$CMDLINE" in
        *kill.sh*) continue ;;
      esac
      run_cmd kill -9 "$pid" 2>/dev/null || true
    done
  fi
fi

echo "[3/4] Suppression des verrous watchdog locaux..."
run_cmd rm -f "${XDG_CONFIG_HOME:-${HOME}/.config}/dhirna/dhirna_watchdog.json"

echo "[4/4] Vérification de /etc/hosts et des fichiers DNS système..."
HOSTS_HAS_DHIRNA=false
if [ -f /etc/hosts ] && grep -qE "^# Dhirna (BEGIN|Shield SafeSearch BEGIN)" /etc/hosts 2>/dev/null; then
  HOSTS_HAS_DHIRNA=true
fi
DNS_FILES_EXIST=false
if [ -f /etc/NetworkManager/conf.d/99-dhirna-shield.conf ] || [ -f /etc/systemd/resolved.conf.d/99-dhirna-shield.conf ]; then
  DNS_FILES_EXIST=true
fi

if $HOSTS_HAS_DHIRNA || $DNS_FILES_EXIST; then
  if $RESTORE_DNS; then
    ELEV=""
    if [ "$(id -u)" -ne 0 ]; then
      ELEV="sudo"
    fi
    if $HOSTS_HAS_DHIRNA; then
      if $DRY_RUN; then
        echo "[dry-run] Clean Dhirna blocks from /etc/hosts"
      else
        TMP_HOSTS="$(mktemp)"
        awk '
          /^# Dhirna BEGIN$/ { skip=1; next }
          /^# Dhirna END$/ { skip=0; next }
          /^# Dhirna Shield SafeSearch BEGIN$/ { skip=1; next }
          /^# Dhirna Shield SafeSearch END$/ { skip=0; next }
          !skip { print }
        ' /etc/hosts > "$TMP_HOSTS"
        $ELEV cp "$TMP_HOSTS" /etc/hosts
        rm -f "$TMP_HOSTS"
      fi
    fi
    if $DNS_FILES_EXIST; then
      run_cmd $ELEV rm -f /etc/NetworkManager/conf.d/99-dhirna-shield.conf /etc/systemd/resolved.conf.d/99-dhirna-shield.conf
      if command -v systemctl >/dev/null 2>&1; then
        run_cmd $ELEV systemctl restart systemd-resolved 2>/dev/null || true
        run_cmd $ELEV systemctl reload NetworkManager 2>/dev/null || true
      fi
    fi
    echo "    /etc/hosts et DNS système restaurés."
  else
    echo "    Note : des règles Dhirna existent dans /etc/hosts ou DNS système."
    echo "    Relancez avec : bash scripts/kill.sh --restore-dns"
  fi
else
  echo "    Aucune règle résiduelle dans /etc/hosts ni dans les drop-ins DNS."
fi

echo "Dhirna arrêté proprement. Pour redémarrer sans blocage : dhirna-desktop --safe-mode"
