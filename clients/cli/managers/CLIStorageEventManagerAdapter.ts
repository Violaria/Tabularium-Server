import { FORMER_NAMES, SuffixDatabaseName } from "@tabularium/sync-core/compat/common/types";
import { SNAPSHOT_FILE } from "@clients/cli/currentNames";
import type { FilePath, UXFileInfoStub, UXInternalFileInfoStub } from "@tabularium/sync-core/compat/common/types";
import type { FileEventItem } from "@tabularium/sync-core/compat/common/types";
import type { IStorageEventManagerAdapter } from "@tabularium/sync-core/compat/managers/adapters";
import type {
    IStorageEventTypeGuardAdapter,
    IStorageEventPersistenceAdapter,
    IStorageEventWatchAdapter,
    IStorageEventStatusAdapter,
    IStorageEventConverterAdapter,
    IStorageEventWatchHandlers,
} from "@tabularium/sync-core/compat/managers/adapters";
import type { FileEventItemSentinel } from "@tabularium/sync-core/compat/managers/StorageEventManager";
import type { NodeFile, NodeFolder } from "@clients/cli/adapters/NodeTypes";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { IgnoreRules } from "@clients/cli/serviceModules/IgnoreRules";
import { fsPromises as fs, getNodeFileCreationTime, path, type Stats } from "@clients/cli/platform";
import type { CliDiagnosticReporter } from "@clients/cli/cliOutput";

/**
 * CLI-specific type guard adapter
 */
class CLITypeGuardAdapter implements IStorageEventTypeGuardAdapter<NodeFile, NodeFolder> {
    isFile(file: unknown): file is NodeFile {
        return !!(
            file &&
            typeof file === "object" &&
            "path" in file &&
            "stat" in file &&
            !(file as { isFolder?: boolean }).isFolder
        );
    }

    isFolder(item: unknown): item is NodeFolder {
        return !!(
            item &&
            typeof item === "object" &&
            "path" in item &&
            (item as { isFolder?: boolean }).isFolder === true
        );
    }
}

/**
 * CLI-specific persistence adapter (file-based snapshot)
 */
class CLIPersistenceAdapter implements IStorageEventPersistenceAdapter {
    private snapshotPath: string;

    constructor(
        basePath: string,
        private reportDiagnostic: CliDiagnosticReporter = () => undefined
    ) {
        this.snapshotPath = path.join(basePath, SNAPSHOT_FILE);
    }

    async saveSnapshot(snapshot: (FileEventItem | FileEventItemSentinel)[]): Promise<void> {
        try {
            await fs.writeFile(this.snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
        } catch (error) {
            this.reportDiagnostic("Failed to save snapshot:", error);
        }
    }

    async loadSnapshot(): Promise<(FileEventItem | FileEventItemSentinel)[] | null> {
        try {
            const content = await fs.readFile(this.snapshotPath, "utf-8");
            return JSON.parse(content) as (FileEventItem | FileEventItemSentinel)[];
        } catch {
            return null;
        }
    }
}

/**
 * CLI-specific status adapter (no-op — daemon uses journald for status)
 */
class CLIStatusAdapter implements IStorageEventStatusAdapter {
    updateStatus(_status: { batched: number; processing: number; totalQueued: number }): void {
        // intentional no-op
    }
}

/**
 * CLI-specific converter adapter
 */
class CLIConverterAdapter implements IStorageEventConverterAdapter<NodeFile> {
    toFileInfo(file: NodeFile, deleted?: boolean): UXFileInfoStub {
        return {
            name: path.basename(file.path),
            path: file.path,
            stat: file.stat,
            deleted: deleted,
            isFolder: false,
        };
    }

    toInternalFileInfo(p: FilePath): UXInternalFileInfoStub {
        return {
            name: path.basename(p),
            path: p,
            isInternal: true,
            stat: undefined,
        };
    }
}

/**
 * CLI-specific watch adapter using chokidar for real-time filesystem monitoring.
 */
class CLIWatchAdapter implements IStorageEventWatchAdapter {
    private _watcher: FSWatcher | undefined;

    constructor(
        private basePath: string,
        private ignoreRules?: IgnoreRules,
        private watchEnabled: boolean = false,
        private reportDiagnostic: CliDiagnosticReporter = () => undefined
    ) {}

    private _toNodeFile(filePath: string, stats: Stats | undefined): NodeFile {
        return {
            path: path.relative(this.basePath, filePath).replace(/\\/g, "/") as FilePath,
            stat: {
                // Floor to integer milliseconds; Linux fs.Stats.*Ms carry sub-millisecond
                // precision, and timestamps are stored as integer ms everywhere else.
                ctime: stats ? getNodeFileCreationTime(stats) : Date.now(),
                mtime: Math.floor(stats?.mtimeMs ?? Date.now()),
                size: stats?.size ?? 0,
                type: "file",
            },
        };
    }

    private _toNodeFolder(dirPath: string): NodeFolder {
        return {
            path: path.relative(this.basePath, dirPath).replace(/\\/g, "/") as FilePath,
            isFolder: true,
        };
    }

    async beginWatch(handlers: IStorageEventWatchHandlers): Promise<void> {
        if (!this.watchEnabled) return;
        const baseIgnored: Array<RegExp | string | ((p: string) => boolean)> = [
            /(^|[/\\])\./,
            new RegExp(`(^|[/\\\\])[^/\\\\]*(${SuffixDatabaseName}|${FORMER_NAMES.databaseSuffix})([/\\\\]|$)`),
        ];
        // Bind rules to a local const before the closure — chokidar v4 requires a
        // MatchFunction, not glob strings, for custom patterns.
        const rules = this.ignoreRules;
        const ignored = rules
            ? [...baseIgnored, (p: string) => rules.shouldIgnore(path.relative(this.basePath, p))]
            : baseIgnored;

        const watcher = chokidarWatch(this.basePath, {
            ignored,
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100,
            },
        });

        watcher.on("add", (filePath, stats) => {
            const nodeFile = this._toNodeFile(filePath, stats);
            handlers.onCreate(nodeFile);
        });

        watcher.on("change", (filePath, stats) => {
            const nodeFile = this._toNodeFile(filePath, stats);
            handlers.onChange(nodeFile);
        });

        watcher.on("unlink", (filePath) => {
            const nodeFile = this._toNodeFile(filePath, undefined);
            handlers.onDelete(nodeFile);
        });

        watcher.on("addDir", (dirPath) => {
            const nodeFolder = this._toNodeFolder(dirPath);
            handlers.onCreate(nodeFolder);
        });

        watcher.on("unlinkDir", (dirPath) => {
            const nodeFolder = this._toNodeFolder(dirPath);
            handlers.onDelete(nodeFolder);
        });

        watcher.on("error", (err) => {
            this.reportDiagnostic("[CLIWatchAdapter] Fatal watcher error — file watching stopped:", err);
            this.reportDiagnostic("[CLIWatchAdapter] Exiting for systemd restart.");
            void watcher.close();
            this._watcher = undefined;
            // Use exit(1) rather than SIGTERM so systemd Restart=on-failure engages.
            process.exit(1);
        });

        await new Promise<void>((resolve) => watcher.once("ready", resolve));
        this._watcher = watcher;
    }

    close(): Promise<void> {
        if (this._watcher) {
            return this._watcher.close();
        }
        return Promise.resolve();
    }
}

/**
 * Composite adapter for CLI StorageEventManager
 */
export class CLIStorageEventManagerAdapter implements IStorageEventManagerAdapter<NodeFile, NodeFolder> {
    readonly typeGuard: CLITypeGuardAdapter;
    readonly persistence: CLIPersistenceAdapter;
    readonly watch: CLIWatchAdapter;
    readonly status: CLIStatusAdapter;
    readonly converter: CLIConverterAdapter;

    constructor(
        basePath: string,
        ignoreRules?: IgnoreRules,
        watchEnabled: boolean = false,
        reportDiagnostic: CliDiagnosticReporter = () => undefined
    ) {
        this.typeGuard = new CLITypeGuardAdapter();
        this.persistence = new CLIPersistenceAdapter(basePath, reportDiagnostic);
        this.watch = new CLIWatchAdapter(basePath, ignoreRules, watchEnabled, reportDiagnostic);
        this.status = new CLIStatusAdapter();
        this.converter = new CLIConverterAdapter();
    }

    close(): Promise<void> {
        return this.watch.close();
    }
}
