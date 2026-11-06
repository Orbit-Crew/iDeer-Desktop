// @vitest-environment jsdom
// Issue 110: closing a human terminal pane explicitly asks whether to end the
// programs inside (decision #59.4). The ask covers every path that removes a
// terminal instance: pane close, tab close, and layout-preset replacement.
// "保留程序" keeps the pane and the programs untouched; "结束程序并关闭"
// kills the PTY sessions and performs the close. A terminal whose process
// already exited never blocks a close, and non-terminal panes close directly.
// Modal visibility is asserted through the guard store (antd keeps closed
// dialogs in the DOM for its exit animation); behavior through the dock
// layout and the terminal session store.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Fragment } from 'react'
import PaneFrame from '../src/renderer/src/dock/PaneFrame'
import TerminalCloseConfirm from '../src/renderer/src/dock/TerminalCloseConfirm'
import { LayoutPresetList } from '../src/renderer/src/dock/LayoutPresetDropdown'
import { useDockStore } from '../src/renderer/src/dock/dockStore'
import { useTerminalSessionStore } from '../src/renderer/src/stores/terminalSessions'
import { useCloseGuardStore } from '../src/renderer/src/dock/closeGuard'
import type { DockLayout } from '../src/renderer/src/dock/types'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useTerminalSessionStore.getState().unregister('inst-1')
  useCloseGuardStore.getState().cancel()
})

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
  // jsdom has no ResizeObserver; the dock chrome observes pane content boxes.
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(window as unknown as { ideerTerminal: unknown }).ideerTerminal = {
    spawn: vi.fn(), write: vi.fn(), resize: vi.fn(),
    kill: vi.fn(async () => {}),
    onData: () => () => {}, onExit: () => () => {}
  }
})

const killMock = (): ReturnType<typeof vi.fn> =>
  (window as unknown as { ideerTerminal: { kill: ReturnType<typeof vi.fn> } }).ideerTerminal.kill

function layoutWithTerminal(): DockLayout {
  return {
    version: 1,
    rootId: 'split-root',
    byId: {
      'split-root': { id: 'split-root', kind: 'split', direction: 'row', ratio: 0.6, children: ['p-anchor', 'p-term'] },
      'p-anchor': { id: 'p-anchor', kind: 'pane', anchor: true, tabs: [{ id: 't-chat', panelType: 'chat', title: '对话' }], activeTabId: 't-chat' },
      'p-term': { id: 'p-term', kind: 'pane', tabs: [{ id: 't-term', panelType: 'terminal', title: '终端 1', instanceId: 'inst-1' }], activeTabId: 't-term' }
    },
    instances: { 'inst-1': { id: 'inst-1', paneId: 'p-term', panelType: 'terminal' } }
  }
}

function layoutWithPane(panelType: 'terminal' | 'files'): DockLayout {
  const base = layoutWithTerminal()
  return {
    ...base,
    byId: {
      ...base.byId,
      'p-term': {
        id: 'p-term', kind: 'pane',
        tabs: [{ id: 't-term', panelType, title: panelType === 'terminal' ? '终端 1' : '文件', instanceId: 'inst-1' }],
        activeTabId: 't-term'
      }
    },
    instances: { 'inst-1': { id: 'inst-1', paneId: 'p-term', panelType } }
  }
}

function mountPaneFrame(layout: DockLayout = layoutWithTerminal()): void {
  useDockStore.getState().hydrate(layout)
  const pane = useDockStore.getState().layout.byId['p-term']
  render(<Fragment>
    <PaneFrame pane={pane as React.ComponentProps<typeof PaneFrame>['pane']} />
    <LayoutPresetList />
    <TerminalCloseConfirm />
  </Fragment>)
}

function seedLiveSession(): void {
  useTerminalSessionStore.getState().register('inst-1', 'sess-1')
}

describe('terminal pane close ask (issue 110)', () => {
  it('asks before closing a pane that still runs a program, and keeping keeps everything', async () => {
    mountPaneFrame()
    seedLiveSession()
    fireEvent.click(screen.getByRole('button', { name: '关闭窗格' }))
    expect(await screen.findByText('结束终端中的程序？')).toBeTruthy()
    expect(useCloseGuardStore.getState().pending).not.toBeNull()
    // Nothing closed, nothing killed yet.
    expect(useDockStore.getState().layout.byId['p-term']).toBeTruthy()
    expect(killMock()).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保留程序' }))
    await waitFor(() => expect(useCloseGuardStore.getState().pending).toBeNull())
    expect(useDockStore.getState().layout.byId['p-term']).toBeTruthy()
    expect(killMock()).not.toHaveBeenCalled()
  })

  it('ends the programs and closes the pane on explicit confirmation', async () => {
    mountPaneFrame()
    seedLiveSession()
    fireEvent.click(screen.getByRole('button', { name: '关闭窗格' }))
    fireEvent.click(await screen.findByRole('button', { name: '结束程序并关闭' }))
    await waitFor(() => expect(killMock()).toHaveBeenCalledWith('sess-1'))
    await waitFor(() => expect(useDockStore.getState().layout.byId['p-term']).toBeUndefined())
    expect(useTerminalSessionStore.getState().byInstance['inst-1']).toBeUndefined()
    expect(useCloseGuardStore.getState().pending).toBeNull()
  })

  it('closes a pane whose terminal already exited without asking', () => {
    mountPaneFrame()
    seedLiveSession()
    useTerminalSessionStore.getState().markExited('inst-1')
    fireEvent.click(screen.getByRole('button', { name: '关闭窗格' }))
    expect(useCloseGuardStore.getState().pending).toBeNull()
    expect(killMock()).not.toHaveBeenCalled()
    expect(useDockStore.getState().layout.byId['p-term']).toBeUndefined()
  })

  it('asks before closing a terminal tab and ends its session on confirm', async () => {
    mountPaneFrame()
    seedLiveSession()
    fireEvent.click(screen.getByTitle('关闭页签'))
    expect(await screen.findByText('结束终端中的程序？')).toBeTruthy()
    expect(useDockStore.getState().layout.byId['p-term']).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '结束程序并关闭' }))
    await waitFor(() => expect(killMock()).toHaveBeenCalledWith('sess-1'))
    // The pane empties and closes with the tab.
    await waitFor(() => expect(useDockStore.getState().layout.byId['p-term']).toBeUndefined())
  })

  it('closes non-terminal panes directly with no ask', () => {
    mountPaneFrame(layoutWithPane('files'))
    fireEvent.click(screen.getByRole('button', { name: '关闭窗格' }))
    expect(useCloseGuardStore.getState().pending).toBeNull()
    expect(killMock()).not.toHaveBeenCalled()
    expect(useDockStore.getState().layout.byId['p-term']).toBeUndefined()
  })

  it('asks before a layout preset replaces a pane with a running terminal', async () => {
    mountPaneFrame()
    seedLiveSession()
    fireEvent.click(screen.getByText('仅对话'))
    expect(await screen.findByText('结束终端中的程序？')).toBeTruthy()
    expect(useCloseGuardStore.getState().pending).not.toBeNull()
    expect(useDockStore.getState().layout.byId['p-term']).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保留程序' }))
    await waitFor(() => expect(useCloseGuardStore.getState().pending).toBeNull())
    expect(useDockStore.getState().layout.byId['p-term']).toBeTruthy()
    expect(killMock()).not.toHaveBeenCalled()
  })

  it('ends the programs and applies the preset on explicit confirmation', async () => {
    mountPaneFrame()
    seedLiveSession()
    fireEvent.click(screen.getByText('仅对话'))
    fireEvent.click(await screen.findByRole('button', { name: '结束程序并关闭' }))
    await waitFor(() => expect(killMock()).toHaveBeenCalledWith('sess-1'))
    await waitFor(() => expect(useDockStore.getState().layout.byId['p-term']).toBeUndefined())
    expect(useDockStore.getState().layout.rootId).not.toBe('split-root')
  })

  it('applies a preset instantly when no terminal program is running', () => {
    mountPaneFrame()
    fireEvent.click(screen.getByText('仅对话'))
    expect(useCloseGuardStore.getState().pending).toBeNull()
    expect(killMock()).not.toHaveBeenCalled()
    expect(useDockStore.getState().layout.byId['p-term']).toBeUndefined()
  })
})
