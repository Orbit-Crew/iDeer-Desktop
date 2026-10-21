import type { ReceiptHistory } from '../../../shared/desktop'

/** Ownership revisions prevent a late request from restoring a prior account. */
export class ReceiptHistoryCache {
  private scope = ''
  private revision = 0
  private value: ReceiptHistory | null = null
  setScope(scope: string): void {
    if (scope === this.scope) return
    this.scope = scope
    this.revision++
    this.value = null
  }
  request(): { scope: string; revision: number } { return { scope: this.scope, revision: this.revision } }
  accept(ticket: { scope: string; revision: number }, value: ReceiptHistory): boolean {
    if (!this.scope || ticket.scope !== this.scope || ticket.revision !== this.revision) return false
    this.value = value
    return true
  }
  read(scope: string): ReceiptHistory | null { return scope && scope === this.scope ? this.value : null }
}
