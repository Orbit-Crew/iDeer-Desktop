// Issue 109: the remote screen's pixel surface. The remote page runs on the
// platform server; this component only draws the JPEG frames it is handed and
// forwards the user's pointer/keyboard gestures upward. It is deliberately
// bridge-free — no preload, no shared bridge types, no embedded content — and
// test/security.test.ts pins that this module's bundle graph stays that way.
import { useRef } from 'react'

export type SurfaceInput =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'down' | 'up' | 'click'; x: number; y: number; button: 'left' | 'right' | 'middle' }
  | { kind: 'wheel'; dx: number; dy: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string }

interface RemoteScreenSurfaceProps {
  /** Base64 JPEG of the latest remote frame; null until the first frame. */
  frame: string | null
  disabled: boolean
  onInput: (event: SurfaceInput) => void
}

/** Maps a pointer position onto the frame's own pixel grid; before the first
 * decode the rectangle carries no scale, so the raw offset is the honest
 * answer instead of an invented resolution. */
function pointerPosition(image: HTMLImageElement | null, clientX: number, clientY: number): { x: number; y: number } {
  const rect = image?.getBoundingClientRect()
  const width = rect?.width ?? 0
  const height = rect?.height ?? 0
  const natural = image?.naturalWidth ?? 0
  const scale = width > 0 && natural > 0 ? natural / width : 1
  const left = rect?.left ?? 0
  const top = rect?.top ?? 0
  return { x: Math.round((clientX - left) * (width > 0 ? scale : 1)), y: Math.round((clientY - top) * (height > 0 ? scale : 1)) }
}

const BUTTONS: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' }

export default function RemoteScreenSurface({ frame, disabled, onInput }: RemoteScreenSurfaceProps): JSX.Element {
  const imageRef = useRef<HTMLImageElement | null>(null)

  const guard = (event: React.MouseEvent): { x: number; y: number } | null => {
    if (disabled || frame === null) return null
    return pointerPosition(imageRef.current, event.clientX, event.clientY)
  }

  return (
    <div
      className="flex-1 min-h-0 overflow-hidden bg-gray-900 relative outline-none"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(event) => {
        if (disabled || frame === null) return
        // Printable characters travel as text (the remote page expects
        // input events); everything else keeps its key name.
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          onInput({ kind: 'text', text: event.key })
        } else {
          onInput({ kind: 'key', key: event.key })
        }
        event.preventDefault()
      }}
    >
      {frame !== null
        ? <img
            data-remote-screen="true"
            ref={imageRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt="远端浏览器画面"
            draggable={false}
            className="max-w-full max-h-full mx-auto block select-none"
            onMouseMove={(event) => {
              const position = guard(event)
              if (position) onInput({ kind: 'move', ...position })
            }}
            onMouseDown={(event) => {
              const position = guard(event)
              if (position) onInput({ kind: 'down', ...position, button: BUTTONS[event.button] ?? 'left' })
            }}
            onMouseUp={(event) => {
              const position = guard(event)
              if (position) onInput({ kind: 'up', ...position, button: BUTTONS[event.button] ?? 'left' })
            }}
            onClick={(event) => {
              const position = guard(event)
              if (position) onInput({ kind: 'click', ...position, button: BUTTONS[event.button] ?? 'left' })
            }}
            onContextMenu={(event) => event.preventDefault()}
            onWheel={(event) => {
              if (disabled || frame === null) return
              onInput({ kind: 'wheel', dx: event.deltaX, dy: event.deltaY })
            }}
          />
        : <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500">
            尚无远端画面
          </div>}
    </div>
  )
}
