// Security seam module (issue 71): the only component source allowed for
// panes whose runtime is not 'native' (webview/webgl). It renders honest
// status text and nothing else — no trusted bridge access, no IPC channels,
// no embedded content. test/security.test.ts pins this: the registry must map
// every external-content panel type to this exact component, and this module's
// bundle graph must stay free of the bridge surface. Issue 110 wired the
// `terminal` slot as a native-hosted pane; issue 116 wired `field` the same
// way (desktop-local results over the guarded read seam); the Agent terminal
// (#111) is the remaining future seam in this family.
import type { PanelTypeId } from '../types'

interface PaneStatus {
  headline: string
  detail: string
}

// 未接入能力的如实状态：保留原版栏目位置，说明支持状态与不可用原因；
// 接入阶段对应 iDeer-Desktop #70（linz 全量能力等价总规格）的分期。
// issue 107 之后 browser 不再是占位：它映射到自己的 webview 窗格组件，
// 由主进程附加守卫与本文件之外的隔离不变量约束。
const EXTERNAL_PANE_STATUS: Partial<Record<PanelTypeId, PaneStatus>> = {
  viewer3d: {
    headline: '三维模型查看器未接入',
    detail: 'STEP/STL/OBJ 查看器在工程阶段接入，随包组件需先完成来源与许可核验。'
  },
  synapse: {
    headline: '会话地图未接入',
    detail: '会话地图依赖消息级分支等一期后续能力完成后接入。'
  }
}

// instanceId 保持未用：占位窗格无实例状态，签名与面板注册表保持一致。
export function ExternalPanePlaceholder({ panelType }: {
  instanceId: string
  panelType: PanelTypeId
}): JSX.Element {
  const status = EXTERNAL_PANE_STATUS[panelType]
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-2 p-6 text-center" style={{ background: 'var(--pane-bg, #FFFFFF)' }}>
      <div className="text-sm font-medium text-gray-700">{status ? status.headline : '该窗格未接入'}</div>
      <div className="max-w-md text-xs text-gray-500 leading-relaxed">
        {status ? status.detail : '该窗格尚未接入 iDeer Desktop，能力按总规格分期交付。'}
      </div>
      <div className="text-[11px] text-gray-400">保留原版入口位置 · 支持状态如实展示</div>
    </div>
  )
}

export default ExternalPanePlaceholder
