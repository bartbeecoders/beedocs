import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { attachmentRejection } from '../media/attachments'

type Options = {
  /**
   * Open the uploaded file when exactly one was picked. A batch is filing, not
   * reading, so it deliberately leaves the view where it was.
   */
  openOnSingle?: boolean
}

export type AttachmentUploadApi = {
  /** Book an upload is running for, or null. Drives the "Uploading…" affordances. */
  uploadingIn: string | null
  /** The last rejection or server error, or null. */
  error: string | null
  clearError: () => void
  /** Upload every acceptable file into a book. Never throws. */
  upload: (bookId: string, files: FileList | File[] | null) => Promise<void>
}

/**
 * One upload loop for every way a file gets into a book — the tree's context
 * menu, the toolbar button, the book overview, and drops on any of them.
 *
 * Files are uploaded one at a time rather than in parallel so a rejected file
 * names itself: a `Promise.all` over a mixed selection fails anonymously, and
 * "which of these six is the problem" is the whole question the person has.
 * A rejection is reported and skipped, so the acceptable files in a selection
 * still land.
 */
export function useAttachmentUpload({ openOnSingle = true }: Options = {}): AttachmentUploadApi {
  const { uploadAttachment } = useWorkspace()
  const navigate = useNavigate()
  const [uploadingIn, setUploadingIn] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Guards against a second drop landing mid-upload and racing the first. */
  const busy = useRef(false)

  const upload = useCallback(
    async (bookId: string, files: FileList | File[] | null) => {
      const list = files ? Array.from(files) : []
      if (!bookId || list.length === 0 || busy.current) return

      busy.current = true
      setUploadingIn(bookId)
      setError(null)
      const rejected: string[] = []
      let lastId: string | null = null
      try {
        for (const file of list) {
          const rejection = attachmentRejection(file)
          if (rejection) {
            rejected.push(rejection)
            continue
          }
          lastId = (await uploadAttachment(bookId, file)).id
        }
        if (rejected.length) setError(rejected.join('\n'))
        if (openOnSingle && lastId && list.length === 1) {
          void navigate(`/books/${bookId}/files/${lastId}`)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        busy.current = false
        setUploadingIn(null)
      }
    },
    [uploadAttachment, navigate, openOnSingle],
  )

  return { uploadingIn, error, clearError: () => setError(null), upload }
}
