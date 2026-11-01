---
id: issue-079-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 79 Desktop session export — the whole-session Markdown export and the single-reply export derived in the trusted main process from the Runtime's own state reply, with the native save dialog and the honest formatting note
last-verified: 2026-11-01
verified-against: feat/issue-79-session-export worktree at G:\code\iDeer-worktrees\issue-79-export on top of origin/develop e7f10b8
---

# Issue 79 Desktop acceptance

## Acceptance criteria

- [x] 整会话导出 Markdown 内容与界面一致
- [x] 单条回复导出可用
- [x] 用构造会话验证导出不含隐藏信息与回执细节
- [x] 文件默认本机、位置可选
- [x] 代码块/公式/图片按现有格式器能力如实呈现、差异如实标注

## Implemented surface

- **Command seam (`src/shared/desktop.ts`)**: `ChatCommand` gains `export`
  with `mode: 'session' | 'message'` and an optional `messageId`; it rides the
  existing restricted `desktop:chat` channel, so the preload channel allowlist
  is unchanged. `ChatSnapshot` gains the transient `exportStatus`
  (`'saved' | 'cancelled'`), set by main on the reply snapshot exactly like
  `downloadStatus`.
- **Document builder (`src/main/chat-export.ts`)**: `buildSessionMarkdown` and
  `buildMessageMarkdown` render exactly the interface-visible message log —
  the same role labels as the chat cards (`你` / `Agent` / `工具 {name}`),
  message text verbatim, one section per message in arrival order. A
  clarification request is recorded as the visible prompt facts (title,
  question, context, option and form-field labels) plus an
  （已回答）/（待回答）marker; request ids, sources and value payloads never
  enter the document. Receipts (`localTasks`), consent requests, server
  events, artifacts, run selections and every internal identifier are
  excluded by construction — the builder reads `state.messages` and nothing
  else. The header states the formatting contract honestly: the interface
  shows plain preformatted text, so code blocks, formulas and images ride the
  message text as-is and no extra rendering is claimed.
- **Main-process export (`src/main/chat-export.ts`,
  `src/main/index.ts`)**: `desktop:chat` intercepts `export` before the
  Runtime is ever reached (like `download` and `tier`). The command shape is
  validated first (`CHAT_COMMAND_INVALID` on wrong mode, extra or missing
  keys, bad `messageId`); the document is derived from a fresh
  `runtime.chat({ action: 'state' })` reply, refusing a scope or open-thread
  mismatch (`CHAT_EXPORT_SCOPE_CHANGED`), a missing or non-AI target
  (`CHAT_EXPORT_TARGET_MISSING`) and documents over the platform's own 2 MiB
  response bound (`CHAT_EXPORT_TOO_LARGE`). The destination is a native
  `showSaveDialog` with a suggested, sanitized file name
  (`{会话标题}-导出-{时间戳}.md` / `{会话标题}-单条回复-{时间戳}.md`); the
  scope is re-checked after the dialog (`CHAT_EXPORT_IDENTITY_CHANGED`), the
  write is staged with `flag: 'wx', mode: 0o600` under a random temporary
  name and renamed atomically (`CHAT_EXPORT_SAVE_FAILED` on failure). A
  dismissed dialog returns `exportStatus: 'cancelled'` and writes nothing.
- **Renderer surface (`src/renderer/src/components/ChatPanel.tsx`)**: a
  导出整会话 Markdown button above the message log (disabled while busy or
  without messages) and a per-card 导出 action on AI replies only; outcome
  alerts mirror the attachment-download alerts.

## Verification

- `test/chat-export.test.ts` (6 cases): verbatim text with code fences and
  formulas, role labels and order, thread-title header, the honest note and
  timestamp, generic-title fallback, and the constructed-session proof that
  request ids, sources, consent contents, receipt hashes, event details,
  artifact names and internal identifiers are absent while visible
  clarification facts and answered markers are present.
- `test/chat-export-main.test.ts` (11 cases): saved write with the double
  state read (before and after the dialog), cancelled path, malformed-command
  rejections before any runtime or dialog use, errored-state passthrough,
  scope/thread mismatch, single-reply export by id and its rejections, save
  failure mapping, identity change during the pending dialog, name
  sanitization and repeatable writes.
- `test/chat-export-ui.test.tsx` (4 cases): the session export button and its
  emitted command, the single-reply export only on AI cards, the disabled
  state without messages, and the outcome alerts driven by `exportStatus`.
- Full suites on the worktree: `npm test` — 21 new export tests all pass;
  the remaining vitest failure set is identical to the same-environment
  develop baseline (installer/recovery domain, environment-dependent,
  pre-existing). `python -m pytest local-runtime/tests -q` (CI invocation
  with `PYTHONPATH: local-runtime`): 586 passed, 8 skipped. `npm run
  typecheck` clean on both tsconfigs; `ruff` (`E9,F63,F7,F82`) clean;
  `verify-runtime-source` not touched by this change (no Runtime source
  modified).

## Limitations

- The export covers the currently open Thread only; that is the same state
  the interface shows, and the Runtime holds no other transcript locally.
- The document records the interface's own formatting capability (plain
  preformatted text); no markdown renderer is added, per the pinned
  dependency list.
