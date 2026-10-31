import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Collapse, Form, Input, InputNumber, Select, Space, Typography } from 'antd'
import type { ChatCommand, ChatSnapshot, HumanInputRequest, LocalConsentView } from '../../../shared/desktop'

type CommandHandler = (command: ChatCommand) => Promise<void>

const taskStates: Record<string, string> = { unknown: '结果待核实', result_not_verified: '结果待核实',
  dispatched: '已派发', acked: '已接收', progress: '执行中', consent_required: '待审批',
  cancel_requested: '已请求停止，结果待核实', completed: '已完成', cancelled: '已停止', denied: '已拒绝', failed: '失败' }
const deliveryStates: Record<string, string> = { uncertain: '结果待核实', pending: '待补传', confirmed: 'Server 已确认', cleaned: '已清理的已确认回执' }

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

type ConsentCardProps = {
  request: LocalConsentView
  state: ChatSnapshot
  threadId: string | undefined
  busy: boolean
  blocked: (capability: string) => boolean
  onCommand: CommandHandler
}

const consentCommand = (request: LocalConsentView, state: ChatSnapshot, threadId: string | undefined,
  decision: 'allow' | 'allow-directory' | 'deny', extra: Record<string, unknown> = {}): ChatCommand =>
  ({ action: 'consent', scope: state.scope, threadId: threadId ?? '', runId: request.runId, taskId: request.taskId,
    requestHash: request.requestHash, decision, ...extra })

function FileWriteConsentCard({ request, state, threadId, busy, blocked, onCommand }: ConsentCardProps): JSX.Element {
  return <Card size="small" title="本机文件写入审批">
    <Typography.Paragraph>新建或覆盖：{request.path}</Typography.Paragraph>
    <Typography.Paragraph>Run：{request.runId} · 任务：{request.taskId}</Typography.Paragraph>
    <Typography.Paragraph copyable>请求 SHA-256：{request.requestHash}</Typography.Paragraph>
    <Typography.Paragraph>以下内容将按原始 UTF-8 字节写入。一次允许仅批准本次请求。</Typography.Paragraph>
    {request.directory && <Typography.Paragraph>持续授权范围：{request.directory} 及其子目录中的文本新建与覆盖。受保护路径和脚本仍受限制，可在设置撤销。</Typography.Paragraph>}
    <Input.TextArea aria-label="审批写入内容" value={request.content} readOnly autoSize={{ minRows: 3, maxRows: 20 }} />
    <Space className="mt-3">
      <Button type="primary" disabled={busy || blocked('local.files.write')}
        onClick={() => void onCommand(consentCommand(request, state, threadId, 'allow'))}>仅允许这一次</Button>
      {request.directory && <Button disabled={busy || blocked('local.files.write')}
        onClick={() => void onCommand(consentCommand(request, state, threadId, 'allow-directory'))}>始终允许此目录的文本写入</Button>}
      <Button danger disabled={busy}
        onClick={() => void onCommand(consentCommand(request, state, threadId, 'deny'))}>拒绝写入</Button>
    </Space>
  </Card>
}

function ScriptConsentCard({ request, state, threadId, busy, blocked, onCommand }: ConsentCardProps): JSX.Element {
  const [remember, setRemember] = useState(false)
  return <Card size="small" title="本机技能脚本审批">
    <Typography.Paragraph>技能：{request.skill} · 脚本：{request.scriptPath} · 版本 V{request.version}</Typography.Paragraph>
    <Typography.Paragraph>Run：{request.runId} · 任务：{request.taskId}</Typography.Paragraph>
    <Typography.Paragraph copyable>脚本 SHA-256：{request.scriptSha256}</Typography.Paragraph>
    <Typography.Paragraph copyable>环境范围 SHA-256：{request.requirementsSha256}</Typography.Paragraph>
    <Typography.Paragraph>
      脚本默认关闭：这次允许只批准这一个脚本内容与其声明的环境范围，执行结果回执由本机记录。
    </Typography.Paragraph>
    <Checkbox aria-label={`记住脚本授权 ${request.scriptPath ?? ''}`} checked={remember}
      onChange={(event) => setRemember(event.target.checked)}>
      记住此授权（只绑定当前脚本内容与环境范围；内容或范围变化会重新询问，可随时撤销）
    </Checkbox>
    <Space className="mt-3">
      <Button type="primary" disabled={busy || blocked('local.skill.script')}
        onClick={() => void onCommand(consentCommand(request, state, threadId, 'allow',
          remember ? { rememberScript: true } : {}))}>允许执行</Button>
      <Button danger disabled={busy}
        onClick={() => void onCommand(consentCommand(request, state, threadId, 'deny'))}>拒绝执行</Button>
    </Space>
  </Card>
}

function MaterialConsentCard({ request, state, threadId, busy, blocked, onCommand }: ConsentCardProps): JSX.Element {
  return <Card size="small" title="本机知识取材审批">
    <Typography.Paragraph>读取已登记知识版本中的冻结文档，用于平台编排的图谱/Wiki 生成。</Typography.Paragraph>
    <Typography.Paragraph>版本：{request.revisionId} · 清单：{request.manifestHash}</Typography.Paragraph>
    <Typography.Paragraph>Run：{request.runId} · 任务：{request.taskId}</Typography.Paragraph>
    <Typography.Paragraph copyable>请求 SHA-256：{request.requestHash}</Typography.Paragraph>
    {(request.documents ?? []).map((document) => <Typography.Paragraph key={document.filename} style={{ overflowWrap: 'anywhere' }}>
      {document.filename} · 文档指纹 {document.contentHash}
    </Typography.Paragraph>)}
    <Typography.Paragraph type="secondary">设备会先核对文档指纹与冻结清单一致才返回内容；拒绝则该文档按失败如实展示。</Typography.Paragraph>
    <Space className="mt-3">
      <Button type="primary" disabled={busy || blocked('local.knowledge.material')}
        onClick={() => void onCommand(consentCommand(request, state, threadId, 'allow'))}>允许读取</Button>
      <Button danger disabled={busy}
        onClick={() => void onCommand(consentCommand(request, state, threadId, 'deny'))}>拒绝读取</Button>
    </Space>
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
  const compatibility = state.compatibility
  const blocked = (capability: string): boolean => compatibility?.level === 'core' || !!compatibility?.disabledCapabilities.includes(capability)
  const answered = new Set(state.messages.flatMap((m) => m.response ? [m.response.request_id] : []))
  const pending = [...state.messages].reverse().find((m) => m.request && !answered.has(m.request.request_id))?.request
  // Issue 73: an unavailable model pauses sending until the user switches;
  // nothing switches silently behind the user's back.
  const canSend = !busy && state.stream === 'idle' && !['pending', 'running'].includes(state.run?.status || '') && !!threadId && !!state.thread?.agentId &&
    state.model?.available !== false
  const modelSourceLabels: Record<string, string> = {
    'session-override': '本会话临时选择', 'account-default': '账号默认', 'platform-default': '平台默认'
  }
  const modelOptions = (state.modelOptions ?? []).map((row) => ({ value: row.name, label: row.displayName || row.name }))
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
      {compatibility && compatibility.level !== 'compatible' && <Alert type="warning" message={compatibility.advice}
        description={compatibility.disabledCapabilities.length ? `停用能力：${compatibility.disabledCapabilities.join('、')}` : compatibility.error} />}
      {state.model?.notice && <Alert type="warning" showIcon message={state.model.notice} />}
      {state.model && !state.model.available && <Alert type="error" showIcon
        message={`模型 ${state.model.name} 已不可用，发送已暂停`}
        description="该模型已不在平台授权列表或当前账号无权使用。请在下方更换模型；未更换前不会发送新消息，也不会静默切换。" />}
      <div className="flex items-center gap-3">
        <Select aria-label="本会话模型" className="min-w-[240px]" placeholder="平台默认模型"
          value={state.model?.source === 'session-override' && state.model.name ? state.model.name : undefined}
          allowClear disabled={busy || state.stream === 'streaming'} options={modelOptions}
          onChange={(name) => void onCommand({ action: 'set-model', scope: state.scope, threadId, modelName: name ?? '' })} />
        <Typography.Text type="secondary">
          本会话模型：{state.model?.name || '平台默认'}{state.model ? ` · ${modelSourceLabels[state.model.source] || state.model.source}` : ''}
        </Typography.Text>
      </div>
      <Typography.Text copyable>Thread：{threadId}</Typography.Text>
      {state.downloadStatus === 'saved' && <Alert type="success" message="附件已保存，内容 SHA-256 已核验。" />}
      {state.downloadStatus === 'cancelled' && <Alert type="info" message="已取消保存附件。" />}
      {!!state.artifacts?.length && <Card size="small" title="Thread 平台附件">
        {state.artifacts.map((artifact) => <div key={artifact.artifact_id}>
          <Typography.Paragraph>{artifact.name} · {artifact.bytes} 字节 · SHA-256 {artifact.sha256}</Typography.Paragraph>
          <Button disabled={busy} onClick={() => void onCommand({ action: 'download', scope: state.scope,
            threadId, artifactId: artifact.artifact_id })}>下载附件 {artifact.name}</Button>
        </div>)}
      </Card>}
      {state.run && <Typography.Text>Run：{state.run.id} · {state.run.status} · {state.stream}</Typography.Text>}
      {state.run && ['pending', 'running'].includes(state.run.status) && state.stop?.state !== 'requested' && <Button danger disabled={busy}
        onClick={() => void onCommand({ action: 'stop', scope: state.scope, threadId, runId: state.run!.id })}>{state.stop ? '重试停止请求' : '停止当前 Turn'}</Button>}
      {state.stop && <Alert type="warning" showIcon message={state.stop.state === 'requested' ? '已请求停止，最终事实以任务回执为准' : '停止请求结果待核实，请恢复状态核对'}
        description="已提交的文件修改不会回滚。断线和重启不会自动重派写操作，迟到回执只核实历史任务。" />}
      <Button disabled={busy || state.stream === 'streaming'} onClick={() => void onCommand({ action: 'reconnect', scope: state.scope, threadId })}>重新连接并恢复状态</Button>
      {state.taskError && <Alert type="warning" message={`本地任务历史待核实：${state.taskError}`} description="当前显示的是上次核对结果，请恢复连接后再次核对。" />}
      {!!state.localTasks?.length && <Card size="small" title="本会话的本地任务与回执">
        <Typography.Paragraph type="secondary">进度与文件结果分别核对。已提交的文件修改不会回滚；结果待核实时不会自动重派。本地结果仅保存在生成它的设备上，不会自动上传；平台附件在 Server 端共享。</Typography.Paragraph>
        {state.localTasks.map((task) => <Card size="small" key={task.task_id}>
          <Typography.Paragraph>Run：{task.run_id} · 任务：{task.task_id}</Typography.Paragraph>
          <Typography.Paragraph>{task.capability} · {task.logical_target}</Typography.Paragraph>
          <Typography.Paragraph>Server 任务：{taskStates[task.status] || task.status}{task.stop_requested ? ' · 已请求停止' : ''}</Typography.Paragraph>
          {task.receipt && <Typography.Paragraph>Server 回执：{taskStates[task.receipt.status || 'unknown'] || task.receipt.status}</Typography.Paragraph>}
          <Typography.Paragraph>本机回执：{task.local ? `${taskStates[task.local.status] || task.local.status} · ${deliveryStates[task.local.delivery_state] || task.local.delivery_state}` : '本机无可核实回执'}</Typography.Paragraph>
          {task.localResult && <Card type="inner" size="small" title="本地生成结果（仅原设备可用）">
            <Typography.Paragraph>文件：{task.localResult.name} · {task.localResult.bytes} 字节</Typography.Paragraph>
            <Typography.Paragraph copyable style={{ overflowWrap: 'anywhere' }}>SHA-256：{task.localResult.sha256}</Typography.Paragraph>
            {task.localResult.artifact_ref
              ? <Typography.Paragraph>平台附件：{task.localResult.artifact_ref}（可在其他已授权设备下载）</Typography.Paragraph>
              : <>
                <Typography.Paragraph type="secondary">此结果尚未上传。查看或展示不会上传；上传需要你在此明确确认，并作为该 Thread 的附件受平台访问控制。</Typography.Paragraph>
                <Button disabled={busy || blocked('local.artifacts.upload')} onClick={() => void onCommand({ action: 'upload', scope: state.scope, threadId,
                  runId: task.run_id, taskId: task.task_id, decision: 'allow' })}>明确授权上传为 Thread 附件</Button>
              </>}
          </Card>}
          {!!task.artifacts?.length && <Card type="inner" size="small" title="平台附件">
            {task.artifacts.map((artifact) => <Typography.Paragraph key={artifact.artifact_id} style={{ overflowWrap: 'anywhere' }}>
              {artifact.name} · {artifact.bytes} 字节 · SHA-256 {artifact.sha256} · 附件 {artifact.artifact_id}
            </Typography.Paragraph>)}
          </Card>}
          {(task.error_code || task.local?.error_code) && <Typography.Text type="warning">{task.error_code || task.local?.error_code}</Typography.Text>}
        </Card>)}
      </Card>}
      {state.localConsents?.filter((request) => !state.stop && request.threadId === threadId && request.runId === state.run?.id).map((request) => {
        if (request.kind === 'skill-script') return <ScriptConsentCard key={`${request.taskId}-${request.requestHash}`}
          request={request} state={state} threadId={threadId} busy={busy} blocked={blocked} onCommand={onCommand} />
        if (request.kind === 'knowledge-material') return <MaterialConsentCard key={`${request.taskId}-${request.requestHash}`}
          request={request} state={state} threadId={threadId} busy={busy} blocked={blocked} onCommand={onCommand} />
        return <FileWriteConsentCard key={`${request.taskId}-${request.requestHash}`}
          request={request} state={state} threadId={threadId} busy={busy} blocked={blocked} onCommand={onCommand} />
      })}
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
