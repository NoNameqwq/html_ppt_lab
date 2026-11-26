import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';

const specialV4 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) specialV4.addSubnet(network, prefix);
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new net.BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  specialV6.addSubnet(network, prefix, 'ipv6');
}

const publicIP = ip => net.isIPv4(ip) ? !specialV4.check(ip)
  : net.isIPv6(ip) && globalV6.check(ip, 'ipv6') && !specialV6.check(ip, 'ipv6');
export const BROWSER_PROXY_HEADER = 'x-wds-browser-proxy';
const loopback = '127.0.0.1';
const denied = () => Object.assign(new Error('请直接输入公开 HTTP(S) 网址或 127.0.0.1 的本地网址。'), { status: 400 });
const hostnameOf = url => url.hostname.replace(/^\[|\]$/g, '');

export function browserURL(value, { localOrigin = '', allowLoopback = false } = {}) {
  if (typeof value !== 'string' || value.length > 4096) throw denied();
  let url;
  try { url = new URL(value); } catch { throw denied(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw denied();
  if (localOrigin) {
    if (url.hostname === loopback && url.origin === localOrigin) return url;
    throw Object.assign(new Error('此本地浏览页只能访问当前打开的地址和端口。请在地址栏直接打开其他地址。'), { status: 400 });
  }
  if (allowLoopback && url.hostname === loopback) return url;
  if (url.port) throw denied();
  const hostname = hostnameOf(url).replace(/\.$/, '').toLowerCase();
  if (net.isIP(hostname) ? !publicIP(hostname) :
      !hostname.includes('.') || /\.(?:localhost|local|internal|home\.arpa|onion)$/.test(hostname)) throw denied();
  return url;
}

async function resolvePublic(hostname) {
  if (net.isIP(hostname)) return hostname;
  const records = await lookup(hostname, { all: true });
  if (!records.length || records.some(({ address }) => !publicIP(address))) throw denied();
  return records.find(({ family }) => family === 4)?.address || records[0].address;
}

// Chromium uses this proxy for top-level requests, redirects and subresources.
// Dial the validated IP directly so a second DNS lookup cannot change the target.
export async function startBrowserProxy({ localOrigin = '', resolveHost = resolvePublic } = {}) {
  const validate = value => browserURL(value, { localOrigin });
  const addressOf = url => localOrigin ? loopback : resolveHost(hostnameOf(url));
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  const proxy = http.createServer(async (req, res) => {
    try {
      const url = validate(req.url);
      if (url.protocol !== 'http:') throw denied();
      const address = await addressOf(url);
      if (res.destroyed) return;
      const headers = { ...req.headers, host: url.host };
      for (const key of ['proxy-authorization', 'proxy-connection', 'connection', 'upgrade']) delete headers[key];
      if (localOrigin) headers[BROWSER_PROXY_HEADER] = 'loopback';
      const upstream = http.request({ hostname: address, port: Number(url.port || 80), path: url.pathname + url.search, method: req.method, headers }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.on('error', error => res.destroy(error));
        response.pipe(res);
      });
      upstream.setTimeout(20000, () => upstream.destroy());
      upstream.on('error', () => {
        if (res.headersSent) res.destroy();
        else res.writeHead(502, { [BROWSER_PROXY_HEADER]: 'unavailable' }).end();
      });
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(403, { [BROWSER_PROXY_HEADER]: 'blocked' }).end();
    }
  });
  proxy.on('connection', track);
  proxy.on('connect', async (req, client, head) => {
    client.on('error', () => client.destroy());
    client.setTimeout(30000, () => client.destroy());
    try {
      if (!/^(?:\[[a-f0-9:]+\]|[a-z\d.-]+):\d{1,5}$/i.test(req.url)) throw denied();
      const scheme = localOrigin && localOrigin.startsWith('http:') ? 'http:' : 'https:';
      const url = validate(scheme + '//' + req.url);
      const port = Number(url.port || (scheme === 'http:' ? 80 : 443));
      const address = await addressOf(url);
      if (client.destroyed) return;
      const upstream = track(net.connect(port, address));
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    } catch { if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + proxy.address().port,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => proxy.close(resolve));
    },
  };
}
