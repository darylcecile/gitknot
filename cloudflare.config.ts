import { defineConfig } from 'cf/config';
import { environment } from './infra/environment.ts';

// Resource commands read only account settings. Build/dev use the complete
// per-Worker configs through scripts/build.ts and scripts/dev.ts.
export default defineConfig(({ mode }) => {
  const env = environment(mode);
  return env.accounts.trusted ? { accountId: env.accounts.trusted } : {};
});
