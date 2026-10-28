import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'
import { SkillSection } from '../src/renderer/src/components/SkillSection'
import type { RuntimeStatus, SkillImportView } from '../src/shared/desktop'

const RESOURCE = '77777777-7777-4777-8777-777777777777'
const PACKAGE_HASH = 'c'.repeat(64)

const importRow = (overrides: Partial<SkillImportView> = {}): SkillImportView => ({
  id: 'skill-1', resourceId: RESOURCE, slug: 'report-skill', revision: 1, contentHash: PACKAGE_HASH,
  version: 0, origin: 'zip', fileCount: 3, totalBytes: 128, status: 'imported', errorCode: '',
  createdAt: '2026-10-27T00:00:00Z', ...overrides
})

const runtimeStatus = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus =>
  ({ process: 'running', connection: 'connected', tasks: [], skillImports: [importRow()], ...overrides })

const renderSection = (overrides: {
  runtime?: RuntimeStatus
  busy?: boolean
  error?: string
} = {}): string =>
  renderToStaticMarkup(
    <SkillSection
      runtime={overrides.runtime ?? runtimeStatus()}
      busy={overrides.busy ?? false}
      error={overrides.error ?? ''}
      onCommand={() => {}}
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
