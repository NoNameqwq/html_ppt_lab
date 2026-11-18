import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const workspaceId = crypto.createHash('sha256').update([
  root, path.resolve(process.env.WDS_DATA_DIR || path.join(root, 'data')),
  path.resolve(process.env.WDS_PROJECTS_DIR || path.join(root, 'projects')),
].join('\0')).digest('hex').slice(0, 16);
const require = createRequire(import.meta.url);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function inspectPort(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(600) });
    const health = await response.json();
    if (health.app === 'webdeck-studio' && health.workspace === workspaceId && health.launcher === 1) return 'ours';
  } catch { /* An occupied port may host any application. */ }
  return new Promise((resolve) => {
    const socket = net.createServer();
    socket.once('error', () => resolve('occupied'));
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve('free')));
  });
}
export async function choosePort(first = 4321) {
  if (!Number.isInteger(first) || first < 1024 || first > 65535) throw new Error('端口应为 1024–65535 的整数');
  for (let port = first; port <= Math.min(first + 30, 65535); port++) {
    const state = await inspectPort(port);
    if (state !== 'occupied') return { port, reuse: state === 'ours' };
  }
  throw new Error('没有可用端口，请用 start.bat --port 其他端口 启动');
}
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('依赖安装失败，请检查网络后重试')));
  });
}
export async function ensureDependencies() {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  try { for (const name of Object.keys(pkg.dependencies || {})) require.resolve(name); }
  catch {
    console.log('首次启动：正在安装依赖…');
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (await fs.access(npmCli).then(() => true, () => false)) await run(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund']);
    else if (process.platform === 'win32') await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --no-audit --no-fund']);
    else await run('npm', ['ci', '--no-audit', '--no-fund']);
  }
  if (!await fs.access(path.join(root, 'app/vendor/katex/katex.min.css')).then(() => true, () => false)) await run(process.execPath, ['scripts/sync-vendor.mjs']);
}
function openBrowser(url) {
  const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log('请在浏览器打开：' + url)); child.unref();
}
export async function start(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('请安装 Node.js 20 或更新版本：https://nodejs.org/');
  await ensureDependencies();
  const index = args.indexOf('--port');
  const first = Number(index >= 0 ? args[index + 1] : process.env.PORT || 4321);
  const { port, reuse } = await choosePort(first), url = `http://127.0.0.1:${port}/#/`;
  const shouldOpen = !args.includes('--no-open') && process.env.WDS_NO_OPEN !== '1';
  if (reuse) { console.log('服务已在运行：' + url); if (shouldOpen) openBrowser(url); return { port, url, reuse: true }; }
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'inherit', windowsHide: true });
  let exited = false; child.once('exit', (code) => { exited = true; process.exitCode = code || 0; });
  child.once('error', (e) => { exited = true; console.error(e.message); process.exitCode = 1; });
  process.on('SIGINT', () => child.kill()); process.on('SIGTERM', () => child.kill());
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error('服务未能启动，请查看上方错误');
    if (await inspectPort(port) === 'ours') {
      console.log(`\n启动成功：${url}\n保持此窗口开启。按 Ctrl+C 停止。\n`);
      if (shouldOpen) openBrowser(url); return { port, url, reuse: false, child };
    }
    await wait(150);
  }
  child.kill(); throw new Error('等待服务启动超时');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start().catch((e) => { console.error('\n启动失败：' + e.message); process.exitCode = 1; });
