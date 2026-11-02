import { eventHub } from "@/core/common/events";
import { translateCatalogueMessage } from "@/core/common/translation";
import { ServiceContext, type StandardIo } from "@tabularium/sync-core/context";

/** Host capabilities owned by one Tabularium CLI composition. */
export class NodeServiceContext extends ServiceContext {
    constructor(
        readonly databasePath: string,
        readonly standardIo: StandardIo
    ) {
        super({ events: eventHub, translate: translateCatalogueMessage });
    }
}
