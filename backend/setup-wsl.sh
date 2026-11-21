#!/usr/bin/env bash
# Instalação do NOFINANCE no WSL (Ubuntu). Pergunta antes de instalar qualquer coisa.
# Uso: bash setup-wsl.sh
set -euo pipefail
cd "$(dirname "$0")"
echo "=== NOFINANCE: instalação no WSL ==="

ask() { read -rp "$1 [s/N] " r; [[ "$r" =~ ^[sS] ]]; }

# 1. Node 22+ (do próprio WSL, não o do Windows em /mnt/c)
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node_ok() { command -v node >/dev/null && [[ "$(command -v node)" != /mnt/* ]] && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
if ! node_ok; then
  ask "Node 22+ não encontrado no WSL. Instalar via nvm?" || { echo "Cancelado."; exit 1; }
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  . "$NVM_DIR/nvm.sh"; nvm install 22; nvm alias default 22
fi
echo "Node: $(node -v)"

# 2. PostgreSQL no WSL
if ! command -v pg_dump >/dev/null || ! ls /etc/postgresql >/dev/null 2>&1; then
  ask "PostgreSQL não encontrado no WSL. Instalar (apt)?" || { echo "Cancelado."; exit 1; }
  sudo apt-get update && sudo apt-get install -y postgresql
fi
sudo service postgresql start

# 3. Senha local do postgres + .env
if [ ! -f .env ]; then
  read -rsp "Defina uma senha para o usuário postgres (local): " PW; echo
  [ -n "$PW" ] || { echo "Senha vazia."; exit 1; }
  echo "ALTER USER postgres PASSWORD :'pw';" | sudo -u postgres psql -q -v pw="$PW"
  ENC=$(PW="$PW" node -p 'encodeURIComponent(process.env.PW)')
  sed "s|postgres@127.0.0.1|postgres:${ENC}@127.0.0.1|g" .env.example > .env
  chmod 600 .env
  echo ".env criado."
fi

# 4. Dependências, banco, testes
npm install --no-audit --no-fund
npm run migrate
npm test
echo
echo "Pronto. Para usar: bash iniciar.sh"
echo "Teste no navegador do Windows: http://localhost:3333/api/v1/personal/dashboard"
