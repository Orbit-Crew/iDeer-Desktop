// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { describeDocumentParse } from '../src/renderer/src/components/RuntimePanel'
import type { KnowledgeImportDocumentParseView } from '../src/shared/desktop'

const parsed = (overrides: Partial<KnowledgeImportDocumentParseView> = {}): KnowledgeImportDocumentParseView =>
  ({ status: 'parsed', parser: 'pypdf', parserVersion: '5.1.0', pages: 3, tables: 0, truncated: false, errorCode: '', ...overrides })

describe('issue 81 import document parse display', () => {
  it('describes a parsed document with its parser identity and page/table counts', () => {
    expect(describeDocumentParse(parsed())).toBe('已解析：pypdf 5.1.0（3 页）')
    expect(describeDocumentParse(parsed({ parser: 'xlsx-ooxml', parserVersion: '1', pages: 0, tables: 2 })))
      .toBe('已解析：xlsx-ooxml 1（2 表）')
    expect(describeDocumentParse(parsed({ pages: 0, tables: 0 }))).toBe('已解析：pypdf 5.1.0')
    expect(describeDocumentParse(parsed({ truncated: true }))).toBe('已解析：pypdf 5.1.0（3 页）（文本已截断）')
  })

  it('reports skipped and failed records with their honest reason codes', () => {
    expect(describeDocumentParse(parsed({
      status: 'skipped', parser: '', parserVersion: '', pages: 0, errorCode: 'PARSE_FORMAT_UNSUPPORTED' })))
      .toBe('设备侧未解析（PARSE_FORMAT_UNSUPPORTED）')
    expect(describeDocumentParse(parsed({
      status: 'failed', parser: '', parserVersion: '', pages: 0, errorCode: 'PARSE_PDF_CORRUPT' })))
      .toBe('解析失败（PARSE_PDF_CORRUPT）')
  })

  it('renders nothing for records that predate the parse engine', () => {
    expect(describeDocumentParse(undefined)).toBe('')
  })
})
