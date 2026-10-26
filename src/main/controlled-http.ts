import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs'

export interface ControlledRequestOptions {
  maxBytes: number
  timeoutMs?: number
  signal?: AbortSignal
}

/** An update address never adds credentials or leaves the paired Server. */
export function controlledOrigin(origin: string): URL {
  let base: URL
  try { base = new URL(origin) } catch { throw new Error('CONTROLLED_ORIGIN_INVALID') }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
      (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('CONTROLLED_ORIGIN_INVALID')
  }
  return new URL(base.origin)
}

async function consume(origin: string, path: string, options: ControlledRequestOptions,
    chunk: (data: Buffer) => void): Promise<void> {
  const base = controlledOrigin(origin)
  let target = new URL(path, base)
  if (target.origin !== base.origin || target.username || target.password || target.hash) throw new Error('CONTROLLED_ORIGIN_INVALID')
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new Error('CONTROLLED_LIMIT_INVALID')
  const deadline = Date.now() + (options.timeoutMs ?? 15000)
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (options.signal?.aborted) throw new Error('CONTROLLED_CANCELED')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('CONTROLLED_TIMEOUT')
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target,
      { headers: { 'Accept-Encoding': 'identity' } })
    let response: IncomingMessage | undefined
    const abort = (): void => { request.destroy(new Error('CONTROLLED_CANCELED')) }
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { request.destroy(new Error('CONTROLLED_TIMEOUT')); response?.destroy(new Error('CONTROLLED_TIMEOUT')) }, remaining)
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        request.once('response', resolve)
        request.once('error', reject)
        request.end()
      })
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        if (!response.headers.location || redirects === 3) throw new Error('CONTROLLED_REDIRECT_REJECTED')
        const next = new URL(response.headers.location, target)
        if (next.origin !== base.origin || next.username || next.password || next.hash) throw new Error('CONTROLLED_REDIRECT_REJECTED')
        response.destroy()
        target = next
        continue
      }
      if (response.statusCode !== 200) throw new Error(response.statusCode === 404 ? 'CONTROLLED_NOT_PUBLISHED' : 'CONTROLLED_SERVER_ERROR')
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('CONTROLLED_ENCODING_REJECTED')
      const length = response.headers['content-length']
      if (length && (!/^\d+$/.test(length) || Number(length) > options.maxBytes)) throw new Error('CONTROLLED_TOO_LARGE')
      let bytes = 0
      for await (const data of response) {
        if (options.signal?.aborted) throw new Error('CONTROLLED_CANCELED')
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
        bytes += buffer.length
        if (bytes > options.maxBytes) throw new Error('CONTROLLED_TOO_LARGE')
        chunk(buffer)
      }
      if (!response.complete) throw new Error('CONTROLLED_TRUNCATED')
      return
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      response?.destroy()
      request.destroy()
    }
  }
  throw new Error('CONTROLLED_REDIRECT_REJECTED')
}

export async function controlledBytes(origin: string, path: string, options: ControlledRequestOptions): Promise<Buffer> {
  const chunks: Buffer[] = []
  await consume(origin, path, options, data => chunks.push(data))
  return Buffer.concat(chunks)
}

/** Stream into a new private staging file without buffering the payload. */
export async function controlledDownload(origin: string, path: string, destination: string,
    options: ControlledRequestOptions): Promise<{ bytes: number; sha256: string }> {
  const file = openSync(destination, 'wx', 0o600)
  let bytes = 0
  const hash = createHash('sha256')
  let succeeded = false
  try {
    await consume(origin, path, options, data => {
      let offset = 0
      while (offset < data.length) offset += writeSync(file, data, offset, data.length - offset)
      bytes += data.length
      hash.update(data)
    })
    fsyncSync(file)
    succeeded = true
    return { bytes, sha256: hash.digest('hex') }
  } finally {
    closeSync(file)
    if (!succeeded) unlinkSync(destination)
  }
}
