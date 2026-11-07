// Issue 115: the CAD pane's WebGL engine (three.js over the converted mesh).
// Data arrives as one {positions, indices} payload from the trusted channel;
// this component renders it, orbits it, and disposes every GPU resource it
// created — nothing else. The RAF loop is visibility-gated so a dock-hidden
// pane stops drawing, and a failed context creation surfaces through `onFail`
// so the pane can fall back to its software 2D engine honestly.
import { memo, useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export type CadRepresentation = 'surface' | 'wireframe' | 'points'

interface Props {
  positions: Float32Array
  indices: Uint32Array
  representation: CadRepresentation
  /** WebGL context creation failure — the parent switches to the 2D engine. */
  onFail?: () => void
}

// GPU buffers are not reclaimed by scene.remove alone; release them here.
function disposeObject3D(obj: THREE.Object3D): void {
  const geo = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
  if (geo) geo.dispose()
  const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
  if (mat) {
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
    else mat.dispose()
  }
}

export default memo(function ThreeMeshViewer({ positions, indices, representation, onFail }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const objectsRef = useRef<THREE.Object3D[]>([])
  const onFailRef = useRef(onFail)
  onFailRef.current = onFail
  const repRef = useRef(representation)
  repRef.current = representation

  // Renderer / scene / camera / controls are created once per mount.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false })
    } catch {
      onFailRef.current?.()
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(wrap.clientWidth, wrap.clientHeight)
    wrap.appendChild(renderer.domElement)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x171a22)
    sceneRef.current = scene
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dir = new THREE.DirectionalLight(0xffffff, 0.9)
    dir.position.set(1, 1, 1)
    scene.add(dir)

    const camera = new THREE.PerspectiveCamera(50, wrap.clientWidth / Math.max(1, wrap.clientHeight), 0.01, 1e6)
    cameraRef.current = camera

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controlsRef.current = controls

    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(wrap)

    // The RAF loop stops while the pane is dock-hidden (display:none / 0×0)
    // and restarts when it becomes visible again.
    let raf = 0
    let visible = false
    const loop = (): void => {
      if (!visible) return
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(loop)
    }
    const kick = (): void => {
      if (raf) return
      raf = requestAnimationFrame(loop)
    }
    const stop = (): void => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        const next = entry.isIntersecting && entry.intersectionRatio > 0
        if (next === visible) return
        visible = next
        if (visible) kick()
        else stop()
      },
      { threshold: [0, 0.0001] }
    )
    io.observe(wrap)
    if (wrap.clientWidth > 0 && wrap.clientHeight > 0) {
      visible = true
      kick()
    }

    return () => {
      stop()
      io.disconnect()
      ro.disconnect()
      controls.dispose()
      objectsRef.current.forEach((o) => {
        disposeObject3D(o)
        scene.remove(o)
      })
      objectsRef.current = []
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
      rendererRef.current = null
      sceneRef.current = null
      cameraRef.current = null
      controlsRef.current = null
    }
  }, [])

  // Rebuild geometry (and refit the camera) on new data or representation.
  useEffect(() => {
    const scene = sceneRef.current
    const renderer = rendererRef.current
    if (!scene || !renderer) return
    objectsRef.current.forEach((o) => {
      disposeObject3D(o)
      scene.remove(o)
    })
    objectsRef.current = []
    if (positions.length < 9 || indices.length < 3) return

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()

    const rep = repRef.current
    let obj: THREE.Object3D
    if (rep === 'points') {
      obj = new THREE.Points(
        geo,
        new THREE.PointsMaterial({ color: 0x9cc6ff, size: 3, sizeAttenuation: false })
      )
    } else {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x8fb6e0,
        wireframe: rep === 'wireframe',
        side: THREE.DoubleSide,
        flatShading: true,
        roughness: 0.7,
        metalness: 0.1
      })
      obj = new THREE.Mesh(geo, mat)
    }
    scene.add(obj)
    objectsRef.current = [obj]

    const camera = cameraRef.current
    const sphere = geo.boundingSphere
    if (camera && sphere) {
      camera.near = Math.max(0.01, sphere.radius * 0.01)
      camera.far = Math.max(100, sphere.radius * 1000)
      camera.updateProjectionMatrix()
      camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + sphere.radius * 2.6)
      camera.lookAt(sphere.center)
      if (controlsRef.current) {
        controlsRef.current.target.copy(sphere.center)
        controlsRef.current.update()
      }
    }
  }, [positions, indices, representation])

  return (
    <div ref={wrapRef} className="w-full h-full overflow-hidden" style={{ background: '#171a22' }} />
  )
})
