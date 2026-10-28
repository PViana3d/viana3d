#!/usr/bin/env bash
# Viana 3D — instalação no Raspberry Pi (Raspberry Pi OS Lite 64-bit).
# Uso:  curl -fsSL https://raw.githubusercontent.com/PViana3d/viana3d/main/pi/instalar.sh | sudo bash
# Opção: ... | sudo bash -s -- --sem-tailscale   (instala só para a rede local)
set -euo pipefail

DIR=/opt/viana3d
PACOTE_URL="${VIANA3D_PACOTE_URL:-https://github.com/PViana3d/viana3d/releases/download/pi-latest/viana3d-pi.zip}"
COM_TAILSCALE=1
for arg in "$@"; do [ "$arg" = "--sem-tailscale" ] && COM_TAILSCALE=0; done

esperar_servidor() {
  for _ in $(seq 1 60); do curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:8090/api/health 2>/dev/null && return 0; sleep 1; done
  echo "O servidor não respondeu. Veja: journalctl -u viana3d -n 50" >&2; return 1
}
titulo() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
[ "$(id -u)" -eq 0 ] || { echo "Corra com sudo (veja o README)."; exit 1; }
TTY=/dev/tty; { : < /dev/tty; } 2>/dev/null || TTY=/dev/stdin

titulo "1/6 Pacotes do sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl unzip ca-certificates unattended-upgrades python3 >/dev/null
# atualizações de segurança automáticas do sistema
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

titulo "2/6 Utilizador e pastas"
id viana3d >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin viana3d
mkdir -p "$DIR/pb_data"
chown viana3d:viana3d "$DIR/pb_data"; chmod 750 "$DIR/pb_data"

titulo "3/6 Serviço da aplicação"
cat > /etc/systemd/system/viana3d.service <<EOF
[Unit]
Description=Viana 3D (PocketBase)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=viana3d
Group=viana3d
WorkingDirectory=$DIR
ExecStart=$DIR/pocketbase serve --http=0.0.0.0:8090 --dir=$DIR/pb_data --publicDir=$DIR/app/pb_public --hooksDir=$DIR/app/pb_hooks --migrationsDir=$DIR/app/pb_migrations --automigrate=false --hooksWatch=false
Restart=always
RestartSec=5
LimitNOFILE=4096
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DIR/pb_data

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/viana3d-atualizar.service <<'EOF'
[Unit]
Description=Viana 3D — procurar versão nova da aplicação
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/viana3d-atualizar
EOF

cat > /etc/systemd/system/viana3d-atualizar.timer <<'EOF'
[Unit]
Description=Viana 3D — atualização diária

[Timer]
OnCalendar=*-*-* 04:30
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable viana3d.service viana3d-atualizar.timer >/dev/null

titulo "4/6 Aplicação e base de dados"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/pacote.zip" "$PACOTE_URL"
unzip -q -o "$tmp/pacote.zip" pi/atualizar.sh -d "$tmp"
install -m 755 "$tmp/pi/atualizar.sh" /usr/local/bin/viana3d-atualizar
VIANA3D_PACOTE_URL="$PACOTE_URL" /usr/local/bin/viana3d-atualizar --forcar
systemctl start viana3d-atualizar.timer

titulo "5/6 Conta de administração do servidor"
echo "Esta conta dá acesso ao painel técnico (cópias de segurança, recuperar palavras-passe)."
echo "É diferente da conta que vai usar na aplicação. Guarde-a num sítio seguro."
ADMINS="$(python3 -I -c "
import sqlite3, sys
try:
    c = sqlite3.connect('file:$DIR/pb_data/data.db?mode=ro', uri=True)
    print(c.execute(\"select count(*) from _superusers where email != '__pbinstaller@example.com'\").fetchone()[0])
except Exception:
    print(0)
")"
if [ "${ADMINS:-0}" -gt 0 ]; then
  echo "Já existe uma conta de administração; não foi alterada."
else
  systemctl stop viana3d   # a conta é criada com o servidor parado (evita conflitos na base de dados)
  while true; do
    read -r -p "Email do administrador: " ADM_EMAIL < "$TTY"
    read -r -s -p "Palavra-passe (mín. 10 caracteres): " ADM_PASS < "$TTY"; echo
    read -r -s -p "Repita a palavra-passe: " ADM_PASS2 < "$TTY"; echo
    if [ "${#ADM_PASS}" -lt 10 ]; then echo "Demasiado curta."; continue; fi
    if [ "$ADM_PASS" != "$ADM_PASS2" ]; then echo "As palavras-passe não coincidem."; continue; fi
    if sudo -u viana3d "$DIR/pocketbase" superuser upsert "$ADM_EMAIL" "$ADM_PASS" --dir="$DIR/pb_data" >/dev/null; then break; fi
    echo "Não foi possível criar a conta; tente de novo."
  done
  unset ADM_PASS ADM_PASS2
  systemctl start viana3d
  esperar_servidor
fi

ENDERECO=""
if [ "$COM_TAILSCALE" -eq 1 ]; then
  titulo "6/6 Acesso pela internet (Tailscale Funnel)"
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  if ! tailscale status >/dev/null 2>&1; then
    echo "Abra o link que vai aparecer no computador ou telemóvel e entre na sua conta Tailscale."
    tailscale up --hostname=viana3d
  fi
  echo "A ligar o acesso público. Se aparecer um link a pedir para ativar o Funnel, abra-o e confirme."
  tailscale funnel --bg 8090
  ENDERECO="https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')/"
else
  titulo "6/6 Acesso pela internet: ignorado (--sem-tailscale)"
fi

IP_LOCAL="$(hostname -I | awk '{print $1}')"
titulo "Concluído"
if [ -n "$ENDERECO" ]; then
  echo "Endereço da aplicação (use este no Windows e no Android):"
  printf '  \033[1m%s\033[0m\n' "$ENDERECO"
  echo "Painel técnico:  ${ENDERECO}_/"
fi
echo "Na rede local, sem internet:  http://${IP_LOCAL}:8090/"
echo
echo "Próximo passo: abra o endereço e crie a conta do dono (Configuração inicial)."
echo "Atualizações: automáticas todas as noites. Para atualizar já: sudo viana3d-atualizar"
