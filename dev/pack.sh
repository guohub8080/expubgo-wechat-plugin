#!/usr/bin/env bash
# Pack the extension source (repo root) into dist/expubgo-wechat-plugin-v<version>.zip
# for store upload. The file list is explicit on purpose — a wildcard zip would
# sweep in AGENTS.md / dev (pack.sh, icon.svg, render-icon.html) / dist / .mimosa,
# none of which belong in the package.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
if [ -z "$VERSION" ]; then
  echo "[pack] cannot read version from manifest.json" >&2
  exit 1
fi
OUT="dist/expubgo-wechat-plugin-v${VERSION}.zip"

mkdir -p dist
rm -f "$OUT"
zip -r "$OUT" manifest.json _locales/zh_CN/messages.json _locales/en/messages.json background.js content-expubgo.js content-wechat.js page-bridge.js icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png > /dev/null
echo "[pack] wrote $OUT"
unzip -l "$OUT"
