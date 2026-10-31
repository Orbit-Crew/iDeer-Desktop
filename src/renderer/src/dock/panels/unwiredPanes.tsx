// Native panel types whose capability is not wired yet (issue 71). They keep
// the original column position with an honest status; unlike external-content
// panes these may use the trusted bridge once their capability lands, so they
// live outside the security seam module.
import type { PanelTypeId } from '../types'

const UNWIRED_PANE_STATUS: Partial<Record<PanelTypeId, { headline: string; detail: string }>> = {
  files: {
    headline: '文件树窗格未接入',
    detail: '人工文件浏览与多格式只读预览在"项目与文件"阶段接入；当前工作目录选择与授权在"本机 Runtime"面板。'
  },
  kb: {
    headline: '知识库窗格未接入',
    detail: '知识导入、图谱与 Wiki 当前在"本机 Runtime"面板，知识阶段迁入对应窗格。'
  }
}

// instanceId 保持未用：占位窗格无实例状态，签名与面板注册表保持一致。
export function UnwiredNativePane({ panelType }: {
  instanceId: string
  panelType: PanelTypeId
}): JSX.Element {
  const status = UNWIRED_PANE_STATUS[panelType]
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-sm font-medium text-gray-700">{status ? status.headline : '该窗格尚未接入'}</div>
      <div className="max-w-md text-xs text-gray-500 leading-relaxed">
        {status ? status.detail : '该窗格尚未接入 iDeer Desktop，能力按总规格分期交付。'}
      </div>
      <div className="text-[11px] text-gray-400">保留原版入口位置 · 支持状态如实展示</div>
    </div>
  )
}

export default UnwiredNativePane
