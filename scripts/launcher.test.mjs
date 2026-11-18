import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data = path.join(root, 'output', 'launcher qa ' + Date.now());
process.env.WDS_DATA_DIR = path.join(data, 'settings');
process.env.WDS_PROJECTS_DIR = path.join(data, 'projects');
const { choosePort, inspectPort, start, workspaceId } = await import('./start.mjs');
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server.address().port;
}
test('reject invalid ports before starting a server', async () => {
  await assert.rejects(choosePort(80));
  await assert.rejects(choosePort(NaN));
});
test('skip occupied ports without terminating another application', async () => {
  const server = http.createServer((req, res) => res.end('another application'));
  const port = await listen(server);
  try {
    assert.equal(await inspectPort(port), 'occupied');
    assert.notEqual((await choosePort(port)).port, port);
    assert(server.listening);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
test('recognize only a matching workspace and data directories', async () => {
  let workspace = workspaceId;
  const server = http.createServer((req, res) => res.end(JSON.stringify({ app: 'webdeck-studio', launcher: 1, workspace })));
  const port = await listen(server);
  try {
    assert.deepEqual(await choosePort(port), { port, reuse: true });
    workspace = 'another-data-directory';
    assert.equal(await inspectPort(port), 'occupied');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
test('start a real isolated backend, then reuse it on a second launch', async () => {
  const socket = net.createServer(), port = await listen(socket);
  await new Promise(r => socket.close(r));
  let running;
  try {
    running = await start(['--no-open', '--port', String(port)]);
    assert.equal(running.reuse, false);
    assert.equal((await (await fetch(running.url.replace('/#/', '/api/health'))).json()).workspace, workspaceId);
    assert.equal((await start(['--no-open', '--port', String(port)])).reuse, true);
    if (process.platform === 'win32') {
      const batch = await promisify(execFile)(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start.bat --no-open --port ' + port], { cwd: root, env: process.env, windowsHide: true, timeout: 15000 });
      assert(batch.stdout.includes('服务已在运行'));
    }
    assert(await fs.stat(process.env.WDS_DATA_DIR));
  } finally {
    if (running?.child) { const closed = once(running.child, 'exit'); running.child.kill(); await closed; }
  }
});
