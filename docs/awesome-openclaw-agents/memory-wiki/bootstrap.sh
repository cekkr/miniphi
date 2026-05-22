#!/usr/bin/env bash
# bootstrap.sh — copy a memory-wiki template to a target dir and fill basics.
#
# Usage:
#   ./bootstrap.sh ~/memory-wiki                 # solo-founder (default)
#   ./bootstrap.sh ~/memory-wiki --engineer      # engineer variant
#
# After running, edit the files by hand. This script only fills the obvious
# blanks (name, handle, main project). Everything else is your job.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <target-dir> [--engineer]" >&2
  exit 1
fi

TARGET="$1"
VARIANT="solo-founder-wiki"
if [[ "${2:-}" == "--engineer" ]]; then
  VARIANT="engineer-wiki"
fi

SRC="$SCRIPT_DIR/templates/$VARIANT"
if [[ ! -d "$SRC" ]]; then
  echo "error: template not found at $SRC" >&2
  exit 1
fi

if [[ -e "$TARGET" ]]; then
  echo "error: $TARGET already exists. Refusing to overwrite." >&2
  exit 1
fi

echo "Copying $VARIANT template to $TARGET ..."
mkdir -p "$TARGET"
cp -R "$SRC"/* "$TARGET"/

echo ""
echo "A few quick questions. Press Enter to skip any."
read -r -p "  Your name:          " NAME
read -r -p "  Your handle:        " HANDLE
read -r -p "  Main project name:  " MAIN_PROJECT

# Portable sed -i (works on macOS and Linux)
sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

for f in "$TARGET"/*.md; do
  [[ -n "${NAME:-}" ]]         && sed_inplace "s|{{NAME}}|${NAME}|g" "$f"
  [[ -n "${HANDLE:-}" ]]       && sed_inplace "s|{{HANDLE}}|${HANDLE}|g" "$f"
  [[ -n "${MAIN_PROJECT:-}" ]] && sed_inplace "s|{{MAIN_PROJECT}}|${MAIN_PROJECT}|g" "$f"
done

echo ""
echo "Done. Wiki created at $TARGET"
echo ""
echo "Next steps:"
echo "  1. Open $TARGET and edit anything that's still a placeholder."
echo "  2. Reference it from your OpenClaw agent's SOUL.md:"
echo ""
echo "       ## Memory Wiki"
echo "       At session start, read $TARGET/PROFILE.md, STACK.md,"
echo "       PROJECTS.md, DECISIONS.md, PEOPLE.md, WORKING.md in that order."
echo "       Only WORKING.md is writable."
echo ""
echo "  3. Optionally copy it into your agent dir:"
echo "       cp -r $TARGET ~/.openclaw/agents/<agent-name>/memory-wiki"
echo ""
echo "  4. Review weekly. Rebuild quarterly."
