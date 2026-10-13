#!/usr/bin/env bash
# PR ごとの検査。.github/workflows/ci.yml の ci ジョブがこれを呼ぶ。
# 検査を増やすときはこのファイルか package.json のスクリプトを書き換える。ワークフローの YAML は触らない。
# ブラウザを使うテスト（Playwright など）は、ここでブラウザを入れてから走らせる。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f package-lock.json ]; then npm ci; else npm install; fi
npm run typecheck
npm test
bash scripts/build.sh
# 手元で動く MCP サーバー（mcp/）を作り、起動して受け答えを確かめる
npm run build:mcp
node scripts/mcp-smoke.mjs
echo "ci: ok"
