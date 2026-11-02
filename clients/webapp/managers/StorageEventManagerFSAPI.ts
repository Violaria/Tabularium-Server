import { StorageEventManagerBase, type StorageEventManagerBaseDependencies } from "@tabularium/sync-core/compat/managers/StorageEventManager";
import { FSAPIStorageEventManagerAdapter } from "./FSAPIStorageEventManagerAdapter";
import type { SyncCore } from "@/core/createCore";
import type { ServiceContext } from "@tabularium/sync-core/context";

export class StorageEventManagerFSAPI extends StorageEventManagerBase<FSAPIStorageEventManagerAdapter> {
    core: SyncCore<ServiceContext>;
    private fsapiAdapter: FSAPIStorageEventManagerAdapter;

    constructor(
        rootHandle: FileSystemDirectoryHandle,
        core: SyncCore<ServiceContext>,
        dependencies: StorageEventManagerBaseDependencies
    ) {
        const adapter = new FSAPIStorageEventManagerAdapter(rootHandle, (message, level, key) =>
            dependencies.APIService.addLog(message, level, key)
        );
        super(adapter, dependencies);
        this.fsapiAdapter = adapter;
        this.core = core;
    }

    /**
     * Override _watchVaultRawEvents for webapp-specific logic
     * In webapp, we don't have internal files like Obsidian's .obsidian folder
     */
    protected override async _watchVaultRawEvents(path: string) {
        // No-op in webapp version
        // Internal file handling is not needed
    }

    async cleanup() {
        // Stop file watching
        if (this.fsapiAdapter?.watch) {
            await this.fsapiAdapter.watch.stopWatch?.();
        }
    }
}
