import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RuntimeProcess } from '../src/main/runtime'

describe('restricted Desktop login boundary', () => {
  it('rejects noncanonical origins and arbitrary URLs before invoking Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-98/unused')
    for (const url of ['file:///x', 'http://platform.example', 'https://u:p@example.com', 'https://example.com/api', 'https://example.com?token=x']) {
      await expect(runtime.beginLogin(url, 'D1')).rejects.toThrow('LOGIN_ORIGIN_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })
  it('admits one browser launch for concurrent login IPC requests', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer concurrent login '))
    let starts = 0
    const platform = createServer((request, response) => {
      request.resume()
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/api/devices/login/start') {
        starts++
        response.end(JSON.stringify({ login_id: 'login-98', expires_in: 300 }))
      } else { response.statusCode = 202; response.end('{"state":"pending"}') }
    })
    await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', resolve))
    const address = platform.address()
    if (!address || typeof address === 'string') throw new Error('No test listener')
    const origin = `http://127.0.0.1:${address.port}`
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      const results = await Promise.allSettled([runtime.beginLogin(origin, 'D1'), runtime.beginLogin(origin, 'D1')])
      expect(results.filter((item) => item.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: origin + '/desktop-login?login_id=login-98' }])
      const rejected = results.find((item) => item.status === 'rejected')
      expect(rejected && rejected.status === 'rejected' && rejected.reason.message).toBe('LOGIN_IN_PROGRESS')
      expect(starts).toBe(1)
    } finally {
      await runtime.stop()
      await new Promise<void>((resolve) => platform.close(() => resolve()))
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})
