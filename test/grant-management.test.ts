import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

it.skipIf(process.platform !== 'win32')('revokes a real saved directory grant through the owned Runtime IPC', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'ideer-t103-management-'))
  const work = mkdtempSync(join(tmpdir(), 'ideer-t103-work-'))
  const platform = createServer((request, response) => {
    request.resume(); response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url === '/api/devices/login/start'
      ? { login_id: 'manage-103' }
      : { account: { id: 'A', name: 'Synthetic A' }, device: { id: 'D', name: 'Synthetic D', owner_id: 'A' },
        business_token: 'synthetic-management-business', session_token: 'synthetic-management-device', session_id: 'session-D',
        server_public_key: 'synthetic-broker', business_expires_at: '2099-01-01T00:00:00+00:00' }))
  })
  await new Promise<void>(done => platform.listen(0, '127.0.0.1', done))
  const address = platform.address()
  if (!address || typeof address === 'string') throw new Error('No fixture listener')
  const runtime = new RuntimeProcess(resolve('.runtime'), profile)
  const config = join(profile, 'settings.json')
  try {
    await runtime.beginLogin(`http://127.0.0.1:${address.port}`, 'Synthetic D')
    await vi.waitFor(() => expect(runtime.status().login?.state).toBe('authenticated'), { timeout: 10000 })
    const grant = JSON.parse(execFileSync(resolve('.runtime/python.exe'), ['-I', '-c',
      "import sys,json;from pathlib import Path;from core.file_service import WorkspaceSelection,WorkspaceFileService;p=Path(sys.argv[1]);w=Path(sys.argv[2]);s=WorkspaceSelection(p/'settings.json');root=s.select(w,confirmed=True)['logicalRoot'];g=WorkspaceFileService(s).remember_consent({'arguments':{'path':root+'/new.txt','content':'AFTER'}});print(json.dumps(g))",
      profile, work], { encoding: 'utf8', windowsHide: true }))
    await vi.waitFor(() => expect(runtime.status().directoryGrants?.[0].id).toBe(grant.id), { timeout: 10000 })
    await runtime.manage('revoke', grant.id)
    await vi.waitFor(() => expect(runtime.status().directoryGrants).toEqual([]), { timeout: 10000 })
    expect(JSON.parse(readFileSync(config, 'utf8')).directory_grants[0].revoked_at).not.toBe('')
    await runtime.manage('logout')
    await vi.waitFor(() => expect(runtime.status().login?.state).toBe('unauthenticated'), { timeout: 10000 })
    expect(runtime.receiptOwnershipScope()).toBe('')
  } finally {
    await runtime.stop()
    execFileSync(resolve('.runtime/python.exe'), ['-I', '-c',
      "import sys;from core.settings import load_settings;from core.secrets import create_default_secret_store;s=load_settings(sys.argv[1]);store=create_default_secret_store();[store.delete(r) for r in [s.business_token_ref,s.session_token_ref,s.device_key_ref] if r.startswith('desktop-')]", config], { windowsHide: true })
    await new Promise<void>(done => platform.close(() => done()))
    rmSync(profile, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}, 30000)
