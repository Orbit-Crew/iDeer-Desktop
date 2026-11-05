// Issue 109: the remote browser entry's trusted seam. The platform's live
// browser stream (backend browser.py @ a7037c3f) is reached only through the
// bundled Runtime: the stream socket itself, its access-token cookie and the
// paired origin all stay inside the Python Runtime, exactly like every other
// platform connection. This module owns three bounded facts on the Electron
// side: the command shape gate, the wire-event projection (frames are base64
// JPEG pixels, everything else is a bounded display fact), and the stream
// lifecycle — one stream at a time, a replacement is an explicit event, and
// a remote download is retrieved only through the artifact path with the
// native save dialog, so the bytes never enter the renderer.
import type { ChatCommand, ChatSnapshot, RemoteBrowserCommand, RemoteBrowserEvent, RemoteBrowserInputEvent, RuntimeStatus } from '../shared/desktop'
import { downloadThreadArtifact } from './artifact-download'

/** One input event, shape-checked before it may ride the wire. Bounds mirror
 * the shared vocabulary; the server re-validates navigate URLs itself and
 * answers nav_rejected, which we surface verbatim instead of retrying. */
export function validateRemoteBrowserInput(event: unknown): RemoteBrowserInputEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
  const candidate = event as Record<string, unknown>
  const coordinate = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000) {
      throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
    }
    return value
  }
  const boundedText = (value: unknown, max: number): string => {
    if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
    return value
  }
  const button = (value: unknown): 'left' | 'right' | 'middle' | undefined => {
    if (value === undefined) return undefined
    if (value === 'left' || value === 'right' || value === 'middle') return value
    throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
  }
  switch (candidate.type) {
    case 'move':
      if (Object.keys(candidate).length !== 3) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      return { type: 'move', x: coordinate(candidate.x), y: coordinate(candidate.y) }
    case 'down':
    case 'up':
    case 'click': {
      const keys = Object.keys(candidate).length
      if (keys !== 3 && keys !== 4) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      const result: RemoteBrowserInputEvent = { type: candidate.type, x: coordinate(candidate.x), y: coordinate(candidate.y) }
      const chosen = button(candidate.button)
      if (chosen) (result as { button?: 'left' | 'right' | 'middle' }).button = chosen
      return result
    }
    case 'wheel':
      if (Object.keys(candidate).length !== 3) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      return { type: 'wheel', dx: coordinate(candidate.dx), dy: coordinate(candidate.dy) }
    case 'key':
      if (Object.keys(candidate).length !== 2) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      return { type: 'key', key: boundedText(candidate.key, 64) }
    case 'text':
      if (Object.keys(candidate).length !== 2) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      return { type: 'text', text: boundedText(candidate.text, 1024) }
    case 'navigate':
      if (Object.keys(candidate).length !== 2) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      return { type: 'navigate', url: boundedText(candidate.url, 2048) }
    case 'back':
    case 'forward':
      if (Object.keys(candidate).length !== 1) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      return { type: candidate.type }
    case 'activate_tab':
      if (Object.keys(candidate).length !== 2 || typeof candidate.index !== 'number' ||
          !Number.isSafeInteger(candidate.index) || candidate.index < 0 || candidate.index > 10000) {
        throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      }
      return { type: 'activate_tab', index: candidate.index }
    default:
      throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
  }
}

const boundedId = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(value)) {
    throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
  }
  return value
}

const boundedScope = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
  return value
}

/** The renderer-facing command gate: exactly four fixed shapes. */
export function validateRemoteBrowserCommand(raw: unknown): RemoteBrowserCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
  const command = raw as Record<string, unknown>
  switch (command.action) {
    case 'open':
      if (Object.keys(command).length !== 3) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      return { action: 'open', threadId: boundedId(command.threadId, 128), scope: boundedScope(command.scope) }
    case 'close':
      if (Object.keys(command).length !== 1) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      return { action: 'close' }
    case 'input':
      if (Object.keys(command).length !== 2) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      return { action: 'input', event: validateRemoteBrowserInput(command.event) }
    case 'retrieve':
      if (Object.keys(command).length !== 4) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      return { action: 'retrieve', threadId: boundedId(command.threadId, 128),
        artifactId: boundedId(command.artifactId, 128), scope: boundedScope(command.scope) }
    default:
      throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const MAX_FRAME_BASE64 = 4_000_000

/** Projects one Runtime push line into the renderer event. Returns null for
 * any malformed or oversized payload — the caller treats that as the wire
 * protocol failing and kills the child, the same as every other family. */
export function parseRemoteBrowserStreamWire(value: unknown): { streamId: string; event: RemoteBrowserEvent } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const wire = value as Record<string, unknown>
  if (wire.v !== 1 || wire.type !== 'browser-stream-event') return null
  const streamId = wire.streamId
  if (typeof streamId !== 'string' || streamId.length < 1 || streamId.length > 64) return null
  const event = wire.event
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const payload = event as Record<string, unknown>
  const text = (input: unknown, min: number, max: number): string | null =>
    typeof input === 'string' && input.length >= min && input.length <= max ? input : null
  switch (payload.kind) {
    case 'state': {
      if (Object.keys(payload).length !== 2 && Object.keys(payload).length !== 4) return null
      if (payload.state !== 'connecting' && payload.state !== 'open' && payload.state !== 'closed') return null
      const result: RemoteBrowserEvent = { kind: 'state', state: payload.state }
      if (Object.keys(payload).length === 4) {
        if (typeof payload.code !== 'number' || !Number.isSafeInteger(payload.code) || payload.code < 1000 || payload.code > 4999) return null
        const category = text(payload.category, 1, 64)
        if (!category) return null
        result.code = payload.code
        result.category = category
      }
      return { streamId, event: result }
    }
    case 'frame': {
      if (Object.keys(payload).length !== 2) return null
      const data = payload.data
      if (typeof data !== 'string' || data.length < 1 || data.length > MAX_FRAME_BASE64 || !BASE64.test(data)) return null
      return { streamId, event: { kind: 'frame', data } }
    }
    case 'url': {
      if (Object.keys(payload).length !== 2) return null
      const url = text(payload.url, 1, 2048)
      if (!url) return null
      return { streamId, event: { kind: 'url', url } }
    }
    case 'tabs': {
      if (Object.keys(payload).length !== 2 || !Array.isArray(payload.tabs) || payload.tabs.length > 20) return null
      const tabs = []
      for (const row of payload.tabs) {
        if (!row || typeof row !== 'object') return null
        const tab = row as Record<string, unknown>
        if (Object.keys(tab).length !== 4 || typeof tab.index !== 'number' || !Number.isSafeInteger(tab.index) ||
            tab.index < 0 || tab.index > 10000 || typeof tab.active !== 'boolean') return null
        const title = text(tab.title, 0, 256)
        const url = text(tab.url, 0, 2048)
        if (title === null || url === null) return null
        tabs.push({ index: tab.index, title, url, active: tab.active })
      }
      return { streamId, event: { kind: 'tabs', tabs } }
    }
    case 'nav-rejected': {
      if (Object.keys(payload).length !== 3) return null
      const url = text(payload.url, 1, 2048)
      const message = text(payload.message, 0, 512)
      if (!url || message === null) return null
      return { streamId, event: { kind: 'nav-rejected', url, message } }
    }
    case 'stream-error': {
      if (Object.keys(payload).length !== 3) return null
      const category = text(payload.category, 1, 64)
      const message = text(payload.message, 0, 512)
      if (!category || message === null) return null
      return { streamId, event: { kind: 'stream-error', category, message } }
    }
    default:
      return null
  }
}

/** What the hub needs from the RuntimeProcess. Structural so the seam stays
 * unit-testable like the Runtime seam itself. */
export interface RemoteBrowserRuntime {
  status(): RuntimeStatus
  remoteBrowser(command: RemoteBrowserWireCommand): Promise<RemoteBrowserStreamAck>
  chat(command: ChatCommand): Promise<ChatSnapshot>
}

/** The main-internal wire commands to the Runtime's browser families. */
export type RemoteBrowserWireCommand =
  | { kind: 'stream'; action: 'open'; threadId: string; scope: string }
  | { kind: 'stream'; action: 'close' }
  | { kind: 'input'; streamId: string; event: RemoteBrowserInputEvent }

export type RemoteBrowserStreamAck = { streamId: string } | { acknowledged: true }

export type RemoteBrowserStreamMessage = { streamId: string; event: RemoteBrowserEvent }

export interface RemoteBrowserHubDeps {
  /** The fixed push channel to the main window (index.ts owns the window). */
  push(event: RemoteBrowserEvent): void
}

export class RemoteBrowserHub {
  private active: string | null = null

  constructor(private readonly runtime: RemoteBrowserRuntime, private readonly deps: RemoteBrowserHubDeps,
    /** The native save step for explicit retrieval; injected like the seam's
     * other dialogs so the flow stays testable without Electron. */
    private readonly chooseDestination: (name: string) => Promise<string | undefined>) {}

  activeStreamId(): string | null { return this.active }

  /** The Runtime's own pushes, already projected by runtime.ts's parser. A
   * stream that opens or ends on the wire (not by a hub command) resyncs the
   * active fact — the hub never disagrees with the Runtime's own lifecycle. */
  onRuntimeEvent(message: { streamId: string; event: RemoteBrowserEvent }): void {
    if (message.event.kind === 'state') {
      if (message.event.state === 'open') this.active = message.streamId
      if (message.event.state === 'closed') this.active = null
    }
    this.deps.push(message.event)
  }

  async handle(raw: unknown): Promise<{ streamId: string } | { acknowledged: true } | { status: 'saved' | 'cancelled' }> {
    const command = validateRemoteBrowserCommand(raw)
    if (command.action === 'open') {
      if (this.runtime.status().login?.state !== 'authenticated') throw new Error('REMOTE_BROWSER_UNAUTHENTICATED')
      if (this.active !== null) {
        // One stream at a time. The replacement is announced, never silent:
        // the renderer sees the old stream close before the new one starts.
        this.deps.push({ kind: 'state', state: 'closed', code: 1000, category: 'REPLACED' })
        await this.runtime.remoteBrowser({ kind: 'stream', action: 'close' })
        this.active = null
      }
      const opened = await this.runtime.remoteBrowser({ kind: 'stream', action: 'open', threadId: command.threadId, scope: command.scope })
      if (!('streamId' in opened) || !opened.streamId) throw new Error('REMOTE_BROWSER_OPEN_FAILED')
      this.active = opened.streamId
      return { streamId: opened.streamId }
    }
    if (command.action === 'close') {
      if (this.active !== null) {
        await this.runtime.remoteBrowser({ kind: 'stream', action: 'close' })
        this.active = null
      }
      return { acknowledged: true }
    }
    if (command.action === 'input') {
      if (this.active === null) throw new Error('REMOTE_BROWSER_STREAM_NOT_OPEN')
      await this.runtime.remoteBrowser({ kind: 'input', streamId: this.active, event: command.event })
      return { acknowledged: true }
    }
    // Explicit retrieval: the platform artifact path only. The Runtime
    // re-checks the identity and the artifact's thread membership; main owns
    // the save dialog; the bytes never reach the renderer.
    const snapshot = await downloadThreadArtifact(this.runtime, {
      action: 'download', scope: command.scope, threadId: command.threadId, artifactId: command.artifactId
    }, this.chooseDestination)
    if (snapshot.error) throw new Error(snapshot.error)
    if (snapshot.downloadStatus === 'cancelled') return { status: 'cancelled' }
    if (snapshot.downloadStatus !== 'saved') throw new Error('REMOTE_BROWSER_RETRIEVE_FAILED')
    return { status: 'saved' }
  }
}
