import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { TreeSelection } from '../workspace/selection'
import type { Favorite, FavoriteKind } from '../types'
import '../styles/favorites.css'

/** Same glyphs the tree rows use, so a favorite is recognisably the same thing. */
const KIND_ICONS: Record<FavoriteKind, string> = {
  book: '📘',
  page: '📄',
  diagram: '⬡',
  slides: '🎞️',
  kanban: '📋',
  project: '📊',
  note: '📝',
  attachment: '📎',
}

function favoritePath(f: Favorite): string | null {
  if (f.kind === 'book') return `/books/${f.entityId}`
  // Everything else lives inside a book; without one there is nowhere to go.
  if (!f.bookId) return null
  switch (f.kind) {
    case 'page':
      return `/books/${f.bookId}/pages/${f.entityId}`
    case 'diagram':
      return `/books/${f.bookId}/diagrams/${f.entityId}`
    case 'slides':
      return `/books/${f.bookId}/slides/${f.entityId}`
    case 'kanban':
      return `/books/${f.bookId}/kanban/${f.entityId}`
    case 'project':
      return `/books/${f.bookId}/project/${f.entityId}`
    case 'note':
      return `/books/${f.bookId}/notes/${f.entityId}`
    case 'attachment':
      return `/books/${f.bookId}/files/${f.entityId}`
  }
}

function favoriteSelection(f: Favorite): TreeSelection {
  switch (f.kind) {
    case 'book':
      return { kind: 'book', bookId: f.entityId }
    case 'page':
      return { kind: 'page', bookId: f.bookId!, pageId: f.entityId }
    case 'diagram':
      return { kind: 'diagram', bookId: f.bookId!, diagramId: f.entityId }
    case 'slides':
      return { kind: 'slides', bookId: f.bookId!, deckId: f.entityId }
    case 'kanban':
      return { kind: 'kanban', bookId: f.bookId!, boardId: f.entityId }
    case 'project':
      return { kind: 'project', bookId: f.bookId!, planId: f.entityId }
    case 'note':
      return { kind: 'note', bookId: f.bookId!, noteId: f.entityId }
    case 'attachment':
      return { kind: 'attachment', bookId: f.bookId!, attachmentId: f.entityId }
  }
}

/**
 * The starred items above the library tree. Renders nothing until something is
 * starred — an empty pinned section would only push the library down for
 * everyone who never uses the feature. Starring happens in the tree's context
 * menus; this panel is where favorites are opened and unstarred.
 */
export function FavoritesPanel() {
  const { favorites, toggleFavorite, setSelection } = useWorkspace()
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('beedocs-favorites-collapsed') === '1'
    } catch {
      return false
    }
  })

  if (favorites.length === 0) return null

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem('beedocs-favorites-collapsed', next ? '1' : '0')
      } catch {
        // Preference only — losing it costs one extra click.
      }
      return next
    })
  }

  return (
    <div className="favorites-panel">
      <button
        type="button"
        className="favorites-header"
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
      >
        <span className="tree-twist">{collapsed ? '▸' : '▾'}</span>
        <span className="favorites-title">★ {t('common.favorites')}</span>
        <span className="muted sm">({favorites.length})</span>
      </button>
      {!collapsed && (
        <ul className="tree-root">
          {favorites.map((f) => {
            const path = favoritePath(f)
            if (!path) return null
            return (
              <li key={`${f.kind}:${f.entityId}`}>
                <div className="tree-row">
                  <NavLink
                    to={path}
                    className="tree-label"
                    onClick={() => setSelection(favoriteSelection(f))}
                  >
                    <span className="tree-icon">{KIND_ICONS[f.kind]}</span>
                    <span className="tree-text">{f.title}</span>
                  </NavLink>
                  <div className="tree-row-actions">
                    <button
                      type="button"
                      className="fav-remove"
                      title={t('nav.removeFavorite')}
                      aria-label={t('nav.removeFavoriteNamed', { title: f.title })}
                      onClick={() => void toggleFavorite(f.kind, f.entityId)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
