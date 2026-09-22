import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useI18n } from '../i18n'
import type { WordCloud as WordCloudData, WordCloudEntry } from '../types'
import '../styles/wordcloud.css'

const COLLAPSED_KEY = 'beedocs-cloud-collapsed'

/** Font sizes (rem) of the least and most used word shown. */
const MIN_REM = 0.8
const MAX_REM = 2.9

/** Accent-family hues, cycled by rank so neighbouring words differ. */
const TONES = 6

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Most used words first, then dealt alternately to the front and the back —
 * the biggest words end up in the middle of the cloud and the small ones at
 * its edges, instead of a list sorted by size.
 */
function arrange(words: WordCloudEntry[]): WordCloudEntry[] {
  const out: WordCloudEntry[] = []
  words.forEach((w, i) => (i % 2 === 0 ? out.push(w) : out.unshift(w)))
  return out
}

/**
 * "Cloud points": the most used words across a book's (or a shelf's)
 * documents — pages, diagram labels, slides, boards, plans, notes and the
 * text inside uploaded files — sized by how often they occur. Counted by the
 * server from the search index, so only documents the viewer can see count.
 * Clicking a word searches the library for it.
 */
export function WordCloud({
  scope,
  id,
  refreshKey,
  onSearch,
}: {
  scope: 'book' | 'shelf'
  id: string
  /** Changes when the scope's content does — the cloud is fetched again. */
  refreshKey?: string
  onSearch: (word: string) => void
}) {
  const { t } = useI18n()
  const [cloud, setCloud] = useState<WordCloudData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  useEffect(() => {
    if (collapsed) return
    let cancelled = false
    const load = scope === 'book' ? api.getBookWordCloud(id) : api.getShelfWordCloud(id)
    load
      .then((next) => {
        if (cancelled) return
        setCloud(next)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [scope, id, refreshKey, collapsed])

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      /* a per-browser nicety only */
    }
  }

  const words = useMemo(() => {
    if (!cloud || cloud.words.length === 0) return []
    const counts = cloud.words.map((w) => w.count)
    const max = Math.max(...counts)
    const min = Math.min(...counts)
    const rank = new Map(cloud.words.map((w, i) => [w.word, i]))
    return arrange(cloud.words).map((w) => {
      // Square root, so one dominant word does not shrink everything else to the floor.
      const share = max === min ? 1 : Math.sqrt((w.count - min) / (max - min))
      return {
        ...w,
        size: MIN_REM + (MAX_REM - MIN_REM) * share,
        tone: (rank.get(w.word) ?? 0) % TONES,
        weight: share > 0.55 ? 700 : share > 0.25 ? 600 : 500,
      }
    })
  }, [cloud])

  const current = cloud && cloud.id === id ? cloud : null

  return (
    <section className="word-cloud" aria-label={t('cloud.title')}>
      <div className="word-cloud-head">
        <h2 className="book-overview-subhead">☁️ {t('cloud.title')}</h2>
        <button type="button" className="btn ghost sm" onClick={toggle} aria-expanded={!collapsed}>
          {collapsed ? t('cloud.show') : t('cloud.hide')}
        </button>
      </div>
      {!collapsed && (
        <>
          {error && <div className="banner error compact">{error}</div>}
          {current && current.words.length > 0 && (
            <p className="muted sm word-cloud-sub">
              {t(current.documents === 1 ? 'cloud.subtitleOne' : 'cloud.subtitle', { n: current.documents })}
            </p>
          )}
          {current && current.words.length === 0 && <p className="muted sm">{t('cloud.empty')}</p>}
          {current && words.length > 0 && (
            <ul className="word-cloud-words" aria-label={t('cloud.aria')}>
              {words.map((w) => (
                <li key={w.word}>
                  <button
                    type="button"
                    className={`word-cloud-word tone-${w.tone}`}
                    style={{ fontSize: `${w.size.toFixed(2)}rem`, fontWeight: w.weight }}
                    title={t('cloud.wordTitle', { word: w.word, count: w.count, docs: w.documents })}
                    onClick={() => onSearch(w.word)}
                  >
                    {w.word}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
