import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const banner = readFileSync('resources/compat/node16-banner.cjs', 'utf8')

describe('Node 16 compatibility banner', () => {
  it('clones cyclic data without silently returning the input', () => {
    const context = createContext({ require: createRequire(import.meta.url) })
    runInContext(banner, context)
    const value = runInContext(`
      const input = { date: new Date('2026-10-17T00:00:00Z') }
      input.self = input
      const copy = structuredClone(input);
      [copy !== input, copy.self === copy, copy.date.toISOString()]
    `, context)
    expect(Array.from(value)).toEqual([true, true, '2026-10-17T00:00:00.000Z'])
    expect(() => runInContext('structuredClone(() => {})', context)).toThrow()
  })

  it('preserves multibyte UTF-8 across chunks and flushes a trailing partial character', async () => {
    const context = createContext({ require: createRequire(import.meta.url) })
    runInContext(banner, context)
    const output = await runInContext(`(async () => {
      const stream = new TextDecoderStream()
      const writer = stream.writable.getWriter()
      const reader = stream.readable.getReader()
      const output = []
      const reading = (async () => {
        for (;;) {
          const next = await reader.read()
          if (next.done) return
          output.push(next.value)
        }
      })()
      await writer.write(new Uint8Array([0xe4, 0xbd]))
      await writer.write(new Uint8Array([0xa0, 0xe5, 0xa5, 0xbd, 0xe4]))
      await writer.close()
      await reading
      return output.join('')
    })()`, context)
    expect(output).toBe('你好�')
  })
})
