// What the sorting engine needs from Obsidian when it runs in the browser: file and folder classes for its
// instanceof checks and the fields it reads. The web notes build maps the module "obsidian" to this file.
export class TAbstractFile {
    parent: TFolder | null = null;
    constructor(
        readonly path: string,
        readonly name: string
    ) {}
}
export class TFile extends TAbstractFile {
    readonly basename: string;
    readonly extension: string;
    constructor(
        path: string,
        name: string,
        readonly stat: { ctime: number; mtime: number; size: number }
    ) {
        super(path, name);
        const dot = name.lastIndexOf(".");
        this.basename = dot > 0 ? name.slice(0, dot) : name;
        this.extension = dot > 0 ? name.slice(dot + 1) : "";
    }
}
export class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];
    isRoot() {
        return this.path === "/";
    }
}
export class Vault {
    static recurseChildren(root: TFolder, callback: (file: TAbstractFile) => unknown) {
        const pending: TAbstractFile[] = [root];
        while (pending.length) {
            const file = pending.pop();
            callback(file);
            if (file instanceof TFolder) pending.push(...file.children);
        }
    }
}
