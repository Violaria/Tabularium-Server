import { LOG_LEVEL_INFO } from "@tabularium/sync-core/compat/common/types";
import type { IStorageEventWatchHandlers } from "@tabularium/sync-core/compat/managers/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FSAPIStorageEventManagerAdapter } from "@clients/webapp/managers/FSAPIStorageEventManagerAdapter";
import type { FSAPIFile } from "@clients/webapp/adapters/FSAPITypes";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("WebApp file watching guidance", () => {
    it("offers a capability-based manual fallback when FileSystemObserver is unavailable", async () => {
        vi.stubGlobal("FileSystemObserver", undefined);
        const addLog = vi.fn();
        const adapter = new FSAPIStorageEventManagerAdapter({} as FileSystemDirectoryHandle, addLog);
        const handlers = {
            onCreate: vi.fn(),
            onChange: vi.fn(),
            onDelete: vi.fn(),
            onRename: vi.fn(),
            onRaw: vi.fn(),
        } satisfies IStorageEventWatchHandlers<FSAPIFile>;

        await adapter.watch.beginWatch(handlers);

        expect(addLog).toHaveBeenCalledWith(
            "Use 'Scan local files' after external changes",
            LOG_LEVEL_INFO,
            "fsapi-watch"
        );
        expect(addLog.mock.calls.map(([message]) => String(message)).join("\n")).not.toMatch(/Chrome \d+/);
    });
});
