# Tabularium Server

[English](README.md) · [中文](README.zh-CN.md) · Lingua Latīna

Ministrator [Tabularii](https://github.com/Violaria/Tabularium): porta Node.js ante CouchDB posita, cum repositorio applicationis SQLite et applicatione interretiali. Submodulus est repositorii parentis, quod etiam plicas Compose, instrumenta exemplorum tutelarium et probationes continet; ibi construe et exsequere.

## Quid facit

- Rationes usorum, tabularia et testimonia instrumentorum. Inscriptio libera non est; administratores rationes creant. Quodque tabularium suum repositorium CouchDB est. Instrumenta testimonia sua accipiunt, triginta dies valida, quae clientes dum adhibentur renovant.
- Porta synchronizationis. Additamentum Obsidian et cliens lineae mandatorum per `/sync` replicant, fluxu mutationum diuturno incluso. Porta documenta reicit quae cryptographia ab extremo ad extremum cum viis obscuratis carent, ita ut ministrator nihil nisi textum cryptatum servet. CouchDB tantum in rete interno Compose attingi potest.
- Applicatio interretialis sub `/`: consola administrationis, commentarii interretiales, cliens tabulariorum in navigatro (in navigatro decrypti tessera arcana tabularii, quae ad ministratorem numquam pervenit), optiones rationis, paginae commentariorum communicatorum sub `/s/<inscriptio>`.
- Missio ad Kindle: additamentum et commentarii interretiales EPUB faciunt, quod ministrator per rationem SMTP constitutam mittit.
- Exempla tutelaria statuta repositorii applicationis et omnium tabulariorum, plena et incrementalia, in capsam insertam scripta, quae per `deploy/backup/cli.ts restore-scheduled` restitui possunt.
- Tabularius, curator artificialis optionalis, a domino singulis tabulariis accensus. Tum demum ministrator tesseram arcanam illius tabularii servat (per `TABULARIUS_SECRET_KEY` cryptatam) et copiam operis apertam tenet, ut curator commentarios quaerat, cum citationibus respondeat et emendationes proponat quas dominus recenset antequam rescribuntur.
  - Praebitores: Anthropic, OpenAI, Gemini, DeepSeek, vLLM et Ollama.
  - Instrumenta optionalia: repositorium scientiae locale RAGFlow, quaestio in interrete, SSH ad hospites inscriptos, arenarium ad codicem exsequendum.
  - Textus ad praebitorem missus per colum exeuntem transit qui testimonia celat.

## Dispositio

```text
src/main.ts          punctum ingressus
src/server.ts        viae HTTP et procurator replicationis
src/store.ts         schema SQLite et migrationes
src/couch.ts         administratio CouchDB
src/backup/          exempla tutelaria statuta
src/shares.ts        paginae communicatae
src/smtp.ts          epistulae ad Kindle
src/tabularius/      curator: cliens gubernatus, quaestio, praebitores, propositiones, SSH, interrete
src/sandbox.ts       officium arenarii (eadem imago, continens separatum cum Docker socket)
ui/                  applicatio interretialis (TypeScript, per build-ui.mjs constructa)
test/                probationes API et navigatri
Dockerfile
```

Imago etiam `notes-dist/` (commentarios interretiales) et `cli-dist/` (clientem lineae mandatorum quo Tabularius utitur) continet. Utrumque ex repositorio additamenti per `npm run build:notes` et `npm run build:cli` in repositorio parente construitur; ideo ministrator solus construi non potest.

## Excolendi ratio

In repositorio parente, cum Node.js 24.10.0:

```bash
npm run check:server
npm run test:server            # Docker requiritur; CouchDB temporarium incipit
npm run test:server:browser    # consola administrationis in navigatro sine facie
docker compose --env-file deploy/local/.env -f deploy/local/compose.yaml up --build -d --wait
```

Optiones cursus in paginis interretis constituuntur (Administratio → Optiones ministri, Optiones LLM, Exempla tutelaria); `.env` ea tantum tenet quibus continentia in initio egent et valores semel in primo initio importatos.
