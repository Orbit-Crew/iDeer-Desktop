import { readFileSync as readBundledFile } from 'node:fs'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from './update-filesystem'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { StagedUpdate } from './update-stage'
import { regularUpdateFile } from './update-stage'
import { verifyUpdate, type UpdateCurrent, type UpdateManifest } from './updates'
import { contained, durableJSON, readDataFormat, safeProgramPath, sha256File, writeRecoveryState, type RecoveryState } from './recovery'

export interface ProgramFact { path: string; sha256: string | null }
export interface MaintenanceTransaction {
  version: 1; id: string; state: 'prepared' | 'applying' | 'verifying' | 'restoring' | 'updated' | 'rolled-back' | 'recovery-failed'
  programRoot: string; userData: string; executable: string; stageRoot: string; payloadRoot: string; installerPath?: string
  parentPid: number; relatedPids: number[]; current: UpdateCurrent; manifest: UpdateManifest; source: 'online' | 'offline'; publicKeyPem: string
  backup: ProgramFact[]; oldAsarSHA256: string; oldLockSHA256: string; detail: string
}
export interface MaintenanceHost {
  waitStopped(transaction: MaintenanceTransaction): Promise<void>
  install(transaction: MaintenanceTransaction): Promise<void>
  launchAndVerify(transaction: MaintenanceTransaction, rollback: boolean): Promise<void>
  stopLaunched(): Promise<void>
}
const journalName = 'transaction.json'
const journalPath = (t: MaintenanceTransaction) => join(t.stageRoot, journalName)
const save = (t: MaintenanceTransaction): void => durableJSON(journalPath(t), t)
const flushCopy = (source: string, destination: string): void => {
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = destination + '.' + randomUUID() + '.update-tmp'
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL)
    const fd = openSync(temporary, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    // A stopped app's archive is always a complete old or new file, including
    // when a helper is interrupted during the copy. Startup can resume recovery.
    renameSync(temporary, destination)
  } finally { if (existsSync(temporary)) rmSync(temporary) }
}

function inventory(root: string, prefix = ''): string[] {
  const result: string[] = []
  for (const name of readdirSync(prefix ? safeProgramPath(root, prefix) : root)) {
    const path = prefix ? prefix + '/' + name : name
    const target = safeProgramPath(root, path)
    const info = lstatSync(target)
    if (info.isDirectory()) result.push(...inventory(root, path))
    else if (info.isFile()) result.push(path)
    else throw new Error('UPDATE_PROGRAM_FILE_INVALID')
  }
  return result
}
function validateLayout(t: MaintenanceTransaction): void {
  if (!/^[0-9a-f-]{36}$/.test(t.id) || resolve(t.stageRoot) !== resolve(join(t.userData, 'Updates', 'stage-' + t.id)) ||
      resolve(t.executable) !== resolve(join(t.programRoot, 'ideer-desktop.exe')) ||
      contained(t.programRoot, t.userData) || contained(t.userData, t.programRoot) || resolve(t.userData) === resolve(t.programRoot) ||
      contained(t.programRoot, t.stageRoot)) throw new Error('UPDATE_TRANSACTION_ROOT_INVALID')
  safeProgramPath(t.stageRoot, journalName)
}
function validateSignedManifest(t: MaintenanceTransaction): void {
  validateLayout(t)
  const stage = t.stageRoot
  const verified = verifyUpdate(readFileSync(regularUpdateFile(stage, 'manifest.json'), 'utf8'),
    readFileSync(regularUpdateFile(stage, 'manifest.sig'), 'utf8').trim(), t.publicKeyPem, t.current, t.source)
  if (!verified.pending || JSON.stringify(verified.pending.manifest) !== JSON.stringify(t.manifest)) throw new Error('UPDATE_STAGE_SIGNATURE_INVALID')
}
function validateRelease(t: MaintenanceTransaction): void {
  validateSignedManifest(t)
  const stage = t.stageRoot
  for (const file of t.manifest.files) {
    const source = regularUpdateFile(t.payloadRoot, file.path)
    if (lstatSync(source).size !== file.bytes || sha256File(source) !== file.sha256) throw new Error('UPDATE_PAYLOAD_INTEGRITY_FAILED')
    safeProgramPath(t.programRoot, file.path)
  }
  for (const path of t.manifest.deletions) safeProgramPath(t.programRoot, path)
  if (t.manifest.kind === 'full') {
    const entry = t.manifest.installer!
    const path = regularUpdateFile(stage, 'installer.exe')
    if (resolve(path) !== resolve(t.installerPath || '') || lstatSync(path).size !== entry.bytes || sha256File(path) !== entry.sha256) throw new Error('UPDATE_INSTALLER_INTEGRITY_FAILED')
  }
}

/** One durable stage identity for backup, install, startup verification and recovery. */
export function prepareTransaction(options: { stage: StagedUpdate; programRoot: string; userData: string;
    executable: string; current: UpdateCurrent; publicKeyPem: string; parentPid: number; relatedPids?: number[] }): string {
  const { stage } = options
  const t: MaintenanceTransaction = { version: 1, id: stage.id, state: 'prepared', programRoot: resolve(options.programRoot),
    userData: resolve(options.userData), executable: resolve(options.executable), stageRoot: resolve(stage.stageRoot),
    payloadRoot: resolve(stage.payloadRoot), installerPath: stage.installerPath, parentPid: options.parentPid, relatedPids: options.relatedPids || [],
    current: options.current, manifest: stage.pending.manifest, source: stage.pending.source, publicKeyPem: options.publicKeyPem,
    backup: [], oldAsarSHA256: '', oldLockSHA256: '', detail: 'backup committed; awaiting process exit' }
  validateRelease(t)
  if (readDataFormat(t.userData) !== t.current.dataFormat) throw new Error('UPDATE_DATA_FORMAT_CHANGED')
  if (existsSync(journalPath(t))) throw new Error('UPDATE_TRANSACTION_ALREADY_EXISTS')
  const paths = t.manifest.kind === 'full' ? inventory(t.programRoot) : [...t.manifest.files.map(f => f.path), ...t.manifest.deletions]
  for (const path of paths) {
    const target = safeProgramPath(t.programRoot, path)
    const sha256 = existsSync(target) ? sha256File(target) : null
    if (sha256) flushCopy(target, safeProgramPath(join(t.stageRoot, 'backup'), path))
    t.backup.push({ path, sha256 })
  }
  t.oldAsarSHA256 = sha256File(safeProgramPath(t.programRoot, 'resources/app.asar'))
  t.oldLockSHA256 = sha256File(safeProgramPath(t.programRoot, 'resources/runtime/distribution.lock.json'))
  save(t)
  const psQuote = (value: string): string => "'" + value.replace(/'/g, "''") + "'"
  durableJSON(join(t.stageRoot, 'repair-instructions.json'), {
    profileToPreserve: t.userData,
    backupToPreserve: join(t.stageRoot, 'backup'),
    resumeCommand: "$env:ELECTRON_RUN_AS_NODE='1'; & " +
      [join(t.stageRoot, 'helper/ideer-desktop.exe'), join(t.stageRoot, 'helper/update-helper.cjs'), journalPath(t)].map(psQuote).join(' '),
    fullRepair: 'If automatic recovery cannot safely finish, reinstall a verified complete installer into ' + t.programRoot +
      '. Preserve the profile and backup above. Do not uninstall or copy old credentials, authorizations or receipts over the current profile.'
  })
  writeRecoveryState(t.userData, recoveryView(t, 'applied-pending-verify'))
  return journalPath(t)
}
function recoveryView(t: MaintenanceTransaction, state: RecoveryState['state']): RecoveryState {
  return { state, stamp: t.id, programRoot: t.programRoot, journalPath: journalPath(t),
    desktopVersion: state === 'rolled-back' ? t.current.desktopVersion : t.manifest.desktop.version,
    runtimePython: state === 'rolled-back' ? t.current.runtimePython : t.manifest.runtime.python,
    detail: t.detail + '; diagnostics: ' + journalPath(t) + (state === 'recovery-failed' && t.manifest.kind === 'full'
      ? '; Reinstall a verified complete installer into ' + t.programRoot + ' without deleting the current profile. Repair instructions: ' + join(t.stageRoot, 'repair-instructions.json') : '') }
}
function verifyProgram(t: MaintenanceTransaction, rollback: boolean): void {
  if (rollback) {
    for (const fact of t.backup) {
      const path = safeProgramPath(t.programRoot, fact.path)
      if (fact.sha256 === null ? existsSync(path) : !existsSync(path) || sha256File(path) !== fact.sha256) throw new Error('RECOVERY_COMBINATION_INTEGRITY_FAILED')
    }
  } else {
    for (const file of t.manifest.files) {
      const path = safeProgramPath(t.programRoot, file.path)
      if (!existsSync(path) || lstatSync(path).size !== file.bytes || sha256File(path) !== file.sha256) throw new Error('UPDATE_COMBINATION_INTEGRITY_FAILED')
    }
    for (const path of t.manifest.deletions) if (existsSync(safeProgramPath(t.programRoot, path))) throw new Error('UPDATE_DELETION_FAILED')
  }
  if (sha256File(safeProgramPath(t.programRoot, 'resources/app.asar')) !== (rollback ? t.oldAsarSHA256 : t.manifest.desktop.asarSHA256) ||
      sha256File(safeProgramPath(t.programRoot, 'resources/runtime/distribution.lock.json')) !== (rollback ? t.oldLockSHA256 : t.manifest.runtime.lockSHA256)) throw new Error('UPDATE_COMBINATION_MISMATCH')
}
function restore(t: MaintenanceTransaction): void {
  const format = readDataFormat(t.userData)
  if (!t.current.readableFormats.includes(format)) throw new Error('RECOVERY_DATA_FORMAT_UNREADABLE')
  // Verify every backup before restoring any byte.
  for (const fact of t.backup) if (fact.sha256 && sha256File(regularUpdateFile(join(t.stageRoot, 'backup'), fact.path)) !== fact.sha256) throw new Error('RECOVERY_BACKUP_INTEGRITY_FAILED')
  if (t.manifest.kind === 'full') {
    const prior = new Set(t.backup.map(f => f.path.toLowerCase()))
    for (const path of inventory(t.programRoot)) if (!prior.has(path.toLowerCase())) rmSync(safeProgramPath(t.programRoot, path))
  }
  for (const fact of t.backup) {
    const target = safeProgramPath(t.programRoot, fact.path)
    if (existsSync(target) && lstatSync(target).isDirectory()) rmdirSync(target) // only an empty obstruction; never recursively delete user contents
    if (fact.sha256 === null) { if (existsSync(target)) rmSync(target) }
    else flushCopy(regularUpdateFile(join(t.stageRoot, 'backup'), fact.path), target)
  }
  verifyProgram(t, true)
}

export async function runMaintenance(path: string, host: MaintenanceHost): Promise<RecoveryState> {
  const t = JSON.parse(readFileSync(path, 'utf8')) as MaintenanceTransaction
  validateLayout(t)
  if (resolve(path) !== resolve(journalPath(t))) throw new Error('UPDATE_TRANSACTION_PATH_INVALID')
  if (['updated', 'rolled-back', 'recovery-failed'].includes(t.state)) {
    const result = recoveryView(t, t.state as RecoveryState['state'])
    writeRecoveryState(t.userData, result)
    return result
  }
  let touched = t.state !== 'prepared'
  let processesStopped = false
  let signedFactsVerified = false
  try {
    validateSignedManifest(t)
    signedFactsVerified = true
    await host.waitStopped(t)
    processesStopped = true
    if (t.state !== 'prepared') throw new Error('UPDATE_INTERRUPTED')
    validateRelease(t)
    t.state = 'applying'; save(t); touched = true
    if (t.manifest.kind === 'full') await host.install(t)
    else {
      for (const file of t.manifest.files) flushCopy(regularUpdateFile(t.payloadRoot, file.path), safeProgramPath(t.programRoot, file.path))
      for (const path of t.manifest.deletions) {
        const target = safeProgramPath(t.programRoot, path)
        if (existsSync(target)) rmSync(target)
      }
    }
    verifyProgram(t, false)
    t.state = 'verifying'; t.detail = 'program hashes verified; awaiting actual Desktop and Runtime health'; save(t)
    await host.launchAndVerify(t, false)
    t.state = 'updated'; t.detail = 'Desktop and bundled Runtime started, versions and controlled echo verified'; save(t)
  } catch (error) {
    const failure = String(error)
    try {
      await host.stopLaunched()
      if (!processesStopped) throw new Error('RECOVERY_PROCESS_STOP_UNCONFIRMED')
      if (!signedFactsVerified) throw new Error('RECOVERY_SIGNED_TRANSACTION_INVALID')
      if (!touched) throw new Error('UPDATE_NOT_APPLIED')
      if (t.state === 'restoring') throw new Error('RECOVERY_INTERRUPTED_MANUAL_REPAIR')
      t.state = 'restoring'; t.detail = failure; save(t)
      restore(t)
      await host.launchAndVerify(t, true)
      t.state = 'rolled-back'; t.detail = 'Previous program hashes, Desktop and Runtime startup verified after ' + failure + '. Automatic updates paused; run manual repair before retrying.'; save(t)
    } catch (recoveryError) {
      let stopFailure = ''
      try { await host.stopLaunched() } catch (error) { stopFailure = '; process stop unconfirmed: ' + String(error) }
      t.state = 'recovery-failed'; t.detail = 'Automatic updates disabled. Preserve data and backup; run manual repair. ' + failure + '; ' + String(recoveryError)
      t.detail += stopFailure
      save(t)
    }
  }
  const result = recoveryView(t, t.state as RecoveryState['state'])
  writeRecoveryState(t.userData, result)
  return result
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
/** Snapshot all owned descendants while task admission is fenced. */
export function captureOwnedProcessTree(pid: number): number[] {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1) throw new Error('UPDATE_PROCESS_INVENTORY_UNAVAILABLE')
  const script = `$ErrorActionPreference='Stop'; $rows=Get-CimInstance Win32_Process; ` +
    `$queue=New-Object 'System.Collections.Generic.List[int]'; $queue.Add(${pid}); ` +
    `$seen=New-Object 'System.Collections.Generic.HashSet[int]'; ` +
    `for($i=0;$i -lt $queue.Count;$i++){ foreach($row in $rows){ if([int]$row.ParentProcessId -eq $queue[$i] -and $seen.Add([int]$row.ProcessId)){ $queue.Add([int]$row.ProcessId) } } }; ` +
    `ConvertTo-Json -Compress -InputObject @($seen | ForEach-Object { [int]$_ })`
  const result = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
  if (result.status !== 0 || result.error) throw new Error('UPDATE_PROCESS_INVENTORY_UNAVAILABLE')
  let value: unknown
  try { value = JSON.parse(result.stdout) } catch { throw new Error('UPDATE_PROCESS_INVENTORY_UNAVAILABLE') }
  if (!Array.isArray(value) || value.length > 2000 || value.some(p => !Number.isSafeInteger(p) || p < 1)) throw new Error('UPDATE_PROCESS_INVENTORY_UNAVAILABLE')
  return value
}
export const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The helper executable is a private copy, never a file held open in the installation. */
export async function launchMaintenance(path: string, helperScript: string): Promise<void> {
  const t = JSON.parse(readFileSync(path, 'utf8')) as MaintenanceTransaction
  validateLayout(t)
  const helperRoot = join(t.stageRoot, 'helper')
  const readyPath = join(t.stageRoot, 'helper-ready.json')
  if (existsSync(readyPath)) {
    const ready = JSON.parse(readFileSync(readyPath, 'utf8'))
    if (processAlive(ready.pid)) return
    rmSync(readyPath)
  }
  if (!existsSync(helperRoot)) {
    mkdirSync(helperRoot, { recursive: false })
    for (const entry of readdirSync(t.programRoot)) {
      const source = safeProgramPath(t.programRoot, entry)
      if (lstatSync(source).isFile() && !/^uninstall/i.test(entry)) flushCopy(source, safeProgramPath(helperRoot, entry))
    }
    const script = openSync(join(helperRoot, 'update-helper.cjs'), 'wx', 0o600)
    try { writeFileSync(script, readBundledFile(helperScript)); fsyncSync(script) } finally { closeSync(script) }
    durableJSON(join(helperRoot, 'files.json'), inventory(helperRoot).map(path => ({ path, sha256: sha256File(safeProgramPath(helperRoot, path)) })))
  }
  const helperFiles = JSON.parse(readFileSync(safeProgramPath(helperRoot, 'files.json'), 'utf8')) as { path: string; sha256: string }[]
  for (const file of helperFiles) if (sha256File(safeProgramPath(helperRoot, file.path)) !== file.sha256) throw new Error('UPDATE_HELPER_INTEGRITY_FAILED')
  const child = spawn(join(helperRoot, basename(t.executable)), [join(helperRoot, 'update-helper.cjs'), path], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, windowsHide: true, stdio: 'ignore', shell: false })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(t.stageRoot, 'helper-ready.json'))) return
    if (!child.pid || !processAlive(child.pid)) break
    await pause(100)
  }
  throw new Error('UPDATE_HELPER_START_UNCONFIRMED')
}
