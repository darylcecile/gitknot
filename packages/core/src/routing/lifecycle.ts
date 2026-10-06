/** These fixed callbacks authenticate an attempt cleanup capability themselves. */
export function repositoryCleanupRequest(request: Request): boolean {
  if (request.method !== 'POST') return false;
  const path = new URL(request.url).pathname;
  return /^\/internal\/hosted\/attempts\/att_[A-Za-z0-9_-]{1,120}\/destroyed$/.test(path)
    || /^\/v1\/attempts\/att_[A-Za-z0-9_-]{1,120}\/terminated$/.test(path);
}
