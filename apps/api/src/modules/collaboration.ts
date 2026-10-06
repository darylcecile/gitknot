import type { App } from '@gitknot/core';
import { registerIssueRoutes } from './collaboration/issues.ts';
import { registerPullRoutes } from './collaboration/pulls.ts';
import { registerDiscussionRoutes } from './collaboration/discussions.ts';
import { registerTaskRoutes } from './collaboration/tasks.ts';
import { registerConversationRoutes } from './collaboration/conversations.ts';
import { registerPersonalRoutes } from './collaboration/personal.ts';
import { registerSearchRoutes } from './collaboration/search.ts';
import { registerCollaborationOperationRoutes } from './collaboration/operations.ts';
import { registerCollaborationReplayGuard } from './collaboration/replay.ts';
import { registerGlobalReadRoutes } from './collaboration/global-read-source.ts';

export function registerCollaborationRoutes(app: App): void {
  registerGlobalReadRoutes(app);
  registerCollaborationReplayGuard(app);
  registerIssueRoutes(app);
  registerPullRoutes(app);
  registerDiscussionRoutes(app);
  registerTaskRoutes(app);
  registerConversationRoutes(app);
  registerPersonalRoutes(app);
  registerSearchRoutes(app);
  registerCollaborationOperationRoutes(app);
}

export { runCollaborationOperation, sweepCollaboration } from './collaboration/operations.ts';
export { getMergeEligibility } from './collaboration/merge.ts';
export { canReadItem as authorizeCollaborationReference } from './collaboration/common.ts';
export { readInboxForDelivery } from './collaboration/personal.ts';
export { inboxDeliveryUserStateGuards } from './collaboration/personal-inbox.ts';
export type { InboxDeliveryUserState } from './collaboration/personal-inbox.ts';
export { authorizeAttachmentObject, sweepAttachmentStorage } from './collaboration/attachment-storage.ts';
export { collaborationUserStateInventory } from './collaboration/user-state.ts';
