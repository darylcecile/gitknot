import type { App } from '@gitknot/core';
import { selectIdentityDatabase } from '@gitknot/core/authority';
import { registerMfaRoutes } from './identity/mfa.ts';
import { registerPasskeyRoutes } from './identity/passkeys.ts';
import { registerPasswordRoutes } from './identity/passwords.ts';
import { registerProfileRoutes } from './identity/profile.ts';
import { registerSessionRoutes } from './identity/sessions.ts';
import { registerTokenRoutes } from './identity/tokens.ts';

export function registerIdentityRoutes(app: App): void {
  app.use('/v1/*', async (c, next) => {
    const path = c.req.path;
    const identity = /^\/v1\/(?:auth|me|users|tokens|invitations|applications)(?:\/|$)/.test(path)
      || /^\/v1\/orgs(?:\/[^/]+(?:\/(?:members|teams|invitations|roles|policy|identities|installations|rules)(?:\/.*)?)?)?$/.test(path)
      || /^\/v1\/accounts\/[^/]+(?:\/(?:roles|policy|grants|identities|applications|installations)(?:\/.*)?)?$/.test(path)
      || /^\/v1\/repos\/[^/]+\/(?:roles|collaborators|invitations)(?:\/|$)/.test(path);
    if (identity && !/^\/v1\/users\/[^/]+\/repos(?:\/|$)/.test(path)) selectIdentityDatabase(c);
    await next();
  });
  registerPasswordRoutes(app);
  registerProfileRoutes(app);
  registerSessionRoutes(app);
  registerMfaRoutes(app);
  registerPasskeyRoutes(app);
  registerTokenRoutes(app);
}
