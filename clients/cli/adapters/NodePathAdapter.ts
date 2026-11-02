import type { FilePath } from "@tabularium/sync-core/compat/common/types";
import type { IPathAdapter } from "@tabularium/sync-core/compat/serviceModules/adapters";
import type { NodeFile } from "./NodeTypes";
import { path } from "@clients/cli/platform";

/**
 * Path adapter implementation for Node.js
 */
export class NodePathAdapter implements IPathAdapter<NodeFile> {
    getPath(file: string | NodeFile): FilePath {
        return (typeof file === "string" ? file : file.path) as FilePath;
    }

    normalisePath(p: string): string {
        // Normalize path separators to forward slashes (like Obsidian)
        return path.normalize(p).replace(/\\/g, "/");
    }
}
