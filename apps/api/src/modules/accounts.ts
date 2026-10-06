import type { App } from '@gitknot/core';
import { registerMachineIdentityRoutes } from './accounts/identities.ts';
import { registerInvitationRoutes } from './accounts/invitations.ts';
import { registerMembershipRoutes, registerTeamRoutes } from './accounts/members-teams.ts';
import { registerOrganizationRoutes } from './accounts/organizations.ts';
import { registerAccountPermissionRoutes } from './accounts/roles-policy.ts';

export function registerAccountRoutes(app: App): void {
  registerOrganizationRoutes(app);
  registerMembershipRoutes(app);
  registerTeamRoutes(app);
  registerInvitationRoutes(app);
  registerAccountPermissionRoutes(app);
  registerMachineIdentityRoutes(app);
}
