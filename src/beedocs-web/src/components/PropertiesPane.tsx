import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import type { Shelf, StorageProvider } from '../types'
import { withBase } from '../basePath'
import { bookshelfSitePath } from '../markdownLinks'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { PageEditorState } from './PageCanvas'
import type { DiagramEditorState } from './DiagramCanvas'
import type { SlideEditorState } from './SlideCanvas'
import type { KanbanEditorState } from './KanbanCanvas'
import type { ProjectEditorState } from './ProjectCanvas'
import type { AttachmentEditorState } from './AttachmentCanvas'
import { OwnerField } from './OwnerField'
import { useGitRepos } from '../hooks/useGitRepos'
import { PageHistoryPanel } from './PageHistoryPanel'
import { SyncedInput } from './SyncedText'
import {
  attachmentIcon,
  attachmentTypeLabel,
  formatFileSize,
} from '../media/attachments'

type Props = {
  pageState: PageEditorState | null
  diagramState: DiagramEditorState | null
  slideState: SlideEditorState | null
  kanbanState: KanbanEditorState | null
  projectState: ProjectEditorState | null
  attachmentState: AttachmentEditorState | null
  view:
    | 'welcome'
    | 'shelf'
    | 'book'
    | 'page'
    | 'diagram'
    | 'slides'
    | 'kanban'
    | 'project'
    | 'attachment'
    | 'settings'
    | 'users'
    | 'stats'
    | 'help'
    | 'gitRepo'
    | 'gitFile'
}

export function PropertiesPane({
  pageState,
  diagramState,
  slideState,
  kanbanState,
  projectState,
  attachmentState,
  view,
}: Props) {
  const { bookId, shelfId } = useParams()
  const { canWrite, authEnabled, canManageUsers, user } = useAuth()
  const { t } = useI18n()
  const { books, shelves, setShelfPublished } = useWorkspace()
  const book = books.find((b) => b.id === bookId)
  const shelf = shelves.find((s) => s.id === shelfId)

  if (view === 'help') {
    return (
      <div className="props-pane">
        <h3>{t('props.helpTitle')}</h3>
        <p className="muted sm">{t('props.helpLead')}</p>
        <ul className="props-links">
          <li>
            <a href="#help-mcp">{t('props.helpLinkMcp')}</a>
          </li>
          <li>
            <a href="#help-diagrams">{t('common.diagrams')}</a>
          </li>
          <li>
            <a href="#help-shortcuts">{t('props.helpLinkShortcuts')}</a>
          </li>
          <li>
            <a href="#help-troubleshooting">{t('props.helpLinkTroubleshooting')}</a>
          </li>
        </ul>
      </div>
    )
  }

  if (view === 'settings') {
    return (
      <div className="props-pane">
        <h3>{t('common.settings')}</h3>
        <p className="muted sm">{t('props.settingsLead')}</p>
      </div>
    )
  }

  if (view === 'users') {
    return (
      <div className="props-pane">
        <h3>{t('common.users')}</h3>
        <p className="muted sm">{t('props.usersLead')}</p>
      </div>
    )
  }

  if (view === 'stats') {
    return (
      <div className="props-pane">
        <h3>{t('props.statsTitle')}</h3>
        <p className="muted sm">{t('props.statsLead')}</p>
      </div>
    )
  }

  if (view === 'page' && pageState) {
    const p = pageState.page
    // Mirrors the server rule: tracking settings belong to the page's owner or
    // an admin (which, with sign-in off, is everyone). Gated on the *saved*
    // owner — assigning yourself in the same edit doesn't grant it early.
    // canWrite too: a viewer who owns a page still cannot save one, and the
    // controls only take effect through a save.
    const canConfigureTracking =
      canWrite && (canManageUsers || (!!user?.id && user.id === (p?.ownerId ?? null)))
    return (
      <div className="props-pane">
        <h3>{t('common.page')}</h3>
        <Field label={t('common.title')}>
          {canWrite ? (
            <SyncedInput value={pageState.title} onValueChange={pageState.setTitle} />
          ) : (
            <span>{pageState.title}</span>
          )}
        </Field>
        <Field label={t('props.slug')}>
          <code className="mono-block">{p?.slug ?? '—'}</code>
        </Field>
        <Field label={t('props.version')}>
          <span>{p?.version ?? '—'}</span>
        </Field>
        <Field label={t('common.owner')}>
          <OwnerField
            value={pageState.ownerId}
            fallbackName={p?.ownerName}
            onChange={pageState.setOwnerId}
          />
        </Field>
        <Field label={t('props.updated')}>
          <span className="sm">{p ? new Date(p.updatedAt).toLocaleString() : '—'}</span>
        </Field>
        {p?.updatedByName && (
          <Field label={t('props.lastChangedBy')}>
            <span className="sm">{p.updatedByName}</span>
          </Field>
        )}
        {canConfigureTracking ? (
          <Field label={t('props.trackChanges')}>
            <div className="props-tracking">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={pageState.trackChanges}
                  onChange={(e) => pageState.setTrackChanges(e.target.checked)}
                />
                <span className="sm">{t('props.keepEveryVersion')}</span>
              </label>
              {pageState.trackChanges && (
                <label className="props-tracking-limit">
                  <span className="sm">{t('props.copiesToKeep')}</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={pageState.maxRevisions}
                    onChange={(e) => {
                      const n = Math.floor(Number(e.target.value))
                      pageState.setMaxRevisions(Number.isFinite(n) && n > 0 ? n : 0)
                    }}
                  />
                  <span className="muted sm">{t('props.zeroUnlimited')}</span>
                </label>
              )}
              <p className="muted sm">{t('props.appliesOnSave')}</p>
            </div>
          </Field>
        ) : (
          p?.trackChanges && (
            <Field label={t('props.trackChanges')}>
              <span className="sm">
                {p.maxRevisions > 0
                  ? t('props.trackOnKeeps', { count: p.maxRevisions })
                  : t('props.trackOnUnlimited')}
                <span className="muted sm"> {t('props.ownerOnlyChange')}</span>
              </span>
            </Field>
          )
        )}
        <div className="props-hint">
          <h4>{t('props.history')}</h4>
          <PageHistoryPanel pageId={p?.id ?? ''} version={p?.version} updatedAt={p?.updatedAt} />
        </div>
        {/* View mode, saving and the how-to-add-content note are all about
            editing. A read-only account is shown the page's facts and nothing
            it cannot act on. */}
        {canWrite && (
          <>
            <Field label={t('props.viewMode')}>
              <select
                value={pageState.mode}
                onChange={(e) => pageState.setMode(e.target.value as PageEditorState['mode'])}
              >
                <option value="edit">{t('props.modeEdit')}</option>
                <option value="source">{t('props.modeSource')}</option>
                <option value="split">{t('props.modeSplit')}</option>
                <option value="preview">{t('props.modePreview')}</option>
              </select>
            </Field>
            <div className="props-actions">
              <button
                type="button"
                className="btn primary sm"
                disabled={pageState.saving || !pageState.dirty}
                onClick={() => void pageState.save()}
              >
                {pageState.saving ? t('common.saving') : t('props.savePage')}
              </button>
              <button
                type="button"
                className="btn danger ghost sm"
                onClick={() => void pageState.deletePage()}
              >
                {t('common.delete')}
              </button>
            </div>
            <div className="props-hint">
              <h4>{t('props.addContent')}</h4>
              <p className="muted sm">{t('props.addContentHint')}</p>
            </div>
          </>
        )}
      </div>
    )
  }

  if (view === 'diagram' && diagramState) {
    const d = diagramState.diagram
    return (
      <div className="props-pane">
        <h3>{t('common.diagram')}</h3>
        <Field label={t('common.title')}>
          {canWrite ? (
            <SyncedInput value={diagramState.title} onValueChange={diagramState.setTitle} />
          ) : (
            <span>{diagramState.title}</span>
          )}
        </Field>
        <Field label={t('props.kind')}>
          {canWrite ? (
            <select
              value={diagramState.kind}
              onChange={(e) => diagramState.setKind(e.target.value)}
            >
              <option value="beediagram">BeeDiagram</option>
              <option value="isometric">{t('props.kindIsometric')}</option>
              <option value="mermaid">Mermaid</option>
              <option value="c4">C4 (Mermaid)</option>
            </select>
          ) : (
            <span>{diagramState.kind}</span>
          )}
        </Field>
        <Field label={t('props.updated')}>
          <span className="sm">{d ? new Date(d.updatedAt).toLocaleString() : '—'}</span>
        </Field>
        {canWrite && (
          <div className="props-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={diagramState.saving || !diagramState.dirty}
              onClick={() => void diagramState.save()}
            >
              {diagramState.saving ? t('common.saving') : t('props.saveDiagram')}
            </button>
            <button
              type="button"
              className="btn danger ghost sm"
              onClick={() => void diagramState.deleteDiagram()}
            >
              {t('common.delete')}
            </button>
          </div>
        )}
        <div className="props-hint">
          <h4>{t('props.markdownEmbed')}</h4>
          <pre className="embed-snippet sm">{diagramState.embedSnippet}</pre>
          <button
            type="button"
            className="btn sm"
            onClick={() => void navigator.clipboard.writeText(diagramState.embedSnippet)}
          >
            {t('props.copyEmbed')}
          </button>
        </div>
      </div>
    )
  }

  if (view === 'slides' && slideState) {
    const d = slideState.deck
    return (
      <div className="props-pane">
        <h3>{t('props.slides')}</h3>
        <Field label={t('common.title')}>
          {canWrite ? (
            <SyncedInput value={slideState.title} onValueChange={slideState.setTitle} />
          ) : (
            <span>{slideState.title}</span>
          )}
        </Field>
        <Field label={t('props.slides')}>
          <span>{slideState.slideCount}</span>
        </Field>
        <Field label={t('props.updated')}>
          <span className="sm">{d ? new Date(d.updatedAt).toLocaleString() : '—'}</span>
        </Field>
        <div className="props-actions">
          <button type="button" className="btn primary sm" onClick={() => slideState.present()}>
            ▶ {t('props.present')}
          </button>
          {canWrite && (
            <>
              <button
                type="button"
                className="btn primary sm"
                disabled={slideState.saving || !slideState.dirty}
                onClick={() => void slideState.save()}
              >
                {slideState.saving ? t('common.saving') : t('props.saveSlides')}
              </button>
              <button
                type="button"
                className="btn danger ghost sm"
                onClick={() => void slideState.deleteDeck()}
              >
                {t('common.delete')}
              </button>
            </>
          )}
        </div>
        <div className="props-hint">
          <h4>{t('props.presenting')}</h4>
          <p className="muted sm">{t('props.presentingHint')}</p>
        </div>
      </div>
    )
  }

  if (view === 'kanban' && kanbanState) {
    const b = kanbanState.board
    return (
      <div className="props-pane">
        <h3>{t('props.kanban')}</h3>
        <Field label={t('common.title')}>
          {canWrite ? (
            <SyncedInput value={kanbanState.title} onValueChange={kanbanState.setTitle} />
          ) : (
            <span>{kanbanState.title}</span>
          )}
        </Field>
        <Field label={t('props.cards')}>
          <span>{kanbanState.cardCount}</span>
        </Field>
        <Field label={t('props.updated')}>
          <span className="sm">{b ? new Date(b.updatedAt).toLocaleString() : '—'}</span>
        </Field>
        <div className="props-actions">
          {canWrite && (
            <>
              <button
                type="button"
                className="btn primary sm"
                disabled={kanbanState.saving || !kanbanState.dirty}
                onClick={() => void kanbanState.save()}
              >
                {kanbanState.saving ? t('common.saving') : t('props.saveKanban')}
              </button>
              <button
                type="button"
                className="btn danger ghost sm"
                onClick={() => void kanbanState.deleteBoard()}
              >
                {t('common.delete')}
              </button>
            </>
          )}
        </div>
        <div className="props-hint">
          <h4>{t('props.markdownEmbed')}</h4>
          <pre className="embed-snippet sm">{`\`\`\`kanban-ref\n${b?.id ?? ''}\n\`\`\``}</pre>
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              void navigator.clipboard.writeText(`\`\`\`kanban-ref\n${b?.id ?? ''}\n\`\`\``)
            }
          >
            {t('props.copyEmbed')}
          </button>
          <p className="muted sm">{t('props.kanbanHint')}</p>
        </div>
      </div>
    )
  }

  if (view === 'project' && projectState) {
    const p = projectState.plan
    return (
      <div className="props-pane">
        <h3>{t('props.project')}</h3>
        <Field label={t('common.title')}>
          {canWrite ? (
            <SyncedInput value={projectState.title} onValueChange={projectState.setTitle} />
          ) : (
            <span>{projectState.title}</span>
          )}
        </Field>
        <Field label={t('props.tasks')}>
          <span>{projectState.taskCount}</span>
        </Field>
        <Field label={t('props.updated')}>
          <span className="sm">{p ? new Date(p.updatedAt).toLocaleString() : '—'}</span>
        </Field>
        <div className="props-actions">
          {canWrite && (
            <>
              <button
                type="button"
                className="btn primary sm"
                disabled={projectState.saving || !projectState.dirty}
                onClick={() => void projectState.save()}
              >
                {projectState.saving ? t('common.saving') : t('props.saveProject')}
              </button>
              <button
                type="button"
                className="btn danger ghost sm"
                onClick={() => void projectState.deletePlan()}
              >
                {t('common.delete')}
              </button>
            </>
          )}
        </div>
        <div className="props-hint">
          <h4>{t('props.markdownEmbed')}</h4>
          <pre className="embed-snippet sm">{`\`\`\`project-ref\n${p?.id ?? ''}\n\`\`\``}</pre>
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              void navigator.clipboard.writeText(`\`\`\`project-ref\n${p?.id ?? ''}\n\`\`\``)
            }
          >
            {t('props.copyEmbed')}
          </button>
          <p className="muted sm">{t('props.projectHint')}</p>
        </div>
      </div>
    )
  }

  if (view === 'attachment' && attachmentState) {
    const a = attachmentState.attachment
    return (
      <div className="props-pane">
        <h3>{t('props.file')}</h3>
        <Field label={t('common.title')}>
          {canWrite ? (
            <SyncedInput value={attachmentState.title} onValueChange={attachmentState.setTitle} />
          ) : (
            <span>{attachmentState.title}</span>
          )}
        </Field>
        <Field label={t('common.description')}>
          {canWrite ? (
            <textarea
              className="props-textarea"
              rows={3}
              value={attachmentState.description}
              placeholder={t('props.descriptionPlaceholder')}
              onChange={(e) => attachmentState.setDescription(e.target.value)}
            />
          ) : (
            <span>{a?.description || '—'}</span>
          )}
        </Field>
        <Field label={t('common.owner')}>
          <OwnerField
            value={attachmentState.ownerId}
            fallbackName={a?.ownerName}
            onChange={attachmentState.setOwnerId}
          />
        </Field>
        <Field label={t('props.fileName')}>
          {canWrite ? (
            <SyncedInput
              value={attachmentState.fileName}
              onValueChange={attachmentState.setFileName}
            />
          ) : (
            <code className="mono-block">{a?.fileName ?? '—'}</code>
          )}
        </Field>
        <Field label={t('props.type')}>
          <span>
            {a ? (
              <>
                <span aria-hidden>{attachmentIcon(a.fileName, a.contentType)}</span>{' '}
                {attachmentTypeLabel(a.fileName, a.contentType)}
              </>
            ) : (
              '—'
            )}
          </span>
        </Field>
        <Field label={t('props.size')}>
          <span>{a ? formatFileSize(a.sizeBytes) : '—'}</span>
        </Field>
        <Field label={t('props.added')}>
          <span className="sm">{a ? new Date(a.createdAt).toLocaleString() : '—'}</span>
        </Field>
        <Field label={t('props.updated')}>
          <span className="sm">{a ? new Date(a.updatedAt).toLocaleString() : '—'}</span>
        </Field>
        <div className="props-actions">
          <button type="button" className="btn sm" onClick={() => attachmentState.download()}>
            {t('common.download')}
          </button>
          {canWrite && (
            <>
              <button
                type="button"
                className="btn primary sm"
                disabled={attachmentState.saving || !attachmentState.dirty}
                onClick={() => void attachmentState.save()}
              >
                {attachmentState.saving ? t('common.saving') : t('props.saveProperties')}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => attachmentState.replaceFile()}
              >
                {t('props.replaceFile')}
              </button>
              <button
                type="button"
                className="btn danger ghost sm"
                onClick={() => void attachmentState.deleteAttachment()}
              >
                {t('common.delete')}
              </button>
            </>
          )}
        </div>
        <div className="props-hint">
          <h4>{t('props.markdownLink')}</h4>
          {/* The route, not the download URL: it opens the file in the workspace
              with its properties, which is what a reader following a link wants. */}
          <pre className="embed-snippet sm">
            {a ? `[${a.title}](/books/${a.bookId}/files/${a.id})` : ''}
          </pre>
          <button
            type="button"
            className="btn sm"
            disabled={!a}
            onClick={() =>
              a &&
              void navigator.clipboard.writeText(`[${a.title}](/books/${a.bookId}/files/${a.id})`)
            }
          >
            {t('props.copyLink')}
          </button>
        </div>
      </div>
    )
  }

  if (view === 'shelf' && shelf) {
    return (
      <div className="props-pane">
        <h3>{t('common.shelf')}</h3>
        <Field label={t('common.title')}>
          <span>{shelf.title}</span>
        </Field>
        <Field label={t('props.slug')}>
          <code className="mono-block">{shelf.slug}</code>
        </Field>
        {shelf.description && (
          <Field label={t('common.description')}>
            <span className="sm">{shelf.description}</span>
          </Field>
        )}
        <Field label={t('common.books')}>
          <span>{shelf.bookCount}</span>
        </Field>
        <Field label={t('common.owner')}>
          <ShelfOwnerField
            shelfId={shelf.id}
            title={shelf.title}
            ownerId={shelf.ownerId ?? ''}
            ownerName={shelf.ownerName}
          />
        </Field>
        <Field label={t('props.storage')}>
          <ShelfStorageField shelf={shelf} />
        </Field>
        <Field label={t('props.website')}>
          <div className="shelf-site-props">
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!shelf.published}
                disabled={!canWrite}
                onChange={(e) => void setShelfPublished(shelf.id, e.target.checked)}
              />
              <span>
                {t('props.serveAsSite')}
                <span className="muted sm" style={{ display: 'block' }}>
                  {withBase(bookshelfSitePath(shelf.slug))}{' '}
                  {authEnabled
                    ? shelf.published
                      ? t('props.siteNoSignIn')
                      : t('props.siteUnpublished')
                    : t('props.siteOpenInstance')}
                </span>
              </span>
            </label>
            <a
              className="btn ghost sm"
              href={withBase(bookshelfSitePath(shelf.slug))}
              target="_blank"
              rel="noreferrer"
            >
              {t('props.openWebsite')}
            </a>
          </div>
        </Field>
        <p className="muted sm">{t('props.shelfNote')}</p>
      </div>
    )
  }

  if (view === 'book' && book) {
    return (
      <div className="props-pane">
        <h3>{t('common.book')}</h3>
        <Field label={t('common.title')}>
          <span>{book.title}</span>
        </Field>
        <Field label={t('props.slug')}>
          <code className="mono-block">{book.slug}</code>
        </Field>
        {book.description && (
          <Field label={t('common.description')}>
            <span className="sm">{book.description}</span>
          </Field>
        )}
        <Field label={t('common.shelf')}>
          <BookShelfField bookId={book.id} title={book.title} shelfId={book.shelfId ?? ''} />
        </Field>
        <Field label={t('common.pages')}>
          <span>{book.pages.length}</span>
        </Field>
        <Field label={t('common.diagrams')}>
          <span>{book.diagrams.length}</span>
        </Field>
        <Field label={t('common.slideDecks')}>
          <span>{book.slideDecks.length}</span>
        </Field>
        <Field label={t('common.kanbanBoards')}>
          <span>{book.kanbanBoards.length}</span>
        </Field>
        <Field label={t('common.projectPlans')}>
          <span>{book.projectPlans.length}</span>
        </Field>
        <Field label={t('common.owner')}>
          <BookOwnerField bookId={book.id} title={book.title} ownerId={book.ownerId ?? ''} ownerName={book.ownerName} />
        </Field>
        <p className="muted sm">
          {canWrite ? t('props.bookHintWrite') : t('props.bookHintRead')}
        </p>
      </div>
    )
  }

  if (view === 'gitRepo' || view === 'gitFile') {
    return <GitRepoProps />
  }

  return (
    <div className="props-pane">
      <h3>{t('props.propertiesTitle')}</h3>
      <p className="muted sm">
        {canWrite ? t('props.defaultHintWrite') : t('props.defaultHintRead')}
      </p>
      <ul className="props-legend">
        <li>
          <strong>{t('props.legendLeft')}</strong> — {t('props.legendLeftDesc')}
        </li>
        <li>
          <strong>{t('props.legendCenter')}</strong> — {t('props.legendCenterDesc')}
        </li>
        <li>
          <strong>{t('props.legendRight')}</strong> — {t('props.legendRightDesc')}
        </li>
      </ul>
    </div>
  )
}

/**
 * Which shelf the book sits on. Written on change like the owner field, and for
 * the same reason: a book has no save button of its own.
 */
function BookShelfField({
  bookId,
  title,
  shelfId,
}: {
  bookId: string
  title: string
  shelfId: string
}) {
  const { canWrite } = useAuth()
  const { t } = useI18n()
  const { shelves, moveBookToShelf } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canWrite) {
    return <span>{shelves.find((s) => s.id === shelfId)?.title ?? t('props.libraryRoot')}</span>
  }

  const assign = async (next: string) => {
    setBusy(true)
    setError(null)
    try {
      await moveBookToShelf(bookId, next || null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <select
        value={shelfId}
        disabled={busy || shelves.length === 0}
        onChange={(e) => void assign(e.target.value)}
        title={title}
      >
        <option value="">{t('props.libraryRootOption')}</option>
        {shelves.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      {shelves.length === 0 && <span className="muted sm">{t('props.noShelvesYet')}</span>}
      {error && (
        <span className="users-error" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

/**
 * Where the shelf's content bodies live. Unlike every other write-on-change
 * field in this pane, picking a value MOVES data server-side and can take
 * minutes — so the change is confirmed in a modal first, and the select never
 * shows the target until the server says it holds. Admin-only: the API refuses
 * anyone else, and non-admins get the read-only name instead.
 */
function ShelfStorageField({ shelf }: { shelf: Shelf }) {
  const { canManageUsers } = useAuth()
  const { t } = useI18n()
  const { refreshTree } = useWorkspace()
  const [providers, setProviders] = useState<StorageProvider[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The target awaiting confirmation. undefined = no dialog; null = "Local".
  const [pending, setPending] = useState<string | null | undefined>(undefined)
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentLabel = shelf.storageProviderName ?? t('props.storageLocal')

  useEffect(() => {
    if (!canManageUsers) return
    let alive = true
    api
      .listStorageProviders()
      .then((list) => {
        if (alive) setProviders(list)
      })
      .catch((e) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [canManageUsers])

  if (!canManageUsers) return <span>{currentLabel}</span>

  const ready = (p: StorageProvider) =>
    p.kind === 'azure-blob' ? p.hasConnectionString : p.googleConnected
  // Ready providers, plus the assigned one even if since broken — the select
  // must be able to show the truth.
  const options = (providers ?? []).filter((p) => ready(p) || p.id === shelf.storageProviderId)
  const pendingName = pending
    ? (options.find((p) => p.id === pending)?.name ?? t('props.thatProvider'))
    : t('props.storageLocal')

  return (
    <>
      <select
        value={shelf.storageProviderId ?? ''}
        disabled={moving || providers === null}
        onChange={(e) => {
          const next = e.target.value || null
          if (next !== (shelf.storageProviderId ?? null)) {
            setError(null)
            setPending(next)
          }
        }}
      >
        <option value="">{t('props.storageLocal')}</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {providers !== null && options.length === 0 && (
        <span className="muted sm">{t('props.addProviderHint')}</span>
      )}
      {loadError && (
        <span className="users-error" role="alert">
          {loadError}
        </span>
      )}
      {pending !== undefined && (
        <ShelfStorageConfirm
          shelf={shelf}
          currentLabel={currentLabel}
          targetName={pendingName}
          moving={moving}
          error={error}
          onCancel={() => {
            if (!moving) {
              setPending(undefined)
              setError(null)
            }
          }}
          onConfirm={async () => {
            setMoving(true)
            setError(null)
            try {
              await api.setShelfStorage(shelf.id, pending ?? null)
              // The tree carries the Shelf DTO this pane renders from.
              await refreshTree()
              setPending(undefined)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            } finally {
              setMoving(false)
            }
          }}
        />
      )}
    </>
  )
}

/** The confirm/progress dialog for a shelf storage move — ImportDialog's modal idiom. */
function ShelfStorageConfirm({
  shelf,
  currentLabel,
  targetName,
  moving,
  error,
  onCancel,
  onConfirm,
}: {
  shelf: Shelf
  currentLabel: string
  targetName: string
  moving: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !moving) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moving, onCancel])

  // A timeout is not a verdict: the server keeps moving after the client hangs up.
  const timedOut = error !== null && /did not respond/i.test(error)

  return (
    <div className="modal-backdrop" onClick={moving ? undefined : onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('props.moveShelfStorage')}</h2>
        </div>
        <div className="modal-body">
          <p>
            {t(shelf.bookCount === 1 ? 'props.moveQuestion.one' : 'props.moveQuestion.other', {
              shelf: shelf.title,
              count: shelf.bookCount,
              from: currentLabel,
              to: targetName,
            })}
          </p>
          <p className="muted sm">{t('props.moveExplain')}</p>
          {moving && <p className="banner warn compact">{t('props.movingKeepOpen')}</p>}
          {error && (
            <p className="banner error compact">
              {error}
              {timedOut ? ` ${t('props.moveTimedOut')}` : ''}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" disabled={moving} onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={moving} onClick={onConfirm}>
            {moving ? t('props.moving') : t('props.moveContent')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The shelf equivalent of {@link BookOwnerField} — same write-on-change reason. */
function ShelfOwnerField({
  shelfId,
  title,
  ownerId,
  ownerName,
}: {
  shelfId: string
  title: string
  ownerId: string
  ownerName?: string | null
}) {
  const { refreshTree } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const assign = async (next: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.updateShelf(shelfId, { title, ownerId: next })
      await refreshTree()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <OwnerField
        value={ownerId}
        fallbackName={ownerName}
        disabled={busy}
        onChange={(next) => void assign(next)}
      />
      {error && (
        <span className="users-error" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

/**
 * A book has no editor to save through, so its owner is written on change.
 * The title rides along because the API requires it on every book update.
 */
function BookOwnerField({
  bookId,
  title,
  ownerId,
  ownerName,
}: {
  bookId: string
  title: string
  ownerId: string
  ownerName?: string | null
}) {
  const { refreshTree } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const assign = async (next: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.updateBook(bookId, { title, ownerId: next })
      // The tree carries the book DTO the pane renders from, so it has to be the
      // thing that learns about the new owner.
      await refreshTree()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <OwnerField
        value={ownerId}
        fallbackName={ownerName}
        disabled={busy}
        onChange={(next) => void assign(next)}
      />
      {error && (
        <span className="users-error" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="props-field">
      <span className="props-label">{label}</span>
      {children}
    </label>
  )
}

/**
 * Facts about the git repo behind the current /git route. Read-only on
 * purpose: a repo has no owner/history machinery — git itself is both.
 */
function GitRepoProps() {
  const { repoId } = useParams()
  const { t } = useI18n()
  const repos = useGitRepos()
  const repo = repos?.find((r) => r.id === repoId)

  if (!repo) {
    return (
      <div className="props-pane">
        <h3>{t('common.repository')}</h3>
        <p className="muted sm">{t('common.loading')}</p>
      </div>
    )
  }

  return (
    <div className="props-pane">
      <h3>{t('common.repository')}</h3>
      <Field label={t('common.name')}>
        <span>{repo.name}</span>
      </Field>
      <Field label={t('props.connection')}>
        <span>{repo.connectionName}</span>
      </Field>
      <Field label={t('props.remote')}>
        <code className="mono-block">{repo.cloneUrl}</code>
      </Field>
      <Field label={t('props.branch')}>
        <span>{repo.defaultBranch || '—'}</span>
      </Field>
      <Field label={t('props.status')}>
        <span>{repo.status}</span>
      </Field>
      {repo.fetchedAt && (
        <Field label={t('props.lastSynced')}>
          <span>{new Date(repo.fetchedAt).toLocaleString()}</span>
        </Field>
      )}
      <Field label={t('props.inSearch')}>
        <span>{repo.indexed ? t('common.yes') : t('common.no')}</span>
      </Field>
      <p className="muted sm">{t('props.gitRepoNote')}</p>
    </div>
  )
}
