import type { AgentTerminalEntryView, AgentTerminalHistoryView, DesktopBridge, DesktopStatus } from '../../../shared/desktop'

export interface AgentTerminalView {
  status: DesktopStatus | null
  /** The history read merged with the snapshot's live running tails. */
  commands: AgentTerminalEntryView[]
  failed: boolean
}

export const emptyAgentTerminalView = (): AgentTerminalView => ({ status: null, commands: [], failed: false })

/**
 * Issue 111: one controller per pane instance. Every refresh reads the
 * status snapshot (honest runtime state + in-flight tails) and the identity's
 * own history read; the running rows from the snapshot overlay the history's
 * stale tails by task id, so the pane never renders a tail newer than the
 * process it belongs to and never invents a command the Runtime did not
 * record. Responses belong to one current user operation via generations,
 * like every other device surface.
 */
export class AgentTerminalController {
  private generation = 0
  private sequence = 0
  private activeRefresh: number | null = null
  private view = emptyAgentTerminalView()
  constructor(
    private readonly api: Pick<DesktopBridge, 'getStatus' | 'terminalHistory' | 'terminalStop'>,
    private readonly publish: (view: AgentTerminalView) => void
  ) {}
  snapshot(): AgentTerminalView { return this.view }
  private update(change: Partial<AgentTerminalView>): void {
    this.view = { ...this.view, ...change }
    this.publish(this.view)
  }
  invalidate(): void { this.generation++; this.activeRefresh = null }
  /** The snapshot's in-flight rows overlay the history's tails by task id. */
  private merge(history: AgentTerminalHistoryView, running: AgentTerminalEntryView[]): AgentTerminalEntryView[] {
    const runningById = new Map(running.map((row) => [row.taskId, row]))
    const merged = history.commands.map((row) => runningById.get(row.taskId) ?? row)
    const known = new Set(merged.map((row) => row.taskId))
    // A row that is running but not yet in the history read (admitted between
    // the two reads) still shows, exactly as recorded.
    for (const row of running) {
      if (!known.has(row.taskId)) merged.push(row)
    }
    return merged
  }
  async refresh(): Promise<void> {
    if (this.activeRefresh !== null) return
    const sequence = ++this.sequence
    this.activeRefresh = sequence
    const generation = this.generation
    try {
      const status = await this.api.getStatus()
      if (generation !== this.generation) return
      const runtimeRunning = status.runtime.process === 'running'
      if (!runtimeRunning) {
        this.update({ status, commands: [], failed: false })
        return
      }
      const history = await this.api.terminalHistory()
      if (generation !== this.generation || this.activeRefresh !== sequence) return
      this.update({ status, commands: this.merge(history, status.runtime.agentTerminal?.running ?? []), failed: false })
    } catch {
      if (generation === this.generation) this.update({ failed: true })
    } finally {
      if (this.activeRefresh === sequence) this.activeRefresh = null
    }
  }
  /** A stop is a request; the refresh afterwards records the honest state. */
  async stop(runId: string): Promise<void> {
    await this.api.terminalStop(runId)
    await this.refresh()
  }
}
