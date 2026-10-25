// Issue 108: the single user update entry. A verified pending update (issue
// 107) can only be installed through this drain-and-install coordinator:
// explicit confirmation, stop admitting new tasks, wait for in-flight tasks
// to reach their terminal state (timeouts are never treated as drained),
// verify durable local records, stop the owned Runtime process, apply the
// staged payload, and restart. Every refusal keeps the pending state and the
// unconfirmed records intact.
import type { InstallOutcome } from '../shared/desktop'
import type { PendingUpdate } from './updates'

export interface DrainView { installDrain?: boolean; activeTasks?: number; unknownWriteEffects?: number; receiptStorageError?: string; process?: string }

export interface InstallDeps {
  status(): DrainView
  drain(action: 'begin' | 'abort'): Promise<void>
  confirm(pending: PendingUpdate): Promise<boolean>
  stop(): Promise<void>
  handoff(): Promise<void>
  quit(): Promise<void>
}

export const DRAIN_DEADLINE_MS = 90000

export function planDrain(status: DrainView): 'ready' | 'draining' | 'blocked' {
  if (status.receiptStorageError) return 'blocked'
  if (status.process !== 'running' || status.installDrain !== true || !Number.isSafeInteger(status.activeTasks) ||
      !Number.isSafeInteger(status.unknownWriteEffects)) return 'draining'
  if ((status.activeTasks ?? 0) > 0) return 'draining'
  if ((status.unknownWriteEffects ?? 0) > 0) return 'blocked'
  return 'ready'
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
    return { installed: false, stage: 'blocked', detail: 'local records could not be saved durably or write effects remain unknown; nothing was installed' }
  }
  try {
    await deps.stop()
    if (deps.status().process !== 'stopped') throw new Error('RUNTIME_STOP_UNCONFIRMED')
  } catch (error) {
    await deps.drain('abort').catch(() => {})
    return { installed: false, stage: 'blocked', detail: String(error) }
  }
  try { await deps.handoff(); await deps.quit() } catch (error) {
    return { installed: false, stage: 'failed', detail: String(error) }
  }
  return { installed: false, stage: 'launched', detail: 'maintenance started; actual Desktop and Runtime startup must verify the update' }
}
