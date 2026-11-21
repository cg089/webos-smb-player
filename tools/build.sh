#!/usr/bin/env bash
# Baut die IPK nach dist/. Braucht Node.js und die webOS-CLI (ares-package):
#   npm install -g @webos-tools/cli
# Ohne globale Installation wird npx verwendet.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v ares-package >/dev/null 2>&1; then
  ARES=(ares-package)
elif command -v npx >/dev/null 2>&1; then
  ARES=(npx --yes -p @webos-tools/cli ares-package)
else
  echo "Weder ares-package noch npx gefunden. Bitte Node.js installieren: https://nodejs.org" >&2
  exit 1
fi

mkdir -p dist
rm -f dist/*.ipk
"${ARES[@]}" --check app service
# -n: JavaScript nicht minifizieren (bleibt lesbar und auf dem TV debugbar)
"${ARES[@]}" -n app service -o dist
ls -la dist/*.ipk
