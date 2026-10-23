# UTF-8 control pipe regression

The real bundled Python subprocess probe in `probe.cjs` uses the same isolated startup and environment allowlist as RuntimeProcess. `probe.json` records both results on this Windows installation. Without `-X utf8`, stdin and stdout use GBK, `sys.flags.utf8_mode` is 0, and the literal Chinese/emoji/CRLF content acquires surrogate code points. With the flag, both streams use UTF-8, UTF-8 mode is 1, the content matches exactly, and no surrogate occurs.

The maintained integration test in `test/runtime.test.ts` starts the actual bundled interpreter through RuntimeProcess and sends a Chinese device name containing an internal CRLF and emoji through its JSON control pipe. A temporary HTTP login service checks the actual received name, and the public Runtime status checks the returned name. No pairing completes and no credential is saved. The test deletes its temporary profile and stops its subprocess and server.

`red-network.log` and `.json` record the pre-fix failure: the temporary service receives corrupt text. `green-network.log` and `.json` record both Runtime process tests passing after adding the explicit startup flag. Both use an unsandboxed local loopback socket, because the sandbox rejects Python socket access with WinError 10013. The first `red` and `green` recordings preserve that environmental failure and are not claimed as the semantic regression result.

`typecheck-node` and `typecheck-web` both pass. The earlier `typecheck` recording preserves a relative `.cmd` launcher failure and is superseded by those direct Node/TypeScript commands. This directory contains focused fix evidence, not a full acceptance result.

No bundled Python source changed, so the archived Server Runtime source provenance remains unchanged. The production change is the Desktop-owned executable argument list. It retains isolated startup and does not depend on `PYTHONUTF8`, which isolation ignores.
