<script lang="ts">
    import { mount, onDestroy, tick, unmount } from "svelte";
    import { basicAuth, issueDevice, listVaults, renewDevice, restoreSession, revokeDevice, ApiError, type User, type Vault } from "./api";
    import { deleteRecord, readRecord, recordKey, recordsOf, writeRecord, type VaultRecord } from "./store";
    import { CredentialsRejectedError, NetworkError, NotesRuntime, WrongPassphraseError, clearLocalVault, type NotesFile } from "./runtime";
    import { renderPreview } from "./preview";
    import { copyCode } from "./markdown";
    import { renderDiagrams } from "./diagrams";
    import { escapeXml } from "@/features/tabularium/epub";
    import { sendToKindle, type KindleItem } from "./kindle";
    import { folderOf, freePath, nameOf, normalisePath } from "./paths";
    import { resolveLinkpath } from "@/features/tabularium/linkpath";
    import { repairLinks } from "../../src/tabularius/links";
    import Tree from "./Tree.svelte";
    import { isSpecSource, parseSpecs, sortedTree, type SortRules } from "./sorting";
    import Editor from "./Editor.svelte";
    import Conflict, { type Version } from "./Conflict.svelte";
    import { formatDate, language, serverError, setLanguage, t, titles, type Language } from "../../ui/i18n";
    import { askText, confirmAction, icon, markShapes, popMenu, message as toast } from "../../ui/core";
    import { INSERT_ACTIONS } from "@/features/tabularium/editorActions";
    import ShareDialog from "@/features/tabularium/share/ShareDialog.svelte";
    import { Sharing } from "@/features/tabularium/share/sharing";
    import type { ShareSource, ShareTreeNode } from "@/features/tabularium/share/package";
    import { sessionShareApi } from "./share";
    import { forgetUnlocked, keepUnlocked, unlockedVault } from "./unlocked";

    type Phase = "loading" | "vaults" | "unlock" | "opening" | "open";
    type Mode = "view" | "edit" | "conflict";
    type SaveState = "unsaved" | "saved" | "pending" | "synced" | "conflict";
    let phase = $state<Phase>("loading");
    let lang = $state<Language>(language());
    document.title = t("notes.title");
    /** Called by the shell when the language is chosen in its sidebar. */
    export function changeLanguage(next: Language) {
        setLanguage(next);
        lang = next;
        document.title = t("notes.title");
    }
    let user = $state<User>();
    let vaults = $state<Vault[]>([]);
    let vault = $state<Vault>();
    let offline = $state(false);
    let error = $state("");
    let notice = $state("");
    let status = $state("");
    let files = $state<NotesFile[]>([]);
    let current = $state<string>();
    let html = $state("");
    let filter = $state("");
    let selecting = $state(false);
    let selected = $state<KindleItem[]>([]);
    let sending = $state(false);
    let passphrase = $state("");
    let previewEl = $state<HTMLElement>();
    /** The note pane: it scrolls, not the note inside it. */
    let mainEl = $state<HTMLElement>();
    let mode = $state<Mode>("view");
    let saveState = $state<SaveState>("synced");
    let editorText = $state("");
    let editor = $state<Editor>();
    let versions = $state<Version[]>([]);
    let attachmentInput = $state<HTMLInputElement>();
    let vaultMenu = $state(false);
    /** How notes are edited (source, live render, or source beside the preview) and read (rendered or source), per browser. */
    type EditView = "source" | "live" | "split";
    type ReadView = "rendered" | "source";
    const VIEW_KEY = "tabularium-notes:views";
    const storedViews = (() => { try { return JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as { edit?: EditView; read?: ReadView }; } catch { return {}; } })();
    let editView = $state<EditView>(storedViews.edit ?? "live");
    let readView = $state<ReadView>(storedViews.read ?? "rendered");
    function chooseView(next: { edit?: EditView; read?: ReadView }) {
        if (next.edit) editView = next.edit;
        if (next.read) readView = next.read;
        try { localStorage.setItem(VIEW_KEY, JSON.stringify({ edit: editView, read: readView })); } catch { /* storage unavailable: lasts for this page */ }
    }
    /** The welcome when no note is open: a greeting by the time of day, and the notes changed last. */
    const greeting = $derived.by(() => {
        const hour = new Date().getHours();
        return t(hour < 5 || hour >= 18 ? "home.evening" : hour < 12 ? "home.morning" : "home.afternoon", { name: user?.username ?? "" });
    });
    const recentNotes = $derived(files.filter((file) => isNote(file.path)).sort((a, b) => b.mtime - a.mtime).slice(0, 6));
    const ago = (time: number) => {
        const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
        return minutes < 1 ? t("time.now") : minutes < 60 ? t("time.minutes", { n: minutes }) : minutes < 1440 ? t("time.hours", { n: Math.floor(minutes / 60) })
            : minutes < 7 * 1440 ? t("time.days", { n: Math.floor(minutes / 1440) }) : formatDate(time);
    };
    /** The open note's text, for the source reading view. */
    let noteText = $state("");
    /** The split view's preview of the draft. */
    let splitHtml = $state("");
    let splitEl = $state<HTMLElement>();
    let splitTimer = 0;
    // Back from the source view, the rendered note's diagrams and images are drawn again.
    $effect(() => {
        if (readView === "rendered" && previewEl && html) void tick().then(() => previewEl && drawExtras(previewEl));
    });
    /** The file tree folded away, remembered in this browser. */
    const TREE_KEY = "tabularium-notes:tree-collapsed";
    let collapsed = $state((() => { try { return localStorage.getItem(TREE_KEY) === "1"; } catch { return false; } })());
    function toggleTree() {
        collapsed = !collapsed;
        try { localStorage.setItem(TREE_KEY, collapsed ? "1" : ""); } catch { /* storage unavailable: lasts for this page */ }
    }
    /** The replica's state for the symbol beside the vault name: in sync, working, or offline. */
    const syncKind = $derived(offline ? "off" : phase === "open" ? "ok" : "busy");
    // File tree order from the vault's Collation.md rules; rule texts are read again only when their revision changes.
    let sortRules = $state.raw<SortRules>([]);
    let sortError = $state("");
    const ruleTexts = new Map<string, { rev: string; text: string }>();
    let runtime: NotesRuntime | undefined;
    let record: VaultRecord | undefined;
    // Shares of the open vault; changes saved here update the shares they belong to after a quiet period.
    let sharing: Sharing | undefined;
    const SHARE_DELAY_MS = 10_000;
    let shareTimer: number | undefined;
    const shareChanges = new Set<string>();
    const shareRenames: (readonly [string, string])[] = [];
    let objectUrls: string[] = [];
    let refreshTimer: number | undefined;
    let saveTimer: number | undefined;
    let stateTimer: number | undefined;
    /** The open note as last saved or loaded: path, revision and text. */
    let base: { path: string; rev: string; text: string } | undefined;
    let draft = "";
    let savedSeq = 0;
    let saving: Promise<void> = Promise.resolve();

    /** Device credentials are renewed once less than half of their 30-day life is left. */
    const RENEW_BEFORE_MS = 15 * 86_400_000;
    const SAVE_DELAY_MS = 2000;
    const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
    const LAST_USER = "tabularium-notes:last-user";
    const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp", avif: "image/avif" };
    const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
    const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const isNote = (path: string) => /\.md$/i.test(path);

    function browserName() {
        const ua = navigator.userAgent;
        const name = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : t("notes.browser");
        return t("notes.deviceName", { browser: name, date: new Date().toISOString().slice(0, 10) });
    }

    function rememberUser(signedIn: User) {
        try {
            localStorage.setItem(LAST_USER, JSON.stringify({ id: signedIn.id, username: signedIn.username }));
        } catch {
            /* without storage there is no offline list */
        }
    }

    /** A link to a note: /notes/?vault=<id>&path=<path> from the home page and Tabularius, or the older /notes/#<vault>/<path>. */
    function linked() {
        const query = new URLSearchParams(location.search);
        if (query.get("vault")) return { vault: query.get("vault")!, path: query.get("path") ?? "" };
        const [id, ...rest] = location.hash.slice(1).split("/");
        if (!id) return undefined;
        try {
            return { vault: decodeURIComponent(id), path: rest.map(decodeURIComponent).join("/") };
        } catch {
            return undefined;
        }
    }
    let pending = linked();
    function followLink() {
        const target = pending && vaults.find((v) => v.id === pending!.vault);
        if (target) chooseVault(target);
    }
    window.addEventListener("hashchange", () => {
        pending = linked();
        if (phase === "open" && pending && pending.vault === vault?.id) void showLinked();
        else if (phase === "vaults" || phase === "unlock") followLink();
    });
    async function showLinked() {
        const path = pending?.path;
        pending = undefined;
        history.replaceState(null, "", location.pathname);
        if (path && files.some((f) => f.path === path)) await show(path);
    }

    async function start() {
        try {
            user = await restoreSession();
            if (!user) {
                // The shell signs in; without a session there is nothing to show here.
                location.assign("/");
                return;
            }
            else await showVaults();
        } catch (e) {
            if (e instanceof TypeError) await showOfflineVaults();
            else {
                error = message(e);
                phase = "vaults";
            }
        }
    }
    void start();

    /** Without a network: the vaults this browser has fetched before, for the account that used it last. */
    async function showOfflineVaults() {
        let last: User | undefined;
        try {
            last = JSON.parse(localStorage.getItem(LAST_USER) ?? "null") ?? undefined;
        } catch {
            last = undefined;
        }
        if (!last) {
            error = t("notes.offlineNoVaults");
            phase = "vaults";
            return;
        }
        user = { ...last, role: "user", mustChangePassword: false };
        offline = true;
        vaults = (await recordsOf(last.id)).filter((r) => r.fetched).map((r) => ({ id: r.key.slice(r.key.indexOf(":") + 1), name: r.vaultName, state: "ready" }));
        phase = "vaults";
        followLink();
    }

    async function showVaults() {
        if (user?.mustChangePassword) {
            location.assign("/");
            return;
        }
        rememberUser(user!);
        vaults = await listVaults();
        phase = "vaults";
        followLink();
        // Back in web notes after another module: the vault unlocked earlier in this page opens again, unless a link
        // asks for another one.
        const kept = unlockedVault(user!.id);
        const target = kept && vaults.find((v) => v.id === kept.vaultId);
        if (kept && target && (phase === "vaults" || vault?.id === target.id)) await reopen(target, kept.passphrase);
    }

    async function reopen(target: Vault, secret: string) {
        vault = target;
        error = "";
        // No unlock form while the kept passphrase opens the vault: a password field that appears and goes again leaves
        // password managers' menus behind on the page.
        phase = "loading";
        status = t("notes.connecting");
        try {
            await open(user!, target, secret, true);
        } catch (e) {
            forgetUnlocked();
            error = message(e);
            phase = "unlock";
        }
    }

    function chooseVault(chosen: Vault) {
        vault = chosen;
        passphrase = "";
        error = "";
        phase = "unlock";
    }

    async function unlock(event: SubmitEvent) {
        event.preventDefault();
        if (!user || !vault) return;
        error = "";
        phase = "opening";
        status = t("notes.connecting");
        try {
            await open(user, vault, passphrase, true);
        } catch (e) {
            error = message(e);
            phase = "unlock";
        }
    }

    async function open(owner: User, target: Vault, secret: string, retry: boolean) {
        const key = recordKey(owner.id, target.id);
        record = await readRecord(key);
        if (!record) {
            const device = await issueDevice(target.id, browserName());
            record = { key, deviceId: device.id, username: device.username, password: device.password, expiresAt: device.expiresAt, fetched: false, vaultName: target.name };
            await writeRecord(record);
        }
        runtime = new NotesRuntime(
            { userId: owner.id, vaultId: target.id, username: record.username, password: record.password, passphrase: secret },
            { changed: scheduleRefresh, restartRequested: () => void lock(t("notes.restart")) }
        );
        status = record.fetched ? t("notes.syncing") : t("notes.firstFetch");
        let started;
        try {
            started = await runtime.start(record);
        } catch (e) {
            await runtime.stop();
            runtime = undefined;
            if (!record.fetched) await clearLocalVault(owner.id, target.id);
            if (e instanceof CredentialsRejectedError && retry) {
                // The device expired or was revoked: issue a new one.
                await deleteRecord(key);
                return open(owner, target, secret, false);
            }
            throw e instanceof WrongPassphraseError || e instanceof NetworkError ? e : new Error(t("notes.openFailed", { error: message(e) }));
        }
        passphrase = "";
        keepUnlocked(owner.id, target.id, secret);
        sharing = new Sharing(sessionShareApi, target.id, secret, target.name, shareSource, record.deviceId);
        offline = started.offline;
        record = { ...record, fetched: true, vaultName: target.name, verifier: started.verifier, tweaks: started.tweaks };
        // Records written before renewal existed have no expiry and are renewed too.
        if (!offline && !(record.expiresAt > Date.now() + RENEW_BEFORE_MS)) record.expiresAt = await renewDevice(basicAuth(record.username, record.password));
        await writeRecord({ ...record });
        files = await runtime.files();
        status = offline ? t("notes.offlineStatus") : t("notes.synced");
        stateTimer = window.setInterval(() => void watchState(), 1000);
        phase = "open";
        if (pending?.vault === target.id) await showLinked();
    }

    /** Save state from the replication progress, and reconnection once the network is back. */
    async function watchState() {
        if (!runtime) return;
        const connected = runtime.connected();
        if (offline && connected) {
            offline = false;
            status = t("notes.synced");
        } else if (!offline && !connected && !navigator.onLine) {
            offline = true;
            status = t("notes.offlineStatus");
        }
        if (saveState === "saved" || saveState === "pending") saveState = runtime.pushedSeq() >= savedSeq ? "synced" : "pending";
    }
    function online() {
        if (runtime) void runtime.reconnect();
    }
    window.addEventListener("online", online);

    function scheduleRefresh() {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => void refresh(), 300);
    }
    async function refresh() {
        if (!runtime) return;
        files = await runtime.files();
        if (!offline) status = t("notes.syncedAt", { time: formatDate(Date.now()) });
        const file = current ? files.find((f) => f.path === current) : undefined;
        if (!current || !file) return;
        if (file.conflicted && mode !== "conflict") {
            await openConflict(current);
            return;
        }
        if (mode === "view") await show(current, false);
        // Another device changed the note being edited: take its text when nothing here is unsaved.
        if (mode === "edit" && base && file.rev !== base.rev && draft === base.text) {
            const loaded = await runtime.open(current);
            base = { path: current, rev: loaded.rev, text: loaded.text };
            draft = loaded.text;
            editor?.replace(loaded.text);
        }
    }

    function releaseImages() {
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
        objectUrls = [];
        imageUrls.clear();
    }

    async function leave() {
        await flush();
        mode = "view";
        base = undefined;
        versions = [];
    }

    async function show(path: string, scroll = true) {
        if (!runtime) return;
        if (path !== current) await leave();
        current = path;
        releaseImages();
        const file = files.find((f) => f.path === path);
        if (file?.conflicted) {
            await openConflict(path);
            return;
        }
        saveState = "synced";
        if (!isNote(path)) {
            html = "";
            return;
        }
        const paths = files.map((f) => f.path);
        noteText = await runtime.read(path);
        html = renderPreview(noteText, (target) => resolveLinkpath(target, path, paths), { sortingNotes: isSpecSource(path) });
        await tick();
        if (scroll) mainEl?.scrollTo(0, 0);
        if (previewEl) await drawExtras(previewEl);
    }
    /** Object URLs of vault images, kept while the note is open. */
    const imageUrls = new Map<string, string>();
    async function imageUrl(path: string) {
        let url = imageUrls.get(path);
        if (!url && runtime) {
            const data = await runtime.readBinary(path);
            url = URL.createObjectURL(new Blob([data as BlobPart], { type: MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] }));
            objectUrls.push(url);
            imageUrls.set(path, url);
        }
        return url;
    }
    /** Diagrams, formulas and vault images of rendered note text. */
    async function drawExtras(root: HTMLElement) {
        void renderDiagrams(root);
        for (const img of root.querySelectorAll<HTMLImageElement>("img[data-vault-src]")) img.src = (await imageUrl(img.dataset.vaultSrc!)) ?? "";
    }
    /** What the editor's live render needs: the vault's images, and the reading view's renderer for tables. */
    const liveOptions = {
        image: async (target: string) => {
            const path = current ? resolveLinkpath(target, current, files.map((f) => f.path)) : undefined;
            return path && /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(path) ? imageUrl(path) : undefined;
        },
        render: (markdown: string) => renderPreview(markdown, (target) => (current ? resolveLinkpath(target, current, files.map((f) => f.path)) : undefined)),
    };
    /** The split view's preview follows the draft a moment after typing stops. */
    function drawSplit() {
        window.clearTimeout(splitTimer);
        splitTimer = window.setTimeout(async () => {
            if (!current) return;
            splitHtml = liveOptions.render(draft);
            await tick();
            if (splitEl) await drawExtras(splitEl);
        }, 200);
    }

    function previewClick(event: MouseEvent) {
        if (copyCode(event, t("notes.codeCopied"))) return;
        const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[data-note]");
        if (!link) return;
        event.preventDefault();
        void show(link.dataset.note!);
    }

    // Editing

    async function edit() {
        if (!runtime || !current) return;
        const loaded = await runtime.open(current);
        base = { path: current, rev: loaded.rev, text: loaded.text };
        draft = editorText = loaded.text;
        saveState = "synced";
        mode = "edit";
        drawSplit();
    }

    function changed(text: string) {
        draft = text;
        if (editView === "split") drawSplit();
        saveState = "unsaved";
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void save(), SAVE_DELAY_MS);
    }

    /** Saves the draft once; saves are queued so that each one starts from the revision the previous one created. */
    function save() {
        window.clearTimeout(saveTimer);
        saving = saving.then(async () => {
            if (!runtime || !base || draft === base.text) return;
            const text = draft;
            try {
                const result = await runtime.save(base.path, text, base.rev);
                base = { ...base, rev: result.rev, text };
                touched([base.path]);
                savedSeq = await runtime.localSeq();
                saveState = result.conflicted ? "conflict" : "saved";
                if (result.conflicted) notice = t("notes.savedAsConflict");
            } catch (e) {
                saveState = "unsaved";
                error = t("notes.saveError", { error: message(e) });
            }
        });
        return saving;
    }
    /** Saves now if anything is unsaved; used before leaving a note or the page. */
    async function flush() {
        if (mode === "edit" && base && draft !== base.text) await save();
        await saving;
    }
    function pagehide() {
        void flush();
    }
    window.addEventListener("pagehide", pagehide);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void flush();
    });

    async function done() {
        const path = current;
        await leave();
        if (path) await show(path, false);
    }

    // Managing notes

    async function newNote() {
        if (!runtime) return;
        const typed = await askText({ title: t("notes.newNote"), label: t("notes.newNotePrompt"), value: current && folderOf(current) ? `${folderOf(current)}/` : "", action: t("notes.newNote") });
        if (typed === null) return;
        const path = normalisePath(typed, true);
        if (!path) {
            error = t("notes.invalidPath");
            return;
        }
        try {
            await runtime.save(path, "");
            touched([path]);
            files = await runtime.files();
            await show(path);
            await edit();
        } catch (e) {
            error = message(e);
        }
    }

    async function rename(item: KindleItem) {
        if (!runtime) return;
        const typed = await askText({ title: t("notes.rename"), label: t("notes.renamePrompt"), value: item.path, action: t("notes.renameAction") });
        if (typed === null || typed.trim() === item.path) return;
        const target = normalisePath(typed);
        if (!target) {
            error = t("notes.invalidPath");
            return;
        }
        await flush();
        const moves = item.folder
            ? files.filter((f) => f.path.startsWith(`${item.path}/`)).map((f) => [f.path, `${target}${f.path.slice(item.path.length)}`] as const)
            : [[item.path, target] as const];
        try {
            const before = new Set(files.map((f) => f.path));
            for (const [from, to] of moves) {
                const content = isNote(from) ? await runtime.read(from) : await runtime.readBinary(from);
                await runtime.save(to, content);
                await runtime.remove(from);
            }
            const relinked = await relink(new Map(moves), before);
            touched([...moves.flat(), ...relinked], [[item.path, target], ...moves]);
            notice = t("notes.renamed", { name: nameOf(target) });
            files = await runtime.files();
            if (current && moves.some(([from]) => from === current)) await show(moves.find(([from]) => from === current)![1]);
            else if (current && relinked.includes(current)) await show(current, false);
        } catch (e) {
            error = message(e);
            files = await runtime.files();
        }
    }

    /**
     * Links follow a rename, as in Obsidian: every note that links to a moved file, and the moved notes' own relative
     * links, are rewritten with the rules Tabularius uses for its proposals. Returns the notes it changed.
     */
    async function relink(moves: Map<string, string>, before: Set<string>) {
        const active = runtime!;
        const after = new Set([...before].filter((path) => !moves.has(path)).concat([...moves.values()]));
        const back = new Map([...moves].map(([from, to]) => [to, from]));
        // A note can only link to a moved file by its name (wikilinks) or its path (Markdown links, which contain the name).
        const names = [...moves.keys()].map((path) => nameOf(path).replace(/\.md$/i, ""));
        const changed: string[] = [];
        for (const path of after) {
            if (!isNote(path)) continue;
            // Saved on top of the revision it was read at: an edit from another device meanwhile becomes a conflict.
            const { text, rev } = await active.open(path);
            const from = back.get(path) ?? path;
            if (from === path && !names.some((name) => text.includes(name) || text.includes(name.replace(/[%() #]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)))) continue;
            const repaired = repairLinks(text, from, path, moves, before, after);
            if (repaired === text) continue;
            await active.save(path, repaired, rev);
            changed.push(path);
        }
        return changed;
    }

    async function remove(item: KindleItem) {
        if (!runtime) return;
        const targets = item.folder ? files.filter((f) => f.path.startsWith(`${item.path}/`)).map((f) => f.path) : [item.path];
        if (!(await confirmAction({ title: t("notes.delete"), body: item.folder ? t("notes.confirmDeleteFolder", { name: item.path, count: targets.length }) : t("notes.confirmDelete", { name: item.path }), action: t("notes.delete"), danger: true }))) return;
        try {
            for (const path of targets) await runtime.remove(path);
            touched(targets);
            if (current && targets.includes(current)) {
                mode = "view";
                base = undefined;
                current = undefined;
                html = "";
            }
            notice = t("notes.deleted", { name: nameOf(item.path) });
            files = await runtime.files();
        } catch (e) {
            error = message(e);
        }
    }

    async function attach(list: File[]) {
        if (!runtime || !current || !list.length) return;
        const folder = folderOf(current);
        const taken = new Set(files.map((f) => f.path));
        for (const file of list) {
            if (file.size > MAX_ATTACHMENT_BYTES) {
                error = t("notes.attachmentTooLarge", { name: file.name });
                continue;
            }
            const name = normalisePath(file.name);
            if (!name || name.includes("/")) {
                error = t("notes.invalidPath");
                continue;
            }
            const path = freePath(folder, name, (candidate) => taken.has(candidate));
            try {
                await runtime.save(path, new Uint8Array(await file.arrayBuffer()));
                touched([path]);
                taken.add(path);
                editor?.insert(`${IMAGE.test(path) ? "!" : ""}[[${nameOf(path)}]]`);
                notice = t("notes.attached", { name: nameOf(path) });
            } catch (e) {
                error = message(e);
            }
        }
        files = await runtime.files();
    }

    // Conflicts

    async function openConflict(path: string) {
        if (!runtime) return;
        current = path;
        const { current: rev, conflicts } = await runtime.revisions(path);
        const binary = !isNote(path);
        const load = async (r: string, isCurrent: boolean): Promise<Version> => {
            const opened = binary ? { text: "", mtime: 0 } : await runtime!.open(path, r);
            return { rev: r, text: opened.text, mtime: opened.mtime, current: isCurrent };
        };
        versions = [await load(rev, true), ...(await Promise.all(conflicts.map((r) => load(r, false))))];
        mode = "conflict";
        saveState = "conflict";
    }

    /** Settles a conflict: the chosen or merged content becomes the current revision, the other leaves are deleted. */
    async function settle(content: string | Uint8Array<ArrayBuffer> | undefined) {
        if (!runtime || !current) return;
        const path = current;
        try {
            const { current: rev, conflicts } = await runtime.revisions(path);
            if (content !== undefined) {
                const result = await runtime.save(path, content, rev);
                if (result.conflicted) throw new Error(t("notes.conflictChanged"));
            }
            for (const leaf of conflicts) await runtime.remove(path, leaf);
            savedSeq = await runtime.localSeq();
            notice = t("notes.conflictResolved");
            mode = "view";
            versions = [];
            files = await runtime.files();
            await show(path, false);
            saveState = "saved";
        } catch (e) {
            error = message(e);
            await openConflict(path);
        }
    }
    async function keep(version: Version) {
        if (!runtime || !current) return;
        if (version.current) await settle(undefined);
        else if (isNote(current)) await settle(version.text);
        else {
            const entry = await runtime.readRevisionBinary(current, version.rev);
            await settle(entry);
        }
    }

    // Session

    /** The shell is leaving web notes: stop replication and close the local database before the module goes. */
    export async function close() {
        await lock();
    }

    async function lock(reason = "") {
        await flush().catch(() => undefined);
        await updateShares().catch(() => undefined);
        sharing = undefined;
        const active = runtime;
        runtime = undefined;
        window.clearTimeout(refreshTimer);
        window.clearInterval(stateTimer);
        releaseImages();
        files = [];
        html = "";
        current = undefined;
        mode = "view";
        base = undefined;
        selecting = false;
        selected = [];
        await active?.stop();
        error = reason;
        phase = vault ? "unlock" : "vaults";
    }

    /** Locks this vault and returns to the vault list. */
    async function switchVault() {
        forgetUnlocked();
        await lock();
        vault = undefined;
        phase = "vaults";
    }

    async function clearLocal() {
        if (!user || !vault) return;
        if (!(await confirmAction({ title: t("notes.clear"), body: t("notes.confirmClear", { vault: vault.name }), action: t("notes.clear"), danger: true }))) return;
        forgetUnlocked();
        await lock();
        const key = recordKey(user.id, vault.id);
        const saved = await readRecord(key);
        if (saved) await revokeDevice(vault.id, saved.deviceId).catch((e) => {
            if (!(e instanceof ApiError && e.status === 404)) throw e;
        });
        await clearLocalVault(user.id, vault.id);
        await deleteRecord(key);
        notice = t("notes.cleared");
        phase = "vaults";
    }

    function toggle(item: KindleItem) {
        selected = selected.some((s) => s.path === item.path) ? selected.filter((s) => s.path !== item.path) : [...selected, item];
    }

    async function kindle(items: KindleItem[]) {
        if (!runtime || !record || !vault) return;
        sending = true;
        notice = "";
        error = "";
        const authorization = basicAuth(record.username, record.password);
        try {
            const sent = await sendToKindle(runtime, items, vault.name, authorization, (title) => (notice = t("notes.sending", { title: titles([title]) })));
            notice = t("notes.sent", { titles: titles(sent) });
            selecting = false;
            selected = [];
        } catch (e) {
            error = t("notes.sendFailed", { error: message(e) });
        } finally {
            sending = false;
        }
    }

    // Notices go to the shell's toasts; only the unlock form keeps its error next to the field.
    $effect(() => {
        if (!notice) return;
        toast(notice);
        notice = "";
    });
    $effect(() => {
        if (!error || phase === "unlock" || phase === "opening") return;
        toast(error, true);
        error = "";
    });

    // Sharing

    /** The vault's files as the share builder reads them, with folders in the order of the file tree. */
    async function shareSource(): Promise<ShareSource> {
        const active = runtime!;
        const all = await active.files();
        const ordered = sortedTree(all, vault?.name ?? "", sortRules);
        const find = (node: ShareTreeNode, path: string): ShareTreeNode | undefined =>
            node.path === path ? node : node.children.map((child) => find(child, path)).find(Boolean);
        return {
            files: all.map((f) => f.path),
            read: (path) => active.read(path),
            readBinary: (path) => active.readBinary(path),
            tree: (folder) => find(ordered, folder) ?? { name: folder, path: folder, folder: true, children: [] },
        };
    }
    function touched(paths: string[], renames: (readonly [string, string])[] = []) {
        for (const path of paths) shareChanges.add(path);
        shareRenames.push(...renames);
        window.clearTimeout(shareTimer);
        shareTimer = window.setTimeout(() => void updateShares().catch((e) => (error = t("share.updateFailed", { error: serverError(message(e)) }))), SHARE_DELAY_MS);
    }
    async function updateShares() {
        window.clearTimeout(shareTimer);
        if (!sharing || !shareChanges.size || offline) return;
        const paths = [...shareChanges];
        const renames = shareRenames.splice(0);
        shareChanges.clear();
        const { withdrawn } = await sharing.refresh({ paths, renames });
        for (const share of withdrawn) toast(t("share.withdrawnDeleted", { address: share.view.slug }));
    }
    async function share(item: KindleItem) {
        if (!sharing || !runtime) return;
        error = "";
        try {
            await flush();
            const active = sharing;
            const { base, shares } = await active.list();
            const existing = shares.find((s) => s.view.state === "active" && s.record?.target === item.path && s.record.folder === item.folder);
            const dialog = document.createElement("dialog");
            dialog.className = "dialog share-dialog";
            document.body.append(dialog);
            let component: ReturnType<typeof mount> | undefined;
            const close = () => {
                if (component) void unmount(component);
                dialog.close();
                dialog.remove();
            };
            dialog.addEventListener("cancel", (event) => {
                event.preventDefault();
                close();
            });
            component = mount(ShareDialog, {
                target: dialog,
                props: {
                    sharing: active,
                    source: await shareSource(),
                    target: item.path,
                    folder: item.folder,
                    name: item.folder ? nameOf(item.path) : nameOf(item.path).replace(/\.md$/i, ""),
                    base,
                    existing,
                    t: (key: string, params?: Record<string, string | number>) => t(key as Parameters<typeof t>[0], params),
                    serverError,
                    formatDate,
                    confirmRevoke: () => confirmAction({ title: t("share.revokeTitle"), body: t("share.revokeBody"), action: t("share.revoke"), danger: true }),
                    close,
                },
            });
            dialog.showModal();
        } catch (e) {
            error = serverError(message(e));
        }
    }

    const conflicted = $derived(new Set(files.filter((f) => f.conflicted).map((f) => f.path)));
    const tree = $derived.by(() => {
        const query = filter.trim().toLowerCase();
        return sortedTree(query ? files.filter((f) => f.path.toLowerCase().includes(query)) : files, vault?.name ?? "", sortRules);
    });
    /** Reads the sorting rules after the file list changes. */
    async function loadSorting(active: NotesRuntime, list: NotesFile[]) {
        const sources = [];
        for (const file of list.filter((f) => isSpecSource(f.path))) {
            let cached = ruleTexts.get(file.path);
            if (cached?.rev !== file.rev) {
                cached = { rev: file.rev, text: await active.read(file.path) };
                ruleTexts.set(file.path, cached);
            }
            sources.push({ path: file.path, text: cached.text });
        }
        if (active !== runtime) return;
        const parsed = parseSpecs(sources, list.map((f) => f.path));
        sortRules = parsed.rules;
        sortError = parsed.unconverted ? t("notes.sortConvert") : "";
    }
    $effect(() => {
        const list = files;
        if (runtime && list.length) void loadSorting(runtime, list).catch((e) => (sortError = t("notes.sortError", { error: message(e) })));
    });
    const sameTitle = $derived(Boolean(current) && /^<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1].trim() === escapeXml(nameOf(current ?? "").replace(/\.md$/i, "")));
    const stateLabel = $derived(
        ({ unsaved: t("notes.stateUnsaved"), saved: t("notes.stateSaved"), pending: t("notes.statePending"), synced: t("notes.stateSynced"), conflict: t("notes.stateConflict") }) as Record<SaveState, string>
    );

    onDestroy(() => {
        window.removeEventListener("online", online);
        window.removeEventListener("pagehide", pagehide);
        void lock();
    });
</script>

<svelte:window
    onclick={(event) => vaultMenu && (event.target as Element).closest?.("[data-owner]")?.getAttribute("data-owner") !== "vault" && (vaultMenu = false)}
    onkeydown={(event) => event.key === "Escape" && (vaultMenu = false)}
/>
<div class="notes">
{#key lang}
{#if phase === "loading"}
    <div class="page center-page"><p class="hint">{t("common.loading")}</p></div>
{:else if phase === "vaults"}
    <div class="page center-page">
        {#if offline}<p class="notice-panel">{t("notes.offlineVaults")}</p>{/if}
        <section class="card vault-list">
            {#each vaults as item (item.id)}
                <button class="vault" onclick={() => chooseVault(item)}>{@html icon("database")}<span>{item.name}</span>{@html icon("chevron")}</button>
            {:else}
                <p class="hint">{t("notes.noVaults")}</p>
            {/each}
        </section>
    </div>
{:else if phase === "unlock" || phase === "opening"}
    <div class="page center-page">
        <header class="page-head"><div><h1>{vault?.name ?? ""}</h1></div></header>
        <form class="card stack unlock" onsubmit={unlock}>
            <label><span>{t("notes.passphrase")}<!-- svelte-ignore a11y_no_noninteractive_tabindex --><span class="tip" tabindex="0" data-tip={t("notes.unlockHint")}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M8 7.2v4M8 4.9v.1" /></svg></span></span> <input name="passphrase" type="password" autocomplete="off" data-bwignore data-1p-ignore data-lpignore="true" bind:value={passphrase} required disabled={phase === "opening"} /></label>
            {#if error}<p class="error">{error}</p>{/if}
            {#if phase === "opening"}<p class="notice">{status}</p>{/if}
            <div class="actions">
                <button class="primary" type="submit" disabled={phase === "opening"}>{t("notes.unlock")}</button>
                <button type="button" class="link" onclick={() => (phase = "vaults")} disabled={phase === "opening"}>{t("notes.otherVault")}</button>
            </div>
        </form>
    </div>
{:else}
    <div class="layout" class:collapsed>
        <aside>
            <header>
                <div class="aside-head">
                    <strong class="vault-name" title={vault?.name}>{vault?.name}</strong>
                    <span class="sync-mark" data-kind={syncKind} role="status" aria-label={status} title={status}><span class="dot" class:busy={syncKind === "busy"} class:off={syncKind === "off"}></span></span>
                    <button class="icon-button small vault-more" data-owner="vault" aria-haspopup="menu" aria-label={t("notes.more")} title={t("notes.more")} aria-expanded={vaultMenu} onclick={() => (vaultMenu = !vaultMenu)}>{@html icon("more")}</button>
                    <button class="icon-button small tree-toggle" aria-label={t("notes.hideTree")} title={t("notes.hideTree")} onclick={toggleTree}>{@html icon("sidebar")}</button>
                </div>
                {#if sortError}<span class="sort-error">{sortError}</span>{/if}
                {#if vaultMenu}
                    <div class="menu" role="menu" data-owner="vault">
                        <button role="menuitem" onclick={() => ((vaultMenu = false), forgetUnlocked(), void lock())}>{t("notes.lock")}</button>
                        <button role="menuitem" onclick={() => ((vaultMenu = false), void switchVault())}>{t("notes.otherVault")}</button>
                        <button role="menuitem" class="danger" onclick={() => ((vaultMenu = false), void clearLocal())}>{t("notes.clear")}</button>
                        <p class="hint">{t("notes.plainCopyTitle")}</p>
                    </div>
                {/if}
                <div class="aside-tools">
                    <label class="search">{@html icon("search")}<input class="filter" placeholder={t("notes.filter")} aria-label={t("notes.filter")} bind:value={filter} /></label>
                    <button class="icon-button raised new-note" aria-label={t("notes.newNote")} title={t("notes.newNote")} onclick={newNote}>{@html icon("plus")}</button>
                </div>
            </header>
            {#if selecting}
                <div class="selection">
                    <button disabled={!selected.length || sending} onclick={() => kindle(selected)}>{t("notes.sendSelected", { count: selected.length })}</button>
                    <button class="link" onclick={() => ((selecting = false), (selected = []))}>{t("notes.cancel")}</button>
                </div>
            {/if}
            <nav>
                <Tree node={tree} {current} {selecting} {selected} {conflicted} open={(path) => show(path)} {toggle} send={(item) => kindle([item])} select={(item) => ((selecting = true), (selected = [item]))} {rename} {remove} {share} expandAll={filter.trim() !== ""} />
            </nav>
        </aside>
        <section class="main" class:split-editing={mode === "edit" && !!current && editView === "split"} bind:this={mainEl}>
            {#if collapsed && !current}<div class="note-bar empty-bar"><button class="icon-button small tree-toggle" aria-label={t("notes.showTree")} title={t("notes.showTree")} onclick={toggleTree}>{@html icon("sidebar")}</button></div>{/if}
            {#if !current && mode === "view"}
                <div class="welcome">
                    <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64">{@html markShapes()}</svg></span>
                    <h1>{greeting}</h1>
                    <p class="welcome-vault">{vault?.name} · {t("home.noteCount", { n: files.filter((file) => isNote(file.path)).length })}</p>
                    {#if recentNotes.length}
                        <section class="welcome-recent">
                            <h2>{t("home.recent")}</h2>
                            <ul>
                                {#each recentNotes as file (file.path)}
                                    <li><button onclick={() => show(file.path)} title={file.path}>{@html icon("file")}<span class="name">{nameOf(file.path).replace(/\.md$/i, "")}</span><span class="folder">{folderOf(file.path)}</span><span class="when">{ago(file.mtime)}</span></button></li>
                                {/each}
                            </ul>
                        </section>
                    {/if}
                    <button class="primary welcome-new" onclick={newNote}>{@html icon("plus")}{t("notes.newNote")}</button>
                </div>
            {/if}
            {#if current}
                <!-- The note's folder and its actions in a bar across the whole pane; the title stays in the reading column. -->
                <div class="note-bar">
                    {#if collapsed}<button class="icon-button small tree-toggle" aria-label={t("notes.showTree")} title={t("notes.showTree")} onclick={toggleTree}>{@html icon("sidebar")}</button>{/if}
                    <span class="crumbs" title={current}>{current.split("/").slice(0, -1).join(" / ")}</span>
                    {#if mode !== "view" || saveState !== "synced"}<span class="save-state" data-state={saveState}>{stateLabel[saveState]}</span>{/if}
                    <span class="bar-actions">
                        {#if mode === "view" && isNote(current)}
                            <span class="segmented" role="radiogroup" aria-label={t("notes.readView")}>
                                {#each [["rendered", "eye"], ["source", "code"]] as [value, glyph] (value)}
                                    <button class="icon-button small" role="radio" aria-checked={readView === value} aria-label={t(`notes.read.${value}` as "notes.read.rendered")} title={t(`notes.read.${value}` as "notes.read.rendered")} onclick={() => chooseView({ read: value as ReadView })}>{@html icon(glyph)}</button>
                                {/each}
                            </span>
                            <button class="icon-button" aria-label={t("notes.edit")} title={t("notes.edit")} onclick={edit}>{@html icon("pencil")}</button>
                        {:else if mode === "edit"}
                            <span class="segmented" role="radiogroup" aria-label={t("notes.editView")}>
                                {#each [["source", "code"], ["live", "live"], ["split", "columns"]] as [value, glyph] (value)}
                                    <button class="icon-button small" role="radio" aria-checked={editView === value} aria-label={t(`notes.edit.${value}` as "notes.edit.live")} title={t(`notes.edit.${value}` as "notes.edit.live")} onclick={() => { chooseView({ edit: value as EditView }); if (value === "split") drawSplit(); }}>{@html icon(glyph)}</button>
                                {/each}
                            </span>
                            <button class="icon-button" aria-haspopup="menu" aria-label={t("editor.insert")} title={t("editor.insert")} onclick={(event) => popMenu(event.currentTarget, [...INSERT_ACTIONS.map((item) => item === "-" ? ("-" as const) : { label: t(`editor.insert.${item.id}` as "editor.insert.table"), svg: item.icon, action: () => editor?.template(item.id) }), "-", { label: t("notes.attach"), icon: "paperclip", action: () => attachmentInput?.click() }])}>{@html icon("plus")}</button>
                            <span class="tip" tabindex="0" role="note" data-tip={t("notes.editHint")}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M8 7.2v4M8 4.9v.1" /></svg></span>
                            <input type="file" multiple hidden bind:this={attachmentInput} onchange={(event) => {
                                const input = event.currentTarget;
                                void attach([...(input.files ?? [])]).then(() => (input.value = ""));
                            }} />
                            <button class="icon-button" aria-label={t("common.save")} title={t("common.save")} onclick={() => void save()}>{@html icon("save")}</button>
                            <button class="primary" onclick={done}>{t("notes.done")}</button>
                        {/if}
                    </span>
                </div>
                <div class="note-head">
                    <!-- A note that opens with its own title as a heading does not show the title twice. -->
                    <h1 class="title" class:echo={mode === "view" && sameTitle}>{nameOf(current).replace(/\.md$/i, "")}</h1>
                </div>
            {/if}
            {#if mode === "edit" && current}
                <div class="edit-area" class:split={editView === "split"}>
                    <Editor bind:this={editor} text={editorText} mode={editView === "live" ? "live" : "source"} live={liveOptions} {changed} save={() => void save()} dropped={(list) => void attach(list)}
                        scrolled={(ratio) => { if (splitEl) splitEl.scrollTop = ratio * (splitEl.scrollHeight - splitEl.clientHeight); }} />
                    {#if editView === "split"}
                        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -- copy buttons in the preview -->
                        <article class="md-body split-preview" bind:this={splitEl} onclick={(event) => copyCode(event, t("notes.codeCopied"))}>{@html splitHtml}</article>
                    {/if}
                </div>
            {:else if mode === "view" && current && isNote(current) && readView === "source"}
                {#key noteText}<Editor text={noteText} mode="source" live={liveOptions} readonly />{/key}
            {:else if mode === "conflict" && current}
                <Conflict {versions} binary={!isNote(current)} {keep} merge={(text) => void settle(text)} />
            {:else}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -- clicks on note links inside the preview are delegated here -->
                <article class="md-body" bind:this={previewEl} onclick={previewClick}>
                    {#if current}
                        {#if html}{@html html}{:else}<p class="hint">{t("notes.notNote")}</p>{/if}
                    {/if}
                </article>
            {/if}
        </section>
    </div>
{/if}
{/key}
</div>
