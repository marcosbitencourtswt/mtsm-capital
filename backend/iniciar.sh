#!/usr/bin/env bash
# Sobe o PostgreSQL e a API. Para parar: Ctrl+C.
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
sudo service postgresql start
npm run dev
