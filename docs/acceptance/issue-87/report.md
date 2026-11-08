# Issue 87 acceptance — CATIA/Abaqus 桌面侧衔接（六期·43）

[iDeer-Desktop #87](https://github.com/Orbit-Crew/iDeer-Desktop/issues/87)
restores the desktop's own share of the CATIA/Abaqus seam: honest discovery
(software / plugin / license per component), one actionable hint per missing
piece, a live readiness announcement, and an authorized-boundary handler for
job-result facts. The external software loop itself stays out of scope here —
it belongs to [iDeer #124/#125](https://github.com/Orbit-Crew/iDeer/issues/124)
per the issue; nothing in this change launches software, spawns MCP servers,
or runs jobs. **全新实现而非受管复制**: the detection surface follows the
original `mcp/templates.ts` recipes (default server dirs, `catia_mcp` module
marker, `mcp_server.py` entry script, `detectPythonPath` order), the source
commit is pinned by reference in docs/porting.md, and no linz code was copied.

Execution date: 2026-11-08, Asia/Shanghai. Automated execution only.

## Candidate and environment

Desktop branch `feat/issue-87-catia-abaqus` from develop `9845dab`.
Windows 11 Pro 10.0.26300 x64; runtime pytest suite (see commands below);
all probes exercised against injected environments and temp-rooted
filesystems, so machine state never leaks into a verdict.

## What was delivered

- `local-runtime/core/engineering_probe.py`: the discovery service.
  Per-tool (`catia`, `abaqus`) and per-component (`software`, `plugin`,
  `python`, `license`) states of `present`/`missing`/`unknown`, each with
  evidence detail and, for anything not present, its own actionable hint —
  缺软件、缺插件、缺许可、缺 Python 分别有各自的提示句,never one generic
  error. A license with no visible signal answers `unknown` honestly (with
  a hint naming how to make it detectable) instead of pretending absence
  or readiness. Probes are plain filesystem-and-environment reads; the
  service accepts an injected env mapping so scans are hermetic.
- Capability announcements (`core/transport.py`): the probe capabilities
  (`local.catia.probe` / `local.abaqus.probe`) ride with the service; the
  readiness capabilities (`local.catia.ready` / `local.abaqus.ready`) are
  recomputed live from the filesystem on every announcement and refreshed
  in the same breath as a probe task that flipped them
  (`_republish_capabilities_if_changed`, shared with the MCP projection).
  Probe and result operations require a bound broker key — installation
  paths are local facts, not public ones.
- Authorized-boundary result flow: `local.catia.result` /
  `local.abaqus.result` register a job output **that already exists inside
  the authorized boundary** — resolution goes through the store's own
  guarded `_resolve` (new public seam `resolve_with_root` keeps the fact's
  `logical_root` and the boundary check on one resolution), refuses
  anything unprovable in-root (`OUTSIDE_ALLOWED_ROOTS`), missing
  (`NOT_FOUND`), or a directory (`NOT_A_FILE`), then records hash/size
  display metadata into the existing local-result registry. Bytes never
  move and never upload.
- Policy (`core/policy.py`): the four capabilities are LEVEL_0 — read-only
  over state the device already owns, like the file reads.
- Surfaces: the desktop tray runtime announces the discovery surface in
  desktop mode (`core/tray.py`), the headless `start-runtime` CLI does the
  same (`core/cli.py`); a runtime built without the service announces
  nothing about these tools.

## Scenario results

| Scenario | Assertion summary | Result |
| --- | --- | --- |
| T87-01 | Every missing component (software/plugin/python/license-unknown) carries its own non-empty hint; hints are pairwise distinct; license with no signal is `unknown`, not `missing` | passed (`test_engineering_probe.py`) |
| T87-02 | CATIA software found via `Program Files\Dassault Systemes\B31\win_b64` with the release in the detail; `CATINSTALLDIR` variant found with version parsed from the path | passed |
| T87-03 | CATIA plugin needs the server dir **and** the `catia_mcp` module; dir-without-module is missing with the module-specific hint | passed |
| T87-04 | CATIA license: `CATALICENCE_FILE` to an existing file → present; to a dangling path → missing; unset → unknown; DSLS license dir with content → present; empty dir stays unknown | passed |
| T87-05 | Abaqus software found via `ABAQUS_HOME` (code-dir evidence, year in detail) and via `SIMULIA\Commands\abaqus.bat` | passed |
| T87-06 | Abaqus plugin needs the server dir **and** `mcp_server.py`; license: `27000@server` → present, dangling file path → missing, unset → unknown | passed |
| T87-07 | Python: found on the injected PATH; absent PATH reported missing with hint | passed |
| T87-08 | Readiness gating: all four present → ready; one signal removed → not ready, `local.<tool>.ready` drops from the announcement while the probe capability stays | passed |
| T87-09 | Probe operation wire shape: tool/ready/components/hints, JSON-serializable; unknown probe operation refused | passed |
| T87-10 | Result registration inside the boundary records capability/logical_root/sha256/bytes into the registry and returns the fact; outside-boundary, missing, and directory paths refuse with `OUTSIDE_ALLOWED_ROOTS` / `NOT_FOUND` / `NOT_A_FILE` and record nothing | passed |
| T87-11 | Probe task round trip over the wire: TASK_RESULT carries the report and an allow receipt; probe capabilities announced by a runtime with the service; none announced without it | passed (`test_engineering_probe.py` transport section) |
| T87-12 | Readiness flip republishes capabilities: HELLO announces ready, license signal removed, probe task answered, CAPABILITY_UPDATE arrives after the ACK without `local.catia.ready` and with the probe capability | passed |
| T87-13 | Result task round trip: in-boundary registration completes with the fact and receipt; out-of-boundary path errors with `OUTSIDE_ALLOWED_ROOTS` | passed |
| T87-14 | Unpaired connection (no bound broker key) gets no probe answers: fixed denial, policy decision `deny` | passed |

## Acceptance grading (三层验收)

- 入口恢复（layer 1）：**passed by construction** — the surface rides the
  existing capability-announcement machinery (HELLO /
  `capability_update`), the same seam every other device capability uses;
  no new IPC channel, no dock entry.
- 业务接线（layer 2）：**passed by named tests** — T87-01…T87-14 above,
  all in `local-runtime/tests/test_engineering_probe.py`.
- 实际候选验收（layer 3）：**STAGED for the candidate package** — this
  issue's desktop share never touches real CATIA/Abaqus, so the only
  honest layer-3 run is the one where real installations, plugins and
  license servers exist on the machine; that belongs to the 六期候选包
  acceptance together with the external loop's iDeer #124/#125 work. The
  detection recipes were written so real machines can be probed with zero
  configuration (env vars optional).

## Known deviations (disclosed, none silent)

1. The desktop cannot prove a CATIA/Abaqus license without launching the
   software: with no visible signal (license file env, DSLS dir, FLEXnet
   env) the license answers **unknown** and the tool is **not** announced
   ready. Making readiness reachable is a hint away (set
   `CATALICENCE_FILE` / `ABAQUSLM_LICENSE_FILE`), never a guessed yes.
2. Detection evidence follows the original's own probes (env vars,
   default install/server paths, module markers). A valid install in a
   nonstandard location without env hints reports missing-software with
   the env-var hint — the same answer the original's template flow gave.
3. The plugin defaults keep the original's development-era paths
   (`E:\lijx\...`); new `IDEER_CATIA_MCP_DIR` / `IDEER_ABAQUS_MCP_DIR`
   overrides exist because hardcoding one developer's machine is not a
   product contract. The defaults are inherited from the original, not
   invented here.
4. Job results are registered as display facts only (hash/size/logical
   path); physical upload stays behind the existing explicit upload
   command, exactly like workspace-write facts. The actual job execution
   and its result files are produced by the external loop (iDeer
   #124/#125), not by this desktop change.

## Executed commands

| Command | Result |
| --- | --- |
| `python -m pytest tests/test_engineering_probe.py -q` | 22 passed |
| `python -m pytest tests -q` (full runtime suite) | see the PR description for the final count recorded at execution time |
| `python -m ruff check core/engineering_probe.py core/transport.py core/policy.py core/files.py core/cli.py core/tray.py core/__init__.py tests/test_engineering_probe.py` | All checks passed |
