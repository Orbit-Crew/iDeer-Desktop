// Issue 115: the CAD pane's software 2D engine — no WebGL anywhere. When the
// three.js context cannot be created (or the user picks it explicitly), the
// same {positions, indices} payload draws on a plain canvas 2D: orthographic
// projection, back-to-front triangle sort, flat shading, drag-to-rotate and
// wheel zoom. It renders exactly the geometry it was given — no simplification,
// no silent substitution.
import { memo, useCallback, useEffect, useRef } from 'react'
import type { CadRepresentation } from './ThreeMeshViewer'

interface Props {
  positions: Float32Array
  indices: Uint32Array
  representation: CadRepresentation
}

interface Cam { yaw: number; pitch: number; zoom: number }

export default memo(function MeshCanvasViewer({ positions, indices, representation }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const camRef = useRef<Cam>({ yaw: -0.6, pitch: 0.45, zoom: 1 })

  const draw = useCallback(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const W = wrap.clientWidth
    const H = wrap.clientHeight
    if (!W || !H) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(W * dpr)
    canvas.height = Math.floor(H * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#171a22'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const n = Math.floor(positions.length / 3)
    if (n < 3) return

    // Bounding sphere center + radius.
    let cx = 0
    let cy = 0
    let cz = 0
    for (let i = 0; i < n; i += 1) {
      cx += positions[i * 3]
      cy += positions[i * 3 + 1]
      cz += positions[i * 3 + 2]
    }
    cx /= n
    cy /= n
    cz /= n
    let rad = 0
    for (let i = 0; i < n; i += 1) {
      const dx = positions[i * 3] - cx
      const dy = positions[i * 3 + 1] - cy
      const dz = positions[i * 3 + 2] - cz
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d > rad) rad = d
    }
    if (rad <= 0) return
    const scale = ((Math.min(W, H) / 2) / rad) * camRef.current.zoom

    const { yaw, pitch } = camRef.current
    const cya = Math.cos(yaw)
    const sya = Math.sin(yaw)
    const cpi = Math.cos(pitch)
    const spi = Math.sin(pitch)

    // Rotate vertices into view space + orthographic projection.
    const vz = new Float64Array(n)
    const sx = new Float64Array(n)
    const sy = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      const x = positions[i * 3] - cx
      const y = positions[i * 3 + 1] - cy
      const z = positions[i * 3 + 2] - cz
      const x1 = x * cya + z * sya
      const z1 = -x * sya + z * cya
      const y2 = y * cpi - z1 * spi
      const z2 = y * spi + z1 * cpi
      vz[i] = z2
      sx[i] = W / 2 + x1 * scale
      sy[i] = H / 2 - y2 * scale
    }

    const triCount = Math.floor(indices.length / 3)
    // Headlight in view space.
    const L = Math.sqrt(0.4 * 0.4 + 0.5 * 0.5 + 0.75 * 0.75)
    const lnx = 0.4 / L
    const lny = 0.5 / L

    const tris: Array<{ depth: number; pts: number[][]; shade: number }> = []
    for (let t = 0; t < triCount; t += 1) {
      const a = indices[t * 3]
      const b = indices[t * 3 + 1]
      const c = indices[t * 3 + 2]
      if (a >= n || b >= n || c >= n) continue
      const e1sx = sx[b] - sx[a]
      const e1sy = sy[b] - sy[a]
      const e2sx = sx[c] - sx[a]
      const e2sy = sy[c] - sy[a]
      const facing = e1sx * e2sy - e1sy * e2sx
      const depth = (vz[a] + vz[b] + vz[c]) / 3
      const screenNx = -e1sy
      const screenNy = e1sx
      const nl = Math.sqrt(screenNx * screenNx + screenNy * screenNy) || 1
      let shade = 0.35 + 0.35 * (screenNx / nl) * lnx + 0.3 * (screenNy / nl) * lny
      shade = Math.max(0.2, Math.min(0.92, shade))
      if (facing < 0) shade *= 0.55
      tris.push({
        depth,
        pts: [
          [sx[a], sy[a]],
          [sx[b], sy[b]],
          [sx[c], sy[c]]
        ],
        shade
      })
    }

    // Back-to-front. 点云只画点，与 three.js 引擎的同一表示法语义一致；
    // 线框/实体照常画三角形。
    tris.sort((p, q) => q.depth - p.depth)

    if (representation !== 'points') {
      for (const t of tris) {
        if (representation === 'surface') {
          const s = t.shade
          const r = 120 + 40 * s
          const g = 150 + 60 * s
          const b = 205 + 35 * s
          ctx.fillStyle = `rgb(${Math.floor(r)},${Math.floor(g)},${Math.floor(b)})`
          ctx.beginPath()
          ctx.moveTo(t.pts[0][0], t.pts[0][1])
          ctx.lineTo(t.pts[1][0], t.pts[1][1])
          ctx.lineTo(t.pts[2][0], t.pts[2][1])
          ctx.closePath()
          ctx.fill()
        } else {
          ctx.strokeStyle = '#7fb3ff'
          ctx.lineWidth = Math.max(1, dpr * 0.7)
          ctx.beginPath()
          ctx.moveTo(t.pts[0][0], t.pts[0][1])
          ctx.lineTo(t.pts[1][0], t.pts[1][1])
          ctx.lineTo(t.pts[2][0], t.pts[2][1])
          ctx.closePath()
          ctx.stroke()
        }
      }
    }
    if (representation === 'points') {
      ctx.fillStyle = '#9cc6ff'
      for (let i = 0; i < n; i += 1) {
        ctx.fillRect(sx[i] - 1.5, sy[i] - 1.5, 3, 3)
      }
    }
  }, [indices, positions, representation])

  // Redraw on mount and on size changes.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(wrap)
    draw()
    return () => ro.disconnect()
  }, [draw])

  // Drag to rotate, wheel to zoom.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let dragging = false
    let lastX = 0
    let lastY = 0
    const onDown = (e: PointerEvent): void => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // 指针捕获失败不影响拖拽
      }
    }
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      const c = camRef.current
      c.yaw -= dx * 0.008
      c.pitch = Math.max(-1.5, Math.min(1.5, c.pitch + dy * 0.008))
      draw()
    }
    const onUp = (): void => {
      dragging = false
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const c = camRef.current
      c.zoom *= e.deltaY < 0 ? 1.08 : 0.92
      c.zoom = Math.max(0.1, Math.min(20, c.zoom))
      draw()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [draw])

  return (
    <div ref={wrapRef} className="w-full h-full relative overflow-hidden" style={{ background: '#171a22' }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing"
      />
    </div>
  )
})
