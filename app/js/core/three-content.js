// Serializable 3D source. The runtime rebuilds GPU resources from this data;
// canvas pixels and interaction state are deliberately not project source.
import { escapeHtml } from './dom.js';

export const THREE_GEOMETRIES = ['box','sphere','cylinder','cone','torus','torusKnot','plane','circle','ring','icosahedron','octahedron','tetrahedron','dodecahedron','capsule','lathe','tube','polyline'];
export const THREE_NODE_TYPES = ['mesh','group','line','points','arrow','axes','grid'];

const vec = (value, name) => {
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error(`${name} 需要三个有限数字`);
};
export function normalizeThreeScene(scene = {}) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error('3D scene 必须是对象');
  let text;
  try { text = JSON.stringify(scene, (key, value) => {
    if ((typeof value === 'number' && !Number.isFinite(value)) || ['function','symbol','bigint'].includes(typeof value)) throw new Error('invalid JSON value');
    return value;
  }); } catch { throw new Error('3D 场景必须可序列化，且只能包含有限数字'); }
  if (text.length > 750000) throw new Error('3D 场景超过 750000 字符，请拆分结构');
  const out = JSON.parse(text);
  if (out.camera) {
    for (const key of ['position','target']) if (out.camera[key] !== undefined) vec(out.camera[key], `camera.${key}`);
    if (out.camera.fov !== undefined && (!(out.camera.fov > 0) || out.camera.fov >= 180)) throw new Error('camera.fov 必须位于 0–180 度之间');
  }
  if (out.objects !== undefined && !Array.isArray(out.objects)) throw new Error('scene.objects 必须是数组');
  if (out.lights !== undefined && !Array.isArray(out.lights)) throw new Error('scene.lights 必须是数组');
  let count = 0;
  const visit = (node, depth = 0) => {
    if (++count > 2000 || depth > 32) throw new Error('3D 场景结构过大或嵌套超过 32 层');
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('3D 对象必须是对象');
    if (!THREE_NODE_TYPES.includes(node.type || 'mesh')) throw new Error(`未知 3D 节点类型：${node.type}`);
    for (const key of ['position','rotation']) if (node[key] !== undefined) vec(node[key], key);
    if (node.scale !== undefined && typeof node.scale !== 'number') vec(node.scale, 'scale');
    if (node.geometry) {
      if (!THREE_GEOMETRIES.includes(node.geometry.type || 'box')) throw new Error(`未知 3D 几何体：${node.geometry.type}`);
      if (node.geometry.args && (!Array.isArray(node.geometry.args) || node.geometry.args.some(n => typeof n !== 'number' || !Number.isFinite(n)))) throw new Error('geometry.args 需要有限数字数组');
      if (node.geometry.points) {
        if (!Array.isArray(node.geometry.points) || node.geometry.points.length > 10000) throw new Error('geometry.points 最多 10000 个坐标');
        node.geometry.points.forEach(p => vec(p, 'geometry.points'));
      }
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new Error('children 必须是数组');
      node.children.forEach(child => visit(child, depth + 1));
    }
  };
  (out.objects || []).forEach(node => visit(node));
  return out;
}

export function threeMarkup({ scene = {}, code = '', label = '交互式 3D 结构' } = {}) {
  if (typeof code !== 'string' || code.length > 250000) throw new Error('3D 自定义代码必须是字符串且不超过 250000 字符');
  const data = { version: 1, scene: normalizeThreeScene(scene), code, label: String(label).slice(0, 500) };
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<div data-wds-three role="group" aria-label="${escapeHtml(data.label)}" style="position:relative;width:100%;height:100%;overflow:hidden"><script type="application/json" data-wds-three-scene>${json}</script></div>`;
}
