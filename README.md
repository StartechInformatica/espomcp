# EspoMCP HTTP – stack Docker per Dockhand

Server MCP per EspoCRM basato su [cauldr0nx/EspoMCP](https://github.com/cauldr0nx/EspoMCP),
esposto via **Streamable HTTP** così da poterlo ospitare su un server e collegarlo da remoto.

L'upstream supporta solo il trasporto `stdio` (la variabile `MCP_TRANSPORT` viene ignorata),
quindi questo pacchetto aggiunge `src/http.ts`: un entrypoint HTTP che riusa i tool originali
senza modificare il codice upstream. In più aggiunge:

- **annotazioni MCP** sui tool (`readOnlyHint`, `destructiveHint`): i tool upstream non ne hanno,
  e senza annotazioni TrueForge non chiede approvazione nemmeno per `delete_entity`;
- **token di sola lettura** (`MCP_AUTH_TOKEN_READONLY`) che espone solo `search_*`, `get_*`, `health_check`;
- **blacklist globale** dei tool (`MCP_TOOLS_DENY`);
- **eviction LRU** delle sessioni: al raggiungimento del limite si chiude la meno usata
  (il client riceve 404 e riapre una sessione nuova, come previsto dalla spec).

## Contenuto

| File | Scopo |
|---|---|
| `Dockerfile` | Build multi-stage: clona l'upstream a un commit fissato, aggiunge `http.ts`, compila, runtime non-root |
| `src/http.ts` | Entrypoint Streamable HTTP con sessioni, auth a token, `/health` |
| `docker-compose.yml` | Definizione dello stack per Dockhand |
| `.env.example` | Variabili da configurare |

## 1. Preparare EspoCRM

1. **Administration → API Users → Create**: crea un utente API (es. `mcp-bot`), Authentication Method = *API Key* (o *HMAC*).
2. Assegnagli un **ruolo dedicato** con i soli permessi necessari. I tool includono `delete_entity`,
   `assign_role_to_user`, `add_user_to_team`: se non vuoi che l'AI possa cancellare o gestire utenti,
   togli *delete* e l'accesso a User/Team/Role dal ruolo.
3. Copia la API Key.

## 2. Deploy su Dockhand

Prima di tutto crea la rete condivisa con TrueForge (una volta sola):
`docker network create mcp-net`, oppure da Dockhand → Networks → Create.
Se non ti serve, rimuovi il blocco `mcp-net` dal compose.

### Opzione A – Git stack (consigliata)
1. Pubblica questa cartella in un repository Git (anche privato).
2. In Dockhand: **Stacks → New → Git**, indica repo e branch, compose file `docker-compose.yml`.
3. Nella sezione **Environment variables** dello stack inserisci almeno
   `ESPOCRM_URL`, `ESPOCRM_API_KEY`, `MCP_AUTH_TOKEN` (generalo con `openssl rand -hex 32`).
4. Deploy. Al primo avvio viene eseguita la build dell'immagine.

### Opzione B – Stack interno
1. Copia la cartella sul server e costruisci l'immagine: `docker build -t espomcp-http:latest .`
2. In Dockhand crea uno stack interno incollando `docker-compose.yml` **senza** il blocco `build:`
   (resta `image: espomcp-http:latest`) e imposta le variabili.

### Verifica
Nei log del container deve comparire `EspoCRM reachable` e poi `listening`.

```bash
curl http://SERVER:3000/health
```

## 3. Esporre in HTTPS (solo per client esterni)

Non serve se lo usi solo da TrueForge sulla rete `mcp-net` dello stesso host.

Per claude.ai / Claude Desktop le connessioni partono dal cloud di Anthropic: il server deve essere
raggiungibile pubblicamente in **HTTPS**. Metti davanti un reverse proxy (Traefik, Caddy, Nginx Proxy Manager…)
che inoltri `https://mcp.tuodominio.it` → `espomcp:3000`.

Con Nginx aggiungi `proxy_buffering off;` e `proxy_read_timeout 3600s;` (serve per lo stream SSE su GET).

## 4. Collegare TrueForge

### Rete
Se TrueForge gira sullo stesso host Docker, non serve HTTPS pubblico: collega il suo servizio
`server` alla rete `mcp-net` aggiungendo al compose di TrueForge:

```yaml
services:
  server:
    # ...configurazione esistente...
    networks:
      - default
      - mcp-net

networks:
  mcp-net:
    external: true
```

### Connettore
In TrueForge: **Settings → Connectors → Add MCP Server**

- URL: `http://espomcp:3000/mcp`
- Autenticazione: **Header auth** → `Authorization` = `Bearer <MCP_AUTH_TOKEN>`

Consigliato: crea due connettori, **EspoCRM** (token completo) ed **EspoCRM lettura**
(`MCP_AUTH_TOKEN_READONLY`), così gli agenti di reportistica/analisi non possono scrivere
nemmeno per errore di configurazione.

### Agenti
- Grazie alle annotazioni, la policy di approvazione di default di TrueForge (`@write`, `@destructive`)
  si applica davvero: creazioni, modifiche e cancellazioni passano dall'approvazione umana.
  Per agenti autonomi (es. schedulati) valuta di togliere l'approvazione solo sui `@write`
  e lasciarla sui `@destructive`.
- Il selettore `@read-only` sui tool abilitati ora funziona (22 tool di lettura).
- Con ~45 tool conviene lasciare attivo il caricamento differito dei tool di TrueForge
  e precaricare solo quelli usati spesso (es. `search_entity`, `get_entity`).
- `search_entity` / `create_entity` / `update_entity` funzionano anche con le entità custom:
  nelle istruzioni dell'agente indica i nomi tecnici delle entità e dei campi (es. `CMyEntity`).

Se TrueForge gira su un altro host o usi la versione hosted di TrueFoundry, usa l'URL HTTPS
pubblico del reverse proxy con lo stesso header.

## 5. Altri client

**Claude Code** (header Bearer):
```bash
claude mcp add --transport http espocrm https://mcp.tuodominio.it/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**claude.ai / Claude Desktop** (Customize → Connectors → Add custom connector):
questi client non permettono header custom, quindi usa il token nel path e lascia vuota l'autenticazione OAuth:
```
https://mcp.tuodominio.it/mcp/<MCP_AUTH_TOKEN>
```
Tratta questo URL come una password.

**MCP Inspector** (test): `npx @modelcontextprotocol/inspector` → Transport *Streamable HTTP*,
URL `http://SERVER:3000/mcp`, header `Authorization: Bearer <token>`.

## Variabili

| Variabile | Default | Note |
|---|---|---|
| `ESPOCRM_URL` | – | Obbligatoria. URL base di EspoCRM (senza `/api/v1`) |
| `ESPOCRM_API_KEY` | – | Obbligatoria |
| `ESPOCRM_AUTH_METHOD` | `apikey` | `apikey` o `hmac` |
| `ESPOCRM_SECRET_KEY` | – | Solo per `hmac` |
| `MCP_AUTH_TOKEN` | – | Accesso completo. Se vuoto (e senza token readonly) il server è **aperto a chiunque** |
| `MCP_AUTH_TOKEN_READONLY` | – | Accesso ai soli tool di lettura; deve essere diverso da `MCP_AUTH_TOKEN` |
| `MCP_TOOLS_DENY` | – | Tool nascosti e bloccati per tutti, separati da virgola |
| `MCP_TOOL_ANNOTATIONS` | `true` | Aggiunge `readOnlyHint`/`destructiveHint` ai tool |
| `MCP_DESTRUCTIVE_TOOLS` | vedi `.env.example` | Override della lista dei tool marcati come distruttivi |
| `MCP_SHARED_NETWORK` | `mcp-net` | Rete Docker esterna condivisa con TrueForge |
| `MCP_PATH` | `/mcp` | Percorso endpoint |
| `MCP_ALLOW_PATH_TOKEN` | `true` | Abilita `/mcp/<token>`; mettilo a `false` se usi solo client con header |
| `MCP_JSON_RESPONSE` | `true` | Risposte POST in JSON invece di SSE (più semplice dietro proxy) |
| `MCP_SESSION_TTL_MINUTES` | `60` | Chiusura sessioni inattive |
| `MCP_MAX_SESSIONS` | `50` | Oltre il limite viene chiusa la sessione usata meno di recente |
| `MCP_HOST_PORT` | `3000` | Porta pubblicata sull'host |
| `ESPOMCP_REF` | commit fissato | Commit/branch upstream da compilare (`master` per l'ultima versione) |

## Note

- Ogni nuova sessione MCP esegue un test di connessione a EspoCRM: se EspoCRM non risponde,
  il client riceve un errore 502 ma il container resta attivo.
- Dopo un redeploy le sessioni aperte vanno perse: TrueForge riceve 404 e si riconnette da solo.
- La vera barriera resta il **ruolo dell'API User in EspoCRM**: token readonly e blacklist sono
  difese aggiuntive, non sostitutive.
- Log su stdout (visibili in Dockhand) e in `/app/logs` (volume `espomcp-logs`).
- Per aggiornare l'upstream cambia `ESPOMCP_REF` e rifai il deploy con rebuild.
