import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { THEMES, useTheme, type ThemeId } from '../theme'
import { LANGUAGES, useI18n, type MessageKey } from '../i18n'
import { deriveOmarchyVars } from '../omarchyTheme'
import { useBranding } from '../branding'
import { loadPaneLayout, savePaneLayout } from '../workspace/layoutPrefs'
import { useAuth } from '../auth/AuthContext'
import { ApiKeyPanel } from './ApiKeyPanel'
import { BrandingPanel } from './BrandingPanel'
import { RbaPanel } from './RbaPanel'
import { LlmProviders } from './LlmProviders'
import { StorageProviders } from './StorageProviders'
import { GitConnections } from './GitConnections'
import { UsersPanel } from './UsersPanel'
import '../styles/llm-providers.css'
import '../styles/storage-providers.css'
import '../styles/users.css'

type Props = {
  onResetPanes?: () => void
}

/**
 * Tab ids double as the URL segment (`/settings/:tab`), so AiAssist can link
 * straight to `/settings/ai` and the user menu to `/settings/account`.
 * Admin-only tabs group by what they gate: `access` is who may enter (sign-in
 * provider + machine key), while AI / storage / git each hold their own paid
 * or privileged credential.
 */
const TABS = [
  { id: 'appearance', adminOnly: false },
  { id: 'editor', adminOnly: false },
  { id: 'account', adminOnly: false },
  { id: 'branding', adminOnly: true },
  { id: 'access', adminOnly: true },
  { id: 'ai', adminOnly: true },
  { id: 'storage', adminOnly: true },
  { id: 'git', adminOnly: true },
  { id: 'about', adminOnly: false },
] as const

type TabId = (typeof TABS)[number]['id']

export function SettingsPanel({ onResetPanes }: Props) {
  const { canManageUsers } = useAuth()
  const { t, lang, setLang } = useI18n()
  const params = useParams<{ tab?: string }>()
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
  const { branding } = useBranding()

  // The Omarchy card previews computed colors, so its swatches are inline
  // styles where the static cards use per-theme CSS rules.
  const omarchyVars = useMemo(
    () => (branding.omarchy ? deriveOmarchyVars(branding.omarchy) : null),
    [branding.omarchy],
  )

  const visibleTabs = TABS.filter((tab) => !tab.adminOnly || canManageUsers)
  // An unknown segment, or an admin tab reached by a non-admin (stale link,
  // demoted account), falls back to the first tab rather than a blank page.
  const active: TabId = visibleTabs.some((tab) => tab.id === params.tab)
    ? (params.tab as TabId)
    : 'appearance'

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
        <h1>{t('common.settings')}</h1>
        <p className="muted">{t('settings.subtitle')}</p>
      </header>

      <nav className="settings-tabs" aria-label={t('common.settings')}>
        {visibleTabs.map((tab) => (
          <Link
            key={tab.id}
            to={`/settings/${tab.id}`}
            className={`settings-tab ${active === tab.id ? 'active' : ''}`}
            aria-current={active === tab.id ? 'page' : undefined}
          >
            {t(`settings.tab.${tab.id}`)}
          </Link>
        ))}
      </nav>

      <div className="settings-tab-panel">
        {active === 'appearance' && (
          <>
            <section className="settings-section">
              <h2>{t('settings.language')}</h2>
              <div className="segmented">
                {LANGUAGES.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    lang={l.tag}
                    className={lang === l.id ? 'active' : ''}
                    onClick={() => setLang(l.id)}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              <p className="muted sm settings-hint">{t('settings.languageHint')}</p>
            </section>

            <section className="settings-section">
              <h2>{t('settings.colorTheme')}</h2>
              <div className="theme-grid">
                {THEMES.map((th) => (
                  <button
                    key={th.id}
                    type="button"
                    className={`theme-card ${theme === th.id ? 'active' : ''}`}
                    data-preview-theme={th.id}
                    onClick={() => setTheme(th.id as ThemeId)}
                  >
                    <span className="theme-swatches" aria-hidden>
                      <i className="sw sw-bg" />
                      <i className="sw sw-elev" />
                      <i className="sw sw-accent" />
                    </span>
                    <span className="theme-card-body">
                      <strong>
                        {th.id === 'high-contrast' ? t('settings.themeLabel.high-contrast') : th.label}
                      </strong>
                      <span className="muted sm">{t(`settings.themeDesc.${th.id}` as MessageKey)}</span>
                    </span>
                  </button>
                ))}
                {branding.omarchy && omarchyVars && (
                  <button
                    type="button"
                    className={`theme-card ${theme === 'omarchy' ? 'active' : ''}`}
                    onClick={() => setTheme('omarchy')}
                  >
                    <span className="theme-swatches" aria-hidden>
                      <i className="sw" style={{ background: omarchyVars['--bg'] }} />
                      <i className="sw" style={{ background: omarchyVars['--bg-elevated'] }} />
                      <i className="sw" style={{ background: omarchyVars['--accent'] }} />
                    </span>
                    <span className="theme-card-body">
                      <strong>Omarchy</strong>
                      <span className="muted sm">
                        {t('settings.themeDesc.omarchy')} · {branding.omarchy.name}
                      </span>
                    </span>
                  </button>
                )}
              </div>
            </section>

            <section className="settings-section">
              <h2>{t('settings.density')}</h2>
              <div className="segmented">
                <button
                  type="button"
                  className={density === 'comfortable' ? 'active' : ''}
                  onClick={() => setDensity('comfortable')}
                >
                  {t('settings.densityComfortable')}
                </button>
                <button
                  type="button"
                  className={density === 'compact' ? 'active' : ''}
                  onClick={() => setDensity('compact')}
                >
                  {t('settings.densityCompact')}
                </button>
              </div>
            </section>

            <section className="settings-section">
              <h2>{t('settings.layout')}</h2>
              <p className="muted sm">
                {t('settings.layoutCurrent', {
                  left: loadPaneLayout().leftWidth,
                  right: loadPaneLayout().rightWidth,
                })}
              </p>
              <button type="button" className="btn sm" onClick={resetPanes}>
                {t('settings.layoutReset')}
              </button>
            </section>
          </>
        )}

        {active === 'editor' && (
          <section className="settings-section">
            <h2>{t('settings.editorTitle')}</h2>
            <label className="check-row">
              <input
                type="checkbox"
                checked={showPreviewDefault}
                onChange={(e) => setShowPreviewDefault(e.target.checked)}
              />
              <span>{t('settings.editorSplitDefault')}</span>
            </label>
            <p className="muted sm settings-hint">{t('settings.editorSplitHint')}</p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={autoSaveEnabled}
                onChange={(e) => setAutoSaveEnabled(e.target.checked)}
              />
              <span>{t('settings.editorAutoSave')}</span>
            </label>
            <p className="muted sm settings-hint">{t('settings.editorAutoSaveHint')}</p>
          </section>
        )}

        {active === 'account' && (
          <section className="settings-section">
            <h2>{t('settings.accountTitle')}</h2>
            <UsersPanel />
          </section>
        )}

        {/* Branding is instance-wide (it renames the header for everyone), so it
            is admin-gated like the credential tabs below. */}
        {active === 'branding' && canManageUsers && (
          <section className="settings-section">
            <h2>{t('settings.sectionBranding')}</h2>
            <BrandingPanel />
          </section>
        )}

        {/* The login provider decides how everyone signs in — admin-only, and the
            API answers /api/settings/rba only to admins anyway. The publish API
            key is a credential with the same rule, so the two share a tab. */}
        {active === 'access' && canManageUsers && (
          <>
            <section className="settings-section">
              <h2>{t('settings.sectionSignin')}</h2>
              <RbaPanel />
            </section>
            <section className="settings-section">
              <h2>{t('settings.sectionApi')}</h2>
              <ApiKeyPanel />
            </section>
          </>
        )}

        {/* Provider rows hold a paid credential, so the API refuses to list them
            for anyone but an admin — showing the tab to an editor would just
            render a 403. Same for storage and git below. */}
        {active === 'ai' && canManageUsers && (
          <section className="settings-section">
            <h2>{t('settings.sectionAi')}</h2>
            <LlmProviders />
          </section>
        )}

        {active === 'storage' && canManageUsers && (
          <section className="settings-section">
            <h2>{t('settings.sectionStorage')}</h2>
            <StorageProviders />
          </section>
        )}

        {active === 'git' && canManageUsers && (
          <section className="settings-section">
            <h2>{t('settings.sectionGit')}</h2>
            <GitConnections />
          </section>
        )}

        {active === 'about' && (
          <section className="settings-section about">
            <h2>{t('settings.aboutTitle')}</h2>
            <p className="muted sm">{t('settings.aboutBlurb')}</p>
            <p className="muted sm">
              <Link to="/help">{t('settings.aboutHelpLink')}</Link> {t('settings.aboutHelpRest')}
            </p>
          </section>
        )}
      </div>
    </div>
  )
}
