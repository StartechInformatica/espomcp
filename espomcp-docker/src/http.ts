#!/usr/bin/env node
/**
 * EspoMCP - Streamable HTTP entrypoint
 *
 * Espone il server MCP di EspoMCP (upstream solo stdio) via HTTP secondo la
 * specifica MCP "Streamable HTTP", così da poterlo ospitare in un container
 * e collegarlo da remoto (Claude Desktop/Code, claude.ai connector, ecc.).
 *
 * Endpoint:
 *   POST|GET|DELETE  {MCP_PATH}            -> auth con "Authorization: Bearer <token>"
 *   POST|GET|DELETE  {MCP_PATH}/<token>    -> auth con token nel path (per client
 *                                             che non permettono header custom)
 *   GET              /health               -> healthcheck (senza auth)
 *
 * Funzioni aggiuntive rispetto all'upstream:
 *   - annotazioni MCP sui tool (readOnlyHint / destructiveHint), usate da client
 *     come TrueForge per selettori @read-only / @write / @destructive e approvazioni
 *   - token di sola lettura (MCP_AUTH_TOKEN_READONLY) che espone solo i tool di lettura
 *   - blacklist globale dei tool (MCP_TOOLS_DENY)
 *   - eviction LRU delle sessioni quando si raggiunge MCP_MAX_SESSIONS
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, validateConfiguration, isSchemaOnlyMode } from './config/index.js';
import { setupEspoCRMTools } from './tools/index.js';
import { EspoCRMClient } from './espocrm/client.js';
import logger from './utils/logger.js';

// ---------------------------------------------------------------------------
// Configurazione HTTP
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MCP_PATH = ('/' + (process.env.MCP_PATH || 'mcp').replace(/^\/+|\/+$/g, ''));
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const AUTH_TOKEN_READONLY = process.env.MCP_AUTH_TOKEN_READONLY || '';
const ALLOW_PATH_TOKEN = (process.env.MCP_ALLOW_PATH_TOKEN || 'true') !== 'false';
const JSON_RESPONSE = (process.env.MCP_JSON_RESPONSE || 'true') !== 'false';
const SESSION_TTL_MS = parseInt(process.env.MCP_SESSION_TTL_MINUTES || '60', 10) * 60_000;
const MAX_SESSIONS = parseInt(process.env.MCP_MAX_SESSIONS || '50', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const csv = (v: string | undefined) =>
  (v || '').split(',').map((x) => x.trim()).filter(Boolean);

const ANNOTATIONS_ENABLED = (process.env.MCP_TOOL_ANNOTATIONS || 'true') !== 'false';
const TOOLS_DENY = new Set(csv(process.env.MCP_TOOLS_DENY));
// Tool di scrittura considerati "distruttivi" (sovrascrivono/rimuovono dati o permessi)
const DESTRUCTIVE_TOOLS = new Set(
  csv(process.env.MCP_DESTRUCTIVE_TOOLS).length
    ? csv(process.env.MCP_DESTRUCTIVE_TOOLS)
    : ['delete_entity', 'update_entity', 'unlink_entities', 'remove_user_from_team', 'assign_role_to_user']
);
const READ_ONLY_RE = /^(search_|get_)|^health_check$/;

type Profile = 'full' | 'readonly';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: Server;
  profile: Profile;
  lastSeen: number;
}

const sessions = new Map<string, SessionEntry>();

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const AUTH_HASH = AUTH_TOKEN ? sha256(AUTH_TOKEN) : null;
const RO_HASH = AUTH_TOKEN_READONLY ? sha256(AUTH_TOKEN_READONLY) : null;

function tokenMatches(candidate: string | undefined | null, hash: Buffer | null): boolean {
  if (!hash || !candidate) return false;
  return timingSafeEqual(sha256(candidate), hash);
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Autentica la richiesta e restituisce il profilo ('full' | 'readonly'),
 * oppure null se non autorizzata. pathToken è il segmento dopo MCP_PATH.
 */
function authenticate(req: IncomingMessage, pathToken: string | null): Profile | null {
  if (!AUTH_HASH && !RO_HASH) return 'full'; // auth disabilitata (sconsigliato)
  let candidate: string | null = null;
  if (pathToken !== null) {
    candidate = ALLOW_PATH_TOKEN ? pathToken : null;
  } else {
    const m = (headerValue(req, 'authorization') || '').match(/^Bearer\s+(.+)$/i);
    candidate = m ? m[1].trim() : null;
  }
  if (tokenMatches(candidate, AUTH_HASH)) return 'full';
  if (tokenMatches(candidate, RO_HASH)) return 'readonly';
  return null;
}

// ---------------------------------------------------------------------------
// Policy sui tool (annotazioni, sola lettura, blacklist)
// ---------------------------------------------------------------------------
function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_RE.test(name);
}

function toolAllowed(name: string, profile: Profile): boolean {
  if (TOOLS_DENY.has(name)) return false;
  if (profile === 'readonly' && !isReadOnlyTool(name)) return false;
  return true;
}

function annotationsFor(name: string) {
  const readOnly = isReadOnlyTool(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly,
    openWorldHint: false,
  };
}

/**
 * Avvolge gli handler tools/list e tools/call registrati da EspoMCP.
 * Usa la mappa interna _requestHandlers dell'SDK MCP (versione fissata dal
 * package-lock upstream): se cambiasse, fallisce in modo esplicito.
 */
function applyToolPolicy(server: Server, profile: Profile): void {
  const needsWrap = ANNOTATIONS_ENABLED || TOOLS_DENY.size > 0 || profile === 'readonly';
  if (!needsWrap) return;

  const handlers = (server as any)._requestHandlers as Map<string, (req: any, extra: any) => Promise<any>> | undefined;
  const listHandler = handlers?.get('tools/list');
  const callHandler = handlers?.get('tools/call');
  if (!handlers || !listHandler || !callHandler) {
    throw new Error('Impossibile applicare la policy sui tool: struttura interna SDK MCP non riconosciuta');
  }

  handlers.set('tools/list', async (req, extra) => {
    const result = await listHandler(req, extra);
    const tools = (result.tools || [])
      .filter((t: any) => toolAllowed(t.name, profile))
      .map((t: any) =>
        ANNOTATIONS_ENABLED ? { ...t, annotations: { ...annotationsFor(t.name), ...(t.annotations || {}) } } : t
      );
    return { ...result, tools };
  });

  handlers.set('tools/call', async (req, extra) => {
    const name: string = req?.params?.name;
    if (!toolAllowed(name, profile)) {
      logger.warn('Blocked tool call', { tool: name, profile });
      return {
        content: [{ type: 'text', text: `Tool "${name}" non consentito per questo connettore (profilo: ${profile}).` }],
        isError: true,
      };
    }
    return callHandler(req, extra);
  });
}

// ---------------------------------------------------------------------------
// Gestione sessioni MCP
// ---------------------------------------------------------------------------
async function createSession(
  config: ReturnType<typeof loadConfig>,
  profile: Profile
): Promise<StreamableHTTPServerTransport> {
  const server = new Server(
    { name: 'EspoCRM Integration Server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Registra i 47 tool di EspoMCP (esegue anche un test di connessione a EspoCRM)
  await setupEspoCRMTools(server, config);
  applyToolPolicy(server, profile);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: JSON_RESPONSE,
    onsessioninitialized: (sessionId: string) => {
      sessions.set(sessionId, { transport, server, profile, lastSeen: Date.now() });
      logger.info('MCP session initialized', { sessionId, profile, activeSessions: sessions.size });
    },
  });

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id && sessions.delete(id)) {
      logger.info('MCP session closed', { sessionId: id, activeSessions: sessions.size });
    }
  };

  await server.connect(transport);
  return transport;
}

async function closeSession(id: string, reason: string): Promise<void> {
  const entry = sessions.get(id);
  if (!entry) return;
  sessions.delete(id);
  logger.info('Closing MCP session', { sessionId: id, reason });
  try { await entry.transport.close(); } catch { /* ignore */ }
  try { await entry.server.close(); } catch { /* ignore */ }
}

/** Chiude la sessione usata meno di recente per fare spazio (il client riceverà 404 e reinizializzerà). */
async function evictLeastRecentlyUsed(): Promise<void> {
  let oldestId: string | null = null;
  let oldest = Infinity;
  for (const [id, entry] of sessions) {
    if (entry.lastSeen < oldest) {
      oldest = entry.lastSeen;
      oldestId = id;
    }
  }
  if (oldestId) await closeSession(oldestId, 'evicted (MCP_MAX_SESSIONS reached)');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const configErrors = validateConfiguration();
  if (configErrors.length > 0) {
    configErrors.forEach((e) => logger.error(`Configuration error: ${e}`));
    process.exit(1);
  }
  const config = loadConfig();

  if (!AUTH_TOKEN && !AUTH_TOKEN_READONLY) {
    logger.warn('MCP_AUTH_TOKEN non impostato: il server MCP è ACCESSIBILE SENZA AUTENTICAZIONE!');
  }
  if (AUTH_TOKEN && AUTH_TOKEN === AUTH_TOKEN_READONLY) {
    logger.error('MCP_AUTH_TOKEN e MCP_AUTH_TOKEN_READONLY devono essere diversi');
    process.exit(1);
  }

  // Test di connettività non bloccante all'avvio (utile nei log di Dockhand)
  if (!isSchemaOnlyMode) {
    try {
      const probe = new EspoCRMClient(config.espocrm, config.server.rateLimit);
      const r = await probe.testConnection();
      if (r.success) {
        logger.info('EspoCRM reachable', { url: config.espocrm.baseUrl, user: r.user?.userName });
      } else {
        logger.warn('EspoCRM NOT reachable at startup - check ESPOCRM_URL / ESPOCRM_API_KEY', {
          url: config.espocrm.baseUrl,
        });
      }
    } catch (e: any) {
      logger.warn('EspoCRM connectivity check failed', { error: e?.message });
    }
  }

  const httpServer = createServer(async (req, res) => {
    setCors(res);
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, { status: 'ok', sessions: sessions.size, uptime: Math.round(process.uptime()) });
        return;
      }

      // Routing: {MCP_PATH} oppure {MCP_PATH}/<token>
      let pathToken: string | null = null;
      if (pathname === MCP_PATH) {
        pathToken = null;
      } else if (pathname.startsWith(MCP_PATH + '/') && !pathname.slice(MCP_PATH.length + 1).includes('/')) {
        pathToken = decodeURIComponent(pathname.slice(MCP_PATH.length + 1));
      } else {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      const profile = authenticate(req, pathToken);
      if (!profile) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        jsonRpcError(res, 401, -32001, 'Unauthorized');
        return;
      }

      const sessionId = headerValue(req, 'mcp-session-id');
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      // Una sessione resta legata al profilo del token che l'ha creata
      if (existing && existing.profile !== profile) {
        jsonRpcError(res, 403, -32001, 'Session belongs to a different access profile');
        return;
      }

      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (e: any) {
          jsonRpcError(res, e.message === 'Payload too large' ? 413 : 400, -32700, e.message);
          return;
        }

        if (sessionId) {
          const entry = existing;
          if (!entry) {
            // Da spec: 404 => il client deve reinizializzare la sessione
            jsonRpcError(res, 404, -32001, 'Session not found');
            return;
          }
          entry.lastSeen = Date.now();
          await entry.transport.handleRequest(req, res, body);
          return;
        }

        if (isInitializeRequest(body)) {
          while (sessions.size >= MAX_SESSIONS) {
            await evictLeastRecentlyUsed();
          }
          let transport: StreamableHTTPServerTransport;
          try {
            transport = await createSession(config, profile);
          } catch (e: any) {
            logger.error('Failed to create MCP session', { error: e?.message });
            jsonRpcError(res, 502, -32603, `Cannot connect to EspoCRM: ${e?.message}`);
            return;
          }
          await transport.handleRequest(req, res, body);
          return;
        }

        jsonRpcError(res, 400, -32000, 'Bad Request: missing Mcp-Session-Id or not an initialize request');
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        const entry = existing;
        if (!entry) {
          jsonRpcError(res, sessionId ? 404 : 400, -32001, sessionId ? 'Session not found' : 'Missing Mcp-Session-Id');
          return;
        }
        entry.lastSeen = Date.now();
        await entry.transport.handleRequest(req, res);
        return;
      }

      res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
      jsonRpcError(res, 405, -32000, 'Method not allowed');
    } catch (e: any) {
      logger.error('Unhandled HTTP error', { error: e?.message, stack: e?.stack });
      jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  // Pulizia sessioni inattive
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeen > SESSION_TTL_MS) void closeSession(id, 'idle timeout');
    }
  }, 60_000);
  sweeper.unref();

  httpServer.listen(PORT, HOST, () => {
    logger.info('EspoCRM MCP server (Streamable HTTP) listening', {
      host: HOST,
      port: PORT,
      endpoint: MCP_PATH,
      auth: AUTH_TOKEN || AUTH_TOKEN_READONLY ? 'enabled' : 'DISABLED',
      readonlyToken: AUTH_TOKEN_READONLY ? 'enabled' : 'disabled',
      pathToken: (AUTH_TOKEN || AUTH_TOKEN_READONLY) && ALLOW_PATH_TOKEN ? 'enabled' : 'disabled',
      toolAnnotations: ANNOTATIONS_ENABLED,
      deniedTools: [...TOOLS_DENY],
      jsonResponse: JSON_RESPONSE,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    clearInterval(sweeper);
    await Promise.all([...sessions.keys()].map((id) => closeSession(id, 'shutdown')));
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason: any) => {
    logger.error('Unhandled rejection', { reason: reason?.message || String(reason) });
  });
}

main().catch((e: any) => {
  logger.error('Fatal error during startup', { error: e?.message, stack: e?.stack });
  process.exit(1);
});
