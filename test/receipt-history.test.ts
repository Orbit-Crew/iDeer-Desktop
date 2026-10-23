import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe.skipIf(process.platform !== 'win32')('Desktop receipt history IPC', () => {
  it('opens durable history and clears only confirmed records', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer receipts 101 '))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      await vi.waitFor(() => expect(runtime.status().process).toBe('running'), { timeout: 10000 })
      const history = await runtime.receipts('history')
      expect(history).toMatchObject({ total: 0, pending: 0, confirmed: 0, uncertain: 0, cleaned: 0, rows: [], storageError: '' })
      await expect(runtime.receipts('clear-confirmed')).rejects.toThrow('RECEIPT_BINDING_CHANGED')
      await expect(runtime.receipts('execute' as 'history')).rejects.toThrow('RECEIPT_ACTION_INVALID')
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
  it('rejects an old cleanup confirmation after the current profile changes', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer receipt ownership 101 '))
    const platform = createServer((request, response) => {
      request.resume()
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(request.url === '/api/devices/login/start'
        ? { login_id: 'receipt-103', expires_in: 300 }
        : { account: { id: 'A', name: 'Synthetic A' }, device: { id: 'D', name: 'Synthetic D', owner_id: 'A' },
          business_token: 'synthetic-business-103', session_token: 'synthetic-device-103', session_id: 'session-D',
          server_public_key: 'public-broker', business_expires_at: '2099-01-01T00:00:00+00:00' }))
    })
    await new Promise<void>(done => platform.listen(0, '127.0.0.1', done))
    const address = platform.address()
    if (!address || typeof address === 'string') throw new Error('No fixture listener')
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      await runtime.beginLogin(`http://127.0.0.1:${address.port}`, 'Synthetic D')
      await vi.waitFor(() => expect(runtime.receiptOwnershipScope()).not.toBe(''), { timeout: 10000 })
      const originalScope = runtime.receiptOwnershipScope()
      const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
      writeFileSync(join(profile, 'settings.json'), JSON.stringify({ ...settings, user_id: 'B' }))
      // Main still has A's last status; Runtime must recheck before clearing B.
      await expect(runtime.receipts('clear-confirmed', 0, originalScope)).rejects.toThrow('RECEIPT_BINDING_CHANGED')
      await vi.waitFor(() => expect(runtime.receiptOwnershipScope()).not.toBe(originalScope), { timeout: 10000 })
      await expect(runtime.receipts('clear-confirmed', 0, originalScope)).rejects.toThrow('RECEIPT_BINDING_CHANGED')
    } finally {
      await runtime.stop()
      execFileSync(resolve('.runtime/python.exe'), ['-I', '-c',
        "import sys;from core.settings import load_settings;from core.secrets import create_default_secret_store;s=load_settings(sys.argv[1]);store=create_default_secret_store();[store.delete(r) for r in [s.business_token_ref,s.session_token_ref,s.device_key_ref] if r.startswith('desktop-')]",
        join(profile, 'settings.json')], { windowsHide: true })
      await new Promise<void>(done => platform.close(() => done()))
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})
