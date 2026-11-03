// Issue 94: the linz FilePanel restored on the dock's native files pane.
// A read-only human window onto the confirmed workspace: directory tree,
// bounded text/image previews, external open and Explorer reveal. Browsing
// here is the human's own freedom — nothing on this surface asks for
// approval, offers a write affordance, or embeds external content; the
// Agent's material-taking keeps its separate consent flow, and every path
// stays workspace-logical end to end.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Space, Spin, Tree, Typography } from 'antd'
import { ExportOutlined, FileOutlined, FolderOutlined, ReloadOutlined, SelectOutlined } from '@ant-design/icons'
import type { DataNode } from 'antd/es/tree'
import type { DesktopBridge, DesktopStatus, FilesCommand, FilesListView, FilesEntry, FilesPreview } from '../../../shared/desktop'
import { useDockStore } from '../dock/dockStore'

type FilesApi = Pick<DesktopBridge, 'files' | 'getStatus'>

const MAX_PREVIEW_TEXT_BYTES = 1048576

/** One honest sentence per wire fact; codes come from the Runtime's store. */
const PREVIEW_ERROR_TEXT: Record<string, string> = {
  FILE_BINARY: '二进制文件请用外部应用打开',
  FILE_TOO_LARGE: '文件超出预览大小限制，请外部打开',
  PROTECTED_PATH: '受保护路径不提供预览',
  NOT_A_FILE: '目录只能在树中展开浏览',
  NOT_A_DIRECTORY: '路径不是目录',
  NOT_FOUND: '文件不存在或已被移动',
  OUTSIDE_ALLOWED_ROOTS: '路径越出了工作目录范围',
  INVALID_PATH: '路径格式无效',
  WORKSPACE_UNAVAILABLE: '工作目录已失效，请在本机 Runtime 面板重新选择并确认',
  PERMISSION_DENIED: '系统拒绝了读取，请外部打开',
  LOCKED_OR_UNAVAILABLE: '文件暂不可读（可能被占用）',
  FILES_BUSY: '读取请求太多，请稍候再试',
  FILES_TIMEOUT: '读取超时，请重试',
  FILES_FAILED: '无法预览该文件'
}
const previewErrorText = (code: string): string =>
  PREVIEW_ERROR_TEXT[code] ?? '无法预览该文件'

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

interface TreeNode extends DataNode {
  key: string
  title: string
  kind: 'dir' | 'file'
  size?: number
}

const fileNode = (entry: FilesEntry, parent: string): TreeNode => ({
  key: `${parent}/${entry.name}`,
  title: entry.name,
  kind: entry.kind,
  size: entry.kind === 'file' ? entry.size : undefined,
  icon: entry.kind === 'dir' ? <FolderOutlined /> : <FileOutlined />,
  isLeaf: entry.kind !== 'dir'
})

interface Selection {
  path: string
  kind: 'dir' | 'file'
  name: string
  size?: number
}

interface PreviewState {
  loading: boolean
  view?: FilesPreview
  error?: string
}

export default function FilePanel({ instanceId, panelType, api }: {
  instanceId: string
  panelType: string
  /** Injectable seam for headless tests; production uses the trusted bridge. */
  api?: FilesApi
}): JSX.Element {
  const bridge: FilesApi = api ?? window.ideer
  // `instanceId`/`panelType` keep the dock pane signature; the files pane is
  // single-instance and stateless across restarts (dock persistence strips
  // per-instance state), so browsing state is component-local on purpose.
  void instanceId
  void panelType
  const openRuntimePane = useDockStore((state) => state.openPanelType)
  const [workspace, setWorkspace] = useState<DesktopStatus['runtime'] | null>(null)
  const [root, setRoot] = useState('')
  const [treeData, setTreeData] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<string[]>([])
  const [listingTruncated, setListingTruncated] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [preview, setPreview] = useState<PreviewState>({ loading: false })
  const [busy, setBusy] = useState(false)
  const requestSequence = useRef(0)

  const workspaceReady = workspace?.process === 'running' &&
    workspace.login?.state === 'authenticated' && workspace.workspace?.state === 'ready'
  const logicalRoot = workspace?.workspace?.logicalRoot ?? ''

  useEffect(() => {
    let active = true
    const poll = (): void => {
      void bridge.getStatus().then((status: DesktopStatus) => {
        if (active) setWorkspace(status.runtime)
      }).catch(() => { /* the pane keeps the last honest state */ })
    }
    poll()
    const timer = setInterval(poll, 1000)
    return () => { active = false; clearInterval(timer) }
  }, [bridge])

  const loadDirectory = useCallback(async (path: string): Promise<{ entries: FilesEntry[]; truncated: boolean }> => {
    const view = await bridge.files({ action: 'list', path }) as FilesListView
    return { entries: view.entries, truncated: view.truncated }
  }, [bridge])

  const expandInto = useCallback(async (parent: string): Promise<TreeNode[]> => {
    const { entries } = await loadDirectory(parent)
    return entries.map((entry) => fileNode(entry, parent))
  }, [loadDirectory])

  const refreshRoot = useCallback(async (rootPath: string) => {
    setLoadError(''); setBusy(true); setSelection(null); setPreview({ loading: false })
    const sequence = ++requestSequence.current
    try {
      const { entries, truncated } = await loadDirectory(rootPath)
      if (sequence !== requestSequence.current) return
      setTreeData(entries.map((entry) => fileNode(entry, rootPath)))
      setListingTruncated(truncated)
      setExpanded([])
    } catch (caught) {
      if (sequence !== requestSequence.current) return
      setTreeData([])
      setLoadError(previewErrorText(caught instanceof Error ? caught.message : 'FILES_FAILED'))
    } finally {
      if (sequence === requestSequence.current) setBusy(false)
    }
  }, [loadDirectory])

  useEffect(() => {
    // The workspace root identity gates the whole tree: a rebind replaces it.
    if (!workspaceReady || !logicalRoot) { setRoot(''); setTreeData([]); setSelection(null); setPreview({ loading: false }); return }
    if (root !== logicalRoot) { setRoot(logicalRoot); void refreshRoot(logicalRoot) }
  }, [workspaceReady, logicalRoot, root, refreshRoot])

  const onSelect = useCallback((path: string, node: TreeNode) => {
    const sequence = ++requestSequence.current
    setSelection({ path, kind: node.kind, name: node.title as string, size: node.size })
    if (node.kind !== 'file') { setPreview({ loading: false }); return }
    setPreview({ loading: true })
    void bridge.files({ action: 'read', path }).then((view) => {
      if (sequence !== requestSequence.current) return
      setPreview({ loading: false, view: view as FilesPreview })
    }).catch((caught: unknown) => {
      if (sequence !== requestSequence.current) return
      setPreview({ loading: false, error: previewErrorText(caught instanceof Error ? caught.message : 'FILES_FAILED') })
    })
  }, [bridge])

  const runExternal = useCallback((action: Extract<FilesCommand, { action: 'open' | 'reveal' }>['action']) => {
    if (!selection) return
    setBusy(true)
    void bridge.files({ action, path: selection.path }).catch((caught: unknown) => {
      setLoadError(previewErrorText(caught instanceof Error ? caught.message : 'FILES_FAILED'))
    }).finally(() => setBusy(false))
  }, [bridge, selection])

  if (!workspaceReady) {
    return <div className="h-full w-full flex flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-sm font-medium text-gray-700">文件树尚未就绪</div>
      <div className="max-w-md text-xs text-gray-500 leading-relaxed">
        {workspace?.process !== 'running'
          ? '本机 Runtime 未运行；文件树浏览绑定在已确认的工作目录上。'
          : workspace?.login?.state !== 'authenticated'
            ? '尚未登录并绑定设备；工作目录授权跟随账号与设备。'
            : '尚未选择并确认工作目录。人工浏览不触发任何审批；Agent 取材仍走既有审批。'}
      </div>
      <Button onClick={() => openRuntimePane('runtime')}>打开「本机 Runtime」面板</Button>
    </div>
  }

  const renderPreview = (): JSX.Element => {
    if (!selection) {
      return <div className="h-full flex items-center justify-center text-xs text-gray-400">选择左侧文件进行只读预览</div>
    }
    if (selection.kind === 'dir') {
      return <div className="h-full flex items-center justify-center text-xs text-gray-400">目录：在左侧树中展开浏览</div>
    }
    if (preview.loading) return <div className="h-full flex items-center justify-center"><Spin /></div>
    if (preview.error) {
      return <div className="h-full flex items-center justify-center p-4"><Alert className="max-w-md" type="info" showIcon message={preview.error} /></div>
    }
    const view = preview.view
    if (!view) return <div className="h-full flex items-center justify-center text-xs text-gray-400">选择左侧文件进行只读预览</div>
    if (view.kind === 'text') {
      return <div className="h-full overflow-auto p-3">
        {view.truncated && <Alert className="mb-2" type="info" showIcon
          message={`仅预览前 ${formatSize(MAX_PREVIEW_TEXT_BYTES)}，完整内容请外部打开`} />}
        <pre className="whitespace-pre-wrap break-all text-xs leading-relaxed text-gray-800 font-mono m-0">{view.content}</pre>
      </div>
    }
    return <div className="h-full overflow-auto p-3 flex items-start justify-center">
      <img alt={selection.name} src={`data:${view.mime};base64,${view.data}`}
        className="max-w-full" style={{ maxHeight: '100%', objectFit: 'contain' }} />
    </div>
  }

  return <div className="h-full w-full flex flex-col" data-instance={instanceId}>
    <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
      <span className="text-xs text-gray-500 truncate flex-1" title={root}>工作目录 {root}</span>
      <Button size="small" icon={<ReloadOutlined />} loading={busy} onClick={() => void refreshRoot(root)}>刷新</Button>
    </div>
    {loadError && <Alert className="m-2" type="error" showIcon message={loadError} />}
    {listingTruncated && <Alert className="m-2" type="info" showIcon
      message="目录条目过多，仅显示前 500 项；子目录可在上层继续展开" />}
    <div className="flex-1 min-h-0 flex">
      <div className="w-2/5 min-w-48 h-full overflow-auto p-2 border-r border-gray-200">
        {treeData.length === 0 && !loadError
          ? <div className="h-full flex items-center justify-center text-xs text-gray-400">{busy ? <Spin /> : '目录为空'}</div>
          : <Tree<TreeNode>
              showIcon
              blockNode
              treeData={treeData}
              expandedKeys={expanded}
              onExpand={(keys) => setExpanded(keys as string[])}
              loadData={async (node) => {
                const nodeKey = String(node.key)
                const children = await expandInto(nodeKey)
                setTreeData((current) => current.map((item) => item.key === nodeKey ? { ...item, children } : item))
              }}
              selectedKeys={selection ? [selection.path] : []}
              onSelect={(keys, info) => {
                const node = info.node as unknown as TreeNode
                if (keys.length > 0) onSelect(String(keys[0]), node)
              }}
            />}
      </div>
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {selection && <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
          <span className="text-xs text-gray-700 truncate flex-1" title={selection.path}>
            {selection.name}{selection.size !== undefined ? `（${formatSize(selection.size)}）` : ''}
          </span>
          <Space size={4}>
            <Button size="small" icon={<ExportOutlined />} disabled={busy}
              onClick={() => runExternal('open')}>打开</Button>
            <Button size="small" icon={<SelectOutlined />} disabled={busy}
              onClick={() => runExternal('reveal')}>定位</Button>
          </Space>
        </div>}
        <div className="flex-1 min-h-0">{renderPreview()}</div>
      </div>
    </div>
    <div className="px-3 py-1 border-t border-gray-200 text-[11px] text-gray-400">
      只读预览 · 人工浏览不触发审批 · Agent 取材仍走既有审批
    </div>
  </div>
}

export { formatSize, previewErrorText }
