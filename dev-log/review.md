# Issue #92 two-axis review (before final commit)

Diff reviewed file by file: `git diff` over 14 modified + 3 new source/test
files, re-read against the acceptance criteria and the neighboring
implementations (ConnectorRegistry, the #91 projects family, the
#110/#94 terminal and file seams).

## Axis (a) — correctness

Chased error paths and cancellation; findings and dispositions:

1. **Canceled dialogs** — folder dialog canceled, confirm refused, and the
   post-bind workspace offer refused all end as user decisions: the first two
   throw `PROJECTS_CANCELED` (the renderer controller treats it as quiet), the
   third simply skips the optional offer and returns the successful bind
   reply. A failed `selectWorkspace` inside the offer is swallowed (the
   workspace chooser stays authoritative); the binding is never undone by it.
2. **Unknown project** — `bind-folder` re-reads the Server's own list and
   refuses `CHAT_NOT_FOUND` before any registry write; the listing it fetches
   is reused for the reply (exactly one GET /api/projects, pinned by
   `test_bind_folder_records_device_local_row_without_platform_writes`).
3. **Identity change** — the chat-session scope fence runs first in
   `projects_manage` for every action including the new two; pinned by
   `test_bind_and_unbind_stay_behind_the_session_fence`. The main-side bind
   dialog flow also re-checks nothing identity-related before the Runtime
   call — the Runtime stays the fence (same shape as delete).
4. **Renderer path injection** — the bridge `ProjectCommand` carries the
   project id only; the path variant (`ProjectBindCommand`) is main-internal
   (the `ConnectorInstallCommand` idiom), and the handler builds the wire
   command fresh from `chosen.filePaths[0]`, so a renderer-supplied `path`
   field can never reach the Runtime. `unbind-folder` passes the renderer
   command through, where the exact 2-key shape check rejects extras.
5. **Terminal start dir** — the selector is sanitized to
   `[A-Za-z0-9_-]{1,128}` (malformed → no selection), a bound folder missing
   on disk falls through (`existsSync`), and the resolver's refusal falls
   through to the user home; no physical path reaches the renderer (pinned by
   the existing "never hands the renderer a start dir" test plus the new
   selector test).
6. **Storage failure** — registry errors surface as the single fixed category
   `PROJECT_BINDING_STORAGE_UNAVAILABLE` (status snapshot) and
   `CHAT_BINDING_STORE_UNAVAILABLE` (chat round-trips); the status loop reads
   rows best-effort like every other registry (error field alongside).
7. **Snapshot parse** — `projectBindings` rows are strictly shape-checked in
   `runtime.ts` (bounded 20, id pattern, path cap 1024); a violation kills
   the child like every other status family. An absent field (older runtime)
   parses as absent — optional.

Findings fixed during review:

- F1: the first draft of `projects_manage` fetched the platform list twice
  for bind (check + reply); rewrote to reuse the one listing.
- F2: `test/terminal-bridge.test.ts` selector test originally built a harness
  and replaced its manager; rewrote to construct the one manager directly.
- F3: the store-failure jsdom test originally clicked bind first, which can
  never produce a bound row with the stub; rewritten to start bound and
  unbind into the rejection. Also switched `getByText` → `getAllByText`
  (antd Alert renders its message node twice in jsdom).

Pre-existing quirk observed, NOT changed (out of scope, behavior preserved):
the projects reply resolver builds `{ [pending.action]: true }`, so mutation
flags land under keys like `create`/`rename` rather than `created`/`renamed`
hidden by the `as ProjectOperationView` cast. No consumer reads the flags
(the controller re-reads the authoritative list), and #92's `bound`/
`unbound` flags follow the same shape, so #92 does not deepen it.

## Axis (b) — idiom

Diffed against the neighboring implementations:

- Registry: `ProjectBindingRegistry` mirrors `ConnectorRegistry` (sqlite next
  to the settings, `identity` hash of `(binding, key)`, `_db`/`_execute`,
  RLock, single error category, `_view` camelCase projection).
- Wire family: the new actions extend the existing `desktop:projects` channel
  — no new invoke/push channel, so the sorted arrays in `test/security.test.ts`
  are byte-identical; an `// Issue 92:` comment documents that in the array's
  comment block (per the ticket's instruction).
- Comments: `// Issue 92:` on every touched surface (TS) and `(#92)` in the
  Python docstrings; the `desktop:projects` handler, the terminal resolver,
  the preload spawn entry, the pane, the store and the modal all carry the
  rationale.
- Test idioms: pytest reuses `test_platform_projects.py`'s `platform()` /
  `make_chat` / `wire` fixtures via import (the established cross-test
  import convention, cf. `test_chat_attachments.py`); vitest follows the
  harness/stubIdeer patterns of `terminal-bridge.test.ts` /
  `session-sidebar.test.tsx`; the bridge test follows the #91 shape-matrix +
  live unauthenticated fence structure.
- UI: the row follows the #91 row (title tooltips, aria-labels naming the
  project, `disabled={busy}`, Popconfirm only for the destructive delete);
  unbind stays a plain button because it is reversible local cleanup.
- Scope discipline: `local-runtime/core/file_service.py`, `settings.py`,
  `transport.py`, `tray.py` (pinned upstream files) are untouched — verified
  by `scripts/verify-runtime-source.py` (exit 0). The Issue-78
  `inherited_binding` contract is unchanged; no second inheritance path.
