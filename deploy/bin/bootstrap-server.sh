#!/usr/bin/env bash
# Run ONCE on a fresh Ubuntu server, as root, AFTER you can log in with an SSH key (it refuses to disable passwords otherwise).
# Firewall (22, 80, 443 only), brute-force protection, automatic security updates, key-only SSH. Docker is installed separately (README).
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run as root" >&2; exit 1; }
KEYS="/root/.ssh/authorized_keys"
[ -n "${SUDO_USER:-}" ] && [ -s "/home/${SUDO_USER}/.ssh/authorized_keys" ] && KEYS="/home/${SUDO_USER}/.ssh/authorized_keys"
if [ ! -s "$KEYS" ]; then
  echo "No SSH key found in $KEYS. Add your public key first, test a key login in ANOTHER terminal, then run this again. Nothing was changed." >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ufw fail2ban unattended-upgrades
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
cat > /etc/ssh/sshd_config.d/99-wendy.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t && systemctl reload ssh
systemctl enable --now fail2ban
echo "Done. Test a NEW ssh login before closing this session."
