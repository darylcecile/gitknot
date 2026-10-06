import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { request, setViewerGrant } from "../api/client.ts";
import { endpoints, repoLink } from "../api/endpoints.ts";
import { array, type Entity } from "../api/types.ts";
import { Button, ErrorNotice, PageHeader, Panel } from "../components/ui.tsx";

export function ViewerPage() {
  const { repoId = "" } = useParams();
  const [token, setToken] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("token") || "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (location.hash)
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
  }, []);
  return (
    <>
      <PageHeader
        title="Open a private viewer link"
        description="This expiring grant is held only in memory and is reauthorized by GitKnot on every request."
      />
      <Panel>
        <form
          className="resource-form"
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            setError(null);
            setViewerGrant({ repoId, token });
            void request<Entity>("/v1/tokens/current")
              .then((credential) => {
                const repositories = array<string>(
                  credential.data.repository_ids,
                );
                if (
                  credential.data.kind !== "viewer" ||
                  repositories.length !== 1 ||
                  repositories[0] !== repoId
                )
                  throw new Error(
                    "This link requires a viewer grant scoped to this repository.",
                  );
                return request(endpoints.repo(repoId));
              })
              .then(() => navigate(repoLink(repoId), { replace: true }))
              .catch((cause) => {
                setViewerGrant(null);
                setError(
                  cause instanceof Error
                    ? cause
                    : new Error("The viewer grant could not be verified."),
                );
              })
              .finally(() => setPending(false));
          }}
        >
          <div className="field">
            <label htmlFor="viewer-token">Viewer grant</label>
            <input
              id="viewer-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              required
            />
          </div>
          <ErrorNotice error={error} />
          <div className="form-actions">
            <Button type="submit" variant="primary" busy={pending}>
              Open repository
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
}
