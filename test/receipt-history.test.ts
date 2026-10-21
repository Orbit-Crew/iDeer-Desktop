import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    const settings = { server_url: 'https://fixture.invalid', user_id: 'A', device_id: 'D', device_public_key: 'public-D', server_public_key: 'public-broker' }
    writeFileSync(join(profile, 'settings.json'), JSON.stringify(settings))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      await vi.waitFor(() => expect(runtime.receiptOwnershipScope()).not.toBe(''), { timeout: 10000 })
      const originalScope = runtime.receiptOwnershipScope()
      writeFileSync(join(profile, 'settings.json'), JSON.stringify({ ...settings, user_id: 'B' }))
      // Main still has A's last status; Runtime must recheck before clearing B.
      await expect(runtime.receipts('clear-confirmed', 0, originalScope)).rejects.toThrow('RECEIPT_BINDING_CHANGED')
      await vi.waitFor(() => expect(runtime.receiptOwnershipScope()).not.toBe(originalScope), { timeout: 10000 })
      await expect(runtime.receipts('clear-confirmed', 0, originalScope)).rejects.toThrow('RECEIPT_BINDING_CHANGED')
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})
