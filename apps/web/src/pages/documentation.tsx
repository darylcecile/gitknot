import type { ReactNode } from "react";
import { Link, NavLink, useParams } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { apiUrl } from "../api/client.ts";
import { Markdown } from "../components/markdown/render.tsx";
import { PageHeader } from "../components/ui.tsx";
import overview from "../content/docs/overview.md?raw";
import cli from "../content/docs/cli.md?raw";
import workflows from "../content/docs/workflows.md?raw";
import api from "../content/docs/api.md?raw";
import support from "../content/docs/support.md?raw";
import { NotFoundPage } from "./operations.tsx";

// Curated user guides; their source contracts and maintenance points are in docs/web.md.
const guides = [
  {
    slug: "",
    label: "Getting started",
    title: "GitKnot documentation",
    description: "Accounts, repositories, reviews, and reproducible work.",
    source: overview,
  },
  {
    slug: "cli",
    label: "Command line",
    title: "GitKnot CLI",
    description: "Use GitKnot from your terminal and automation.",
    source: cli,
  },
  {
    slug: "workflows",
    label: "Workflows",
    title: "GitKnot workflows",
    description:
      "Define, validate, plan, and reproduce verification at exact revisions.",
    source: workflows,
  },
  {
    slug: "api",
    label: "API guide",
    title: "GitKnot API",
    description:
      "Authenticate, read, change, and download through the shared REST contract.",
    source: api,
  },
];

function DocumentationArticle({
  title,
  description,
  source,
  children,
}: {
  title: string;
  description: string;
  source: string;
  children?: ReactNode;
}) {
  return (
    <>
      <title>{`${title} · GitKnot`}</title>
      <PageHeader
        eyebrow={
          <Link className="documentation-breadcrumb" to="/docs">
            Documentation
          </Link>
        }
        title={title}
        description={description}
        actions={
          <a
            href={apiUrl("/openapi.json")}
            className="button button-secondary"
            target="_blank"
            rel="noopener noreferrer"
          >
            OpenAPI specification <ArrowUpRight size={15} />
          </a>
        }
      />
      <div className="documentation-layout">
        <nav className="documentation-navigation" aria-label="Documentation">
          {guides.map((guide) => (
            <NavLink
              key={guide.slug}
              to={`/docs${guide.slug ? `/${guide.slug}` : ""}`}
              end
            >
              {guide.label}
            </NavLink>
          ))}
          <NavLink to="/support">Support</NavLink>
          <Link to="/help">Keyboard & editing help</Link>
        </nav>
        <article className="documentation-article" aria-label={title}>
          {children}
          <Markdown source={source} />
        </article>
      </div>
    </>
  );
}

export function DocumentationPage() {
  const { guide = "" } = useParams();
  const selected = guides.find((item) => item.slug === guide);
  return selected ? <DocumentationArticle {...selected} /> : <NotFoundPage />;
}

export function SupportPage() {
  const email =
    import.meta.env.VITE_SUPPORT_EMAIL?.trim() || "support@gitknot.com";
  const href = `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}`;
  return (
    <DocumentationArticle
      title="GitKnot support"
      description="Recover access and troubleshoot a request, workflow, or durable operation."
      source={support}
    >
      <section
        className="support-contact markdown"
        aria-labelledby="support-contact-heading"
      >
        <h2 id="support-contact-heading">Contact GitKnot support</h2>
        <p>
          Email <a href={href}>{email}</a> with the error message, GitKnot
          request ID, approximate time, and affected repository or run ID. The
          guide below explains where to find that information.
        </p>
      </section>
    </DocumentationArticle>
  );
}
