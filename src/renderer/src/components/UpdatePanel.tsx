import { useEffect, useState } from 'react'
import { Alert, Button, Card, Space, Typography } from 'antd'
import type { InstallOutcome, RecoveryView, UpdateCheckResult } from '../../../shared/desktop'

// Issue 107: one update entry. Checking and importing only verify and show
// the staged, pending state; installation is a separate, later confirmation.
export default function UpdatePanel(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [install, setInstall] = useState<InstallOutcome | null>(null)
  const [recovery, setRecovery] = useState<RecoveryView | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => { void window.ideer.recoveryState().then((state) => { if (state) setRecovery(state) }).catch(() => {}) }, [])

  const run = async (kind: 'online' | 'offline'): Promise<void> => {
    setBusy(true); setFailed(''); setResult(null); setInstall(null)
    try {
      setResult(kind === 'online' ? await window.ideer.checkUpdates() : await window.ideer.importUpdate())
    } catch (error) { setFailed(String(error).replace(/^Error:\s*/, '')) }
    finally { setBusy(false) }
  }

  const installNow = async (): Promise<void> => {
    setBusy(true); setFailed(''); setInstall(null)
    try { setInstall(await window.ideer.installUpdate()) }
    catch (error) { setFailed(String(error).replace(/^Error:\s*/, '')) }
    finally { setBusy(false) }
  }

  const pending = result?.pending
  return <Card className="max-w-3xl mt-6 shadow-card" title="更新检查与离线导入">
    <Typography.Paragraph type="secondary">
      在线检查使用已配对 Server 提供的受控地址；离线导入选择 manifest.json（同目录需有 manifest.sig）。
      两条路径都只做签名、完整性与兼容性校验，并停在待安装状态——检查或导入不等于安装同意，也不会修改任何文件。
    </Typography.Paragraph>
    <Space wrap>
      <Button disabled={busy} onClick={() => void run('online')}>检查更新（在线）</Button>
      <Button disabled={busy} onClick={() => void run('offline')}>导入离线补丁清单</Button>
    </Space>
    {failed && <Alert className="mt-4" type="error" showIcon message={`更新检查失败：${failed}`} />}
    {result && !result.ok && !failed && <Alert className="mt-4" type="warning" showIcon
      message={`更新被拒绝：${result.error}`}
      description="拒绝时不修改任何文件，也不扩大任何可见性。请核对发布来源或重新导出清单。" />}
    {pending && <Card type="inner" size="small" className="mt-4" title="待安装（未安装）">
      <Typography.Paragraph>类型：{pending.kind === 'full' ? '完整安装包建议' : '程序补丁'} · 来源：{pending.source === 'online' ? '在线检查' : '离线导入'}</Typography.Paragraph>
      <Typography.Paragraph>目标组合：Desktop {pending.desktopVersion} · Runtime Python {pending.runtimePython}</Typography.Paragraph>
      <Typography.Paragraph>Server 兼容要求：协议 ≥ {pending.serverCompatibility.minProtocol}
        {pending.serverCompatibility.notes ? ` · ${pending.serverCompatibility.notes}` : ''}</Typography.Paragraph>
      <Typography.Paragraph>变更文件 {pending.fileCount} 个 · 删除项 {pending.deletionCount} 个 · 校验时间 {pending.verifiedAt}</Typography.Paragraph>
      <Typography.Paragraph type="warning">{pending.advice}</Typography.Paragraph>
      <Button type="primary" disabled={busy} onClick={() => void installNow()}>确认并排空安装</Button>
    </Card>}
    {install && <Alert className="mt-4" type={install.installed ? 'success' : install.stage === 'launched' ? 'info' : 'warning'} showIcon
      message={install.installed ? `更新已核实：${install.detail}` : install.stage === 'launched'
        ? '维护进程已启动，重启后将核实 Desktop 和 Runtime 是否可用。' : `安装未执行（${install.stage}）：${install.detail}`} />}
    {recovery && <Alert className="mt-4" type={recovery.state === 'updated' ? 'success'
      : recovery.state === 'recovery-failed' ? 'error' : 'warning'} showIcon
      message={{ 'applied-pending-verify': '更新待重启核实', updated: '更新组合已核实',
        'rolled-back': '已恢复到更新前程序；自动更新已暂停', 'recovery-failed': '自动恢复失败，已停止自动更新' }[recovery.state]}
      description={`${recovery.detail}（Desktop ${recovery.desktopVersion} · Runtime Python ${recovery.runtimePython}）`} />}
  </Card>
}
