// File tree order for web notes: the lists in the vault's Collation.md notes, with the plug-in's file order code, so the
// tree matches Obsidian's file list.
import { arrange, defaultOrder, FORMER_RULES_FILE, isRulesNote, namesOf, orderFor, readOrders } from "@/core/common/fileOrder";

export interface SortedNode {
    name: string;
    path: string;
    folder: boolean;
    children: SortedNode[];
}
export type SortRules = ReturnType<typeof readOrders>;

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Notes that may hold sorting rules. */
export const isSpecSource = (path: string) => isRulesNote(path);

/**
 * The rules in the rules notes, and whether a folder still has only the former rules note (sortspec.md, no longer read),
 * which the plug-in converts. `paths` are all the vault's files.
 */
export function parseSpecs(sources: { path: string; text: string }[], paths: string[]): { rules: SortRules; unconverted: boolean } {
    const current = new Set(paths.filter((path) => isRulesNote(path)).map(folderOf));
    const unconverted = paths.some((path) => isRulesNote(path, FORMER_RULES_FILE) && !current.has(folderOf(path)));
    return { rules: readOrders(sources), unconverted };
}

interface Folder {
    name: string;
    path: string;
    folders: Map<string, Folder>;
    files: string[];
}

/** The tree of `files`: each folder by name with folders first, then arranged by the rules. */
export function sortedTree(files: { path: string }[], rootName: string, rules: SortRules = []): SortedNode {
    const root: Folder = { name: rootName, path: "", folders: new Map(), files: [] };
    const folderAt = (path: string): Folder => {
        if (!path) return root;
        const parent = folderAt(folderOf(path));
        let folder = parent.folders.get(nameOf(path));
        if (!folder) parent.folders.set(nameOf(path), (folder = { name: nameOf(path), path, folders: new Map(), files: [] }));
        return folder;
    };
    for (const file of files) folderAt(folderOf(file.path)).files.push(file.path);
    const convert = (folder: Folder): SortedNode => {
        const children: SortedNode[] = [
            ...[...folder.folders.values()].map(convert),
            ...folder.files.map((path): SortedNode => ({ name: nameOf(path), path, folder: false, children: [] })),
        ];
        const ordered = arrange(
            defaultOrder(children, (node) => node.name, (node) => node.folder),
            orderFor(rules, folder.path),
            (node) => namesOf(node.name, node.folder)
        );
        return { name: folder.name, path: folder.path, folder: true, children: ordered };
    };
    return convert(root);
}
