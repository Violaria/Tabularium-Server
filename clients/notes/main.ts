// Web notes as a module of the Tabularium web application: the shell loads this file when the notes module opens.
import { mount as mountComponent, unmount as unmountComponent } from "svelte";
import App from "./App.svelte";
import type { Language } from "../../ui/i18n";
import "./notes.css";
import { deleteRecord, recordsOf } from "./store";
import { clearLocalVault } from "./runtime";
import { ApiError, revokeDevice } from "./api";
import { forgetUnlocked } from "./unlocked";

export { forgetUnlocked };

type Notes = { changeLanguage(next: Language): void; close(): Promise<void> };
let app: Notes | undefined;

/** Draws web notes into `target` (the shell's content area). */
export function mount(target: HTMLElement) {
    app = mountComponent(App, { target }) as unknown as Notes;
}
/** The shell changed the language in its sidebar. */
export function changeLanguage(next: Language) {
    app?.changeLanguage(next);
}
/**
 * Removes every vault this browser keeps for an account (the plain-text copy, the local database and the device
 * credentials) and revokes those devices on the server. Called when signing out, while the session still exists.
 */
export async function clearAccount(userId: string) {
    forgetUnlocked();
    await unmount();
    for (const record of await recordsOf(userId)) {
        const vaultId = record.key.slice(userId.length + 1);
        await revokeDevice(vaultId, record.deviceId).catch((error: unknown) => {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
        });
        await clearLocalVault(userId, vaultId);
        await deleteRecord(record.key);
    }
    window.localStorage.removeItem("tabularium-notes:last-user");
}
/** Leaving the module: the component stops replication and closes the local database before it goes. */
export async function unmount() {
    if (!app) return;
    const leaving = app;
    app = undefined;
    await leaving.close();
    await unmountComponent(leaving as never);
}
