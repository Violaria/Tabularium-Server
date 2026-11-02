// Vault paths typed by the user: relative, `/`-separated, no empty, `.`, `..` or hidden segments.

export function normalisePath(input: string, note = false) {
    const parts = input.trim().replace(/\\/g, "/").split("/").map((part) => part.trim());
    if (!parts.length || parts.some((part) => !part || part.startsWith("."))) return undefined;
    let path = parts.join("/");
    if (note && !/\.md$/i.test(path)) path += ".md";
    return path.length > 512 ? undefined : path;
}

export const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A free name in `folder`: `name`, else `name 1`, `name 2`… before the extension. */
export function freePath(folder: string, name: string, taken: (path: string) => boolean) {
    const dot = name.lastIndexOf(".");
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 0; ; n++) {
        const candidate = `${folder ? `${folder}/` : ""}${n ? `${stem} ${n}` : stem}${extension}`;
        if (!taken(candidate)) return candidate;
    }
}
