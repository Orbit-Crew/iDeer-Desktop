import type { DesktopBridge, DesktopStatus, ReceiptHistory } from '../../../shared/desktop'
import { ReceiptHistoryCache } from './receiptHistory'

export interface RuntimePanelView {
  status: DesktopStatus | null
  history: ReceiptHistory | null
  failed: boolean
  historyError: boolean
  clearing: boolean
}
export const emptyRuntimePanelView = (): RuntimePanelView => ({ status: null, history: null, failed: false, historyError: false, clearing: false })

/** Every status and history response belongs to one current user operation. */
export class RuntimePanelController {
  private generation = 0
  private sequence = 0
  private activeRefresh: number | null = null
  private stopping = false
  private scope = ''
  private history = new ReceiptHistoryCache()
  private view = emptyRuntimePanelView()
  constructor(private readonly api: Pick<DesktopBridge, 'getStatus' | 'receipts' | 'stopRuntime'>, private readonly publish: (view: RuntimePanelView) => void) {}
  snapshot(): RuntimePanelView { return this.view }
  private update(change: Partial<RuntimePanelView>): void { this.view = { ...this.view, ...change }; this.publish(this.view) }
  invalidate(): void { this.generation++; this.activeRefresh = null }
  private applyStatus(status: DesktopStatus, generation: number): number | null {
    if (generation !== this.generation) return null
    const scope = status.runtime.process === 'running' ? status.runtime.receiptScope || '' : ''
    if (scope !== this.scope) {
      this.scope = scope
      this.history.setScope(scope)
      this.generation++
      this.view = { ...this.view, historyError: false, clearing: false }
    }
    this.update({ status, history: this.history.read(scope), failed: false })
    return this.generation
  }
  private failHistory(generation: number): void {
    if (generation !== this.generation) return
    this.invalidate()
    this.scope = ''
    this.history.setScope('')
    this.update({ status: null, history: null, historyError: true, clearing: false })
  }
  async refresh(offset: number): Promise<void> {
    if (this.activeRefresh !== null || this.stopping) return
    const sequence = ++this.sequence
    this.activeRefresh = sequence
    let generation = this.generation
    try {
      const status = await this.api.getStatus()
      const currentGeneration = this.applyStatus(status, generation)
      if (currentGeneration === null) return
      generation = currentGeneration
      if (!this.scope) return
      const ticket = this.history.request()
      try {
        const records = await this.api.receipts('history', offset)
        if (generation !== this.generation) return
        const current = await this.api.getStatus()
        const currentGeneration = this.applyStatus(current, generation)
        if (currentGeneration === null) return
        generation = currentGeneration
        if (this.history.accept(ticket, records)) this.update({ history: records, historyError: false })
      } catch { this.failHistory(generation) }
    } catch {
      if (generation === this.generation) { this.failHistory(generation); this.update({ failed: true }) }
    } finally { if (this.activeRefresh === sequence) this.activeRefresh = null }
  }
  async stop(): Promise<void> {
    this.invalidate()
    const generation = this.generation
    this.stopping = true
    this.scope = ''
    this.history.setScope('')
    const status = this.view.status
    this.update({ history: null, clearing: false, status: status ? { ...status, server: 'offline', runtime: { ...status.runtime, process: 'stopping', connection: 'offline', tasks: [], receiptScope: '' } } : null })
    try {
      await this.api.stopRuntime()
      if (generation === this.generation && this.view.status) this.update({ status: { ...this.view.status, runtime: { ...this.view.status.runtime, process: 'stopped' } } })
    } catch { if (generation === this.generation) this.update({ failed: true }) }
    finally { this.stopping = false }
  }
  async clearConfirmed(offset: number): Promise<void> {
    this.invalidate()
    let generation = this.generation
    const ticket = this.history.request()
    this.update({ clearing: true })
    try {
      const records = await this.api.receipts('clear-confirmed', offset)
      if (generation !== this.generation) return
      // Fence any refresh that began while the native dialog was open.
      this.invalidate()
      generation = this.generation
      const current = await this.api.getStatus()
      const currentGeneration = this.applyStatus(current, generation)
      if (currentGeneration === null) return
      generation = currentGeneration
      if (this.history.accept(ticket, records)) this.update({ history: records, historyError: false })
    } catch { this.failHistory(generation) }
    finally { if (generation === this.generation) this.update({ clearing: false }) }
  }
}
