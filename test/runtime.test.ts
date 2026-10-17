import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe.skipIf(process.platform !== 'win32')('owned Runtime process', () => {
  it('starts the bundled interpreter in a spaced path and stops without a child', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer runtime test '))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      await vi.waitFor(() => expect(runtime.status().connection).toBe('not-configured'), { timeout: 10000 })
      expect(runtime.status().process).toBe('running')
      const pid = runtime.status().pid!
      await runtime.stop()
      expect(runtime.status().process).toBe('stopped')
      expect(() => process.kill(pid, 0)).toThrow()
      await runtime.start()
      await vi.waitFor(() => expect(runtime.status().process).toBe('running'), { timeout: 10000 })
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})
