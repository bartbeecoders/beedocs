import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { Attachment } from '../types'
import {
  ATTACHMENT_ACCEPT,
  attachmentIcon,
  attachmentRejection,
  attachmentTypeLabel,
  canPreviewAttachment,
  formatFileSize,
  isImageAttachment,
} from '../media/attachments'
import { useFileDropZone } from '../hooks/useFileDropZone'

export type AttachmentEditorState = {
  attachment: Attachment | null
  title: string
  description: string
  ownerId: string
  fileName: string
  dirty: boolean
  saving: boolean
  error: string | null
  setTitle: (v: string) => void
  setDescription: (v: string) => void
  setOwnerId: (v: string) => void
  setFileName: (v: string) => void
  save: () => Promise<void>
  /** Open the OS file picker and swap the stored bytes for the chosen file. */
  replaceFile: () => void
  download: () => void
  deleteAttachment: () => Promise<void>
}

type Props = {
  onStateChange?: (state: AttachmentEditorState | null) => void
}

/**
 * Center-canvas host for an attachment route.
 *
 * Unlike every other canvas there is no editor: the document itself is opaque
 * bytes this app cannot open, so the canvas shows what it can (a PDF, an image)
 * and otherwise gets out of the way with a download. The editable part —
 * title, description, owner, download name — is metadata, which is why saving
 * here is an explicit button rather than the auto-save the text editors use:
 * there is no stream of keystrokes to coalesce.
 */
export function AttachmentCanvas({ onStateChange }: Props) {
  const { bookId = '', attachmentId = '' } = useParams()
  const navigate = useNavigate()
  const { canWrite } = useAuth()
  const { patchAttachment, deleteAttachment: deleteFromTree } = useWorkspace()

  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [fileName, setFileName] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)
  /**
   * Bumped after every replace so the preview's src changes. The download URL is
   * keyed on the id alone — deliberately, so links stay valid across a
   * replacement — which means the browser would otherwise show the cached file.
   */
  const [fileVersion, setFileVersion] = useState(0)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const idRef = useRef(attachmentId)
  idRef.current = attachmentId

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setError(null)
      setAttachment(null)
      setDirty(false)
      setSavedAt(null)
      try {
        const a = await api.getAttachment(attachmentId)
        if (cancelled) return
        setAttachment(a)
        setTitle(a.title)
        setDescription(a.description ?? '')
        setOwnerId(a.ownerId ?? '')
        setFileName(a.fileName)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [attachmentId])

  /** Fold a server response back into local state and the library tree. */
  const applySaved = useCallback(
    (saved: Attachment) => {
      setAttachment(saved)
      setTitle(saved.title)
      setDescription(saved.description ?? '')
      setOwnerId(saved.ownerId ?? '')
      setFileName(saved.fileName)
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
      patchAttachment(saved.bookId, saved)
    },
    [patchAttachment],
  )

  const save = useCallback(async () => {
    const id = idRef.current
    if (!id || !title.trim()) return
    setSaving(true)
    setError(null)
    try {
      // Empty strings are meaningful here: the API reads "" as "clear it" for
      // description and owner, which is exactly what an emptied field means.
      const saved = await api.updateAttachment(id, {
        title: title.trim(),
        description,
        ownerId,
        fileName: fileName.trim() || undefined,
      })
      if (idRef.current === id) applySaved(saved)
    } catch (e) {
      if (idRef.current === id) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (idRef.current === id) setSaving(false)
    }
  }, [title, description, ownerId, fileName, applySaved])

  const onPickReplacement = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      const rejection = attachmentRejection(file)
      if (rejection) {
        setError(rejection)
        return
      }
      const id = idRef.current
      setReplacing(true)
      setError(null)
      try {
        const saved = await api.replaceAttachmentFile(id, file)
        if (idRef.current !== id) return
        applySaved(saved)
        setFileVersion((v) => v + 1)
      } catch (e) {
        if (idRef.current === id) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (idRef.current === id) setReplacing(false)
      }
    },
    [applySaved],
  )

  const download = useCallback(() => {
    const a = document.createElement('a')
    a.href = api.attachmentUrl(idRef.current)
    a.download = ''
    a.click()
  }, [])

  const remove = useCallback(async () => {
    if (!confirm(`Delete “${title}”? The file is removed from the server.`)) return
    await deleteFromTree(idRef.current, bookId)
    void navigate(`/books/${bookId}`)
  }, [title, deleteFromTree, bookId, navigate])

  const replaceFile = useCallback(() => fileInputRef.current?.click(), [])

  /**
   * Dropping a file here replaces this one rather than adding another: the
   * canvas is showing a single document, and "here is the new version of that"
   * is the only thing a drop onto it can reasonably mean. Only the first file
   * of a multi-file drop is taken — the rest have no slot to land in.
   */
  const fileDrop = useFileDropZone({
    enabled: canWrite,
    onFiles: (files) => void onPickReplacement(files[0]),
  })

  useEffect(() => {
    onStateChange?.({
      attachment,
      title,
      description,
      ownerId,
      fileName,
      dirty,
      saving,
      error,
      setTitle: (v) => {
        setTitle(v)
        setDirty(true)
      },
      setDescription: (v) => {
        setDescription(v)
        setDirty(true)
      },
      setOwnerId: (v) => {
        setOwnerId(v)
        setDirty(true)
      },
      setFileName: (v) => {
        setFileName(v)
        setDirty(true)
      },
      save,
      replaceFile,
      download,
      deleteAttachment: remove,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment, title, description, ownerId, fileName, dirty, saving, error, save, remove])

  useEffect(() => {
    return () => onStateChange?.(null)
  }, [onStateChange])

  if (error && !attachment) {
    return <div className="canvas-message error">{error}</div>
  }
  if (!attachment) {
    return <div className="canvas-message muted">Loading file…</div>
  }

  const previewUrl = `${api.attachmentUrl(attachment.id, true)}&v=${fileVersion}`
  const statusLabel = saving
    ? 'Saving…'
    : replacing
      ? 'Uploading…'
      : dirty
        ? 'Unsaved'
        : savedAt
          ? `Saved · ${savedAt}`
          : null

  return (
    <div
      className={`attachment-canvas${fileDrop.dragging ? ' file-drop-over' : ''}`}
      {...fileDrop.dropProps}
    >
      {fileDrop.dragging && (
        <div className="file-drop-overlay">
          <span aria-hidden>♻️</span>
          <strong>Drop to replace “{attachment.title}”</strong>
          <span className="muted sm">
            Keeps the title, description and every link to this file
          </span>
        </div>
      )}
      <div className="canvas-toolbar">
        <div className="canvas-heading">
          {canWrite ? (
            <input
              className="canvas-title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setDirty(true)
              }}
              placeholder="File title"
            />
          ) : (
            <span className="canvas-title">{title}</span>
          )}
          <div className="canvas-meta">
            <span>{attachmentTypeLabel(attachment.fileName, attachment.contentType)}</span>
            <span>· {formatFileSize(attachment.sizeBytes)}</span>
            {statusLabel && <span>· {statusLabel}</span>}
          </div>
        </div>
        <div className="toolbar-group">
          <button type="button" className="btn sm" onClick={download}>
            Download
          </button>
          {canWrite && (
            <>
              <button
                type="button"
                className="btn ghost sm"
                disabled={replacing}
                onClick={replaceFile}
                title="Upload a new version of this file, keeping its title and links"
              >
                {replacing ? 'Uploading…' : 'Replace file'}
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
            </>
          )}
        </div>
      </div>
      {error && <div className="banner error compact">{error}</div>}

      <input
        ref={fileInputRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        hidden
        onChange={(e) => {
          void onPickReplacement(e.target.files?.[0])
          // Reset, or picking the same file twice in a row fires no change event.
          e.target.value = ''
        }}
      />

      <div className="attachment-preview">
        {canPreviewAttachment(attachment.contentType) ? (
          isImageAttachment(attachment.contentType) ? (
            <img className="attachment-preview-image" src={previewUrl} alt={attachment.title} />
          ) : (
            <iframe
              className="attachment-preview-frame"
              src={previewUrl}
              title={attachment.title}
            />
          )
        ) : (
          <div className="attachment-placeholder">
            <span className="attachment-placeholder-icon" aria-hidden>
              {attachmentIcon(attachment.fileName, attachment.contentType)}
            </span>
            <strong>{attachment.fileName}</strong>
            <p className="muted sm">
              {attachmentTypeLabel(attachment.fileName, attachment.contentType)} ·{' '}
              {formatFileSize(attachment.sizeBytes)}
            </p>
            <p className="muted sm">
              This format opens in its own application. Download it to read or edit it — the copy
              here stays as it is until someone uploads a replacement.
            </p>
            <button type="button" className="btn primary sm" onClick={download}>
              Download {attachment.fileName}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
