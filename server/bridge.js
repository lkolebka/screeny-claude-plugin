#!/usr/bin/env node
'use strict';

// Screeny MCP bridge.
//
// Screeny (the Mac app) serves MCP over plain HTTP on 127.0.0.1. Claude Desktop and
// Cowork start a local MCP server as a command and talk to it over stdio. This file is
// the piece in between: it reads JSON-RPC from stdin, posts it to the app, and writes
// what comes back to stdout. It has no dependencies and talks to nothing but 127.0.0.1.
//
// The app is often closed when the client starts, so the bridge outlives it: it answers
// the handshake itself when Screeny isn't there, keeps looking for it, and tells the
// client to list the tools again once it appears.

const http = require('node:http');

const BRIDGE_VERSION = '1.0.0';

// Screeny binds the first free port from 9410 (9:41, the time on every Apple status bar).
const FIRST_PORT = 9410;
const PORT_COUNT = 10;
const HANDSHAKE_TIMEOUT_MS = 3000;
// How often to look for Screeny while it is closed (the tests shorten it), and how long
// to stay away from a port that some other app answered on.
const RETRY_MS = Number(process.env.SCREENY_MCP_RETRY_MS) || 5000;
const STRANGER_MS = 60000;

const KNOWN_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const OFFLINE =
  "Screeny isn't reachable. Screeny is a Mac app (https://getscreeny.app) and its tools " +
  'work only while it is open with Settings → Automation → MCP Server turned on. Ask the ' +
  'user to open Screeny and check that toggle, then try again.';

const OFFLINE_INSTRUCTIONS =
  "Screeny turns screenshots and screen recordings into device mockups. Its tools aren't " +
  'listed yet because the Screeny Mac app is not running, or its MCP server is off ' +
  '(Settings → Automation → MCP Server). They appear on their own once it is. Call ' +
  'screeny_status to check the connection and to read how to use Screeny.';

const STATUS_TOOL = {
  name: 'screeny_status',
  title: 'Check Screeny Connection',
  description:
    "Check whether the Screeny Mac app is reachable. Screeny's own tools are available " +
    'only while the app is open with Settings → Automation → MCP Server turned on. Call ' +
    "this when they are missing or failing: it reconnects if it can, says what the user " +
    "has to do if it can't, and returns Screeny's notes on how to use its tools.",
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'Check Screeny Connection', readOnlyHint: true, openWorldHint: false },
};

// The app the bridge is connected to: { url, sessionId, protocolVersion, info }.
let upstream = null;
let connecting = null;
// Addresses that answered and weren't Screeny, with the time each may be tried again.
const strangers = new Map();
let retryTimer = null;
let handshakeCount = 0;

// What the client said in its own handshake, replayed to Screeny whenever it (re)appears.
let clientInit = null;
let clientReady = false;
// False when the client's handshake was answered by the bridge alone, so it never saw
// Screeny's instructions. screeny_status stays listed then, as the way to read them.
let clientHasInstructions = false;
let knownTools = [];

function log(text) {
  process.stderr.write(`[screeny-bridge] ${text}\n`);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(text, isError) {
  const result = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

// MARK: - HTTP

function candidates() {
  if (process.env.SCREENY_MCP_URL) return [process.env.SCREENY_MCP_URL];
  return Array.from({ length: PORT_COUNT }, (_, i) => `http://127.0.0.1:${FIRST_PORT + i}/mcp`);
}

function sseData(event) {
  const lines = [];
  for (const line of event.split('\n')) {
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
  }
  return lines.join('\n');
}

/// One request to the app. Resolves when the response has ended, with its status; every
/// JSON-RPC message in a 2xx body (JSON, or a stream of server-sent events) goes to
/// `onMessage` as it arrives. Rejects when the app can't be reached or hangs up early.
function request(method, url, headers, body, onMessage, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method,
      // One connection per request: the app's server doesn't pipeline, and a reused
      // socket it has already closed would read as Screeny having quit.
      agent: false,
      headers: {
        Accept: 'application/json, text/event-stream',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.on('response', (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      const isStream = /text\/event-stream/i.test(res.headers['content-type'] || '');
      let buffer = '';

      const deliver = (text) => {
        if (!text.trim()) return;
        try {
          const parsed = JSON.parse(text);
          for (const message of Array.isArray(parsed) ? parsed : [parsed]) onMessage(message);
        } catch (error) {
          log(`unreadable message from Screeny: ${error.message}`);
        }
      };

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        if (!ok || !isStream) return;
        // A lone trailing \r may be half of a \r\n: leave it for the next chunk.
        const held = buffer.endsWith('\r') ? '\r' : '';
        buffer = buffer.slice(0, buffer.length - held.length).replace(/\r\n?/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          deliver(sseData(buffer.slice(0, end)));
          buffer = buffer.slice(end + 2);
        }
        buffer += held;
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('connection closed early')));
      res.on('end', () => {
        if (ok && isStream) deliver(sseData(buffer.replace(/\r\n?/g, '\n')));
        else if (ok) deliver(buffer);
        resolve({ status: res.statusCode, headers: res.headers, text: ok ? '' : buffer });
      });
    });
    req.end(payload || undefined);
  });
}

function sessionHeaders(target) {
  const headers = { 'MCP-Protocol-Version': target.protocolVersion };
  if (target.sessionId) headers['Mcp-Session-Id'] = target.sessionId;
  return headers;
}

function errorText(response) {
  try {
    const message = JSON.parse(response.text).error.message;
    if (message) return message;
  } catch (_) {
    // Not a JSON-RPC error body: the status is all there is to report.
  }
  return `Screeny answered HTTP ${response.status}.`;
}

// MARK: - Finding Screeny

/// The MCP handshake with whatever answers at `url`. Null unless it is Screeny — the
/// port range is not reserved, so another app can be the one listening.
async function handshake(url) {
  const id = `screeny-bridge-${++handshakeCount}`;
  const params = clientInit || {
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'screeny-bridge', version: BRIDGE_VERSION },
  };
  let result = null;
  const response = await request(
    'POST', url, {}, { jsonrpc: '2.0', id, method: 'initialize', params },
    (message) => { if (message.id === id && message.result) result = message.result; },
    HANDSHAKE_TIMEOUT_MS
  );
  const name = result && result.serverInfo && result.serverInfo.name;
  if (!/screeny/i.test(name || '')) return null;

  const found = {
    url,
    sessionId: response.headers['mcp-session-id'] || null,
    protocolVersion: result.protocolVersion || params.protocolVersion,
    info: result,
  };
  await request(
    'POST', url, sessionHeaders(found), { jsonrpc: '2.0', method: 'notifications/initialized' },
    () => {}, HANDSHAKE_TIMEOUT_MS
  );
  return found;
}

async function discover(isAsked) {
  for (const url of candidates()) {
    // Something else lives on this port. Leave it in peace for a while, unless the
    // user is waiting on the answer.
    if (!isAsked && strangers.get(url) > Date.now()) continue;
    let found = null;
    let isStranger = true;
    try {
      found = await handshake(url);
    } catch (error) {
      isStranger = error.code !== 'ECONNREFUSED';
    }
    if (!found) {
      if (isStranger) strangers.set(url, Date.now() + STRANGER_MS);
      continue;
    }
    strangers.delete(url);
    upstream = found;
    stopRetrying();
    log(`connected to Screeny ${found.info.serverInfo.version || ''} at ${url}`);
    // Anything but the client's own handshake: its tool list is out of date now.
    if (clientReady) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    return found;
  }
  startRetrying();
  return null;
}

/// `isAsked` when the client is waiting on the answer, as against the bridge looking on
/// its own while Screeny is closed.
function connect(isAsked) {
  if (upstream) return Promise.resolve(upstream);
  if (!connecting) connecting = discover(isAsked).finally(() => { connecting = null; });
  return connecting;
}

function startRetrying() {
  if (retryTimer || !clientInit) return;
  retryTimer = setInterval(() => { connect(false).catch(() => {}); }, RETRY_MS);
}

function stopRetrying() {
  clearInterval(retryTimer);
  retryTimer = null;
}

function lose(target, reason) {
  if (upstream !== target) return;
  upstream = null;
  log(`lost Screeny: ${reason}`);
  startRetrying();
}

// MARK: - Answering the client

function listedTools() {
  const needsStatus = !clientHasInstructions || knownTools.length === 0;
  return needsStatus ? [...knownTools, STATUS_TOOL] : knownTools;
}

function answerOffline(message) {
  if (message.method === 'tools/list') reply(message.id, { tools: listedTools() });
  else if (message.method === 'tools/call') reply(message.id, textResult(OFFLINE, true));
  else fail(message.id, -32000, OFFLINE);
}

async function initialize(message) {
  clientInit = message.params || {};
  const found = await connect(true);
  if (found) {
    const capabilities = found.info.capabilities || {};
    clientHasInstructions = true;
    reply(message.id, {
      ...found.info,
      capabilities: { ...capabilities, tools: { ...capabilities.tools, listChanged: true } },
    });
    return;
  }
  const asked = clientInit.protocolVersion;
  reply(message.id, {
    protocolVersion: KNOWN_PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'Screeny', version: BRIDGE_VERSION },
    instructions: OFFLINE_INSTRUCTIONS,
  });
}

async function status(message) {
  const found = await connect(true);
  if (!found) {
    reply(message.id, textResult(OFFLINE, true));
    return;
  }
  const version = found.info.serverInfo.version;
  let text = `Screeny${version ? ' ' + version : ''} is connected. Its tools are available.`;
  if (found.info.instructions) text += `\n\nHow to use Screeny:\n\n${found.info.instructions}`;
  reply(message.id, textResult(text, false));
}

/// Posts one of the client's messages to Screeny and relays everything that comes back —
/// the result, and any progress notification or request the app sends ahead of it.
async function forward(message, isRetry) {
  const target = upstream;
  const isRequest = message.id !== undefined && message.id !== null && typeof message.method === 'string';
  let answered = false;

  const relay = (incoming) => {
    const isAnswer = isRequest && incoming.id === message.id && incoming.method === undefined;
    if (isAnswer) {
      answered = true;
      if (message.method === 'tools/list' && incoming.result && Array.isArray(incoming.result.tools)) {
        knownTools = incoming.result.tools;
        incoming = { ...incoming, result: { ...incoming.result, tools: listedTools() } };
      }
    }
    send(incoming);
  };

  let response;
  try {
    response = await request('POST', target.url, sessionHeaders(target), message, relay);
  } catch (error) {
    lose(target, error.message);
    if (isRequest && !answered) answerOffline(message);
    return;
  }

  // The session is one Screeny no longer knows: the app was relaunched. Start a new one
  // and ask again, once.
  if (response.status === 404 && !isRetry) {
    lose(target, 'the session expired');
    if (await connect(true)) return forward(message, true);
    if (isRequest) answerOffline(message);
    return;
  }
  if (isRequest && !answered) {
    const ok = response.status >= 200 && response.status < 300;
    fail(message.id, -32603, ok ? 'Screeny closed the response without a result.' : errorText(response));
  }
}

async function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method } = message;
  const isRequest = id !== undefined && id !== null && typeof method === 'string';

  if (isRequest && method === 'initialize') return initialize(message);
  if (method === 'notifications/initialized') {
    // Not forwarded: the bridge does its own handshake with the app.
    clientReady = true;
    return;
  }
  if (isRequest && method === 'ping') return reply(id, {});
  if (isRequest && method === 'tools/call' && message.params && message.params.name === STATUS_TOOL.name) {
    return status(message);
  }

  // A notification or a response has no one to report a missing app to; a request is
  // worth one more look for it.
  if (!upstream && isRequest) await connect(true);
  if (upstream) return forward(message, false);
  if (isRequest) answerOffline(message);
}

// MARK: - stdio

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, end).trim();
    pending = pending.slice(end + 1);
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      fail(null, -32700, 'Parse error');
      continue;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      handle(message).catch((error) => {
        log(`${message && message.method}: ${error.stack || error}`);
        if (message && message.id !== undefined && message.id !== null && message.method) {
          fail(message.id, -32603, String(error.message || error));
        }
      });
    }
  }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  stopRetrying();
  const target = upstream;
  if (target && target.sessionId) {
    await request('DELETE', target.url, sessionHeaders(target), undefined, () => {}, 1000).catch(() => {});
  }
  process.exit(0);
}

process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
