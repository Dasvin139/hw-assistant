#!/usr/bin/env bash
# Creates a sudoers rule that lets ONE user run ONE command with ONE exact argument list
# as root, without a password. Nothing else gains privileges.
#
#   ./scripts/install-sudoers.sh            # dry run: prints the rule
#   sudo ./scripts/install-sudoers.sh --apply   # installs /etc/sudoers.d/hw-assistant
set -euo pipefail

USER_NAME="${SUDO_USER:-$(id -un)}"
DMIDECODE="$(command -v dmidecode || true)"
[[ -n "$DMIDECODE" ]] || { echo "dmidecode is not installed (e.g. sudo apt install dmidecode)"; exit 1; }

RULE="${USER_NAME} ALL=(root) NOPASSWD: ${DMIDECODE} -t memory"
echo "Rule: ${RULE}"

if [[ "${1:-}" != "--apply" ]]; then
  echo "Dry run. Re-run with: sudo $0 --apply"
  exit 0
fi

TMP="$(mktemp)"
echo "$RULE" > "$TMP"
visudo -cf "$TMP"                      # refuse to install a rule that does not parse
install -m 0440 -o root -g root "$TMP" /etc/sudoers.d/hw-assistant
rm -f "$TMP"
echo "Installed /etc/sudoers.d/hw-assistant"
