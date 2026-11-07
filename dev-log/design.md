# Issue #92 design decisions (settled before code)

## D1 — Registry storage: sqlite `ProjectBindingRegistry` in new `core/project_binding.py`

Matches the established device-registry idiom (`ConnectorRegistry`, `KnowledgeImportRegistry`,
`SkillScriptRegistry`): one sqlite file next to the settings (`project-bindings.db`), own
`threading.RLock`, rows keyed by an identity hash of `(profile_binding, project_id)`, a single
fixed storage-error category `PROJECT_BINDING_STORAGE_UNAVAILABLE`.

Why not a `RuntimeSettings` field: settings is one JSON document rewritten wholesale under
`_SAVE_LOCK`, holding the single device-wide workspace selection and its grant identity. Project
bindings are N small rows written from the stdio dispatch loop and read by the 0.5 s status loop;
the sqlite registry idiom fits both the write pattern and the error-surfacing pattern. A separate
file also keeps platform-project deletion fully decoupled from local files (design constraint).

Per-device isolation is structural: `profile_binding(settings)` = (server_origin, user_id,
**device_id**, device_public_key, broker_public_key). Rows are keyed by the whole binding, so a
different device never sees another device's rows — 换设备登录 shows 未绑定（原设备绑定不迁移）
without any migration logic.

Row fields: identity, binding (JSON), project_id, path, device_name (display attribution, bound
at bind time), created_at.

## D2 — Wire: extend the existing `desktop:projects` family (no new channel)

`ProjectCommand` gains `{ action: 'bind-folder'; projectId: string }` and
`{ action: 'unbind-folder'; projectId: string }`. The folder path NEVER comes from the renderer:
main opens the native `dialog.showOpenDialog` (openDirectory) and a confirm message box (boundary
explanation, like `desktop:workspace:choose`), then sends the chosen path to the Runtime.

- runtime.ts `projects()`: per-action key validation; bind-folder carries `projectId` + `path`
  (1..1024 chars); wire `{type:'projects', id, action, projectId, path?, scope}`.
- desktop.py envelope gate: two new key sets in the existing `projects` gate block.
- `DesktopChat.projects_manage`: bind-folder re-reads the platform list first and refuses an
  unknown projectId with `CHAT_NOT_FOUND` (the registry is keyed by platform projectId, so a bind
  must reference a live project); validates the path (absolute, isdir → else `CHAT_COMMAND_INVALID`);
  records via the registry. unbind-folder is local cleanup, idempotent, no platform precondition.
  Replies follow the family idiom: every reply carries the platform's own post-action list plus the
  account permissions, and now also `bindings` (this device's rows) plus `bound:`/`unbound:` flags.
- Registry failures raise `CHAT_BINDING_STORE_UNAVAILABLE` (new fixed category; renderer explains it).
- Binding/unbinding is intentionally NOT gated on `projects:write`: it is a device-local accessory
  record; the platform-side check is project existence (read) only.

## D3 — Status snapshot: `projectBindings` rides the 0.5 s snapshot

Main-side consumption (terminal start dir) must not depend on a renderer projects round-trip.
desktop.py status gains `projectBindings` (rows for the authenticated profile, capped 20) and
`projectBindingStorageError`; runtime.ts parses them with the same strictness as `connectors` into
`RuntimeStatus.projectBindings?: ProjectBindingView[]`. `ProjectBindingView` =
`{ projectId, path, deviceName, createdAt }`.

## D4 — Consumption (criterion 4)

- 起始输入 (start): human terminal chain becomes project binding → workspace locate → home.
  The renderer passes its selected project as an id-only selector to `terminal:spawn`
  (`TerminalBridge.spawn(projectId?)`); main resolves the path exclusively from the Runtime
  snapshot (`runtime.status().projectBindings`), verifies it still exists on disk (existsSync),
  and never hands any path back to the renderer — the invariant "renderer never supplies or
  receives a physical path" holds; a bogus/unknown selector simply falls through the chain.
  The chain itself is a tested exported helper in `terminal.ts` (`startDirForProject`).
- 边界输入 (boundary): the Agent file tools' root input in desktop mode is the confirmed device
  workspace (`WorkspaceSelection`) — unchanged. The bound folder becomes usable as that root
  input through the existing guarded seam: after a confirmed bind, when the device has no
  workspace yet, main offers a second explicit dialog to select the bound folder as the
  workspace (`runtime.selectWorkspace`); pytest proves a bound folder passes the same guards
  (`WorkspaceSelection.select(confirmed=True)` → grant → file store roots inside it). The
  Issue-78 `_thread_bindings` scaffolding stays as-is: its per-run context consumer is future
  work (documented in `inherited_binding`), and this ticket does not grow a second inheritance
  path.

## D5 — Renderer

`ProjectDirectoryView` gains `bindings: ProjectBindingView[]` (default `[]`); the controller's
single `run()` path passes them through; `bindFolder`/`unbindFolder` methods. `ProjectRow` shows
已绑定：{path}（本设备：{deviceName}） or 未绑定（原设备绑定不迁移）, with 绑定文件夹 / 解除绑定
buttons. Bind/unbind ride the existing generation-fenced `run()`; a canceled dialog stays quiet
(`PROJECTS_CANCELED`).

## Security test arrays

No new IPC channel and no new push channel: bind-folder/unbind-folder ride `desktop:projects`,
so the sorted invoke/push arrays in `test/security.test.ts` stay byte-identical; an `// Issue 92:`
comment documents that decision in the array's comment block (per ticket).
