// Projects and the archive: how a user arranges their conversations in a vault. A project is only a named group;
// deleting it leaves its conversations ungrouped. Archived conversations leave the list but stay readable, can be
// continued and are still found by search_conversations.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

interface Owner { id: string }
interface Project { id: string; name: string; createdAt: number }

const NAME_LIMIT = 80;
const TITLE_LIMIT = 120;

export function createProjects(db: DatabaseSync, fail: (status: number, message: string) => never) {
  const name = (value: unknown, limit: number) => {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!text || text.length > limit) fail(400, 'Invalid name');
    return text;
  };
  const projectFor = (id: string, user: Owner) => {
    const project = db.prepare('SELECT id, vault_id AS vaultId FROM tabularius_projects WHERE id=? AND user_id=?').get(id, user.id) as { id: string; vaultId: string } | undefined;
    if (!project) fail(404, 'Project not found');
    return project!;
  };
  return {
    list(vaultId: string, user: Owner) {
      return db.prepare('SELECT id, name, created_at AS createdAt FROM tabularius_projects WHERE vault_id=? AND user_id=? ORDER BY name COLLATE NOCASE')
        .all(vaultId, user.id) as unknown as Project[];
    },
    create(vaultId: string, user: Owner, value: unknown): Project {
      const project = { id: randomUUID(), name: name(value, NAME_LIMIT), createdAt: Date.now() };
      db.prepare('INSERT INTO tabularius_projects(id,user_id,vault_id,name,created_at) VALUES(?,?,?,?,?)').run(project.id, user.id, vaultId, project.name, project.createdAt);
      return project;
    },
    rename(id: string, user: Owner, value: unknown) {
      projectFor(id, user);
      db.prepare('UPDATE tabularius_projects SET name=? WHERE id=?').run(name(value, NAME_LIMIT), id);
    },
    remove(id: string, user: Owner) {
      projectFor(id, user);
      db.prepare('DELETE FROM tabularius_projects WHERE id=?').run(id);
    },
    /** Title, project (an id of the user's projects in the same vault, or null) and archive state of a conversation. */
    arrange(conversation: { id: string; vault_id: string }, user: Owner, data: Record<string, unknown>) {
      if (data.title !== undefined) db.prepare('UPDATE tabularius_conversations SET title=? WHERE id=?').run(name(data.title, TITLE_LIMIT), conversation.id);
      if (data.project !== undefined) {
        if (data.project !== null && (typeof data.project !== 'string' || projectFor(data.project, user).vaultId !== conversation.vault_id)) fail(404, 'Project not found');
        db.prepare('UPDATE tabularius_conversations SET project_id=? WHERE id=?').run(data.project as string | null, conversation.id);
      }
      if (data.archived !== undefined) {
        if (typeof data.archived !== 'boolean') fail(400, 'archived must be a boolean');
        db.prepare('UPDATE tabularius_conversations SET archived_at=? WHERE id=?').run(data.archived ? Date.now() : null, conversation.id);
      }
    },
    /** Everything a vault's projects hold, when Tabularius is turned off for it. */
    forgetVault(vaultId: string) {
      db.prepare('DELETE FROM tabularius_projects WHERE vault_id=?').run(vaultId);
    },
  };
}
export type Projects = ReturnType<typeof createProjects>;
