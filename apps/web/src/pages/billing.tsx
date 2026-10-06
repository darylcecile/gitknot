import { useState } from "react";
import { Link, NavLink, useParams, useSearchParams } from "react-router";
import {
  ArrowRight,
  CreditCard,
  Gauge,
  ReceiptText,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { endpoints, query } from "../api/endpoints.ts";
import { useCollection, useResource } from "../api/hooks.ts";
import {
  array,
  displayName,
  humanize,
  record,
  text,
  type Account,
  type Entity,
} from "../api/types.ts";
import {
  ActionButton,
  CreateResource,
  EditResource,
  ResourceForm,
  type Field,
} from "../components/forms.tsx";
import {
  Badge,
  Button,
  DownloadButton,
  Empty,
  ErrorNotice,
  JsonDetails,
  Loading,
  Metadata,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Status,
  Time,
} from "../components/ui.tsx";

const NANO = 1_000_000_000n;
export function usdToNano(value: unknown): string {
  const source = text(value).trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(source))
    throw new Error(
      "Enter a non-negative dollar amount with up to nine decimal places.",
    );
  const [whole = "0", decimal = ""] = source.split(".");
  return (BigInt(whole) * NANO + BigInt(decimal.padEnd(9, "0"))).toString();
}

export function nanoToUsd(value: unknown): string {
  try {
    const amount = BigInt(text(value, "0"));
    const absolute = amount < 0n ? -amount : amount;
    const fractional = (absolute % NANO)
      .toString()
      .padStart(9, "0")
      .replace(/0+$/, "");
    return `${amount < 0n ? "-" : ""}${absolute / NANO}${fractional ? `.${fractional}` : ""}`;
  } catch {
    return "";
  }
}

export function Amount({
  value,
  detailed = false,
}: {
  value: unknown;
  detailed?: boolean;
}) {
  if (value === undefined || value === null || value === "")
    return <span>—</span>;
  try {
    const amount = BigInt(text(value));
    const negative = amount < 0n;
    const absolute = negative ? -amount : amount;
    const precision = detailed ? 6 : 2;
    const divisor = 10n ** BigInt(9 - precision);
    const rounded = (absolute + divisor / 2n) / divisor;
    const scale = 10n ** BigInt(precision);
    const whole = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    }).format(rounded / scale);
    return (
      <span className="numeric" title={`USD ${nanoToUsd(value)}`}>
        {negative ? "−" : ""}${whole}.
        {(rounded % scale).toString().padStart(precision, "0")}
      </span>
    );
  } catch {
    return <span>Invalid amount</span>;
  }
}

export function BillingIndexPage() {
  const accounts = useCollection<Account>(endpoints.accounts);
  return (
    <>
      <PageHeader
        eyebrow="Cost, with context"
        title="Billing & usage"
        description="Choose a payer to see measured usage, reservations, budgets, and invoices."
      />
      <ErrorNotice error={accounts.error} retry={accounts.refresh} />
      {accounts.loading && !accounts.data ? (
        <Loading />
      ) : (
        <div className="account-grid">
          {accounts.items.map((account) => (
            <Link
              className="account-card"
              to={`/billing/${account.id}`}
              key={account.id}
            >
              <Wallet size={25} />
              <div>
                <h2>{account.name}</h2>
                <p>
                  {account.type === "organization"
                    ? "Organization billing"
                    : "Personal billing"}
                </p>
              </div>
              <ArrowRight size={18} />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

const sections = [
  ["overview", "Overview"],
  ["usage", "Usage & ledger"],
  ["budgets", "Budgets"],
  ["invoices", "Invoices"],
  ["subscription", "Plan & subscription"],
  ["credits", "Credits"],
];

export function BillingPage() {
  const { accountId = "", section = "overview" } = useParams();
  const billing = useResource<Entity>(endpoints.billing(accountId));
  const account = useResource<Account>(endpoints.account(accountId));
  const base = endpoints.billing(accountId);
  return (
    <>
      <PageHeader
        eyebrow={
          <Link to={`/accounts/${accountId}`}>
            {account.data?.name || accountId}
          </Link>
        }
        title="Billing & usage"
        description="Measured usage, enforceable caps, and a clear view of every reservation."
      />
      <nav className="tabs" aria-label="Billing navigation">
        {sections.map(([path, label]) => (
          <NavLink
            end
            className={section === path ? "active" : ""}
            key={path}
            to={`/billing/${accountId}/${path}`}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      {section === "overview" ? (
        <BillingOverview billing={billing} base={base} accountId={accountId} />
      ) : section === "usage" ? (
        <UsagePanel base={base} />
      ) : section === "budgets" ? (
        <BudgetsPanel base={base} />
      ) : section === "invoices" ? (
        <InvoicesPanel base={base} accountId={accountId} />
      ) : section === "subscription" ? (
        <SubscriptionPanel base={base} />
      ) : section === "credits" ? (
        <CreditsPanel base={base} />
      ) : (
        <Notice>Select a billing section.</Notice>
      )}
    </>
  );
}

function BillingOverview({
  billing,
  base,
  accountId,
}: {
  billing: ReturnType<typeof useResource<Entity>>;
  base: string;
  accountId: string;
}) {
  const data = billing.data;
  const usage = record(data?.usage);
  return (
    <>
      <ErrorNotice error={billing.error} retry={billing.refresh} />
      {!data && billing.loading ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="billing-metrics">
              <Metric
                label="Measured usage"
                value={
                  data.settled_amount ||
                  data.measured_amount ||
                  usage.settled_amount
                }
                detail="Settled usage this period"
              />
              <Metric
                label="Reserved"
                value={
                  data.reserved_amount ||
                  data.outstanding_reservations ||
                  usage.reserved_amount
                }
                detail="Maximum committed in-flight cost"
              />
              <Metric
                label="Forecast"
                value={data.forecast_amount || usage.forecast_amount}
                detail="Estimate, separate from measured usage"
              />
              <Metric
                label="Included usage"
                value={data.included_usage_units}
                detail="Included in the current plan"
              />
            </div>
            <div className="dashboard-grid">
              <Panel
                title="Your plan"
                actions={
                  <Link to={`/billing/${accountId}/subscription`}>
                    Manage plan
                  </Link>
                }
              >
                <div className="panel-body">
                  <h3>
                    {text(
                      record(data.plan).name || data.plan_name || data.plan_id,
                      "Plan details",
                    )}
                  </h3>
                  <Metadata
                    values={{
                      billing_period: data.period || data.billing_period,
                      entitlements: data.entitlements,
                      currency: "USD",
                    }}
                  />
                  <IncludedUsage value={data.included_usage_units} />
                  <JsonDetails
                    title="Billing details (monetary units: USD nanodollars)"
                    value={data}
                  />
                </div>
              </Panel>
              <Panel title="Cost controls">
                <div className="panel-body">
                  <p>
                    New paid work must fit within settled cost, outstanding
                    reservations, and the configured safety buffer.
                  </p>
                  <Link
                    to={`/billing/${accountId}/budgets`}
                    className="button button-secondary"
                  >
                    <ShieldCheck size={16} />
                    Manage budgets
                  </Link>
                </div>
              </Panel>
            </div>
            <Panel title="Execution controls">
              <div className="setting-row">
                <div>
                  <h3>Pause paid execution</h3>
                  <p>
                    Prevent new paid admission. Cleanup, credential revocation,
                    browsing, and export remain operational.
                  </p>
                </div>
                <ActionButton
                  path={`${base}/execution-control`}
                  snapshot={billing.snapshot}
                  label={
                    data.execution_paused
                      ? "Resume admission"
                      : "Pause admission"
                  }
                  method="PATCH"
                  body={{ paused: !data.execution_paused }}
                  fields={[
                    {
                      name: "reason",
                      label: "Reason",
                      type: "textarea",
                      required: true,
                    },
                  ]}
                  onDone={billing.refresh}
                />
              </div>
            </Panel>
          </>
        )
      )}
    </>
  );
}

function IncludedUsage({ value }: { value: unknown }) {
  return (
    <dl className="metadata included-usage">
      <div>
        <dt>Included usage</dt>
        <dd>
          <Amount value={value} /> USD
        </dd>
      </div>
    </dl>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: unknown;
  detail: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>
        <Amount value={value} />
      </strong>
      <p>{detail}</p>
    </div>
  );
}

function UsagePanel({ base }: { base: string }) {
  const [params, setParams] = useSearchParams();
  const usage = useCollection<Entity>(
    query(`${base}/usage${params.get("view") === "ledger" ? "/ledger" : ""}`, {
      period: params.get("period"),
      group_by: params.get("group_by") || "repository",
      repo_id: params.get("repo_id"),
    }),
  );
  return (
    <>
      <div className="filter-bar">
        <div className="segmented">
          {["summary", "ledger"].map((view) => (
            <button
              type="button"
              key={view}
              aria-pressed={(params.get("view") || "summary") === view}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("view", view);
                setParams(next);
              }}
            >
              {view}
            </button>
          ))}
        </div>
        <label>
          Group by{" "}
          <select
            value={params.get("group_by") || "repository"}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              next.set("group_by", event.target.value);
              setParams(next);
            }}
            aria-label="Usage grouping"
          >
            {["account", "repository", "workflow", "team", "actor"].map(
              (group) => (
                <option key={group}>{group}</option>
              ),
            )}
          </select>
        </label>
        <form
          className="inline-filters"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const next = new URLSearchParams(params);
            next.set("period", text(form.get("period")));
            setParams(next);
          }}
        >
          <label>
            Billing period
            <input
              type="month"
              name="period"
              defaultValue={
                params.get("period") || new Date().toISOString().slice(0, 7)
              }
            />
          </label>
          <Button type="submit">Apply</Button>
        </form>
        <Link
          className="button button-secondary"
          to={`/billing/${base.split("/")[3]}/invoices`}
        >
          Download statements
        </Link>
      </div>
      <Panel
        title="Usage ledger"
        description="Exact quantities and price versions. Customer-runner time is separate from hosted compute charges."
      >
        <ErrorNotice error={usage.error} retry={usage.refresh} />
        <div className="resource-table-wrap">
          <table className="resource-table">
            <thead>
              <tr>
                <th scope="col">Attribution</th>
                <th scope="col">Meter</th>
                <th scope="col">Quantity</th>
                <th scope="col">Amount</th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {usage.items.map((row, index) => (
                <tr key={row.id || index}>
                  <td>
                    <strong>
                      {text(
                        row.repository_name ||
                          row.workflow_name ||
                          row.team_name ||
                          row.actor_name ||
                          row.repo_id ||
                          row.group ||
                          row.dimension_id,
                        row.id,
                      )}
                    </strong>
                    <details>
                      <summary>Lineage</summary>
                      <Metadata values={row} />
                    </details>
                  </td>
                  <td>
                    {text(row.meter || row.meter_id)}
                    {row.executor === "self_hosted" && (
                      <Badge>Customer infrastructure</Badge>
                    )}
                  </td>
                  <td className="numeric">
                    {text(row.quantity)} {text(row.unit)}
                  </td>
                  <td>
                    <Amount
                      value={row.amount || row.amount_nanos || row.total_amount}
                      detailed
                    />
                  </td>
                  <td>
                    <Time
                      value={
                        row.recorded_at ||
                        row.occurred_at ||
                        row.updated_at ||
                        row.created_at
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!usage.items.length && !usage.loading && !usage.error && (
          <Empty
            title="No usage in this period"
            description="Billable work and customer-runner time appear after their durable metering receipts are recorded."
          />
        )}
        <Pagination {...usage} />
      </Panel>
    </>
  );
}

const budgetFields: Field[] = [
  {
    name: "scope",
    label: "Scope",
    type: "select",
    options: ["account", "repository", "workflow", "team", "actor"],
    default: "account",
    required: true,
    createOnly: true,
  },
  {
    name: "scope_id",
    label: "Scope ID",
    help: "The account, repository, workflow, team, or actor controlled by this cap.",
    required: true,
    createOnly: true,
  },
  {
    name: "period_end",
    label: "Period end (optional)",
    type: "datetime-local",
    createOnly: true,
  },
  { name: "limit_usd", label: "Limit (USD)", required: true },
  {
    name: "safety_buffer_usd",
    label: "Safety buffer (USD)",
    default: "0",
    required: true,
  },
  {
    name: "threshold_percentages",
    label: "Alert thresholds (%)",
    type: "csv",
    default: ["50", "80", "100"],
  },
];
const budgetBody = (body: Record<string, unknown>) => {
  return {
    ...(body.scope
      ? {
          scope: body.scope,
          scope_id: body.scope_id,
          period_end: body.period_end ?? null,
        }
      : {}),
    ...(body.stopped !== undefined ? { stopped: body.stopped } : {}),
    limit_units: usdToNano(body.limit_usd),
    safety_buffer_units: usdToNano(body.safety_buffer_usd),
    threshold_percentages: array<string>(body.threshold_percentages).map(
      Number,
    ),
  };
};

function BudgetsPanel({ base }: { base: string }) {
  const accountId = /\/accounts\/([^/]+)/.exec(base)?.[1] || "";
  const budgets = useCollection<Entity>(`${base}/budgets`);
  const [editing, setEditing] = useState("");
  const budget = useResource<Entity>(
    editing ? `${base}/budgets/${editing}` : null,
  );
  return (
    <Panel
      title="Budgets"
      description="Hard caps reserve concurrent spending before admission. Alerts alone never stop work."
      actions={
        <CreateResource
          path={`${base}/budgets`}
          title="Create budget"
          fields={budgetFields.map((field) =>
            field.name === "scope_id"
              ? { ...field, default: accountId }
              : field,
          )}
          transform={budgetBody}
          onSaved={budgets.refresh}
        />
      }
    >
      <ErrorNotice error={budgets.error} retry={budgets.refresh} />
      {budgets.items.map((item) => (
        <article className="budget-row" key={item.id}>
          <div>
            <h3>{humanize(item.scope)} cap</h3>
            <Badge tone="green">Hard cap</Badge>
            <Metadata
              values={{
                scope: item.scope_type,
                resource: item.scope_id,
                period_end: item.period_end,
                stopped: item.stopped,
                thresholds: item.threshold_percentages,
              }}
            />
          </div>
          <div className="budget-amounts">
            <span>
              Limit{" "}
              <strong>
                <Amount value={item.limit_amount} />
              </strong>
            </span>
            <span>
              Settled <Amount value={item.settled_amount} />
            </span>
            <span>
              Reserved <Amount value={item.reserved_amount} />
            </span>
            <span>
              Buffer <Amount value={item.safety_buffer} />
            </span>
          </div>
          <div className="row-actions">
            <Button onClick={() => setEditing(item.id)}>Edit</Button>
            <ActionButton
              path={`${base}/budgets/${item.id}`}
              method="PATCH"
              label={item.stopped ? "Resume scope" : "Stop scope"}
              description="Control new admission within this budget scope while retaining all commitments."
              body={{
                limit_units: item.limit_units,
                safety_buffer_units: item.safety_buffer_units,
                threshold_percentages: item.threshold_percentages,
                stopped: !item.stopped,
              }}
              onDone={budgets.refresh}
            />
          </div>
        </article>
      ))}
      {!budgets.items.length && !budgets.loading && !budgets.error && (
        <Empty
          title="No account budgets configured"
          description="Create a hard cap and configure the thresholds that should alert you."
        />
      )}
      <Pagination {...budgets} />
      {editing && (
        <Panel title="Edit budget">
          <ErrorNotice error={budget.error} retry={budget.refresh} />
          {budget.snapshot && (
            <ResourceForm
              path={`${base}/budgets/${editing}`}
              initial={{
                ...budget.snapshot,
                data: {
                  ...budget.snapshot.data,
                  limit_usd: nanoToUsd(budget.data?.limit_amount),
                  safety_buffer_usd: nanoToUsd(budget.data?.safety_buffer),
                },
              }}
              fields={[
                ...budgetFields,
                {
                  name: "stopped",
                  label: "Stop new work in this scope",
                  type: "checkbox",
                },
              ]}
              transform={budgetBody}
              onCancel={() => setEditing("")}
              onSaved={() => {
                setEditing("");
                budgets.refresh();
              }}
            />
          )}
        </Panel>
      )}
    </Panel>
  );
}

function InvoicesPanel({
  base,
  accountId,
}: {
  base: string;
  accountId: string;
}) {
  const invoices = useCollection<Entity>(`${base}/invoices`);
  return (
    <Panel title="Invoices">
      <ErrorNotice error={invoices.error} retry={invoices.refresh} />
      {invoices.items.map((invoice) => (
        <article className="invoice-row" key={invoice.id}>
          <ReceiptText size={21} />
          <Link to={`/billing/${accountId}/invoices/${invoice.id}`}>
            {text(invoice.number, invoice.id)}
          </Link>
          <Status value={invoice.state || invoice.status} />
          <Time value={invoice.issued_at || invoice.created_at} />
          <Amount value={invoice.total_amount || invoice.amount} />
          <DownloadButton
            path={`${base}/invoices/${invoice.id}/download`}
            name={`${invoice.id}.csv`}
          />
        </article>
      ))}
      {!invoices.items.length && !invoices.loading && !invoices.error && (
        <Empty title="No invoices yet" />
      )}
      <Pagination {...invoices} />
    </Panel>
  );
}

export function InvoicePage() {
  const { accountId = "", invoiceId = "" } = useParams();
  const path = endpoints.billing(
    accountId,
    `invoices/${encodeURIComponent(invoiceId)}`,
  );
  const invoice = useResource<Entity>(path);
  return (
    <>
      <PageHeader
        eyebrow={<Link to={`/billing/${accountId}/invoices`}>Invoices</Link>}
        title={
          invoice.data
            ? `Invoice ${text(invoice.data.number, invoiceId)}`
            : "Invoice"
        }
        actions={
          <>
            <DownloadButton
              path={`${path}/download`}
              name={`${invoiceId}.csv`}
            />
            {invoice.data?.collection_method === "processor" &&
              invoice.data.state === "open" && (
                <ActionButton
                  path={`${path}/pay`}
                  snapshot={invoice.snapshot}
                  label="Pay invoice"
                  description="Request collection of this exact invoice amount."
                  onDone={invoice.refresh}
                />
              )}
          </>
        }
      />
      <ErrorNotice error={invoice.error} retry={invoice.refresh} />
      {invoice.data && (
        <Panel>
          <div className="panel-body">
            <Status value={invoice.data.state} />
            <Metadata
              values={{
                period: invoice.data.period,
                issued_at: invoice.data.issued_at,
                due_at: invoice.data.due_at,
                currency: invoice.data.currency,
              }}
            />
            <h2>
              Total <Amount value={invoice.data.total_amount} />
            </h2>
            {array<Entity>(invoice.data.lines || invoice.data.items).map(
              (line, index) => (
                <div className="invoice-line" key={line.id || index}>
                  <span>{text(line.description || line.meter)}</span>
                  <span>
                    {text(line.quantity)} {text(line.unit)}
                  </span>
                  <Amount value={line.amount} detailed />
                </div>
              ),
            )}
            <JsonDetails
              title="Price versions and invoice lineage"
              value={invoice.data}
            />
          </div>
        </Panel>
      )}
    </>
  );
}

function SubscriptionPanel({ base }: { base: string }) {
  const subscription = useResource<Entity>(`${base}/subscription`);
  const plans = useCollection<Entity>(`${base}/plans`);
  return (
    <>
      <Panel title="Current subscription">
        <ErrorNotice error={subscription.error} retry={subscription.refresh} />
        {subscription.data && (
          <div className="panel-body">
            <Metadata
              values={{
                plan: subscription.data.plan_id,
                state: subscription.data.state,
                period_start: subscription.data.period_start,
                period_end: subscription.data.period_end,
                seats: subscription.data.seat_count,
                billing_email: subscription.data.billing_email,
                collection_method: subscription.data.collection_method,
                currency: "USD",
              }}
            />
            <JsonDetails
              title="Subscription details (monetary units: USD nanodollars)"
              value={subscription.data}
            />
            <ActionButton
              path={`${base}/subscription/cancel`}
              snapshot={subscription.snapshot}
              label="Cancel subscription"
              description="Review the effective date and retention in the returned subscription state."
              fields={[{ name: "reason", label: "Reason", type: "textarea" }]}
              onDone={subscription.refresh}
            />
          </div>
        )}
      </Panel>
      <Panel title="Available plans">
        <ErrorNotice error={plans.error} retry={plans.refresh} />
        {plans.items.map((plan) => (
          <div className="setting-row" key={plan.id}>
            <div>
              <h3>{displayName(plan)}</h3>
              <p>{text(plan.description)}</p>
              <Amount value={plan.price_amount} /> USD / month
              <IncludedUsage value={plan.included_usage_units} />
              <Metadata
                values={{
                  entitlements: plan.entitlements,
                }}
              />
            </div>
            <ActionButton
              path={`${base}/subscription`}
              snapshot={subscription.snapshot}
              label="Select plan"
              method="PATCH"
              body={{ plan_id: plan.id }}
              description={`Choose ${displayName(plan)}. Review the plan entitlements and effective billing terms above.`}
              onDone={subscription.refresh}
            />
          </div>
        ))}
      </Panel>
    </>
  );
}

function CreditsPanel({ base }: { base: string }) {
  const credits = useCollection<Entity>(`${base}/credits`);
  return (
    <Panel
      title="Credits"
      description="Credits reduce the payable amount. They do not expand operating-cost budgets."
      actions={
        <CreateResource
          path={`${base}/credits`}
          title="Redeem credit"
          sensitive
          fields={[
            {
              name: "code",
              label: "Credit code",
              type: "password",
              autoComplete: "off",
              required: true,
            },
          ]}
          onSaved={credits.refresh}
        />
      }
    >
      <ErrorNotice error={credits.error} retry={credits.refresh} />
      {credits.items.map((credit) => (
        <div className="invoice-line" key={credit.id}>
          <div>
            <strong>
              {text(credit.description || credit.reason, credit.id)}
            </strong>
            <Time value={credit.created_at} />
          </div>
          <span>
            Remaining <Amount value={credit.remaining_units} />
          </span>
          <Time value={credit.expires_at} />
        </div>
      ))}
      {!credits.items.length && !credits.loading && !credits.error && (
        <Empty title="No credits recorded" />
      )}
      <Pagination {...credits} />
    </Panel>
  );
}
