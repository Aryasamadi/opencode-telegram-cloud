#!/usr/bin/env bash
set -euo pipefail

node scripts/state.mjs save

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add .state/agent-state.v1.enc
if [[ -f .state/agent-state.previous.enc ]]; then
  git add .state/agent-state.previous.enc
fi

if git diff --cached --quiet; then
  echo "Checkpoint is unchanged; no commit is needed."
  exit 0
fi

git fetch origin main
git rebase --autostash origin/main
git add .state/agent-state.v1.enc
if [[ -f .state/agent-state.previous.enc ]]; then
  git add .state/agent-state.previous.enc
fi

if git diff --cached --quiet; then
  echo "Checkpoint already matches the latest main branch."
  exit 0
fi

git commit -m "chore(state): update encrypted OpenCode checkpoint"
git push origin HEAD:main
echo "Encrypted checkpoint committed to main."
