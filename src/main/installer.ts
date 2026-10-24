// Issue 108: the single user update entry. A verified pending update (issue
// 107) can only be installed through this drain-and-install coordinator:
// explicit confirmation, stop admitting new tasks, wait for in-flight tasks
// to reach their terminal state (timeouts are never treated as drained),
// verify durable local records, stop the owned Runtime process, apply the
// staged payload, and restart. Every refusal keeps the pending state and the
// unconfirmed records intact.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { InstallOutcome, UpdateCheckResult } from '../shared/desktop'
import type { PendingUpdate } from './updates'

export interface DrainView { installDrain?: boolean; activeTasks?: number; receiptStorageError?: string; process?: string }

export interface InstallDeps {
  status(): DrainView
  drain(action: 'begin' | 'abort'): Promise<void>
  confirm(pending: PendingUpdate): Promise<boolean>
  apply(files: { path: string; sha256: string; bytes: number }[], deletions: string[]): Promise<void>
  launch(installerPath?: string): Promise<void>
  quit(): Promise<void>
}

export const DRAIN_DEADLINE_MS = 90000
const STOP_SETTLE_MS = 1500

export function planDrain(status: DrainView): 'ready' | 'draining' | 'blocked' {
  if (status.receiptStorageError) return 'blocked'
  if ((status.activeTasks ?? 0) > 0) return 'draining'
  return 'ready'
}

/** A resolved target stays inside its base on every platform. */
export function contained(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Apply a verified patch payload into the program directory. */
export async function applyPatch(pending: PendingUpdate, payloadRoot: string,
    programRoot: string): Promise<void> {
  const manifest = pending.manifest
  // Static hazards (absolute paths, drive letters, dot segments) are already
  // rejected by the manifest parser; these containment checks hold per platform.
  for (const file of manifest.files) {
    const source = resolve(payloadRoot, file.path)
    if (!contained(payloadRoot, source)) throw new Error('UPDATE_PAYLOAD_OUTSIDE_PROGRAM_DIRECTORY')
    if (!existsSync(source) || statSync(source).size !== file.bytes) throw new Error('UPDATE_PAYLOAD_FILE_UNAVAILABLE')
    const digest = createHash('sha256').update(readFileSync(source)).digest('hex')
    if (digest !== file.sha256) throw new Error('UPDATE_PAYLOAD_HASH_MISMATCH')
  }
  mkdirSync(programRoot, { recursive: true })
  for (const file of manifest.files) {
    const target = resolve(programRoot, file.path)
    if (!contained(programRoot, target)) throw new Error('UPDATE_TARGET_OUTSIDE_PROGRAM_DIRECTORY')
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(resolve(payloadRoot, file.path), target)
  }
  for (const deletion of manifest.deletions) {
    const target = resolve(programRoot, deletion)
    if (!contained(programRoot, target)) throw new Error('UPDATE_TARGET_OUTSIDE_PROGRAM_DIRECTORY')
    if (existsSync(target)) unlinkSync(target)
  }
}

export async function requestInstall(pending: PendingUpdate, deps: InstallDeps,
    options: { payloadRoot?: string; programRoot?: string; installerPath?: string; deadlineMs?: number } = {}): Promise<InstallOutcome> {
  if (!(await deps.confirm(pending))) return { installed: false, stage: 'canceled', detail: 'the user did not confirm the installation' }
  try { await deps.drain('begin') } catch (error) {
    return { installed: false, stage: 'failed', detail: 'drain could not start: ' + String(error) }
  }
  const deadline = Date.now() + (options.deadlineMs ?? DRAIN_DEADLINE_MS)
  let last = 'draining'
  while (Date.now() < deadline) {
    last = planDrain(deps.status())
    if (last !== 'draining') break
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 500))
  }
  if (last === 'draining') {
    await deps.drain('abort').catch(() => {})
    // A timeout is never treated as an empty queue.
    return { installed: false, stage: 'blocked', detail: 'in-flight tasks did not reach a terminal state before the deadline' }
  }
  if (last === 'blocked') {
    await deps.drain('abort').catch(() => {})
    return { installed: false, stage: 'blocked', detail: 'local records could not be saved durably; nothing was installed' }
  }
  try {
    if (pending.kind === 'full') {
      if (!options.installerPath) throw new Error('UPDATE_FULL_INSTALLER_UNAVAILABLE')
      await deps.launch(options.installerPath)
    } else {
      if (!options.payloadRoot || !options.programRoot) throw new Error('UPDATE_PATCH_ROOTS_UNAVAILABLE')
      await deps.apply(pending.manifest.files, pending.manifest.deletions)
    }
  } catch (error) {
    await deps.drain('abort').catch(() => {})
    return { installed: false, stage: 'failed', detail: String(error) }
  }
  // Stop the owned process only after the drained queue and durable records
  // are facts; a crash here leaves the old installation intact.
  await new Promise(settle => setTimeout(settle, STOP_SETTLE_MS))
  if (deps.status().process !== 'stopped') await deps.quit()
  return { installed: true, stage: pending.kind === 'full' ? 'launched' : 'applied', detail: 'drain completed and the update was staged; restart verifies the new combination' }
}

export function readPending(raw: unknown): UpdateCheckResult['pending'] {
  return raw as UpdateCheckResult['pending']
}

export const hashFileForTest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
export const removeTreeForTest = (path: string): void => rmSync(path, { recursive: true, force: true })
export const joinPath = join
