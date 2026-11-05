// Issue 107: the restored local browser pane. The webview is the one
// external-content surface: every page mounts with the fixed browser
// partition (no node integration, no preload, no popups), so a page can
// never reach the trusted bridge — main validates the same invariants again
// at attachment time. The pane chrome is a native surface: the address bar
// shares the shared address grammar (no invented search engine), the start
// page states the boundaries honestly, every denied permission ask and
// download phase is one visible line, popups arrive as facts routed to the
// owning pane, and clearing the partition rides the trusted main-process
// dialog. Tab state is pane-local and dies with the pane (the dock
// persistence contract strips volatile per-instance state on save);
// `instanceId` and `panelType` keep the registry signature.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeftOutlined, ArrowRightOutlined, ClearOutlined, CloseOutlined,
  HomeOutlined, PlusOutlined, ReloadOutlined
} from '@ant-design/icons'
import type { BrowserPaneEvent } from '../../../../shared/desktop'
import { BROWSER_PERMISSION_LABELS, BROWSER_PARTITION, sanitizeAddress } from '../../../../shared/desktop'

interface BrowserTab {
  id: string
  /** The URL this tab was asked to load; null is the local start page. */
  requested: string | null
  /** The URL the guest last committed (address-bar truth). */
  current: string | null
  title: string
  error: string | null
}

interface WebviewElement extends HTMLElement {
  goBack?(): void
  goForward?(): void
  reload?(): void
  getWebContentsId?(): number
}

interface Notice { key: number; at: string; event: BrowserPaneEvent }

let tabSeq = 0
let noticeSeq = 0
const MAX_NOTICES = 30
const newTab = (): BrowserTab => {
  tabSeq += 1
  return { id: `btab-${tabSeq}`, requested: null, current: null, title: '起始页', error: null }
}
const nowLabel = (): string => new Date().toLocaleTimeString()

/** One honest line per device-side fact; unmatched permission names fall
 * back to the raw wire value instead of a guessed label. */
function noticeLine(event: BrowserPaneEvent): string {
  switch (event.kind) {
    case 'permission': {
      const label = BROWSER_PERMISSION_LABELS[event.permission] || event.permission
      return event.origin
        ? `已拒绝「${label}」权限请求（${event.origin}）`
        : `已拒绝「${label}」权限请求`
    }
    case 'download':
      switch (event.phase) {
        case 'started': return `${event.filename} 开始下载（存入授权文件夹）`
        case 'completed': return `${event.filename} 下载完成（已存入授权文件夹）`
        case 'canceled': return `${event.filename} 下载已取消`
        case 'interrupted': return `${event.filename} 下载中断（已保存的部分文件留在授权文件夹）`
        case 'rejected':
          return event.reason === 'WORKSPACE_UNCONFIRMED'
            ? `${event.filename} 下载被拒绝：未确认授权文件夹，已取消`
            : `${event.filename} 下载被拒绝：${event.reason || '未知原因'}`
      }
      break
    case 'navigation-blocked':
      return `已阻止非 http(s) 导航：${event.url}`
    case 'cleared':
      return '浏览器分区已清空，页签已回到起始页'
    case 'window-open':
      break
  }
  return ''
}

function TabView({ tab, active, onCommitted, onTitle, onFailed, register }: {
  tab: BrowserTab
  active: boolean
  onCommitted: (tabId: string, url: string) => void
  onTitle: (tabId: string, title: string) => void
  onFailed: (tabId: string, error: string) => void
  register: (tabId: string, element: WebviewElement | null) => void
}): JSX.Element | null {
  const elementRef = useRef<WebviewElement | null>(null)
  // The guest element only exists while the tab has a requested URL, so the
  // wiring effect depends on it: mounting the webview (requested null →
  // set) re-runs this after the ref has been attached.
  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    register(tab.id, element)
    const committed = (event: Event): void => {
      const url = (event as unknown as { url?: unknown }).url
      if (typeof url === 'string' && url) onCommitted(tab.id, url)
    }
    const titled = (event: Event): void => {
      const title = (event as unknown as { title?: unknown }).title
      if (typeof title === 'string' && title) onTitle(tab.id, title)
    }
    const failed = (event: Event): void => {
      const detail = event as unknown as { errorCode?: unknown; errorDescription?: unknown; isMainFrame?: unknown }
      // ERR_ABORTED (-3) is a superseded load, and a frame failure is not
      // the page's failure — neither may pretend the document broke.
      if (detail.isMainFrame === true && detail.errorCode !== -3) {
        onFailed(tab.id, `${String(detail.errorDescription || '')}（错误码 ${String(detail.errorCode)}）`)
      }
    }
    element.addEventListener('did-navigate', committed)
    element.addEventListener('did-navigate-in-page', committed)
    element.addEventListener('page-title-updated', titled)
    element.addEventListener('did-fail-load', failed)
    return () => {
      element.removeEventListener('did-navigate', committed)
      element.removeEventListener('did-navigate-in-page', committed)
      element.removeEventListener('page-title-updated', titled)
      element.removeEventListener('did-fail-load', failed)
      register(tab.id, null)
    }
  }, [tab.id, tab.requested, onCommitted, onTitle, onFailed, register])
  if (!tab.requested) return null
  return (
    <webview
      ref={(element) => { elementRef.current = element as WebviewElement | null }}
      src={tab.requested}
      partition={BROWSER_PARTITION}
      webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
      style={{ display: active ? 'block' : 'none', width: '100%', height: '100%', background: '#FFFFFF' }}
    />
  )
}

export default function BrowserPane({ instanceId, panelType }: {
  instanceId: string
  panelType: string
}): JSX.Element {
  void instanceId
  void panelType
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [newTab()])
  const [activeId, setActiveId] = useState('')
  const [address, setAddress] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)
  const [notices, setNotices] = useState<Notice[]>([])
  const elements = useRef(new Map<string, WebviewElement | null>())
  const tabsRef = useRef(tabs)
  const activeIdRef = useRef(activeId)

  // 每个窗格至少一个页签；首个页签即为活动页签（effect 内补齐，不在渲染期写状态）。
  useEffect(() => {
    if (!activeId && tabs.length > 0) setActiveId(tabs[0].id)
  }, [activeId, tabs])
  tabsRef.current = tabs
  activeIdRef.current = activeId

  const patchTab = useCallback((tabId: string, patch: (tab: BrowserTab) => BrowserTab): void => {
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? patch(tab) : tab)))
  }, [])

  const register = useCallback((tabId: string, element: WebviewElement | null): void => {
    elements.current.set(tabId, element)
  }, [])

  const onCommitted = useCallback((tabId: string, url: string): void => {
    patchTab(tabId, (tab) => ({ ...tab, current: url, error: null }))
    if (tabId === activeIdRef.current) setAddress(url)
  }, [patchTab])

  const onTitle = useCallback((tabId: string, title: string): void => {
    patchTab(tabId, (tab) => ({ ...tab, title }))
  }, [patchTab])

  const onFailed = useCallback((tabId: string, error: string): void => {
    patchTab(tabId, (tab) => ({ ...tab, error }))
  }, [patchTab])

  useEffect(() => {
    return window.ideer.onBrowserEvents((event) => {
      if (event.kind === 'cleared') {
        const fresh = newTab()
        setTabs([fresh])
        setActiveId(fresh.id)
        setAddress('')
        setAddressError(null)
      }
      if (event.kind === 'window-open' && event.url) {
        // 只有拥有该 guest 的窗格把事实变成页签；其他窗格不伪造入口。
        const owning = tabsRef.current.find((tab) => elements.current.get(tab.id)?.getWebContentsId?.() === event.contentsId)
        if (owning) {
          const opened = { ...newTab(), requested: event.url, title: event.url }
          setTabs((prev) => [...prev, opened])
          setActiveId(opened.id)
        }
      }
      const line = noticeLine(event)
      if (!line) return
      noticeSeq += 1
      setNotices((prev) => [{ key: noticeSeq, at: nowLabel(), event }, ...prev].slice(0, MAX_NOTICES))
    })
  }, [])

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]

  const navigate = (value: string): void => {
    if (!active) return
    const target = sanitizeAddress(value)
    if (!target) {
      setAddressError('无法识别的地址：请输入完整的 http(s) 网址或站点域名（不提供搜索引擎代搜）')
      return
    }
    setAddressError(null)
    if (target === active.current && active.requested) {
      // 重新访问同一地址：按刷新处理，而不是静默无操作。
      elements.current.get(active.id)?.reload?.()
      return
    }
    patchTab(active.id, (tab) => ({ ...tab, requested: target, title: target, error: null }))
    setAddress(target)
  }

  const goHome = (): void => {
    if (!active) return
    setAddress('')
    setAddressError(null)
    patchTab(active.id, () => ({ ...newTab(), id: active.id }))
  }

  const addTab = (): void => {
    const tab = newTab()
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
    setAddress('')
    setAddressError(null)
  }

  const closeTab = (tabId: string): void => {
    const remaining = tabs.filter((tab) => tab.id !== tabId)
    if (remaining.length === 0) {
      // 保留最后一个页签位：回到起始页而不是留下空窗格。
      const fresh = newTab()
      setTabs([fresh])
      setActiveId(fresh.id)
    } else {
      setTabs(remaining)
      if (tabId === activeId) {
        const index = tabs.findIndex((tab) => tab.id === tabId)
        const next = remaining[Math.min(index, remaining.length - 1)]
        setActiveId(next.id)
        setAddress(next.current ?? '')
      }
    }
    setAddressError(null)
  }

  const withActive = (action: (element: WebviewElement) => void): void => {
    const element = elements.current.get(active?.id ?? '')
    if (element) action(element)
  }

  return (
    <div className="h-full w-full flex flex-col" style={{ background: 'var(--pane-bg, #FFFFFF)' }}>
      <div className="flex items-center gap-1 px-2 py-1 border-b" style={{ borderColor: 'var(--pane-border, #E2E8F0)' }}>
        <button type="button" title="后退" aria-label="后退" className="px-2 py-0.5 text-gray-600 hover:text-gray-900 disabled:opacity-40"
          onClick={() => withActive((element) => element.goBack?.())}><ArrowLeftOutlined /></button>
        <button type="button" title="前进" aria-label="前进" className="px-2 py-0.5 text-gray-600 hover:text-gray-900 disabled:opacity-40"
          onClick={() => withActive((element) => element.goForward?.())}><ArrowRightOutlined /></button>
        <button type="button" title="刷新" aria-label="刷新" className="px-2 py-0.5 text-gray-600 hover:text-gray-900 disabled:opacity-40"
          onClick={() => withActive((element) => element.reload?.())}><ReloadOutlined /></button>
        <button type="button" title="主页" aria-label="主页" className="px-2 py-0.5 text-gray-600 hover:text-gray-900"
          onClick={goHome}><HomeOutlined /></button>
        <form className="flex-1 flex items-center min-w-0" onSubmit={(event) => { event.preventDefault(); navigate(address) }}>
          <input
            value={address}
            placeholder="输入网址"
            className="flex-1 min-w-0 px-2 py-1 text-xs border rounded"
            style={{ borderColor: 'var(--pane-border, #CBD5E1)' }}
            onChange={(event) => { setAddress(event.target.value); setAddressError(null) }}
          />
          <button type="submit" className="ml-1 px-2 py-1 text-xs border rounded text-gray-700 hover:bg-gray-50"
            style={{ borderColor: 'var(--pane-border, #CBD5E1)' }}>前往</button>
        </form>
        <button type="button" title="新建页签" aria-label="新建页签" className="px-2 py-0.5 text-gray-600 hover:text-gray-900"
          onClick={addTab}><PlusOutlined /></button>
        <button
          type="button" aria-label="清空分区"
          className="px-2 py-0.5 text-xs text-gray-600 hover:text-gray-900 border rounded"
          style={{ borderColor: 'var(--pane-border, #CBD5E1)' }}
          onClick={() => { window.ideer.browser({ action: 'clear' }) }}
        ><ClearOutlined /> 清空分区</button>
      </div>
      <div className="flex items-center gap-1 px-2 py-0.5 border-b text-xs overflow-x-auto" style={{ borderColor: 'var(--pane-border, #E2E8F0)' }}>
        {tabs.map((tab) => (
          <span key={tab.id} className="flex items-center gap-1 px-2 py-0.5 rounded whitespace-nowrap cursor-pointer"
            style={{ background: tab.id === active?.id ? 'var(--pane-tab-active, #DBEAFE)' : 'transparent' }}
            role="button"
            title={tab.title}
            onClick={() => { setActiveId(tab.id); setAddress(tab.current ?? '') }}>
            <span className="max-w-[160px] truncate">{tab.title}</span>
            <button type="button" aria-label={`关闭页签 ${tab.title}`} className="text-gray-400 hover:text-gray-700"
              onClick={(event) => { event.stopPropagation(); closeTab(tab.id) }}><CloseOutlined /></button>
          </span>
        ))}
      </div>
      {addressError && (
        <div className="px-2 py-1 text-xs text-red-600 border-b" style={{ borderColor: 'var(--pane-border, #E2E8F0)' }}>
          {addressError}
        </div>
      )}
      {notices.length > 0 && (
        <div className="border-b text-[11px] leading-5 max-h-24 overflow-y-auto" style={{ borderColor: 'var(--pane-border, #E2E8F0)' }}>
          {notices.map((notice) => (
            <div key={notice.key} className="px-2 text-gray-600 cursor-pointer hover:bg-gray-50"
              onClick={() => setNotices((prev) => prev.filter((item) => item.key !== notice.key))}>
              <span className="text-gray-400 mr-1">{notice.at}</span>{noticeLine(notice.event)}
            </div>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => {
          const isActive = tab.id === active?.id
          return (
            <div key={tab.id} className="absolute inset-0" style={{ display: isActive ? 'block' : 'none' }}>
              {tab.requested ? (
                <>
                  <TabView tab={tab} active={isActive} onCommitted={onCommitted} onTitle={onTitle} onFailed={onFailed} register={register} />
                  {tab.error && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
                      style={{ background: 'var(--pane-bg, #FFFFFF)' }}>
                      <div className="text-sm font-medium text-red-600">页面加载失败</div>
                      <div className="max-w-md text-xs text-gray-500 break-all">{tab.error}</div>
                      <button type="button" className="px-3 py-1 text-xs border rounded"
                        style={{ borderColor: 'var(--pane-border, #CBD5E1)' }}
                        onClick={() => { elements.current.get(tab.id)?.reload?.() }}>重试</button>
                    </div>
                  )}
                </>
              ) : (
                <div className="h-full w-full flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <div className="text-sm font-medium text-gray-700">浏览器起始页</div>
                  <div className="max-w-md text-xs text-gray-500 leading-relaxed">
                    在地址栏输入网址访问。页面均为外部内容，不接入可信桥；登录态与 Cookie 存独立分区（与系统浏览器、平台凭据隔离，清空分区即全部移除）；下载自动进入已授权文件夹，夹外不落地；权限请求默认拒绝并逐条记录。
                  </div>
                  <div className="text-[11px] text-gray-400">清空分区需在确认对话框中确认后执行</div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
