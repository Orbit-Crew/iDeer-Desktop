import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'
import { SkillSection } from '../src/renderer/src/components/SkillSection'
import type { RuntimeStatus, SkillImportView, SkillPreferencesView, SkillTriggerPreferenceView } from '../src/shared/desktop'

const RESOURCE = '77777777-7777-4777-8777-777777777777'
const PACKAGE_HASH = 'c'.repeat(64)

const importRow = (overrides: Partial<SkillImportView> = {}): SkillImportView => ({
  id: 'skill-1', resourceId: RESOURCE, slug: 'report-skill', revision: 1, contentHash: PACKAGE_HASH,
  version: 0, origin: 'zip', fileCount: 3, totalBytes: 128, status: 'imported', errorCode: '',
  createdAt: '2026-10-27T00:00:00Z', ...overrides
})

const runtimeStatus = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus =>
  ({ process: 'running', connection: 'connected', tasks: [], skillImports: [importRow()], ...overrides })

const preferenceRow = (overrides: Partial<SkillTriggerPreferenceView> = {}): SkillTriggerPreferenceView => ({
  skillId: RESOURCE, slug: 'report-skill', displayName: 'Report skill', latestVersion: 2, available: true,
  enabled: true, keywords: ['weekly report'], alwaysInject: false, applicableAgentIds: [], priority: 3, ...overrides
})

const renderSection = (overrides: {
  runtime?: RuntimeStatus
  busy?: boolean
  error?: string
  initialPreferences?: SkillPreferencesView
} = {}): string =>
  renderToStaticMarkup(
    <SkillSection
      runtime={overrides.runtime ?? runtimeStatus()}
      busy={overrides.busy ?? false}
      error={overrides.error ?? ''}
      onCommand={() => {}}
      onPreferences={async () => ({ skills: [] })}
      initialPreferences={overrides.initialPreferences}
    />
  )

describe('skill package preview import bridge (#120)', () => {
  it('validates the package command before the owned Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-120/unused')
    for (const kind of ['', 'exe', 'markdown/extra', 7 as unknown as string]) {
      await expect(runtime.importSkill(kind as 'zip', ['C:/pkg/report-skill.zip'], false))
        .rejects.toThrow('SKILL_COMMAND_INVALID')
    }
    for (const paths of [[], ['a', 'b'], [''], [7], [`C:/${'x'.repeat(33000)}/pkg.zip`]]) {
      await expect(runtime.importSkill('zip', paths as string[], false)).rejects.toThrow('SKILL_COMMAND_INVALID')
    }
    for (const confirmed of ['yes', 1, undefined]) {
      await expect(runtime.importSkill('zip', ['C:/pkg/report-skill.zip'], confirmed as boolean))
        .rejects.toThrow('SKILL_COMMAND_INVALID')
    }
    for (const resourceId of ['', 'not-a-uuid', `${RESOURCE}/extra`]) {
      await expect(runtime.publishSkill(resourceId, 1)).rejects.toThrow('SKILL_COMMAND_INVALID')
    }
    for (const revision of [0, -1, 1.5, 1000001]) {
      await expect(runtime.publishSkill(RESOURCE, revision)).rejects.toThrow('SKILL_COMMAND_INVALID')
    }
    // Well-formed commands still need the owned Runtime process.
    await expect(runtime.importSkill('zip', ['C:/pkg/report-skill.zip'], false)).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.publishSkill(RESOURCE, 1)).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
    // A stopped Runtime has no import view; a running one starts empty.
    expect(runtime.status().skillImports ?? []).toEqual([])
  })

  it('renders the import surface with honest record states and the publish handle', () => {
    const html = renderSection()
    expect(html).toContain('导入 Markdown 技能…')
    expect(html).toContain('导入 ZIP 技能…')
    expect(html).toContain('导入目录技能…')
    // The imported row names the private draft and its frozen package hash.
    expect(html).toContain('report-skill · 已导入为私有草稿 · 3 个文件（ZIP）')
    expect(html).toContain('私有草稿 R1')
    expect(html).toContain(PACKAGE_HASH)
    expect(html).toContain('发布此草稿为版本副本…')
    // The published row names the version copy, not a draft.
    const published = renderSection({ runtime: runtimeStatus({ skillImports: [importRow({ status: 'published', version: 2 })] }) })
    expect(published).toContain('report-skill · 已发布版本副本')
    expect(published).toContain('平台版本副本：V2')
    expect(published).not.toContain('发布此草稿为版本副本…')
    // A failed row shows only its fixed category and no hash to impersonate.
    const failed = renderSection({ runtime: runtimeStatus({ skillImports: [importRow({ status: 'failed', errorCode: 'SKILL_IMPORT_ILLEGAL_CONTENT', contentHash: '' })] }) })
    expect(failed).toContain('导入失败：SKILL_IMPORT_ILLEGAL_CONTENT')
    expect(failed).not.toContain(PACKAGE_HASH)
  })

  it.skipIf(process.platform !== 'win32')('refuses an unauthenticated confirmed import through the actual bundled Runtime', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-skill-bridge-'))
    // The package lives outside the protected profile area: a real picked file.
    const packages = mkdtempSync(join(tmpdir(), 'ideer-skill-packages-'))
    const packagePath = join(packages, 'report-skill.md')
    writeFileSync(packagePath, '---\nname: report-skill\ndescription: Build a weekly report\n---\n\n# Report skill\n', 'utf8')
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect(runtime.status().skillImports).toEqual([])
      // The device-side preview stays local by design; the confirmed upload
      // needs the platform session and is refused with the fixed category.
      await expect(runtime.importSkill('markdown', [packagePath], true)).rejects.toThrow('CHAT_UNAUTHENTICATED')
      // The unauthenticated status carries no import display facts.
      expect(runtime.status().skillImports).toEqual([])
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
      rmSync(packages, { recursive: true, force: true })
    }
  }, 30000)
})

describe('skill trigger preference configuration bridge (#121)', () => {
  it('validates the preference command before the owned Runtime and never matches locally', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-121/unused')
    const good = { action: 'set' as const, skillId: RESOURCE, enabled: true, keywords: ['report'], alwaysInject: false, applicableAgentIds: [], priority: 5 }
    for (const command of [
      null, 'list', 7, {},
      { action: 'remove' },
      { action: 'list', extra: 1 },
      { action: 'set', skillId: 'not-a-uuid' },
      { action: 'set', skillId: `${RESOURCE}/extra` },
      { action: 'clear' },
      { action: 'clear', skillId: 'nope' },
      { ...good, priority: 1001 },
      { ...good, priority: -1001 },
      { ...good, priority: 1.5 },
      { ...good, keywords: new Array(17).fill('k') },
      { ...good, keywords: [''] },
      { ...good, keywords: ['x'.repeat(65)] },
      { ...good, applicableAgentIds: ['nope'] },
      { ...good, applicableAgentIds: new Array(33).fill(RESOURCE) },
      { ...good, enabled: 'yes' },
      { ...good, extra: 1 }
    ]) {
      await expect(runtime.skillPreferences(command as never)).rejects.toThrow('SKILL_PREFERENCE_COMMAND_INVALID')
    }
    // Well-formed commands still need the owned Runtime process: the Desktop
    // owns no matching code and no model — the command only travels onward.
    await expect(runtime.skillPreferences({ action: 'list' })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.skillPreferences(good)).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.skillPreferences({ action: 'clear', skillId: RESOURCE })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })

  it('renders the preference surface with the Server-owned fields and honest availability', () => {
    const html = renderSection({ initialPreferences: { skills: [preferenceRow()] } })
    expect(html).toContain('触发偏好（Server 端匹配）')
    // The configuration surface names the documented fields only.
    expect(html).toContain('report-skill')
    expect(html).toContain('可用')
    expect(html).toContain('weekly report')
    expect(html).toContain('始终注入')
    expect(html).toContain('适用 Agent')
    expect(html).toContain('优先级')
    expect(html).toContain('保存偏好')
    expect(html).toContain('清除')
    // An unavailable Skill says so instead of pretending it can trigger.
    const unavailable = renderSection({ initialPreferences: { skills: [preferenceRow({ available: false, latestVersion: 0 })] } })
    expect(unavailable).toContain('不可用')
    // Empty state: the account holds no preferences yet.
    expect(renderSection()).toContain('正在加载触发偏好')
  })
})

describe('device skill script authorization surface (#122)', () => {
  const grant = {
    id: 'a'.repeat(64), resourceId: RESOURCE, slug: 'report-skill', version: 2,
    contentHash: PACKAGE_HASH, scriptPath: 'scripts/analyze.py', scriptSha256: 'b'.repeat(64),
    requirementsHash: 'd'.repeat(64), status: 'granted' as const, createdAt: '2026-10-27T00:00:00Z'
  }

  it('validates the script command before the owned Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-122/unused')
    for (const command of [
      null, 'list', {}, { action: 'grant' }, { action: 'list', extra: 1 },
      { action: 'revoke' }, { action: 'revoke', authorizationId: '' },
      { action: 'revoke', authorizationId: 'x'.repeat(129) }, { action: 'revoke', authorizationId: 7 }
    ]) {
      await expect(runtime.skillScripts(command as never)).rejects.toThrow('SKILL_SCRIPT_COMMAND_INVALID')
    }
    await expect(runtime.skillScripts({ action: 'list' })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.skillScripts({ action: 'revoke', authorizationId: 'a'.repeat(64) }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })

  it('renders remembered grants with revoke and shows the storage error honestly', async () => {
    const html = renderToStaticMarkup(
      <SkillSection
        runtime={runtimeStatus({
          skillScriptAuthorizations: [grant],
          skillImports: []
        })}
        busy={false}
        error=""
        onCommand={() => {}}
        onPreferences={async () => ({ skills: [] })}
        onScriptCommands={async () => ({ authorizations: [grant] })}
      />
    )
    expect(html).toContain('脚本授权（设备本地）')
    expect(html).toContain('report-skill')
    expect(html).toContain('scripts/analyze.py')
    expect(html).toContain('脚本指纹')
    expect(html).toContain('撤销此授权')
// No grants and no error: the empty state says so instead of inventing rows.
    const empty = renderToStaticMarkup(
      <SkillSection runtime={runtimeStatus({ skillImports: [] })} busy={false} error=""
        onCommand={() => {}} onPreferences={async () => ({ skills: [] })}
        onScriptCommands={async () => ({ authorizations: [] })} />
    )
    expect(empty).toContain('本机当前没有已记住的技能脚本授权')
    const storageError = renderToStaticMarkup(
      <SkillSection runtime={runtimeStatus({
        skillImports: [], skillScriptStorageError: 'SKILL_SCRIPT_STORAGE_UNAVAILABLE'
      })} busy={false} error="" onCommand={() => {}} onPreferences={async () => ({ skills: [] })}
        onScriptCommands={async () => ({ authorizations: [] })} />
    )
    expect(storageError).toContain('脚本授权记录存储不可用')
  })
})
