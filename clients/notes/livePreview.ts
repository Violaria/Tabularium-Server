// Live render for the web notes editor, after Obsidian's live preview: the line the cursor is on shows its Markdown as
// written; everywhere else the marks are hidden and the text is styled. Diagrams, formulas and tables are drawn when the
// cursor is not inside them; a click puts the cursor back into their source. Only decorations change: the document is
// the note's text, untouched.
import { Facet, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { inlineMathEnd } from "./math";
import { renderDiagrams } from "./diagrams";
import { renderMath } from "./math";
import { element } from "./dom";

export interface LiveOptions {
    /** An object URL for an embedded vault file that is an image, or undefined. */
    image(target: string): Promise<string | undefined>;
    /** HTML of a Markdown fragment (a table) as the reading view renders it. */
    render(markdown: string): string;
}

/** The vault's images and the reading view's renderer, for the editor this extension is in. */
const liveOptions = Facet.define<LiveOptions, LiveOptions>({ combine: (values) => values[0] });

const hide = Decoration.replace({});
const lines = new WeakSet<Decoration>();
const line = (cls: string) => {
    const decoration = Decoration.line({ class: cls });
    lines.add(decoration);
    return decoration;
};
const isLine = (decoration: Decoration) => lines.has(decoration);
const mark = (cls: string) => Decoration.mark({ class: cls });

/** Line numbers that hold a cursor or part of a selection: they show their Markdown. */
function activeLines(state: EditorState) {
    const lines = new Set<number>();
    for (const range of state.selection.ranges) {
        const first = state.doc.lineAt(range.from).number;
        const last = state.doc.lineAt(range.to).number;
        for (let n = first; n <= last; n++) lines.add(n);
    }
    return lines;
}
/** The YAML front matter at the top of the note, if any: [from, to) in the document. */
function frontMatter(state: EditorState): [number, number] | undefined {
    const match = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(state.doc.sliceString(0, Math.min(state.doc.length, 20000)));
    return match ? [0, match[0].length] : undefined;
}

class Bullet extends WidgetType {
    override eq() {
        return true;
    }
    override toDOM() {
        const span = element("span");
        span.className = "cm-bullet";
        span.textContent = "•";
        return span;
    }
}
class Checkbox extends WidgetType {
    constructor(readonly checked: boolean) {
        super();
    }
    override eq(other: Checkbox) {
        return other.checked === this.checked;
    }
    override toDOM(view: EditorView) {
        const box = element("input");
        box.type = "checkbox";
        box.checked = this.checked;
        box.className = "cm-task";
        // Ticking the box writes [x] or [ ] into the note, nothing else.
        box.addEventListener("mousedown", (event) => {
            event.preventDefault();
            const at = view.posAtDOM(box);
            const text = view.state.doc.sliceString(at, at + 3);
            if (!/^\[[ xX]\]$/.test(text)) return;
            view.dispatch({ changes: { from: at + 1, to: at + 2, insert: this.checked ? " " : "x" } });
        });
        return box;
    }
    override ignoreEvent() {
        return false;
    }
}
class Rule extends WidgetType {
    override eq() {
        return true;
    }
    override toDOM() {
        const hr = element("span");
        hr.className = "cm-rule";
        return hr;
    }
}
class Picture extends WidgetType {
    constructor(readonly target: string, readonly options: LiveOptions) {
        super();
    }
    override eq(other: Picture) {
        return other.target === this.target;
    }
    override toDOM() {
        const span = element("span");
        span.className = "cm-embed";
        span.textContent = this.target;
        void this.options.image(this.target).then((url) => {
            if (!url) return;
            const img = element("img");
            img.src = url;
            img.alt = this.target;
            span.replaceChildren(img);
        });
        return span;
    }
}
class InlineFormula extends WidgetType {
    constructor(readonly tex: string, readonly display: boolean) {
        super();
    }
    override eq(other: InlineFormula) {
        return other.tex === this.tex && other.display === this.display;
    }
    override toDOM() {
        const span = element("span");
        span.className = `math${this.display ? " display" : ""} cm-math`;
        span.dataset.tex = this.tex;
        span.textContent = this.tex;
        void renderMath(span.parentNode ?? wrap(span));
        return span;
    }
}
/** A detached element's own parent, so that the renderers (which search below a root) find it. */
function wrap(detached: HTMLElement) {
    const holder = element("span");
    holder.append(detached);
    return holder;
}
/** A drawn block (diagram, formula, table) in place of its source; a click puts the cursor at its start. */
class Block extends WidgetType {
    constructor(readonly kind: "mermaid" | "math" | "table", readonly source: string) {
        super();
    }
    override eq(other: Block) {
        return other.kind === this.kind && other.source === this.source;
    }
    override toDOM(view: EditorView) {
        const box = element("div");
        box.className = `cm-block cm-block-${this.kind} md-body`;
        if (this.kind === "mermaid") {
            const figure = element("figure");
            figure.className = "mermaid-diagram";
            figure.dataset.source = this.source;
            const pre = element("pre");
            pre.textContent = this.source;
            figure.append(pre);
            box.append(figure);
            queueMicrotask(() => void renderDiagrams(box));
        } else if (this.kind === "math") {
            const div = element("div");
            div.className = "math display";
            div.dataset.tex = this.source;
            div.textContent = this.source;
            box.append(div);
            queueMicrotask(() => void renderMath(box));
        } else {
            // The table's HTML comes from the reading view's renderer (raw HTML disabled there).
            box.replaceChildren(...new DOMParser().parseFromString(`<body>${view.state.facet(liveOptions).render(this.source)}</body>`, "text/html").body.childNodes);
        }
        box.addEventListener("mousedown", (event) => {
            event.preventDefault();
            view.dispatch({ selection: { anchor: view.posAtDOM(box) } });
            view.focus();
        });
        return box;
    }
    override ignoreEvent() {
        return false;
    }
}

/** Where blocks drawn in place of their source are: fenced Mermaid, $$ formulas and tables, outside the cursor. */
function blocks(state: EditorState): DecorationSet {
    const active = activeLines(state);
    const touched = (from: number, to: number) => {
        const first = state.doc.lineAt(from).number;
        const last = state.doc.lineAt(to).number;
        for (let n = first; n <= last; n++) if (active.has(n)) return true;
        return false;
    };
    const found: Range<Decoration>[] = [];
    const code: [number, number][] = [];
    syntaxTree(state).iterate({
        enter: (node) => {
            if (node.name === "FencedCode") {
                code.push([node.from, node.to]);
                const info = state.doc.sliceString(node.from, node.to).split("\n")[0].replace(/^[`~]+/, "").trim().toLowerCase();
                if (info === "mermaid" && !touched(node.from, node.to)) {
                    const text = state.doc.sliceString(node.from, node.to);
                    const source = text.split("\n").slice(1, -1).join("\n");
                    found.push(Decoration.replace({ widget: new Block("mermaid", source), block: true }).range(node.from, node.to));
                }
                return false;
            }
            if (node.name === "Table" && !touched(node.from, node.to)) {
                found.push(Decoration.replace({ widget: new Block("table", state.doc.sliceString(node.from, node.to)), block: true }).range(node.from, node.to));
                return false;
            }
            return undefined;
        },
    });
    // $$ blocks: a line starting with $$ to the next line ending with $$, outside code.
    const inCode = (pos: number) => code.some(([from, to]) => pos >= from && pos < to);
    for (let n = 1; n <= state.doc.lines; n++) {
        const start = state.doc.line(n);
        if (!start.text.startsWith("$$") || inCode(start.from)) continue;
        let end = n;
        if (!/^\$\$.+\$\$\s*$/.test(start.text)) {
            for (end = n + 1; end <= state.doc.lines && !state.doc.line(end).text.trimEnd().endsWith("$$"); end++);
            if (end > state.doc.lines) break;
        }
        const last = state.doc.line(end);
        if (!touched(start.from, last.to)) {
            const tex = state.doc.sliceString(start.from, last.to).trim().replace(/^\$\$/, "").replace(/\$\$$/, "").trim();
            found.push(Decoration.replace({ widget: new Block("math", tex), block: true }).range(start.from, last.to));
        }
        n = end;
    }
    return Decoration.set(found, true);
}
const blockField = StateField.define<DecorationSet>({
    create: blocks,
    update: (value, transaction) => (transaction.docChanged || transaction.selection ? blocks(transaction.state) : value),
    provide: (field) => EditorView.decorations.from(field),
});

/** Inline styling and hidden marks in the visible part of the note. */
function inline(view: EditorView, options: LiveOptions): DecorationSet {
    const { state } = view;
    const active = activeLines(state);
    const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
    const front = frontMatter(state);
    const found: Range<Decoration>[] = [];
    // Line decorations sit at a line's start; marks and replacements need a non-empty range (widgets may be empty).
    const add = (from: number, to: number, decoration: Decoration) => {
        if (from < to || (decoration.spec as { widget?: unknown }).widget || isLine(decoration))
            found.push(decoration.range(from, to));
    };
    const code: [number, number][] = [];
    for (const { from, to } of view.visibleRanges) {
        syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
                if (front && node.from < front[1]) return node.to > front[1] ? undefined : false;
                const name = node.name;
                const hidden = !isActive(node.from);
                const heading = /^ATXHeading(\d)$/.exec(name);
                if (heading) {
                    add(state.doc.lineAt(node.from).from, state.doc.lineAt(node.from).from, line(`cm-h cm-h${heading[1]}`));
                    return undefined;
                }
                if (name === "HeaderMark" && hidden) {
                    // The marks and the space after them.
                    const after = state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
                    add(node.from, node.to + after, hide);
                    return undefined;
                }
                if (name === "Emphasis") add(node.from, node.to, mark("cm-em"));
                else if (name === "StrongEmphasis") add(node.from, node.to, mark("cm-strong"));
                else if (name === "Strikethrough") add(node.from, node.to, mark("cm-strike"));
                else if (name === "InlineCode") {
                    code.push([node.from, node.to]);
                    add(node.from, node.to, mark("cm-inline-code"));
                } else if ((name === "EmphasisMark" || name === "StrikethroughMark" || name === "CodeMark") && hidden) add(node.from, node.to, hide);
                else if (name === "Link") {
                    add(node.from, node.to, mark("cm-link"));
                    if (hidden) {
                        // [label](url): only the label shows.
                        const text = state.doc.sliceString(node.from, node.to);
                        const close = text.indexOf("](");
                        if (text.startsWith("[") && close > 0) {
                            add(node.from, node.from + 1, hide);
                            add(node.from + close, node.to, hide);
                        }
                    }
                    return false;
                } else if (name === "Image" && hidden) {
                    const text = state.doc.sliceString(node.from, node.to);
                    const url = /\]\(([^)\s]+)/.exec(text)?.[1];
                    if (url && !/^https?:/i.test(url)) add(node.from, node.to, Decoration.replace({ widget: new Picture(decodeURI(url), options) }));
                    return false;
                } else if (name === "Blockquote") {
                    for (let pos = node.from; pos <= node.to; ) {
                        const current = state.doc.lineAt(pos);
                        add(current.from, current.from, line("cm-quote"));
                        pos = current.to + 1;
                    }
                } else if (name === "QuoteMark" && hidden) {
                    const after = state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
                    add(node.from, node.to + after, hide);
                } else if (name === "ListMark" && hidden && /^[-*+]$/.test(state.doc.sliceString(node.from, node.to))) {
                    // A task's dash goes; a bullet becomes a dot.
                    const task = /^ \[[ xX]\]/.test(state.doc.sliceString(node.to, node.to + 4));
                    add(node.from, node.to + (task ? 1 : 0), task ? hide : Decoration.replace({ widget: new Bullet() }));
                } else if (name === "TaskMarker") {
                    const checked = /x/i.test(state.doc.sliceString(node.from, node.to));
                    if (hidden) add(node.from, node.to, Decoration.replace({ widget: new Checkbox(checked) }));
                    if (checked) {
                        const rest = state.doc.lineAt(node.to);
                        add(node.to, rest.to, mark("cm-done"));
                    }
                } else if (name === "HorizontalRule" && hidden) add(node.from, node.to, Decoration.replace({ widget: new Rule() }));
                else if (name === "FencedCode") {
                    code.push([node.from, node.to]);
                    for (let pos = node.from; pos <= node.to; ) {
                        const current = state.doc.lineAt(pos);
                        const edge = current.from === node.from || current.to === node.to;
                        add(current.from, current.from, line(edge ? "cm-fence" : "cm-codeblock"));
                        pos = current.to + 1;
                    }
                    return false;
                }
                return undefined;
            },
        });
        // Obsidian's own syntax, outside code: [[links]], ![[embeds]], ==highlights==, %%comments%%, $formulas$, callouts.
        const inCode = (pos: number) => code.some(([a, b]) => pos >= a && pos < b);
        for (let pos = from; pos <= to; ) {
            const current = state.doc.lineAt(pos);
            pos = current.to + 1;
            if (front && current.from < front[1]) {
                add(current.from, current.from, line("cm-frontmatter"));
                continue;
            }
            if (inCode(current.from)) continue;
            const text = current.text;
            const hidden = !active.has(current.number);
            const callout = /^(>\s*)\[!([A-Za-z-]+)\][+-]?\s*/.exec(text);
            if (callout) {
                const title = Decoration.line({ class: "cm-callout-title", attributes: { "data-callout": callout[2].toLowerCase() } });
                lines.add(title);
                add(current.from, current.from, title);
                if (hidden) add(current.from + callout[1].length, current.from + callout[0].length, hide);
            }
            for (const match of text.matchAll(/(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) {
                const start = current.from + match.index;
                const end = start + match[0].length;
                if (inCode(start)) continue;
                if (match[1] && hidden) {
                    add(start, end, Decoration.replace({ widget: new Picture(match[2].trim(), options) }));
                    continue;
                }
                add(start, end, mark("cm-link"));
                if (hidden) {
                    const label = match[3] ?? match[2];
                    const labelStart = match[3] !== undefined ? end - 2 - match[3].length : start + 2;
                    add(start, labelStart, hide);
                    add(labelStart + label.length, end, hide);
                }
            }
            for (const match of text.matchAll(/==([^=\n]+)==/g)) {
                const start = current.from + match.index;
                if (inCode(start)) continue;
                add(start, start + match[0].length, mark("cm-highlight"));
                if (hidden) {
                    add(start, start + 2, hide);
                    add(start + match[0].length - 2, start + match[0].length, hide);
                }
            }
            for (const match of text.matchAll(/%%[^%\n]*%%/g)) add(current.from + match.index, current.from + match.index + match[0].length, mark("cm-comment"));
            if (!text.startsWith("$$"))
                for (let at = text.indexOf("$"); at >= 0; at = text.indexOf("$", at + 1)) {
                    const end = inlineMathEnd(text, at);
                    if (end < 0 || inCode(current.from + at)) continue;
                    const display = text[at + 1] === "$";
                    if (hidden) add(current.from + at, current.from + end, Decoration.replace({ widget: new InlineFormula(text.slice(at + (display ? 2 : 1), end - (display ? 2 : 1)), display) }));
                    else add(current.from + at, current.from + end, mark("cm-math-source"));
                    at = end - 1;
                }
        }
    }
    // Replacements must not overlap: in document order, the first one at a place wins.
    found.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
    let last = -1;
    const kept = found.filter((range) => {
        if ((range.value.spec as { widget?: unknown }).widget === undefined && range.value !== hide) return true;
        if (range.from < last) return false;
        last = range.to;
        return true;
    });
    return Decoration.set(kept, true);
}

const live = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
            this.decorations = inline(view, view.state.facet(liveOptions));
        }
        update(update: ViewUpdate) {
            if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) this.decorations = inline(update.view, update.state.facet(liveOptions));
        }
    },
    { decorations: (plugin) => plugin.decorations }
);

/** The live render extension; `options` give it the vault's images and the reading view's renderer. */
export function livePreview(options: LiveOptions): Extension {
    return [liveOptions.of(options), live, blockField, EditorView.editorAttributes.of({ class: "cm-live" })];
}
