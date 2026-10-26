# Signed compatibility combinations

Generate the controlled `compatibility.json` and detached Ed25519 signature:

```powershell
& $node scripts/release/issue-110/make-compatibility.cjs --spec $spec --key $privateKey --output $controlledDirectory
```

The spec contains `version: 1`, `level`, `disabledCapabilities`, `minProtocol`,
`notes`, `candidateCombo: { desktop, runtime, server }`, and optional
`supportedCombos`. Each supported combination has the same three exact version
fields and may override `level` and `disabledCapabilities`. Runtime means the
actual Python version. Server means its deployed `SERVER_RELEASE_VERSION`.
The Runtime package's existing `runtime_version` retains its original meaning.

Desktop 0.1.0 reads only the top-level policy. To keep that client compatible
while restricting a new client, use the old combination as `candidateCombo`
with top-level `compatible`, then put Desktop 0.2.0 in `supportedCombos` with
its tested policy. The generator refuses an old-client override that disagrees
with the top-level policy. A candidate in this format is the default target,
not a claim that every client interprets the matrix.

Publish both controlled files with the deployment trust public key used by
Server and the packaged Desktop. The generator also writes a combination
record with declaration and public-key hashes. It does not publish or claim
that a matrix passed. Deploy Server first, verify the unchanged old client,
then introduce the new client and record the actual test results and package
hashes. Unverified rolling upgrades remain unsupported.
