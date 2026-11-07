// Issue 116: the field pane's software 2D canvas — no WebGL anywhere. It
// draws exactly the primitives the pure model composed (depth-sorted
// scalar-colored quads, per-edge scalar-colored wireframe segments,
// per-point squares) with drag-to-rotate and wheel zoom; the guarded read
// seam and the pane own everything else. No bridge surface here. The same
// software-canvas idiom is used by the CAD viewer under review in #151.
import { memo, useCallback, useEffect, useRef } from 'react'
import {
  composeFieldPrimitives, type FieldCam, type FieldGeometry,
  type FieldRepresentation
} from './fieldCanvasModel'

interface Props {
  geom: FieldGeometry
  representation: FieldRepresentation
}

export default memo(function FieldCanvasView({ geom, representation }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const camRef = useRef<FieldCam>({ yaw: -0.6, pitch: 0.45, zoom: 1 })

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

    const prim = composeFieldPrimitives(geom, camRef.current, { width: W, height: H }, representation)
    if (prim.overCap || prim.overCapPoints) return // 窗格已如实说明；画布保持空场不画假数据

    ctx.lineWidth = Math.max(1, dpr * 0.7)
    for (const seg of prim.segments) {
      ctx.strokeStyle = seg.color
      ctx.beginPath()
      ctx.moveTo(seg.pts[0][0] * dpr, seg.pts[0][1] * dpr)
      for (let k = 1; k < seg.pts.length; k += 1) {
        ctx.lineTo(seg.pts[k][0] * dpr, seg.pts[k][1] * dpr)
      }
      ctx.closePath()
      ctx.stroke()
    }
    for (const quad of prim.quads) {
      ctx.fillStyle = quad.color
      ctx.beginPath()
      ctx.moveTo(quad.pts[0][0] * dpr, quad.pts[0][1] * dpr)
      for (let k = 1; k < quad.pts.length; k += 1) {
        ctx.lineTo(quad.pts[k][0] * dpr, quad.pts[k][1] * dpr)
      }
      ctx.closePath()
      ctx.fill()
    }
    ctx.fillStyle = '#9cc6ff'
    for (const pt of prim.points) {
      ctx.fillStyle = pt.color
      ctx.fillRect(pt.x * dpr - 1.5, pt.y * dpr - 1.5, 3, 3)
    }
  }, [geom, representation])

  // 挂载与尺寸变化时重绘。
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(wrap)
    draw()
    return () => ro.disconnect()
  }, [draw])

  // 拖拽旋转、滚轮缩放（与 CAD 软件引擎同一交互惯用法）。
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
        aria-label="仿真结果画布"
      />
    </div>
  )
})
