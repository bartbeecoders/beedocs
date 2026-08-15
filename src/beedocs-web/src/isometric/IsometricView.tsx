import { useEffect, useRef } from 'react'
import { IsoCanvas, type IsoCanvasHandle } from './IsoCanvas'
import { useIsoController } from './useIsoController'

/**
 * Read-only isometric rendering used in page embeds, previews, and for viewer
 * accounts: pan and zoom stay available, editing does not.
 */
export default function IsometricView({ source, title }: { source: string; title?: string }) {
  const ctrl = useIsoController({ source, onChange: () => {}, readOnly: true })
  const canvasRef = useRef<IsoCanvasHandle>(null)
  const fitted = useRef(false)

  useEffect(() => {
    if (fitted.current) return
    fitted.current = true
    // Wait one frame so the wrapper has a measured size to fit into.
    const raf = requestAnimationFrame(() => canvasRef.current?.zoomToFit())
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="iso-view" aria-label={title ? `Isometric diagram: ${title}` : 'Isometric diagram'}>
      <IsoCanvas ref={canvasRef} ctrl={ctrl} />
    </div>
  )
}
