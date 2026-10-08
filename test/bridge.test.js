'use strict';

// Tests for server/bridge.js. Each one runs the real bridge as a child process and
// speaks MCP to it over stdio, with a stand-in for the Screeny app behind it.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BRIDGE = path.join(__dirname, '..', 'server', 'bridge.js');
const INSTRUCTIONS = 'One vocabulary everywhere.';
const TOOLS = [
  { name: 'list_devices', description: 'List devices.', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_mockup', description: 'Save PNGs.', inputSchema: { type: 'object', properties: {} } },
];

/// A stand-in for the app: Streamable HTTP with sessions, answering in server-sent
/// events the way the real one does.
class FakeScreeny {
  constructor({ name = 'Screeny', json = false } = {}) {
    this.name = name;
    this.json = json;
    this.sessions = new Set();
    this.seen = [];
    this.sockets = new Set();
    this.server = http.createServer((req, res) => this.serve(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  listen(port = 0) {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.url = `http://127.0.0.1:${this.port}/mcp`;
        resolve(this);
      });
    });
  }

  close() {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(resolve));
  }

  answer(res, messages, headers = {}) {
    if (this.json) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(messages[messages.length - 1]));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
    res.write('id: 1_1\r\ndata: \r\n\r\n');
    // Split mid-event, and mid line ending, the way a socket may.
    for (const message of messages) {
      const event = `id: x\r\nevent: message\r\ndata: ${JSON.stringify(message)}\r`;
      res.write(event.slice(0, 20));
      res.write(event.slice(20));
      res.write('\n\r\n');
    }
    res.end();
  }

  serve(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const session = req.headers['mcp-session-id'];
      if (req.method === 'DELETE') {
        this.sessions.delete(session);
        res.writeHead(200).end();
        return;
      }
      const message = JSON.parse(body);
      this.seen.push({ message, session });

      if (message.method === 'initialize') {
        const id = `session-${this.sessions.size + 1}-${Date.now()}`;
        this.sessions.add(id);
        this.answer(res, [{
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.name, version: '2.0.0' },
            instructions: INSTRUCTIONS,
          },
        }], { 'Mcp-Session-Id': id });
        return;
      }
      if (!this.sessions.has(session)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Not Found: Invalid or expired session ID' } }));
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (message.method === 'tools/list') {
        this.answer(res, [{ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } }]);
        return;
      }
      if (message.method === 'tools/call' && message.params.name === 'hang_up') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: \n\n');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (message.method === 'tools/call') {
        this.answer(res, [
          { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 't', progress: 1 } },
          { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `ran ${message.params.name} é✓` }] } },
        ]);
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } }));
    });
  }
}

/// The bridge, and the client's end of its stdio.
class Client {
  constructor(url) {
    this.child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, SCREENY_MCP_URL: url, SCREENY_MCP_RETRY_MS: '100' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.received = [];
    this.waiters = [];
    this.nextId = 1;
    let pending = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        this.received.push(JSON.parse(pending.slice(0, end)));
        pending = pending.slice(end + 1);
        this.waiters = this.waiters.filter((waiter) => !waiter());
      }
    });
  }

  write(message) {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  /// Resolves with the first received message `match` accepts, past or future.
  waitFor(match, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 4000);
      const check = () => {
        const found = this.received.find(match);
        if (!found) return false;
        clearTimeout(timer);
        resolve(found);
        return true;
      };
      if (!check()) this.waiters.push(check);
    });
  }

  call(method, params) {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    return this.waitFor((message) => message.id === id && message.method === undefined, `the answer to ${method}`);
  }

  async start() {
    const answer = await this.call('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return answer.result;
  }

  stop() {
    return new Promise((resolve) => {
      this.child.on('exit', resolve);
      this.child.stdin.end();
    });
  }
}

const names = (answer) => answer.result.tools.map((tool) => tool.name);
const freePort = async () => {
  const probe = await new FakeScreeny().listen();
  await probe.close();
  return probe.port;
};

test('with Screeny running, the handshake and the tools are Screeny\'s own', async () => {
  const app = await new FakeScreeny().listen();
  const client = new Client(app.url);
  try {
    const init = await client.start();
    assert.equal(init.serverInfo.name, 'Screeny');
    assert.equal(init.instructions, INSTRUCTIONS);
    assert.equal(init.capabilities.tools.listChanged, true);

    assert.deepEqual(names(await client.call('tools/list')), ['list_devices', 'create_mockup']);

    const result = await client.call('tools/call', { name: 'create_mockup', arguments: {} });
    assert.equal(result.result.content[0].text, 'ran create_mockup é✓');
    await client.waitFor((message) => message.method === 'notifications/progress', 'the progress notification');

    // One session, opened by the bridge and used for everything after it.
    const sessions = new Set(app.seen.filter((entry) => entry.message.method !== 'initialize').map((entry) => entry.session));
    assert.equal(sessions.size, 1);
    assert.ok(app.sessions.has([...sessions][0]));
    assert.equal(app.seen.filter((entry) => entry.message.method === 'notifications/initialized').length, 1);
    assert.equal(app.seen[0].message.params.clientInfo.name, 'test');
  } finally {
    await client.stop();
    assert.equal(app.sessions.size, 0, 'the bridge ends its session on the way out');
    await app.close();
  }
});

test('a plain JSON answer is relayed like a streamed one', async () => {
  const app = await new FakeScreeny({ json: true }).listen();
  const client = new Client(app.url);
  try {
    await client.start();
    assert.deepEqual(names(await client.call('tools/list')), ['list_devices', 'create_mockup']);
  } finally {
    await client.stop();
    await app.close();
  }
});

test('with Screeny closed, the bridge answers, then announces the tools when it opens', async () => {
  const port = await freePort();
  const client = new Client(`http://127.0.0.1:${port}/mcp`);
  let app;
  try {
    const init = await client.start();
    assert.equal(init.protocolVersion, '2025-06-18');
    assert.equal(init.capabilities.tools.listChanged, true);
    assert.match(init.instructions, /not running/);

    assert.deepEqual(names(await client.call('tools/list')), ['screeny_status']);
    const down = await client.call('tools/call', { name: 'screeny_status', arguments: {} });
    assert.equal(down.result.isError, true);
    const refused = await client.call('tools/call', { name: 'create_mockup', arguments: {} });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /MCP Server/);

    app = await new FakeScreeny().listen(port);
    await client.waitFor((message) => message.method === 'notifications/tools/list_changed', 'tools/list_changed');

    // The client never saw Screeny's instructions, so the status tool stays to give them.
    assert.deepEqual(names(await client.call('tools/list')), ['list_devices', 'create_mockup', 'screeny_status']);
    const up = await client.call('tools/call', { name: 'screeny_status', arguments: {} });
    assert.ok(!up.result.isError);
    assert.match(up.result.content[0].text, /One vocabulary everywhere/);
  } finally {
    await client.stop();
    if (app) await app.close();
  }
});

test('when Screeny is relaunched, the next call starts a new session and goes through', async () => {
  const app = await new FakeScreeny().listen();
  const client = new Client(app.url);
  try {
    await client.start();
    await client.call('tools/list');
    app.sessions.clear();

    const result = await client.call('tools/call', { name: 'list_devices', arguments: {} });
    assert.equal(result.result.content[0].text, 'ran list_devices é✓');
    assert.equal(app.seen.filter((entry) => entry.message.method === 'initialize').length, 2);
  } finally {
    await client.stop();
    await app.close();
  }
});

test('when Screeny quits, its tools stay listed and say why they fail', async () => {
  const app = await new FakeScreeny().listen();
  const client = new Client(app.url);
  try {
    await client.start();
    await client.call('tools/list');
    await app.close();

    const result = await client.call('tools/call', { name: 'create_mockup', arguments: {} });
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /open Screeny/);
    assert.deepEqual(names(await client.call('tools/list')), ['list_devices', 'create_mockup']);
  } finally {
    await client.stop();
  }
});

test('a response Screeny abandons half way still gets an answer', async () => {
  const app = await new FakeScreeny().listen();
  const client = new Client(app.url);
  try {
    await client.start();
    const result = await client.call('tools/call', { name: 'hang_up', arguments: {} });
    assert.equal(result.result.isError, true);
  } finally {
    await client.stop();
    await app.close();
  }
});

test('another app on the port is not mistaken for Screeny', async () => {
  const app = await new FakeScreeny({ name: 'Something Else' }).listen();
  const client = new Client(app.url);
  try {
    const init = await client.start();
    assert.match(init.instructions, /not running/);
    assert.deepEqual(names(await client.call('tools/list')), ['screeny_status']);
    assert.ok(!app.seen.some((entry) => entry.message.method === 'tools/list'));

    // Left to itself the bridge looks every 100 ms here, and stays off this port: only
    // the two requests above, which the client was waiting on, reached the other app.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(app.seen.length, 2);
    assert.ok(app.seen.every((entry) => entry.message.method === 'initialize'));
  } finally {
    await client.stop();
    await app.close();
  }
});

test('ping is answered without the app, and a broken line is reported', async () => {
  const port = await freePort();
  const client = new Client(`http://127.0.0.1:${port}/mcp`);
  try {
    await client.start();
    assert.deepEqual((await client.call('ping')).result, {});
    client.child.stdin.write('{not json\n');
    const error = await client.waitFor((message) => message.error && message.error.code === -32700, 'the parse error');
    assert.equal(error.id, null);
  } finally {
    await client.stop();
  }
});
