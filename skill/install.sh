#!/usr/bin/env bash
# Install the htmlz CLI + agent skill from a local checkout (dev install).
#
# Symlinks (so `git pull` in this repo updates everyone):
#   skill/htmlz  →  ~/.local/bin/htmlz
#   skill/       →  ~/.claude/skills/htmlz/
#                →  ~/.codex/skills/htmlz/   (if ~/.codex exists)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$ROOT/skill"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

mkdir -p "$BIN_DIR"

ln -sfn "$SKILL_DIR/htmlz" "$BIN_DIR/htmlz"
printf "✓ %s -> %s\n" "$BIN_DIR/htmlz" "$SKILL_DIR/htmlz"

for skills_dir in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  parent=$(dirname "$skills_dir")
  if [ -d "$parent" ]; then
    mkdir -p "$skills_dir"
    ln -sfn "$SKILL_DIR" "$skills_dir/htmlz"
    printf "✓ %s -> %s\n" "$skills_dir/htmlz" "$SKILL_DIR"
  fi
done

warn=0
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn=1
  printf "\n! %s is not on PATH. Add to your shell profile:\n" "$BIN_DIR"
  printf "    export PATH=\"\$HOME/.local/bin:\$PATH\"\n"
fi

if ! command -v jq >/dev/null 2>&1; then
  warn=1
  printf "\n! jq is not installed:\n"
  printf "    brew install jq            # macOS\n"
  printf "    apt install -y jq          # Debian/Ubuntu\n"
  printf "    dnf install -y jq          # Fedora/RHEL\n"
fi

[ "$warn" = "0" ] && printf "\nTry: htmlz --help\n"
