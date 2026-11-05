// Templates pane (issue 84): hosts the prompt-template plaza in the dock's
// native pane container, with the same scroll discipline as the device pane.
import TemplatesSection from '../../components/TemplateSection'

export default function TemplatesPane({ instanceId, panelType }: {
  instanceId: string
  panelType: string
}): JSX.Element {
  return (
    <div className="h-full w-full overflow-auto p-4" style={{ background: 'var(--pane-bg, #F4F6FA)' }}>
      <TemplatesSection />
    </div>
  )
}
