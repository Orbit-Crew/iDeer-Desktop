// Issue 86: the settings modal's 关窗即退出 toggle. The shell's window
// lifecycle preference is a device-local boolean owned by the main process
// (userData JSON, read at close time); this surface only reads it and writes
// exactly the inverse boolean through the desktop:preferences family. A
// failed read or save surfaces honestly — the switch never pretends a state
// it could not confirm.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Space, Switch, Typography } from 'antd'
import type { PreferenceCommand, PreferencesView } from '../../../../shared/desktop'

export const CLOSE_PREFERENCE_HINT =
  '默认关闭窗口只是隐藏到托盘：任务、审批与通知继续，Runtime 保持运行，点击托盘图标可回到窗口。'
    + '托盘菜单的「退出」始终真正退出并排空在途任务。开启后，关闭窗口即执行同样的真退出流程。'

export function ClosePreferenceView({ view, busy, error, onCommand }: {
  view: PreferencesView | null
  busy: boolean
  error: string
  onCommand: (command: PreferenceCommand) => void
}): JSX.Element {
  // The stored boolean is closeToTray (resident); the visible switch is its
  // inverse, 关窗即退出.
  const checked = view ? !view.closeToTray : false
  return <div>
    <Space className="w-full mb-1">
      <Switch aria-label="关窗即退出" checked={checked} disabled={busy || !view}
        onChange={(value) => onCommand({ action: 'set', closeToTray: !value })} />
      <Typography.Text>关窗即退出</Typography.Text>
    </Space>
    <Typography.Paragraph type="secondary" className="mb-1">{CLOSE_PREFERENCE_HINT}</Typography.Paragraph>
    {error && <Alert type="error" showIcon message={`设置未保存：${error}`} />}
  </div>
}

export default function ClosePreference(): JSX.Element {
  const [view, setView] = useState<PreferencesView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    try {
      const next = await window.ideer.preferences({ action: 'get' })
      if (current === generation.current) { setView(next); setError('') }
    } catch (exception) {
      if (current === generation.current) {
        setError(exception instanceof Error ? exception.message : String(exception))
      }
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const onCommand = (command: PreferenceCommand): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      const current = ++generation.current
      try {
        const next = await window.ideer.preferences(command)
        if (current === generation.current) { setView(next); setError('') }
      } catch (exception) {
        if (current === generation.current) {
          // The failed save keeps the last confirmed view visible; the next
          // load re-reads the store so the two never disagree silently.
          setError(exception instanceof Error ? exception.message : String(exception))
          void load()
        }
      } finally {
        if (current === generation.current) setBusy(false)
      }
    })()
  }

  return <ClosePreferenceView view={view} busy={busy} error={error} onCommand={onCommand} />
}
