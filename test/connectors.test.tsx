import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'
import { ConnectorSection } from '../src/renderer/src/components/ConnectorSection'
import type { ConnectorView, RuntimeStatus } from '../src/shared/desktop'

const MANIFEST_HASH = 'a'.repeat(64)
const PACKAGE_HASH = 'b'.repeat(64)

const connectorRow = (overrides: Partial<ConnectorView> = {}): ConnectorView => ({
  slug: 'demo-echo', displayName: 'Demo Echo Connector', version: '1.2.0', entry: 'server.py',
  manifestHash: MANIFEST_HASH, packageHash: PACKAGE_HASH, serverConnectorId: 'platform-conn-1',
  state: 'installed', createdAt: '2026-10-27T00:00:00Z', ...overrides
})

const runtimeStatus = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus =>
  ({ process: 'running', connection: 'connected', tasks: [], connectors: [connectorRow()], ...overrides })

const renderSection = (overrides: { runtime?: RuntimeStatus; busy?: boolean; error?: string } = {}): string =>
  renderToStaticMarkup(
    <ConnectorSection
      runtime={overrides.runtime ?? runtimeStatus()}
      busy={overrides.busy ?? false}
      error={overrides.error ?? ''}
      onCommand={() => {}}
    />
  )

describe('local connector install bridge (#123)', () => {
  it('validates the connector command before the owned Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-123/unused')
    for (const command of [undefined, null, 7, {}, { action: 'deploy' }, { action: 'preview' }, { action: 'install', path: '' },
      { action: 'install', path: `C:/${'x'.repeat(33000)}` }, { action: 'remove' }, { action: 'remove', slug: '../escape' },
      { action: 'remove', slug: '' }, { action: 'list', extra: 1 }]) {
      await expect(runtime.connectors(command as never)).rejects.toThrow('CONNECTOR_COMMAND_INVALID')
    }
    // Well-formed commands still need the owned Runtime process.
    await expect(runtime.connectors({ action: 'list' })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.connectors({ action: 'install', path: 'C:/pkg/demo-echo' })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
    // A stopped Runtime has no connector view; the surface starts empty.
    expect(runtime.status().connectors ?? []).toEqual([])
  })

  it('renders the install surface with identity-only rows and actionable categories', () => {
    const html = renderSection()
    expect(html).toContain('安装本地连接器组件…')
    // The row carries identity facts only — never a command line or path.
    expect(html).toContain('Demo Echo Connector（demo-echo） · 版本 1.2.0 · 入口 server.py')
    expect(html).toContain(MANIFEST_HASH)
    expect(html).toContain('移除此连接器…')
    expect(html).not.toMatch(/connectors[/\\]demo-echo/)
    // An empty registry says so; a storage failure never looks like empty.
    const empty = renderSection({ runtime: runtimeStatus({ connectors: [] }) })
    expect(empty).toContain('尚无已安装的连接器')
    const storage = renderSection({ runtime: runtimeStatus({ connectorStorageError: 'CONNECTOR_STORAGE_UNAVAILABLE' }) })
    expect(storage).toContain('连接器登记存储不可用')
    // A fixed failure category renders its actionable hint.
    const failed = renderSection({ error: 'CONNECTOR_DEPENDENCY_MISSING' })
    expect(failed).toContain('组件声明了本机无法探测的依赖')
  })

  it.skipIf(process.platform !== 'win32')('refuses every connector operation without an owned authenticated binding', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-connector-bridge-'))
    // The candidate lives outside the protected profile area: a real fixed
    // package (stdlib-only entry, frozen manifest) the flow could locate.
    const packages = mkdtempSync(join(tmpdir(), 'ideer-connector-packages-'))
    mkdirSync(packages, { recursive: true })
    writeFileSync(join(packages, 'connector.json'), JSON.stringify({
      connector: 'demo-echo', displayName: 'Demo Echo Connector', version: '1.2.0',
      entry: 'server.py', requirements: { python: '>=3.9' }
    }), 'utf8')
    writeFileSync(join(packages, 'server.py'), 'print("stub")\n', 'utf8')
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      // No owned profile binding exists yet: nothing is listable, previewable,
      // installable or removable — the fixed unavailable category, and the
      // install writes nothing (no managed store, no controlled config).
      await expect(runtime.connectors({ action: 'list' })).rejects.toThrow('CONNECTOR_UNAVAILABLE')
      await expect(runtime.connectors({ action: 'preview', path: packages })).rejects.toThrow('CONNECTOR_UNAVAILABLE')
      await expect(runtime.connectors({ action: 'install', path: packages })).rejects.toThrow('CONNECTOR_UNAVAILABLE')
      await expect(runtime.connectors({ action: 'remove', slug: 'demo-echo' })).rejects.toThrow('CONNECTOR_UNAVAILABLE')
      expect(runtime.status().connectors ?? []).toEqual([])
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
      rmSync(packages, { recursive: true, force: true })
    }
  }, 60000)
})
