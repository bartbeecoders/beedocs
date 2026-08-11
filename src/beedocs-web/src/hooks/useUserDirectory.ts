import { useEffect, useState } from 'react'
import { api } from '../api'
import type { UserSummary } from '../types'

/**
 * The list of accounts an owner can be set to.
 *
 * Cached at module scope because every owner picker wants the same list and the
 * properties pane remounts it on each navigation — without this, clicking
 * through ten pages is ten identical requests. The cache is a promise, so
 * pickers that mount together share one in-flight call rather than racing.
 */
let cached: Promise<UserSummary[]> | null = null

function load(): Promise<UserSummary[]> {
  cached ??= api.listUserDirectory().catch((e: unknown) => {
    // A failure must not be cached: the next mount should try again, and the
    // most likely cause is a session that just ended.
    cached = null
    throw e
  })
  return cached
}

/** Drop the cache after anything that changes the account list. */
export function refreshUserDirectory() {
  cached = null
}

export function useUserDirectory(): { users: UserSummary[]; loading: boolean } {
  const [users, setUsers] = useState<UserSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    load()
      .then((list) => !cancelled && setUsers(list))
      // An owner picker that cannot list accounts falls back to showing the
      // stored name; failing loudly here would be noise in a side panel.
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  return { users, loading }
}

/** How an account is labelled in a picker: display name, falling back to the login name. */
export function userLabel(user: UserSummary): string {
  return user.displayName?.trim() || user.username
}
