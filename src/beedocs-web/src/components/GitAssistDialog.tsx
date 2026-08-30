import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { bumpGitStatus } from '../hooks/useGitRepos'
import { gitFilePath } from '../gitPaths'
import { MarkdownView } from './MarkdownView'
import type { GitAssistKind, GitAssistResult, GitRepo } from '../types'
import '../styles/git.css'

const KIND_COPY: Record<GitAssistKind, { title: string; blurb: string }> = {
  readme: {
    title: 'Draft a README',
    blurb: 'What the project is, how to build and run it, basic usage — grounded in the repo.',
  },
  documentation: {
    title: 'Draft developer documentation',
    blurb: 'Architecture overview, components and how they interact — for a developer new to the codebase.',
  },
  manual: {
    title: 'Draft a user manual',
    blurb: 'Getting started, features, how to accomplish the main tasks — for a user, not a developer.',
  },
  summary: {
    title: 'Summarize the repository',
    blurb: 'Purpose, tech stack, structure and notable details, in about a page.',
  },
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * One AI drafting action against a repo, start to finish: optional extra
 * instructions → generate (the server reads the clone and asks the configured
 * LLM provider) → review the rendered draft → save it into the working tree.
 * The save is the ordinary blob-guarded write, so an AI draft enters history
 * only through the same review/commit gate as any human edit.
 */
export function GitAssistDialog({
  repo,
  kind,
  onClose,
}: {
  repo: GitRepo
  kind: GitAssistKind
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [instructions, setInstructions] = useState('')
  const [path, setPath] = useState('')
  const [result, setResult] = useState<GitAssistResult | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const copy = KIND_COPY[kind]

  useEffect(() => () => abortRef.current?.abort(), [])

  // Esc closes — but never mid-generation without asking, the draft cost money.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const generate = async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setGenerating(true)
    setError(null)
    try {
      const next = await api.gitAssist(
        repo.id,
        { kind, instructions: instructions.trim() || undefined },
        ctrl.signal,
      )
      if (ctrl.signal.aborted) return
      setResult(next)
      setShowSource(false)
      setPath((p) => p || next.suggestedPath || 'docs/DRAFT.md')
    } catch (e) {
      if (!ctrl.signal.aborted) setError(errText(e))
    } finally {
      if (abortRef.current === ctrl) setGenerating(false)
    }
  }

  const save = async () => {
    if (!result || saving) return
    const target = path.trim()
    if (target === '') return
    setSaving(true)
    setError(null)
    try {
      // Overwrite-aware: an existing file's blob sha rides along so the save
      // fails honestly if someone changed it since the dialog opened.
      let baseBlobSha: string | null = null
      try {
        baseBlobSha = (await api.getGitFile(repo.id, target)).blobSha
      } catch {
        // Not there yet — a create.
      }
      await api.writeGitFile(repo.id, target, result.markdown, baseBlobSha)
      bumpGitStatus()
      onClose()
      void navigate(gitFilePath(repo.id, target))
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="git-dialog-overlay"
      onMouseDown={() => {
        if (!generating && !saving) onClose()
      }}
      role="presentation"
    >
      <div
        className="git-dialog git-assist-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>
          ✨ {copy.title} — {repo.name}
        </h3>
        <p className="muted sm">{copy.blurb}</p>

        {result === null ? (
          <>
            <label className="git-assist-field">
              <span>Extra instructions (optional)</span>
              <textarea
                rows={3}
                placeholder="Audience, focus, tone, sections to include…"
                value={instructions}
                autoFocus
                disabled={generating}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </label>
            <p className="muted sm">
              The server reads the repository (tree, README, manifests, docs, key sources) and asks
              your default AI provider — configure providers under Settings → AI providers. Nothing
              is written until you review and save the draft.
            </p>
          </>
        ) : (
          <>
            <p className="git-assist-meta muted sm">
              {result.providerName}
              {result.model ? ` · ${result.model}` : ''} · {(result.elapsedMs / 1000).toFixed(1)}s
              {result.completionTokens != null ? ` · ${result.completionTokens} tokens` : ''} ·
              grounded in {result.contextFiles.length} file
              {result.contextFiles.length === 1 ? '' : 's'}
              <button type="button" className="btn ghost sm" onClick={() => setShowSource((v) => !v)}>
                {showSource ? 'Preview' : 'Source'}
              </button>
            </p>
            <div className="git-assist-preview">
              {showSource ? (
                <pre className="git-code">
                  <code>{result.markdown}</code>
                </pre>
              ) : (
                <MarkdownView content={result.markdown} />
              )}
            </div>
            <label className="git-assist-field git-assist-path">
              <span>Save in the repo as</span>
              <input
                className="llm-mono"
                spellCheck={false}
                value={path}
                disabled={saving}
                onChange={(e) => setPath(e.target.value)}
              />
            </label>
          </>
        )}

        {error ? (
          <p className="banner error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="git-dialog-actions">
          <button type="button" className="btn sm" disabled={saving} onClick={onClose}>
            {result ? 'Discard' : 'Cancel'}
          </button>
          {result !== null ? (
            <>
              <button
                type="button"
                className="btn sm"
                disabled={generating || saving}
                onClick={() => void navigator.clipboard?.writeText(result.markdown)}
              >
                Copy Markdown
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={generating || saving}
                onClick={() => {
                  setResult(null)
                  setError(null)
                }}
              >
                Adjust &amp; regenerate
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={saving || path.trim() === ''}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save draft to repo'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn primary sm"
              disabled={generating}
              onClick={() => void generate()}
            >
              {generating ? 'Generating… (can take a minute)' : 'Generate draft'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
