import { createElement, useCallback, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { useAttachmentUpload } from './useAttachmentUpload'
import { classifyDroppedFile, titleFromMarkdownFile } from '../media/fileDropIntent'
import { attachmentRejection } from '../media/attachments'
import { MarkdownDropDialog, type MarkdownDropAction } from '../components/MarkdownDropDialog'
import { showToast } from '../toast'
import { useI18n } from '../i18n'

/**
 * Library drop router: PDF/zip/images go straight to Files; Markdown asks
 * whether to attach or become a page. The picker "Upload file" path still
 * uses {@link useAttachmentUpload} directly and skips this prompt.
 */
export function useLibraryFileDrop() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { books, createPage } = useWorkspace()
  const { uploadingIn, error, clearError, upload } = useAttachmentUpload()
  const [pending, setPending] = useState<{ files: File[]; bookId: string } | null>(null)
  const [extraError, setExtraError] = useState<string | null>(null)

  const handleFiles = useCallback(
    async (bookId: string, files: File[]) => {
      if (!bookId || files.length === 0) return
      const markdown: File[] = []
      const attachments: File[] = []
      const rejected: string[] = []
      try {
        for (const file of files) {
          const intent = await classifyDroppedFile(file)
          if (intent === 'markdown') {
            const why = attachmentRejection(file)
            if (why) rejected.push(why)
            else markdown.push(file)
          } else if (intent === 'attachment') attachments.push(file)
          else
            rejected.push(
              attachmentRejection(file) ?? `“${file.name}” is not a file type this library accepts.`,
            )
        }
        if (rejected.length) setExtraError(rejected.join('\n'))
        else setExtraError(null)
        if (attachments.length) await upload(bookId, attachments)
        if (markdown.length) setPending({ files: markdown, bookId })
      } catch (e) {
        setExtraError(e instanceof Error ? e.message : String(e))
      }
    },
    [upload],
  )

  const confirmMarkdown = useCallback(
    async (action: MarkdownDropAction, bookId: string) => {
      if (!pending) return
      const files = pending.files
      if (action === 'file') {
        await upload(bookId, files)
        return
      }
      const titles: string[] = []
      let lastId: string | null = null
      for (const file of files) {
        const content = await file.text()
        const title = titleFromMarkdownFile(file.name, content)
        titles.push(title)
        const page = await createPage(bookId, title, null, content)
        lastId = page.id
      }
      showToast(
        titles.length === 1
          ? t('dialogs.mdDropPageCreated', { title: titles[0] })
          : t('dialogs.mdDropPagesCreated', { count: titles.length }),
        'ok',
      )
      if (lastId && files.length === 1) void navigate(`/books/${bookId}/pages/${lastId}`)
    },
    [pending, upload, createPage, navigate, t],
  )

  const combinedError = extraError ?? error
  const clear = () => {
    setExtraError(null)
    clearError()
  }

  const dialog: ReactNode = pending
    ? createElement(MarkdownDropDialog, {
        files: pending.files,
        books: books.map((b) => ({ id: b.id, title: b.title })),
        defaultBookId: pending.bookId,
        onConfirm: confirmMarkdown,
        onClose: () => setPending(null),
      })
    : null

  return {
    uploadingIn,
    error: combinedError,
    clearError: clear,
    /** Drop path — classifies, then attaches or prompts. */
    handleFiles,
    /** Explicit upload (picker / “Upload file”) — always Files. */
    upload,
    dialog,
  }
}
