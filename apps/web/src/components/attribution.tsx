import { useAuth } from "../auth-context.ts";
import { record, text } from "../api/types.ts";

/** Use only summaries returned with the authorized resource, or this user's own session. */
export function useAttribution(value: Record<string, unknown>) {
  const { session } = useAuth();
  const summary = record(value.author || value.actor);
  const id = text(
    summary.id || value.author_id || value.actor_id || value.created_by,
  );
  const own = session?.user.id === id ? session.user : null;
  const username = text(summary.username || own?.username);
  const named = text(
    summary.display_name ||
      summary.name ||
      value.author_name ||
      value.actor_name ||
      own?.display_name ||
      username,
  );
  return {
    id,
    name: named && named !== id ? named : "Contributor",
    username,
    avatar: text(summary.avatar_url || own?.avatar_url),
    detail: username ? `@${username}` : id ? `Principal ${id}` : undefined,
  };
}

export function Attribution({ value }: { value: Record<string, unknown> }) {
  const actor = useAttribution(value);
  return (
    <span className="attribution" title={actor.detail}>
      {actor.name}
    </span>
  );
}
