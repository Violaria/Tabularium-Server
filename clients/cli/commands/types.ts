import { SyncCore } from "@/core/createCore";
import type { SyncSettings } from "@tabularium/sync-core/compat/common/types";
import type { NodeServiceContext } from "@clients/cli/services/NodeServiceContext";
import type { ReplicationSchedulingControl } from "@/core/serviceFeatures/replicationScheduling";

export type CLICommand =
    | "daemon"
    | "sync"
    | "push"
    | "pull"
    | "pull-rev"
    | "put"
    | "cat"
    | "cat-rev"
    | "ls"
    | "info"
    | "rm"
    | "resolve"
    | "mirror"
    | "rebuild"
    | "fetch"
    | "remote-add"
    | "remote-rm"
    | "remote-ls"
    | "remote-export"
    | "remote-set"
    | "remote-activate"
    | "mark-resolved"
    | "unlock-remote"
    | "lock-remote"
    | "remote-status"
    | "init-settings";

export interface CLIOptions {
    databasePath?: string;
    vaultPath?: string;
    settingsPath?: string;
    verbose?: boolean;
    debug?: boolean;
    force?: boolean;
    writeSettings?: boolean;
    /** Restore the former zero exit code after a returned remote-administration verification failure. */
    compatRemoteAdminExitZero?: boolean;
    command: CLICommand;
    commandArgs: string[];
    interval?: number;
}

export interface CLICommandContext {
    databasePath: string;
    vaultPath: string;
    core: SyncCore<NodeServiceContext>;
    /** Host-composition view used only to coordinate daemon-owned recurring work. */
    replicationScheduling: ReplicationSchedulingControl;
    settingsPath: string;
    originalSyncSettings: Pick<
        SyncSettings,
        | "liveSync"
        | "syncOnStart"
        | "periodicReplication"
        | "syncOnSave"
        | "syncOnEditorSave"
        | "syncOnFileOpen"
        | "syncAfterMerge"
    >;
}

export const VALID_COMMANDS = new Set([
    "daemon",
    "sync",
    "push",
    "pull",
    "pull-rev",
    "put",
    "cat",
    "cat-rev",
    "ls",
    "info",
    "rm",
    "resolve",
    "mirror",
    "rebuild",
    "fetch",
    "remote-add",
    "remote-rm",
    "remote-ls",
    "remote-export",
    "remote-set",
    "remote-activate",
    "mark-resolved",
    "unlock-remote",
    "lock-remote",
    "remote-status",
    "init-settings",
] as const);

export function isCLICommand(value: string): value is CLICommand {
    return (VALID_COMMANDS as ReadonlySet<string>).has(value);
}
