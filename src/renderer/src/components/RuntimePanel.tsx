import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Input, Space, Typography } from 'antd'
import { emptyRuntimePanelView, RuntimePanelController } from '../stores/runtimePanel'

export default function RuntimePanel(): JSX.Element {
  const [view, setView] = useState(emptyRuntimePanelView)
  const { status, history, failed, historyError, clearing } = view
  const [server, setServer] = useState('')
  const [deviceName, setDeviceName] = useState('我的电脑')
  const [loginError, setLoginError] = useState(false)
  const [opening, setOpening] = useState(false)
  const [workspaceError, setWorkspaceError] = useState(false)
  const [historyOffset, setHistoryOffset] = useState(0)
  const controller = useRef<RuntimePanelController | null>(null)
  useEffect(() => {
    let active = true
    const current = new RuntimePanelController(window.ideer, next => { if (active) setView(next) })
    controller.current = current
    void current.refresh(historyOffset)
    const timer = setInterval(() => void current.refresh(historyOffset), 1000)
    return () => { active = false; current.invalidate(); clearInterval(timer); if (controller.current === current) controller.current = null }
  }, [historyOffset])
  const runtime = status?.runtime
  const login = runtime?.login
  const processNames = { stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', crashed: '异常退出', missing: '随附文件缺失', unresponsive: '无响应' }
  const connectionNames = { 'not-configured': '未配置设备', connecting: '连接中', connected: '已连接', offline: '未连接', paused: '已暂停', error: '设备配置或凭证不可用' }
  return <Card className="max-w-3xl mt-6 shadow-card" title="本机 Runtime">
    <Typography.Title level={5}>平台账号与设备绑定</Typography.Title>
    <Typography.Paragraph>在系统浏览器登录已有账号或 SSO，核对设备后确认绑定。完成交换前，桌面业务会话为未认证。</Typography.Paragraph>
    <Space direction="vertical" className="w-full mb-4">
      <Input aria-label="平台统一入口" placeholder="https://平台统一入口" value={server} onChange={(event) => setServer(event.target.value)} disabled={login?.state === 'authenticated'} />
      <Input aria-label="设备名称" value={deviceName} maxLength={255} onChange={(event) => setDeviceName(event.target.value)} disabled={login?.state === 'authenticated'} />
      <Button type="primary" loading={opening} disabled={login?.state === 'awaiting-confirmation' || login?.state === 'authenticated'} onClick={() => {
        setOpening(true); setLoginError(false)
        void window.ideer.beginLogin(server, deviceName).catch(() => setLoginError(true)).finally(() => setOpening(false))
      }}>在浏览器登录并绑定此设备</Button>
      {loginError && <Alert type="error" message="无法开始登录，请检查 HTTPS 统一入口和 Runtime 状态" />}
      {login?.state === 'awaiting-confirmation' && <Alert type="info" message="等待浏览器确认本人设备，桌面业务会话尚未建立" />}
      {login?.verification && <Typography.Text>设备校验码：{login.verification}</Typography.Text>}
      {login?.error && <Alert type="error" message={`登录未完成：${login.error}`} />}
      <Typography.Text>桌面业务会话：{login?.state === 'authenticated' ? '已认证' : '未认证'}</Typography.Text>
      {login?.state === 'authenticated' && <Typography.Text>账号：{login.account} · 设备：{login.device}</Typography.Text>}
    </Space>
    {failed ? <Alert type="error" message="无法读取 Runtime 状态，当前不可执行任务" /> : <>
      <Typography.Paragraph>进程：{runtime ? processNames[runtime.process] : '读取中'} {runtime?.pid ? `（PID ${runtime.pid}）` : ''}</Typography.Paragraph>
      <Typography.Paragraph>设备连接：{runtime ? connectionNames[runtime.connection] : '读取中'}</Typography.Paragraph>
    </>}
    <Space>
      <Button disabled={!runtime || !['stopped', 'crashed'].includes(runtime.process)} onClick={() => void window.ideer.startRuntime().catch(() => setView(current => ({ ...current, failed: true })))}>启动 Runtime</Button>
      <Button disabled={!runtime || !['running', 'starting', 'unresponsive'].includes(runtime.process)} onClick={() => void controller.current?.stop()}>停止 Runtime</Button>
    </Space>
    <Typography.Title level={5} className="mt-5">只读工作目录</Typography.Title>
    <Typography.Paragraph>按会话需要将文件名或文本发送到 Server 和模型，不自动上传整目录。目录不登记为平台 Resource。授权限当前账号与设备，切换目录后旧路径失效。</Typography.Paragraph>
    <Typography.Paragraph>{runtime?.workspace?.state === 'ready' ? runtime.workspace.logicalRoot : '尚未选择并确认目录'}</Typography.Paragraph>
    <Button disabled={login?.state !== 'authenticated'} onClick={() => {
      setWorkspaceError(false)
      void window.ideer.chooseWorkspace().catch(() => setWorkspaceError(true))
    }}>选择并授权只读目录</Button>
    {workspaceError && <Alert type="error" message="目录不可用或授权未完成，请选择普通工作目录" />}
    <Typography.Title level={5} className="mt-5">执行回执历史</Typography.Title>
    <Typography.Paragraph>重连只补传回执，不会重做操作。未确认和结果待核实的记录会持续保留；此处最多显示最近 20 条，存储不受显示数量限制。</Typography.Paragraph>
    {(runtime?.receiptStorageError || history?.storageError) && <Alert type="error" message="可靠记录存储不可用，已阻止新操作。已发生效果的任务请核实结果；修复本机存储后重试。" />}
    {historyError && <Alert type="error" message="无法读取回执历史，不能据此判断记录为空" />}
    {history && <Typography.Paragraph>共 {history.total} 条 · 待确认 {history.pending} · 已确认 {history.confirmed} · 结果待核实 {history.uncertain} · 已清理标记 {history.cleaned}</Typography.Paragraph>}
    <Button loading={clearing} disabled={!history?.confirmed || runtime?.process !== 'running'} onClick={() => void controller.current?.clearConfirmed(historyOffset)}>清理已确认回执</Button>
    <Space className="ml-3">
      <Button disabled={historyOffset === 0} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 20))}>较新回执</Button>
      <Button disabled={!history || historyOffset + 20 >= history.total} onClick={() => setHistoryOffset(historyOffset + 20)}>较早回执</Button>
    </Space>
    {history?.rows.map(row => <Typography.Paragraph key={row.receipt_id}>
      {row.task_id} · {row.run_id} · {row.tool_call_id} · {row.capability} · {row.logical_target} · {row.user_id} / {row.device_id} · {row.status} · {row.error_code} ·
      {{ pending: '待确认，等待原身份合法连接', confirmed: 'Server 已确认', uncertain: '结果待核实', cleaned: '已清理，保留标记' }[row.delivery_state] || row.delivery_state}
    </Typography.Paragraph>)}
    <Typography.Title level={5} className="mt-5">近期任务</Typography.Title>
    {!runtime?.tasks.length ? <Typography.Text type="secondary">暂无任务记录</Typography.Text> : runtime.tasks.map((task, index) => <Typography.Paragraph key={`${task.taskId}-${index}`}>
      {task.taskId} · {task.runId} · {task.capability} · {task.state}
    </Typography.Paragraph>)}
  </Card>
}
