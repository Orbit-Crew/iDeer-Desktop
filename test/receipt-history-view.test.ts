import { describe, expect, it } from 'vitest'
import { ReceiptHistoryCache } from '../src/renderer/src/stores/receiptHistory'
import type { ReceiptHistory } from '../src/shared/desktop'

const records: ReceiptHistory = { total: 1, pending: 1, confirmed: 0, uncertain: 0, cleaned: 0, storageError: '', rows: [] }
describe('receipt history identity transitions', () => {
  it('drops old-account data and in-flight responses on account change or Runtime stop', () => {
    const cache = new ReceiptHistoryCache()
    cache.setScope('A')
    const a = cache.request()
    expect(cache.accept(a, records)).toBe(true)
    expect(cache.read('A')).toEqual(records)
    cache.setScope('B')
    expect(cache.read('B')).toBeNull()
    expect(cache.accept(a, records)).toBe(false)
    const b = cache.request()
    expect(cache.accept(b, { ...records, total: 2 })).toBe(true)
    cache.setScope('')
    expect(cache.read('B')).toBeNull()
    expect(cache.accept(b, records)).toBe(false)
    cache.setScope('A')
    expect(cache.accept(a, records)).toBe(false)
  })
})
