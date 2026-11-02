import type { SyncSettings } from "@tabularium/sync-core/compat/common/types";
import { createNewVaultSettings } from "@tabularium/sync-core/settings";

export function createDefaultCliSettings(): SyncSettings {
    return {
        ...createNewVaultSettings(),
        useIndexedDBAdapter: false,
        isConfigured: false,
    };
}
