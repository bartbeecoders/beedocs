import { useEffect, useState } from 'react'
import { BeeDiagramEditor } from './BeeDiagramEditor'
import { BeeStudioEditor } from './studio/BeeStudioEditor'

export type BeeEditorMode = 'studio' | 'classic'

const MODE_KEY = 'beedocs-bee-editor-mode'

function loadMode(): BeeEditorMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'classic' ? 'classic' : 'studio'
  } catch {
    return 'studio'
  }
}

type Props = {
  source: string
  onChange: (source: string) => void
  readOnly?: boolean
}

/**
 * BeeDiagram editing surface with the two editing modes:
 * **Studio** (draw.io-style palette + canvas + format panel) and
 * **Classic** (the original compact BeeDocs editor). Both read and write the
 * same BeeDiagram JSON.
 */
export function BeeDiagramWorkbench({ source, onChange, readOnly }: Props) {
  const [mode, setMode] = useState<BeeEditorMode>(loadMode)

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      /* ignore */
    }
  }, [mode])

  return (
    <div className={`bee-workbench bee-workbench--${mode}`}>
      <div className="bee-workbench-modes">
        <div className="segmented" role="tablist" aria-label="Diagram editor mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'studio'}
            className={mode === 'studio' ? 'active' : ''}
            onClick={() => setMode('studio')}
            title="Shape palette, connection arrows and format panel"
          >
            Studio
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'classic'}
            className={mode === 'classic' ? 'active' : ''}
            onClick={() => setMode('classic')}
            title="The compact BeeDocs editor"
          >
            Classic
          </button>
        </div>
      </div>
      {mode === 'studio' ? (
        <BeeStudioEditor source={source} onChange={onChange} readOnly={readOnly} />
      ) : (
        <BeeDiagramEditor source={source} onChange={onChange} readOnly={readOnly} />
      )}
    </div>
  )
}
