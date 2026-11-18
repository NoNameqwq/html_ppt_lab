import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const copy = async (from, to) => { await fs.mkdir(path.dirname(path.join(root, to)), { recursive: true }); await fs.copyFile(path.join(root, from), path.join(root, to)); };
for (const name of ['katex.mjs', 'katex.min.css']) await copy('node_modules/katex/dist/' + name, 'app/vendor/katex/' + name);
await fs.cp(path.join(root, 'node_modules/katex/dist/fonts'), path.join(root, 'app/vendor/katex/fonts'), { recursive: true });
await copy('node_modules/katex/LICENSE', 'app/vendor/katex/LICENSE');
await copy('node_modules/dompurify/dist/purify.es.mjs', 'app/vendor/dompurify.mjs');
await copy('node_modules/dompurify/LICENSE', 'app/vendor/DOMPurify-LICENSE');
await copy('node_modules/html2canvas-pro/dist/html2canvas-pro.esm.js', 'app/vendor/html2canvas-pro.mjs');
await copy('node_modules/html2canvas-pro/LICENSE', 'app/vendor/html2canvas-pro-LICENSE');
await fs.mkdir(path.join(root, 'app/vendor/three'), { recursive: true });
const threeLicense = await fs.readFile(path.join(root, 'node_modules/three/LICENSE'), 'utf8');
await build({
  stdin: { contents: "import * as THREE from 'three'; import { OrbitControls } from 'three/addons/controls/OrbitControls.js'; window.WDS_THREE={THREE,OrbitControls};", resolveDir: root, sourcefile: 'three-bundle-entry.js' },
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['chrome110','firefox115','safari17'],
  legalComments: 'inline', outfile: path.join(root, 'app/vendor/three/three-bundle.js'),
  banner: { js: '/*! Built-in Three.js and OrbitControls.\n' + threeLicense.replace(/\*\//g, '* /') + '\n*/' },
});
await copy('node_modules/three/LICENSE', 'app/vendor/three/LICENSE');
// Browser ESM modules cannot resolve bare npm imports. Share the same XML
// completeness validator between BAT and the static workbench.
await build({stdin:{contents:"export {XMLValidator,XMLParser} from 'fast-xml-parser';",resolveDir:root,sourcefile:'xml-parser-entry.js'},bundle:true,minify:true,format:'esm',platform:'browser',target:['chrome110','firefox115','safari17'],legalComments:'inline',outfile:path.join(root,'app/vendor/xml-parser.mjs')});
await copy('node_modules/fast-xml-parser/LICENSE', 'app/vendor/XMLParser-LICENSE');
