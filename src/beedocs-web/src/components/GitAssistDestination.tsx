import { useI18n } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { Book, Shelf } from '../types'

export type GitAssistDest =
  | { mode: 'new'; shelfId: string }
  | { mode: 'existing'; bookId: string }

export function destToPublishBody(dest: GitAssistDest): { shelfId?: string; bookId?: string } {
  if (dest.mode === 'existing') return { bookId: dest.bookId }
  return dest.shelfId ? { shelfId: dest.shelfId } : {}
}

export function defaultDest(): GitAssistDest {
  return { mode: 'new', shelfId: '' }
}

/** Shelf vs existing-book picker shared by the generate dialog and the job result. */
export function GitAssistDestination({
  value,
  onChange,
  disabled,
}: {
  value: GitAssistDest
  onChange: (next: GitAssistDest) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const { books, shelves } = useWorkspace()
  const sorted = [...books].sort((a, b) => a.title.localeCompare(b.title))

  return (
    <div className="git-assist-dest">
      <label className="check-row">
        <input
          type="radio"
          name="git-assist-dest"
          checked={value.mode === 'new'}
          disabled={disabled}
          onChange={() => onChange({ mode: 'new', shelfId: value.mode === 'new' ? value.shelfId : '' })}
        />
        <span>{t('gitadmin.destNewBook')}</span>
      </label>
      {value.mode === 'new' ? (
        <label className="git-assist-field">
          <span>{t('gitadmin.shelfForBook')}</span>
          <select
            value={value.shelfId}
            disabled={disabled}
            onChange={(e) => onChange({ mode: 'new', shelfId: e.target.value })}
          >
            <option value="">{t('gitadmin.libraryRoot')}</option>
            {shelves.map((s: Shelf) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="check-row">
        <input
          type="radio"
          name="git-assist-dest"
          checked={value.mode === 'existing'}
          disabled={disabled || sorted.length === 0}
          onChange={() =>
            onChange({
              mode: 'existing',
              bookId: value.mode === 'existing' ? value.bookId : (sorted[0]?.id ?? ''),
            })
          }
        />
        <span>{t('gitadmin.destExistingBook')}</span>
      </label>
      {sorted.length === 0 ? (
        <p className="muted sm">{t('gitadmin.noBooksYet')}</p>
      ) : value.mode === 'existing' ? (
        <label className="git-assist-field">
          <span>{t('gitadmin.pickBook')}</span>
          <select
            value={value.bookId}
            disabled={disabled}
            onChange={(e) => onChange({ mode: 'existing', bookId: e.target.value })}
          >
            {sorted.map((b: Book) => (
              <option key={b.id} value={b.id}>
                {b.shelfTitle ? `${b.title} — ${b.shelfTitle}` : b.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  )
}
