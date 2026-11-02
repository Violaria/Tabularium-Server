// Mermaid diagrams in notes and Tabularius answers, drawn like Obsidian draws them. Mermaid is large, so it is loaded
// only when a page has a diagram. A diagram that does not parse keeps its source, with Mermaid's message under it.
import { renderMath } from "./math";
import { element } from "./dom";

let counter = 0;
let loading: Promise<typeof import("mermaid").default> | undefined;

function mermaid() {
    loading ??= import("mermaid").then(({ default: library }) => library);
    return loading;
}

/** Draws the diagrams and formulas under `root` that are not drawn yet. */
export async function renderDiagrams(root: ParentNode) {
    await renderMath(root);
    const blocks = [...root.querySelectorAll<HTMLElement>(".mermaid-diagram:not([data-drawn])")];
    if (!blocks.length) return;
    const library = await mermaid();
    const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.side !== "light";
    // Errors show under the source, not as Mermaid's own error graphic at the end of the page.
    library.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", fontFamily: "inherit", suppressErrorRendering: true });
    for (const block of blocks) {
        block.dataset.drawn = "";
        try {
            const { svg } = await library.render(`mermaid-${++counter}`, block.dataset.source ?? "");
            // Mermaid's own output, sanitised by it (securityLevel strict); parsed apart from the page, then moved in.
            block.replaceChildren(...new DOMParser().parseFromString(`<body>${svg}</body>`, "text/html").body.childNodes);
            block.classList.add("drawn");
        } catch (error) {
            document.getElementById(`dmermaid-${counter}`)?.remove();
            const note = element("figcaption");
            note.className = "mermaid-error";
            note.textContent = error instanceof Error ? error.message : String(error);
            block.append(note);
        }
    }
}
