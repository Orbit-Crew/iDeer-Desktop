import { useEffect, useState } from 'react'
import { Alert, Button, Card, Space, Typography } from 'antd'
import type { DesktopStatus } from '../../../shared/desktop'

export default function RuntimePanel(): JSX.Element {
  const [status, setStatus] = useState<DesktopStatus | null>(null)
  const [failed, setFailed] = useState(false)
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
  const processNames = { stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', crashed: '异常退出', missing: '随附文件缺失', unresponsive: '无响应' }
  const connectionNames = { 'not-configured': '未配置设备', connecting: '连接中', connected: '已连接', offline: '未连接', paused: '已暂停', error: '设备配置或凭证不可用' }
  return <Card className="max-w-3xl mt-6 shadow-card" title="本机 Runtime">
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
