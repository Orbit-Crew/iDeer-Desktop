// Issue 116: the Tecplot results pane's reader — a faithful port of the
// original linz `tecplot-reader.ts` (f88141b) for its actually-supported
// subset: structured IJK ASCII (POINT/BLOCK), VARIABLES + ZONE headers.
// Desktop additions, each pinned by test/tecplot-reader.test.ts:
//  - Fortran D-exponents parse to their real value (the original's
//    parseFloat silently truncated `1.0D+03` to `1.0` — a wrong-value fake);
//  - skipped zones (malformed header, out-of-subset FE data, incomplete
//    body, over-cap) are counted in `zonesOmitted` instead of vanishing;
//  - non-finite values are counted in `nonFiniteValues` so the pane can say
//    so instead of faking their magnitude;
//  - fixed caps (MAX_ZONES / zone point cap / variable cap) bound the work
//    the 1 MiB guarded preview can hand us.
export interface TecplotZone {
  name: string
  dims: [number, number, number]
  /** 每个变量的数组，长度 I*J*K，按 i 最快变化（Tecplot 有序 zone 约定） */
  data: number[][]
}

export interface ParsedTecplot {
  variables: string[]
  zones: TecplotZone[]
  /** 被跳过、未渲染的 ZONE 头数量（子集外/残缺/超限），绝不静默 */
  zonesOmitted: number
  /** 数据区里无法用有限数表示的值的个数（NaN/±Inf） */
  nonFiniteValues: number
}

export const MAX_ZONES = 128
export const MAX_ZONE_POINTS = 2_000_000
export const MAX_ZONE_VARIABLES = 64

type TokKind = 'id' | 'str' | 'num' | 'eq' | 'comma' | 'other'
interface Tok {
  kind: TokKind
  value: string
}

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([EeDd][-+]?\d+)?$/

/** Fortran 双精度记数：`1.0D+03` → `1.0E+03`，让 parseFloat 读到真值。 */
function normalizeNumber(raw: string): number {
  return parseFloat(raw.replace(/[Dd]/, 'E'))
}

function tokenize(text: string): Tok[] {
  const toks: Tok[] = []
  const len = text.length
  let i = 0
  while (i < len) {
    const c = text[i]
    if (c === '"' || c === "'") {
      const q = c
      let j = i + 1
      let s = ''
      while (j < len && text[j] !== q) {
        s += text[j]
        j += 1
      }
      toks.push({ kind: 'str', value: s })
      i = j + 1
    } else if (c === '=') {
      toks.push({ kind: 'eq', value: '=' })
      i += 1
    } else if (c === ',') {
      toks.push({ kind: 'comma', value: ',' })
      i += 1
    } else if (/\s/.test(c)) {
      i += 1
    } else if (/\d/.test(c) || (c === '.' && /\d/.test(text[i + 1] ?? '')) || (c === '-' && /\d/.test(text[i + 1] ?? '')) || (c === '+' && /\d/.test(text[i + 1] ?? ''))) {
      let j = i + 1
      while (j < len && !/[\s,="']/.test(text[j])) j += 1
      const word = text.slice(i, j)
      if (NUM_RE.test(word)) toks.push({ kind: 'num', value: word })
      else toks.push({ kind: 'id', value: word })
      i = j
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < len && /[A-Za-z0-9_]/.test(text[j])) j += 1
      toks.push({ kind: 'id', value: text.slice(i, j) })
      i = j
    } else {
      toks.push({ kind: 'other', value: c })
      i += 1
    }
  }
  return toks
}

function parseVariables(toks: Tok[]): string[] {
  const vars: string[] = []
  for (let i = 0; i < toks.length; i += 1) {
    if (toks[i].kind === 'id' && toks[i].value.toUpperCase() === 'VARIABLES') {
      // 收集变量名，直到遇到 ZONE / TITLE / 其它指令
      let j = i + 1
      while (j < toks.length && !(toks[j].kind === 'id' && /^(ZONE|TITLE)$/i.test(toks[j].value))) {
        const t = toks[j]
        if (t.kind === 'str') vars.push(t.value)
        else if (t.kind === 'id') vars.push(t.value)
        else if (t.kind === 'num') vars.push(t.value)
        j += 1
      }
      break
    }
  }
  return vars
}

interface ZoneHeader {
  name: string
  i: number | null
  j: number | null
  k: number | null
  pack: 'POINT' | 'BLOCK'
}

function readZoneHeader(toks: Tok[], start: number): { header: ZoneHeader; dataStart: number } | null {
  const header: ZoneHeader = { name: '', i: null, j: null, k: null, pack: 'POINT' }
  let i = start + 1 // 跳过 'ZONE'
  const skipCommas = (): void => {
    while (toks[i]?.kind === 'comma') i += 1
  }
  skipCommas()
  // 解析属性：id '=' value, 直到不再是属性。F= 与新式 DATAPACKING= 同义。
  while (i < toks.length) {
    const t = toks[i]
    if (t.kind !== 'id' || toks[i + 1]?.kind !== 'eq') break
    const key = t.value.toUpperCase()
    const valTok = toks[i + 2]
    if (valTok) {
      const raw = valTok.value
      if (key === 'T' || key === 'TITLE') header.name = raw
      else if (key === 'I') header.i = parseInt(raw, 10) || null
      else if (key === 'J') header.j = parseInt(raw, 10) || null
      else if (key === 'K') header.k = parseInt(raw, 10) || null
      else if (key === 'F' || key === 'DATAPACKING') header.pack = raw.toUpperCase() === 'BLOCK' ? 'BLOCK' : 'POINT'
    }
    i += 3
    skipCommas()
  }
  if (toks[i]?.kind !== 'num') return null
  return { header, dataStart: i }
}

export function parseTecplotAscii(text: string): ParsedTecplot {
  const toks = tokenize(text)
  const variables = parseVariables(toks)
  const zones: TecplotZone[] = []
  let zonesOmitted = 0
  let nonFiniteValues = 0

  for (let i = 0; i < toks.length; i += 1) {
    if (toks[i].kind === 'id' && toks[i].value.toUpperCase() === 'ZONE') {
      if (zones.length >= MAX_ZONES) {
        // 到达显示上限：数清剩余 ZONE 头，如实上报，绝不静默丢弃。
        for (let r = i; r < toks.length; r += 1) {
          if (toks[r].kind === 'id' && toks[r].value.toUpperCase() === 'ZONE') zonesOmitted += 1
        }
        break
      }
      const parsed = readZoneHeader(toks, i)
      if (!parsed) {
        zonesOmitted += 1
        continue
      }
      const { header, dataStart } = parsed
      if (!header.i || !header.j || header.i < 1 || header.j < 1) {
        zonesOmitted += 1
        continue
      }
      const I = header.i
      const J = header.j
      const K = header.k && header.k >= 1 ? header.k : 1
      const N = I * J * K
      const nv = variables.length
      if (nv < 1 || nv > MAX_ZONE_VARIABLES || N > MAX_ZONE_POINTS) {
        zonesOmitted += 1
        continue
      }

      // 收集数据（遇到下一个 ZONE 结束）
      let dataEnd = toks.length
      for (let d = dataStart; d < toks.length; d += 1) {
        if (toks[d].kind === 'id' && toks[d].value.toUpperCase() === 'ZONE') {
          dataEnd = d
          break
        }
      }
      const numToks = toks.slice(dataStart, dataEnd).filter((t) => t.kind === 'num')
      if (numToks.length < N * nv) {
        zonesOmitted += 1
        continue
      }

      const data: number[][] = variables.map(() => new Array<number>(N))
      if (header.pack === 'BLOCK') {
        for (let v = 0; v < nv; v += 1) {
          for (let n = 0; n < N; n += 1) {
            data[v][n] = normalizeNumber(numToks[v * N + n].value)
          }
        }
      } else {
        // POINT：逐点读取 nv 个值
        for (let n = 0; n < N; n += 1) {
          for (let v = 0; v < nv; v += 1) {
            data[v][n] = normalizeNumber(numToks[n * nv + v].value)
          }
        }
      }
      for (const column of data) {
        for (const value of column) {
          if (!Number.isFinite(value)) nonFiniteValues += 1
        }
      }

      zones.push({ name: header.name || `zone-${zones.length + 1}`, dims: [I, J, K], data })
    }
  }

  return { variables, zones, zonesOmitted, nonFiniteValues }
}
