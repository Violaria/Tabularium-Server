export interface CouchConfig { url: string; adminUser: string; adminPassword: string; syncUser: string; syncPassword: string }
export const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

export class Couch {
  readonly config: CouchConfig;
  constructor(config: CouchConfig) { this.config = config; }
  async admin(path: string, method = 'GET', body?: unknown) {
    return fetch(`${this.config.url}${path}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { authorization: basic(this.config.adminUser, this.config.adminPassword), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async prepare() {
    if (this.config.syncUser === this.config.adminUser) throw new Error('CouchDB sync identity must differ from administrator');
    let response = await this.admin('/_users', 'PUT');
    if (![201, 202, 412].includes(response.status)) throw new Error(`CouchDB _users: ${response.status}`);
    await response.arrayBuffer();
    const path = `/_users/${encodeURIComponent(`org.couchdb.user:${this.config.syncUser}`)}`;
    response = await this.admin(path);
    if (response.status === 404) {
      await response.arrayBuffer();
      response = await this.admin(path, 'PUT', { name: this.config.syncUser, password: this.config.syncPassword, roles: [], type: 'user' });
      if (!response.ok) throw new Error(`CouchDB service user: ${response.status}`);
    } else if (!response.ok) throw new Error(`CouchDB service user: ${response.status}`);
    await response.arrayBuffer();
    response = await fetch(`${this.config.url}/_session`, { signal: AbortSignal.timeout(15_000), headers: {
      authorization: basic(this.config.syncUser, this.config.syncPassword),
    } });
    const session = await response.json() as { userCtx?: { name: string; roles: string[] } };
    if (!response.ok || session.userCtx?.name !== this.config.syncUser || session.userCtx.roles.includes('_admin')) {
      throw new Error('CouchDB sync credentials must authenticate a non-admin user');
    }
  }
  async provision(database: string) {
    let response = await this.admin(`/${database}`, 'PUT');
    if (![201, 202, 412].includes(response.status)) throw new Error(`CouchDB create: ${response.status}`);
    await response.arrayBuffer();
    response = await this.admin(`/${database}/_security`, 'PUT', {
      admins: { names: [], roles: [] }, members: { names: [this.config.syncUser], roles: [] },
    });
    if (!response.ok) throw new Error(`CouchDB security: ${response.status}`);
    await response.arrayBuffer();
  }
}
