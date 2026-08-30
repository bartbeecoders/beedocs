/** Route to a file inside a git repo, path segments escaped one by one. */
export function gitFilePath(repoId: string, path: string): string {
  return `/git/${repoId}/files/` + path.split('/').map(encodeURIComponent).join('/')
}
