import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { controlledBytes } from '../src/main/controlled-http'

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void,
    test: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await test(`http://127.0.0.1:${(server.address() as { port: number }).port}`) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

describe('controlled update HTTP boundary', () => {
  it('follows a same-origin redirect and refuses every cross-origin redirect before making the request', async () => {
    let foreignRequests = 0
    await serve((_request, response) => { foreignRequests++; response.end('FOREIGN') }, async foreign => {
      await serve((request, response) => {
        if (request.url === '/same') { response.writeHead(302, { location: '/ok' }); response.end() }
        else if (request.url === '/foreign') { response.writeHead(302, { location: foreign + '/payload' }); response.end() }
        else response.end('VERIFIED')
      }, async origin => {
        expect((await controlledBytes(origin, '/same', { maxBytes: 8 })).toString()).toBe('VERIFIED')
        await expect(controlledBytes(origin, '/foreign', { maxBytes: 8 })).rejects.toThrow('CONTROLLED_REDIRECT_REJECTED')
      })
    })
    expect(foreignRequests).toBe(0)
  })

  it('rejects oversized chunked responses while reading and enforces one deadline for the body', async () => {
    await serve((request, response) => {
      if (request.url === '/large') { response.write('1234'); response.end('5678') }
      else { response.write('1') }
    }, async origin => {
      await expect(controlledBytes(origin, '/large', { maxBytes: 5 })).rejects.toThrow('CONTROLLED_TOO_LARGE')
      await expect(controlledBytes(origin, '/slow', { maxBytes: 8, timeoutMs: 80 })).rejects.toThrow('CONTROLLED_TIMEOUT')
    })
  })
})
