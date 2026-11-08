// Issue 119: the data-driven installer component catalog. The checked-in
// resources/components/catalog.json is the single source of truth for the
// wizard's three dependency tiers (最小/常用/自定义, mapped onto NSIS install
// types) and the engineering components. This module validates the shape,
// expands tiers, computes the version-lock identity (app version plus one
// SHA-256 per artifact file, pinned against the linz provenance), and renders
// the NSIS sections. It reads only local paths — the offline pack tool and the
// build hooks share it, and nothing here touches the network.
'use strict'

const { createHash } = require('node:crypto')
const { existsSync, readFileSync, statSync } = require('node:fs')
const { isAbsolute, join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const TIER_IDS = ['minimal', 'typical', 'custom']
const TIER_INSTTYPE = { minimal: 1, typical: 2, custom: 3 }
const STATUSES = ['available', 'bundled', 'pending']
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

class CatalogError extends Error {
  constructor(code, message) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'CatalogError'
    this.code = code
  }
}

function text(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 400 || value.includes('\0')) {
    throw new CatalogError('CATALOG_INVALID', `${field} 必须是非空文本`)
  }
  return value
}

/** One package-relative posix path that cannot escape or masquerade. */
function checkedRelative(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\\') ||
      value.startsWith('/') || isAbsolute(value) || /[:\0]/.test(value)) {
    throw new CatalogError('CATALOG_INVALID', `${field} 必须是仓库相对路径`)
  }
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new CatalogError('CATALOG_INVALID', `${field} 必须是仓库相对路径`)
  }
  return value
}

/**
 * Validate one catalog against the frozen shape; unknown keys and impossible
 * tier/artifact combinations are refused instead of half-accepted.
 */
function validateCatalog(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new CatalogError('CATALOG_INVALID', 'catalog 必须是 JSON 对象')
  }
  if (setKeys(data) !== 'components,schema,tiers' || data.schema !== 1) {
    throw new CatalogError('CATALOG_INVALID', 'catalog 顶层字段固定为 schema/tiers/components')
  }
  if (!Array.isArray(data.tiers) || data.tiers.length !== TIER_IDS.length) {
    throw new CatalogError('CATALOG_INVALID', `tiers 必须恰好是 ${TIER_IDS.join('/')}`)
  }
  data.tiers.forEach((tier, index) => {
    if (typeof tier !== 'object' || tier === null || setKeys(tier) !== 'description,id,name') {
      throw new CatalogError('CATALOG_INVALID', 'tier 字段固定为 id/name/description')
    }
    if (tier.id !== TIER_IDS[index]) {
      throw new CatalogError('CATALOG_INVALID', `tier 顺序必须固定为 ${TIER_IDS.join('/')}`)
    }
    text(tier.name, `tiers[${index}].name`)
    text(tier.description, `tiers[${index}].description`)
  })
  if (!Array.isArray(data.components) || data.components.length === 0) {
    throw new CatalogError('CATALOG_INVALID', 'components 必须是非空数组')
  }
  const seen = new Set()
  for (const component of data.components) {
    if (typeof component !== 'object' || component === null) {
      throw new CatalogError('CATALOG_INVALID', 'component 必须是对象')
    }
    if (!ID_PATTERN.test(component.id ?? '') || seen.has(component.id)) {
      throw new CatalogError('CATALOG_INVALID', `component id 非法或重复: ${String(component.id)}`)
    }
    seen.add(component.id)
    text(component.name, `${component.id}.name`)
    text(component.description, `${component.id}.description`)
    if (!STATUSES.includes(component.status)) {
      throw new CatalogError('CATALOG_INVALID', `${component.id}.status 必须是 ${STATUSES.join('/')}`)
    }
    if (component.status === 'available') {
      if (setKeys(component) !== 'artifact,description,id,name,provenance,status,tiers' &&
          setKeys(component) !== 'artifact,description,id,name,status,tiers') {
        throw new CatalogError('CATALOG_INVALID', `${component.id} 字段集合非法`)
      }
      const tiers = component.tiers
      if (typeof tiers !== 'object' || tiers === null || setKeys(tiers) !== 'custom,minimal,typical' ||
          Object.values(tiers).some(flag => typeof flag !== 'boolean')) {
        throw new CatalogError('CATALOG_INVALID', `${component.id}.tiers 必须覆盖三档`)
      }
      const artifact = component.artifact
      if (typeof artifact !== 'object' || artifact === null || setKeys(artifact) !== 'dest,files,source' ||
          !Array.isArray(artifact.files) || artifact.files.length === 0) {
        throw new CatalogError('CATALOG_INVALID', `${component.id}.artifact 字段集合非法`)
      }
      checkedRelative(artifact.source, `${component.id}.artifact.source`)
      checkedRelative(artifact.dest, `${component.id}.artifact.dest`)
      const files = new Set()
      for (const file of artifact.files) {
        // Artifact members stay single file names inside the artifact root.
        const relative = checkedRelative(file, `${component.id}.artifact.files[]`)
        if (relative.includes('/')) {
          throw new CatalogError('CATALOG_INVALID', `${component.id}.artifact.files 仅接受文件名`)
        }
        files.add(relative)
      }
      if (files.size !== artifact.files.length) {
        throw new CatalogError('CATALOG_INVALID', `${component.id}.artifact.files 存在重复`)
      }
      if (component.provenance !== undefined) {
        if (typeof component.provenance !== 'object' || component.provenance === null ||
            setKeys(component.provenance) !== 'file,prefix') {
          throw new CatalogError('CATALOG_INVALID', `${component.id}.provenance 字段集合非法`)
        }
        checkedRelative(component.provenance.file, `${component.id}.provenance.file`)
        text(component.provenance.prefix, `${component.id}.provenance.prefix`)
      }
    } else {
      // Bundled and pending components are wizard statements, not installable
      // artifacts: no artifact, no tier membership, always an honest note.
      if (setKeys(component) !== 'description,id,name,note,status') {
        throw new CatalogError('CATALOG_INVALID', `${component.id} 字段集合非法`)
      }
      text(component.note, `${component.id}.note`)
    }
  }
  return data
}

function setKeys(object) {
  return Object.keys(object).sort().join(',')
}

function loadCatalog(root = ROOT, file = join(root, 'resources/components/catalog.json')) {
  let raw
  try {
    raw = readFileSync(file)
  } catch {
    throw new CatalogError('CATALOG_INVALID', `无法读取组件目录: ${file}`)
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new CatalogError('CATALOG_INVALID', 'catalog.json 不是合法 JSON')
  }
  return validateCatalog(data)
}

function componentById(catalog, id) {
  return catalog.components.find(component => component.id === id) ?? null
}

/**
 * One tier → the installable component ids it selects, in catalog order.
 * Bundled and pending entries never expand: they are not install units.
 */
function expandTier(catalog, tierId) {
  if (!TIER_IDS.includes(tierId)) {
    throw new CatalogError('TIER_UNKNOWN', `未知依赖档位: ${tierId}`)
  }
  return catalog.components
    .filter(component => component.status === 'available' && component.tiers[tierId])
    .map(component => component.id)
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function provenancePins(root, component) {
  const pins = JSON.parse(readFileSync(join(root, component.provenance.file), 'utf8')).files
  const map = {}
  for (const file of component.artifact.files) {
    map[file] = pins[component.provenance.prefix + file]
  }
  return map
}

/**
 * The version-lock identity an installation carries: the app version plus one
 * SHA-256 per artifact file. When the component pins provenance, the archived
 * pins stay authoritative — a build tree whose bytes drifted is refused
 * instead of locked.
 */
function componentLock(root = ROOT, appVersion = appVersionOf(root)) {
  if (typeof appVersion !== 'string' || !VERSION_PATTERN.test(appVersion)) {
    throw new CatalogError('CATALOG_INVALID', `appVersion 非法: ${String(appVersion)}`)
  }
  const catalog = loadCatalog(root)
  const components = {}
  for (const id of expandables(catalog)) {
    const component = componentById(catalog, id)
    const files = {}
    for (const file of component.artifact.files) {
      const absolute = join(root, component.artifact.source, file)
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw new CatalogError('ARTIFACT_MISSING', `组件 ${id} 缺少制品文件: ${component.artifact.source}/${file}`)
      }
      const digest = sha256File(absolute)
      if (component.provenance) {
        const pinned = provenancePins(root, component)[file]
        if (pinned === undefined) {
          throw new CatalogError('PROVENANCE_MISMATCH', `provenance 未固定 ${id}/${file}`)
        }
        if (pinned !== digest) {
          throw new CatalogError('PROVENANCE_MISMATCH',
            `组件 ${id} 的 ${file} 与 provenance 固定哈希不一致（版本锁定拒绝）`)
        }
      }
      files[file] = digest
    }
    components[id] = { artifact: component.artifact.source, dest: component.artifact.dest, files }
  }
  return { schema: 1, appVersion, components }
}

function expandables(catalog) {
  return catalog.components.filter(component => component.status === 'available').map(component => component.id)
}

function appVersionOf(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

function sectionSymbol(id) {
  return `SEC_IDEER_${id.replace(/-/g, '_').toUpperCase()}`
}

function nsisString(value) {
  if (value.includes('"') || value.includes('$')) {
    throw new CatalogError('CATALOG_INVALID', `NSIS 文本不能包含引号或 $: ${value}`)
  }
  return value
}

/**
 * Render the deterministic NSIS installer script: three install types, one
 * selectable section per available component, honest read-only entries for
 * bundled/pending components, and the core-section protection. The output is
 * checked in at resources/nsis/components.nsh and pinned by tests.
 */
function generateNsis(catalog) {
  const lines = [
    '; GENERATED FILE — DO NOT EDIT.',
    '; Produced by scripts/generate-component-nsis.cjs from resources/components/catalog.json.',
    '; Regenerate with: npm run components:generate',
    '!ifndef IDEER_COMPONENTS_NSH',
    '!define IDEER_COMPONENTS_NSH',
    '',
    '; Issue 119: the three dependency tiers are NSIS install types (1-based',
    '; in declaration order). 最小 = 主程序 + 内置 Python Runtime（Runtime 是核心，',
    '; 应用离开它无法工作，故不作为可选组件）；常用 = 再加常用工程组件；自定义 =',
    '; 从常用配置开始自行勾选。向导不联网安装任何额外内容。',
    ...catalog.tiers.map(tier => `InstType "${nsisString(tier.name)}"`),
    '',
    '; The components page rides between the directory page and the installing',
    '; page through electron-builder\'s customPageAfterChangeDir hook.',
    '!macro customPageAfterChangeDir',
    '  !insertmacro MUI_PAGE_COMPONENTS',
    '!macroend',
    '',
    '; Sections live in the installer build only — the uninstaller build pass',
    '; would otherwise embed every artifact a second time.',
    '!ifndef BUILD_UNINSTALLER',
    ''
  ]
  if (catalog.tiers.length !== TIER_IDS.length) throw new CatalogError('CATALOG_INVALID', 'tiers 非法')
  for (const component of catalog.components) {
    const symbol = sectionSymbol(component.id)
    if (component.status === 'available') {
      const membership = TIER_IDS.filter(tier => component.tiers[tier]).map(tier => TIER_INSTTYPE[tier])
      if (membership.length === 0) {
        throw new CatalogError('CATALOG_INVALID', `${component.id} 至少要属于一个档位`)
      }
      lines.push(`Section "${nsisString(component.name)}" ${symbol}`)
      lines.push(`  SectionIn ${membership.join(' ')}`)
      lines.push(`  SetOutPath "$INSTDIR\\${component.artifact.dest.replace(/\//g, '\\')}"`)
      // BUILD_RESOURCES_DIR already points at <repo>/resources, so the File
      // source is the artifact path inside that directory.
      if (!component.artifact.source.startsWith('resources/')) {
        throw new CatalogError('CATALOG_INVALID', `${component.id}.artifact.source 必须位于 resources/ 下`)
      }
      const inResources = component.artifact.source.replace(/^resources\//, '').replace(/\//g, '\\')
      for (const file of component.artifact.files) {
        lines.push(`  File "${'$'}{BUILD_RESOURCES_DIR}\\${inResources}\\${file}"`)
      }
      lines.push('SectionEnd', '')
    } else if (component.status === 'bundled') {
      lines.push(`Section "${nsisString(`${component.name}（${component.note}）`)}" ${symbol}`)
      lines.push('  SectionIn RO')
      lines.push('  ; Intentional no-op: this component is part of the app bundle; the')
      lines.push('  ; entry exists so the wizard states that honestly.')
      lines.push('SectionEnd', '')
    } else {
      lines.push(`Section /o "${nsisString(`${component.name}（待提供：${component.note}）`)}" ${symbol}`)
      lines.push('  ; Intentional no-op: pending upstream work — explicitly not installable.')
      lines.push('SectionEnd', '')
    }
  }
  const pending = catalog.components.filter(component => component.status === 'pending')
  const coreIndex = catalog.components.length
  lines.push(
    '; The core section (electron-builder\'s "install" section) is the next one',
    '; after the component sections above. Guard the layout: if that assumption',
    '; ever breaks, abort loudly instead of protecting the wrong section.',
    `!define IDEER_CORE_SECTION_INDEX ${coreIndex}`,
    '',
    '!macro customInit',
    '  SectionGetText ${IDEER_CORE_SECTION_INDEX} $0',
    '  StrCmp $0 "install" ideer_components_core_ok',
    '  DetailPrint "iDeer: unexpected installer section layout (section ' + coreIndex + ' is $0)"',
    '  Abort',
    '  ideer_components_core_ok:',
    `  SectionSetText ${'$'}{IDEER_CORE_SECTION_INDEX} "主程序与 Python Runtime（必装）"`,
    `  SectionSetFlags ${'$'}{IDEER_CORE_SECTION_INDEX} 17`,
    ...pending.flatMap(component => [
      `  ; ${component.id} stays visible but locked read-only and unselected:`,
      '  ; pending components are never silently installable.',
      `  SectionSetFlags ${'$'}{${sectionSymbol(component.id)}} 16`
    ]),
    '!macroend',
    '',
    '!endif ; !BUILD_UNINSTALLER',
    '',
    '; Each available component section uninstalls its own files (the stock',
    '; uninstaller\'s RMDir /r $INSTDIR also removes them; these lines state',
    '; the ownership explicitly).',
    '!macro customUnInstall'
  )
  for (const component of catalog.components) {
    if (component.status !== 'available') continue
    for (const file of component.artifact.files) {
      lines.push(`  Delete "$INSTDIR\\${component.artifact.dest.replace(/\//g, '\\')}\\${file}"`)
    }
    lines.push(`  RMDir "$INSTDIR\\${component.artifact.dest.replace(/\//g, '\\')}"`)
  }
  lines.push('!macroend', '', '!endif ; IDEER_COMPONENTS_NSH')
  return lines.join('\n') + '\n'
}

module.exports = {
  CatalogError,
  ROOT,
  TIER_IDS,
  componentById,
  componentLock,
  expandTier,
  generateNsis,
  loadCatalog,
  sha256File
}
