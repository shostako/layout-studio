#!/usr/bin/env bash
# 配るものを dist/ に作る。CI がこれを呼ぶ。作り方を変えるときはこのファイルか package.json の build を書き換える。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

rm -rf dist
npm run build
test -f dist/index.html || { echo "build: dist/index.html がない" >&2; exit 1; }
