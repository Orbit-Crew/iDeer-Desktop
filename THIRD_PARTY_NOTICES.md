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
No third-party bundled binaries, skills, fonts or icons from linz are distributed
in this baseline. Ant Design icons are installed from the locked npm package.

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
