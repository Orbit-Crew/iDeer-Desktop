---
id: issue-71-dock-entry-restoration
kind: evidence
status: current
owner: Neowyh
scope: Issue 71 entry restoration of the pinned linz dock multi-pane workspace: split tree, ratios, tab/pane drag, multi-instance panes, eight layout presets and device-local persistence
last-verified: 2026-10-31
verified-against: iDeer-Desktop develop d4a1a47 plus this change (single commit on feat/issue-71-dock-workspace); Windows 11 Pro 10.0.26300 x64, Node 22.14.0, prepared runtime Python 3.12.10
---

# Issue 71 dock workspace entry restoration

[Issue #71](https://github.com/Orbit-Crew/iDeer-Desktop/issues/71) is the first
phase-one child of [the linz full capability equivalence spec #70](https://github.com/Orbit-Crew/iDeer-Desktop/issues/70).
This record covers the **first of the three acceptance layers (entry
restoration)**: the original dock multi-pane framework is restored with its
column positions, arrangement presets and device-local persistence, and every
capability that is not wired yet keeps its original entry position with an
honest status instead of disappearing.

## What was restored

Source reference is the pinned original
[Neowyh/linz f88141b dock](https://github.com/Neowyh/linz/tree/f88141bb3d3450a572fcc52e0f9b48a1e60d3b13/src/renderer/src/dock)
(MIT declaration retained in THIRD_PARTY_NOTICES.md; per
[docs/porting.md](../../porting.md) the copy is managed and adapted, not kept
in sync).

- `src/renderer/src/dock/` — the dock framework: split tree store with
  normalised `byId`, ratio clamping, tab and pane drag targets
  (`moveTab`/`splitBeside`/`movePaneBeside`/`swapPanes`), multi-instance pane
  types, the pane chrome (`PaneFrame`), the keep-alive instance overlay
  (`InstanceHostOverlay`), the add-panel picker, the panel registry and the
  eight fixed arrangement presets with thumbnails (`layoutPresets`).
- Persistence — `ideer.dock.layout.v1` and `ideer.ui.companion.visible.v1` are
  device-level `localStorage` keys (Electron renderer). The layout and preset
  follow the device, never the account or the project; restarts restore them.
  Volatile per-instance session state is stripped on save — where the original
  stripped only `sessionId`, the Desktop also strips `url` (both are
  restart-volatile here). The original only ever read the companion-visible
  key at startup; the Desktop also writes it on every switch.
- Entry — the workspace area of `AppLayout` is now the dock. The chat anchor
  hosts the platform chat (`ChatPanel`, unchanged); the Desktop-specific
  `runtime` pane carries the existing Runtime/Update/Compatibility surfaces;
  the workspace layout-arrangement button floats top-right over the dock.
- Honest placeholders — `browser`, `terminal`, `files`, `kb`, `viewer3d`,
  `field`, `synapse` stay listed at their original column positions with a
  status card naming the phase that wires them (per #70). `sql` remains
  meta-only, exactly as in the pinned original (it was never a delivered
  original pane).

### Documented divergences from the original

- The Desktop default layout pairs the chat anchor with the **本机 Runtime**
  pane instead of the original browser/terminal/files tools pane: those panes
  are not wired in this phase, and device binding is the Desktop's primary
  honest surface. The original arrangements remain available as presets.
- The companion-pane switch defaults to visible on first run (the original
  defaulted to hidden); hiding the Runtime pane would hide login and device
  binding.
- Two robustness fixes over the original: the anchor chat tab can never be
  dragged out (the original store allowed it, which would collapse the anchor
  pane away), and `ensureAnchorPane` wraps a single-pane root into a split so
  the repaired anchor is actually reachable from the render tree.
- Desktop has no router: the anchor renders `ChatPanel` directly where the
  original rendered `<Outlet/>`.
- The dock store's initial state is the restored/default layout at store
  creation, so the first frame and static acceptance markup render the same
  layout (zustand v4 serves `getInitialState()` as the server snapshot).

## Security seam

`test/security.test.ts` gains a `dock pane security seam` block:

- every registered panel type with a non-`native` runtime (`browser`,
  `terminal`, `viewer3d`, `field`, `synapse`) maps to the
  `externalPanes` placeholder component by identity, and `files`/`kb` map to
  the unwired-native placeholder — a future pane cannot silently gain bridge
  access by being registered;
- the `externalPanes` module bundles to a graph with no `preload`,
  `shared/desktop` or component imports and no `window.ideer`, `desktop:`,
  `sendToHost`, `openExternal` or `webview` references — external-content
  panes cannot reach the trusted bridge through the dock;
- the main window guards stay closed (`webviewTag: false`, `setWindowOpenHandler`
  deny, `will-navigate`/`will-attach-webview` prevention, permission
  request/check handlers deny), so no pane can attach a webview around the
  seam;
- the preload channel list assertion is unchanged: the dock adds no IPC.

## Evidence

Run at authoring on Windows 11 Pro 10.0.26300 x64, Node 22.14.0, prepared
runtime Python 3.12.10 (worktree `.runtime` assembled from the pinned
distribution lock):

- `npm run typecheck` — both tsconfig projects clean.
- `npm test` — **174/174 tests pass, 35 files**, including:
  - `test/dock-store.test.ts` (23): default layout, anchor repair
    (including the single-pane-root reachability fix), split/close collapse,
    ratio clamping, multi-instance numbering (浏览器 1/浏览器 2),
    single-instance focus, tab/pane moves, anchor hardening, side mapping,
    all eight presets (one anchor each, expected pane/instance counts),
    companion-switch consistency, persistence round-trip, volatile-state
    stripping, corrupt/foreign payload rejection;
  - `test/dock-view.test.tsx` (7): startup markup (chat anchor, Runtime pane,
    arrangement entry), default split tree with adjustable divider, honest
    placeholder text, per-instance tab strip, eight arrangements listed,
    registry vocabulary (all original columns, `sql` meta-only), add-picker
    contents;
  - `test/security.test.ts` (4, of which 3 are new): the seam block above;
  - `test/startup.test.tsx` (1): updated to the dock startup surface (chat
    anchor alert, Runtime honest-state line, arrangement entry, sidebar exit).
- The local-only reference copy of the original dock sources used during the
  port lives in the checkout `.cache/linz-ref-f88141b/` and is not committed.

## Scope limits (three-layer accounting)

- This record claims only **entry restoration**. Business wiring (业务接线)
  and installed candidate acceptance (实际候选验收) are not claimed: the
  browser/terminal/files/kb/viewer3d/field/synapse panes are honest
  placeholders, and no packaged installer run was performed.
- The like-for-like visual comparison ("同类窗口尺寸下的外观对照") tracked by
  the linz frontend restoration requirements (see the decision map
  [#51](https://github.com/Orbit-Crew/iDeer-Desktop/issues/51) and the spec
  [#70](https://github.com/Orbit-Crew/iDeer-Desktop/issues/70)) is pending;
  this record pins structure and behavior through markup and store tests, not
  pixel comparison.
- `applyPreset` interplay with the companion switch is covered at store level;
  drag-and-drop DOM behavior is covered by the pure side-mapping and store
  move/split actions, not by synthetic browser drag events.

## How to re-run

```powershell
. .\scripts\project-env.ps1   # if invoking tools directly on Windows
npm run typecheck
npm test                      # full suite incl. the bundled-Runtime tests; a fresh
                              # checkout first needs: python scripts/prepare-runtime.py
npx vitest run test/dock-store.test.ts test/dock-view.test.tsx
npx vitest run test/security.test.ts test/startup.test.tsx
```
