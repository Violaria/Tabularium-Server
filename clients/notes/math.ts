// Formulas: $…$ inline and $$…$$ as a block, written as in Obsidian and drawn with KaTeX. KaTeX is loaded only when a
// page has a formula. The scanning rules are shared with the editor's live render, so both see the same formulas.
import type MarkdownIt from "markdown-it";
import { escapeXml } from "@/features/tabularium/epub";

/**
 * The end (exclusive) of an inline formula starting at `start` in `text`, or -1. "$$…$$" on one line is a display
 * formula. Like Pandoc and Obsidian: the opening "$" is not followed by a space, the closing one is not preceded by a
 * space or a backslash nor followed by a digit, so prices ("$5 and $10") are not formulas.
 */
export function inlineMathEnd(text: string, start: number): number {
    if (text[start] !== "$" || text[start - 1] === "\\") return -1;
    if (text[start + 1] === "$") {
        const close = text.indexOf("$$", start + 2);
        if (close < 0 || close === start + 2 || text.slice(start + 2, close).includes("\n\n")) return -1;
        return close + 2;
    }
    if (!text[start + 1] || /\s/.test(text[start + 1])) return -1;
    for (let at = start + 1; at < text.length; at++) {
        const char = text[at];
        if (char === "\n" && text[at + 1] === "\n") return -1;
        if (char === "\\") {
            at++;
            continue;
        }
        if (char !== "$") continue;
        if (/\s/.test(text[at - 1]) || /\d/.test(text[at + 1] ?? "")) return -1;
        return at + 1;
    }
    return -1;
}

/** markdown-it rules: inline formulas, and blocks between lines that start and end with "$$". */
export function math(md: MarkdownIt) {
    md.inline.ruler.before("escape", "math_inline", (state, silent) => {
        const end = inlineMathEnd(state.src, state.pos);
        if (end < 0) return false;
        if (!silent) {
            const display = state.src[state.pos + 1] === "$";
            const token = state.push("math_inline", "", 0);
            token.content = state.src.slice(state.pos + (display ? 2 : 1), end - (display ? 2 : 1));
            token.meta = { display };
        }
        state.pos = end;
        return true;
    });
    md.block.ruler.before("fence", "math_block", (state, startLine, endLine, silent) => {
        const start = state.bMarks[startLine] + state.tShift[startLine];
        const first = state.src.slice(start, state.eMarks[startLine]);
        if (!first.startsWith("$$")) return false;
        let content: string;
        let last = startLine;
        const single = /^\$\$(.+)\$\$\s*$/.exec(first);
        if (single) content = single[1];
        else {
            const lines = [first.slice(2)];
            for (last = startLine + 1; last < endLine; last++) {
                const line = state.src.slice(state.bMarks[last] + state.tShift[last], state.eMarks[last]);
                if (line.trimEnd().endsWith("$$")) {
                    lines.push(line.trimEnd().slice(0, -2));
                    break;
                }
                lines.push(line);
            }
            if (last >= endLine) return false;
            content = lines.join("\n");
        }
        if (silent) return true;
        const token = state.push("math_block", "div", 0);
        token.content = content.trim();
        token.map = [startLine, last + 1];
        state.line = last + 1;
        return true;
    });
    md.renderer.rules.math_inline = (tokens, index) =>
        `<span class="math${(tokens[index].meta as { display?: boolean } | null)?.display ? " display" : ""}" data-tex="${escapeXml(tokens[index].content)}">${escapeXml(tokens[index].content)}</span>`;
    md.renderer.rules.math_block = (tokens, index) => `<div class="math display" data-tex="${escapeXml(tokens[index].content)}">${escapeXml(tokens[index].content)}</div>\n`;
}

let loading: Promise<typeof import("katex").default> | undefined;
function katex() {
    loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([{ default: library }]) => library);
    return loading;
}

/** Draws the formulas under `root` that are not drawn yet; a formula with an error shows its source and the error. */
export async function renderMath(root: ParentNode) {
    const items = [...root.querySelectorAll<HTMLElement>(".math[data-tex]:not([data-drawn])")];
    if (!items.length) return;
    const library = await katex();
    for (const item of items) {
        item.dataset.drawn = "";
        library.render(item.dataset.tex ?? "", item, { displayMode: item.classList.contains("display"), throwOnError: false, strict: "ignore", output: "htmlAndMathml" });
    }
}
