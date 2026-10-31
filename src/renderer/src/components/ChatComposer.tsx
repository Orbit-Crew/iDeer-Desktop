import { useMemo, useRef, useState } from 'react'
import { Button, Input, Space, Tag, Typography } from 'antd'
import type { TextAreaRef } from 'rc-textarea'
import type { ChatCommand, ChatSnapshot } from '../../../shared/desktop'
import { MAX_MESSAGE_SKILLS } from '../../../shared/desktop'

type CommandHandler = (command: ChatCommand) => Promise<void>

/** Issue 75: one composer fact picked through the input commands — the
 * at-mentioned delegate Agent for this message, or a mounted Skill chip.
 * Identity facts only; the ids come from the Server's own resource rows. */
interface ComposerPick { id: string; name: string }

interface PickerState { kind: 'agent' | 'skill'; query: string; start: number; active: number }

/** The trailing `@query` or `/query` before the caret, only where the token
 * begins the text or follows whitespace — the original composer habit. The
 * start points at the token's own `@` or `/`; the slash token is consumed
 * into a chip on pick, the at token becomes the visible `@Name ` mention the
 * platform's lead Agent reads. */
function triggerAt(text: string, caret: number, kind: 'agent' | 'skill'): { query: string; start: number } | null {
  const marker = kind === 'agent' ? '@' : '/'
  const match = new RegExp(`(?:^|\\s)\\${marker}([^\\s]*)$`).exec(text.slice(0, caret))
  if (!match) return null
  return { query: match[1], start: match.index + match[0].length - 1 - match[1].length }
}

/** Issue 75: the message composer restores the original input habits — `@`
 * at-mentions one Agent for this message (platform sub-agent delegation in
 * the SAME session: the main Agent and Thread are unchanged, in contrast to
 * the 新建平台聊天 flow which opens a new session), `/` mounts Skill chips
 * (first chip first: the Runtime maps it onto the platform's one explicit
 * Skill per run; the rest stay mounted and unnamed Skills are auto-injected
 * by the account's own trigger preferences, which only the Server matches).
 * Enter sends, Shift+Enter newlines, and a composing IME never sends. */
export function ChatComposer({ state, busy, pending, canSend, onCommand }: {
  state: ChatSnapshot
  busy: boolean
  pending: boolean
  canSend: boolean
  onCommand: CommandHandler
}): JSX.Element {
  const [text, setText] = useState('')
  const [delegate, setDelegate] = useState<ComposerPick | null>(null)
  const [skills, setSkills] = useState<ComposerPick[]>([])
  const [picker, setPicker] = useState<PickerState | null>(null)
  const areaRef = useRef<TextAreaRef | null>(null)
  const threadId = state.thread?.id

  const options = useMemo(() => {
    const rows = state.resources.filter((resource) => resource.type === picker?.kind && resource.available)
    const query = (picker?.query || '').toLowerCase()
    return rows.filter((resource) => !query || resource.name.toLowerCase().includes(query) || resource.id.toLowerCase().includes(query))
      .map((resource) => ({ id: resource.id, name: resource.name }))
  }, [picker, state.resources])

  const closePicker = (): void => setPicker(null)

  const caret = (): number => areaRef.current?.resizableTextArea?.textArea.selectionStart ?? text.length

  const syncPicker = (nextText: string, at: number): void => {
    const agent = triggerAt(nextText, at, 'agent')
    if (agent) {
      setPicker((current) => ({ kind: 'agent', query: agent.query, start: agent.start, active: current?.kind === 'agent' ? current.active : 0 }))
      return
    }
    const skill = triggerAt(nextText, at, 'skill')
    if (skill) {
      setPicker((current) => ({ kind: 'skill', query: skill.query, start: skill.start, active: current?.kind === 'skill' ? current.active : 0 }))
      return
    }
    setPicker(null)
  }

  const consumeToken = (replacement: string): void => {
    if (!picker) return
    const end = picker.start + 1 + picker.query.length
    setText(`${text.slice(0, picker.start)}${replacement}${text.slice(Math.min(end, text.length))}`)
  }

  const pickAgent = (option: ComposerPick): void => {
    // The mention stays in the message text (the lead Agent reads it and the
    // platform delegates through its own sub-agents); the chip is the
    // structured fact this command asserts.
    consumeToken(`@${option.name} `)
    setDelegate({ id: option.id, name: option.name })
    closePicker()
    requestAnimationFrame(() => areaRef.current?.focus())
  }

  const pickSkill = (option: ComposerPick): void => {
    consumeToken('')
    setSkills((mounted) => mounted.some((skill) => skill.id === option.id) || mounted.length >= MAX_MESSAGE_SKILLS
      ? mounted
      : [...mounted, { id: option.id, name: option.name }])
    closePicker()
    requestAnimationFrame(() => areaRef.current?.focus())
  }

  const send = (): void => {
    if (!canSend || pending || !text.trim() || !threadId) return
    const message = text
    setText('')
    setDelegate(null)
    // Mounted Skills persist across the session's messages; only the
    // per-message delegation clears with the text.
    void onCommand({ action: 'send', scope: state.scope, threadId, turnId: crypto.randomUUID(), text: message,
      ...(delegate ? { delegateAgentId: delegate.id } : {}),
      ...(skills.length ? { skillIds: skills.map((skill) => skill.id) } : {}) })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // An active IME composition owns Enter; never send or pick through it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (picker && options.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setPicker({ ...picker, active: (picker.active + 1) % options.length })
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setPicker({ ...picker, active: (picker.active - 1 + options.length) % options.length })
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const option = options[picker.active]
        if (option) picker.kind === 'agent' ? pickAgent(option) : pickSkill(option)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closePicker()
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  const disabled = !canSend || !!pending
  return <div className="w-full">
    {(delegate || skills.length > 0) && <div className="mb-2 flex flex-wrap gap-2">
      {delegate && <Tag closable aria-label={`已委派 ${delegate.name}`} color="blue"
        onClose={() => setDelegate(null)}>委派给：{delegate.name}</Tag>}
      {skills.map((skill, index) => <Tag key={skill.id} closable aria-label={`已挂载 ${skill.name}`} color="geekblue"
        onClose={() => setSkills((mounted) => mounted.filter((row) => row.id !== skill.id))}>
        {index === 0 ? '必用：' : '挂载：'}{skill.name}</Tag>)}
    </div>}
    <div className="relative">
      <Input.TextArea aria-label="聊天消息" ref={areaRef} value={text} maxLength={16000}
        autoSize={{ minRows: 3, maxRows: 10 }} disabled={disabled}
        placeholder={pending ? '请先回答上方问题' : '发送给平台 Agent（@ 点名 Agent 委派本条消息，/ 挂载必用 Skill）'}
        onChange={(event) => { setText(event.target.value); syncPicker(event.target.value, event.target.selectionStart ?? event.target.value.length) }}
        onKeyDown={onKeyDown} onBlur={() => { if (picker) closePicker() }} />
      {picker && options.length > 0 && <ul role="listbox" aria-label={picker.kind === 'agent' ? '@ Agent 候选' : '/ Skill 候选'}
        className="absolute z-10 left-0 right-0 bottom-full mb-1 max-h-48 overflow-auto rounded border border-gray-200 bg-white shadow-md">
        {options.map((option, index) => <li key={option.id} role="option" aria-selected={index === picker.active}
          className={`cursor-pointer px-3 py-1.5 text-sm ${index === picker.active ? 'bg-blue-50' : ''}`}
          onMouseDown={(event) => { event.preventDefault(); picker.kind === 'agent' ? pickAgent(option) : pickSkill(option) }}>
          {option.name} <Typography.Text type="secondary" className="text-xs">{option.id}</Typography.Text>
        </li>)}
      </ul>}
    </div>
    <Space className="mt-2">
      <Button type="primary" aria-label="发送消息" disabled={disabled || !text.trim()} onClick={send}>发送</Button>
      <Typography.Text type="secondary" className="text-xs">Enter 发送 · Shift+Enter 换行 · @ 委派（本会话内）· / 挂载 Skill</Typography.Text>
    </Space>
  </div>
}
