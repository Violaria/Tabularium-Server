import { posix } from 'node:path';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MARKDOWN = /(\]\()(<[^>\n]*>|[^()\s]+)(\))/g;
const WIKI = /\[\[([^\]|#\n]+)(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g;

// The vault's link style: spaces, parentheses, `#` and `%` percent-encoded, everything else as is.
const encode = (path: string) => path.replace(/[%() #]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const decode = (path: string) => { try { return decodeURIComponent(path); } catch { return path; } };

/** Resolves a wikilink target the way Obsidian does for unambiguous cases: a full vault path, else a unique path suffix. */
function resolveWiki(target: string, files: Set<string>) {
  const name = target.trim();
  for (const candidate of [name, `${name}.md`]) if (files.has(candidate)) return candidate;
  const matches = [...files].filter(path => path.endsWith(`/${name}`) || path.endsWith(`/${name}.md`));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Rewrites the links of one note after a set of moves. `from`/`to` are the note's old and new paths, `moves` maps old to new
 * paths, `before`/`after` are all vault files before and after the change. Links that do not resolve are left alone.
 */
export function repairLinks(text: string, from: string, to: string, moves: Map<string, string>, before: Set<string>, after: Set<string>) {
  const moved = from !== to;
  const markdown = text.replace(MARKDOWN, (whole, open: string, raw: string, close: string) => {
    const bracketed = raw.startsWith('<');
    const value = bracketed ? raw.slice(1, -1) : raw;
    if (SCHEME.test(value) || value.startsWith('#') || value.startsWith('/')) return whole;
    const hash = value.indexOf('#');
    const [path, fragment] = hash < 0 ? [value, ''] : [value.slice(0, hash), value.slice(hash)];
    const target = posix.normalize(posix.join(posix.dirname(from), decode(path)));
    if (!before.has(target)) return whole;
    const destination = moves.get(target) ?? target;
    if (!moved && destination === target) return whole;
    const relative = posix.relative(posix.dirname(to), destination);
    return `${open}${bracketed ? `<${relative}${fragment}>` : `${encode(relative)}${fragment}`}${close}`;
  });
  return markdown.replace(WIKI, (whole, target: string, heading = '', alias = '') => {
    const resolved = resolveWiki(target, before);
    const destination = resolved && moves.get(resolved);
    if (!destination) return whole;
    const extension = target.trim().endsWith('.md') ? '' : '.md';
    const bare = (path: string) => extension ? path.replace(/\.md$/, '') : path;
    const basename = posix.basename(destination);
    const unique = [...after].filter(path => posix.basename(path) === basename).length === 1;
    return `[[${!target.includes('/') && unique ? bare(basename) : bare(destination)}${heading}${alias}]]`;
  });
}
