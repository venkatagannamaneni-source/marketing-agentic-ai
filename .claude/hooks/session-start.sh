#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install project dependencies with Bun
if command -v bun &> /dev/null; then
  bun install
else
  npm install
fi

# Install Playwright browsers (chromium only for speed)
npx playwright install chromium 2>/dev/null || true
