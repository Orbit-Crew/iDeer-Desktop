---
id: desktop-issue-107-browser-pane-restoration
kind: evidence
status: current
owner: Neowyh
scope: iDeer-Desktop issue 107 local browser pane restoration: multi-tab navigation over the fixed browser partition, isolated login state, workspace-confined downloads, deny-by-default permission records, and the external-content seam updates
last-verified: 2026-11-05
verified-against: iDeer-Desktop develop f340115 plus this change (single commit on feat/issue-107-browser-pane); Windows 11 Pro 10.0.26300 x64, Node 22.14.0, prepared runtime Python 3.12.10
---

# iDeer-Desktop issue 107: local browser pane restoration

> Numbering note: this directory's [report.md](report.md) records **iDeer**
> #107 (signed update-asset verification, 2026-10-24). This file records
> **Orbit-Crew/iDeer-Desktop** issue
> [#107](https://github.com/Orbit-Crew/iDeer-Desktop/issues/107) — a different
> repository's ticket that happens to share the number.

The issue is the five-phase "浏览、终端与调度" child of [the linz full
capability equivalence spec
#70](https://github.com/Orbit-Crew/iDeer-Desktop/issues/70). Its only blocker,
[#71](https://github.com/Orbit-Crew/iDeer-Desktop/issues/71) (the dock
framework), closed completed on 2026-11-04. As with #94 the implementation is
a fresh build on the Desktop's own seam, not a managed copy of the pinned
linz browser code (no provenance entries; see
[docs/porting.md](../../porting.md)).

## Acceptance criteria

### 多标签与导航操作可用

- The pane (`src/renderer/src/dock/panels/browserPane.tsx`) keeps one
  start-page tab at open, adds tabs, closes tabs (the last close returns to
  the start page instead of an empty pane), and keeps every mounted webview
  alive across tab switches — only visibility changes, matching the dock
  keep-alive contract.
- Back/forward/reload ride the guest's own history; Home returns to the
  start page. The address bar follows committed navigations and page titles.
- Pins: `test/browser-pane.test.tsx` (navigation blocks), plus the updated
  bridge-key and `webviewTag` assertions in `scripts/desktop-smoke.cjs`.

### 登录态独立分区：与系统浏览器隔离、清窗格=清分区

- Every webview mounts with exactly `persist:browser-pane`
  (`BROWSER_PARTITION` in `src/shared/desktop.ts`) — never the app's default
  session (which carries the device surfaces) and never the system browser.
- 清空分区 rides the one bridge entry `desktop:browser` → the trusted main
  process shows the confirmation dialog (the renderer can never sign it) and
  clears cookies, site storage and caches of that partition only; every tab
  returns to the start page with an honest notice.
- Pins: `test/security.test.ts` partition invariants,
  `test/browser-main.test.ts` clear gating, `test/browser-pane.test.tsx`
  clear flow.

### 下载进授权文件夹；夹外下载拒绝或提示

- `will-download` is intercepted in the trusted main process
  (`src/main/browserPane.ts`): no native save dialog exists. The destination
  resolves through the Runtime's own guarded `files locate` answer for the
  confirmed workspace root — the physical path never reaches the renderer.
- The filename is sanitized (path separators, control characters, Windows
  reserved names); a colliding workspace file is never overwritten
  (`name (n).ext`). With no confirmed workspace the download is refused with
  a visible `WORKSPACE_UNCONFIRMED` record.
- Pins: `test/browser-main.test.ts` download routing (refusal, phases,
  collision rename), `test/browser-pane.test.tsx` download notices.

### 权限请求默认拒绝、逐次明示

- The partition session denies every permission request
  (`setPermissionRequestHandler` → `callback(false)`) and every permission
  check; each ask becomes one visible dated line in the pane with the
  Chinese label map (`BROWSER_PERMISSION_LABELS`), unknown names falling back
  to the raw wire value.
- Pins: `test/browser-main.test.ts` permission gate,
  `test/browser-pane.test.tsx` per-ask records.

### 安全缝用例更新（webview 隔离不变量）

- `test/security.test.ts` replaces the issue-71 "guards closed" block: the
  browser pane is now the one non-native pane with its own component; the
  main window re-enables `webviewTag` under a validated
  `will-attach-webview` gate (fixed partition, no node integration, no
  preload, first document already http(s)); the renderer CSP relaxes only
  `frame-src` to `http: https:` while `connect-src` stays `'none'`; the
  preload surface gains exactly `browser` + `onBrowserEvents`; and the
  main-side chokepoint (one persistent partition, session permission denial,
  http(s) document gate, workspace-confined downloads, per-guest popup
  routing via `web-contents-created`) is pinned by source assertions.

## Deliberate divergences from the original

- No search-engine fallback in the address bar: free text is rejected
  honestly instead of inventing a destination the user never chose
  (`sanitizeAddress` in `src/shared/desktop.ts`).
- Popups never open native windows; a popup URL becomes a fact routed to the
  owning pane and turns into a tab there (other panes ignore it).
- Non-http(s) navigations are refused with a visible record; the old local
  execution chain (linz `ipc/browser`) stays excluded per the capability
  table in docs/porting.md.
- Tab state is pane-local and dies with the pane; the dock persistence
  contract already strips volatile per-instance state.

## Test evidence

| Command | Result |
| --- | --- |
| `npm run typecheck` | passed (both tsconfig projects) |
| `npm test` | 344/344 vitest tests passed (58 files), including the 33 new browser tests; project-env node test passed |
| `test:desktop` (real Electron smoke) | not run in this session — installed-app evidence path; the updated smoke assertions (bridge keys, `webviewTag: true`) are source-pinned by the unit tests above and must be re-verified at the acceptance layer |

Baseline note: the develop checkout shows one environment-dependent skills
failure (`SKILL_IMPORT_FAILED` through the bundled Runtime); the same test
passes in this worktree with the freshly prepared runtime.
