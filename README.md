# Tabularium Server

English · [中文](README.zh-CN.md) · [Lingua Latīna](README.la.md)

The server of [Tabularium](https://github.com/Violaria/Tabularium): a Node.js gateway in front of CouchDB, with an SQLite application database and a web app. It is a submodule of the parent repository, which also holds the Compose files, the backup tools and the tests; build and run it from there.

## What it does

- Accounts, vaults and device credentials. Registration is closed; administrators create accounts. Each vault is its own CouchDB database. Devices get their own credentials, valid for 30 days and renewed by the clients while in use.
- Synchronisation gateway. The Obsidian plug-in and the command-line client replicate through `/sync`, including the long-lived change feed. The gateway rejects documents that are not end-to-end encrypted with path obfuscation, so the server only ever stores ciphertext. CouchDB is reachable only on the Compose internal network.
- Web app at `/`: the administration console, a browser client for vaults (decrypted in the browser with the vault passphrase, which never reaches the server), account settings, and shared note pages at `/s/<address>`.
- Send to Kindle: the plug-in and the browser client build an EPUB and the server mails it through the configured SMTP account.
- Scheduled backups of the application database and every vault, full and incremental, written to a mounted directory and restorable with `deploy/backup/cli.ts restore-scheduled`.
- Tabularius, an optional AI curator, enabled per vault by its owner. Only then does the server hold that vault's passphrase (encrypted with `TABULARIUS_SECRET_KEY`) and keep a plaintext working copy, so the curator can search the notes, answer with citations and propose edits that the owner reviews before they are written back. Providers: Anthropic, OpenAI, Gemini, DeepSeek, vLLM and Ollama. Optional tools: a local RAGFlow knowledge base, web search, SSH to registered hosts, and a sandbox for running code. Text sent to a provider passes an outbound filter that masks credentials.

## Layout

```text
src/main.ts          entry point
src/server.ts        HTTP routes and the replication proxy
src/store.ts         SQLite schema and migrations
src/couch.ts         CouchDB administration
src/backup/          scheduled backups
src/shares.ts        shared pages
src/smtp.ts          mail for Send to Kindle
src/tabularius/      the AI curator: managed client, search, providers, proposals, SSH, web
src/sandbox.ts       the sandbox service (same image, separate container with the Docker socket)
ui/                  web app (TypeScript, built by build-ui.mjs)
test/                API and browser tests
Dockerfile
```

The image also contains `notes-dist/` (the browser client) and `cli-dist/` (the command-line client used by Tabularius). Both are built from the plug-in repository by `npm run build:notes` and `npm run build:cli` in the parent repository, which is why the server cannot be built on its own.

## Development

From the parent repository, with Node.js 24.10.0:

```bash
npm run check:server
npm run test:server            # needs Docker; starts a temporary CouchDB
npm run test:server:browser    # administration console in a headless browser
docker compose --env-file deploy/local/.env -f deploy/local/compose.yaml up --build -d --wait
```

Runtime settings are made on the web pages (Admin → Server settings, LLM settings, Backups); `.env` holds only what the containers need at start-up and values imported once on first start.
