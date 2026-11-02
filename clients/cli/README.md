# Tabularium CLI

The command-line client, built on the plug-in's sync core (derived from the command-line client of Self-hosted LiveSync). Tabularium uses it in two places: the server image runs it as the managed client of Tabularius (`apps/server/cli-dist`, built by `npm run build:cli` in the parent repository), and a host can run it as a plaintext mirror of a vault. It syncs with a Tabularium gateway like any other device, with credentials issued for it on the web.

## Building

From the parent repository, with Node.js 24.10.0:

```bash
npm run build:cli
node apps/server/clients/cli/dist/index.cjs --help
```

## Configuration

Settings use the plug-in's format. Create a file with the defaults and edit it:

```bash
node dist/index.cjs init-settings ./settings.json
```

For a Tabularium vault set at least `couchDB_URI` (`<server>/sync`), `couchDB_DBNAME` (the vault ID), `couchDB_USER` and `couchDB_PASSWORD` (the device credentials), `encrypt: true`, `E2EEAlgorithm: "v2"`, `usePathObfuscation: true`, `passphrase` (the vault's passphrase) and `isConfigured: true`. Set `readChunksOnline: false` so that a first fetch of a large vault receives chunks in batches instead of one request per chunk.

## Usage

```text
tabularium-cli <database-path> [--settings <file>] [--vault <path>] [options] <command> [command-args]
```

`--help` lists every command and option. The ones Tabularium relies on:

| Command | Purpose |
| --- | --- |
| `fetch --force` | replace the local database with the remote state and write the vault files |
| `daemon` | scan the vault, then keep syncing in both directions (the default command) |
| `sync` | one replication cycle |
| `mirror [vault-path]` | write the database contents to the file system |
| `ls`, `info`, `cat`, `cat-rev`, `pull`, `pull-rev` | read files and revisions from the local database |
| `put`, `push`, `rm`, `resolve` | change files in the local database and resolve conflicts |
| `rebuild --force`, `unlock-remote` | rebuild the remote from this vault, unlock it afterwards |

Files and folders whose names start with a dot are not synchronised.

## Tests

Unit tests: `npm run test:clients` in the parent repository. The shell and Deno end-to-end suites in `test/` and `testdeno/` need a CouchDB (and for some, MinIO), started by the scripts in `util/`; see `testdeno/CONTRIBUTING_TESTS.md`.
