import type { App } from '@gitknot/core';
import { registerCatalogRoutes } from './repositories/catalog.ts';
import { registerRepositoryLifecycleRoutes } from './repositories/lifecycle.ts';
import { registerRepositoryPermissionRoutes } from './repositories/permissions.ts';
import { registerRepositoryRuleRoutes } from './repositories/rules.ts';

export { sweepRepositoryCatalog } from './repositories/lifecycle.ts';
export { effectiveRepositoryRules, repositoryRuleSchema, ruleConflicts, ruleObligations } from './repositories/rules.ts';

export function registerRepositoryRoutes(app: App): void {
  registerCatalogRoutes(app);
  registerRepositoryPermissionRoutes(app);
  registerRepositoryRuleRoutes(app);
  registerRepositoryLifecycleRoutes(app);
}
