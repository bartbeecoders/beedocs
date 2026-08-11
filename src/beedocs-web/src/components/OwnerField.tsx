import { useAuth } from '../auth/AuthContext'
import { useUserDirectory, userLabel } from '../hooks/useUserDirectory'

type Props = {
  /** Account id, or "" for unassigned. */
  value: string
  /** Called with an account id, or "" to clear the owner. */
  onChange: (ownerId: string) => void
  /**
   * The name the server resolved for the current owner. Shown when the account
   * is not in the directory — deleted or disabled — so a stale owner reads as a
   * name rather than as "Unassigned".
   */
  fallbackName?: string | null
  disabled?: boolean
}

/**
 * Picks the account answerable for a book or page.
 *
 * Read-only accounts get plain text: they can see who owns a document, which is
 * half the point of recording it, but the API would refuse the change.
 */
export function OwnerField({ value, onChange, fallbackName, disabled }: Props) {
  const { canWrite } = useAuth()
  const { users } = useUserDirectory()

  // The server already resolved the owner's name, so the read-only view needs
  // no directory at all.
  if (!canWrite) {
    return <span>{value ? fallbackName || 'Unknown account' : 'Unassigned'}</span>
  }

  const known = users.some((u) => u.id === value)

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">Unassigned</option>
      {/* An owner whose account was deleted or disabled is still the owner. Keep
          it as an option so opening the picker cannot silently reassign it. */}
      {value !== '' && !known && (
        <option value={value}>{fallbackName || 'Unknown account'}</option>
      )}
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {userLabel(u)}
        </option>
      ))}
    </select>
  )
}
