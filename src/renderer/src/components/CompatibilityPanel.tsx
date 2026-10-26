import { useEffect, useState } from 'react'
import { Alert, Button, Card, Typography } from 'antd'
import type { CompatibilityView } from '../../../shared/desktop'

// Issue 110: one place to see and refresh the combination compatibility gate.
// The gate only stops or allows local work; it never grants permissions.
export default function CompatibilityPanel(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<CompatibilityView | null>(null)
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const result = await window.ideer.refreshCompatibility()
      if ('level' in result) { setView(result); setError(result.error || '') }
      else if (result.error) { setView(null); setError(result.error) }
    } catch (failure) { setView(null); setError(String(failure).replace(/^Error:\s*/, '')) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    void refresh()
    let active = true
    const poll = setInterval(() => {
      void window.ideer.getStatus().then(status => {
        const effective = status.runtime.compatibility
        if (active && effective?.level) { setView(effective); setError(effective.error || '') }
      }).catch(() => {})
    }, 1000)
    return () => { active = false; clearInterval(poll) }
  }, [])

  return <Card className="max-w-3xl mt-6 shadow-card" title="组合兼容状态">
    <Typography.Paragraph type="secondary">
      兼容声明由已配对 Server 的受控地址提供并验签。单项不兼容只停该能力；核心不兼容停止新的本地任务，
      历史与未确认执行记录完整保留，未知任务不会当作未执行。功能开关不替代权限：Server 授权与本地策略仍决定每个请求。
    </Typography.Paragraph>
    <Button disabled={busy} onClick={() => void refresh()}>刷新兼容声明</Button>
    {error && <Alert className="mt-4" type="warning" showIcon message={`兼容声明不可用：${error}`}
      description="无法核验现有兼容声明时停止新的本地任务；记录与历史保留。首次未发布声明仅保留旧协议 1 行为。" />}
    {view && <div className="mt-4">
      <Typography.Paragraph>级别：{{ compatible: '组合兼容', capability: '单项能力不兼容', core: '核心不兼容（已停新本地任务）' }[view.level]}</Typography.Paragraph>
      {view.disabledCapabilities.length > 0 && <Typography.Paragraph>停用能力：{view.disabledCapabilities.join('、')}</Typography.Paragraph>}
      <Typography.Paragraph>候选组合：Desktop {view.candidateCombo.desktop} · Runtime {view.candidateCombo.runtime} · Server {view.candidateCombo.server}</Typography.Paragraph>
      {view.actualCombo && <Typography.Paragraph>当前组合：Desktop {view.actualCombo.desktop} · Runtime {view.actualCombo.runtime} · Server {view.actualCombo.server || '等待已认证 Server 握手'}</Typography.Paragraph>}
      {view.notes && <Typography.Paragraph type="secondary">{view.notes}</Typography.Paragraph>}
      <Typography.Paragraph type={view.level === 'compatible' ? 'secondary' : 'warning'}>{view.advice}</Typography.Paragraph>
    </div>}
  </Card>
}
