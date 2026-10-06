import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useNavigate } from "react-router";
import {
  activeViewerRepository,
  apiPath,
  apiUrl,
  download,
  readHeaders,
} from "../../api/client.ts";
import { endpoints, query, repoLink } from "../../api/endpoints.ts";
import { ErrorNotice } from "../ui.tsx";

const allowedTags = [
  "a",
  "p",
  "div",
  "span",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "s",
  "b",
  "i",
  "u",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "input",
  "details",
  "summary",
  "kbd",
  "sup",
  "sub",
];

export function safeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: [
      "href",
      "src",
      "alt",
      "title",
      "class",
      "type",
      "checked",
      "disabled",
      "start",
      "align",
      "colspan",
      "rowspan",
    ],
    FORBID_ATTR: ["style", "srcset", "id", "name"],
    ALLOW_DATA_ATTR: false,
  });
}

export function renderMarkdown(source: string): string {
  return safeHtml(
    marked.parse(source, { async: false, gfm: true, breaks: false }),
  );
}

export function Markdown({
  source,
  onPassage,
  repository,
}: {
  source: string;
  onPassage?: (selection: {
    quote: string;
    start: number;
    end: number;
  }) => void;
  repository?: { id: string; ref: string; path: string };
}) {
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [downloadError, setDownloadError] = useState<Error | null>(null);
  const [diagrams, setDiagrams] = useState<{ source: string; id: string }[]>(
    [],
  );
  const html = useMemo(() => renderMarkdown(source), [source]);
  useEffect(() => {
    const blocks = [
      ...(root.current?.querySelectorAll<HTMLElement>("pre") || []),
    ];
    const update = () =>
      blocks.forEach((block, index) => {
        const scrollable =
          block.scrollWidth > block.clientWidth ||
          block.scrollHeight > block.clientHeight;
        if (scrollable) {
          const language = block
            .querySelector("code")
            ?.className.match(/(?:^|\s)language-([a-z0-9_-]+)/i)?.[1];
          block.tabIndex = 0;
          block.setAttribute("role", "region");
          block.setAttribute(
            "aria-label",
            `Scrollable code block ${index + 1}${language ? ` (${language})` : ""}`,
          );
        } else {
          block.removeAttribute("tabindex");
          block.removeAttribute("role");
          block.removeAttribute("aria-label");
        }
      });
    const observer = new ResizeObserver(update);
    blocks.forEach((block) => observer.observe(block));
    update();
    return () => observer.disconnect();
  }, [html]);
  useEffect(() => {
    if (!root.current) return;
    const controller = new AbortController();
    const objectUrls: string[] = [];
    const relative = (value: string) => {
      if (!repository || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value))
        return null;
      const directory = repository.path.split("/").slice(0, -1).join("/");
      try {
        const url = new URL(
          value,
          `https://gitknot.invalid/${directory ? `${directory}/` : ""}`,
        );
        return {
          path: decodeURIComponent(url.pathname).slice(1),
          hash: url.hash,
        };
      } catch {
        return null;
      }
    };
    const next: { source: string; id: string }[] = [];
    root.current.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
      const original = link.dataset.gitknotSource || link.getAttribute("href");
      if (!original) return;
      link.dataset.gitknotSource = original;
      delete link.dataset.gitknotApi;
      delete link.dataset.gitknotPage;
      const file = relative(original);
      if (file && repository) {
        link.href = `${repoLink(repository.id, `code/${file.path.split("/").map(encodeURIComponent).join("/")}`)}?ref=${encodeURIComponent(repository.ref)}${file.hash}`;
        link.dataset.gitknotPage = "true";
      } else {
        try {
          link.href = apiUrl(original);
          link.dataset.gitknotApi = "true";
        } catch {
          /* Ordinary web and passage links retain their sanitized destination. */
        }
      }
      link.rel = "nofollow noopener noreferrer";
      if (/^https?:/.test(link.href) && link.origin !== location.origin)
        link.target = "_blank";
    });
    root.current.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      const original =
        image.dataset.gitknotSource || image.getAttribute("src") || "";
      if (!original) return;
      image.dataset.gitknotSource = original;
      const file = relative(original);
      let target: string;
      try {
        target =
          file && repository
            ? query(endpoints.repo(repository.id, "raw"), {
                ref: repository.ref,
                path: file.path,
              })
            : apiPath(original);
      } catch {
        return;
      }
      if (!activeViewerRepository()) {
        image.src = apiUrl(target);
        return;
      }
      image.removeAttribute("src");
      void fetch(apiUrl(target), {
        headers: readHeaders(target),
        credentials: "include",
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok)
            throw new Error(
              `Unable to load this authorized image (${response.status}).`,
            );
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          image.src = url;
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setDownloadError(
              cause instanceof Error
                ? cause
                : new Error("Image download failed."),
            );
        });
    });
    root.current
      .querySelectorAll("pre > code.language-mermaid")
      .forEach((code, index) => {
        next.push({ source: code.textContent || "", id: `diagram-${index}` });
      });
    setDiagrams(next);
    return () => {
      controller.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [html, repository?.id, repository?.ref, repository?.path]);
  return (
    <>
      <div
        className="markdown"
        ref={root}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(event) => {
          const link =
            event.target instanceof Element
              ? event.target.closest<HTMLAnchorElement>(
                  "a[data-gitknot-api], a[data-gitknot-page]",
                )
              : null;
          if (!link) return;
          event.preventDefault();
          if (link.dataset.gitknotPage) {
            navigate(`${link.pathname}${link.search}${link.hash}`);
            return;
          }
          setDownloadError(null);
          void download(
            link.href,
            link.textContent?.trim() || "download",
          ).catch((cause) =>
            setDownloadError(
              cause instanceof Error ? cause : new Error("Download failed."),
            ),
          );
        }}
        onMouseUp={() => {
          if (!onPassage || !root.current) return;
          const selection = window.getSelection();
          if (
            !selection ||
            selection.isCollapsed ||
            !selection.anchorNode ||
            !root.current.contains(selection.anchorNode) ||
            !selection.focusNode ||
            !root.current.contains(selection.focusNode)
          )
            return;
          const quote = selection.toString().trim();
          if (!quote) return;
          const start = source.indexOf(quote);
          // Anchors address canonical Markdown offsets, never rendered DOM offsets.
          if (start >= 0 && source.indexOf(quote, start + 1) < 0)
            onPassage({ quote, start, end: start + quote.length });
        }}
      />
      <ErrorNotice error={downloadError} />
      {diagrams.map((diagram) => (
        <Diagram key={diagram.id} source={diagram.source} />
      ))}
    </>
  );
}

function Diagram({ source }: { source: string }) {
  const [document, setDocument] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    setError("");
    setDocument("");
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          maxTextSize: 50_000,
          maxEdges: 500,
          suppressErrorRendering: true,
          flowchart: { htmlLabels: false },
          secure: [
            "secure",
            "securityLevel",
            "startOnLoad",
            "maxTextSize",
            "maxEdges",
            "htmlLabels",
          ],
        });
        const { svg } = await mermaid.render(
          `gk-${crypto.randomUUID()}`,
          source,
        );
        const clean = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          FORBID_TAGS: ["foreignObject", "script", "a", "image"],
          FORBID_ATTR: ["href", "xlink:href"],
        });
        if (!disposed)
          setDocument(
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; base-uri 'none'"><style>html{color-scheme:light}body{margin:16px;font:14px system-ui;text-align:center}svg{max-width:100%;height:auto}</style></head><body>${clean}</body></html>`,
          );
      } catch (cause) {
        if (!disposed)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to render this diagram.",
          );
      }
    })();
    return () => {
      disposed = true;
    };
  }, [source]);
  return (
    <figure className="diagram">
      <figcaption>Diagram</figcaption>
      {error ? (
        <p role="status">{error}</p>
      ) : document ? (
        <iframe
          title="Markdown diagram"
          sandbox=""
          srcDoc={document}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <p role="status">Rendering diagram…</p>
      )}
    </figure>
  );
}
