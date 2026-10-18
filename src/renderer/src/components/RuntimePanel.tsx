import { useEffect, useState } from 'react'
import { Alert, Button, Card, Input, Space, Typography } from 'antd'
import type { DesktopStatus } from '../../../shared/desktop'

export default function RuntimePanel(): JSX.Element {
  const [status, setStatus] = useState<DesktopStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [server, setServer] = useState('')
  const [deviceName, setDeviceName] = useState('我的电脑')
  const [loginError, setLoginError] = useState(false)
  const [opening, setOpening] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.ideer.getStatus()
        if (active) { setStatus(next); setFailed(false) }
      } catch { if (active) setFailed(true) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1000)
    return () => { active = false; clearInterval(timer) }
  }, [])
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
      <Button disabled={!runtime || !['stopped', 'crashed'].includes(runtime.process)} onClick={() => void window.ideer.startRuntime().catch(() => setFailed(true))}>启动 Runtime</Button>
      <Button disabled={!runtime || !['running', 'starting', 'unresponsive'].includes(runtime.process)} onClick={() => void window.ideer.stopRuntime().catch(() => setFailed(true))}>停止 Runtime</Button>
    </Space>
    <Typography.Title level={5} className="mt-5">近期任务</Typography.Title>
    {!runtime?.tasks.length ? <Typography.Text type="secondary">暂无任务记录</Typography.Text> : runtime.tasks.map((task, index) => <Typography.Paragraph key={`${task.taskId}-${index}`}>
      {task.taskId} · {task.runId} · {task.capability} · {task.state}
    </Typography.Paragraph>)}
  </Card>
}
