import { describe, expect, it, vi } from 'vitest'
import {
  AgentBrowserHub,
  agentBrowserResultWire,
  parseAgentBrowserCommandWire,
  type AgentBrowserPort
} from '../src/main/agentBrowser'

const okPort = (overrides: Partial<AgentBrowserPort> = {}): AgentBrowserPort => ({
  observe: vi.fn(async () => ({ tabs: [{ id: 7, url: 'https://example.com/', title: 'Example' }] })),
  observeText: vi.fn(async () => ({ url: 'https://example.com/', title: 'Example', text: 'hello' })),
  navigate: vi.fn(async () => ({ url: 'https://example.com/' })),
  goBack: vi.fn(async () => ({})),
  goForward: vi.fn(async () => ({})),
  reload: vi.fn(async () => ({})),
  pressKey: vi.fn(async () => ({})),
  typeText: vi.fn(async () => ({})),
  click: vi.fn(async () => ({})),
  submit: vi.fn(async () => ({ submitted: true })),
  download: vi.fn(async () => ({ queued: true })),
  ...overrides
})

describe('agent browser wire (issue 108)', () => {
  it('accepts only the bounded browser-control frame', () => {
    expect(parseAgentBrowserCommandWire({ v: 1, type: 'browser-control', id: 'r1', command: { action: 'observe' } }))
      .toEqual({ id: 'r1', command: { action: 'observe' } })
    expect(parseAgentBrowserCommandWire({ v: 1, type: 'browser-control', id: 'x'.repeat(65), command: { action: 'observe' } })).toBeNull()
    expect(parseAgentBrowserCommandWire({ v: 1, type: 'browser-control', id: '', command: { action: 'observe' } })).toBeNull()
    expect(parseAgentBrowserCommandWire({ v: 1, type: 'browser-control', id: 'r1' })).toBeNull()
    expect(parseAgentBrowserCommandWire({ v: 1, type: 'browser-control', id: 'r1', command: 'observe' })).toBeNull()
    expect(parseAgentBrowserCommandWire({ v: 1, type: 'browser-input', id: 'r1', command: {} })).toBeNull()
    expect(parseAgentBrowserCommandWire({ type: 'browser-control', id: 'r1', command: {} })).toBeNull()
  })

  it('serializes the stdin reply with the exact Python-reader key set', () => {
    expect(agentBrowserResultWire('r1', { tabs: [] }, '')).toEqual({
      v: 1, type: 'browser-control-result', id: 'r1', result: { tabs: [] }, error: ''
    })
    expect(agentBrowserResultWire('r1', null, 'AGENT_BROWSER_TIMEOUT')).toEqual({
      v: 1, type: 'browser-control-result', id: 'r1', result: null, error: 'AGENT_BROWSER_TIMEOUT'
    })
  })
})

describe('agent browser hub (issue 108)', () => {
  it('dispatches each fixed action to its port operation', async () => {
    const port = okPort()
    const hub = new AgentBrowserHub(port)
    await hub.handle('r1', { action: 'observe' })
    await hub.handle('r2', { action: 'observe-text', tabId: 7 })
    await hub.handle('r3', { action: 'navigate', url: 'https://example.com/' })
    await hub.handle('r4', { action: 'back', tabId: 7 })
    await hub.handle('r5', { action: 'forward', tabId: 7 })
    await hub.handle('r6', { action: 'reload', tabId: 7 })
    await hub.handle('r7', { action: 'key', key: 'Enter', tabId: 7 })
    await hub.handle('r8', { action: 'text', text: 'hello', tabId: 7 })
    await hub.handle('r9', { action: 'click', x: 10, y: 20, tabId: 7 })
    await hub.handle('r10', { action: 'submit', tabId: 7 })
    await hub.handle('r11', { action: 'download', url: 'https://example.com/a.zip' })
    expect(port.observe).toHaveBeenCalledOnce()
    expect(port.observeText).toHaveBeenCalledWith(7)
    expect(port.navigate).toHaveBeenCalledWith(null, 'https://example.com/')
    expect(port.goBack).toHaveBeenCalledWith(7)
    expect(port.goForward).toHaveBeenCalledWith(7)
    expect(port.reload).toHaveBeenCalledWith(7)
    expect(port.pressKey).toHaveBeenCalledWith('Enter', 7)
    expect(port.typeText).toHaveBeenCalledWith('hello', 7)
    expect(port.click).toHaveBeenCalledWith(10, 20, 7)
    expect(port.submit).toHaveBeenCalledWith(7)
    expect(port.download).toHaveBeenCalledWith('https://example.com/a.zip')
  })

  it('announces the control before the port runs', async () => {
    const announced: { kind: string; intent: string; action: string; url: string }[] = []
    const port = okPort({
      observe: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    const hub = new AgentBrowserHub(port, (event) => announced.push(event))
    const outcome = await hub.handle('r1', { action: 'observe' })
    expect(announced).toEqual([{ kind: 'agent-control', intent: 'observe', action: 'observe', url: '' }])
    expect(outcome.error).toBe('AGENT_BROWSER_FAILED')
  })

  it('refuses unknown actions and out-of-bounds fields before the port', async () => {
    const port = okPort()
    const hub = new AgentBrowserHub(port)
    const bad = [
      {},
      { action: 'pilot' },
      { action: 'observe', url: 'https://example.com' },
      { action: 'observe', extra: 'x' },
      { action: 'navigate', url: 'javascript:alert(1)' },
      { action: 'navigate', url: 'file:///C:/Windows' },
      { action: 'navigate' },
      { action: 'text', text: 'x'.repeat(2000), tabId: 1 },
      { action: 'text', text: 'hi', tabId: 1, url: 'https://example.com' },
      { action: 'key', key: 'a\nb', tabId: 1 },
      { action: 'click', x: -1, y: 0, tabId: 1 },
      { action: 'observe-text' },
      { action: 'back', tabId: true },
      { action: 'back', tabId: 1.5 }
    ]
    for (const command of bad) {
      const outcome = await hub.handle('r1', command as Record<string, unknown>)
      expect(outcome).toEqual({ result: null, error: 'AGENT_BROWSER_COMMAND_INVALID' })
    }
    expect(port.observe).not.toHaveBeenCalled()
  })

  it('bounds the port result and refuses invented fields', async () => {
    const hub = new AgentBrowserHub(okPort({
      observe: vi.fn(async () => ({ tabs: Array.from({ length: 21 }, (_, i) => ({ id: i, url: 'https://e.com', title: 't' })) }))
    }))
    expect(await hub.handle('r1', { action: 'observe' }))
      .toEqual({ result: null, error: 'AGENT_BROWSER_RESULT_INVALID' })
    const textHub = new AgentBrowserHub(okPort({
      observeText: vi.fn(async () => ({ url: 'https://e.com', title: 't', text: 'x'.repeat(30000) }))
    }))
    expect(await textHub.handle('r2', { action: 'observe-text', tabId: 1 }))
      .toEqual({ result: null, error: 'AGENT_BROWSER_RESULT_INVALID' })
    const extraHub = new AgentBrowserHub(okPort({
      navigate: vi.fn(async () => ({ url: 'https://e.com', shellcode: 'yes' }))
    }))
    const outcome = await extraHub.handle('r3', { action: 'navigate', url: 'https://e.com' })
    expect(outcome.result).toEqual({ url: 'https://e.com' })
  })

  it('keeps fixed categories verbatim and recasts everything else', async () => {
    const hub = new AgentBrowserHub(okPort({
      observe: vi.fn(async () => { throw new Error('boom') })
    }))
    expect(await hub.handle('r1', { action: 'observe' })).toEqual({ result: null, error: 'AGENT_BROWSER_FAILED' })
    const noTab = new AgentBrowserHub(okPort({
      observeText: vi.fn(async () => { throw new Error('AGENT_BROWSER_NO_TAB') })
    }))
    expect(await noTab.handle('r2', { action: 'observe-text', tabId: 1 }))
      .toEqual({ result: null, error: 'AGENT_BROWSER_NO_TAB' })
  })
})
