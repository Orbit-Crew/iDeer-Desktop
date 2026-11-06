/**
 * Issue 86: the window lifecycle's decision layer, extracted from the main
 * wiring so both exit paths are testable without spawning Electron.
 *
 * Two decisions live here:
 *  - whether a window close means "hide to tray" (the resident default) or
 *    belongs to a real exit;
 *  - the true-exit drain: stop admitting new tasks on the owned Runtime,
 *    wait for the same safe-stop predicate the installer uses
 *    (`planDrain`: drain on, zero in-flight tasks, zero unknown write
 *    effects, no receipt storage failure), bounded in time, with the
 *    existing `installDrain('abort')` as the honest way out. The final
 *    teardown itself stays the existing `before-quit` path; nothing here
 *    stops the Runtime or quits by itself.
 *
 * Everything is Electron-free; the main process injects `runtime.status`,
 * `runtime.installDrain`, timers.
 */
import { planDrain, type DrainView } from './installer'

export type ExitDrainOutcome = 'drained' | 'timeout' | 'blocked' | 'unavailable'

export interface ExitDrainDeps {
  status(): DrainView
  drain(action: 'begin' | 'abort'): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
}

/** Same bound as the installer drain (`DRAIN_DEADLINE_MS`): a timeout is
 * never treated as an empty queue, here it becomes an honest abort + note. */
export const EXIT_DRAIN_DEADLINE_MS = 90000
export const EXIT_DRAIN_POLL_MS = 500

/** The one honest sentence per non-drained outcome, surfaced to the user on
 * the OS toast before the existing teardown runs. */
export const EXIT_DRAIN_NOTES: Record<Exclude<ExitDrainOutcome, 'drained'>, string> = {
  timeout: '在途任务未能在期限内全部结束，已停止等待并退出；未确认回执保留。',
  blocked: '存在未知写入效果或记录保存失败，已中止排空并退出；未确认回执保留。',
  unavailable: 'Runtime 未运行或已停止，未执行排空即退出。'
}

/** A window close starts the true exit exactly when 关窗即退出 is set and the
 * close is not one of the teardown's own closes (or a repeat during an
 * in-flight exit). Every other non-teardown close is absorbed: hidden to the
 * tray, Runtime untouched. */
export function shouldExitOnClose(closeToTray: boolean, exiting: boolean): boolean {
  return !closeToTray && !exiting
}

/** Whether a close is intercepted at all (absorbed into the tray, or turned
 * into an exit by `shouldExitOnClose`). The update-maintenance helper
 * instance is never intercepted: it carries no tray icon, so a hidden window
 * there would be unrestorable — its close takes the natural path (real
 * destroy → `window-all-closed` → the existing teardown), and the teardown's
 * own closes pass through as before. */
export function shouldInterceptClose(maintenance: boolean, quitting: boolean): boolean {
  return !maintenance && !quitting
}

/** The true-exit drain. Begins the install-grade drain, polls the shared
 * safe-stop predicate until it holds or the deadline passes, and aborts the
 * drain on every non-drained outcome. Never quits and never stops the
 * Runtime process — the caller hands over to the existing teardown. */
export async function drainForExit(deps: ExitDrainDeps,
    options: { deadlineMs?: number; pollMs?: number } = {}): Promise<ExitDrainOutcome> {
  // Not running (or still starting): nothing can be drained; the teardown's
  // own `runtime.stop()` already treats a missing child as a no-op.
  if (deps.status().process !== 'running') return 'drained'
  try {
    await deps.drain('begin')
  } catch {
    return 'unavailable'
  }
  const deadline = deps.now() + (options.deadlineMs ?? EXIT_DRAIN_DEADLINE_MS)
  for (;;) {
    // A Runtime that died mid-drain can never reach the safe-stop predicate;
    // waiting out the whole deadline for it would just be a lie with delay.
    const current = deps.status()
    if (current.process === 'stopped' || current.process === 'crashed') return 'unavailable'
    const state = planDrain(current)
    if (state === 'ready') return 'drained'
    if (state === 'blocked') {
      await deps.drain('abort').catch(() => {})
      return 'blocked'
    }
    if (deps.now() >= deadline) {
      await deps.drain('abort').catch(() => {})
      return 'timeout'
    }
    await deps.sleep(options.pollMs ?? EXIT_DRAIN_POLL_MS)
  }
}
