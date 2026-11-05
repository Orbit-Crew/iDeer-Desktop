// Issue 107: the local browser pane's device-side seam. The pane's webviews
// share one fixed persistent partition (src/shared/desktop.ts
// BROWSER_PARTITION); this module hardens that partition and its guest pages:
// permission asks are denied with one visible record each, document loads are
// constrained to http(s), downloads land inside the confirmed workspace
// folder (or are refused outright), and guest popups never open native
// windows — they surface as facts the owning pane turns into tabs. Nothing
// here touches the trusted bridge channels; the renderer only ever receives
// bounded BrowserPaneEvents. The class imports electron types only, so the
// service logic stays unit-testable like the Runtime seam.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Session, WebContents } from 'electron'
import type { BrowserPaneEvent } from '../shared/desktop'
import { isWebUrl } from '../shared/desktop'

/** Minimal structural shape of the download the wiring hands over. */
export interface DownloadLike {
  getFilename(): string
  setSavePath(path: string): void
  cancel(): void
  once(event: string, listener: (event: unknown, state: string) => void): unknown
}

export interface BrowserPaneDeps {
  push: (event: BrowserPaneEvent) => void
  /** Resolves the confirmed workspace's physical root, or null when no
   * workspace is confirmed for this account+device right now. */
  resolveWorkspaceRoot: () => Promise<string | null>
  /** The clear confirmation lives in the trusted main process (a native
   * dialog); the renderer can never sign this itself. */
  confirmClear: () => Promise<boolean>
  /** Stops every live guest of the partition (crashes its renderer, so no
   * JavaScript can run). Runs before the storage clear: a page that stays
   * alive across the wipe could re-persist cookies between the clear
   * resolving and the renderer unmounting its webviews. */
  destroyPartitionGuests: () => void
  clearStorage: () => Promise<void>
}

const RESERVED_WINDOWS_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

/**
 * One server-suggested download filename, made safe for the workspace folder:
 * path separators cannot smuggle a directory, control characters and Windows
 * reserved characters become underscores, reserved device names and trailing
 * dots/spaces are neutralized, and a hard cap keeps the path usable. The
 * result stays the honest name of the file — it never becomes a search key.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  let safe = base.replace(/[\x00-\x1f\x7f:*?"<>|]/g, '_')
  safe = safe.replace(/[. ]+$/g, '')
  if (!safe) return 'download'
  if (RESERVED_WINDOWS_NAMES.has(safe.replace(/\..*$/, '').toLowerCase())) safe = `_${safe}`
  if (safe.length > 200) safe = safe.slice(0, 200).replace(/[. ]+$/g, '')
  return safe || 'download'
}

/**
 * A non-colliding path inside the workspace root: "name (n).ext" before the
 * extension, mirroring what a system save dialog would have done — an
 * existing workspace file is never overwritten by a browser download.
 */
export function downloadTarget(root: string, suggested: string, exists: (path: string) => boolean = existsSync): string {
  const safe = sanitizeFilename(suggested)
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const extension = dot > 0 ? safe.slice(dot) : ''
  let candidate = join(root, safe)
  for (let n = 1; n < 10000 && exists(candidate); n += 1) {
    candidate = join(root, `${stem} (${n})${extension}`)
  }
  return candidate
}

function originOf(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

/** Subframe loads that belong to the embedding page itself, not to the web
 * outside it. Kept as a scheme test so a crafted `about:blank?…` or a
 * `data:` URL cannot smuggle a path past the boundary while the ordinary
 * page machinery keeps working. */
const INTRINSIC_FRAME_SCHEMES = /^(about:blank|blob:|data:)/i

export class BrowserPaneService {
  private readonly session: Session
  private readonly deps: BrowserPaneDeps
  private attached = false

  constructor(session: Session, deps: BrowserPaneDeps) {
    this.session = session
    this.deps = deps
  }

  /** Registers the partition-wide gates once; a second call is a no-op. */
  attachPartition(): void {
    if (this.attached) return
    this.attached = true
    const session = this.session
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(false)
      const origin = originOf(details?.requestingUrl || contents?.getURL() || '')
      this.deps.push({ kind: 'permission', permission, origin })
    })
    session.setPermissionCheckHandler(() => false)
    session.on('will-download', (event, item) => {
      // The save destination is decided here, never by a native save dialog:
      // the workspace folder is the boundary, so the download cannot ask its
      // way outside it.
      event.preventDefault()
      void this.routeDownload(item as unknown as DownloadLike)
    })
    session.webRequest.onBeforeRequest((details, callback) => {
      // The document boundary: frames are web documents, everything else
      // (subresources, XHR, websocket frames) rides the page's own origin.
      // A subframe the page creates from its own machinery (about:blank
      // inherits the parent origin, blob:/data: are origin-scoped or opaque)
      // is not an external document; a file:/ftp:/custom-scheme frame is.
      if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
        callback({ cancel: !isWebUrl(details.url) && !INTRINSIC_FRAME_SCHEMES.test(details.url) })
        return
      }
      callback({})
    })
  }

  /** Per-guest guards, wired from `app.on('web-contents-created')`. */
  hardenGuest(contents: WebContents): void {
    contents.setWindowOpenHandler(({ url }) => {
      // No native popup window for pane content: the URL becomes a fact the
      // owning pane turns into a tab. A non-web URL is a dead end by design.
      this.deps.push({ kind: 'window-open', contentsId: contents.id, url: isWebUrl(url) ? url : '' })
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isWebUrl(url)) {
        event.preventDefault()
        this.deps.push({ kind: 'navigation-blocked', url })
      }
    })
  }

  /** The partition clear; the confirmation gate belongs to main, not UI. */
  async clear(): Promise<void> {
    if (!(await this.deps.confirmClear())) return
    // Guests first (which also tears down their in-flight downloads), then
    // the storage: the renderer's tab reset on the `cleared` fact is the
    // second half of the story, never the wipe's guarantee.
    this.deps.destroyPartitionGuests()
    await this.deps.clearStorage()
    this.deps.push({ kind: 'cleared' })
  }

  private async routeDownload(item: DownloadLike): Promise<void> {
    const filename = sanitizeFilename(item.getFilename())
    let root: string | null = null
    try {
      root = await this.deps.resolveWorkspaceRoot()
    } catch {
      root = null
    }
    if (!root) {
      this.deps.push({ kind: 'download', phase: 'rejected', filename, reason: 'WORKSPACE_UNCONFIRMED' })
      try { item.cancel() } catch { /* the source tab may already be gone */ }
      return
    }
    try {
      item.setSavePath(downloadTarget(root, filename))
    } catch {
      return // the download item died with its page; nothing to report
    }
    this.deps.push({ kind: 'download', phase: 'started', filename })
    item.once('done', (_event, state) => {
      if (state === 'completed') this.deps.push({ kind: 'download', phase: 'completed', filename })
      else if (state === 'cancelled') this.deps.push({ kind: 'download', phase: 'canceled', filename })
      else this.deps.push({ kind: 'download', phase: 'interrupted', filename })
    })
  }
}
