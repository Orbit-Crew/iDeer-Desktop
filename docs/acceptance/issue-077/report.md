---
id: issue-077-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 77 Desktop side of background sessions and notification jump-back — the bounded background-run observation ledger and approval-ask projection in the Runtime, the strictly parsed notify wire plus the main-process notification ledger, OS toasts and the bridge's first push channels, the notification center pane and sidebar bell, and the toast/row activation jump-back through the sidebar's own open handshake
last-verified: 2026-11-01
verified-against: feat/issue-77-background-sessions worktree at G:\code\iDeer-worktrees\issue-77-background, commits 980541f / 72a0f96 / 4912c10 on top of origin/develop 5e7c138
---

# Issue 77 Desktop acceptance

## Acceptance criteria

- [x] 切走会话后任务继续执行、状态如实显示
- [x] 完成与待审批产生系统通知，点击跳回正确会话
- [x] 桌面无硬编码并发上限（能力交集决定）
- [x] 通知中心可复用扩展（后续票不再重做）
- [x] 桥契约与 Runtime 测试覆盖后台流转

## Implemented surface

- **Runtime observation (`local-runtime/core/platform_chat.py`)**: a Run still
  `{pending, running}` on a thread the user switches away from is registered
  in a 100-entry display ledger (overflow drops the oldest entry, stated in the
  constant's own comment) (`_load_thread`; same-thread open/reconnect
  never registers, a loaded thread drops its own entries). `background_tick`
  — self-throttled to 2 s, single-flight, called from the desktop.py status
  loop — reports each registered run whose Server status left
  `{pending, running}` as exactly one `run-finished` event (≤8 Server polls
  per tick), and reports approval asks from the unfiltered device queue whose
  `payload.thread_id` is not the visible session as exactly one
  `approval-required` event per task; a resolved ask that reappears is asked
  again. Unknown ask kinds stay on the foreground cards only. Every event
  carries identity facts only (bounded summary: path / skill id / revision
  id), is token-scrubbed, and `_reset` or a scope change clears the ledger so
  a retired pairing never reports. `desktop.py` emits each event as one
  `{'v':1,'type':'notify'}` line and adds `backgroundRuns` to the status
  snapshot.
- **Desktop main (`src/main/runtime.ts`, `src/main/notifications.ts`,
  `src/main/index.ts`)**: the status pipe parses `notify` lines through
  `parseNotifyEvent` (strict fixed shapes; any violation kills the process
  like a malformed status line) and validates the bounded `backgroundRuns`
  summary. `NotificationRegistry` keeps at most 100 records newest-first,
  dedupes finished runs by thread+run and asks by task, and answers
  `desktop:notifications` list/read/read-all/clear. Each recorded event shows
  a Windows toast (`setAppUserModelId` was already set; guarded by
  `Notification.isSupported()`); the toast click restores/shows/focuses the
  main window (the `second-instance` paradigm) and pushes
  `desktop:notification:activate {id, threadId}`. After every ledger change
  the main process pushes the full `NotificationCenterView` on
  `desktop:notifications` — the bridge's first push channels, pinned by the
  security test to exactly these two fixed names.
- **Renderer (`src/renderer/src/stores/notificationCenter.ts`,
  `dock/panels/notificationsPane.tsx`, dock registry, `Layout/`)**: AppLayout
  mounts one app-lifetime controller so activation works with the pane
  closed; every push replaces the whole view (no local merge). The
  `notifications` dock pane lists records with kind labels and unread dots,
  offers read-all/clear, and rows activate through `requestOpen(threadId)` +
  `notifications({action:'read'})` — the same handshake the sidebar uses, so
  the serialized chat open path cannot race the poll. The sidebar header
  carries the unread bell that opens the pane via
  `useDockStore.openPanelType('notifications')`.

## Test evidence

- Runtime: `python -m pytest local-runtime/tests -q` — 586 passed, 8 skipped
  (4 new tests: switch-away keeps the run running and reports finish exactly
  once and reopening shows the end state; background ask notifies once,
  skips the foreground session, re-asks after resolution, tolerates an
  unavailable consent snapshot; identity change fences the ledger; a fact
  outside the wire identity charset is skipped). The two
  `test_desktop_process.py` cases need `IDEER_TEST_PYTHON` pointing at a
  prepared `.runtime` when run from a fresh worktree.
- Bridge/ledger: `test/notifications.test.ts` (7) covers `parseNotifyEvent`
  acceptance/rejection and the registry's ordering, dedupe, unread, settle
  and 100-record bound.
- Renderer: `test/notification-center.test.tsx` (6) covers push replacement,
  stop semantics, activation→`requestOpen`+read, pane rendering with facts,
  controller-less read-only display, and the settle commands.
- Suite: `vitest run` 195 passed plus the new/changed files below; the 20 failures are pre-existing
  environmental ones reproduced identically on the untouched baseline
  `develop` checkout on this machine (recovery/nsis/updates-release signing
  fixtures and the `threads-bridge` real-runtime case; the same command on
  the base commit fails the same 20). All 5 files touched by this issue pass.
- Typecheck: `tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json`
  both clean.
- Security pinning: `test/security.test.ts` asserts the preload's invoke
  allowlist plus `desktop:notifications`, pins the ONLY two `.on(`
  subscriptions to `desktop:notifications` and
  `desktop:notification:activate`, and pins `notifications` as a wired native
  pane (no seam placeholder).

## Not done here

- Tray-resident behavior and the tray badge are issue #86's surface; they
  reuse the same ledger and `RuntimeNotifyEvent` union instead of a new one.
- The ledger is in-memory in the trusted main process for this ticket;
  persistence is not an acceptance criterion and was not added.
