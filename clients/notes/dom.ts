// Element creation for the web pages (web notes and shared pages): they run in a browser, where Obsidian's createEl
// helpers do not exist. The factory is typed by the one method used.
const page: Pick<Document, "createElement"> = document;

export function element<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return page.createElement(tag);
}
