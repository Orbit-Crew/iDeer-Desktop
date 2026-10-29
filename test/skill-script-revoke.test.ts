import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

// Issue 41: the real Runtime revoke response carries `revoked` plus the
// post-revoke grant list. Success, already-gone and unavailable paths are
// exercised against the real parsing code and a real registry — the child
// is never stubbed into answering with a bare list.
it.skipIf(process.platform !== 'win32')('revokes a real Skill script grant through the owned Runtime IPC', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'ideer-i41-script-'))
  const work = mkdtempSync(join(tmpdir(), 'ideer-i41-work-'))
  const platform = createServer((request, response) => {
    request.resume(); response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url === '/api/devices/login/start'
      ? { login_id: 'script-41' }
      : { account: { id: 'A', name: 'Synthetic A' }, device: { id: 'D', name: 'Synthetic D', owner_id: 'A' },
        business_token: 'synthetic-script-business', session_token: 'synthetic-script-device', session_id: 'session-D',
        server_public_key: 'synthetic-broker', business_expires_at: '2099-01-01T00:00:00+00:00' }))
  })
  await new Promise<void>(done => platform.listen(0, '127.0.0.1', done))
  const address = platform.address()
  if (!address || typeof address === 'string') throw new Error('No fixture listener')
  const runtime = new RuntimeProcess(resolve('.runtime'), profile)
  const config = join(profile, 'settings.json')
  const registryPath = join(profile, 'skill-scripts.db')
  const grantScript = [
    "import sys,json;from pathlib import Path;",
    "from core.settings import load_settings;",
    "from core.receipt_ledger import profile_binding;",
    "from core.skill_script import SkillScriptRegistry;",
    "binding=profile_binding(load_settings(sys.argv[1]));",
    "registry=SkillScriptRegistry(Path(sys.argv[2]));",
    "identity=registry.remember(binding,{'resource_id':'weekly-report','slug':'weekly-report','version':1,",
    "'content_hash':'a'.ljust(64,'b'),'script_path':'scripts/report.py',",
    "'script_sha256':'c'.ljust(64,'d'),'requirements_hash':'e'.ljust(64,'f')});",
    "print(json.dumps({'identity':identity,'view':registry.view(binding)}))"
  ].join('')
  try {
    await runtime.beginLogin(`http://127.0.0.1:${address.port}`, 'Synthetic D')
    await vi.waitFor(() => expect(runtime.status().login?.state).toBe('authenticated'), { timeout: 10000 })
    const grant = JSON.parse(execFileSync(resolve('.runtime/python.exe'), ['-I', '-c', grantScript, config, registryPath],
      { encoding: 'utf8', windowsHide: true }))
    expect(grant.view).toHaveLength(1)

    const listed = await runtime.skillScripts({ action: 'list' })
    expect(listed.revoked).toBeUndefined()
    expect(listed.authorizations.map(row => row.id)).toEqual([grant.identity])

    const revoked = await runtime.skillScripts({ action: 'revoke', authorizationId: grant.identity })
    expect(revoked.revoked).toBe(true)
    expect(revoked.authorizations).toEqual([])

    // Revoking the same identity again reports "already gone" as a resolved
    // false — the registry row really left the device database.
    const again = await runtime.skillScripts({ action: 'revoke', authorizationId: grant.identity })
    expect(again.revoked).toBe(false)
    expect(again.authorizations).toEqual([])

    await runtime.manage('logout')
    await vi.waitFor(() => expect(runtime.status().login?.state).toBe('unauthenticated'), { timeout: 10000 })
    await expect(runtime.skillScripts({ action: 'revoke', authorizationId: grant.identity }))
      .rejects.toThrow('SKILL_SCRIPT_UNAVAILABLE')
  } finally {
    await runtime.stop()
    execFileSync(resolve('.runtime/python.exe'), ['-I', '-c',
      "import sys;from core.settings import load_settings;from core.secrets import create_default_secret_store;s=load_settings(sys.argv[1]);store=create_default_secret_store();[store.delete(r) for r in [s.business_token_ref,s.session_token_ref,s.device_key_ref] if r.startswith('desktop-')]", config], { windowsHide: true })
    await new Promise<void>(done => platform.close(() => done()))
    rmSync(profile, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}, 45000)
