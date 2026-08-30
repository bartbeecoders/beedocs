import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'
import { useBranding } from '../branding'
import { useI18n } from '../i18n'
import { withApiBase } from '../basePath'
import type { Branding, GenerateLogoResult } from '../types'

/**
 * Settings → Branding (admin only): rename the instance and swap the 🐝 mark
 * for a custom logo — uploaded, or drafted by the configured AI provider and
 * applied only after the admin approves the preview. Every mutation returns the
 * fresh branding, which is pushed through the provider's refresh so the header
 * and login screen update without a reload.
 */
export function BrandingPanel() {
  const { branding, refresh } = useBranding()
  const { t } = useI18n()

  const [title, setTitle] = useState(branding.customTitle ? branding.title : '')
  const [savingTitle, setSavingTitle] = useState(false)
  const [titleMessage, setTitleMessage] = useState<string | null>(null)

  const [logoBusy, setLogoBusy] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [draft, setDraft] = useState<GenerateLogoResult | null>(null)
  const [generateError, setGenerateError] = useState<string | null>(null)

  // A save elsewhere (or the initial fetch finishing) refreshes the form's
  // starting point — but never while the admin is mid-edit in this panel.
  useEffect(() => {
    if (!savingTitle) setTitle(branding.customTitle ? branding.title : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branding.title, branding.customTitle])

  const saveTitle = async (e: FormEvent) => {
    e.preventDefault()
    if (savingTitle) return
    setSavingTitle(true)
    setTitleMessage(null)
    try {
      const next: Branding = await api.updateBranding(title.trim() || null)
      await refresh()
      setTitleMessage(next.customTitle ? t('providers.brandTitleSaved') : t('providers.brandTitleReset'))
    } catch (err) {
      setTitleMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingTitle(false)
    }
  }

  const uploadLogo = async (file: File) => {
    setLogoBusy(true)
    setLogoError(null)
    try {
      await api.uploadBrandingLogo(file)
      await refresh()
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : String(err))
    } finally {
      setLogoBusy(false)
    }
  }

  const removeLogo = async () => {
    setLogoBusy(true)
    setLogoError(null)
    try {
      await api.deleteBrandingLogo()
      await refresh()
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : String(err))
    } finally {
      setLogoBusy(false)
    }
  }

  const generate = async () => {
    if (generating) return
    setGenerating(true)
    setGenerateError(null)
    try {
      setDraft(await api.generateBrandingLogo(prompt))
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const applyDraft = async () => {
    if (!draft) return
    setLogoBusy(true)
    setLogoError(null)
    try {
      await api.setBrandingLogoSvg(draft.svg)
      await refresh()
      setDraft(null)
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : String(err))
    } finally {
      setLogoBusy(false)
    }
  }

  return (
    <div className="branding-panel">
      <form className="branding-title-row" onSubmit={saveTitle}>
        <label className="branding-label" htmlFor="branding-title">
          {t('providers.brandInstanceName')}
        </label>
        <div className="branding-title-controls">
          <input
            id="branding-title"
            type="text"
            maxLength={60}
            placeholder="BeeDocs"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={savingTitle}
          />
          <button type="submit" className="btn sm primary" disabled={savingTitle}>
            {savingTitle ? t('common.saving') : t('common.save')}
          </button>
          {branding.customTitle && (
            <button
              type="button"
              className="btn sm"
              disabled={savingTitle}
              onClick={() => {
                setTitle('')
                void api.updateBranding(null).then(() => refresh())
              }}
            >
              {t('providers.brandResetTitle')}
            </button>
          )}
        </div>
        <p className="muted sm settings-hint">{t('providers.brandTitleHint')}</p>
        {titleMessage && <p className="muted sm">{titleMessage}</p>}
      </form>

      <div className="branding-logo-block">
        <span className="branding-label">{t('providers.brandLogo')}</span>
        <div className="branding-logo-row">
          <span className="branding-logo-preview" aria-hidden>
            {branding.logoUrl ? (
              <img src={withApiBase(branding.logoUrl)} alt={t('providers.brandCurrentLogo')} />
            ) : (
              <span className="branding-logo-emoji">🐝</span>
            )}
          </span>
          <div className="branding-logo-actions">
            <button
              type="button"
              className="btn sm"
              disabled={logoBusy}
              onClick={() => fileInput.current?.click()}
            >
              {t('providers.brandUploadImage')}
            </button>
            {branding.logoUrl && (
              <button type="button" className="btn sm" disabled={logoBusy} onClick={removeLogo}>
                {t('providers.brandRemoveLogo')}
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept=".svg,.png,.jpg,.jpeg,.webp,image/svg+xml,image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void uploadLogo(file)
              }}
            />
          </div>
        </div>
        <p className="muted sm settings-hint">{t('providers.brandLogoHint')}</p>
        {logoError && <p className="branding-error">{logoError}</p>}
      </div>

      <div className="branding-generate">
        <label className="branding-label" htmlFor="branding-prompt">
          {t('providers.brandGenerateLabel')}
        </label>
        <textarea
          id="branding-prompt"
          rows={2}
          placeholder={t('providers.brandPromptPlaceholder')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={generating}
        />
        <div className="branding-generate-actions">
          <button type="button" className="btn sm primary" disabled={generating} onClick={generate}>
            {generating
              ? t('providers.brandGenerating')
              : draft
                ? t('providers.brandGenerateAnother')
                : t('providers.brandGenerate')}
          </button>
          <span className="muted sm">{t('providers.brandGenerateHint')}</span>
        </div>
        {generateError && <p className="branding-error">{generateError}</p>}

        {draft && (
          <div className="branding-draft">
            {/* Sanitized server-side before it ever reaches the browser. */}
            <span
              className="branding-logo-preview branding-draft-preview"
              dangerouslySetInnerHTML={{ __html: draft.svg }}
            />
            <div className="branding-logo-actions">
              <button type="button" className="btn sm primary" disabled={logoBusy} onClick={applyDraft}>
                {t('providers.brandUseLogo')}
              </button>
              <button type="button" className="btn sm" disabled={logoBusy} onClick={() => setDraft(null)}>
                {t('providers.brandDiscard')}
              </button>
              <span className="muted sm">
                {draft.providerName} · {draft.model}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
