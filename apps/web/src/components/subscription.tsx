import { useState } from "react";
import { useResource } from "../api/hooks.ts";
import { revisionSnapshot } from "../api/client.ts";
import { query } from "../api/endpoints.ts";
import type { Entity } from "../api/types.ts";
import { ResourceForm, type Field } from "./forms.tsx";
import { Button, ErrorNotice, Loading, Modal } from "./ui.tsx";

export const subscriptionFields: Field[] = [
  {
    name: "mode",
    label: "Notifications",
    type: "select",
    options: [
      { value: "watching", label: "All activity" },
      { value: "participating", label: "Participating and mentions" },
      { value: "ignored", label: "Muted" },
    ],
    default: "participating",
    required: true,
  },
  {
    name: "muted_until",
    label: "Mute until (optional)",
    type: "datetime-local",
  },
  {
    name: "digest",
    label: "Email digest",
    type: "select",
    options: ["inherit", "off", "daily", "weekly"],
    default: "inherit",
    required: true,
  },
];

export function SubscriptionButton({
  repoId,
  itemId,
  label = "Notifications",
  onSaved,
}: {
  repoId: string;
  itemId?: string;
  label?: string;
  onSaved?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const current = useResource<{ subscription: Entity | null }>(
    open
      ? query("/v1/subscriptions/current", { repo_id: repoId, item_id: itemId })
      : null,
  );
  const subscription = current.data?.subscription;
  return (
    <>
      <Button onClick={() => setOpen(true)}>{label}</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Thread and repository notifications"
      >
        <ErrorNotice error={current.error} retry={current.refresh} />
        {current.loading && !current.data ? (
          <Loading rows={2} />
        ) : (
          current.data && (
            <ResourceForm
              path={
                subscription
                  ? `/v1/subscriptions/${subscription.id}`
                  : "/v1/subscriptions"
              }
              initial={
                subscription ? revisionSnapshot(subscription) : undefined
              }
              fields={subscriptionFields}
              transform={(body) =>
                subscription
                  ? body
                  : { ...body, repo_id: repoId, item_id: itemId || null }
              }
              submitLabel="Save notifications"
              onCancel={() => setOpen(false)}
              onSaved={() => {
                setOpen(false);
                onSaved?.();
              }}
            />
          )
        )}
      </Modal>
    </>
  );
}
