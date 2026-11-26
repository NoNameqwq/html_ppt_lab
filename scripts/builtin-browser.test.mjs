import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBuiltinBrowser } from '../server/builtin-browser.mjs';
import { browserURL, startBrowserProxy } from '../server/browser-network.mjs';

test('Browser outbound policy applies both to navigation and to proxy requests', async t => {
  assert.equal(browserURL('https://example.com:443/path').href, 'https://example.com/path');
  for (const url of [
    'file:///project.html', 'http://localhost', 'https://127.1', 'http://0x7f000001',
    'http://[::ffff:192.168.1.2]', 'http://[::1]', 'http://169.254.169.254',
    'https://site.local', 'https://user:pass@example.com', 'https://example.com:1234',
  ]) assert.throws(() => browserURL(url), { status: 400 });
  const proxy = await startBrowserProxy();
  t.after(() => proxy.close());
  const request = (method, path) => new Promise((resolve, reject) => {
    const req = http.request(proxy.url, { method, path }, res => { res.resume(); resolve(res.statusCode); });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await request('GET', 'http://127.0.0.1/'), 403);
  assert.equal(await request('CONNECT', '192.168.1.2:443'), 403);
  assert.equal(await request('CONNECT', '127.0.0.1:8443'), 403);
});

test('Built-in Chromium reads, interacts with and captures a page in an isolated chat', async t => {
  const fixture = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (new URL(req.url).pathname === '/next') {
      res.end('<title>Next page</title><main>Next source</main>');
      return;
    }
    res.end(`<title>Research fixture</title><main>
      <button onclick="document.querySelector('p').textContent='Expanded content'">Expand</button>
      <a href="/next">Next</a><p>Initial content</p><div style="height: 2400px"></div>
    </main>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const browser = createBuiltinBrowser({ startProxy: async () => ({
    url: 'http://127.0.0.1:' + fixture.address().port, close() {},
  }) });
  t.after(async () => {
    await browser.close();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  });
  const operate = args => browser.operate('first', args);
  let page;
  try { page = await operate({ action: 'open', url: 'http://research.example/' }); }
  catch (error) {
    if (error.status === 503) { t.skip(error.message); return; }
    throw error;
  }
  assert.equal(page.title, 'Research fixture');
  assert.match(page.text, /Initial content/);
  assert.deepEqual(await browser.operate('other', { action: 'inspect' }), { ok: true, open: false });
  const expand = page.targets.find(target => target.label === 'Expand').index;
  const expanded = await operate({ action: 'click', snapshot: page.snapshot, index: expand });
  assert.match(expanded.text, /Expanded content/);
  await assert.rejects(operate({ action: 'click', snapshot: page.snapshot, index: expand }), { status: 409 });
  const next = expanded.targets.find(target => target.label === 'Next').index;
  assert.equal((await operate({ action: 'click', snapshot: expanded.snapshot, index: next })).title, 'Next page');
  assert.equal((await operate({ action: 'back' })).title, 'Research fixture');
  assert((await operate({ action: 'scroll', pixels: 500 })).scrollY > 0);
  const shot = await operate({ action: 'screenshot' });
  assert.match(shot.images[0], /^data:image\/jpeg;base64,\/9j\//);
  await operate({ action: 'close' });
  assert.equal((await operate({ action: 'inspect' })).open, false);
});

test('Explicit loopback browsing renders one local origin and blocks redirects to another port', async t => {
  let otherRequests = 0, proxied = false;
  const other = http.createServer((_req, res) => {
    otherRequests++;
    res.end('<title>Other local app</title><main>Other port</main>');
  });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  const otherURL = 'http://127.0.0.1:' + other.address().port + '/';
  const fixture = http.createServer((req, res) => {
    proxied ||= req.headers['x-wds-browser-proxy'] === 'loopback';
    if (req.url === '/redirect') { res.writeHead(302, { Location: otherURL }).end(); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/details') { res.end('<title>Local details</title><main>Details</main>'); return; }
    res.end('<title>Local app</title><main><a href="/details">Details</a><p>Local service</p></main>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + fixture.address().port;
  const browser = createBuiltinBrowser();
  t.after(async () => {
    await browser.close();
    await Promise.all([fixture, other].map(server => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    }));
  });
  const operate = args => browser.operate('local', args);
  let page;
  try { page = await operate({ action: 'open', url: root, preview: true }); }
  catch (error) {
    if (error.status === 503) { t.skip(error.message); return; }
    throw error;
  }
  assert.equal(page.title, 'Local app');
  assert.match(page.text, /Local service/);
  assert.match(page.images[0], /^data:image\/jpeg;base64,/);
  assert(proxied, 'Loopback navigation must pass through the restricted proxy');
  const details = await operate({ action: 'click', index: page.targets[0].index, snapshot: page.snapshot });
  assert.equal(details.title, 'Local details');
  await assert.rejects(operate({ action: 'open', url: root + '/redirect' }));
  assert.equal(otherRequests, 0);
  assert.equal((await operate({ action: 'open', url: otherURL })).title, 'Other local app');
  assert(otherRequests > 0);
});
