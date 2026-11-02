/**
 * Read-only Tabularium runtime for the web notes page: the upstream core with an OPFS directory as its vault.
 * Settings live in memory only, so the passphrase never reaches browser storage.
 */
import { moveLocalDatabase } from "@tabularium/sync-core/compat/pouchdb/moveLocalDatabase";
import { FORMER_NAMES, SuffixDatabaseName } from "@tabularium/sync-core/compat/common/types";
import { createCore, type SyncCore } from "@/core/createCore";
import type { ServiceContext } from "@tabularium/sync-core/context";
import type { AbstractReplicator } from "@tabularium/sync-core/compat/replication/AbstractReplicator";
import type { SyncSettings } from "@tabularium/sync-core/compat/common/types";
import { useRemoteConfiguration } from "@tabularium/sync-core/compat/serviceFeatures/remoteConfig";
import { stripAllPrefixes } from "@tabularium/sync-core/compat/string_and_binary/path";
import { createWebStorageValueStore } from "@vrtmrz/value-store/web-storage";
import { decrypt as decryptHKDF } from "octagonal-wheels/encryption/hkdf";
import { createBrowserServiceHub } from "@clients/browser/createBrowserServiceHub";
import { initialiseServiceModulesFSAPI, type FSAPIServiceModules } from "@clients/webapp/serviceModules/FSAPIServiceModules";
import { basicAuth } from "./api";
import type { VaultRecord } from "./store";
import { createBinaryBlob, createTextBlob } from "@tabularium/sync-core/compat/common/utils";
import type { FilePathWithPrefix, UXFileInfo } from "@tabularium/sync-core/compat/common/types";
import { t } from "../../ui/i18n";

export interface NotesFile {
    path: string;
    size: number;
    mtime: number;
    rev: string;
    conflicted: boolean;
}
export interface NotesConnection {
    userId: string;
    vaultId: string;
    username: string;
    password: string;
    passphrase: string;
}

export class WrongPassphraseError extends Error {
    constructor() {
        super(t("notes.wrongPassphrase"));
    }
}
export class CredentialsRejectedError extends Error {}
/** The server could not be reached; a vault fetched before can still be opened offline. */
export class NetworkError extends Error {}

/** An encrypted metadata path and the vault's salt: not secret, enough to check a passphrase offline. */
export interface Verifier {
    path: string;
    salt: string;
}
export interface StartResult {
    offline: boolean;
    verifier?: Verifier;
    tweaks?: Record<string, unknown>;
}

async function verifyLocally(verifier: Verifier | undefined, passphrase: string) {
    if (!verifier) return;
    const salt = Uint8Array.from(atob(verifier.salt), (c) => c.charCodeAt(0));
    try {
        await decryptHKDF(verifier.path.slice(ENCRYPTED_META_PREFIX.length), passphrase, salt);
    } catch {
        throw new WrongPassphraseError();
    }
}

const ENCRYPTED_META_PREFIX = "/\\:";
const storagePrefix = (vaultId: string) => `tabularium-notes:${vaultId}:`;
const databaseName = (vaultId: string) => `tabularium-${vaultId}`;
const hidden = (path: string) => path.startsWith(".") || path.includes("/.");

/** The OPFS directory that holds one vault's working copy. */
async function vaultDirectory(userId: string, vaultId: string, create: boolean) {
    let directory = await navigator.storage.getDirectory();
    for (const name of ["tabularium", userId, vaultId]) directory = await directory.getDirectoryHandle(name, { create });
    return directory;
}

/** Removes the working copy, the local databases and device values of a vault. */
export async function clearLocalVault(userId: string, vaultId: string) {
    await vaultDirectory(userId, vaultId, true);
    const tabularium = await (await navigator.storage.getDirectory()).getDirectoryHandle("tabularium");
    await (await tabularium.getDirectoryHandle(userId)).removeEntry(vaultId, { recursive: true });
    for (const { name } of await indexedDB.databases()) {
        if (!name?.includes(databaseName(vaultId))) continue;
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error(`Cannot delete ${name}`));
            request.onblocked = () => reject(new Error(`${name} is still open`));
        });
    }
    // Device values, and PouchDB's own bookkeeping keys (`_pouch_<database>`).
    for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith(storagePrefix(vaultId)) || key.includes(databaseName(vaultId))) window.localStorage.removeItem(key);
    }
}

export class NotesRuntime {
    private core?: SyncCore<ServiceContext>;
    private modules?: FSAPIServiceModules;
    /** The local database's change feed, cancelled when the vault closes. */
    private changes?: { cancel(): void };
    private settings: SyncSettings;

    constructor(
        private readonly connection: NotesConnection,
        private readonly events: { changed(): void; restartRequested(): void }
    ) {
        this.settings = {
            couchDB_URI: `${location.origin}/sync`,
            couchDB_DBNAME: connection.vaultId,
            // The first fetch resets the local database under this suffix (the app ID, which is the system vault name);
            // setting it from the start keeps one database name on every opening.
            additionalSuffixOfDatabaseName: databaseName(connection.vaultId),
            couchDB_USER: connection.username,
            couchDB_PASSWORD: connection.password,
            passphrase: connection.passphrase,
            encrypt: true,
            E2EEAlgorithm: "v2",
            usePathObfuscation: true,
            isConfigured: true,
            liveSync: false,
            syncOnSave: false,
            syncOnStart: false,
            syncOnFileOpen: false,
            periodicReplication: false,
            syncInternalFiles: false,
            usePluginSync: false,
            autoSweepPlugins: false,
            autoSweepPluginsPeriodic: false,
            gcDelay: 0,
        } as SyncSettings;
    }

    private get auth() {
        return basicAuth(this.connection.username, this.connection.password);
    }

    /**
     * Opens the vault: verifies the passphrase, adopts the server's chunk parameters, fetches everything on first
     * use and then keeps a live replication running. Without a network, a vault fetched before opens from its local
     * copy: the passphrase is checked against the saved encrypted sample and the saved chunk parameters are used.
     */
    async start(saved: Pick<VaultRecord, "fetched" | "verifier" | "tweaks">): Promise<StartResult> {
        const { vaultId, userId } = this.connection;
        const root = await vaultDirectory(userId, vaultId, true);
        const hub = createBrowserServiceHub<ServiceContext>({
            deviceValues: createWebStorageValueStore(window.localStorage, { prefix: storagePrefix(vaultId) }),
            getSystemVaultName: () => databaseName(vaultId),
            settings: {
                load: () => Promise.resolve(this.settings),
                save: (settings) => {
                    this.settings = settings;
                    return Promise.resolve();
                },
            },
            restart: { schedule: () => this.events.restartRequested() },
        });
        this.core = createCore<ServiceContext>({
            hub,
            serviceModules: (core, serviceHub) => (this.modules = initialiseServiceModulesFSAPI(root, core, serviceHub)),
            features: (core) => {
                useRemoteConfiguration(core);
                // 1.0 renamed the local database; a browser that synchronised before moves its copy before it opens.
                core.services.appLifecycle.onSettingLoaded.addHandler(async () => {
                    const name = core.services.vault.getVaultName();
                    await moveLocalDatabase((database) => core.services.database.createPouchDBInstance(database), name + FORMER_NAMES.databaseSuffix, name + SuffixDatabaseName);
                    return true;
                }, -10);
            },
        });
        const { services, serviceModules } = this.core;
        if (!(await services.control.onLoad())) throw new Error(t("notes.coreFailed"));
        await services.control.onReady();
        let result: StartResult;
        try {
            const verifier = await this.verifyPassphrase();
            if (await this.remoteLocked()) throw new Error(t("notes.vaultLocked"));
            // A rebuild gives the vault a new salt; the copy fetched before belongs to the old database.
            const rebuilt = saved.fetched && verifier && saved.verifier && verifier.salt !== saved.verifier.salt;
            const preferred = await this.withReplicator((replicator, settings) => replicator.getRemotePreferredTweakValues(settings));
            const tweaks = preferred.status === "available" ? (preferred.values as Record<string, unknown>) : saved.tweaks;
            if (tweaks) await services.setting.applyPartial(tweaks, true);
            if (!saved.fetched || rebuilt) await serviceModules.rebuilder.$fetchLocal(false, true);
            result = { offline: false, verifier: verifier ?? saved.verifier, tweaks };
        } catch (error) {
            // Only a network failure on a vault fetched before falls back to the local copy.
            if (!(error instanceof NetworkError) || !saved.fetched) throw error;
            await verifyLocally(saved.verifier, this.connection.passphrase);
            if (saved.tweaks) await services.setting.applyPartial(saved.tweaks, true);
            result = { offline: true, verifier: saved.verifier, tweaks: saved.tweaks };
        }
        await services.setting.applyPartial({ liveSync: true }, true);
        await services.control.applySettings();
        // Offline there is no network round trip in between: wait until the local database can be read.
        for (const deadline = Date.now() + 30_000; !services.database.isDatabaseReady(); ) {
            if (Date.now() > deadline) throw new Error(t("notes.coreFailed"));
            await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        this.changes = services.database.localDatabase.localDatabase
            .changes({ since: "now", live: true })
            .on("change", () => this.events.changed());
        return result;
    }

    /** Restarts the live replication, for example when the network comes back. */
    async reconnect() {
        await this.core?.services.control.applySettings();
    }

    /** Runs a task on the replicator that is active now; the core replaces it whenever settings change. */
    private async withReplicator<T>(task: (replicator: AbstractReplicator, settings: SyncSettings) => Promise<T>) {
        const { services } = this.core;
        const result = await services.replicator.runWithActiveReplicatorContext((context) => task(context.replicator as AbstractReplicator, services.setting.currentSettings()));
        if (result === undefined) throw new NetworkError(t("notes.noConnection"));
        return result;
    }

    /** A rebuilt vault stays locked until its owner lifts the lock; fetching it before then fails. */
    private async remoteLocked() {
        let response: Response;
        try {
            response = await window.fetch(`/sync/${this.connection.vaultId}/_local/obsydian_livesync_milestone`, {
                headers: { authorization: this.auth },
            });
        } catch {
            throw new NetworkError(t("notes.offline"));
        }
        if (response.status === 404) return false;
        if (!response.ok) throw new Error(t("notes.readFailed", { status: response.status }));
        return ((await response.json()) as { locked?: boolean }).locked === true;
    }

    /**
     * Decrypts the path of one metadata document and returns it with the salt as a sample for offline checks.
     * An empty vault cannot be checked and is accepted.
     */
    private async verifyPassphrase(): Promise<Verifier | undefined> {
        const range = `startkey=${encodeURIComponent('"f:"')}&endkey=${encodeURIComponent('"f:\ufff0"')}`;
        let response: Response;
        try {
            response = await window.fetch(`/sync/${this.connection.vaultId}/_all_docs?include_docs=true&limit=1&${range}`, {
                headers: { authorization: this.auth },
            });
        } catch {
            throw new NetworkError(t("notes.offline"));
        }
        if (response.status === 401 || response.status === 403) throw new CredentialsRejectedError(t("notes.credentialsRejected"));
        if (response.status >= 500) throw new NetworkError(t("notes.readFailed", { status: response.status }));
        if (!response.ok) throw new Error(t("notes.readFailed", { status: response.status }));
        const { rows } = (await response.json()) as { rows: { doc: { path: string } }[] };
        const path = rows[0]?.doc.path;
        if (!path?.startsWith(ENCRYPTED_META_PREFIX)) return undefined;
        let salt: Uint8Array<ArrayBuffer>;
        try {
            salt = await this.withReplicator((replicator, settings) => replicator.getReplicationPBKDF2Salt(settings));
        } catch {
            throw new NetworkError(t("notes.offline"));
        }
        const verifier = { path, salt: btoa(String.fromCharCode(...salt)) };
        await verifyLocally(verifier, this.connection.passphrase);
        return verifier;
    }

    async files(): Promise<NotesFile[]> {
        const files: NotesFile[] = [];
        for await (const doc of this.core.services.database.localDatabase.findAllNormalDocs({ conflicts: true })) {
            if (doc._deleted || doc.deleted) continue;
            const path = stripAllPrefixes(doc.path);
            if (!hidden(path)) files.push({ path, size: doc.size, mtime: doc.mtime, rev: doc._rev ?? "", conflicted: (doc._conflicts?.length ?? 0) > 0 });
        }
        return files;
    }

    private get access() {
        return this.core.serviceModules.databaseFileAccess;
    }

    private async entry(path: string, rev?: string) {
        const entry = await this.access.fetch(path as FilePathWithPrefix, rev, true);
        if (!entry || entry.deleted) throw new Error(t("notes.fileMissing", { path }));
        return entry;
    }
    async read(path: string) {
        return (await this.entry(path)).body.text();
    }
    async readBinary(path: string) {
        return new Uint8Array(await (await this.entry(path)).body.arrayBuffer());
    }
    async readRevisionBinary(path: string, rev: string) {
        return new Uint8Array(await (await this.entry(path, rev)).body.arrayBuffer());
    }
    /** The text of a note and the revision it was read at, as the base for saving. */
    async open(path: string, rev?: string) {
        const entry = await this.entry(path, rev);
        const meta = await this.access.fetchEntryMeta(path as FilePathWithPrefix, rev, true);
        return { text: await entry.body.text(), rev: (meta && meta._rev) || "" , mtime: entry.stat.mtime };
    }
    async exists(path: string) {
        const meta = await this.access.fetchEntryMeta(path as FilePathWithPrefix, undefined, true);
        return !!meta && !meta.deleted && !meta._deleted;
    }

    private file(path: string, content: string | Uint8Array<ArrayBuffer>): UXFileInfo {
        const body = typeof content === "string" ? createTextBlob(content) : createBinaryBlob(content);
        const now = Date.now();
        return { name: path.slice(path.lastIndexOf("/") + 1), path: path as FilePathWithPrefix, stat: { size: body.size, ctime: now, mtime: now, type: "file" }, body };
    }

    /**
     * Saves on top of `baseRev`. When another device has changed the note since, the content is kept as a conflicting
     * revision next to theirs instead of replacing it. Without `baseRev` the file must be new.
     */
    async save(path: string, content: string | Uint8Array<ArrayBuffer>, baseRev?: string): Promise<{ rev: string; conflicted: boolean }> {
        const file = this.file(path, content);
        if (baseRev === undefined) {
            if (await this.exists(path)) throw new Error(t("notes.exists", { path }));
            if (!(await this.access.store(file, true))) throw new Error(t("notes.saveFailed"));
            const meta = await this.access.fetchEntryMeta(path as FilePathWithPrefix, undefined, true);
            return { rev: (meta && meta._rev) || "", conflicted: false };
        }
        const rev = await this.access.storeWithLiveBaseRevision(file, baseRev);
        if (rev) return { rev, conflicted: false };
        const conflict = await this.access.storeAsConflictedRevisionWithResult(file, baseRev);
        if (!conflict) throw new Error(t("notes.saveFailed"));
        return { rev: conflict, conflicted: true };
    }

    /** Deletes a file, or with `rev` only that revision leaf (used to settle conflicts). */
    async remove(path: string, rev?: string) {
        if (!(await this.access.delete(path as FilePathWithPrefix, rev))) throw new Error(t("notes.deleteFailed", { path }));
    }

    /** The current revision and the conflicting revisions of a file. */
    async revisions(path: string) {
        const meta = await this.access.fetchEntryMeta(path as FilePathWithPrefix, undefined, true);
        return { current: (meta && meta._rev) || "", conflicts: await this.access.getConflictedRevs(path as FilePathWithPrefix) };
    }

    /** Local database sequence now, and how far the replication has pushed it to the server. */
    async localSeq() {
        const info = await this.core.services.database.localDatabase.localDatabase.info();
        return Number(String(info.update_seq).split("-")[0]);
    }
    pushedSeq() {
        const statics = this.core?.services.replicator.replicationStatics.value;
        return statics ? Number(String(statics.lastSyncPushSeq).split("-")[0]) : 0;
    }
    connected() {
        const status = this.core?.services.replicator.replicationStatics.value.syncStatus;
        return status === "CONNECTED" || status === "COMPLETED" || status === "PAUSED";
    }

    async stop() {
        this.changes?.cancel();
        const core = this.core;
        this.core = undefined;
        if (!core) return;
        await this.modules?.storageEventManager.cleanup();
        await core.services.control.onUnload();
    }
}
