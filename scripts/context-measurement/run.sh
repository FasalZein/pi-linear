#!/usr/bin/env bash
# AEO-831 context measurement runner.
#
# Deterministic offline replay of one fixed task set on three tool-exposure arms.
# No model runs and no Linear request leaves the machine.
#
# Requirements (measurement only; not runtime dependencies of the extension):
#   - installed dev dependencies, for `node_modules/.bin/vite-node`
#   - a Python 3 interpreter with `tiktoken==0.12.0`, selected with AEO831_PYTHON
#
# Environment overrides:
#   AEO831_BEFORE_REV  git revision measured as "before" (default: frozen v0.9 commit)
#   AEO831_PYTHON      python interpreter that has tiktoken (default: python3)
#   AEO831_WORK_DIR    directory for the large intermediate dumps (default: a temp dir)
#   AEO831_OUT_JSON    results file (default: docs/v10-context-measurement-results.json)
#   AEO831_OUT_MD      evidence file (default: docs/v10-context-measurement-evidence.md)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
BASELINE="$REPO/scripts/fixtures/context-baseline-v0.9.json"
BEFORE_REV="${AEO831_BEFORE_REV:-$("${AEO831_PYTHON:-python3}" -c 'import json,sys;print(json.load(open(sys.argv[1]))["beforeRev"])' "$BASELINE")}"
PYTHON="${AEO831_PYTHON:-python3}"
OUT_JSON="${AEO831_OUT_JSON:-$REPO/docs/v10-context-measurement-results.json}"
OUT_MD="${AEO831_OUT_MD:-$REPO/docs/v10-context-measurement-evidence.md}"
VITE_NODE="$REPO/node_modules/.bin/vite-node"

if [[ -n "$(git -C "$REPO" status --short --untracked-files=no)" ]]; then
  echo "Working tree has tracked changes; refusing a non-reproducible measurement." >&2
  exit 2
fi
if [[ ! -x "$VITE_NODE" ]]; then
  echo "Missing $VITE_NODE. Install dev dependencies first." >&2
  exit 2
fi
if ! "$PYTHON" -c 'import tiktoken' 2>/dev/null; then
  echo "Python interpreter '$PYTHON' has no tiktoken. Install tiktoken==0.12.0 or set AEO831_PYTHON." >&2
  exit 2
fi

WORK="${AEO831_WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/aeo831.XXXXXX")}"
mkdir -p "$WORK"
BEFORE_SOURCE="$WORK/before-source"
CURRENT_COMMIT="$(git -C "$REPO" rev-parse HEAD)"
BEFORE_COMMIT="$(git -C "$REPO" rev-parse "$BEFORE_REV")"

rm -rf "$BEFORE_SOURCE"
mkdir -p "$BEFORE_SOURCE"
git -C "$REPO" archive "$BEFORE_COMMIT" | tar -x -C "$BEFORE_SOURCE"
ln -s "$REPO/node_modules" "$BEFORE_SOURCE/node_modules"

AEO831_SOURCE_COMMIT="$CURRENT_COMMIT" "$VITE_NODE" --root "$REPO" "$HERE/measure.mts" \
  --repo "$REPO" --out "$WORK/current-dump.json" --label current
AEO831_SOURCE_COMMIT="$BEFORE_COMMIT" "$VITE_NODE" --root "$BEFORE_SOURCE" "$HERE/measure.mts" \
  --repo "$BEFORE_SOURCE" --out "$WORK/before-dump.json" --label before

"$PYTHON" "$HERE/tokenize-and-report.py" \
  --before "$WORK/before-dump.json" \
  --current "$WORK/current-dump.json" \
  --baseline "$BASELINE" \
  --out-json "$OUT_JSON" \
  --out-md "$OUT_MD"

"$PYTHON" "$HERE/verify-results.py" "$OUT_JSON"
echo "Intermediate dumps: $WORK"
