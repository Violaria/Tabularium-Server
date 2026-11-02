// Send to Kindle from the web notes page: same book as the plug-in, sent with this browser's device credentials.
import { MAX_BOOK_BYTES, assembleBook, notesIn, noteTitle } from "@/features/tabularium/kindleBook";
import { language, serverError, t } from "../../ui/i18n";
import { resolveLinkpath } from "@/features/tabularium/linkpath";
import type { NotesRuntime } from "./runtime";

export interface KindleItem {
    path: string;
    folder: boolean;
}

/** Sends one book per item, in order; stops at the first failure. Returns the titles sent. */
export async function sendToKindle(runtime: NotesRuntime, items: KindleItem[], vaultName: string, authorization: string, progress: (title: string) => void) {
    const files = (await runtime.files()).map((file) => file.path);
    const source = {
        read: (path: string) => runtime.read(path),
        readBinary: (path: string) => runtime.readBinary(path),
        resolve: (target: string, from: string) => resolveLinkpath(target, from, files),
    };
    const sent: string[] = [];
    for (const item of items) {
        const title = item.folder ? item.path.slice(item.path.lastIndexOf("/") + 1) || vaultName : noteTitle(item.path);
        const notes = item.folder ? notesIn(item.path, files) : [item.path];
        if (!notes.length) throw new Error(t("notes.emptyFolder", { title }));
        progress(title);
        const texts = { language: language(), contents: t("notes.contents"), missingImage: (name: string) => t("notes.missingImage", { name }) };
        const book = await assembleBook(source, notes, title, texts, item.folder ? item.path : undefined);
        if (book.length > MAX_BOOK_BYTES) throw new Error(`${title}: ${serverError("Request body too large")}`);
        const response = await window.fetch("/api/v1/kindle/send", {
            method: "POST",
            headers: { authorization, "content-type": "application/epub+zip", "x-tabularium-filename": encodeURIComponent(`${title}.epub`) },
            body: book.buffer as ArrayBuffer,
        });
        if (!response.ok) {
            const reason = ((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`;
            throw new Error(`${title}: ${serverError(reason)}`);
        }
        sent.push(title);
    }
    return sent;
}
