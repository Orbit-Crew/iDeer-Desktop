# Third-party notices

This application derives from LINZ by LINZ Team, repository
https://github.com/Neowyh/linz, commit
f88141bb3d3450a572fcc52e0f9b48a1e60d3b13.

That commit declares `MIT` in package.json. The exact original package.json and
package-lock.json are preserved in resources/provenance. The source tree has no
root LICENSE file. No copyright year or missing license text has been invented.
The maintainer must obtain and verify the upstream license grant and notices
before distribution. This is an unresolved release blocker.
The Desktop package is marked UNLICENSED while this verification is pending;
this does not replace or remove the upstream MIT declaration.

Copied and adapted source files, source hashes, compatibility changes and deferred
assets are listed in docs/porting.md and resources/provenance/linz-source.json.
No third-party skills, fonts or icons from linz are distributed in this baseline.
Ant Design icons are installed from the locked npm package.

Issue 115 adds the CAD viewer's bundled components; both registrations keep the
same verification duty as the linz derivation itself, and neither adds a license
grant beyond what the upstream projects declare:

- **occt-import-js** (glue `occt-import-js.js` and `occt-import-js.wasm` under
  `resources/occt/`): copied byte-for-byte from the linz commit above, with
  SHA-256 hashes pinned in resources/provenance/linz-source.json. The glue and
  WASM are build artifacts of occt-import-js
  (https://github.com/Kovacsv/occt-import-js), which linz pinned at ^0.0.23 and
  which declares the MIT license; the WASM embeds Open CASCADE Technology
  (OCCT), distributed by that project under the LGPL-2.1 with the OCCT
  development exception. The maintainer must verify both upstream grants and
  notices against the exact artifact before distribution — the release blocker
  above applies to these binaries in particular, because they are the first
  third-party binary shipped from the linz side of the derivation.
- **three.js 0.185.1** (`dependencies`, exact npm pin; renderer-side WebGL
  rendering for the CAD pane): installed from the npm registry like the other
  locked dependencies and licensed MIT upstream (https://threejs.org).
  `@types/three` 0.185.4 is a devDependency under Apache-2.0 and is not
  distributed.

Electron and installed npm dependencies retain their own licenses in the
installed packages and Electron distribution. The effective dependency set is
package-lock.json, distinct from the archived upstream lock. Build artifacts must
retain Electron's LICENSE and LICENSES.chromium.html and dependency notices.

The Python Local Runtime is copied from Orbit-Crew/iDeer commit
ccb251e07e5f5934b851e4c3df00224718f28123. Its MIT notice is retained in
local-runtime/LICENSE.upstream and shipped as runtime/LICENSE.ideer-runtime.txt.
The migration manifest and changes are recorded in docs/runtime-migration.md.
The embedded CPython and wheel distributions retain their original license
files under resources/runtime. Exact archives and hashes are recorded in
local-runtime/distribution.lock.json. This adds no license grant for linz.
