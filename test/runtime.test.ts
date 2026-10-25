import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe.skipIf(process.platform !== 'win32')('owned Runtime process', () => {
  const directory = process.env.IDEER_TEST_PYTHON ? dirname(process.env.IDEER_TEST_PYTHON) : resolve('.runtime')
  it('starts a fenced maintenance Runtime, verifies real interpreter echo, and confirms graceful process exit', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer maintenance runtime '))
    const runtime = new RuntimeProcess(directory, profile, true)
    try {
      await runtime.start()
      await vi.waitFor(() => expect(runtime.status().process).toBe('running'), { timeout: 10000 })
      expect(runtime.status()).toMatchObject({ installDrain: true, activeTasks: 0, unknownWriteEffects: 0 })
      const health = await runtime.health()
      expect(health).toEqual({ v: 1, type: 'health', id: expect.any(String), echo: 'ideer-update-health-v1', python: '3.12.10', pid: runtime.status().pid })
      const pid = health.pid
      await runtime.installDrain('abort')
      await vi.waitFor(() => expect(runtime.status().installDrain).toBe(false))
      await runtime.installDrain('begin')
      await vi.waitFor(() => expect(runtime.status().installDrain).toBe(true))
      await runtime.stopForInstall()
      expect(runtime.status().process).toBe('stopped')
      expect(() => process.kill(pid, 0)).toThrow()
      await runtime.start()
      await vi.waitFor(() => expect(runtime.status().process).toBe('running'), { timeout: 10000 })
      expect(runtime.status().installDrain).toBe(false)
    } finally { await runtime.stop(); rmSync(profile, { recursive: true, force: true }) }
  }, 25000)
  it('starts the bundled interpreter in a spaced path and stops without a child', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer runtime test '))
    const runtime = new RuntimeProcess(directory, profile)
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

  it('preserves Unicode and embedded CRLF through the bundled JSON control pipe', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer unicode runtime test '))
    const runtime = new RuntimeProcess(directory, profile)
    const names: string[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (request.url === '/api/devices/login/start') names.push(body.name)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(request.url === '/api/devices/login/start' ? { login_id: 'unicode-test' } : { state: 'pending' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server has no TCP address')
    const origin = `http://127.0.0.1:${address.port}`
    const name = '中文设备\r\n第二行🙂'
    try {
      expect(await runtime.beginLogin(origin, name)).toBe(`${origin}/desktop-login?login_id=unicode-test`)
      expect(names).toEqual([name])
      await vi.waitFor(() => expect(runtime.status().login?.device).toBe(name))
    } finally {
      await runtime.stop()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})
