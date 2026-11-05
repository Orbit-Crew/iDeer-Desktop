// Issue 109: the remote browser entry's Desktop-side contract. The platform
// browser stream (backend browser.py @ a7037c3f) is proxied by the bundled
// Runtime; these pin the main-process seam in the files-bridge fence pattern:
// command shape first, then availability, then identity; the wire event
// projection stays bounded; and a remote download is retrieved only through
// the explicit, dialog-gated artifact path (bytes never reach the renderer).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'
import {
  RemoteBrowserHub,
  parseRemoteBrowserStreamWire,
  validateRemoteBrowserCommand
} from '../src/main/remoteBrowser'
import type { RemoteBrowserCommand, RemoteBrowserEvent, RemoteBrowserInputEvent } from '../src/shared/desktop'

function unavailableRuntime(): RuntimeProcess {
  // No child ever starts: every shape-valid call must end unavailable.
  return new RuntimeProcess('does-not-matter', 'does-not-matter')
}

const validInput: RemoteBrowserInputEvent = { type: 'click', x: 10, y: 20 }

describe('remote browser runtime wire gate (issue 109)', () => {
  it('rejects unknown command kinds before anything else', async () => {
    const runtime = unavailableRuntime()
    await expect(runtime.remoteBrowser({ kind: 'drag' } as never)).rejects.toThrow('REMOTE_BROWSER_COMMAND_INVALID')
  })

  it('rejects malformed open shapes before checking availability', async () => {
    const runtime = unavailableRuntime()
    const bad = ['', 'thread/../x', 'a'.repeat(129), 5]
    for (const threadId of bad) {
      await expect(runtime.remoteBrowser({ kind: 'stream', action: 'open', threadId: threadId as string, scope: 's'.repeat(8) }))
        .rejects.toThrow('REMOTE_BROWSER_COMMAND_INVALID')
    }
    await expect(runtime.remoteBrowser({ kind: 'stream', action: 'open', threadId: 't1', scope: '' }))
      .rejects.toThrow('REMOTE_BROWSER_COMMAND_INVALID')
    await expect(runtime.remoteBrowser({ kind: 'stream', action: 'open', threadId: 't1', scope: 's'.repeat(129) }))
      .rejects.toThrow('REMOTE_BROWSER_COMMAND_INVALID')
  })

  it('rejects malformed input events before checking availability', async () => {
    const runtime = unavailableRuntime()
    const bad: unknown[] = [
      { type: 'drag', x: 1, y: 1 },
      { type: 'click', x: 'a', y: 1 },
      { type: 'click', x: 1e9, y: 1 },
      { type: 'text', text: '' },
      { type: 'text', text: 'x'.repeat(1025) },
      { type: 'navigate', url: '' },
      { type: 'wheel', dx: 1 },
      { type: 'activate_tab', index: -1 },
      { type: 'key', key: 'k'.repeat(65) },
      'click'
    ]
    for (const event of bad) {
      await expect(runtime.remoteBrowser({ kind: 'input', streamId: 'st1', event: event as RemoteBrowserInputEvent }))
        .rejects.toThrow('REMOTE_BROWSER_COMMAND_INVALID')
    }
  })

  it('answers shape-valid commands with the availability fence', async () => {
    const runtime = unavailableRuntime()
    await expect(runtime.remoteBrowser({ kind: 'stream', action: 'open', threadId: 't1', scope: 'scope' }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.remoteBrowser({ kind: 'stream', action: 'close' })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.remoteBrowser({ kind: 'input', streamId: 'st1', event: validInput }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
  })
})

describe('remote browser wire event projection (issue 109)', () => {
  it('parses every platform event kind into a bounded view', () => {
    expect(parseRemoteBrowserStreamWire({ v: 1, type: 'browser-stream-event', streamId: 'st1',
      event: { kind: 'state', state: 'open' } })).toEqual({ streamId: 'st1', event: { kind: 'state', state: 'open' } })
    expect(parseRemoteBrowserStreamWire({ v: 1, type: 'browser-stream-event', streamId: 'st1',
      event: { kind: 'state', state: 'closed', code: 4404, category: 'THREAD_UNAVAILABLE' } }))
      .toEqual({ streamId: 'st1', event: { kind: 'state', state: 'closed', code: 4404, category: 'THREAD_UNAVAILABLE' } })
    expect(parseRemoteBrowserStreamWire({ v: 1, type: 'browser-stream-event', streamId: 'st1',
      event: { kind: 'frame', data: 'aGVsbG8=' } }))
      .toEqual({ streamId: 'st1', event: { kind: 'frame', data: 'aGVsbG8=' } })
    expect(parseRemoteBrowserStreamWire({ v: 1, type: 'browser-stream-event', streamId: 'st1',
      event: { kind: 'url', url: 'https://example.test/a' } }))
      .toEqual({ streamId: 'st1', event: { kind: 'url', url: 'https://example.test/a' } })
    expect(parseRemoteBrowserStreamWire({ v: 1, type: 'browser-stream-event', streamId: 'st1',
      event: { kind: 'tabs', tabs: [{ index: 0, title: 't', url: 'https://e.test', active: true }] } })).toBeTruthy()
    expect(parseRemoteBrowserStreamWire({ v: 1, type: 'browser-stream-event', streamId: 'st1',
      event: { kind: 'nav-rejected', url: 'https://intranet.test/x', message: 'not allowed' } }))
      .toEqual({ streamId: 'st1', event: { kind: 'nav-rejected', url: 'https://intranet.test/x', message: 'not allowed' } })
    expect(parseRemoteBrowserStreamWire({ v: 1, type: 'browser-stream-event', streamId: 'st1',
      event: { kind: 'stream-error', category: 'CONNECTION_FAILED', message: 'reset' } })).toBeTruthy()
  })

  it('rejects malformed or oversized wire events so they never reach the renderer', () => {
    const base = { v: 1, type: 'browser-stream-event', streamId: 'st1' }
    expect(parseRemoteBrowserStreamWire({ ...base, event: { kind: 'frame', data: 'not base64!' } })).toBeNull()
    expect(parseRemoteBrowserStreamWire({ ...base, event: { kind: 'frame', data: 'a'.repeat(4_000_001) } })).toBeNull()
    expect(parseRemoteBrowserStreamWire({ ...base, event: { kind: 'state', state: 'paused' } })).toBeNull()
    expect(parseRemoteBrowserStreamWire({ ...base, event: { kind: 'state', state: 'closed', code: 99 } })).toBeNull()
    expect(parseRemoteBrowserStreamWire({ ...base, event: { kind: 'url', url: 'u'.repeat(2049) } })).toBeNull()
    expect(parseRemoteBrowserStreamWire({ ...base,
      event: { kind: 'tabs', tabs: Array.from({ length: 21 }, (_, index) => ({ index, title: '', url: '', active: false })) } })).toBeNull()
    expect(parseRemoteBrowserStreamWire({ ...base, streamId: 's'.repeat(65), event: { kind: 'url', url: 'https://e.test' } })).toBeNull()
    expect(parseRemoteBrowserStreamWire({ ...base, event: { kind: 'nav-rejected', url: '', message: '' } })).toBeNull()
    expect(parseRemoteBrowserStreamWire({ v: 2, type: 'browser-stream-event', streamId: 'st1', event: { kind: 'url', url: 'https://e.test' } })).toBeNull()
    expect(parseRemoteBrowserStreamWire({ ...base, event: { kind: 'url', url: 'https://e.test', extra: 1 } })).toBeNull()
  })
})

interface FakeRuntime {
  status: () => { login?: { state: string } }
  remoteBrowser: ReturnType<typeof vi.fn>
  chat: ReturnType<typeof vi.fn>
}

function fakeRuntime(authenticated = true): FakeRuntime {
  return {
    status: () => ({ login: { state: authenticated ? 'authenticated' : 'unauthenticated' } as never }),
    remoteBrowser: vi.fn(async () => ({ streamId: 'st-1' })),
    chat: vi.fn()
  }
}

function hubOver(fake: FakeRuntime, pushes: RemoteBrowserEvent[] = [], chooser?: (name: string) => Promise<string | undefined>): RemoteBrowserHub {
  return new RemoteBrowserHub(fake as never, { push: (event) => pushes.push(event) }, chooser ?? (async () => undefined))
}

describe('remote browser hub (issue 109)', () => {
  it('refuses to open a stream without an authenticated platform identity', async () => {
    const fake = fakeRuntime(false)
    const hub = hubOver(fake)
    await expect(hub.handle({ action: 'open', threadId: 't1', scope: 'scope' })).rejects.toThrow('REMOTE_BROWSER_UNAUTHENTICATED')
    expect(fake.remoteBrowser).not.toHaveBeenCalled()
  })

  it('opens the one stream through the runtime wire and remembers it', async () => {
    const fake = fakeRuntime()
    const hub = hubOver(fake)
    await expect(hub.handle({ action: 'open', threadId: 't1', scope: 'scope' })).resolves.toEqual({ streamId: 'st-1' })
    expect(fake.remoteBrowser).toHaveBeenCalledWith({ kind: 'stream', action: 'open', threadId: 't1', scope: 'scope' })
    await expect(hub.handle({ action: 'input', event: validInput })).resolves.toEqual({ acknowledged: true })
    expect(fake.remoteBrowser).toHaveBeenLastCalledWith({ kind: 'input', streamId: 'st-1', event: validInput })
  })

  it('replaces an active stream explicitly instead of switching silently', async () => {
    const fake = fakeRuntime()
    const pushes: RemoteBrowserEvent[] = []
    const hub = hubOver(fake, pushes)
    await hub.handle({ action: 'open', threadId: 't1', scope: 'scope' })
    fake.remoteBrowser.mockImplementation(async (command: { kind: string; action?: string }) =>
      command.kind === 'stream' && command.action === 'open' ? { streamId: 'st-2' } : { acknowledged: true })
    await hub.handle({ action: 'open', threadId: 't2', scope: 'scope' })
    expect(fake.remoteBrowser).toHaveBeenNthCalledWith(2, { kind: 'stream', action: 'close' })
    expect(pushes).toContainEqual({ kind: 'state', state: 'closed', code: 1000, category: 'REPLACED' })
    expect(hub.activeStreamId()).toBe('st-2')
  })

  it('refuses input forwarding while no stream is open', async () => {
    const hub = hubOver(fakeRuntime())
    await expect(hub.handle({ action: 'input', event: validInput })).rejects.toThrow('REMOTE_BROWSER_STREAM_NOT_OPEN')
  })

  it('clears the active stream when the runtime reports a closed stream', () => {
    const hub = hubOver(fakeRuntime())
    hub.onRuntimeEvent({ streamId: 'st-1', event: { kind: 'state', state: 'open' } })
    expect(hub.activeStreamId()).toBe('st-1')
    hub.onRuntimeEvent({ streamId: 'st-1', event: { kind: 'state', state: 'closed', code: 1000, category: 'CLOSED' } })
    expect(hub.activeStreamId()).toBeNull()
  })

  it('forwards every parsed runtime event to the renderer push', () => {
    const pushes: RemoteBrowserEvent[] = []
    const hub = hubOver(fakeRuntime(), pushes)
    hub.onRuntimeEvent({ streamId: 'st-1', event: { kind: 'frame', data: 'aGVsbG8=' } })
    expect(pushes).toEqual([{ kind: 'frame', data: 'aGVsbG8=' }])
  })

  it('rejects commands that are not one of the four fixed shapes', async () => {
    const hub = hubOver(fakeRuntime())
    const bad: unknown[] = [
      { action: 'navigate', url: 'https://e.test' },
      { action: 'open', threadId: '../x', scope: 'scope' },
      { action: 'retrieve', threadId: 't1', artifactId: '../y', scope: 'scope' },
      { action: 'input', event: { type: 'drop' } },
      'open'
    ]
    for (const command of bad) await expect(hub.handle(command)).rejects.toThrow('REMOTE_BROWSER_COMMAND_INVALID')
  })
})

describe('remote browser explicit retrieval (issue 109)', () => {
  const artifact = { artifact_id: 'af1', name: 'report.png', sha256: '', bytes: 0 }
  const downloadPayload = {
    ...artifact,
    bytes: 5,
    sha256: '5d41402abc4b2a76b9719d911017c592',
    content: Buffer.from('hello').toString('base64')
  }
  // sha256('hello') for integrity re-check inside downloadThreadArtifact:
  const realSha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  downloadPayload.sha256 = realSha

  it('retrieves only through the artifact path and lands the file after the dialog', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ideer remote retrieve '))
    try {
      const fake = fakeRuntime()
      fake.chat.mockImplementation(async (command: { action: string }) => {
        if (command.action === 'download') {
          expect(command).toMatchObject({ action: 'download', threadId: 't1', artifactId: 'af1', scope: 'scope' })
          return { scope: 'scope', error: '', download: downloadPayload } as never
        }
        // downloadThreadArtifact re-checks the identity with a state snapshot
        // after the dialog; answer it with the same scope.
        return { scope: 'scope', error: '' } as never
      })
      const destination = join(directory, 'report.png')
      const hub = hubOver(fake, [], async () => destination)
      await expect(hub.handle({ action: 'retrieve', threadId: 't1', artifactId: 'af1', scope: 'scope' }))
        .resolves.toEqual({ status: 'saved' })
      expect(readFileSync(destination, 'utf8')).toBe('hello')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('reports a cancelled dialog as cancelled without writing anything', async () => {
    const fake = fakeRuntime()
    fake.chat.mockResolvedValue({ scope: 'scope', error: '', download: downloadPayload } as never)
    const hub = hubOver(fake, [], async () => undefined)
    await expect(hub.handle({ action: 'retrieve', threadId: 't1', artifactId: 'af1', scope: 'scope' }))
      .resolves.toEqual({ status: 'cancelled' })
  })

  it("surfaces the runtime's own refusal category instead of inventing one", async () => {
    const fake = fakeRuntime()
    fake.chat.mockResolvedValue({ scope: 'scope', error: 'CHAT_ARTIFACT_NOT_FOUND' } as never)
    const hub = hubOver(fake, [], async () => 'unused')
    await expect(hub.handle({ action: 'retrieve', threadId: 't1', artifactId: 'af1', scope: 'scope' }))
      .rejects.toThrow('CHAT_ARTIFACT_NOT_FOUND')
  })
})

describe('renderer command shape gate (issue 109)', () => {
  it('accepts the four fixed commands and rejects everything else', () => {
    expect(validateRemoteBrowserCommand({ action: 'close' })).toEqual({ action: 'close' })
    expect(validateRemoteBrowserCommand({ action: 'open', threadId: 't1', scope: 'scope' }))
      .toEqual({ action: 'open', threadId: 't1', scope: 'scope' })
    expect(validateRemoteBrowserCommand({ action: 'input', event: validInput })).toEqual({ action: 'input', event: validInput })
    expect(validateRemoteBrowserCommand({ action: 'retrieve', threadId: 't1', artifactId: 'af1', scope: 'scope' }))
      .toEqual({ action: 'retrieve', threadId: 't1', artifactId: 'af1', scope: 'scope' })
    const bad: unknown[] = [
      { action: 'open', threadId: 't1' },
      { action: 'open', threadId: 't1', scope: 'scope', extra: 1 },
      { action: 'input' },
      { action: 'retrieve', threadId: 't1', artifactId: 'a', scope: '' },
      null,
      7
    ]
    for (const command of bad) expect(() => validateRemoteBrowserCommand(command)).toThrow('REMOTE_BROWSER_COMMAND_INVALID')
  })
})

describe('shared command vocabulary (issue 109)', () => {
  it('keeps the bridge command type and the hub gate aligned', () => {
    const commands: RemoteBrowserCommand[] = [
      { action: 'open', threadId: 't1', scope: 'scope' },
      { action: 'close' },
      { action: 'input', event: validInput },
      { action: 'retrieve', threadId: 't1', artifactId: 'af1', scope: 'scope' }
    ]
    for (const command of commands) expect(validateRemoteBrowserCommand(command)).toEqual(command)
  })
})
