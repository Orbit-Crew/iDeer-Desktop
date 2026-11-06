// Device pane (issue 71): stacks the existing Desktop platform surfaces so the
// restored dock keeps every current capability reachable. The cards keep their
// own controllers and semantics unchanged; this wrapper only adds the pane
// scroll container and the standing honest-state line from the former
// connection page. Issue 85 stacks the scheduled-tasks management card here
// too: it rides the same authenticated Runtime session as its siblings, so it
// is a pane section rather than a new dock pane type.
import { Alert } from 'antd'
import RuntimePanel from '../../components/RuntimePanel'
import ScheduledTasksPanel from '../../components/ScheduledTasksPanel'
import UpdatePanel from '../../components/UpdatePanel'
import CompatibilityPanel from '../../components/CompatibilityPanel'

export default function RuntimePane(): JSX.Element {
  return (
    <div className="h-full w-full overflow-auto p-4" style={{ background: 'var(--pane-bg, #F4F6FA)' }}>
      <Alert className="mb-4" type="info" showIcon
        message="配对后的设备可通过 Runtime 接收 Server 签名任务。尚未配置设备时，任务不可用。" />
      <ScheduledTasksPanel />
      <RuntimePanel />
      <UpdatePanel />
      <CompatibilityPanel />
    </div>
  )
}
