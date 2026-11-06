import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'
import { formatDeclarationSummary } from '../src/main/skillDeclaration'
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

describe('skill package declaration import bridge (#82)', () => {
  const DECLARED_MD = [
    '---',
    'name: declared-skill',
    'description: Declares environment and permissions',
    'requires-internet: true',
    'permissions:',
    '  - network',
    '  - subprocess',
    'execution-environment:',
    '  target: user_device',
    '  os:',
    '    - windows',
    '  dependencies:',
    '    - python3>=3.10',
    '  software: []',
    '  tools: []',
    '  data: []',
    '---',
    '',
    '# Declared skill',
    ''
  ].join('\n')

  it('formats the confirmation dialog declaration summary', () => {
    const summary = formatDeclarationSummary(
      [
        { path: 'SKILL.md', role: 'body', bytes: 10, sha256: 'a'.repeat(64), language: '' },
        { path: 'scripts/analyze.py', role: 'script', bytes: 20, sha256: 'b'.repeat(64), language: 'python' },
        { path: 'scripts/render.js', role: 'script', bytes: 30, sha256: 'c'.repeat(64), language: 'js' }
      ],
      { target: 'user_device', os: ['windows'], dependencies: ['python3>=3.10'], software: [], tools: ['pandoc'], data: [] },
      { network: true, subprocess: false })
    expect(summary).toContain('声明语言：scripts/analyze.py（Python）、scripts/render.js（JS）')
    expect(summary).toContain('权限声明：联网（未声明的能力不会被自动授予）')
    expect(summary).toContain('依赖与环境：执行目标 本机设备；系统 windows；依赖 python3>=3.10；工具 pandoc')
    // A package that declares nothing says so instead of omitting the block.
    const undeclared = formatDeclarationSummary(
      [{ path: 'SKILL.md', role: 'body', bytes: 10, sha256: 'a'.repeat(64), language: '' }],
      null, { network: false, subprocess: false })
    expect(undeclared).toContain('声明语言：（包内无脚本成员）')
    expect(undeclared).toContain('权限声明：未声明联网/子进程权限')
    expect(undeclared).toContain('依赖与环境：包未声明执行环境')
  })

  it.skipIf(process.platform !== 'win32')('projects the declared environment, permissions, and script languages through the owned Runtime', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-skill-declared-'))
    // The packages live outside the protected profile area as real picked
    // directories; the device-side preview stays local and needs no session.
    const packages = mkdtempSync(join(tmpdir(), 'ideer-skill-declared-pkg-'))
    const declaredDir = join(packages, 'declared-skill')
    for (const [relative, content] of [
      ['SKILL.md', DECLARED_MD],
      ['scripts/analyze.py', "print('analyze')\n"],
      ['scripts/render.js', "console.log('render')\n"],
      ['references/notes.md', '# Frozen reference notes\n']
    ] as const) {
      const target = join(declaredDir, relative)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
    }
    const invalidDir = join(packages, 'invalid-skill')
    mkdirSync(join(invalidDir, 'scripts'), { recursive: true })
    writeFileSync(join(invalidDir, 'SKILL.md'), DECLARED_MD.replace('target: user_device', 'target: phone'), 'utf8')
    writeFileSync(join(invalidDir, 'scripts', 'analyze.py'), "print('analyze')\n", 'utf8')
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      const preview = await runtime.importSkill('directory', [declaredDir], false)
      if (preview.confirmed !== false) throw new Error('expected a preview')
      // #82 AC2/AC5: the declaration the user confirms is the normalized
      // frozen-grammar projection plus the declared permission facts.
      expect(preview.environment).toEqual({
        target: 'user_device', os: ['windows'], dependencies: ['python3>=3.10'],
        software: [], tools: [], data: []
      })
      expect(preview.permissions).toEqual({ network: true, subprocess: true })
      // #82 AC1: the four-language recognition rides the script members.
      const languages = Object.fromEntries(preview.files.map((file) => [file.path, file.language]))
      expect(languages['SKILL.md']).toBe('')
      expect(languages['references/notes.md']).toBe('')
      expect(languages['scripts/analyze.py']).toBe('python')
      expect(languages['scripts/render.js']).toBe('js')
      // A declaration the device cannot read refuses with its fixed category;
      // nothing uploads and no import fact is left behind.
      await expect(runtime.importSkill('directory', [invalidDir], false))
        .rejects.toThrow('SKILL_IMPORT_INVALID_DECLARATION')
      expect(runtime.status().skillImports).toEqual([])
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
      rmSync(packages, { recursive: true, force: true })
    }
  }, 30000)
})
