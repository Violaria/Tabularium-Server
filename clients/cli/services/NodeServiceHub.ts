import { CLI_DIRECTORY } from "@clients/cli/currentNames";
import type { AppLifecycleServiceDependencies } from "@tabularium/sync-core/compat/services/base/AppLifecycleService";
import type { ServiceContext } from "@tabularium/sync-core/context";
import type {
    ComponentHasResult,
    SvelteDialogManager,
} from "@tabularium/sync-core/compat/services/implements/base/SvelteDialog";
import { UIService } from "@tabularium/sync-core/compat/services/implements/base/UIService";
import { InjectableServiceHub } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableServiceHub";
import { InjectableAppLifecycleService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableAppLifecycleService";
import { InjectableConflictService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableConflictService";
import { InjectableDatabaseEventService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableDatabaseEventService";
import { InjectableFileProcessingService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableFileProcessingService";
import { InjectableSettingService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableSettingService";
import { PathServiceCompat } from "@tabularium/sync-core/compat/services/implements/injectable/InjectablePathService";
import { InjectableRemoteService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableRemoteService";
import { InjectableReplicationService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableReplicationService";
import { InjectableReplicatorService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableReplicatorService";
import { InjectableTestService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableTestService";
import { InjectableTweakValueService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableTweakValueService";
import { InjectableVaultServiceCompat } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableVaultService";
import { ControlService } from "@tabularium/sync-core/compat/services/base/ControlService";
import { HeadlessAPIService } from "@clients/cli/services/HeadlessAPIService";
import { NodeKeyValueDBService } from "./NodeKeyValueDBService";
import { createNodeLocalStorage } from "./NodeLocalStorage";
import { DatabaseService } from "@tabularium/sync-core/compat/services/base/DatabaseService";
import type { SyncSettings } from "@tabularium/sync-core/compat/common/types";
import { path as nodePath } from "@clients/cli/platform";
import type { KeyValueDBService } from "@tabularium/sync-core/compat/services/base/KeyValueDBService";
import { PouchDB } from "@clients/cli/lib/pouchdb-node";
import { NodeServiceContext } from "./NodeServiceContext";
import { setLang } from "@/core/common/translation";

export { NodeServiceContext } from "./NodeServiceContext";

class NodeAppLifecycleService<T extends ServiceContext> extends InjectableAppLifecycleService<T> {
    constructor(context: T, dependencies: AppLifecycleServiceDependencies) {
        super(context, dependencies);
    }
}

class NodeDialogManager<T extends ServiceContext> implements SvelteDialogManager {
    open<TValue, UInitial>(
        _component: ComponentHasResult<TValue, UInitial>,
        _initialData?: UInitial
    ): Promise<TValue | undefined> {
        return Promise.reject(new Error("Interactive dialogues are not available in the CLI."));
    }

    openWithExplicitCancel<TValue, UInitial>(
        _component: ComponentHasResult<TValue, UInitial>,
        _initialData?: UInitial
    ): Promise<TValue> {
        return Promise.reject(new Error("Interactive dialogues are not available in the CLI."));
    }
}

type NodeUIServiceDependencies<T extends ServiceContext = ServiceContext> = {
    APIService: HeadlessAPIService<T>;
};
class NodeDatabaseService<T extends NodeServiceContext> extends DatabaseService<T> {
    protected override modifyDatabaseOptions(
        settings: SyncSettings,
        name: string,
        options: PouchDB.Configuration.DatabaseConfiguration
    ): { name: string; options: PouchDB.Configuration.DatabaseConfiguration } {
        const optionPass = {
            ...options,
            prefix: this.context.databasePath + nodePath.sep,
        };
        const passSettings = { ...settings, useIndexedDBAdapter: false };
        return super.modifyDatabaseOptions(passSettings, name, optionPass);
    }
}
class NodeUIService<T extends ServiceContext> extends UIService<T> {
    override get dialogToCopy(): never {
        throw new Error("Method not implemented.");
    }

    constructor(context: T, dependencies: NodeUIServiceDependencies<T>) {
        const dialogManager = new NodeDialogManager<T>();

        super(context, {
            dialogManager,
            APIService: dependencies.APIService,
        });
    }
}

export class NodeServiceHub<T extends NodeServiceContext> extends InjectableServiceHub<T> {
    constructor(basePath: string, context: T) {
        const runtimeDir = nodePath.join(basePath, CLI_DIRECTORY, "runtime");
        const localStoragePath = nodePath.join(runtimeDir, "local-storage.json");
        const keyValueDBPath = nodePath.join(runtimeDir, "keyvalue-db.json");

        const API = new HeadlessAPIService<T>(context);
        const conflict = new InjectableConflictService(context);
        const fileProcessing = new InjectableFileProcessingService(context);

        const setting = new InjectableSettingService<T>(context, {
            APIService: API,
            onDisplayLanguageChanged: setLang,
            deviceValues: createNodeLocalStorage(localStoragePath),
        });

        const appLifecycle = new NodeAppLifecycleService<T>(context, {
            settingService: setting,
        });

        const remote = new InjectableRemoteService(context, {
            pouchDB: PouchDB,
            APIService: API,
            appLifecycle,
            setting,
        });

        const tweakValue = new InjectableTweakValueService(context);
        const vault = new InjectableVaultServiceCompat(context, {
            settingService: setting,
            APIService: API,
        });
        const test = new InjectableTestService(context);
        const databaseEvents = new InjectableDatabaseEventService(context);
        const path = new PathServiceCompat(context, {
            settingService: setting,
        });

        const database = new NodeDatabaseService<T>(context, {
            pouchDB: PouchDB,
            API: API,
            path,
            vault,
            setting,
        });

        const config = setting.config;

        const replicator = new InjectableReplicatorService(context, {
            settingService: setting,
            appLifecycleService: appLifecycle,
            databaseEventService: databaseEvents,
        });

        const replication = new InjectableReplicationService(context, {
            APIService: API,
            appLifecycleService: appLifecycle,
            replicatorService: replicator,
            settingService: setting,
            fileProcessingService: fileProcessing,
            databaseService: database,
        });

        const keyValueDB = new NodeKeyValueDBService(
            context,
            {
                appLifecycle,
                databaseEvents,
                vault,
            },
            keyValueDBPath
        );

        const control = new ControlService(context, {
            appLifecycleService: appLifecycle,
            settingService: setting,
            databaseService: database,
            fileProcessingService: fileProcessing,
            APIService: API,
            replicatorService: replicator,
        });

        const ui = new NodeUIService<T>(context, {
            APIService: API,
        });

        const serviceInstancesToInit = {
            appLifecycle,
            conflict,
            database,
            databaseEvents,
            fileProcessing,
            replication,
            replicator,
            remote,
            setting,
            tweakValue,
            vault,
            test,
            ui,
            path,
            API,
            config,
            keyValueDB: keyValueDB as unknown as KeyValueDBService<T>,
            control,
        };
        super(context, serviceInstancesToInit);
    }
}
