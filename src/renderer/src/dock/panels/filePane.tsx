// Files pane (issue 94): hosts the restored FilePanel in the dock's native
// pane container, with the same scroll discipline as the device pane.
import FilePanel from '../../components/FilePanel'

export default function FilePane({ instanceId, panelType }: {
  instanceId: string
  panelType: string
}): JSX.Element {
  return (
    <div className="h-full w-full" style={{ background: 'var(--pane-bg, #F4F6FA)' }}>
      <FilePanel instanceId={instanceId} panelType={panelType} />
    </div>
  )
}
