#!/usr/bin/env bash
# Install the htmlz CLI + agent skill from a running htmlz server.
#
#   curl -fsSL http://YOUR-HTMLZ-SERVER/install.sh | bash
#
# Detects Claude Code (~/.claude/) and Codex (~/.codex/) and installs into
# whichever it finds. Idempotent — re-run to refresh.
#
# BASE is templated by the server at request time using the scheme + host the
# caller hit, so the same script works from any DNS name or IP that points at
# the htmlz instance. We also persist BASE into ~/.config/htmlz/config.json
# so the CLI auto-points at the server you installed from.

set -euo pipefail

BASE="${HTMLZ_BASE:-{{BASE}}}"
SKILL_NAME="htmlz"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${HTMLZ_CONFIG_DIR:-$HOME/.config/htmlz}"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }

command -v curl >/dev/null 2>&1 || { red "missing: curl"; exit 1; }

targets=()
[ -d "$HOME/.claude" ] && targets+=("$HOME/.claude/skills")
[ -d "$HOME/.codex" ]  && targets+=("$HOME/.codex/skills")

if [ ${#targets[@]} -eq 0 ]; then
  red "No agent found. Install Claude Code or Codex first."
  red "  Looked for ~/.claude/ and ~/.codex/"
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

dim "Fetching skill from $BASE …"
curl -fsSL "$BASE/_skill/SKILL.md" -o "$tmp/SKILL.md"
curl -fsSL "$BASE/_skill/htmlz"    -o "$tmp/htmlz"
chmod +x "$tmp/htmlz"

canonical=""
for skills_dir in "${targets[@]}"; do
  mkdir -p "$skills_dir"
  dest="$skills_dir/$SKILL_NAME"
  if [ -L "$dest" ]; then
    dim "↷ skipping $dest (symlink — dev install from repo)"
    [ -z "$canonical" ] && canonical="$dest/htmlz"
    continue
  fi
  mkdir -p "$dest"
  cp "$tmp/SKILL.md" "$dest/SKILL.md"
  cp "$tmp/htmlz"    "$dest/htmlz"
  chmod +x "$dest/htmlz"
  green "✓ installed → $dest"
  [ -z "$canonical" ] && canonical="$dest/htmlz"
done

mkdir -p "$BIN_DIR"
ln -sfn "$canonical" "$BIN_DIR/htmlz"
green "✓ linked    → $BIN_DIR/htmlz"

# Persist BASE so the CLI doesn't need HTMLZ_BASE on every invocation.
mkdir -p "$CONFIG_DIR"
printf '{"base": "%s"}\n' "$BASE" > "$CONFIG_DIR/config.json"
green "✓ wrote     → $CONFIG_DIR/config.json (base=$BASE)"

printf "\n"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  red "  $BIN_DIR is not on PATH. Add to your shell profile:"
  printf "    export PATH=\"\$HOME/.local/bin:\$PATH\"\n\n"
fi

if ! command -v jq >/dev/null 2>&1; then
  red "  jq is required by the CLI:"
  printf "    brew install jq            # macOS\n"
  printf "    apt install -y jq          # Debian/Ubuntu\n"
  printf "    dnf install -y jq          # Fedora/RHEL\n\n"
fi

dim "Next: tell the skill who you are (asked once on first comment)"
printf "    htmlz identity <your-name>\n"
