import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Collapse, Form, Input, InputNumber, Select, Space, Typography } from 'antd'
import type { ChatCommand, ChatSnapshot, HumanInputRequest } from '../../../shared/desktop'

type CommandHandler = (command: ChatCommand) => Promise<void>

function Clarification({ request, disabled, onAnswer }: {
  request: HumanInputRequest; disabled: boolean; onAnswer: (text?: string, optionId?: string) => void
}): JSX.Element {
  return <Card size="small" title={request.title || '需要你的输入'}>
    <Typography.Paragraph>{request.question}</Typography.Paragraph>
    {request.context && <Typography.Paragraph type="secondary">{request.context}</Typography.Paragraph>}
    <Space wrap className="mb-3">{request.options?.map((option) => <Button key={option.id} disabled={disabled}
      onClick={() => onAnswer(undefined, option.id)}>{option.label}</Button>)}</Space>
    {request.input_mode !== 'single_choice' && <Form disabled={disabled} onFinish={(values) => {
      if (request.input_mode === 'form') {
        const fields = request.fields || []
        const present = Object.fromEntries(fields.filter((field) => values[field.name] !== undefined && values[field.name] !== '').map((field) => [field.name, values[field.name]]))
        const summary = fields.filter((field) => field.name in present).map((field) => `${field.label}: ${String(present[field.name])}`).join('; ')
        onAnswer(`${summary} [values: ${JSON.stringify(present)}]`)
      } else onAnswer(values.answer)
    }}>
      {request.input_mode === 'form' ? request.fields?.map((field) => <Form.Item key={field.name}
        name={field.name} label={field.label} rules={[{ required: field.required }]} valuePropName={field.type === 'checkbox' ? 'checked' : 'value'}>
        {field.type === 'checkbox' ? <Checkbox /> : field.type === 'number' ? <InputNumber /> :
          ['select', 'multi_select'].includes(field.type) ? <Select mode={field.type === 'multi_select' ? 'multiple' : undefined}
            options={field.options?.map((o) => ({ label: o.label, value: o.value }))} /> :
            field.type === 'textarea' ? <Input.TextArea /> : <Input type={field.type === 'date' ? 'date' : 'text'} />}
      </Form.Item>) : <Form.Item name="answer" rules={[{ required: true, whitespace: true }]}>
        <Input.TextArea aria-label="澄清回答" maxLength={12000} />
      </Form.Item>}
      <Button htmlType="submit" disabled={disabled}>提交回答</Button>
    </Form>}
  </Card>
}

export function ChatView({ state, busy, onCommand }: {
  state: ChatSnapshot; busy: boolean; onCommand: CommandHandler
}): JSX.Element {
  return <ChatContents key={state.scope} state={state} busy={busy} onCommand={onCommand} />
}

function ChatContents({ state, busy, onCommand }: {
  state: ChatSnapshot; busy: boolean; onCommand: CommandHandler
}): JSX.Element {
  const [agentId, setAgentId] = useState<string | undefined>(state.thread?.agentId)
  const [skillId, setSkillId] = useState<string | undefined>(state.thread?.skillId || undefined)
  const [text, setText] = useState('')
  const threadId = state.thread?.id
  const answered = new Set(state.messages.flatMap((m) => m.response ? [m.response.request_id] : []))
  const pending = [...state.messages].reverse().find((m) => m.request && !answered.has(m.request.request_id))?.request
  const canSend = !busy && state.stream === 'idle' && !['pending', 'running'].includes(state.run?.status || '') && !!threadId && !!state.thread?.agentId
  const resourceOptions = (type: 'agent' | 'skill'): { value: string; label: string; disabled: boolean }[] => state.resources.filter((r) => r.type === type).map((r) => ({
    value: r.id, label: `${r.name} · ${r.visibility} · v${r.version ?? '未发布'} · ${r.id}${r.available ? '' : ' · 不可用'}`, disabled: !r.available
  }))
  return <Space direction="vertical" size="middle" className="w-full">
    <Space wrap>
      <Button onClick={() => void onCommand({ action: 'refresh' })} disabled={busy}>刷新资源与历史</Button>
      <Typography.Text type="secondary">由 Server 编排，凭证保留在系统安全存储中</Typography.Text>
    </Space>
    {state.error && <Alert type="error" showIcon message={`平台聊天不可用：${state.error}`} description={state.error === 'CONSENT_CONTENT_REDACTED'
      ? '审批内容包含受保护凭证，无法完整显示原始内容，已阻止批准。请修改写入请求。'
      : '请检查平台连接或重新登录。断线后不会自动重发旧提交，请恢复状态后核对原 Run。'} />}
    <Select aria-label="选择 Agent" placeholder="选择已发布 Agent" value={agentId} onChange={setAgentId}
      className="w-full" options={resourceOptions('agent')} disabled={busy} />
    <Select aria-label="选择 Skill" placeholder="可选：选择 Agent 已包含的 Skill" value={skillId} onChange={setSkillId}
      allowClear className="w-full" options={resourceOptions('skill')} disabled={busy} />
    <Button type="primary" disabled={busy || !agentId} onClick={() => {
      setText('')
      void onCommand({ action: 'create', scope: state.scope, agentId: agentId!, ...(skillId ? { skillId } : {}) })
    }}>新建平台聊天</Button>
    <Select aria-label="平台 Thread 历史" placeholder="重新打开平台 Thread" className="w-full" value={threadId}
      disabled={busy} options={state.threads.map((t) => ({ value: t.id, label: `${t.title} · ${t.status}` }))}
      onChange={(id) => { setText(''); void onCommand({ action: 'open', scope: state.scope, threadId: id }) }} />
    {threadId && <>
      <Typography.Text copyable>Thread：{threadId}</Typography.Text>
      {state.run && <Typography.Text>Run：{state.run.id} · {state.run.status} · {state.stream}</Typography.Text>}
      <Button disabled={busy || state.stream === 'streaming'} onClick={() => void onCommand({ action: 'reconnect', scope: state.scope, threadId })}>重新连接并恢复状态</Button>
      {state.localConsents?.filter((request) => request.threadId === threadId && request.runId === state.run?.id).map((request) => <Card
        key={`${request.taskId}-${request.requestHash}`} size="small" title="本机文件写入审批">
        <Typography.Paragraph>新建或覆盖：{request.path}</Typography.Paragraph>
        <Typography.Paragraph>Run：{request.runId} · 任务：{request.taskId}</Typography.Paragraph>
        <Typography.Paragraph copyable>请求 SHA-256：{request.requestHash}</Typography.Paragraph>
        <Typography.Paragraph>以下内容将按原始 UTF-8 字节写入。批准只适用于本次请求。</Typography.Paragraph>
        <Input.TextArea aria-label="审批写入内容" value={request.content} readOnly autoSize={{ minRows: 3, maxRows: 20 }} />
        <Space className="mt-3">
          <Button type="primary" disabled={busy} onClick={() => void onCommand({ action: 'consent', scope: state.scope,
            threadId, runId: request.runId, taskId: request.taskId, requestHash: request.requestHash, decision: 'allow' })}>仅允许这一次</Button>
          <Button danger disabled={busy} onClick={() => void onCommand({ action: 'consent', scope: state.scope,
            threadId, runId: request.runId, taskId: request.taskId, requestHash: request.requestHash, decision: 'deny' })}>拒绝写入</Button>
        </Space>
      </Card>)}
      <div role="log" aria-label="平台聊天消息" className="space-y-3 max-h-[50vh] overflow-auto">
        {state.messages.map((message) => <Card size="small" key={message.id} title={message.role === 'human' ? '你' : message.role === 'ai' ? 'Agent' : `工具 ${message.name}`}>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.text}</Typography.Paragraph>
          {pending && message.request?.request_id === pending.request_id && <Clarification key={pending.request_id} request={pending}
            disabled={!canSend} onAnswer={(answer, optionId) => void onCommand({ action: 'answer', scope: state.scope,
              threadId, turnId: crypto.randomUUID(), requestId: pending.request_id,
              ...(answer ? { text: answer } : {}), ...(optionId ? { optionId } : {}) })} />}
          {message.request && answered.has(message.request.request_id) && <Typography.Text type="secondary">已回答</Typography.Text>}
        </Card>)}
      </div>
      <Input.TextArea aria-label="聊天消息" value={text} maxLength={16000} autoSize={{ minRows: 3, maxRows: 10 }}
        disabled={!canSend || !!pending} placeholder={pending ? '请先回答上方问题' : '发送给平台 Agent'} onChange={(event) => setText(event.target.value)} />
      <Button type="primary" disabled={!canSend || !!pending || !text.trim()} onClick={() => {
        const message = text
        setText('')
        void onCommand({ action: 'send', scope: state.scope, threadId, turnId: crypto.randomUUID(), text: message })
      }}>发送</Button>
    </>}
    {!!state.events.length && <Collapse items={[{ key: 'progress', label: '服务端工具与子代理进度', children:
      state.events.map((event, i) => <div key={`${event.id}-${i}`}><Typography.Text>{event.id} · {event.event}</Typography.Text><pre className="whitespace-pre-wrap break-all text-xs">{event.detail}</pre></div>) }]} />}
    {state.run && Object.keys(state.run.selection).length > 0 && <Collapse items={[{ key: 'versions', label: '本次 Run 固定的资源与版本', children: <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(state.run.selection, null, 2)}</pre> }]} />}
  </Space>
}

export default function ChatPanel(): JSX.Element {
  const [state, setState] = useState<ChatSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)
  const actionInFlight = useRef(false)
  const pollRequest = useRef<Promise<void>>(Promise.resolve())
  const mounted = useRef(true)
  const scope = useRef('')
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (!inFlight.current && !actionInFlight.current) {
        inFlight.current = true
        pollRequest.current = (async () => { try {
          let next = await window.ideer.chat({ action: 'state' })
          if (next.scope && next.scope !== scope.current) next = await window.ideer.chat({ action: 'refresh' })
          if (mounted.current) { scope.current = next.scope; setState(next); setFailed(false) }
        } catch { if (mounted.current) { scope.current = ''; setState(null); setFailed(true) } }
        finally { inFlight.current = false } })()
        await pollRequest.current
      }
      if (mounted.current) timer = setTimeout(() => void poll(), 500)
    }
    void poll()
    return () => { mounted.current = false; clearTimeout(timer) }
  }, [])
  const command: CommandHandler = async (request) => {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy(true)
    await pollRequest.current
    try {
      const next = await window.ideer.chat(request)
      if (mounted.current) { scope.current = next.scope; setState(next); setFailed(false) }
    } catch { if (mounted.current) { setState(null); setFailed(true) } }
    finally { actionInFlight.current = false; if (mounted.current) setBusy(false) }
  }
  return <Card className="max-w-4xl mt-6 shadow-card" title="平台聊天与历史">
    {failed && <Alert type="error" message="Runtime 或 Server 不可用，请检查连接后恢复状态；旧提交不会自动重发" />}
    {state?.scope ? <ChatView state={state} busy={busy} onCommand={command} /> :
      <Alert type="info" showIcon message="请先在系统浏览器登录并绑定设备，再选择平台已有 Agent/Skill 聊天" />}
  </Card>
}
