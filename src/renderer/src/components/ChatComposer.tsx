import { useMemo, useRef, useState } from 'react'
import { Button, Input, Space, Switch, Tag, Typography } from 'antd'
import type { TextAreaRef } from 'rc-textarea'
import type { ChatAttachment, ChatAttachmentChoice, ChatCommand, ChatSnapshot } from '../../../shared/desktop'
import { ATTACHMENT_DESTINATION_LABELS, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_SKILLS } from '../../../shared/desktop'

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
  // start = the token's own marker character: match[0] is [prefix][marker][query].
  const tokenStart = match.index + match[0].length - 1 - match[1].length
  return { query: match[1], start: tokenStart }
}

/** Issue 75: the message composer restores the original input habits — `@`
 * at-mentions one Agent for this message (platform sub-agent delegation in
 * the SAME session: the main Agent and Thread are unchanged, in contrast to
 * the 新建平台聊天 flow which opens a new session), `/` mounts Skill chips
 * that persist across the session's messages (first chip first: the Runtime
 * maps it onto the platform's one explicit Skill per run and records the
 * whole mount on the run; a run without any explicit Skill is where the
 * account's own trigger-preference injection happens, matched only by the
 * Server). Enter sends, Shift+Enter newlines, and a composing IME never
 * sends. Issue 76: the collab switch restores the original mode toggle to
 * the input area — on (the default) one sentence can dispatch several
 * professional agents the platform runs as parallel sub-agents; off keeps
 * the lead Agent working alone for that run, and the at-mention picker
 * offers no candidates — a delegation entry that could not take effect is
 * never shown. Both states ride every send as an explicit boolean: the
 * platform's own silent default is delegation OFF (the Web client's mode
 * switch behaves the same), so "on" must say so. The team composition stays
 * the lead Agent's own configuration; the desktop provides no team
 * management surface. */
export function ChatComposer({ state, pending, canSend, sendBlockedReason, onCommand }: {
  state: ChatSnapshot
  pending: boolean
  canSend: boolean
  /** Issue 80: the visible reason sending is paused — shown while the
   * composer is disabled and no clarification is pending. */
  sendBlockedReason?: string
  onCommand: CommandHandler
}): JSX.Element {
  const [text, setText] = useState('')
  const [delegate, setDelegate] = useState<ComposerPick | null>(null)
  const [skills, setSkills] = useState<ComposerPick[]>([])
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [collab, setCollab] = useState(true)
  // Issue 93: one chip per picked attachment, each carrying its explicit
  // destination. The default is always 发送解析文本 — the device parses and
  // only the extracted text rides the message, the original never leaves
  // the machine. Nothing executes until the user acts.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const areaRef = useRef<TextAreaRef | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const threadId = state.thread?.id

  const addFiles = (files: FileList | File[] | null | undefined): void => {
    if (!files || !('length' in files) || files.length === 0) return
    setAttachments((current) => {
      const next = [...current]
      for (const file of Array.from(files)) {
        if (next.length >= MAX_MESSAGE_ATTACHMENTS) break
        const path = (file as File & { path?: string }).path
        // A dropped or picked item without a device path has no local file
        // to bind — skip it instead of inventing one.
        if (!path) continue
        next.push({ id: crypto.randomUUID(), path, name: file.name, destination: 'parsed-text' })
      }
      return next
    })
  }

  const removeAttachment = (id: string): void =>
    setAttachments((current) => current.filter((row) => row.id !== id))

  const chooseDestination = (row: ChatAttachment, choice: ChatAttachmentChoice): void => {
    if (choice === 'local-view') {
      // 仅本机查看 executes immediately: the Runtime parses on the device
      // and answers with a read-only display record; the chip is consumed
      // and never rides a send.
      if (!threadId) return
      removeAttachment(row.id)
      void onCommand({ action: 'attachment-view', scope: state.scope, threadId, id: row.id, path: row.path, name: row.name })
      return
    }
    setAttachments((current) => current.map((item) => item.id === row.id ? { ...item, destination: choice } : item))
  }

  const options = useMemo(() => {
    // Issue 76: collaboration off — delegation cannot take effect this run,
    // so the agent picker stays closed instead of faking an entry point.
    if (picker?.kind === 'agent' && !collab) return []
    const rows = state.resources.filter((resource) => resource.type === picker?.kind && resource.available)
    const query = (picker?.query || '').toLowerCase()
    return rows.filter((resource) => !query || resource.name.toLowerCase().includes(query) || resource.id.toLowerCase().includes(query))
      .map((resource) => ({ id: resource.id, name: resource.name }))
  }, [picker, state.resources, collab])

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

  const pick = (option: ComposerPick): void => picker?.kind === 'agent' ? pickAgent(option) : pickSkill(option)

  const send = (): void => {
    if (!canSend || pending || (!text.trim() && attachments.length === 0) || !threadId) return
    const message = text
    setText('')
    setDelegate(null)
    // Mounted Skills persist across the session's messages; only the
    // per-message delegation clears with the text. The collab switch rides
    // every send as an explicit boolean (#76): the platform's own silent
    // default is delegation OFF, so "on" must say so too. Each attachment's
    // chosen destination rides along (#93); the chips clear with the message.
    void onCommand({ action: 'send', scope: state.scope, threadId, turnId: crypto.randomUUID(), text: message,
      ...(delegate ? { delegateAgentId: delegate.id } : {}),
      ...(skills.length ? { skillIds: skills.map((skill) => skill.id) } : {}),
      ...(attachments.length ? { attachments: attachments.map(({ id, path, name, destination }) => ({ id, path, name, destination })) } : {}),
      collab })
    setAttachments([])
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
        if (option) pick(option)
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
  return <div className="w-full" role="group" aria-label="消息编辑区"
    onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (!disabled) addFiles(event.dataTransfer?.files) }}>
    {disabled && !pending && sendBlockedReason && <Typography.Text type="warning" className="text-xs"
      role="status">{sendBlockedReason}</Typography.Text>}
    {(delegate || skills.length > 0) && <div className="mb-2 flex flex-wrap gap-2">
      {delegate && <Tag closable aria-label={`已委派 ${delegate.name}`} color="blue"
        onClose={() => setDelegate(null)}>委派给：{delegate.name}</Tag>}
      {skills.map((skill, index) => <Tag key={skill.id} closable aria-label={`已挂载 ${skill.name}`} color="geekblue"
        onClose={() => setSkills((mounted) => mounted.filter((row) => row.id !== skill.id))}>
        {index === 0 ? '必用：' : '挂载：'}{skill.name}</Tag>)}
    </div>}
    {attachments.length > 0 && <ul role="list" aria-label="待发送附件" className="mb-2 flex flex-wrap gap-2 list-none p-0">
      {attachments.map((row) => <li key={row.id} aria-label={`附件 ${row.name}`}
        className="flex items-center gap-2 rounded border border-gray-200 bg-white px-2 py-1">
        <Typography.Text className="text-xs" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</Typography.Text>
        <select aria-label={`附件去向 ${row.name}`} className="text-xs rounded border border-gray-200 bg-white px-1 py-0.5"
          value={row.destination} disabled={disabled}
          onChange={(event) => chooseDestination(row, event.target.value as ChatAttachmentChoice)}>
          {(Object.keys(ATTACHMENT_DESTINATION_LABELS) as ChatAttachmentChoice[]).map((choice) => (
            <option key={choice} value={choice}>{ATTACHMENT_DESTINATION_LABELS[choice]}</option>
          ))}
        </select>
        <Button type="text" size="small" aria-label={`移除附件 ${row.name}`} disabled={disabled}
          onClick={() => removeAttachment(row.id)}>×</Button>
      </li>)}
    </ul>}
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
          onMouseDown={(event) => { event.preventDefault(); pick(option) }}>
          {option.name} <Typography.Text type="secondary" className="text-xs">{option.id}</Typography.Text>
        </li>)}
      </ul>}
    </div>
    <Space className="mt-2" wrap>
      <Button type="primary" aria-label="发送消息" disabled={disabled || (!text.trim() && attachments.length === 0)} onClick={send}>发送</Button>
      {!disabled && <input ref={fileRef} type="file" multiple aria-label="选择附件文件" className="hidden"
        onChange={(event) => { addFiles(event.target.files); event.target.value = '' }} />}
      <Button aria-label="添加附件" disabled={disabled} onClick={() => fileRef.current?.click()}>附件</Button>
      <Switch aria-label="协同模式" checked={collab} disabled={disabled} onChange={setCollab} size="small" />
      <Typography.Text type="secondary" className="text-xs">协同：一句话派发多个专业 Agent，平台并行子代理执行（团队由主 Agent 配置决定）</Typography.Text>
      <Typography.Text type="secondary" className="text-xs">Enter 发送 · Shift+Enter 换行 · @ 委派（仅本条消息，协同关闭时不可用）· / 挂载 Skill（首个为本会话必用）· 拖入或点“附件”添加附件，默认本机解析送文本，原件不会自动上传</Typography.Text>
    </Space>
  </div>
}
