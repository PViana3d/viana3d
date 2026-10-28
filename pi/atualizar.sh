#!/usr/bin/env bash
# Viana 3D — atualiza a aplicação no Raspberry Pi (e o PocketBase, quando muda de versão).
# Uso: sudo viana3d-atualizar            (só atualiza se houver versão nova)
#      sudo viana3d-atualizar --forcar   (reinstala a versão mais recente)
set -euo pipefail

DIR=/opt/viana3d
PACOTE_URL="${VIANA3D_PACOTE_URL:-https://github.com/PViana3d/viana3d/releases/download/pi-latest/viana3d-pi.zip}"
FORCAR="${1:-}"

[ "$(id -u)" -eq 0 ] || { echo "Corra com sudo: sudo viana3d-atualizar"; exit 1; }

arquitetura() {
  case "$(uname -m)" in
    aarch64|arm64) echo linux_arm64 ;;
    armv7l|armv6l) echo linux_armv7 ;;
    x86_64|amd64)  echo linux_amd64 ;;
    *) echo "Arquitetura não suportada: $(uname -m)" >&2; exit 1 ;;
  esac
}

instalar_pocketbase() {   # $1 = versão, $2 = pasta temporária
  local v="$1" t="$2" a base zip soma
  a="$(arquitetura)"
  base="https://github.com/pocketbase/pocketbase/releases/download/v${v}"
  zip="pocketbase_${v}_${a}.zip"
  echo "A instalar o PocketBase ${v} (${a})…"
  curl -fsSL --retry 3 -o "$t/$zip" "$base/$zip"
  curl -fsSL --retry 3 -o "$t/checksums.txt" "$base/checksums.txt"
  soma="$(grep " ${zip}\$" "$t/checksums.txt" | awk '{print $1}')"
  [ -n "$soma" ] || { echo "Não encontrei a soma de verificação de ${zip}." >&2; exit 1; }
  echo "${soma}  $t/$zip" | sha256sum -c --quiet - || { echo "O ficheiro do PocketBase não passou na verificação." >&2; exit 1; }
  mkdir -p "$t/pb" && unzip -oq "$t/$zip" pocketbase -d "$t/pb"
  [ -f "$DIR/pocketbase" ] && cp -f "$DIR/pocketbase" "$DIR/pocketbase.anterior"
  install -m 755 -o root -g root "$t/pb/pocketbase" "$DIR/pocketbase"
}

esperar_servidor() {
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:8090/api/health 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/pacote.zip" "$PACOTE_URL"
novo="$(sha256sum "$tmp/pacote.zip" | awk '{print $1}')"
atual="$(cat "$DIR/.pacote-sha256" 2>/dev/null || true)"
if [ "$novo" = "$atual" ] && [ "$FORCAR" != "--forcar" ]; then
  echo "A aplicação já está atualizada (versão $(cat "$DIR/app/BUILD" 2>/dev/null || echo '?'))."
  exit 0
fi

unzip -q "$tmp/pacote.zip" -d "$tmp/app"
[ -f "$tmp/app/pb_public/index.html" ] && [ -f "$tmp/app/pi/PB_VERSION" ] || { echo "Pacote inválido." >&2; exit 1; }

quer="$(tr -d '[:space:]' < "$tmp/app/pi/PB_VERSION")"
tem="$("$DIR/pocketbase" --version 2>/dev/null | awk '{print $3}' || true)"
if [ "$quer" != "$tem" ]; then instalar_pocketbase "$quer" "$tmp"; fi

rm -rf "$DIR/app.anterior"
[ -d "$DIR/app" ] && mv "$DIR/app" "$DIR/app.anterior"
mv "$tmp/app" "$DIR/app"
chown -R root:root "$DIR/app"; chmod -R a+rX "$DIR/app"
install -m 755 "$DIR/app/pi/atualizar.sh" /usr/local/bin/viana3d-atualizar

systemctl restart viana3d
if esperar_servidor; then
  echo "$novo" > "$DIR/.pacote-sha256"
  echo "Aplicação atualizada para a versão $(cat "$DIR/app/BUILD")."
else
  echo "O servidor não arrancou com a versão nova; a voltar à anterior." >&2
  journalctl -u viana3d -n 20 --no-pager >&2 || true
  if [ -d "$DIR/app.anterior" ]; then rm -rf "$DIR/app"; mv "$DIR/app.anterior" "$DIR/app"; fi
  [ -f "$DIR/pocketbase.anterior" ] && [ "$quer" != "$tem" ] && cp -f "$DIR/pocketbase.anterior" "$DIR/pocketbase"
  systemctl restart viana3d
  exit 1
fi
