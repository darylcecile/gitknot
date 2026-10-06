import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronRight, Trash2 } from "lucide-react";
import { useCollection } from "../api/hooks.ts";
import { revisionSnapshot } from "../api/client.ts";
import {
  displayName,
  array,
  record,
  humanize,
  text,
  type Entity,
  type Snapshot,
} from "../api/types.ts";
import {
  ActionButton,
  CreateResource,
  EditResource,
  type Field,
} from "./forms.tsx";
import {
  Empty,
  ErrorNotice,
  JsonDetails,
  Loading,
  Modal,
  OneTimeNotice,
  Pagination,
  Panel,
  Status,
  Time,
} from "./resource-ui.tsx";
import { Notice } from "./ui.tsx";

export type CollectionSpec = {
  title: string;
  singular: string;
  description?: string;
  fields: Field[];
  editFields?: Field[];
  columns?: string[];
  sensitive?: boolean;
  allowDelete?: boolean;
  create?: boolean;
  edit?: boolean;
  rowPath?: (item: Entity) => string;
  itemPath?: (item: Entity) => string;
  createTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
};

export function ResourceCollection({
  path,
  spec,
  actions,
  onChanged,
}: {
  path: string;
  spec: CollectionSpec;
  actions?: (item: Entity, refresh: () => void) => ReactNode;
  onChanged?: () => void;
}) {
  const collection = useCollection<Entity>(path);
  const [created, setCreated] = useState<Snapshot<Entity> | null>(null);
  const [selected, setSelected] = useState<Entity | null>(null);
  const refresh = () => {
    collection.refresh();
    onChanged?.();
  };
  const columns = spec.columns || ["name", "state", "updated_at"];
  const itemPath = (item: Entity) =>
    spec.itemPath?.(item) ||
    `${path.split("?")[0]}/${encodeURIComponent(item.id)}`;
  return (
    <Panel
      title={spec.title}
      description={spec.description}
      actions={
        spec.create !== false && (
          <CreateResource
            path={path}
            title={`Create ${spec.singular}`}
            fields={spec.fields}
            sensitive={spec.sensitive}
            transform={spec.createTransform}
            onSaved={(result) => {
              setCreated(result);
              refresh();
            }}
          />
        )
      }
    >
      <ErrorNotice error={collection.error} retry={collection.refresh} />
      {created && <OneTimeNotice value={created.data} />}
      {created && array(created.data.overlaps).length > 0 && (
        <Notice tone="warning">
          <strong>Active work overlaps this claim.</strong>
          <JsonDetails
            title="Overlapping claims"
            value={created.data.overlaps}
          />
        </Notice>
      )}
      {created && typeof created.data.operation_id === "string" && (
        <Notice>
          Operation started.{" "}
          <Link to={`/operations/${created.data.operation_id}`}>
            Follow its durable progress
          </Link>
          .
        </Notice>
      )}
      {collection.loading && !collection.data ? (
        <Loading />
      ) : collection.items.length ? (
        <div className="resource-table-wrap">
          <table className="resource-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th scope="col" key={column}>
                    {humanize(column)}
                  </th>
                ))}
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {collection.items.map((item) => (
                <tr key={item.id}>
                  {columns.map((column, index) => (
                    <td key={column}>
                      {index === 0 ? (
                        spec.rowPath ? (
                          <Link
                            className="resource-name"
                            to={spec.rowPath(item)}
                          >
                            {text(item[column], displayName(item))}
                          </Link>
                        ) : (
                          <button
                            className="text-button resource-name"
                            onClick={() => setSelected(item)}
                          >
                            {text(item[column], displayName(item))}
                          </button>
                        )
                      ) : column.endsWith("_at") ? (
                        <Time value={item[column]} />
                      ) : column === "state" || column === "status" ? (
                        <Status value={item[column]} />
                      ) : typeof item[column] === "object" ? (
                        <span className="muted truncate">
                          {JSON.stringify(item[column])}
                        </span>
                      ) : (
                        <span className={column.endsWith("_id") ? "mono" : ""}>
                          {text(
                            item[column],
                            typeof item[column] === "boolean"
                              ? item[column]
                                ? "Yes"
                                : "No"
                              : "—",
                          )}
                        </span>
                      )}
                    </td>
                  ))}
                  <td>
                    <div className="row-actions">
                      {actions?.(item, refresh)}
                      {spec.edit !== false && (
                        <EditResource
                          path={itemPath(item)}
                          fields={spec.editFields || spec.fields}
                          snapshot={revisionSnapshot(item)}
                          title={`Edit ${spec.singular}`}
                          onSaved={refresh}
                          sensitive={spec.sensitive}
                        />
                      )}
                      {spec.allowDelete !== false && (
                        <ActionButton
                          path={itemPath(item)}
                          snapshot={revisionSnapshot(item)}
                          label="Remove"
                          title={`Remove ${displayName(item)}?`}
                          description="This action removes the resource and its active access. Existing history remains subject to retention."
                          danger
                          method="DELETE"
                          confirmText={displayName(item)}
                          onDone={refresh}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !collection.error && (
          <Empty
            title={`No ${spec.title.toLowerCase()} yet`}
            description={spec.description}
          />
        )
      )}
      <Pagination {...collection} />
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? displayName(selected) : "Details"}
      >
        <div className="modal-body">
          <JsonDetails title="Resource details" value={selected} />
        </div>
      </Modal>
    </Panel>
  );
}
