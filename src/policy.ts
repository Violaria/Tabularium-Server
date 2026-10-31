// Accepts only the document shapes LiveSync writes with E2EE V2 and path obfuscation, measured with real clients on 2026-10-29.
// This is a structural check: plaintext that imitates the ciphertext prefixes cannot be recognised. Each kind of document
// may carry only its own fields (as written by the clients in production, 2026-10-31), so no plaintext rides along.
const REPLICATION = ['_id', '_rev', '_deleted', '_revisions', '_conflicts', '_deleted_conflicts'];
const FIELDS = {
  version: new Set([...REPLICATION, 'type', 'version', 'used_features']),
  chunk: new Set([...REPLICATION, 'type', 'data', 'e_']),
  file: new Set([...REPLICATION, 'type', 'datatype', 'path', 'mtime', 'ctime', 'size', 'children', 'eden', 'deleted']),
};
const unexpected = (doc: Record<string, unknown>, allowed: Set<string>) => Object.keys(doc).find(key => !allowed.has(key));
export function rejection(doc: Record<string, unknown>): string | undefined {
  const id = doc._id;
  if (typeof id !== 'string') return 'documents need an id';
  if ('_attachments' in doc) return 'attachments are not accepted';
  if (id !== 'obsydian_livesync_version' && !id.startsWith('h:') && !id.startsWith('f:')) return 'only encrypted LiveSync documents are accepted';
  if (doc._deleted === true && Object.keys(doc).every(key => key.startsWith('_'))) return undefined;
  const kind = id === 'obsydian_livesync_version' ? 'version' : id.startsWith('h:') ? 'chunk' : 'file';
  const extra = unexpected(doc, FIELDS[kind]);
  if (extra) return `unexpected field ${extra.slice(0, 40)}`;
  if (id === 'obsydian_livesync_version') return doc.type === 'versioninfo' ? undefined : 'unexpected version document';
  if (id.startsWith('h:')) {
    return doc.type === 'leaf' && doc.e_ === true && typeof doc.data === 'string' && doc.data.startsWith('%') ? undefined : 'chunks must be encrypted';
  }
  if (id.startsWith('f:')) {
    if (typeof doc.path !== 'string' || !doc.path.startsWith('/\\:')) return 'file metadata must be encrypted';
    if (doc.mtime !== 0 || doc.ctime !== 0 || doc.size !== 0) return 'file metadata must not expose times or sizes';
    if (!Array.isArray(doc.children) || doc.children.length) return 'file metadata must not list chunks in clear';
    if (doc.eden !== undefined) {
      const entries = Object.values((doc.eden ?? {}) as Record<string, { data?: unknown }>);
      if (entries.length > 1 || entries.some(entry => typeof entry?.data !== 'string' || !entry.data.startsWith('%'))) return 'eden must be encrypted';
    }
  }
  return undefined;
}
