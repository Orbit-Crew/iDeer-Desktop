// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
import { TemplatesSection } from '../src/renderer/src/components/TemplateSection'
import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import type { ChatCommand, ChatSnapshot, TemplateCommand, TemplateView } from '../src/shared/desktop'
import { extractTemplateVariables } from '../src/shared/desktop'

afterEach(() => {
  cleanup()
  useSessionStore.setState({ pendingPrefill: null })
})

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const ROW_A: TemplateView['templates'][number] = {
  id: 'tpl-a', name: '周报助手', category: '办公', content: '请根据 {{要点}} 写周报，语气 {{语气}}。',
  usageCount: 3, visibility: 'private', updatedAt: '2026-11-01T00:00:00Z'
}
const ROW_B: TemplateView['templates'][number] = {
  id: 'tpl-b', name: '代码评审', category: '研发', content: '评审以下 {{语言}} 代码：',
  usageCount: 0, visibility: 'private', updatedAt: '2026-11-02T00:00:00Z'
}

const makeApi = (rows: TemplateView['templates']) => {
  const commands: TemplateCommand[] = []
  const api = vi.fn(async (command: TemplateCommand): Promise<TemplateView> => {
    commands.push(command)
    let templates = rows
    if (command.action === 'use') {
      templates = rows.map((row) => row.id === command.templateId
        ? { ...row, usageCount: row.usageCount + 1 } : row)
    }
    if (command.action === 'delete') templates = rows.filter((row) => row.id !== command.templateId)
    return { templates, ...(command.action === 'use' ? { used: true } : {}) }
  })
  return { api, commands }
}

const stateWith = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  scope: 'identity',
  resources: [
    { id: 'agent-main', type: 'agent', name: 'Main', visibility: 'private', version: 1, available: true, reason: '' }
  ],
  threads: [], messages: [], events: [], subagents: [],
  thread: { id: 'thread-84', status: 'idle', agentId: 'agent-main', skillId: '' },
  stream: 'idle', error: '', lastEventId: '',
  ...over
})

// --- the `{{变量}}` extraction ------------------------------------------------

describe('template variable extraction (#84)', () => {
  it('extracts variables in first-appearance order, deduplicated', () => {
    expect(extractTemplateVariables('写 {{b}} 与 {{a}}，再提 {{b}}')).toEqual(['b', 'a'])
  })
  it('tolerates inner spaces and refuses broken or empty placeholders', () => {
    expect(extractTemplateVariables('{{ spaced }}与{{x}}')).toEqual(['spaced', 'x'])
    expect(extractTemplateVariables('{} {{}} {{a{}b}}')).toEqual([])
  })
  it('caps the extraction at 32 names', () => {
    const text = Array.from({ length: 40 }, (_, i) => `{{v${i}}}`).join(' ')
    expect(extractTemplateVariables(text)).toHaveLength(32)
    expect(extractTemplateVariables(text)[31]).toBe('v31')
  })
})

// --- the plaza section --------------------------------------------------------

describe('template plaza section (#84)', () => {
  it('lists rows with categories, usage counts and visibility facts', async () => {
    const { api } = makeApi([ROW_A, ROW_B])
    render(<TemplatesSection onCommand={api} />)
    await vi.waitFor(() => expect(screen.getByText('周报助手')).toBeTruthy())
    expect(screen.getByText('使用 3 次')).toBeTruthy()
    expect(screen.getByText('使用 0 次')).toBeTruthy()
    expect(screen.getByText('评审以下 {{语言}} 代码：').textContent).toBeTruthy()
    // The account's private rows say so — the plaza never implies shared.
    expect(screen.getByText(/默认私有/).textContent).toBeTruthy()
    expect(screen.getAllByText('私有').length).toBe(2)
  })

  it('clicking 使用 prefills the composer via the store and records one use (+1)', async () => {
    const { api, commands } = makeApi([ROW_A])
    render(<TemplatesSection onCommand={api} />)
    await vi.waitFor(() => expect(screen.getByLabelText('使用 周报助手')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('使用 周报助手'))
    await vi.waitFor(() => expect(commands).toContainEqual({ action: 'use', templateId: 'tpl-a' }))
    // The prefill signal carries the content; the composer consumes it below.
    expect(useSessionStore.getState().pendingPrefill?.content).toBe(ROW_A.content)
    await vi.waitFor(() => expect(screen.getByText('使用 4 次')).toBeTruthy())
  })

  it('creates a template with name, custom category and content only', async () => {
    const { api, commands } = makeApi([])
    render(<TemplatesSection onCommand={api} />)
    await vi.waitFor(() => expect(screen.getByText('还没有模板，先在上方创建一条')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '新模板' } })
    fireEvent.change(screen.getByLabelText('模板分类'), { target: { value: '办公' } })
    fireEvent.change(screen.getByLabelText('模板内容'), { target: { value: '总结 {{主题}}' } })
    expect(screen.getByLabelText('新建模板变量占位')?.textContent).toContain('{{主题}}')
    fireEvent.click(screen.getByLabelText('创建模板'))
    await vi.waitFor(() => expect(commands).toContainEqual(
      { action: 'create', name: '新模板', category: '办公', content: '总结 {{主题}}' }))
    // No visibility field ever leaves the section — private is structural.
    expect(JSON.stringify(commands[0])).not.toContain('visibility')
  })

  it('filters the list by a custom category', async () => {
    const { api } = makeApi([ROW_A, ROW_B])
    render(<TemplatesSection onCommand={api} />)
    await vi.waitFor(() => expect(screen.getByText('周报助手')).toBeTruthy())
    fireEvent.mouseDown(within(screen.getByLabelText('分类筛选')).getByRole('combobox'))
    // The dropdown portals to the body; row cards also say 研发, so pick the
    // option element inside the select's own item list.
    fireEvent.click(screen.getAllByText('研发').find((el) => el.closest('.ant-select-item'))!)
    expect(screen.queryByText('周报助手')).toBeNull()
    expect(screen.getByText('代码评审')).toBeTruthy()
  })

  it('edits and deletes through the same post-action list replies', async () => {
    const { api, commands } = makeApi([ROW_A])
    render(<TemplatesSection onCommand={api} />)
    await vi.waitFor(() => expect(screen.getByLabelText('编辑 周报助手')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('编辑 周报助手'))
    fireEvent.change(screen.getByLabelText('编辑模板名称'), { target: { value: '改名后' } })
    fireEvent.click(screen.getByLabelText('保存模板'))
    // The edit form is prefilled with the row's current facts, so the save
    // carries the whole edited form and the Server applies it as one PATCH.
    await vi.waitFor(() => expect(commands).toContainEqual({ action: 'update', templateId: 'tpl-a',
      name: '改名后', category: '办公', content: ROW_A.content }))
    // The single-slot command gate re-enables the row buttons only after the
    // update reply lands; wait for it before the next click.
    await vi.waitFor(() => expect((screen.getByLabelText('删除 周报助手') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByLabelText('删除 周报助手'))
    await vi.waitFor(() => expect(commands).toContainEqual({ action: 'delete', templateId: 'tpl-a' }))
    await vi.waitFor(() => expect(screen.queryByText('周报助手')).toBeNull())
  })
})

// --- the composer prefill semantics -------------------------------------------

describe('composer template prefill (#84)', () => {
  it('fills the draft on a template click, highlights placeholders, never auto-sends', async () => {
    const commands: ChatCommand[] = []
    render(<ChatView state={stateWith()} busy={false} attachmentView={null}
      onCommand={async (command) => { commands.push(command) }} />)
    const textarea = screen.getByLabelText('聊天消息') as HTMLTextAreaElement
    useSessionStore.getState().requestPrefill('请根据 {{要点}} 写周报，语气 {{语气}}。')
    await vi.waitFor(() => expect(textarea.value).toBe('请根据 {{要点}} 写周报，语气 {{语气}}。'))
    // The signal is consumed exactly once; re-renders never re-fill.
    await vi.waitFor(() => expect(useSessionStore.getState().pendingPrefill).toBeNull())
    const chips = screen.getByRole('status', { name: '消息占位待补填' })
    expect(chips.textContent).toContain('{{要点}}')
    expect(chips.textContent).toContain('{{语气}}')
    // Prefill only: nothing was sent by the click.
    expect(commands).toEqual([])
    // Filling one placeholder removes its chip; the send still needs the user.
    fireEvent.change(textarea, { target: { value: '请根据 周报要点 写周报，语气 {{语气}}。' } })
    expect(screen.getByRole('status', { name: '消息占位待补填' }).textContent).not.toContain('{{要点}}')
    expect(commands).toEqual([])
  })

  it('a fresh click replaces the draft; an empty draft keeps composer semantics', async () => {
    const commands: ChatCommand[] = []
    render(<ChatView state={stateWith()} busy={false} attachmentView={null}
      onCommand={async (command) => { commands.push(command) }} />)
    const textarea = screen.getByLabelText('聊天消息') as HTMLTextAreaElement
    useSessionStore.getState().requestPrefill('第一版 {{a}}')
    await vi.waitFor(() => expect(textarea.value).toBe('第一版 {{a}}'))
    useSessionStore.getState().requestPrefill('第二版 {{b}}')
    await vi.waitFor(() => expect(textarea.value).toBe('第二版 {{b}}'))
    expect(screen.getByRole('status', { name: '消息占位待补填' }).textContent).toContain('{{b}}')
    expect(commands).toEqual([])
  })
})
