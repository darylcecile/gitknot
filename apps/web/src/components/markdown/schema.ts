import {
  DOMParser as ProseMirrorDOMParser,
  Schema,
  type Node as ProseMirrorNode,
  type NodeSpec,
} from "prosemirror-model";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownSerializer,
} from "prosemirror-markdown";
import { tableNodes } from "prosemirror-tables";
import { marked, type Token } from "marked";
import { safeHtml } from "./render.tsx";

const sourceAttrs = {
  source: { default: null },
  fingerprint: { default: null },
};
let nodes = defaultMarkdownParser.schema.spec.nodes;
nodes.forEach((name, spec) => {
  if (name !== "doc" && name !== "text")
    nodes = nodes.update(name, {
      ...spec,
      attrs: { ...spec.attrs, ...sourceAttrs },
    });
});
const listItem = nodes.get("list_item")!;
nodes = nodes.update("list_item", {
  ...listItem,
  attrs: { ...listItem.attrs, checked: { default: null } },
  parseDOM: [
    {
      tag: "li",
      getAttrs: (element) => {
        const input = (element as HTMLElement).querySelector(
          ":scope > input[type=checkbox]",
        );
        return { checked: input ? input.hasAttribute("checked") : null };
      },
    },
  ],
  toDOM: (node) =>
    node.attrs.checked === null
      ? ["li", 0]
      : [
          "li",
          { "data-task": "true" },
          [
            "input",
            {
              type: "checkbox",
              ...(node.attrs.checked ? { checked: "checked" } : {}),
              contenteditable: "false",
              "aria-label": "Toggle task",
            },
          ],
          ["div", 0],
        ],
});
const tables = tableNodes({
  tableGroup: "block",
  cellContent: "paragraph+",
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => dom.getAttribute("align"),
      setDOMAttr: (value, attrs) => {
        if (value) attrs.align = value;
      },
    },
  },
});
for (const [name, spec] of Object.entries(tables))
  nodes = nodes.addToEnd(name, {
    ...spec,
    attrs: { ...spec.attrs, ...sourceAttrs },
  });
const preserved: NodeSpec = {
  group: "block",
  atom: true,
  selectable: true,
  isolating: true,
  attrs: { ...sourceAttrs, raw: {}, kind: { default: "source" } },
  toDOM: (node) => [
    "div",
    { class: "preserved-block", contenteditable: "false" },
    [
      "span",
      { class: "preserved-label" },
      `${node.attrs.kind} · source preserved`,
    ],
    ["pre", String(node.attrs.raw)],
  ],
};
nodes = nodes.addToEnd("preserved_block", preserved);
export const markdownSchema = new Schema({
  nodes,
  marks: defaultMarkdownParser.schema.spec.marks.addToEnd("strike", {
    parseDOM: [{ tag: "del" }, { tag: "s" }],
    toDOM: () => ["del", 0],
  }),
});

function fingerprint(node: ProseMirrorNode): string {
  return JSON.stringify(node.toJSON(), (key, value: unknown) =>
    key === "source" || key === "fingerprint" ? undefined : value,
  );
}

function containsUnsupported(token: Token): boolean {
  if (token.type === "html" || token.type === "def") return true;
  if (
    "tokens" in token &&
    Array.isArray(token.tokens) &&
    token.tokens.some(containsUnsupported)
  )
    return true;
  if (token.type === "list")
    return token.items.some((item: { tokens: Token[] }) =>
      item.tokens.some(containsUnsupported),
    );
  return false;
}

function rawNode(raw: string, kind = "Markdown") {
  return markdownSchema.nodes.preserved_block!.create({ raw, kind });
}

// Map normalized lexer offsets back to the original bytes, including CRLF and lone CR.
function sourceMap(source: string) {
  let normalized = "";
  const offsets: number[] = [];
  for (let index = 0; index < source.length; index++) {
    offsets.push(index);
    const char = source[index]!;
    if (char === "\r") {
      normalized += "\n";
      if (source[index + 1] === "\n") index++;
    } else normalized += char;
  }
  offsets.push(source.length);
  return { normalized, offsets };
}

export function parseCanonical(source: string): ProseMirrorNode {
  if (!source) return markdownSchema.topNodeType.createAndFill()!;
  const { normalized, offsets } = sourceMap(source);
  const tokens = marked.lexer(normalized, { gfm: true });
  const children: ProseMirrorNode[] = [];
  let position = 0;
  let leading = "";
  const preserveGap = (raw: string) => {
    if (!raw) return;
    const last = children.at(-1);
    if (/^\s*$/.test(raw) && last && last.attrs.source !== null)
      children[children.length - 1] = last.type.create(
        { ...last.attrs, source: last.attrs.source + raw },
        last.content,
        last.marks,
      );
    else if (/^\s*$/.test(raw) && !last) leading += raw;
    else children.push(rawNode(raw));
  };
  for (const token of tokens) {
    const start = normalized.indexOf(token.raw, position);
    if (start < 0) {
      return markdownSchema.topNodeType.create(null, [rawNode(source)]);
    }
    preserveGap(source.slice(offsets[position], offsets[start]));
    const end = start + token.raw.length;
    const raw = source.slice(offsets[start], offsets[end]);
    position = end;
    if (token.type === "space") {
      preserveGap(raw);
      continue;
    }
    if (containsUnsupported(token)) {
      children.push(
        rawNode(
          leading + raw,
          token.type === "html" ? "HTML" : "Extended Markdown",
        ),
      );
      leading = "";
      continue;
    }
    const dom = document.createElement("div");
    dom.innerHTML = safeHtml(marked.parser([token]));
    const parsed = ProseMirrorDOMParser.fromSchema(markdownSchema).parse(dom);
    if (parsed.childCount !== 1) {
      children.push(rawNode(leading + raw));
      leading = "";
      continue;
    }
    const node = parsed.child(0);
    children.push(
      node.type.create(
        {
          ...node.attrs,
          source: leading + raw,
          fingerprint: fingerprint(node),
        },
        node.content,
        node.marks,
      ),
    );
    leading = "";
  }
  preserveGap(source.slice(offsets[position]));
  if (leading) children.push(rawNode(leading));
  return markdownSchema.topNodeType.create(
    null,
    children.length ? children : [markdownSchema.nodes.paragraph!.create()],
  );
}

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    preserved_block(state, node) {
      state.write(node.attrs.raw);
      state.closeBlock(node);
    },
    list_item(state, node) {
      if (node.attrs.checked !== null)
        state.write(node.attrs.checked ? "[x] " : "[ ] ");
      state.renderContent(node);
    },
    table(state, node) {
      const rows: string[][] = [];
      node.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => {
          cells.push(
            serializer
              .serialize(markdownSchema.topNodeType.create(null, cell.content))
              .replaceAll("\n", "<br>")
              .replaceAll("|", "\\|"),
          );
        });
        rows.push(cells);
      });
      if (rows[0]) {
        state.write(`| ${rows[0].join(" | ")} |\n`);
        const alignments: string[] = [];
        node
          .child(0)
          .forEach((cell) =>
            alignments.push(
              cell.attrs.align === "center"
                ? ":---:"
                : cell.attrs.align === "right"
                  ? "---:"
                  : "---",
            ),
          );
        state.write(`| ${alignments.join(" | ")} |\n`);
        for (const row of rows.slice(1))
          state.write(`| ${row.join(" | ")} |\n`);
      }
      state.closeBlock(node);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strike: {
      open: "~~",
      close: "~~",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
  },
);

export function serializeCanonical(doc: ProseMirrorNode): string {
  let source = "";
  doc.forEach((node) => {
    if (node.type.name === "preserved_block") {
      source += node.attrs.raw;
      return;
    }
    if (
      node.attrs.source !== null &&
      node.attrs.fingerprint === fingerprint(node)
    ) {
      source += node.attrs.source;
      return;
    }
    const current = serializer.serialize(
      markdownSchema.topNodeType.create(null, [node]),
    );
    const original =
      typeof node.attrs.source === "string" ? node.attrs.source : "";
    const suffix = original.match(/(?:\r?\n)*$/)?.[0] || "\n\n";
    if (source && !source.endsWith("\n")) source += "\n\n";
    source += current + suffix;
  });
  return source;
}
