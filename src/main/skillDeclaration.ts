import type { SkillImportEnvironmentView, SkillImportPermissionsView, SkillPackageFileView, SkillScriptLanguage } from '../shared/desktop'

/** Issue 82: the human labels of the four declared script languages. */
const LANGUAGE_LABELS: Record<SkillScriptLanguage, string> = {
  python: 'Python',
  js: 'JS',
  shell: 'Shell',
  executable: '可执行'
}

/** The dialog names at most this many scripts; larger packages summarize by
 * the file count line instead of an unbounded language list. */
const MAX_SUMMARY_SCRIPTS = 8

/** Issue 82: the confirmation dialog's declaration summary.
 *
 * The import decision point must show what the package declares — script
 * languages, network/subprocess permissions, and the environment's
 * requirement dimensions — before any byte uploads. A package that declares
 * nothing says so instead of omitting the block, so silence is never
 * ambiguous. Pure display: authorization still happens per script at
 * execution time through the existing script-consent gate.
 */
export function formatDeclarationSummary(
  files: SkillPackageFileView[],
  environment: SkillImportEnvironmentView | null,
  permissions: SkillImportPermissionsView
): string {
  const scripts = files.filter((file) => file.role === 'script').slice(0, MAX_SUMMARY_SCRIPTS)
  const languageParts: string[] = []
  for (const script of scripts) {
    languageParts.push(script.language ? `${script.path}（${LANGUAGE_LABELS[script.language]}）` : script.path)
  }
  const lines: string[] = []
  lines.push(languageParts.length ? `声明语言：${languageParts.join('、')}` : '声明语言：（包内无脚本成员）')
  const permissionParts: string[] = []
  if (permissions.network) permissionParts.push('联网')
  if (permissions.subprocess) permissionParts.push('子进程')
  lines.push(permissionParts.length ? `权限声明：${permissionParts.join('、')}（未声明的能力不会被自动授予）` : '权限声明：未声明联网/子进程权限')
  if (environment) {
    const parts: string[] = [`执行目标 ${environment.target === 'user_device' ? '本机设备' : '服务器'}`]
    if (environment.os.length) parts.push(`系统 ${environment.os.join('、')}`)
    if (environment.dependencies.length) parts.push(`依赖 ${environment.dependencies.join('、')}`)
    if (environment.software.length) parts.push(`软件 ${environment.software.join('、')}`)
    if (environment.tools.length) parts.push(`工具 ${environment.tools.join('、')}`)
    if (environment.data.length) parts.push(`数据 ${environment.data.join('、')}`)
    lines.push(`依赖与环境：${parts.join('；')}`)
  } else {
    lines.push('依赖与环境：包未声明执行环境')
  }
  return lines.join('\n')
}
