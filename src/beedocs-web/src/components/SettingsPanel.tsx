import { Link } from 'react-router-dom'
import { THEMES, useTheme, type ThemeId } from '../theme'
import { loadPaneLayout, savePaneLayout } from '../workspace/layoutPrefs'
import { useAuth } from '../auth/AuthContext'
import { ApiKeyPanel } from './ApiKeyPanel'
import { LlmProviders } from './LlmProviders'
import { UsersPanel } from './UsersPanel'
import '../styles/llm-providers.css'
import '../styles/users.css'

type Props = {
  onResetPanes?: () => void
}

export function SettingsPanel({ onResetPanes }: Props) {
  const { canManageUsers } = useAuth()
  const {
    theme,
    setTheme,
    density,
    setDensity,
    showPreviewDefault,
    setShowPreviewDefault,
    autoSaveEnabled,
    setAutoSaveEnabled,
  } = useTheme()

  const resetPanes = () => {
    const defaults = {
      leftWidth: 280,
      rightWidth: 300,
      leftCollapsed: false,
      rightCollapsed: false,
    }
    savePaneLayout(defaults)
    onResetPanes?.()
  }

  return (
    <div className="settings-panel">
      <header className="settings-header">
        <h1>Settings</h1>
        <p className="muted">Appearance and editor defaults for this browser.</p>
      </header>

      <section className="settings-section">
        <h2>Color theme</h2>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`theme-card ${theme === t.id ? 'active' : ''}`}
              data-preview-theme={t.id}
              onClick={() => setTheme(t.id as ThemeId)}
            >
              <span className="theme-swatches" aria-hidden>
                <i className="sw sw-bg" />
                <i className="sw sw-elev" />
                <i className="sw sw-accent" />
              </span>
              <span className="theme-card-body">
                <strong>{t.label}</strong>
                <span className="muted sm">{t.description}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2>Density</h2>
        <div className="segmented">
          <button
            type="button"
            className={density === 'comfortable' ? 'active' : ''}
            onClick={() => setDensity('comfortable')}
          >
            Comfortable
          </button>
          <button
            type="button"
            className={density === 'compact' ? 'active' : ''}
            onClick={() => setDensity('compact')}
          >
            Compact
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h2>Editor</h2>
        <label className="check-row">
          <input
            type="checkbox"
            checked={showPreviewDefault}
            onChange={(e) => setShowPreviewDefault(e.target.checked)}
          />
          <span>Open pages in split (edit + preview) by default</span>
        </label>
        <p className="muted sm settings-hint">
          Applies only until you pick a view for a page — each page remembers edit / source / split /
          preview.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={autoSaveEnabled}
            onChange={(e) => setAutoSaveEnabled(e.target.checked)}
          />
          <span>Auto-save pages and diagrams while editing</span>
        </label>
        <p className="muted sm settings-hint">
          When enabled, saves about 1.5s after you stop typing. Manual Save and Ctrl/Cmd+S still work.
        </p>
      </section>

      <section className="settings-section">
        <h2>Users &amp; roles</h2>
        <UsersPanel />
      </section>

      {/* The publish API key is a credential — the API answers only to admins,
          so showing the section to an editor would just render a 403. */}
      {canManageUsers && (
        <section className="settings-section">
          <h2>API access</h2>
          <ApiKeyPanel />
        </section>
      )}

      {/* Provider rows hold a paid credential, so the API refuses to list them
          for anyone but an admin — showing the section to an editor would only
          render a 403. */}
      {canManageUsers && (
        <section className="settings-section">
          <h2>AI providers</h2>
          <LlmProviders />
        </section>
      )}

      <section className="settings-section">
        <h2>Layout</h2>
        <p className="muted sm">
          Pane widths and collapse state are remembered. Current: left{' '}
          {loadPaneLayout().leftWidth}px, right {loadPaneLayout().rightWidth}px.
        </p>
        <button type="button" className="btn sm" onClick={resetPanes}>
          Reset pane layout
        </button>
      </section>

      <section className="settings-section about">
        <h2>About</h2>
        <p className="muted sm">
          BeeDocs — self-hosted architecture documentation. Markdown, Mermaid, and BeeDiagram.
        </p>
        <p className="muted sm">
          <Link to="/help">About &amp; Help</Link> — workspace guide, diagram shortcuts, and how to
          connect an AI agent over MCP.
        </p>
      </section>
    </div>
  )
}
