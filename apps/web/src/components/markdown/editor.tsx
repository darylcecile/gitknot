import { useEffect, useId, useRef, useState } from "react";
import {
  Bold,
  Code,
  Eye,
  Heading2,
  Italic,
  List,
  ListOrdered,
  ListChecks,
  Link2,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
} from "lucide-react";
import { EditorView as CodeView } from "@codemirror/view";
import { EditorState as CodeState, type ChangeSet } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
  baseKeymap,
  setBlockType,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { splitListItem, wrapInList } from "prosemirror-schema-list";
import {
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  tableEditing,
} from "prosemirror-tables";
import {
  markdownSchema,
  parseCanonical,
  serializeCanonical,
} from "./schema.ts";
import { Markdown } from "./render.tsx";
import { Button, Modal } from "../ui.tsx";

// CodeMirror offsets count every line ending as one character. Apply its changes
// to canonical source offsets so untouched CRLF/mixed-newline blocks stay exact.
export function applySourceChanges(source: string, changes: ChangeSet): string {
  const offsets: number[] = [];
  for (let index = 0; index < source.length; index++) {
    offsets.push(index);
    if (source[index] === "\r" && source[index + 1] === "\n") index++;
  }
  offsets.push(source.length);
  const separator = source.match(/\r\n|\r|\n/)?.[0] || "\n";
  const edits: { from: number; to: number; text: string }[] = [];
  changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    edits.push({
      from: offsets[from]!,
      to: offsets[to]!,
      text: inserted.toString().replaceAll("\n", separator),
    });
  });
  for (const edit of edits.reverse())
    source = source.slice(0, edit.from) + edit.text + source.slice(edit.to);
  return source;
}

export function SourceEditor({
  value,
  onChange,
  label,
  id,
  language = "markdown",
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  id?: string;
  language?: "markdown" | "code";
}) {
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<CodeView | null>(null);
  const change = useRef(onChange);
  const canonical = useRef(value);
  const updating = useRef(false);
  change.current = onChange;
  useEffect(() => {
    if (!root.current) return;
    canonical.current = value;
    const view = new CodeView({
      parent: root.current,
      state: CodeState.create({
        doc: value,
        extensions: [
          basicSetup,
          ...(language === "markdown" ? [markdown()] : []),
          CodeView.lineWrapping,
          CodeView.contentAttributes.of({
            "aria-label": label,
            role: "textbox",
            "aria-multiline": "true",
            ...(id ? { id } : {}),
          }),
          CodeView.updateListener.of((update) => {
            if (update.docChanged && !updating.current) {
              canonical.current = applySourceChanges(
                canonical.current,
                update.changes,
              );
              change.current(canonical.current);
            }
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [id, label, language]);
  useEffect(() => {
    const view = editor.current;
    if (view && canonical.current !== value) {
      canonical.current = value;
      updating.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
      updating.current = false;
    }
  }, [value]);
  return <div className="source-editor" ref={root} />;
}

export function MarkdownEditor({
  value,
  onChange,
  label = "Markdown",
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  id?: string;
}) {
  const [mode, setMode] = useState<"rich" | "source" | "preview">("rich");
  return (
    <div className="markdown-editor">
      <div className="editor-modebar">
        <div className="segmented" role="group" aria-label="Editing mode">
          {(["rich", "source", "preview"] as const).map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={mode === item}
              onClick={() => setMode(item)}
            >
              {item === "rich" ? (
                "Write"
              ) : item === "source" ? (
                "Markdown"
              ) : (
                <>
                  <Eye size={14} />
                  Preview
                </>
              )}
            </button>
          ))}
        </div>
        <span className="editor-format-note">
          Markdown is the source of truth
        </span>
      </div>
      {mode === "source" ? (
        <SourceEditor id={id} value={value} onChange={onChange} label={label} />
      ) : mode === "preview" ? (
        <div className="editor-preview">
          {value ? (
            <Markdown source={value} />
          ) : (
            <p className="muted">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <RichEditor id={id} value={value} onChange={onChange} label={label} />
      )}
      <div className="editor-footnote">
        CommonMark + tables, tasks, code, and diagrams. Extended source blocks
        are preserved verbatim.
      </div>
    </div>
  );
}

function RichEditor({
  value,
  onChange,
  label,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  id?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  const latest = useRef(value);
  const [inTable, setInTable] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const linkId = useId();
  change.current = onChange;
  const execute = (command: Command) => {
    const view = editor.current;
    if (view) {
      command(view.state, view.dispatch, view);
      view.focus();
    }
  };
  const applyLink = () => {
    try {
      const url = new URL(linkUrl, location.origin);
      if (
        !["https:", "http:", "mailto:"].includes(url.protocol) ||
        !linkUrl.trim()
      )
        throw new Error("Use an HTTP, HTTPS, mailto, or relative link.");
      execute(toggleMark(markdownSchema.marks.link!, { href: linkUrl }));
      setLinkOpen(false);
    } catch (cause) {
      setLinkError(
        cause instanceof Error ? cause.message : "Enter a valid URL.",
      );
    }
  };
  useEffect(() => {
    if (!root.current) return;
    try {
      const view = new EditorView(root.current, {
        state: EditorState.create({
          schema: markdownSchema,
          doc: parseCanonical(value),
          plugins: [
            history(),
            keymap({
              "Mod-z": undo,
              "Mod-Shift-z": redo,
              "Mod-y": redo,
              "Mod-b": toggleMark(markdownSchema.marks.strong!),
              "Mod-i": toggleMark(markdownSchema.marks.em!),
              Enter: splitListItem(markdownSchema.nodes.list_item!),
              Tab: goToNextCell(1),
              "Shift-Tab": goToNextCell(-1),
            }),
            keymap(baseKeymap),
            tableEditing(),
          ],
        }),
        attributes: {
          role: "textbox",
          "aria-label": label,
          "aria-multiline": "true",
          ...(id ? { id } : {}),
        },
        dispatchTransaction(transaction) {
          view.updateState(view.state.apply(transaction));
          const selection = view.state.selection.$from;
          let table = false;
          for (let depth = selection.depth; depth > 0; depth--)
            if (selection.node(depth).type.name === "table") table = true;
          setInTable(table);
          if (transaction.docChanged) {
            latest.current = serializeCanonical(view.state.doc);
            change.current(latest.current);
          }
        },
        handleClickOn(view, _pos, node, nodePos, event) {
          if (
            node.type.name !== "list_item" ||
            node.attrs.checked === null ||
            !(event.target instanceof HTMLInputElement)
          )
            return false;
          view.dispatch(
            view.state.tr.setNodeMarkup(nodePos, undefined, {
              ...node.attrs,
              checked: !node.attrs.checked,
            }),
          );
          return true;
        },
        handleDOMEvents: {
          click: (_view, event) => {
            if (event.target instanceof Element && event.target.closest("a")) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
      });
      editor.current = view;
      return () => {
        view.destroy();
        editor.current = null;
      };
    } catch (cause) {
      setEditorError(
        cause instanceof Error
          ? cause.message
          : "Unable to open the rich editor. Use Markdown mode.",
      );
    }
  }, [id, label]);
  useEffect(() => {
    const view = editor.current;
    if (view && value !== latest.current) {
      latest.current = value;
      view.updateState(
        EditorState.create({
          schema: markdownSchema,
          doc: parseCanonical(value),
          plugins: view.state.plugins,
        }),
      );
    }
  }, [value]);
  const insertTable: Command = (state, dispatch) => {
    const cell = () => markdownSchema.nodes.table_cell!.createAndFill()!;
    const header = () => markdownSchema.nodes.table_header!.createAndFill()!;
    const row = markdownSchema.nodes.table_row!;
    const table = markdownSchema.nodes.table!.create(null, [
      row.create(null, [header(), header(), header()]),
      row.create(null, [cell(), cell(), cell()]),
    ]);
    if (dispatch)
      dispatch(state.tr.replaceSelectionWith(table).scrollIntoView());
    return true;
  };
  const tools = [
    {
      label: "Bold (⌘/Ctrl B)",
      icon: Bold,
      command: toggleMark(markdownSchema.marks.strong!),
    },
    {
      label: "Italic (⌘/Ctrl I)",
      icon: Italic,
      command: toggleMark(markdownSchema.marks.em!),
    },
    {
      label: "Strikethrough",
      icon: Strikethrough,
      command: toggleMark(markdownSchema.marks.strike!),
    },
    {
      label: "Heading",
      icon: Heading2,
      command: setBlockType(markdownSchema.nodes.heading!, { level: 2 }),
    },
    {
      label: "Bullet list",
      icon: List,
      command: wrapInList(markdownSchema.nodes.bullet_list!),
    },
    {
      label: "Numbered list",
      icon: ListOrdered,
      command: wrapInList(markdownSchema.nodes.ordered_list!),
    },
    {
      label: "Quote",
      icon: Quote,
      command: wrapIn(markdownSchema.nodes.blockquote!),
    },
    {
      label: "Code block",
      icon: Code,
      command: setBlockType(markdownSchema.nodes.code_block!),
    },
    { label: "Insert table", icon: Table, command: insertTable },
    {
      label: "Task list",
      icon: ListChecks,
      command: ((state, dispatch) => {
        const list = markdownSchema.nodes.bullet_list!.create(null, [
          markdownSchema.nodes.list_item!.createAndFill({ checked: false })!,
        ]);
        if (dispatch)
          dispatch(state.tr.replaceSelectionWith(list).scrollIntoView());
        return true;
      }) as Command,
    },
    {
      label: "Add link",
      icon: Link2,
      command: (() => {
        setLinkUrl("");
        setLinkError("");
        setLinkOpen(true);
        return true;
      }) as Command,
    },
    { label: "Undo", icon: Undo2, command: undo },
    { label: "Redo", icon: Redo2, command: redo },
  ];
  return (
    <>
      <div
        className="editor-toolbar"
        role="toolbar"
        aria-label="Text formatting"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button",
            ),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (index < 0) return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        }}
      >
        {tools.map((tool) => (
          <button
            type="button"
            key={tool.label}
            aria-label={tool.label}
            title={tool.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => execute(tool.command)}
          >
            <tool.icon size={16} />
          </button>
        ))}
        {inTable && (
          <div className="table-tools">
            {[
              { label: "Add row", command: addRowAfter },
              { label: "Add column", command: addColumnAfter },
              { label: "Delete row", command: deleteRow },
              { label: "Delete column", command: deleteColumn },
              { label: "Delete table", command: deleteTable },
            ].map((tool) => (
              <button
                type="button"
                key={tool.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => execute(tool.command)}
              >
                {tool.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {editorError && <p role="alert">{editorError}</p>}
      <div className="rich-editor markdown" ref={root} />
      <Modal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Link selected text"
      >
        <div className="modal-body">
          <div className="field">
            <label htmlFor={linkId}>Link URL</label>
            <input
              id={linkId}
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  applyLink();
                }
              }}
              placeholder="https://"
            />
          </div>
          {linkError && <p role="alert">{linkError}</p>}
          <div className="form-actions">
            <Button
              onClick={() => {
                const view = editor.current;
                if (view)
                  view.dispatch(
                    view.state.tr.removeMark(
                      view.state.selection.from,
                      view.state.selection.to,
                      markdownSchema.marks.link,
                    ),
                  );
                setLinkOpen(false);
              }}
            >
              Remove link
            </Button>
            <Button variant="primary" onClick={applyLink}>
              Apply link
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
