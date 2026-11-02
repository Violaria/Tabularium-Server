import type { ServiceContext } from "@tabularium/sync-core/context";
import type { AppLifecycleService } from "@tabularium/sync-core/compat/services/base/AppLifecycleService";
import type { IConfigService } from "@tabularium/sync-core/compat/services/base/IService";
import type { ControlService } from "@tabularium/sync-core/compat/services/base/ControlService";
import type { ReplicatorService } from "@tabularium/sync-core/compat/services/base/ReplicatorService";
import type { InjectableAPIService } from "@tabularium/sync-core/compat/services/implements/injectable/InjectableAPIService";
import { UIService } from "@tabularium/sync-core/compat/services/implements/base/UIService";
import DialogToCopy from "@/ui/dialogs/dialogues/DialogueToCopy.svelte";
import { BrowserSvelteDialogManager } from "./BrowserSvelteDialogManager";

export interface BrowserUIServiceDependencies<T extends ServiceContext> {
    API: InjectableAPIService<T>;
    appLifecycle: AppLifecycleService<T>;
    config: IConfigService;
    control: ControlService<T>;
    replicator: ReplicatorService<T>;
}

export class BrowserUIService<T extends ServiceContext> extends UIService<T> {
    override get dialogToCopy() {
        return DialogToCopy;
    }
    constructor(context: T, dependents: BrowserUIServiceDependencies<T>) {
        const browserConfirm = dependents.API.confirm;
        const obsidianSvelteDialogManager = new BrowserSvelteDialogManager<T>(context, {
            appLifecycle: dependents.appLifecycle,
            config: dependents.config,
            replicator: dependents.replicator,
            confirm: browserConfirm,
            control: dependents.control,
        });
        super(context, {
            dialogManager: obsidianSvelteDialogManager,
            APIService: dependents.API,
        });
    }
}
