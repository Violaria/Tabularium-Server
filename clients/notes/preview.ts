// Markdown preview for the web notes page. Raw HTML is escaped (markdown-it `html: false`); links between
// notes become in-page navigation, embedded vault images are marked for loading from the local replica,
// and remote images are shown as links so that nothing is fetched without a click.
import MarkdownIt from "markdown-it";
import { escapeXml } from "@/features/tabularium/epub";
import { outsideCode, stripFrontMatter } from "@/features/tabularium/render";
import { stripMarks } from "@/features/tabularium/sensitive";
import { t } from "../../ui/i18n";
import { enhance } from "./markdown";
import { tip } from "../../ui/core";
import { foldSortingNotes } from "./sortingNotes";

export type Resolver = (target: string) => string | undefined;

const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
const EXTERNAL = /^(https?|mailto):/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const name = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

function rewriteObsidian(markdown: string) {
    return outsideCode(markdown, (part) =>
        part
            .replace(/%%[\s\S]*?%%/g, "")
            .replace(/!\[\[([^\]|]+?)\\?(?:\|([^\]]*))?\]\]/g, (_, target: string, alias: string = "") =>
                `![${alias.replace(/^\d+(x\d+)?$/, "")}](embed:${encodeURIComponent(target.trim())})`)
            .replace(/\[\[([^\]|]+?)\\?(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) =>
                `[${(alias ?? target).replace(/[[\]]/g, "")}](note:${encodeURIComponent(target.trim())})`)
    );
}

/** Link target written in the note, decoded; undefined for external links. */
function target(href: string) {
    if (href.startsWith("note:") || href.startsWith("embed:")) return decodeURIComponent(href.slice(href.indexOf(":") + 1));
    if (SCHEME.test(href) || href.startsWith("#")) return undefined;
    try {
        return decodeURI(href);
    } catch {
        return href;
    }
}

export function renderPreview(markdown: string, resolve: Resolver, options: { sortingNotes?: boolean; keepMarks?: boolean } = {}) {
    const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
    enhance(md, { copy: t("notes.copyCode") });
    if (options.sortingNotes) foldSortingNotes(md, tip);
    const internal = new WeakMap<object, string | null>();
    md.renderer.rules.image = (tokens, index) => {
        const src = tokens[index].attrGet("src") ?? "";
        const alt = tokens[index].content;
        if (EXTERNAL.test(src)) {
            return `<a class="remote-image" href="${escapeXml(src)}" target="_blank" rel="noopener noreferrer">${escapeXml(t("notes.remoteImage", { name: alt || src }))}</a>`;
        }
        const written = target(src) ?? src;
        const path = resolve(written);
        if (!path) return `<span class="missing">${escapeXml(t("notes.notFound", { name: written }))}</span>`;
        if (IMAGE.test(path)) return `<img data-vault-src="${escapeXml(path)}" alt="${escapeXml(alt)}"/>`;
        return `<a class="internal" href="#" data-note="${escapeXml(path)}">${escapeXml(alt || name(path))}</a>`;
    };
    md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
        const token = tokens[index];
        const href = token.attrGet("href") ?? "";
        if (EXTERNAL.test(href)) {
            token.attrSet("target", "_blank");
            token.attrSet("rel", "noopener noreferrer");
            return self.renderToken(tokens, index, options);
        }
        if (href.startsWith("#")) return self.renderToken(tokens, index, options);
        const written = target(href);
        const path = written === undefined ? undefined : resolve(written);
        internal.set(token, path ?? null);
        return path ? `<a class="internal" href="#" data-note="${escapeXml(path)}">` : `<span class="unresolved">`;
    };
    md.renderer.rules.link_close = (tokens, index, options, _env, self) => {
        let open = index;
        while (open > 0 && tokens[open].type !== "link_open") open--;
        return internal.get(tokens[open]) === null ? "</span>" : self.renderToken(tokens, index, options);
    };
    const text = stripFrontMatter(markdown);
    return md.render(rewriteObsidian(options.keepMarks ? text : stripMarks(text)));
}
