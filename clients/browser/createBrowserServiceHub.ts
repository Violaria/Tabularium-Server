import type { SyncSettings } from "@tabularium/sync-core/compat/common/types";
import type { KeyValueDatabaseFactory } from "@tabularium/sync-core/compat/interfaces/KeyValueDatabase";
import { PouchDB } from "@tabularium/sync-core/compat/pouchdb/pouchdb-browser";
import { ControlService } from "@tabularium/sync-core/compat/services/base/ControlService";
import { DatabaseService } from "@tabularium/sync-core/compat/services/base/DatabaseService";
import { KeyValueDBService } from "@tabularium/sync-core/compat/services/base/KeyValueDBService";
import type { ValueDeleter, ValueStore } from "@vrtmrz/value-store";
import { ServiceContext } from "@tabularium/sync-core/context";
import { InjectableAppLifecycleService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableAppLifecycleService";
import { InjectableConflictService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableConflictService";
import { InjectableDatabaseEventService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableDatabaseEventService";
import { InjectableFileProcessingService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableFileProcessingService";
import { PathServiceCompat } from "@tabularium/sync-core/compat/services/implements/injectable/InjectablePathService";
import { InjectableRemoteService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableRemoteService";
import { InjectableReplicationService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableReplicationService";
import { InjectableReplicatorService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableReplicatorService";
import { InjectableServiceHub } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableServiceHub";
import { InjectableSettingService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableSettingService";
import { InjectableTestService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableTestService";
import { InjectableTweakValueService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableTweakValueService";
import { InjectableVaultServiceCompat } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableVaultService";

import { setLang, translateCatalogueMessage } from "@/core/common/translation";
import { BrowserConfirm } from "./BrowserConfirm";
import { createBrowserKeyValueDatabaseFactory } from "./BrowserKeyValueDatabase";
import { BrowserAPIService, type BrowserAPIServiceOptions } from "./BrowserAPIService";
import { BrowserUIService } from "./BrowserUIService";

export interface BrowserSettingsPersistence {
    load(): Promise<SyncSettings | undefined>;
    save(settings: SyncSettings): Promise<void>;
}

export interface BrowserRestartPolicy {
    schedule(): void;
    perform?: () => void;
    ask?: (message?: string) => void;
    isScheduled?: () => boolean;
}

export interface BrowserServiceHubOptions<T extends ServiceContext> {
    deviceValues: ValueStore & ValueDeleter;
    context?: T;
    getSystemVaultName?: () => string;
    settings?: BrowserSettingsPersistence;
    restart?: BrowserRestartPolicy;
    openKeyValueDatabase?: KeyValueDatabaseFactory;
    API?: Omit<BrowserAPIServiceOptions, "confirm" | "getSystemVaultName">;
}

class BrowserAppLifecycleService<T extends ServiceContext> extends InjectableAppLifecycleService<T> {}

class BrowserDatabaseService<T extends ServiceContext> extends DatabaseService<T> {}

class BrowserKeyValueDBService<T extends ServiceContext> extends KeyValueDBService<T> {}

/** Tabularium-owned service composition shared by WebApp and WebPeer. */
export class BrowserServiceHub<T extends ServiceContext> extends InjectableServiceHub<T> {
    constructor(options: BrowserServiceHubOptions<T>) {
        const context =
            options.context ??
            (new ServiceContext({
                translate: translateCatalogueMessage,
            }) as T);
        const API = new BrowserAPIService(context, {
            ...options.API,
            confirm: new BrowserConfirm(context),
            getSystemVaultName: options.getSystemVaultName ?? (() => "livesync-browser"),
        });
        const conflict = new InjectableConflictService(context);
        const fileProcessing = new InjectableFileProcessingService(context);
        const setting = new InjectableSettingService(context, {
            APIService: API,
            onDisplayLanguageChanged: setLang,
            deviceValues: options.deviceValues,
        });
        const settingsPersistence = options.settings;
        setting.loadData.setHandler(
            settingsPersistence ? () => settingsPersistence.load() : () => Promise.resolve(undefined)
        );
        setting.saveData.setHandler(
            settingsPersistence ? (settings) => settingsPersistence.save(settings) : () => Promise.resolve()
        );

        const appLifecycle = new BrowserAppLifecycleService(context, {
            settingService: setting,
        });
        const restartPolicy = options.restart;
        const scheduleRestart = restartPolicy ? () => restartPolicy.schedule() : () => {};
        appLifecycle.scheduleRestart.setHandler(scheduleRestart);
        appLifecycle.performRestart.setHandler(
            restartPolicy?.perform ? () => restartPolicy.perform?.() : scheduleRestart
        );
        appLifecycle.askRestart.setHandler(
            restartPolicy?.ask ? (message) => restartPolicy.ask?.(message) : scheduleRestart
        );
        appLifecycle.isReloadingScheduled.setHandler(
            restartPolicy?.isScheduled ? () => restartPolicy.isScheduled?.() ?? false : () => false
        );

        const databaseEvents = new InjectableDatabaseEventService(context);
        const path = new PathServiceCompat(context, {
            settingService: setting,
        });
        const vault = new InjectableVaultServiceCompat(context, {
            settingService: setting,
            APIService: API,
        });
        const database = new BrowserDatabaseService(context, {
            pouchDB: PouchDB,
            path,
            vault,
            setting,
            API,
        });
        const config = setting.config;
        const replicator = new InjectableReplicatorService(context, {
            settingService: setting,
            appLifecycleService: appLifecycle,
            databaseEventService: databaseEvents,
        });
        const remote = new InjectableRemoteService(context, {
            pouchDB: PouchDB,
            APIService: API,
            appLifecycle,
            setting,
        });
        const replication = new InjectableReplicationService(context, {
            APIService: API,
            appLifecycleService: appLifecycle,
            replicatorService: replicator,
            settingService: setting,
            fileProcessingService: fileProcessing,
            databaseService: database,
        });
        const keyValueDB = new BrowserKeyValueDBService(context, {
            openKeyValueDatabase: options.openKeyValueDatabase ?? createBrowserKeyValueDatabaseFactory(),
            appLifecycle,
            databaseEvents,
            vault,
        });
        const control = new ControlService(context, {
            appLifecycleService: appLifecycle,
            databaseService: database,
            fileProcessingService: fileProcessing,
            settingService: setting,
            APIService: API,
            replicatorService: replicator,
        });
        const ui = new BrowserUIService(context, {
            API,
            appLifecycle,
            config,
            control,
            replicator,
        });

        super(context, {
            API,
            appLifecycle,
            conflict,
            config,
            control,
            database,
            databaseEvents,
            fileProcessing,
            keyValueDB,
            path,
            remote,
            replication,
            replicator,
            setting,
            test: new InjectableTestService(context),
            tweakValue: new InjectableTweakValueService(context),
            ui,
            vault,
        });
    }
}

export function createBrowserServiceHub<T extends ServiceContext>(
    options: BrowserServiceHubOptions<T>
): BrowserServiceHub<T> {
    return new BrowserServiceHub(options);
}
