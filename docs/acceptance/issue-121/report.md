---
id: issue-121-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 121 Desktop side of unified Skill trigger preferences — the pinned preference IPC channel, the relaying runtime wire, and the configuration surface; matching stays Server-side by construction
last-verified: 2026-10-27
verified-against: orch/issue-121-skill-trigger working tree on top of 7d9e5a5 (#120 candidate); every acceptance command below was run against the tree exactly as committed
---

# Issue 121 Desktop acceptance

The Desktop candidate lives in the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop` (WSL:
`/mnt/g/code/iDeer-worktrees/issue-112-desktop`), branch
`orch/issue-121-skill-trigger`, stacked on 7d9e5a5 (#120). The Server repo
carries the same branch on top of 7422b14c; its companion report is
`docs/acceptance/issue-121/report.md` in that repository. No issue closure,
no PR, and no `dist:win` installer are claimed by this report — packaging
stays a recorded-pending step (see Pending).

## Implemented surface

- `src/shared/desktop.ts`: `SkillTriggerPreferenceView`,
  `SkillPreferencesView`, `SkillPreferenceCommand` (`list` / `set` /
  `clear`), and the `DesktopBridge.skillPreferences` declaration. The `set`
  document carries exactly the Server's fields (enabled, keywords,
  alwaysInject, applicableAgentIds, priority) — nothing more is configurable
  from the device, and nothing matching-related is decided there.
- `src/preload/index.ts` + `src/main/index.ts`: the new pinned IPC channel
  `desktop:skill-preferences` (pinned in `test/security.test.ts` alongside
  every other channel). The main-process handler enforces the trusted
  main-frame sender check and authentication before anything is relayed.
- `src/main/runtime.ts`: `skillPreferences(command)` validates the command
  against the fixed bounds (skill UUID; ≤16 keywords of ≤64 chars; ≤32 agent
  UUIDs; integer priority −1000..1000; exact key sets per action) before the
  owned Runtime, one in-flight request, 30 s timeout, and the response
  handler re-validates the Server's projection into the bounded view (≤200
  rows, per-row field bounds, UUID-filtered ids). No keyword evaluation and
  no model driving exist anywhere in the Desktop — the command only travels
  renderer → main → owned Runtime → Server endpoints.
- `local-runtime/core/desktop.py`: the `skill-preferences` wire type with the
  strict shape validation per action and its own bounded queue; only fixed
  categories (`CHAT_*`, `SKILL_PREFERENCE_*`) cross the Desktop boundary.
- `local-runtime/core/platform_chat.py`: `skill_preferences(command)` relays
  to `GET /api/resources/skill-trigger-preferences`, `PUT
  /api/resources/{id}/trigger-preference`, `DELETE
  /api/resources/{id}/trigger-preference` (new `_empty` helper for body-less
  writes that requires the expected 204; `_request` gained an explicit
  `method`), and projects the Server's own list into the Desktop display
  shape — every field validated/bounded, anything the Server did not state is
  dropped rather than invented. Authority is the Server's: visibility,
  published availability, and the dependency closure are re-validated there
  at Run preparation on every match.
- `src/renderer/src/components/SkillSection.tsx`: the 触发偏好（Server 端匹配）
  surface — per-Skill enable switch, keywords input (comma separated, empty
  means always-inject per the preserved rule), always-inject checkbox,
  applicable-Agent input (comma separated UUIDs, empty means all Agents),
  priority input (−1000..1000), save/clear buttons, honest 可用/不可用
  availability from the Server projection, and fixed-category error alerts.
  The API is injectable (`onPreferences`) for static-render tests.
- Tests: `test/security.test.ts` pins the new channel;
  `test/skills.test.tsx` adds the command-boundary validation suite (22
  malformed-command shapes, RUNTIME_UNAVAILABLE for well-formed ones — the
  Desktop owns no matching code) and the rendered preference surface
  assertions; `local-runtime/tests/test_skill_preferences.py` (new) drives
  the real `DesktopChat` seam against a protocol fixture: list projection,
  set relay (snake_case wire fields), clear, fixed-category server rejection
  mapping (404 → `CHAT_NOT_FOUND`, wrong status → `CHAT_PROTOCOL_ERROR`),
  pre-wire refusal of invalid commands, and unauthenticated refusal.

## Commands and results

Environment: Windows 10.0.26300 x64 host, Node v22.14.0 (pinned toolchain),
Python 3.12 (miniconda) in WSL Ubuntu for the local-runtime suite. All
commands run 2026-10-27 against the working tree at this candidate.

| Suite | Result |
| --- | --- |
| `npm.cmd run typecheck` | exit 0 (no errors) |
| `npx.cmd vitest run test/security.test.ts test/skills.test.tsx` | 2 files / 6 tests passed (first run red: the `set` key-count bound was 6 instead of 7; fixed, then green) |
| `npx.cmd vitest run` (full) | 27 files / 124 tests passed. One bundled-runtime contention flake in the first full pass (the documented rerun-once trap; it coincided with the parallel local-runtime run); the immediate rerun was fully green: 27 files / 124 tests |
| `$HOME/miniconda3/bin/python -m pytest tests -q` (local-runtime, WSL) | 477 passed, 11 skipped, exit 0 — the recorded #120-tip baseline is 471/11; the exact delta is the 6 new `test_skill_preferences.py` tests |

## Scenario records (T121-01..04, Desktop legs)

| Scenario | Ticket ACs | Automated evidence (passed) | Staged / unexecuted remainder |
| --- | --- | --- | --- |
| T121-01 (Desktop 配置明确选择/关键词/空关键词始终注入/适用 Agent/优先级/启用) | 1, 4 | `test/skills.test.tsx` `renders the preference surface…` — the configuration surface exposes exactly 启用/关键词/始终注入/适用 Agent/优先级 per Skill with the Server's availability, and no local matching controls; `validates the preference command…` — every configuration command is validated before the owned Runtime and can only travel onward (`RUNTIME_UNAVAILABLE` without it); `local-runtime/tests/test_skill_preferences.py` pins the relay to the Server endpoints. The Server match/inject leg: companion report T121-01. | Real UI session driving a real Server match: **unexecuted**, staged on credentials. |
| T121-02 (手动选择/触发的拒绝场景，设备侧) | 2, 4 | `test_invalid_commands_are_refused_before_any_wire_traffic` + `test_server_rejections_map_to_fixed_categories` — invalid shapes never leave the process; the Server's rejections surface as fixed categories, never partial success. The authority matrix itself: companion report T121-02. | Real rejection matrix through the live UI: **unexecuted**, staged. |
| T121-03 (偏好不越权，A/B 隔离) | 1, 3 | The Desktop grants nothing by construction: the preference surface has no content editing and no execution affordances, and `security.test.ts` keeps the shipped graph free of any model/MCP/terminal dependency. The two-account Server leg: companion report T121-03. | Real A/B account pass through the UI: **unexecuted**, staged. |
| T121-04 (进行中 Run 不漂移，设备侧观察) | 3, 4 | The Desktop observes Runs through the existing chat surface only; the frozen-version guarantee is the Server's (companion report T121-04). Device-side regression coverage: full vitest + local-runtime suites green (above). | Real cross-repo Run observation: **unexecuted**, staged with the real-model Run environment. |

## Pending / risks

- `npm.cmd run dist:win` and the install/start/exit verification: **not run**
  — recorded pending, per the ticket's staging rules; this candidate claims
  no installer.
- Real Win7: **unexecuted**, owned by
  [#131](https://github.com/Orbit-Crew/iDeer/issues/131); modern-Windows
  results are not Win7 results.
- The preference UI intentionally shows skills the Server lists for the
  account (including ones whose availability flipped) so stale preferences
  remain visible and clearable; no content is displayed.
- `dev-log/` remains an untracked local working directory (ticket copy at
  `dev-log/ticket-121.md`), exactly as at baseline.

Execution update, 2026-10-29: the prepared driver ran end-to-end (r39,
settled after the driver-hardening series). T121-01/03/04 passed with the
real model and the frozen-identity injection asserted from the archived
selection snapshots and the applied/skipped audits; T121-02 passed its
rejection matrix, closure and delete legs and stages only the
visibility-reduction dependency. The projection-refresh re-mount race and
the provider-latency legs are recorded verbatim. Bindings and sanitized
evidence are in [installed-20261029.md](installed-20261029.md). Win7
remains with #131.
