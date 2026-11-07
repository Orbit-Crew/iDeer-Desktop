# Issue 116 acceptance — Tecplot 结果面板（六期·41）

[iDeer-Desktop #116](https://github.com/Orbit-Crew/iDeer-Desktop/issues/116)
restores the original linz Tecplot results pane on the Desktop's own seams:
the structured IJK ASCII subset (POINT/BLOCK) parses and displays in the
dock's native `field` pane over the #94 guarded file-read seam, with the
original three display modes (实体/线框/点云) and the original blue→gray→red
scalar coloring. Nothing here is a managed copy of linz source; no new
dependency; zero new IPC channels. Directory name carries the `-tecplot-panel`
suffix because the repo's existing `issue-116/` records belong to the old
numbering (the knowledge-graph ticket, merged as PR #26).

Execution date: 2026-11-07, Asia/Shanghai. Automated execution only.

## Candidate and environment

Desktop branch `feat/issue-116-tecplot-panel` from develop `12a6407`.
Windows 11 Pro 10.0.26300 x64; Node 22.23.4 (project cache `.cache/node-v22`);
bundled Runtime Python 3.12.10 (`.runtime`). vitest 501 passed / 2 failed in
parallel load, both the pre-existing develop timing flakes (`browser-slot`,
`session-sidebar`), each re-verified passing solo; runtime pytest
911 passed / 8 skipped.

## What was delivered

- `src/renderer/src/dock/panels/field/tecplotReader.ts`: a port adapted from
  the original reader (same tokenizer, `VARIABLES`, `ZONE T/I/J/K/F` header
  parsing and POINT/BLOCK loading structure — **not** a verbatim copy, so no
  SHA-256 provenance entry; the source commit is pinned by reference) plus
  the Desktop honesty additions: Fortran `D`-exponents parse to their real
  value (the original's `parseFloat` silently truncated them to a wrong
  value), skipped zones are counted (`zonesOmitted`), non-finite values are
  counted per file (`nonFiniteValues`) and per active zone/variable, and
  fixed caps (128 zones / 2,000,000 points per zone / 64 variables) bound
  the work the 1 MiB guarded preview can hand over.
- `src/renderer/src/dock/panels/field/fieldCanvasModel.ts` +
  `FieldCanvasView.tsx`: the pure paint model and its software 2D canvas —
  the surface layer is exactly the I×J (k=0) quad plane the original's
  `buildStructuredPolydata` built, points mode covers every I×J×K point,
  the color transfer reproduces the original's three stops (one shared
  source for the painter and the scalar bar), and the painter's-algorithm/
  headlight/drag-rotate/wheel-zoom engine is this pane's own no-WebGL
  implementation (the same idiom the CAD viewer under review in #151 uses).
  Wireframe coloring approximates the original's per-point scalar coloring
  per edge (each edge takes its start vertex's value). No WebGL, no embedded
  content.
- `src/renderer/src/dock/panels/fieldPane.tsx`: the native pane —
  workspace-logical path input, guarded read, honest states (runtime not
  running / workspace not confirmed / wire error codes mapped to the same
  sentences the files pane uses), truncated read announced as "已按可完整解析
  的部分显示" and, when the cut leaves no complete zone at all, both facts
  stated together; skipped zones, file-wide and per-zone non-finite values
  announced; a zone without x/y/z coordinates refused with the original's
  sentence; render caps (524,288 quads / 262,144 points) refuse the
  over-limit representation with a notice; scalar bar with the active
  variable's finite range.
- Seam reclassification like the terminal (#110): `field` leaves the
  external-content seam (`runtime: 'native'` in `panelMeta.ts`), the
  registry maps it to `FieldPane`, the placeholder loses its entry, and
  `test/security.test.ts` pins the new registry shape (external content is
  now `browser`/`synapse`/`viewer3d` only). The pane module graph contains no
  webview and no external content; the read stays inside the pinned
  `desktop:files` channel inventory (no channel list change).

## Scenario results

| Scenario | Assertion summary | Result |
| --- | --- | --- |
| T116-01 | POINT zones parse with the i-fastest ordering, BLOCK with variable-major, `F=` and `DATAPACKING=` alike; K>1 volumes read N=I·J·K values per variable; absent K defaults to 1; untitled zones default to zone-N | passed (`test/tecplot-reader.test.ts`) |
| T116-02 | Fortran `D`-exponents parse to their real value (no silent mantissa truncation) | passed |
| T116-03 | Incomplete zone bodies, malformed headers and out-of-subset FE zones are counted as omitted and never rendered; over-cap zones and the 128-zone limit are counted, not silently dropped | passed |
| T116-04 | Non-finite values are counted and excluded from the displayed range | passed |
| T116-05 | Geometry: positions are the first three variables' positional data; the layer is exactly the I×J (k=0) quads the original built; points cover all N; the color transfer reproduces the original stops with clamping and a midpoint color for non-finite input | passed (`test/field-canvas-model.test.ts`) |
| T116-06 | Surface composes depth-sorted scalar-colored quads (back-to-front, base color pinned per quad mean); wireframe composes per-edge scalar-colored strokes (start-vertex value); points compose one colored point per grid point; over-cap layers and over-cap point clouds refuse the draw honestly; the scalar bar gradient derives from the same stops as the painter | passed |
| T116-07 | Pane: honest not-ready state before login/workspace; load over `desktop:files` read; zone/variable facts displayed (`slice (2×2×1)`, active variable, mode default 实体); scalar bar shows the finite range | passed (`test/field-pane.test.tsx`) |
| T116-08 | Zone switch keeps the variable; mode switch cycles the original three representations | passed |
| T116-09 | Truncated read announced; a truncated read with zero complete zones states both facts; skipped zones and file-wide/per-zone non-finite values announced; empty parse result and wire error codes (`FILE_BINARY` et al.) map to the shared honest sentences | passed |
| T116-10 | A zone without x/y/z coordinate names is refused with the original's sentence instead of drawing a fake field | passed |
| T116-11 | Registry/security pins: external-content panes are `browser`/`synapse`/`viewer3d` only; `field` is native, wired to its own component, not the unwired placeholder; preload channel inventory unchanged | passed (`test/security.test.ts`) |

## Acceptance grading (三层验收)

- 入口恢复（layer 1）：**passed by pinning** — the `field` column keeps its
  original dock position and now carries the real pane
  (`test/security.test.ts`, `test/dock-view.test.tsx`).
- 业务接线（layer 2）：**passed by named tests** — T116-01…T116-11 above.
- 实际候选验收（layer 3）：**STAGED for the candidate package** — file-based
  scenarios ride the same guarded seam the files pane already exercises on
  the installed app; a real simulation-file walkthrough against the packaged
  app belongs to the 六期候选包 acceptance run, with the numerical-tolerance
  acceptance owned by the iDeer #127 framework per the issue.

## Known deviations (disclosed, none silent)

1. Rendering is a software 2D canvas, not vtk.js/WebGL: no new dependency,
   no provenance burden, no CSP change; interaction and modes match the
   original's three representations. The reader is a port adapted from the
   original (same parsing structure, declared fixes) — not a verbatim copy,
   hence no SHA-256 provenance entry; the source commit is pinned by
   reference in docs/porting.md.
2. The surface layer is the original's actual k=0 I×J layer; a K>1 volume
   therefore shows its k=0 plane plus all points in points mode — exactly
   what the original's own cell construction rendered. Wireframe colors each
   edge by its start vertex's value, a per-edge approximation of the
   original's per-point scalar coloring.
3. Truncated reads (1 MiB guarded preview cap) display only completely
   parsed zones with an explicit notice; the original read whole files. A
   cut that leaves no complete zone states both facts instead of a bare
   "no zones" error.
4. Files with no scalar variables beyond x/y/z are refused with an honest
   notice instead of rendering uncolored geometry.
5. Fixed render caps (524,288 quads / 262,144 points) refuse the over-limit
   representation with a notice instead of attempting an unbounded draw.
6. Conversation→pane auto-open and the panel command store are #117's scope
   (结果自动开窗), not included here.

## Executed commands

| Command | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm test` (full vitest) | 501 passed / 2 known develop load flakes (`browser-slot`, `session-sidebar`), both passing solo |
| `python scripts/verify-runtime-source.py` | passed |
| `python -m ruff check local-runtime --select E9,F63,F7,F82` | passed |
| `PYTHONPATH=local-runtime python -m pytest local-runtime/tests -q` | 911 passed, 8 skipped |
| `npm run verify:provenance` | passed |
| `npm run build` | passed |
| `npm run test:desktop` (real-Electron smoke) | STAGED for the CI Linux lane, consistent with #149/#151 practice on this shared machine; this diff touches no main-process code and no bridge key, so the smoke's pinned surface is unchanged |
