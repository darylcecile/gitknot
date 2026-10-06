import {
  Component,
  Suspense,
  lazy,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Navigate, Route, Routes } from "react-router";
import { AuthPage, RequireAuth } from "./auth.tsx";
import { AppLayout } from "./components/layout.tsx";
import { Button, Loading } from "./components/ui.tsx";

function page<T, K extends keyof T>(load: () => Promise<T>, name: K) {
  return lazy(async () => ({ default: (await load())[name] as ComponentType }));
}
const Home = page(() => import("./pages/home.tsx"), "HomePage");
const Inbox = page(() => import("./pages/home.tsx"), "InboxPage");
const Search = page(() => import("./pages/home.tsx"), "SearchPage");
const SearchScan = page(() => import("./pages/home.tsx"), "SearchScanPage");
const Profile = page(() => import("./pages/home.tsx"), "ProfilePage");
const Repositories = page(
  () => import("./pages/repositories.tsx"),
  "RepositoriesPage",
);
const NewRepository = page(
  () => import("./pages/repositories.tsx"),
  "NewRepositoryPage",
);
const ImportRepository = lazy(async () => {
  const { NewRepositoryPage } = await import("./pages/repositories.tsx");
  return { default: () => <NewRepositoryPage importing /> };
});
const Repository = page(
  () => import("./pages/repositories.tsx"),
  "RepositoryLayout",
);
const Code = page(() => import("./pages/repositories.tsx"), "CodePage");
const EditFile = page(() => import("./pages/repositories.tsx"), "EditFilePage");
const History = page(() => import("./pages/repositories.tsx"), "HistoryPage");
const Commit = page(() => import("./pages/repositories.tsx"), "CommitPage");
const Refs = page(() => import("./pages/repositories.tsx"), "RefsPage");
const GitOperation = page(
  () => import("./pages/repositories.tsx"),
  "GitOperationPage",
);
const Compare = page(() => import("./pages/diff.tsx"), "ComparePage");
const IssueManagement = page(
  () => import("./pages/collaboration.tsx"),
  "IssueManagementPage",
);
const Categories = page(
  () => import("./pages/collaboration.tsx"),
  "DiscussionCategoriesPage",
);
const collaboration = (
  kind: "issues" | "pulls" | "discussions" | "tasks",
  detail = false,
) =>
  lazy(async () => {
    const { CollaborationList, CollaborationDetail } =
      await import("./pages/collaboration.tsx");
    return {
      default: () =>
        detail ? (
          <CollaborationDetail kind={kind} />
        ) : (
          <CollaborationList kind={kind} />
        ),
    };
  });
const Issues = collaboration("issues");
const Issue = collaboration("issues", true);
const Pulls = collaboration("pulls");
const Pull = collaboration("pulls", true);
const Discussions = collaboration("discussions");
const Discussion = collaboration("discussions", true);
const Tasks = collaboration("tasks");
const Task = collaboration("tasks", true);
const Workflows = page(() => import("./pages/workflows.tsx"), "WorkflowsPage");
const Workflow = page(() => import("./pages/workflows.tsx"), "WorkflowPage");
const ValidateWorkflow = page(
  () => import("./pages/workflows.tsx"),
  "ValidateWorkflowPage",
);
const Plan = page(() => import("./pages/workflows.tsx"), "PlanPage");
const Run = page(() => import("./pages/workflows.tsx"), "RunPage");
const Environments = page(
  () => import("./pages/workflows.tsx"),
  "EnvironmentsPage",
);
const Environment = page(
  () => import("./pages/settings.tsx"),
  "EnvironmentPage",
);
const RepositorySettings = page(
  () => import("./pages/settings.tsx"),
  "RepositorySettingsPage",
);
const Webhook = page(() => import("./pages/settings.tsx"), "WebhookPage");
const Accounts = page(() => import("./pages/settings.tsx"), "AccountsPage");
const Account = page(() => import("./pages/settings.tsx"), "AccountPage");
const AccountExport = page(
  () => import("./pages/account-exports.tsx"),
  "AccountExportPage",
);
const Team = page(() => import("./pages/settings.tsx"), "TeamPage");
const Invitations = page(
  () => import("./pages/settings.tsx"),
  "InvitationsPage",
);
const RepositoryRunners = page(
  () => import("./pages/settings.tsx"),
  "RepositoryRunnersPage",
);
const RunnerPool = page(() => import("./pages/settings.tsx"), "RunnerPoolPage");
const PersonalSettings = page(
  () => import("./pages/personal-settings.tsx"),
  "PersonalSettingsPage",
);
const BillingIndex = page(
  () => import("./pages/billing.tsx"),
  "BillingIndexPage",
);
const Billing = page(() => import("./pages/billing.tsx"), "BillingPage");
const Invoice = page(() => import("./pages/billing.tsx"), "InvoicePage");
const FederationProvider = page(
  () => import("./pages/federation.tsx"),
  "FederationProviderPage",
);
const Transfer = page(() => import("./pages/settings.tsx"), "TransferPage");
const Viewer = page(() => import("./pages/viewer.tsx"), "ViewerPage");
const FederationLogin = page(
  () => import("./pages/federation.tsx"),
  "FederationSignIn",
);
const Operation = page(() => import("./pages/operations.tsx"), "OperationPage");
const Help = page(() => import("./pages/operations.tsx"), "HelpPage");
const Documentation = page(
  () => import("./pages/documentation.tsx"),
  "DocumentationPage",
);
const Support = page(() => import("./pages/documentation.tsx"), "SupportPage");
const NotFound = page(() => import("./pages/operations.tsx"), "NotFoundPage");

export function App() {
  return (
    <AppErrorBoundary>
      <Suspense fallback={<Loading label="Opening your workspace" />}>
        <Routes>
          <Route
            path="auth/sso"
            element={
              <main className="auth-content">
                <FederationLogin />
              </main>
            }
          />
          <Route path="auth/:action" element={<AuthPage />} />
          <Route path="login" element={<Navigate to="/auth/login" replace />} />
          <Route
            path="signup"
            element={<Navigate to="/auth/signup" replace />}
          />
          <Route element={<AppLayout />}>
            <Route
              index
              element={
                <RequireAuth>
                  <Home />
                </RequireAuth>
              }
            />
            <Route
              path="inbox"
              element={
                <RequireAuth>
                  <Inbox />
                </RequireAuth>
              }
            />
            <Route
              path="inbox/:notificationId"
              element={
                <RequireAuth>
                  <Inbox />
                </RequireAuth>
              }
            />
            <Route path="search" element={<Search />} />
            <Route path="viewer/:repoId" element={<Viewer />} />
            <Route
              path="search/scans/:scanId"
              element={
                <RequireAuth>
                  <SearchScan />
                </RequireAuth>
              }
            />
            <Route path="users/:username" element={<Profile />} />
            <Route path="repos" element={<Repositories />} />
            <Route
              path="repos/new"
              element={
                <RequireAuth>
                  <NewRepository />
                </RequireAuth>
              }
            />
            <Route
              path="repos/import"
              element={
                <RequireAuth>
                  <ImportRepository />
                </RequireAuth>
              }
            />
            <Route path="repos/:repoId" element={<Repository />}>
              <Route index element={<Code />} />
              <Route path="code/*" element={<Code />} />
              <Route
                path="edit"
                element={
                  <RequireAuth>
                    <EditFile />
                  </RequireAuth>
                }
              />
              <Route path="history" element={<History />} />
              <Route path="commits/:commitId" element={<Commit />} />
              <Route path="compare" element={<Compare />} />
              <Route path="refs" element={<Refs />} />
              <Route
                path="git/operations/:operationId"
                element={<GitOperation />}
              />
              <Route path="issues" element={<Issues />} />
              <Route path="issues/manage" element={<IssueManagement />} />
              <Route path="issues/:itemId" element={<Issue />} />
              <Route path="pulls" element={<Pulls />} />
              <Route path="pulls/:itemId" element={<Pull />} />
              <Route path="discussions" element={<Discussions />} />
              <Route path="discussions/categories" element={<Categories />} />
              <Route path="discussions/:itemId" element={<Discussion />} />
              <Route path="tasks" element={<Tasks />} />
              <Route path="tasks/:itemId" element={<Task />} />
              <Route path="workflows" element={<Workflows />} />
              <Route path="workflows/validate" element={<ValidateWorkflow />} />
              <Route path="workflows/:workflowId" element={<Workflow />} />
              <Route path="plans/:planId" element={<Plan />} />
              <Route path="runs/:runId" element={<Run />} />
              <Route path="environments" element={<Environments />} />
              <Route
                path="environments/:environmentId"
                element={<Environment />}
              />
              <Route path="runners" element={<RepositoryRunners />} />
              <Route path="runners/:poolId" element={<RunnerPool />} />
              <Route path="settings" element={<RepositorySettings />} />
              <Route
                path="settings/:section"
                element={<RepositorySettings />}
              />
              <Route
                path="settings/webhooks/:webhookId"
                element={<Webhook />}
              />
            </Route>
            <Route
              path="accounts"
              element={
                <RequireAuth>
                  <Accounts />
                </RequireAuth>
              }
            />
            <Route
              path="accounts/:accountId"
              element={
                <RequireAuth>
                  <Account />
                </RequireAuth>
              }
            />
            <Route
              path="accounts/:accountId/exports/:exportId"
              element={
                <RequireAuth>
                  <AccountExport />
                </RequireAuth>
              }
            />
            <Route
              path="accounts/:accountId/:section"
              element={
                <RequireAuth>
                  <Account />
                </RequireAuth>
              }
            />
            <Route
              path="accounts/:accountId/teams/:teamId"
              element={
                <RequireAuth>
                  <Team />
                </RequireAuth>
              }
            />
            <Route
              path="accounts/:accountId/sso/:providerId"
              element={
                <RequireAuth>
                  <FederationProvider />
                </RequireAuth>
              }
            />
            <Route
              path="accounts/:accountId/runners/:poolId"
              element={
                <RequireAuth>
                  <RunnerPool />
                </RequireAuth>
              }
            />
            <Route
              path="invitations"
              element={
                <RequireAuth>
                  <Invitations />
                </RequireAuth>
              }
            />
            <Route
              path="invitations/:invitationId"
              element={
                <RequireAuth>
                  <Invitations />
                </RequireAuth>
              }
            />
            <Route
              path="transfers/:repoId/:transferId"
              element={
                <RequireAuth>
                  <Transfer />
                </RequireAuth>
              }
            />
            <Route
              path="settings"
              element={
                <RequireAuth>
                  <PersonalSettings />
                </RequireAuth>
              }
            />
            <Route
              path="settings/:section"
              element={
                <RequireAuth>
                  <PersonalSettings />
                </RequireAuth>
              }
            />
            <Route
              path="billing"
              element={
                <RequireAuth>
                  <BillingIndex />
                </RequireAuth>
              }
            />
            <Route
              path="billing/:accountId"
              element={
                <RequireAuth>
                  <Billing />
                </RequireAuth>
              }
            />
            <Route
              path="billing/:accountId/:section"
              element={
                <RequireAuth>
                  <Billing />
                </RequireAuth>
              }
            />
            <Route
              path="billing/:accountId/invoices/:invoiceId"
              element={
                <RequireAuth>
                  <Invoice />
                </RequireAuth>
              }
            />
            <Route
              path="operations/:operationId"
              element={
                <RequireAuth>
                  <Operation />
                </RequireAuth>
              }
            />
            <Route path="help" element={<Help />} />
            <Route path="docs" element={<Documentation />} />
            <Route path="docs/:guide" element={<Documentation />} />
            <Route path="support" element={<Support />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </AppErrorBoundary>
  );
}

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* The recovery screen is independent of the failed route. */
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error">
        <img src="/favicon.svg" alt="GitKnot" width="44" height="44" />
        <h1>We couldn’t open this view.</h1>
        <p>
          Your server data is safe. Unsaved non-sensitive drafts remain in this
          browser tab.
        </p>
        <p role="alert">{this.state.error.message}</p>
        <Button variant="primary" onClick={() => location.reload()}>
          Reload GitKnot
        </Button>
        <a href="/">Return to your workspace</a>
      </main>
    );
  }
}
