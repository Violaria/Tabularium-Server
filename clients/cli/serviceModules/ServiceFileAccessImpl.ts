import { ServiceFileAccessBase, type StorageAccessBaseDependencies } from "@tabularium/sync-core/compat/serviceModules/ServiceFileAccessBase";
import { NodeFileSystemAdapter } from "@clients/cli/adapters/NodeFileSystemAdapter";

/**
 * CLI-specific implementation of ServiceFileAccess
 * Uses NodeFileSystemAdapter for platform-specific operations
 */
export class ServiceFileAccessCLI extends ServiceFileAccessBase<NodeFileSystemAdapter> {
    constructor(services: StorageAccessBaseDependencies<NodeFileSystemAdapter>) {
        super(services);
    }
}
