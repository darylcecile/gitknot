import { createSecretsBroker, sweepVault } from '@gitknot/secrets';
import type { SecretsBrokerBindings } from '@gitknot/secrets';
import { handleFederationBrokerRequest } from '@gitknot/federation/broker';
import { sweepFederationState } from '@gitknot/federation';
import { federationVaultBindings } from '@gitknot/secrets/federation';
import { vaultEnvironment } from '@gitknot/secrets/authority';

const app = createSecretsBroker();

export default {
  fetch(request: Request, env: SecretsBrokerBindings, ctx: ExecutionContext): Response | Promise<Response> {
    env = vaultEnvironment(env);
    if (new URL(request.url).pathname.startsWith('/internal/federation/')) {
      return handleFederationBrokerRequest(request, federationVaultBindings(env, request), ctx);
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: SecretsBrokerBindings): Promise<void> {
    env = vaultEnvironment(env);
    const result = await sweepVault(env);
    await sweepFederationState(env.DB);
    if (result.failed) throw new Error(`vault_maintenance_incomplete:${result.failed}`);
  },
} satisfies ExportedHandler<SecretsBrokerBindings>;
