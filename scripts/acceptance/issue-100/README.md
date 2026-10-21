# Issue 100 acceptance

Use the Desktop lock, Node 22, the prepared Windows `.runtime`, and the Server
candidate identified in [the report](../../../docs/acceptance/issue-100/report.md).
Apply the report's Server patch to its pinned base before starting the fixture.
Install Server's dependencies with `uv sync --locked`. The Server checkout and
fixture state must be isolated from production data.

The fixture uses real authentication, four-step device pairing, published
Agents, canonical Runs, signed broker tasks and Windows file operations. Only
the Server model is deterministic. It requests the predefined operation instead
of contacting a provider. The native directory picker and confirmation callbacks
return synthetic paths and consent; Playwright clicks the actual Desktop button
and checks the real confirmation options. This is automated UI coverage, not a
record of a person operating Windows dialogs.

Start the Gateway in a separate terminal with its locked Linux Python. Both
state directories below must be new. `DesktopState` must also be accessible from
Windows; WSL uses its `/mnt/c/...` equivalent.

```bash
<ServerPython> scripts/acceptance/issue-100/server_fixture.py \
  --server-root <ServerCheckout> --state <FreshServerState> \
  --desktop-state <FreshDesktopState>
```

After `READY`, prepare the isolated A/D1 and B/D2 credentials and profiles from
the Desktop root. These six Credential Manager entries belong to this fixture;
no credential values are written to the evidence.

```powershell
& .runtime/python.exe -I scripts/acceptance/issue-100/profiles.py prepare <DesktopState>
```

For a built development app, run `node scripts/acceptance/issue-100/desktop.cjs
<DesktopState>`. For the installed candidate, first obtain explicit current-user
installation acceptance authorization. The following command temporarily moves
the existing Runtime profile, checks exclusive ownership, runs synthetic file
acceptance, restores the profile and compares every original file hash.

```powershell
& scripts/acceptance/issue-100/installed.ps1 -State <DesktopState> `
  -Executable 'D:\software\iDeer Desktop\ideer-desktop\ideer-desktop.exe'
```

The script refuses a concurrent Desktop. Normal completion removes the six
temporary credentials, stops the fixture Gateway, removes the unique workspace
fixtures and leaves the installed app closed. If interrupted, inspect the
ownership marker and backup before touching a profile. Never delete a backup
whose restoration has not been verified. `profiles.py cleanup <DesktopState>`
deletes only the entries enumerated in that fixture's ledger.

T100-01 checks the exact consent text, logical directory, Resource list and
upload endpoint summary. T100-02 compares list/read/search with independent
constants, then queries every Local Task through the public API using archived
Run receipt IDs. T100-03 checks protected, outside, junction and symlink paths,
platform denial, local DENY and unchanged file hashes. T100-04 holds a model
request before dispatch, switches directory, checks stale roots and the old
direct Server route, switches identity and restarts the original identity.
Individual waits are 60 seconds; the held request expires after 45 seconds.

When Win32 symbolic-link creation lacks privilege, the fixture creates an actual
NTFS LX symlink through WSL and records that flavor explicitly. It never calls
the missing Win32-privilege scenario passed. Runtime contract tests also cover
reparse flags before file resolution.

After successful completion, collect the allowlisted evidence. This compares
all prepared Runtime files and the unpacked ASAR with the installed payload,
records source fingerprints, strips personal retention paths, and excludes
profiles, databases, cookies, tokens, credential references and private keys.

```powershell
python scripts/acceptance/issue-100/collect_evidence.py `
  --state <DesktopState> --installed 'D:\software\iDeer Desktop\ideer-desktop'
```

Run the Desktop static, test, provenance and distribution commands in the report.
Run Server's actual standard/contract/integration gates and protected Real E2E
selection as recorded there. A model fixture does not replace those gates.
Windows 7 remains unexecuted under issue #131.
