---
id: issue-115-cad-viewer-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 115 Desktop CAD viewer (STEP/STL/OBJ) over the dock viewer3d pane
last-verified: 2026-11-07
verified-against: feat/issue-115-cad-viewer based on develop 12a6407; evidence produced from the same worktree tree (G:\code\iDeer-worktrees\issue-115-cad-viewer) before publication
---

# Issue 115 CAD viewer Desktop acceptance

The candidate is the isolated worktree `G:\code\iDeer-worktrees\issue-115-cad-viewer`,
branch `feat/issue-115-cad-viewer`, base develop 12a6407. This directory is named
`issue-115-cad-viewer` because `docs/acceptance/issue-115/` already holds the
unrelated iDeer-repository issue 115 (server-side knowledge publication) records.

Implemented Desktop surface: the dock's 三维模型 pane reads workspace-logical
STL/OBJ/STP/STEP model files through the Runtime's own `locate` gate, converts
them in the trusted main process (local pure readers for STL/OBJ; the pinned
occt-import-js OpenCASCADE WASM for STEP), and renders one bounded mesh payload
with two honest engines — three.js WebGL and a software 2D canvas fallback —
with explicit size/triangle caps, explicit per-code refusals, and no geometry
editing. The bundled components are registered in `resources/provenance/linz-source.json`
(occt binaries copied byte-for-byte from the linz source commit) and
`THIRD_PARTY_NOTICES.md` (occt-import-js MIT + OCCT LGPL-2.1-exception, three.js MIT).

| Issue criterion | Status | Evidence and remaining work |
| --- | --- | --- |
| STEP/STL/OBJ 文件加载与三维显示 | partial (automated complete, installed visual run unexecuted) | Automated: binary/ASCII STL and OBJ (quad fan, negative and slashed indices) parser tests; STEP merge/offset/failure tests with an injected converter; the real shipped WASM converts the CAx-IF AS1 AP214 assembly (`as1-oc-214.stp`, 433,606 bytes) into 18 meshes / 5,260 vertices / 5,040 triangles through the exact `resources/occt` binaries (evidence command below). jsdom pane tests cover the open flow and the honest stats line. An installed-app run with a logged-in account, a confirmed workspace and real model files remains unexecuted. |
| 3D 视图操作可用；2D 回退路径可用 | partial | The three.js engine ports the original's orbit/zoom interaction with visibility-gated rendering and full GPU disposal; the software 2D canvas engine ports the original's orthographic painter (back-to-front sort, flat shading, drag rotate, wheel zoom). Automated: a jsdom test proves the WebGL-failure path switches to the 2D engine with an explicit announcement (`WebGL 不可用，已切换到软件渲染`). Real interactive drag/zoom in the installed app is unexecuted. |
| 大模型处理策略如实（不静默失败） | partial (automated complete) | Automated: file cap 100 MB refused before read (`CAD_FILE_TOO_LARGE`); binary STL triangle count refused from its 84-byte header before the body is read; post-parse triangle budget 1,000,000 refused for ASCII STL and STEP (`CAD_MESH_TOO_LARGE`); empty geometry named (`CAD_EMPTY_GEOMETRY`); a missing conversion engine is its own code (`CAD_OCCT_UNAVAILABLE`); malformed coordinates and unresolvable face indices are parser-level codes. A real over-cap model run in the installed app is unexecuted. |
| 新增格式不做、入口不出现假承诺 | complete (automated) | The service whitelist accepts only `.stl/.obj/.stp/.step` and refuses other suffixes by code (`CAD_FORMAT_UNSUPPORTED`, tested with `.iges`, `.xyz`, no extension); the external-pane placeholder text that promised the future viewer is removed from the seam module; the pane footer states 只读查看 / 几何编辑不在范围, and the pane exposes no editing control (asserted). The conversation→pane auto-open command is deliberately out of scope (#117 结果自动开窗). |
| 与多窗格框架的窗格类型集成可用 | partial (modern Windows automation complete, installed NSIS run unexecuted) | The pre-reserved `viewer3d` pane type is wired to the real component (native-hosted like the terminal — desktop-local content, not external content), pinned in test/security.test.ts (registry mapping, wired list, dependency and channel inventories), test/dock-view.test.tsx (vocabulary, add picker) and test/cad-bridge.test.ts (pane graph touches only `window.ideer.cad` + `getStatus`, no preload module, no embedded-content seam). The real-Electron desktop smoke passes end to end, including the bridge key inventory with `cad`. The NSIS installed-package run remains unexecuted for this ticket. |

Win7 is the only explicitly deferred platform verification for this stage and
is owned by closing ticket #131: SwiftShader WebGL performance and the software
2D fallback on real Win7 hardware stay unexecuted, and modern Windows passes
must not be read as Win7 passes.

## Commands and results

Windows 11 host, Git Bash, pinned Node 22.14.0 (`C:\Users\Neo\.ideer-tools\node22`),
pinned Python 3.12 venv for the runtime preparation. Worktree `.runtime` was
prepared with `node scripts/project-env.cjs python scripts/prepare-runtime.py`
(Prepared Python 3.12.10). Worktree `.cache` was seeded from the main checkout's
electron and electron-builder caches.

- `npm run typecheck` — clean (tsconfig.node + tsconfig.web).
- `npm test` — 500–501 of 502 passing across repeated runs. The intermittent
  failures are the pre-existing load-sensitive integration tests
  (`knowledge-publish`, `session-sidebar`, and once `browser-slot`), which spin
  up real local gateways and Runtime child processes and time out under full-suite
  parallelism; they pass in isolation in this worktree and the full suite shows
  the same intermittent set on the pristine develop baseline (467 tests, one
  `session-sidebar` failure reproduced there). All 49 CAD/security/dock-view
  tests pass in every run.
- `npm run build && npm run test:desktop` — real Electron smoke passes: launch,
  login-fallback text, Runtime lifecycle, bridge key inventory including `cad`,
  sidebar/resize/quit stages, process-exit checks.
- Real WASM conversion evidence (2026-11-07, this worktree):

  ```
  node -e "require('resources/occt/occt-import-js.js')({locateFile}) ...
          occt.ReadStepFile(fs.readFileSync('as1-oc-214.stp'), null)"
  → STEP OK: meshes=18 vertices=5260 triangles=5040
  ```

  Input: upstream occt-import-js test fixture
  `test/testfiles/cax-if/as1-oc-214.stp` (CAx-IF AP214 assembly, 433,606 bytes),
  cached outside the repository. The conversion used the exact
  `resources/occt/occt-import-js.js` + `.wasm` bytes pinned in
  `resources/provenance/linz-source.json`
  (`3fb44ce1…`, `33391fc9…`), which `npm run verify:provenance` re-verifies.
