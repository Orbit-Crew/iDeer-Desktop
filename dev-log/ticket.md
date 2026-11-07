# Ticket: Issue #92 [二期·12] 项目文件夹绑定（项目+设备）

## Session facts (read first)

- Work tree: `G:/code/iDeer-worktrees/issue-92-project-folder-binding`, branch `feat/issue-92-project-folder-binding`, base `794ca43` (= origin/develop).
- You work ONLY inside this work tree. NEVER touch `G:/code/iDeer-Desktop` (main workspace), never push to any remote, never `git stash`, never merge/rebase.
- Node: prepend `G:/code/iDeer-Desktop/.cache/node-dist/node-v22.23.4-win-x64` to PATH for every shell that runs node/npm. Repo npm scripts self-initialize the project env.
- Python: use the worktree's `.venv/Scripts/python.exe`. Any pytest run that imports `core.*` MUST set `PYTHONPATH=G:/code/iDeer-worktrees/issue-92-project-folder-binding/local-runtime` so the worktree source is tested, never site-packages.
- After ANY change under `local-runtime/core`: re-run `npm run runtime:prepare` BEFORE running live bridge tests (`test/*-bridge*.test.ts` live cases spawn `.runtime/python.exe`).
- Mechanical-sync trap: `scripts/verify-runtime-source.py` pins files listed in `resources/provenance/runtime-source.json` (`files`) against upstream blobs; if you modify a listed file that is not yet under `modified`, add it to `modified` (migration record) and re-run the script until it passes.
- Forbidden: creating PRs, commenting on GitHub issues, changing issue state, editing `docs/agents/issue-tracker.md`.

## Full issue text (Orbit-Crew/iDeer-Desktop#92)

> ## Parent
>
> [linz 全量能力等价：iDeer Desktop 总规格](https://github.com/Orbit-Crew/iDeer-Desktop/issues/70)（二期：项目与文件）
>
> ## What to build
>
> 项目文件夹绑定：每个项目在每台电脑上可绑定一个本机工作文件夹（可选配件、随时补绑/解绑），绑定按"项目+设备"记录；项目详情展示"已绑路径/未绑定"及设备归属；受控终端与文件工具以此为起始/边界输入。
>
> ## Acceptance criteria
>
> - [x] 绑定/解绑可用，按项目+设备隔离记录 — evidence: `local-runtime/tests/test_project_bindings.py::test_bind_folder_records_device_local_row_without_platform_writes` + `::test_rebind_replaces_the_path_and_unbind_clears_it` + `::test_other_device_never_sees_the_binding` (registry keyed by the whole profile binding incl. device_id)
> - [x] 项目详情正确展示绑定状态与设备归属 — evidence: `test/session-sidebar.test.tsx` `project folder bindings (#92) > shows the bound path with device attribution next to the project` (已绑定：path（本设备：deviceName）)
> - [x] 换设备登录显示"未绑定（原设备绑定不迁移）" — evidence: `test/session-sidebar.test.tsx > shows the cross-device unbound note when this device has no binding row` + pytest `::test_other_device_never_sees_the_binding` (per-device keying makes the view empty elsewhere)
> - [x] 绑定信息作为受控终端/文件工具的边界输入可被消费 — evidence: `test/terminal-start-dir.test.ts` (project binding → workspace → home chain, wired in `src/main/index.ts` via `startDirForProject`); file tools: `test_project_bindings.py::test_bound_folder_is_usable_as_the_workspace_root_input` plus the bind-flow workspace offer in `src/main/index.ts` (documented in `dev-log/design.md` D4)
> - [x] 桥契约测试覆盖绑定读写 — evidence: `test/projects-bridge.test.ts` (exact per-action shape matrices + live bundled-Runtime round-trip: CHAT_UNAUTHENTICATED fence for bind-folder/unbind-folder, empty `projectBindings` snapshot) + `test_project_bindings.py` read-write round-trips against the fake platform

## Design constraints (settled — do not reopen)

- The platform API has NO project-binding endpoint (verified: `/api/projects` GET/POST/PATCH/DELETE/archive/restore only). Bindings are therefore a **device-local registry keyed by platform projectId**, matching `GLOSSARY.md` (项目文件夹绑定: 每台电脑各绑各的, distinct from 目录授权). Cross-device "未绑定（原设备绑定不迁移）" follows naturally from device-local storage: the registry records the device identity that made the binding, and a different device shows 未绑定 with that explanation.
- Bind/unbind is optional and repeatable (补绑/解绑 anytime). Deleting a platform project must NOT delete local files (out of scope here, but your storage must not couple the two).

## Architecture map (verified)

- Project management (#91) surface to extend: `src/renderer/src/components/Layout/ProjectManageModal.tsx` (`ProjectRow`), opened from `Sidebar.tsx`; store `src/renderer/src/stores/projectDirectory.ts` (`ProjectDirectoryController`, generation-fenced `run()`, `explainProjectError`); selection state `sessionStore.ts` `ProjectSelection` + `setProjectSelection` (sessionStore.ts:51).
- IPC ladder to clone: `ProjectCommand` union (`src/shared/desktop.ts` 413-442) → `window.ideer.projects` (`src/preload/index.ts`:25) → `ipcMain.handle('desktop:projects')` (`src/main/index.ts` 589-606) → `RuntimeProcess.projects()` (`src/main/runtime.ts` 542-577, single-slot, `{type:'projects', id, action, ..., scope: this.chatScope}`) → desktop.py envelope gate (244-262) + `project_commands` queue + dispatch (771-791) → `DesktopChat.projects_manage` (`local-runtime/core/platform_chat.py` 2981-3035). Prefer extending the existing `projects` family with new actions over inventing a new channel family; if you must add a channel, the security test arrays must be updated in sorted order.
- Channel whitelist test: `test/security.test.ts` bundles the preload and asserts exact sorted invoke channel list (lines ~118-119) and push channels (~129-130). Same file pins package.json dependency list — do not add dependencies.
- Existing device-wide workspace binding (NOT per-project): `local-runtime/core/file_service.py` `WorkspaceSelection` (line 75, `scope()` = sha256 of account/device+workspace), `select()` (169), directory grants; terminal start dir: `src/main/terminal.ts` `TerminalSessions.resolveStartDir` wired at `src/main/index.ts` 298-312 — currently `runtime.files('locate','/')` of the single workspace with home fallback; its doc comment already anticipates "project-bound folder, user home as fallback" (decision #59.2). Browser pane locate: index.ts 94-104.
- Status snapshot flow: desktop.py emits status every 0.5 s; `RuntimeProcess` parses it in the stdout reader (`runtime.ts` ~1821-1971) into `RuntimeStatus` (`src/shared/desktop.ts` ~670). New binding state should ride this snapshot (e.g. `projectBindings` field) or a dedicated projects action reply — pick one, document it.
- Runtime facade split: `local-runtime/core/desktop.py` (stdio dispatch) + `local-runtime/core/platform_chat.py` (`DesktopChat`) + settings persistence `local-runtime/core/settings.py` (`RuntimeSettings`, save() line 229). A device-local registry can be a small sqlite/json store owned by the Runtime (pattern: `KnowledgeImportRegistry` sqlite in `core/knowledge_import.py` 133-265) or a `RuntimeSettings` field — decide by matching existing idiom, and document why.
- Tests to extend: `test/projects-bridge.test.ts` (bridge contract incl. live round-trip), `test/session-sidebar.test.tsx` (jsdom, stubIdeer helper), `local-runtime/tests/test_platform_projects.py` (in-file `http.server` fake platform).

## Scope guidance

1. Runtime: project-binding registry (bind/unbind/read per project+device, device identity recorded), surfaced through the projects family + status; pytest coverage (bind, unbind, rebind, per-device isolation, unknown project).
2. Bridge: new actions on `desktop:projects` (`bind-folder` with a main-side native folder dialog + confirm like existing dialogs, `unbind-folder`), shared types, preload d.ts, security test sorted arrays with `// Issue 92:` comment.
3. Consumption (criterion 4): `TerminalSessions.resolveStartDir` prefers the bound folder of the currently selected project (fallback chain: project binding → workspace locate → home); document how file tools see the boundary — the bound folder must be usable as the workspace/root input for that project's chats (the exact seam is yours; keep it honest and tested — at minimum terminal start-dir consumption + a documented, tested path for file tools).
4. UI: project rows/details in `ProjectManageModal.tsx` (and/or sidebar) show 已绑路径/未绑定 + device attribution; bind (folder picker via main dialog) / unbind buttons; a different-device view shows 未绑定（原设备绑定不迁移）. jsdom tests.
5. Bridge contract test covers bind/unbind read-write round-trip (criterion 5).

## Workflow (required)

1. Test-first red-green slices: write the failing test first per slice (pytest for Runtime registry/consumption, vitest for bridge/UI), watch it fail, implement, watch it pass. Focused verification only per slice: the touched pytest/vitest files + `npm run typecheck` + (channel changes) `npm run test:security`. Do NOT run the full suite repeatedly — the orchestrator runs the PR gate.
2. Impact analysis before edits: grep callers of every seam you touch; new IPC surface must land simultaneously in shared types, preload + d.ts, main handler, and the sorted security-test arrays.
3. Two-axis review before your final commit: (a) correctness — re-read the diff against the acceptance criteria, chase error paths (canceled dialogs, unknown project, identity change) and cancellation; (b) idiom — diff against neighboring implementations, fix deviations (naming, error categories, comment style `// Issue 92:`). Record findings and fixes in `dev-log/review.md`.
4. Commit: conventional, `feat(projects): ... (#92)`; tree must end clean (`git status` empty); check off the acceptance boxes above with one evidence line each (test id or explicit staged reason).
5. Session files only in `dev-log/`.

## Report format (final message)

- STATUS: DONE | BLOCKED (+ why)
- Commit hash(es) + subjects
- Acceptance criteria: pass/fail/staged each, with the proving test id
- Checks run + exit codes
- Files changed (paths)
- Risks/notes for the reviewer
