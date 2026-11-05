// Issue 109: the remote browser pane — the platform's live browser as the
// second entry. Everything visible here is 远端: the badge is permanent, the
// location difference is stated in place, a refused navigation is reported
// honestly (no retry, no fallback, no silent switch to any local mode), and
// remote downloads say they stay on the server until an explicit per-file
// retrieval. The screen is pixels drawn by RemoteScreenSurface; this pane is
// the only bridge talker (navigation commands, input forwarding, retrieval).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Select, Tag } from 'antd'
import { ArrowLeftOutlined, ArrowRightOutlined, CloudDownloadOutlined, GlobalOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ChatSnapshot, DesktopBridge, RemoteBrowserEvent, RemoteBrowserInputEvent, RemoteBrowserTabRow } from '../../../../shared/desktop'
import type { PanelTypeId } from '../types'
import RemoteScreenSurface, { type SurfaceInput } from './remoteBrowser/RemoteScreenSurface'

export type RemoteBrowserApi = Pick<DesktopBridge, 'chat' | 'remoteBrowser' | 'onRemoteBrowserEvents'>

type StreamState = 'idle' | 'connecting' | 'open' | 'closed'

/** The server's own close codes (browser.py) plus the Desktop's replacement
 * fact, each stated as the reason it is — never folded into a generic error. */
const CLOSE_REASONS: Record<string, string> = {
  UNAUTHENTICATED: '远端登录态失效',
  THREAD_UNAVAILABLE: '该 Thread 不可用、不属于当前账号，或平台浏览器能力未开启',
  SCREENCAST_FAILED: '远端画面开启失败',
  SESSION_CAPACITY: '平台浏览器会话已满',
  SERVICE_UNAVAILABLE: '平台浏览器能力不可用',
  CONNECTION_FAILED: '连接远端失败',
  IDENTITY_CHANGED: '平台身份已变化',
  REPLACED: '该会话已被另一个远端浏览入口取代',
  CLOSED: '会话已结束'
}

const OPEN_ERRORS: Record<string, string> = {
  REMOTE_BROWSER_UNAUTHENTICATED: '远端登录态失效，请重新登录平台后再连接',
  REMOTE_BROWSER_BUSY: '上一次连接仍在进行，请稍候',
  REMOTE_BROWSER_TIMEOUT: '连接远端超时',
  RUNTIME_UNAVAILABLE: '本机 Runtime 未运行',
  CHAT_IDENTITY_CHANGED: '平台身份已变化，请重新打开会话后再连接'
}

/** Honest address syntax only: an http(s) URL passes, a bare host gains
 * https://, and everything else is refused — the remote entry never invents
 * a search destination the user did not choose. */
export function normalizeAddress(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(trimmed)) return `https://${trimmed}`
  return null
}

function describeClose(event: { code?: number; category?: string }): string {
  const reason = (event.category && CLOSE_REASONS[event.category]) || (event.category ? `原因 ${event.category}` : '原因未说明')
  return `远端会话已关闭：${reason}${event.code !== undefined ? `（${event.code}）` : ''}`
}

export default function RemoteBrowserPane({ instanceId, api }: {
  instanceId: string
  panelType: PanelTypeId
  api?: RemoteBrowserApi
}): JSX.Element {
  // instanceId stays unused: like the placeholder panes, the remote stream is
  // app-wide state (one platform session), not per-instance state; the dock
  // persistence contract strips volatile per-instance state anyway.
  void instanceId
  const bridge: RemoteBrowserApi = api ?? window.ideer

  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [closeLine, setCloseLine] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [frame, setFrame] = useState<string | null>(null)
  const [tabs, setTabs] = useState<RemoteBrowserTabRow[]>([])
  const [notices, setNotices] = useState<{ id: number; text: string }[]>([])
  const [retrieving, setRetrieving] = useState<string | null>(null)
  const noticeSeq = useRef(0)
  const lastMoveRef = useRef(0)

  const pushNotice = useCallback((text: string) => {
    noticeSeq.current += 1
    setNotices((prev) => [{ id: noticeSeq.current, text }, ...prev].slice(0, 6))
  }, [])

  const loadChatState = useCallback(() => {
    void bridge.chat({ action: 'state' }).then((state) => {
      setSnapshot(state)
      setSnapshotError(null)
    }).catch((error: unknown) => {
      setSnapshotError(String((error as Error)?.message || error))
    })
  }, [bridge])

  useEffect(() => { loadChatState() }, [loadChatState])

  useEffect(() => bridge.onRemoteBrowserEvents((event: RemoteBrowserEvent) => {
    switch (event.kind) {
      case 'state':
        setStreamState(event.state)
        if (event.state === 'closed') setCloseLine(describeClose(event))
        if (event.state === 'open') { setCloseLine(null); setOpenError(null) }
        if (event.state === 'connecting') setCloseLine(null)
        break
      case 'url':
        setAddress(event.url)
        break
      case 'frame':
        setFrame(event.data)
        break
      case 'tabs':
        setTabs(event.tabs)
        break
      case 'nav-rejected':
        pushNotice(`远端无法访问该地址：${event.url}（${event.message || '服务端拒绝'}）。位置不同，不自动兜底、不重试。`)
        break
      case 'stream-error':
        pushNotice(`远端流错误：${(CLOSE_REASONS[event.category] ? `${CLOSE_REASONS[event.category]}（${event.category}）` : event.category)}${event.message ? `：${event.message}` : ''}`)
        break
    }
  }), [bridge, pushNotice])

  const sendInput = useCallback(async (event: RemoteBrowserInputEvent): Promise<void> => {
    try {
      await bridge.remoteBrowser({ action: 'input', event })
    } catch {
      // A gesture racing a closing stream is not an error of its own; the
      // state events carry the honest reason the stream ended.
    }
  }, [bridge])

  const connect = useCallback(async () => {
    if (!snapshot?.thread) return
    setStreamState('connecting')
    setOpenError(null)
    setCloseLine(null)
    try {
      await bridge.remoteBrowser({ action: 'open', threadId: snapshot.thread.id, scope: snapshot.scope })
    } catch (error) {
      setStreamState('closed')
      const code = String((error as Error)?.message || error)
      setOpenError(`无法连接远端：${OPEN_ERRORS[code] ?? code}`)
    }
  }, [bridge, snapshot])

  const disconnect = useCallback(async () => {
    try {
      await bridge.remoteBrowser({ action: 'close' })
    } catch {
      setStreamState('closed')
    }
  }, [bridge])

  const navigate = useCallback((raw: string) => {
    const url = normalizeAddress(raw)
    if (!url) {
      pushNotice('请输入 http(s) 网址：远端入口不代做搜索、不猜测目的地。')
      return
    }
    setAddress(url)
    void sendInput({ type: 'navigate', url })
  }, [pushNotice, sendInput])

  const onSurfaceInput = useCallback((event: SurfaceInput) => {
    if (event.kind === 'move') {
      const now = Date.now()
      if (now - lastMoveRef.current < 33) return
      lastMoveRef.current = now
      void sendInput({ type: 'move', x: event.x, y: event.y })
      return
    }
    if (event.kind === 'wheel') {
      void sendInput({ type: 'wheel', dx: event.dx, dy: event.dy })
      return
    }
    if (event.kind === 'key') {
      void sendInput({ type: 'key', key: event.key })
      return
    }
    if (event.kind === 'text') {
      void sendInput({ type: 'text', text: event.text })
      return
    }
    void sendInput({ type: event.kind, x: event.x, y: event.y, button: event.button })
  }, [sendInput])

  const retrieve = useCallback(async (artifactId: string, name: string) => {
    if (!snapshot?.thread) return
    setRetrieving(artifactId)
    try {
      const outcome = await bridge.remoteBrowser({ action: 'retrieve', threadId: snapshot.thread.id, artifactId, scope: snapshot.scope })
      if ('status' in outcome && outcome.status === 'saved') pushNotice(`已取回到本机：${name}（保存位置由系统对话框确认）`)
      else pushNotice(`已取消取回：${name}（未写入本机）`)
      loadChatState()
    } catch (error) {
      pushNotice(`平台拒绝取回：${String((error as Error)?.message || error)}`)
    } finally {
      setRetrieving(null)
    }
  }, [bridge, loadChatState, pushNotice, snapshot])

  const connected = streamState === 'open'
  const thread = snapshot?.thread ?? null

  const statusLine = snapshotError !== null
    ? `对话状态不可用（${snapshotError}）：远端浏览器需要先登录平台并打开一个会话。`
    : snapshot?.error
      ? '远端浏览器需要先登录平台，并在对话面板打开一个平台会话。'
      : thread === null
        ? '远端浏览器会话属于平台 Thread：请先在对话面板打开一个平台会话。'
        : null

  return (
    <div className="h-full w-full flex flex-col bg-white">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <Tag color="gold" className="flex-shrink-0" title="此窗格的一切浏览都发生在平台服务器（远端）">远端</Tag>
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} disabled={!connected}
          title="后退（远端页面历史）" onClick={() => void sendInput({ type: 'back' })} />
        <Button type="text" size="small" icon={<ArrowRightOutlined />} disabled={!connected}
          title="前进（远端页面历史）" onClick={() => void sendInput({ type: 'forward' })} />
        <Button type="text" size="small" icon={<ReloadOutlined />} disabled={!connected || !address}
          title="重新载入当前远端地址" onClick={() => navigate(address)} />
        <Input
          size="small"
          type="text"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onPressEnter={(event) => navigate((event.target as HTMLInputElement).value)}
          placeholder={connected ? '输入要在远端打开的网址' : '连接远端会话后可导航'}
          disabled={!connected}
          className="flex-1"
          prefix={<GlobalOutlined className="text-gray-400" />}
        />
        {connected
          ? <Button size="small" onClick={() => void disconnect()}>断开</Button>
          : <Button size="small" type="primary" disabled={thread === null || streamState === 'connecting'}
              onClick={() => void connect()}>连接远端会话</Button>}
      </div>

      <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-100 text-[11px] text-gray-500 flex-shrink-0">
        <span>远端 = 平台服务器网络（隔离沙箱）：网页、内网与登录态都在服务器侧，与「本机」入口彼此独立，二者不做静默切换。</span>
        {connected && <span className="text-emerald-700 flex-shrink-0">远端会话已连接</span>}
        {tabs.length > 1 && (
          <Select size="small" value={tabs.find((tab) => tab.active)?.index ?? tabs[0]?.index}
            onChange={(index) => void sendInput({ type: 'activate_tab', index })}
            options={tabs.map((tab) => ({ value: tab.index, label: tab.title || tab.url || `标签 ${tab.index}` }))}
            className="flex-shrink-0 min-w-[120px]" />
        )}
      </div>

      {statusLine !== null && (
        <div className="px-3 py-4 text-xs text-gray-600 leading-relaxed flex-shrink-0">
          {statusLine}
        </div>
      )}
      {openError !== null && (
        <div className="px-3 py-1 text-xs text-red-600 flex-shrink-0">{openError}</div>
      )}
      {closeLine !== null && (
        <div className="px-3 py-1 text-xs text-amber-700 flex-shrink-0">{closeLine}</div>
      )}

      <RemoteScreenSurface frame={frame} disabled={!connected} onInput={onSurfaceInput} />

      {notices.length > 0 && (
        <div className="px-3 py-1 border-t border-gray-100 max-h-24 overflow-y-auto flex-shrink-0">
          {notices.map((notice) => (
            <div key={notice.id} className="text-[11px] text-gray-600 leading-relaxed">{notice.text}</div>
          ))}
        </div>
      )}

      <div className="border-t border-gray-200 px-2 py-1.5 flex-shrink-0 max-h-40 overflow-y-auto">
        <div className="text-[11px] text-gray-500 leading-relaxed">
          <CloudDownloadOutlined className="mr-1" />
          下载发生在远端：文件保存在平台服务器上，不会自动落到本机；需要时在此逐个显式取回，取回时按普通文件边界由系统对话框选择保存位置。
        </div>
        {thread !== null && !!snapshot?.artifacts?.length && (
          <div className="mt-1">
            {snapshot.artifacts.slice(0, 20).map((artifact) => (
              <div key={artifact.artifact_id} className="flex items-center gap-2 text-xs leading-6">
                <span className="truncate flex-1" title={artifact.name}>{artifact.name}</span>
                <span className="text-[11px] text-gray-400 flex-shrink-0">{artifact.bytes} 字节 · 在远端</span>
                <Button size="small" type="link" className="flex-shrink-0"
                  disabled={retrieving !== null}
                  onClick={() => void retrieve(artifact.artifact_id, artifact.name)}>取回到本机</Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
