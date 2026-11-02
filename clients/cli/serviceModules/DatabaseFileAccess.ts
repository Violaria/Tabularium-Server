import {
    ServiceDatabaseFileAccessBase,
    type ServiceDatabaseFileAccessDependencies,
} from "@tabularium/sync-core/compat/serviceModules/ServiceDatabaseFileAccessBase";
import type { DatabaseFileAccess } from "@tabularium/sync-core/compat/interfaces/DatabaseFileAccess";

/**
 * CLI-specific implementation of ServiceDatabaseFileAccess
 * Same as Obsidian version, no platform-specific changes needed
 */
export class ServiceDatabaseFileAccessCLI extends ServiceDatabaseFileAccessBase implements DatabaseFileAccess {
    constructor(services: ServiceDatabaseFileAccessDependencies) {
        super(services);
    }
}
