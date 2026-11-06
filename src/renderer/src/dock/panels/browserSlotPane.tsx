// Issue 107 + 109: the browser slot's one explicit location choice. 本机 is
// the restored local webview browser (issue 107: fixed partition, intranet
// reach, downloads land in the confirmed workspace); 远端 is the platform's
// remote browser (issue 109: server-side pixels and server-held logins). The
// slot renders exactly one of them at a time — the location moves only
// through this visible choice, never silently, and the current location is
// always stated in place. The choice is pane-local and dies with the pane
// (the dock persistence contract strips volatile per-instance state).
import { useState } from 'react'
import BrowserPane from './browserPane'
import RemoteBrowserPane from './remoteBrowserPane'
import type { PanelTypeId } from '../types'

type BrowserLocation = 'local' | 'remote'

export default function BrowserSlotPane({ instanceId, panelType }: {
  instanceId: string
  panelType: PanelTypeId
}): JSX.Element {
  const [location, setLocation] = useState<BrowserLocation>('local')
  const choose = (next: BrowserLocation): void => { setLocation(next) }
  return (
    <div className="h-full w-full flex flex-col" style={{ background: 'var(--pane-bg, #FFFFFF)' }}>
      <div
        role="group" aria-label="浏览器位置选择"
        className="flex items-center gap-1 px-2 py-1 border-b text-xs"
        style={{ borderColor: 'var(--pane-border, #E2E8F0)' }}
      >
        <button
          type="button" aria-pressed={location === 'local'}
          title="跑在这台电脑上的内嵌浏览器：独立分区保存登录态，可访问本机网络与内网"
          className="px-2 py-0.5 border rounded"
          style={{
            borderColor: 'var(--pane-border, #CBD5E1)',
            background: location === 'local' ? 'var(--pane-tab-active, #DBEAFE)' : 'transparent'
          }}
          onClick={() => choose('local')}
        >本机</button>
        <button
          type="button" aria-pressed={location === 'remote'}
          title="跑在平台服务器上的浏览器：桌面经画面流查看与操控，登录态在服务器侧治理"
          className="px-2 py-0.5 border rounded"
          style={{
            borderColor: 'var(--pane-border, #CBD5E1)',
            background: location === 'remote' ? 'var(--pane-tab-active, #DBEAFE)' : 'transparent'
          }}
          onClick={() => choose('remote')}
        >远端</button>
        <span className="text-[11px] text-gray-400">位置只经此选择切换，本机与远端互不兜底、绝不静默切换</span>
      </div>
      <div className="flex-1 min-h-0">
        {location === 'local'
          ? <BrowserPane instanceId={instanceId} panelType={panelType} />
          : <RemoteBrowserPane instanceId={instanceId} panelType={panelType} />}
      </div>
    </div>
  )
}
