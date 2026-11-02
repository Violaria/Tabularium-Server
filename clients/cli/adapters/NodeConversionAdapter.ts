import type { FilePath, UXFileInfoStub, UXFolderInfo } from "@tabularium/sync-core/compat/common/types";
import type { IConversionAdapter } from "@tabularium/sync-core/compat/serviceModules/adapters";
import type { NodeFile, NodeFolder } from "./NodeTypes";
import { path } from "@clients/cli/platform";

/**
 * Conversion adapter implementation for Node.js
 */
export class NodeConversionAdapter implements IConversionAdapter<NodeFile, NodeFolder> {
    nativeFileToUXFileInfoStub(file: NodeFile): UXFileInfoStub {
        return {
            name: path.basename(file.path),
            path: file.path,
            stat: file.stat,
            isFolder: false,
        };
    }

    nativeFolderToUXFolder(folder: NodeFolder): UXFolderInfo {
        return {
            name: path.basename(folder.path),
            path: folder.path,
            isFolder: true,
            children: [],
            parent: path.dirname(folder.path) as FilePath,
        };
    }
}
