// Tabularius answers read like notes: the same markdown-it extensions as web notes (code blocks, callouts, task lists,
// tables) and Mermaid diagrams. [[path]] citations link to the note in web notes. Raw HTML stays escaped, external
// links open in a new tab and images are shown as links, so an answer fetches nothing by itself.
import MarkdownIt from "markdown-it";
import { escapeXml } from "@/features/tabularium/epub";
import { outsideCode } from "@/features/tabularium/render";
import { copyCode, enhance } from "./markdown";

export { copyCode };
export { renderDiagrams } from "./diagrams";

const EXTERNAL = /^(https?|mailto):/i;

/** `cite(path)` is the address of a cited note; `copy` the label of the code copy button. */
export function renderAnswer(text: string, cite: (path: string) => string, copy: string) {
    const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
    enhance(md, { copy });
    md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
        const token = tokens[index];
        const href = token.attrGet("href") ?? "";
        if (href.startsWith("cite:")) {
            token.attrSet("href", cite(decodeURIComponent(href.slice(5))));
            token.attrSet("class", "cite");
            // Followed inside the application, so web notes opens without reloading the page.
            token.attrSet("data-route", "");
        } else if (EXTERNAL.test(href)) {
            token.attrSet("target", "_blank");
            token.attrSet("rel", "noopener noreferrer");
        }
        return self.renderToken(tokens, index, options);
    };
    md.renderer.rules.image = (tokens, index) => {
        const src = tokens[index].attrGet("src") ?? "";
        const label = escapeXml(tokens[index].content || src);
        return EXTERNAL.test(src) ? `<a href="${escapeXml(src)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    };
    const linked = outsideCode(text, (part) =>
        part.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_, path: string, alias?: string) =>
            `[${(alias ?? path).replace(/[[\]]/g, "")}](cite:${encodeURIComponent(path.trim())})`)
    );
    return md.render(linked);
}
