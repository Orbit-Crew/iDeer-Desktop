#!/usr/bin/env bash
set -euo pipefail
cd /home/neowyh/.codex-worktrees/ideer-acceptance111-15aa-20261026
unset TEST_PNPM_BIN
export PATH="/tmp/ideer111-tools-15aa:/home/neowyh/.local/bin:$PATH"
export UV_CACHE_DIR=/tmp/deer-flow-uv-cache
export PYTHON=/home/neowyh/.codex-worktrees/ideer-acceptance111-15aa-20261026/backend/.venv/bin/python
export TEST_LANE_ARTIFACT_DIR=/tmp/ideer111-lanes-fixed-15aa
export CI=1
export PLAYWRIGHT_HTML_OPEN=never
export PLAYWRIGHT_BASE_URL=http://127.0.0.1:13111
export PORT=13111
exec bash scripts/run-test-lane.sh core-full
