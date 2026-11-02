// In Collation.md, a list item's note after " —— " goes behind an ⓘ icon after the name, shown on hover or tap like the
// explanations on the web pages (`tip`).
import type MarkdownIt from "markdown-it";
import { NOTE_SEPARATOR } from "@/core/common/fileOrder";

export function foldSortingNotes(md: MarkdownIt, tip: (text: string) => string) {
    md.core.ruler.push("collation_notes", (state) => {
        state.tokens.forEach((token, index) => {
            if (token.type !== "inline" || state.tokens[index - 2]?.type !== "list_item_open" || !token.children) return;
            const children = token.children;
            const at = children.findIndex((child) => child.type === "text" && child.content.includes(NOTE_SEPARATOR));
            if (at < 0) return;
            const text = children[at].content;
            const cut = text.indexOf(NOTE_SEPARATOR);
            const note = [text.slice(cut + NOTE_SEPARATOR.length), ...children.slice(at + 1).map((child) => child.content)].join("").trim();
            children[at].content = text.slice(0, cut);
            const icon = new state.Token("html_inline", "", 0);
            icon.content = tip(note);
            children.splice(at + 1, children.length, icon);
        });
    });
}
