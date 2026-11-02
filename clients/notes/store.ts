import type { Verifier } from "./runtime";
// Per-browser state for each account and vault, kept in IndexedDB. Never holds the passphrase.

export interface VaultRecord {
    key: string;
    deviceId: string;
    username: string;
    password: string;
    expiresAt: number;
    /** The vault has been fetched completely at least once. */
    fetched: boolean;
    /** Shown in the vault list when the server cannot be reached. */
    vaultName: string;
    /** Encrypted sample for checking the passphrase offline; contains no secret. */
    verifier?: Verifier;
    /** The server's chunk parameters, used when opening offline. */
    tweaks?: Record<string, unknown>;
}

const DB = "tabularium-notes";
const STORE = "vaults";
export const recordKey = (userId: string, vaultId: string) => `${userId}:${vaultId}`;

function open() {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
    });
}
async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
    const db = await open();
    try {
        return await new Promise<T>((resolve, reject) => {
            const request = action(db.transaction(STORE, mode).objectStore(STORE));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        });
    } finally {
        db.close();
    }
}

/** Every saved vault of an account, for opening without a network. */
export async function recordsOf(userId: string) {
    const all = await run<VaultRecord[]>("readonly", (store) => store.getAll() as IDBRequest<VaultRecord[]>);
    return all.filter((record) => record.key.startsWith(`${userId}:`));
}
export const readRecord = (key: string) => run<VaultRecord | undefined>("readonly", (store) => store.get(key) as IDBRequest<VaultRecord | undefined>);
export const writeRecord = (record: VaultRecord) => run("readwrite", (store) => store.put(record));
export const deleteRecord = (key: string) => run("readwrite", (store) => store.delete(key));
