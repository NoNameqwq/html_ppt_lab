/**
 * 把 hanzi-writer-data 的逐字 JSON 打包成单个紧凑文件，供 /api/hanzi 按需返回。
 *
 * 输出格式（全部是一维数字/字符串数组，便于 gzip 与增量解码）：
 *   { v, count, chars, strokes, medians, radicals }
 *   chars    : '好永…'                  —— 与下面三个数组按字符顺序一一对应
 *   strokes  : [n, d1 … dn, n, d1 …]    —— 每字的笔画路径数量 + 路径
 *   medians  : [n, [len, x, y, …] … ]   —— 每字的中线笔迹，按上一条解析
 *   radicals : [n, i1 … in, n, …]       —— 每字哪些笔画属于部首
 * 路径坐标位于 1024×1024 汉字网格、y 轴向上，渲染时需 translate(0,900) scale(1,-1)。
 *
 * 用法：node scripts/pack-hanzi.mjs [--all]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(root, 'node_modules/hanzi-writer-data');
const OUT = path.join(root, 'app/vendor/hanzi');

/** GB2312 一级字表（3755 常用字）。 */
function commonChars() {
  const decoder = new TextDecoder('gbk');
  const out = [];
  for (let hi = 0xb0; hi <= 0xd7; hi++) {
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      try {
        const ch = decoder.decode(new Uint8Array([hi, lo]));
        if (ch.length === 1 && ch.trim()) out.push(ch);
      } catch { /* ignore */ }
    }
  }
  return out;
}

async function loadAll() {
  const files = (await fs.readdir(SRC)).filter((f) => f.endsWith('.json'));
  const map = new Map();
  for (const file of files) {
    const char = file.slice(0, -5);
    if (char.length !== 1) continue; // package.json 等
    let data;
    try {
      data = JSON.parse(await fs.readFile(path.join(SRC, file), 'utf8'));
    } catch { continue; }
    if (!Array.isArray(data?.strokes) || !data.strokes.length) continue;
    map.set(char, {
      strokes: data.strokes.map(String),
      medians: (data.medians || []).map((line) => line.map((point) => [Math.round(point[0]), Math.round(point[1])])),
      radStrokes: Array.isArray(data.radStrokes) ? data.radStrokes : [],
    });
  }
  return map;
}

function pack(chars, map) {
  const kept = chars.filter((ch) => map.has(ch));
  const strokes = [], medians = [], radicals = [];
  for (const ch of kept) {
    const item = map.get(ch);
    strokes.push(item.strokes.length, ...item.strokes);
    medians.push(item.medians.length);
    for (const line of item.medians) medians.push(line.length, ...line.flat());
    radicals.push(item.radStrokes.length, ...item.radStrokes);
  }
  return { v: 2, count: kept.length, chars: kept.join(''), strokes, medians, radicals };
}

async function write(name, payload) {
  const json = JSON.stringify(payload);
  await fs.writeFile(path.join(OUT, name), json);
  const gz = zlib.gzipSync(Buffer.from(json), { level: 9 });
  console.log(name.padEnd(24), `${payload.count}`.padStart(6), 'chars', (json.length / 1e6).toFixed(1).padStart(6) + 'MB raw', (gz.length / 1e6).toFixed(2).padStart(6) + 'MB gzip');
}

const map = await loadAll();
console.log('源字符数', map.size);
await fs.mkdir(OUT, { recursive: true });
const common = commonChars().filter((c) => map.has(c));
await write('strokes-common.json', pack(common, map));
await write('strokes-full.json', pack([...map.keys()], map));
await fs.copyFile(path.join(SRC, 'ARPHICPL.TXT'), path.join(OUT, 'ARPHICPL.TXT'));
await fs.writeFile(path.join(OUT, 'SOURCE.txt'), [
  'Stroke data from hanzi-writer-data (https://github.com/chanind/hanzi-writer-data),',
  'derived from Make Me a Hanzi (https://github.com/skishore/makemeahanzi) by Shaunak Kishore.',
  'Licensed under the Arphic Public License — see ARPHICPL.TXT.',
  '',
  'strokes-common.json: GB2312 level-1 (3755 common simplified characters)',
  'strokes-full.json:   all available characters',
  '',
  'Paths are in a 1024x1024 grid with y pointing up; render with translate(0,900) scale(1,-1).',
  'Regenerate with: node scripts/pack-hanzi.mjs',
].join('\n'));
