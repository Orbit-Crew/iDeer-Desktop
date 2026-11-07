/**
 * Issue 108: the Desktop's side of the agent's controlled browser channel.
 *
 * The bundled Runtime forwards one consented, tier-resolved action per
 * signed task; this module validates the wire frame, announces the control
 * on the pane's fact channel (开工前标示), dispatches the fixed action to
 * the injected port, and bounds every fact on the way back. The port is
 * the only place that touches Electron; here there is no bridge surface,
 * no IPC channel of its own, and no arbitrary code path — an action is
 * one of the fixed names below or it is refused before the port runs.
 *
 * Fixed categories (AGENT_BROWSER_*) cross the boundary verbatim, both to
 * the Runtime and — through it — to the task's receipt; anything unnamed
 * is recast to AGENT_BROWSER_FAILED so invented strings never travel.
 */

export type AgentBrowserIntent = 'observe' | 'input' | 'submit' | 'download'

export type AgentBrowserObserveResult = {
  tabs: { id: number; url: string; title: string }[]
}

export type AgentBrowserObserveTextResult = {
  url: string
  title: string
  text: string
}

export type AgentBrowserFact = Record<string, unknown>

export type AgentBrowserPort = {
  observe(): Promise<AgentBrowserObserveResult>
  observeText(tabId: number): Promise<AgentBrowserObserveTextResult>
  navigate(tabId: number | null, url: string): Promise<AgentBrowserFact>
  goBack(tabId: number): Promise<AgentBrowserFact>
  goForward(tabId: number): Promise<AgentBrowserFact>
  reload(tabId: number): Promise<AgentBrowserFact>
  pressKey(key: string, tabId: number): Promise<AgentBrowserFact>
  typeText(text: string, tabId: number): Promise<AgentBrowserFact>
  click(x: number, y: number, tabId: number): Promise<AgentBrowserFact>
  submit(tabId: number): Promise<AgentBrowserFact>
  download(url: string): Promise<AgentBrowserFact>
}

export type AgentBrowserWireCommand = {
  id: string
  command: Record<string, unknown>
}

export type AgentBrowserAnnounce = {
  kind: 'agent-control'
  intent: AgentBrowserIntent
  action: string
  url: string
}

export type AgentBrowserOutcome = { result: unknown; error: string }

const MAX_ID_LENGTH = 64
const MAX_URL_LENGTH = 2048
const MAX_TEXT_LENGTH = 1024
const MAX_KEY_LENGTH = 16
const MAX_COORDINATE = 100000
const MAX_TAB_ID = 10000000
const MAX_OBSERVE_TEXT = 20000
const MAX_TABS = 20
const MAX_TITLE_LENGTH = 300
const MAX_ACTION_LENGTH = 32

const INTENT_BY_ACTION: Record<string, AgentBrowserIntent> = {
  observe: 'observe',
  'observe-text': 'observe',
  navigate: 'input',
  back: 'input',
  forward: 'input',
  reload: 'input',
  key: 'input',
  text: 'input',
  click: 'input',
  submit: 'submit',
  download: 'download'
}

/** The bounded stdout frame the Runtime forwards; anything else is dropped. */
export function parseAgentBrowserCommandWire(value: unknown): AgentBrowserWireCommand | null {
  if (!value || typeof value !== 'object') return null
  const frame = value as Record<string, unknown>
  if (frame.v !== 1 || frame.type !== 'browser-control') return null
  if (typeof frame.id !== 'string' || frame.id.length < 1 || frame.id.length > MAX_ID_LENGTH) return null
  if (!frame.command || typeof frame.command !== 'object' || Array.isArray(frame.command)) return null
  const command = frame.command as Record<string, unknown>
  if (typeof command.action !== 'string' || command.action.length > MAX_ACTION_LENGTH) return null
  return { id: frame.id, command }
}

/** The stdin reply with the exact key set the Runtime's reader validates. */
export function agentBrowserResultWire(id: string, result: unknown, error: string):
    { v: 1; type: 'browser-control-result'; id: string; result: unknown; error: string } {
  return { v: 1, type: 'browser-control-result', id, result, error }
}

const isHttpUrl = (url: unknown): url is string =>
  typeof url === 'string' && url.length > 0 && url.length <= MAX_URL_LENGTH &&
  /^https?:\/\/[^/]/i.test(url)

const boundedTabId = (value: unknown): number | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_TAB_ID) {
    throw new RangeError('tabId')
  }
  return value
}

/**
 * One hub per desktop surface. `announce` rides the browser pane's own
 * fact channel so the user sees the control start in the pane itself;
 * the chat-side consent card is the other half of the announcement.
 */
export class AgentBrowserHub {
  private readonly port: AgentBrowserPort
  private readonly announce: ((event: AgentBrowserAnnounce) => void) | null

  constructor(port: AgentBrowserPort, announce: ((event: AgentBrowserAnnounce) => void) | null = null) {
    this.port = port
    this.announce = announce
  }

  async handle(id: string, raw: Record<string, unknown>): Promise<AgentBrowserOutcome> {
    let intent: AgentBrowserIntent
    try {
      intent = this.validate(raw)
    } catch {
      return { result: null, error: 'AGENT_BROWSER_COMMAND_INVALID' }
    }
    const action = raw.action as string
    const url = typeof raw.url === 'string' ? raw.url : ''
    this.announce?.({ kind: 'agent-control', intent, action, url })
    try {
      const result = await this.dispatch(raw)
      const bounded = this.bound(action, result)
      return { result: bounded, error: '' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { result: null, error: message.startsWith('AGENT_BROWSER_') ? message : 'AGENT_BROWSER_FAILED' }
    }
  }

  private validate(raw: Record<string, unknown>): AgentBrowserIntent {
    const action = raw.action
    const intent = INTENT_BY_ACTION[action as string]
    if (!intent) throw new RangeError('action')
    // Only the fixed fields an action names may ride it; anything else is a
    // smuggled instruction and refuses before the port ever runs.
    const allowed = new Set<string>(['action', 'tabId'])
    if (action === 'navigate' || action === 'download') allowed.add('url')
    if (action === 'text') allowed.add('text')
    if (action === 'key') allowed.add('key')
    if (action === 'click') { allowed.add('x'); allowed.add('y') }
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw new RangeError(`field:${key}`)
    }
    const tabId = boundedTabId(raw.tabId)
    // The content read always names its tab; every other per-tab action may
    // leave it to the port (the pane's own active guest) and fail there
    // with AGENT_BROWSER_NO_TAB when no guest exists.
    if (action === 'observe-text' && tabId === null) throw new RangeError('tabId')
    if (action === 'navigate' || action === 'download') {
      if (!isHttpUrl(raw.url)) throw new RangeError('url')
    }
    if (action === 'text' && !(typeof raw.text === 'string' && raw.text.length > 0 && raw.text.length <= MAX_TEXT_LENGTH)) {
      throw new RangeError('text')
    }
    if (action === 'key' && !(typeof raw.key === 'string' && raw.key.length > 0 && raw.key.length <= MAX_KEY_LENGTH &&
        ![...raw.key].some((character) => character.charCodeAt(0) < 32))) {
      throw new RangeError('key')
    }
    if (action === 'click' && !(Number.isInteger(raw.x) && (raw.x as number) >= 0 && (raw.x as number) <= MAX_COORDINATE &&
        Number.isInteger(raw.y) && (raw.y as number) >= 0 && (raw.y as number) <= MAX_COORDINATE)) {
      throw new RangeError('coordinates')
    }
    return intent
  }

  private async dispatch(raw: Record<string, unknown>): Promise<unknown> {
    const tabId = boundedTabId(raw.tabId)
    switch (raw.action) {
      case 'observe': return this.port.observe()
      case 'observe-text': return this.port.observeText(tabId as number)
      case 'navigate': return this.port.navigate(tabId, raw.url as string)
      case 'back': return this.port.goBack(tabId as number)
      case 'forward': return this.port.goForward(tabId as number)
      case 'reload': return this.port.reload(tabId as number)
      case 'key': return this.port.pressKey(raw.key as string, tabId as number)
      case 'text': return this.port.typeText(raw.text as string, tabId as number)
      case 'click': return this.port.click(raw.x as number, raw.y as number, tabId as number)
      case 'submit': return this.port.submit(tabId as number)
      case 'download': return this.port.download(raw.url as string)
      default:
        throw new RangeError('action')
    }
  }

  private bound(action: string, result: unknown): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('AGENT_BROWSER_RESULT_INVALID')
    }
    const record = result as Record<string, unknown>
    // The pane-list read is bounded by the fixed tab cap; the one channel
    // page content may take is the observe-text read, capped on its own.
    if (action === 'observe') {
      const tabs = record.tabs
      if (!Array.isArray(tabs) || tabs.length > MAX_TABS) throw new Error('AGENT_BROWSER_RESULT_INVALID')
      const rows: { id: number; url: string; title: string }[] = []
      for (const tab of tabs) {
        const row = tab as Record<string, unknown>
        if (typeof row?.id !== 'number' || !Number.isInteger(row.id) ||
            typeof row?.url !== 'string' || row.url.length > MAX_URL_LENGTH ||
            typeof row?.title !== 'string' || row.title.length > MAX_TITLE_LENGTH) {
          throw new Error('AGENT_BROWSER_RESULT_INVALID')
        }
        rows.push({ id: row.id, url: row.url, title: row.title })
      }
      return { tabs: rows }
    }
    if (action === 'observe-text') {
      if (typeof record.text !== 'string' || record.text.length > MAX_OBSERVE_TEXT ||
          typeof record.url !== 'string' || record.url.length > MAX_URL_LENGTH ||
          typeof record.title !== 'string' || record.title.length > MAX_TITLE_LENGTH) {
        throw new Error('AGENT_BROWSER_RESULT_INVALID')
      }
      return { url: record.url, title: record.title, text: record.text }
    }
    // Every other action returns fixed facts only; invented fields drop.
    const bounded: Record<string, unknown> = {}
    if (typeof record.url === 'string' && record.url.length <= MAX_URL_LENGTH) bounded.url = record.url
    if (typeof record.title === 'string' && record.title.length <= MAX_TITLE_LENGTH) bounded.title = record.title
    if (record.submitted === true || record.submitted === false) bounded.submitted = record.submitted
    if (record.queued === true || record.queued === false) bounded.queued = record.queued
    return bounded
  }
}
