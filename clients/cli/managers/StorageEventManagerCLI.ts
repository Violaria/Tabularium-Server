import { StorageEventManagerBase, type StorageEventManagerBaseDependencies } from "@tabularium/sync-core/compat/managers/StorageEventManager";
import { CLIStorageEventManagerAdapter } from "./CLIStorageEventManagerAdapter";
import type { SyncCore } from "@/core/createCore";
import type { ServiceContext } from "@tabularium/sync-core/context";
import type { IgnoreRules } from "@clients/cli/serviceModules/IgnoreRules";
import { LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";

export class StorageEventManagerCLI extends StorageEventManagerBase<CLIStorageEventManagerAdapter> {
    core: SyncCore<ServiceContext>;

    constructor(
        basePath: string,
        core: SyncCore<ServiceContext>,
        dependencies: StorageEventManagerBaseDependencies,
        ignoreRules?: IgnoreRules,
        watchEnabled?: boolean
    ) {
        const adapter = new CLIStorageEventManagerAdapter(basePath, ignoreRules, watchEnabled, (message, detail) => {
            dependencies.APIService.addLog(message, LOG_LEVEL_NOTICE);
            if (detail !== undefined) {
                dependencies.APIService.addLog(detail, LOG_LEVEL_NOTICE);
            }
        });
        super(adapter, dependencies);
        this.core = core;
    }

    /**
     * Override _watchVaultRawEvents for CLI-specific logic
     * In CLI, we don't have internal files like Obsidian's .obsidian folder
     */
    protected override async _watchVaultRawEvents(path: string) {
        // No-op in CLI version
        // Internal file handling is not needed
    }

    /**
     * Close the file watcher. Call this during graceful shutdown.
     */
    close(): Promise<void> {
        return this.adapter.close();
    }
}
