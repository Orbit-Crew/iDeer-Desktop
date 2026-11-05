// Issue 107: the local browser pane's device-side seam. These pin the
// partition-external invariants on the Desktop side: the one fixed partition,
// the http(s)-only document boundary, permission asks denied with one visible
// record each, downloads routed into the confirmed workspace with
// collision-safe names (and refused outright without one), guest popups
// routed to the owning pane instead of a native window, and the clear action
// gated by a confirmation the renderer can never sign itself.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BrowserPaneService, downloadTarget, sanitizeFilename }
  from '../src/main/browserPane'
import type { BrowserPaneEvent } from '../src/shared/desktop'
import { BROWSER_PARTITION, isWebUrl, sanitizeAddress } from '../src/shared/desktop'

type RequestCallback = (details: { resourceType: string; url: string }, respond: (answer: { cancel?: boolean }) => void) => void
type NavigateHandler = (event: { preventDefault(): void }, url: string) => void

interface FakeSession {
  permissionRequests: Array<(contents: { getURL(): string }, permission: string,
    callback: (allowed: boolean) => void, details: { requestingUrl?: string }) => void>
  permissionChecks: Array<() => boolean>
  downloads: Array<(event: { preventDefault(): void }, item: never, contents: unknown) => void>
  beforeRequest: Array<RequestCallback>
  setPermissionRequestHandler(fn: FakeSession['permissionRequests'][number]): void
  setPermissionCheckHandler(fn: FakeSession['permissionChecks'][number]): void
  on(name: string, fn: FakeSession['downloads'][number]): void
  webRequest: { onBeforeRequest(_filter: unknown, fn: RequestCallback): void }
}

function fakeSession(): FakeSession {
  const session = {
    permissionRequests: [] as FakeSession['permissionRequests'],
    permissionChecks: [] as FakeSession['permissionChecks'],
    downloads: [] as FakeSession['downloads'],
    beforeRequest: [] as RequestCallback[],
    setPermissionRequestHandler(fn: FakeSession['permissionRequests'][number]): void { session.permissionRequests.push(fn) },
    setPermissionCheckHandler(fn: FakeSession['permissionChecks'][number]): void { session.permissionChecks.push(fn) },
    on(name: string, fn: FakeSession['downloads'][number]): void {
      if (name === 'will-download') session.downloads.push(fn)
    },
    webRequest: {
      // The real API has a filter-optional overload; accept both shapes.
      onBeforeRequest(filterOrListener: unknown, maybeListener?: RequestCallback): void {
        session.beforeRequest.push((maybeListener ?? filterOrListener) as RequestCallback)
      }
    }
  }
  return session
}

interface FakeItem {
  filename: string
  savedTo: string | null
  canceled: boolean
  doneListeners: Array<(state: string) => void>
}

function fakeItem(filename: string): FakeItem & { like: never } {
  const item: FakeItem & { like?: unknown } = {
    filename, savedTo: null, canceled: false,
    doneListeners: []
  }
  // The like surface mutates the same record the test asserts on.
  item.like = {
    getFilename: () => item.filename,
    setSavePath: (path: string) => { item.savedTo = path },
    cancel: () => { item.canceled = true },
    once: (_name: string, listener: (state: string) => void) => { item.doneListeners.push(listener) }
  }
  return item as FakeItem & { like: never }
}

function makeService(overrides: {
  resolveWorkspaceRoot?: () => Promise<string | null>
  confirmClear?: () => Promise<boolean>
  destroyPartitionGuests?: () => void
  clearStorage?: () => Promise<void>
} = {}): { service: BrowserPaneService; events: BrowserPaneEvent[]; session: FakeSession } {
  const events: BrowserPaneEvent[] = []
  const session = fakeSession()
  const instance = new BrowserPaneService(session as never, {
    push: (event) => events.push(event),
    resolveWorkspaceRoot: overrides.resolveWorkspaceRoot ?? (async () => null),
    confirmClear: overrides.confirmClear ?? (async () => true),
    destroyPartitionGuests: overrides.destroyPartitionGuests ?? (() => {}),
    clearStorage: overrides.clearStorage ?? (async () => {})
  })
  return { service: instance, events, session }
}

describe('shared address grammar (issue 107)', () => {
  it('keeps only http(s) as web documents', () => {
    expect(isWebUrl('https://example.com/a?b=1')).toBe(true)
    expect(isWebUrl('http://localhost:8080/x')).toBe(true)
    expect(isWebUrl('file:///C:/Windows')).toBe(false)
    expect(isWebUrl('javascript:alert(1)')).toBe(false)
    expect(isWebUrl('about:blank')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
  })

  it('passes full http(s) URLs and upgrades bare hosts to https', () => {
    expect(sanitizeAddress(' https://example.com/path ')).toBe('https://example.com/path')
    expect(sanitizeAddress('http://192.168.1.10:9000/console')).toBe('http://192.168.1.10:9000/console')
    expect(sanitizeAddress('example.com')).toBe('https://example.com')
    expect(sanitizeAddress('localhost:8080')).toBe('https://localhost:8080')
    expect(sanitizeAddress('example.com/a?b=1#top')).toBe('https://example.com/a?b=1#top')
  })

  it('rejects everything the user did not actually name as a site', () => {
    expect(sanitizeAddress('file:///C:/Windows/notepad.exe')).toBeNull()
    expect(sanitizeAddress('javascript:alert(1)')).toBeNull()
    expect(sanitizeAddress('how to simulate a wing profile')).toBeNull()
    expect(sanitizeAddress('C:\\tmp\\report.pdf')).toBeNull()
    expect(sanitizeAddress('')).toBeNull()
    expect(sanitizeAddress('   ')).toBeNull()
    expect(sanitizeAddress('ftp://example.com')).toBeNull()
  })
})

describe('download naming (issue 107)', () => {
  it('strips path separators, control characters and Windows reserved names', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf')
    expect(sanitizeFilename('..\\..\\evil.exe')).toBe('evil.exe')
    expect(sanitizeFilename('a/b/c.txt')).toBe('c.txt')
    expect(sanitizeFilename('bad:name?.txt')).toBe('bad_name_.txt')
    expect(sanitizeFilename('CON')).toBe('_CON')
    expect(sanitizeFilename('trailing...')).toBe('trailing')
    expect(sanitizeFilename('')).toBe('download')
    expect(sanitizeFilename('x'.repeat(400)).length).toBeLessThanOrEqual(200)
  })

  it('lands the download in the workspace root without overwriting', () => {
    const root = mkdtempSync(join(tmpdir(), 'ideer-browser-'))
    writeFileSync(join(root, 'a.pdf'), 'old')
    expect(downloadTarget(root, 'a.pdf', (path) => path === join(root, 'a.pdf'))).toBe(join(root, 'a (1).pdf'))
    expect(downloadTarget(root, 'b.pdf', () => false)).toBe(join(root, 'b.pdf'))
    mkdirSync(join(root, 'sub'))
    expect(downloadTarget(join(root, 'sub'), 'c.bin', () => false)).toBe(join(root, 'sub', 'c.bin'))
  })
})

describe('partition gate (issue 107)', () => {
  it('attaches exactly one permission/download/request gate set', () => {
    const { service, session } = makeService()
    service.attachPartition()
    service.attachPartition()
    expect(session.permissionRequests).toHaveLength(1)
    expect(session.permissionChecks).toHaveLength(1)
    expect(session.downloads).toHaveLength(1)
    expect(session.beforeRequest).toHaveLength(1)
  })

  it('denies every permission ask and records one visible fact per ask', () => {
    const { service, events, session } = makeService()
    service.attachPartition()
    const allowed: boolean[] = []
    session.permissionRequests[0](
      { getURL: () => 'https://origin.example/page' }, 'geolocation', (ok) => allowed.push(ok),
      { requestingUrl: 'https://ask.example/page' })
    expect(allowed).toEqual([false])
    expect(events).toEqual([{ kind: 'permission', permission: 'geolocation', origin: 'https://ask.example' }])
    expect(session.permissionChecks[0]()).toBe(false)
  })

  it('blocks non-http(s) document loads while leaving page subresources alone', () => {
    const { service, session } = makeService()
    service.attachPartition()
    const decide = (resourceType: string, url: string): boolean => {
      let canceled = false
      session.beforeRequest[0]({ resourceType, url }, (answer) => { canceled = Boolean(answer.cancel) })
      return canceled
    }
    expect(decide('mainFrame', 'https://example.com/')).toBe(false)
    expect(decide('mainFrame', 'file:///C:/Windows')).toBe(true)
    expect(decide('subFrame', 'file:///C:/Windows/page.html')).toBe(true)
    expect(decide('subFrame', 'ftp://example.com/doc.txt')).toBe(true)
    // The embedding page's own machinery: about:blank/blob:/data: frames ride
    // the page, not the web outside it.
    expect(decide('subFrame', 'about:blank')).toBe(false)
    expect(decide('subFrame', 'blob:https://example.com/8f2e')).toBe(false)
    expect(decide('subFrame', 'data:text/html,<b>x</b>')).toBe(false)
    expect(decide('image', 'file:///C:/leak.png')).toBe(false)
    expect(decide('xhr', 'data:text/plain,hi')).toBe(false)
    expect(decide('other', 'https://example.com/api')).toBe(false)
  })

  it('uses exactly the one fixed persistent partition constant', () => {
    expect(BROWSER_PARTITION).toBe('persist:browser-pane')
  })
})

describe('download routing (issue 107)', () => {
  it('refuses downloads outright when no workspace is confirmed', async () => {
    const { service, events, session } = makeService()
    service.attachPartition()
    const item = fakeItem('report.pdf')
    session.downloads[0]({ preventDefault: () => {} }, item.like, {})
    await vi.waitFor(() => { expect(item.canceled).toBe(true) })
    expect(item.savedTo).toBeNull()
    expect(events).toContainEqual({ kind: 'download', phase: 'rejected', filename: 'report.pdf', reason: 'WORKSPACE_UNCONFIRMED' })
  })

  it('routes downloads into the confirmed workspace root and reports the phases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ideer-browser-'))
    const { service, events, session } = makeService({
      resolveWorkspaceRoot: async () => root
    })
    service.attachPartition()
    const item = fakeItem('result.csv')
    session.downloads[0]({ preventDefault: () => {} }, item.like, {})
    await vi.waitFor(() => { expect(item.savedTo).toBe(join(root, 'result.csv')) })
    expect(events.at(-1)).toEqual({ kind: 'download', phase: 'started', filename: 'result.csv' })
    expect(item.doneListeners).toHaveLength(1)
    for (const [state, phase] of [['completed', 'completed'], ['cancelled', 'canceled'], ['interrupted', 'interrupted']] as const) {
      item.doneListeners[0]({}, state)
      expect(events.at(-1)).toEqual({ kind: 'download', phase, filename: 'result.csv' })
    }
  })

  it('renames colliding downloads instead of overwriting workspace files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ideer-browser-'))
    writeFileSync(join(root, 'result.csv'), 'existing user file')
    const { service, events, session } = makeService({ resolveWorkspaceRoot: async () => root })
    service.attachPartition()
    const item = fakeItem('result.csv')
    session.downloads[0]({ preventDefault: () => {} }, item.like, {})
    await vi.waitFor(() => { expect(item.savedTo).toBe(join(root, 'result (1).csv')) })
    expect(events.at(-1)).toEqual({ kind: 'download', phase: 'started', filename: 'result.csv' })
  })
})

describe('guest hardening (issue 107)', () => {
  it('denies popups and hands the URL to the owning pane as a new-tab fact', () => {
    const { service, events } = makeService()
    const decisions: Array<unknown> = []
    const contents: {
      id: number
      setWindowOpenHandler(handler: (details: { url: string }) => unknown): void
      on(name: string, handler: NavigateHandler): void
      navigateHandler: NavigateHandler | null
    } = {
      id: 42,
      setWindowOpenHandler: (handler) => { decisions.push(handler) },
      on: (name, handler) => {
        if (name === 'will-navigate') contents.navigateHandler = handler
      },
      navigateHandler: null
    }
    service.hardenGuest(contents as never)
    expect(decisions).toHaveLength(1)
    const handler = decisions[0] as (details: { url: string }) => unknown
    expect(handler({ url: 'https://example.com/next' })).toEqual({ action: 'deny' })
    expect(events.at(-1)).toEqual({ kind: 'window-open', contentsId: 42, url: 'https://example.com/next' })
    expect(handler({ url: 'file:///C:/Windows' })).toEqual({ action: 'deny' })
    expect(events.at(-1)).toEqual({ kind: 'window-open', contentsId: 42, url: '' })
  })

  it('stops non-http(s) same-page navigations and records the block', () => {
    const { service, events } = makeService()
    const prevented: boolean[] = []
    const contents = {
      setWindowOpenHandler: () => {},
      on: (name: string, handler: NavigateHandler) => {
        if (name === 'will-navigate') contents.navigateHandler = handler
      },
      navigateHandler: null as NavigateHandler | null
    }
    service.hardenGuest(contents as never)
    contents.navigateHandler!({ preventDefault: () => prevented.push(true) }, 'https://example.com/next')
    expect(prevented).toEqual([])
    contents.navigateHandler!({ preventDefault: () => prevented.push(true) }, 'file:///C:/Windows')
    expect(prevented).toEqual([true])
    expect(events.at(-1)).toEqual({ kind: 'navigation-blocked', url: 'file:///C:/Windows' })
  })
})

describe('partition clear (issue 107)', () => {
  it('clears storage only after the trusted confirmation and reports the fact', async () => {
    const clearStorage = vi.fn(async () => {})
    const { service, events } = makeService({ clearStorage })
    await service.clear()
    expect(clearStorage).toHaveBeenCalledOnce()
    expect(events.at(-1)).toEqual({ kind: 'cleared' })
  })

  it('keeps the partition untouched when the confirmation is declined', async () => {
    const clearStorage = vi.fn(async () => {})
    const { service, events } = makeService({ confirmClear: async () => false, clearStorage })
    await service.clear()
    expect(clearStorage).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('stops the partition guests before wiping storage', async () => {
    const order: string[] = []
    const { service, events } = makeService({
      destroyPartitionGuests: () => { order.push('destroy') },
      clearStorage: async () => { order.push('clear') }
    })
    await service.clear()
    expect(order).toEqual(['destroy', 'clear'])
    expect(events.at(-1)).toEqual({ kind: 'cleared' })
  })
})
