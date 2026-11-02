import type { LOG_LEVEL } from "@tabularium/sync-core/compat/common/types";

/** Diagnostic output supplied by the Webapp host. */
export type WebAppLog = (message: unknown, level: LOG_LEVEL, key?: string) => void;
