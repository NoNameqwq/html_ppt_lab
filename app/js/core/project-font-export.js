import * as css from 'css-tree';
import { PROJECT_FONTS, projectFontsIn } from './project-fonts.js';

const normal = 400;
const inherited = new Set(['inherit', 'unset']);
const boldElements = new Set(['b', 'strong', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const styleBlocks = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b([^>]*)>([\s\S]*?)<\/style>/gi;

export function splitProjectFontStyles(html) {
  const embedded = new Map();
  html = html.replace(styleBlocks, (block, attrs, code) => {
    const mode = attrs && /\bdata-wds-project-fonts=["'](live|embedded)["']/i.exec(attrs)?.[1];
    if (!mode) return block;
    if (mode === 'embedded') {
      for (const rule of code.matchAll(/@font-face\s*\{([^{}]+)\}/gi)) {
        const family = projectFontsIn(rule[1])[0];
        const weight = /(?:^|;)\s*font-weight\s*:\s*(\d+)\s*(?:;|$)/i.exec(rule[1])?.[1];
        if (family && weight && /url\(["']?data:font\//i.test(rule[1])) embedded.set(family.family + ':' + weight, rule[0]);
      }
    }
    return '<style></style>';
  });
  return { html, embedded };
}

function declarations(block) {
  const values = {};
  function set(property, value, important) {
    if (!values[property]?.important || important) values[property] = { value, important };
  }
  for (const decl of block.children) {
    if (decl.type !== 'Declaration') continue;
    const name = decl.property.toLowerCase();
    if (name !== 'font' && !['font-weight', 'font-family', 'all'].includes(name)) continue;
    const value = css.generate(decl.value);
    if (name === 'font') {
      const match = css.lexer.matchProperty(name, decl.value);
      const weight = decl.value.children && [...decl.value.children].find(part => match.getTrace(part)?.some(entry => entry.name === 'font-weight'));
      set('font-family', value, decl.important);
      set('font-weight', match.matched ? (weight ? css.generate(weight) : 'normal') : value, decl.important);
    } else if (name === 'all') {
      set('font-family', value, decl.important);
      set('font-weight', value, decl.important);
    } else set(name, value, decl.important);
  }
  return values;
}

function possibleWeights(value, parent) {
  value = value.toLowerCase();
  if (inherited.has(value)) return parent;
  if (value === 'normal' || value === 'initial') return [normal];
  if (value === 'bold') return [700];
  if (value === 'bolder') return parent.map(w => w === null ? null : w < 350 ? 400 : w < 550 ? 700 : 900);
  if (value === 'lighter') return parent.map(w => w === null ? null : w < 550 ? 100 : w < 750 ? 400 : 700);
  return [/^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null];
}

// CSS Fonts searches different sides of the requested weight first, with a
// special ordering for the 400–500 interval.
function nearestFace(faces, weight) {
  const heavier = faces.find(face => face.weight >= weight);
  const lighter = faces.findLast(face => face.weight <= weight);
  if (weight < 400) return lighter || heavier;
  if (weight > 500) return heavier || lighter;
  return (heavier?.weight <= 500 && heavier) || lighter || heavier;
}

export function projectFontFacesFor(plan) {
  const doc = plan.fontDocument;
  const usage = new Map();
  const ruleStyles = new Map();
  const uncertain = new Set(plan.fontScriptRefs);
  let unknownWeights = plan.dynamicFontWeights;
  const variables = new Map();
  const add = (families, weights) => {
    for (const { family } of families) {
      if (!usage.has(family)) usage.set(family, new Set());
      for (const weight of weights) usage.get(family).add(weight);
    }
  };
  function noteVariables(tree) {
    css.walk(tree, { visit: 'Declaration', enter(decl) {
      if (decl.property.startsWith('--')) {
        if (!variables.has(decl.property)) variables.set(decl.property, new Set());
        variables.get(decl.property).add(css.generate(decl.value));
      }
    }});
  }
  function referenced(value, seen = new Set()) {
    const families = projectFontsIn(value);
    for (const [, name] of value.matchAll(/\bvar\(\s*(--[\w-]+)/gi)) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const candidate of variables.get(name) || []) families.push(...referenced(candidate, seen));
    }
    return families;
  }
  const looseRules = [];
  const textHosts = new Set();
  for (const code of plan.fontStylesheets) {
    try {
      const tree = css.parse(code);
      noteVariables(tree);
      css.walk(tree, { visit: 'Rule', enter(rule) {
        const styles = declarations(rule.block);
        const hasFontStyle = Object.keys(styles).length > 0;
        const selector = css.generate(rule.prelude);
        // Dynamic states and pseudo-elements can use their own font styling.
        const host = selector.replace(/::[\w-]+(?:\([^)]*\))?|:(?:hover|active|focus(?:-visible|-within)?|before|after)\b/g, '');
        const pseudoText = /::?(?:before|after)\b|::(?:marker|placeholder)\b/.test(selector);
        if (!hasFontStyle && !pseudoText) return;
        if (this.atrule?.name?.endsWith('keyframes') || plan.dynamicFontSelectors) {
          if (hasFontStyle) looseRules.push(styles);
          return;
        }
        try {
          for (const node of doc.querySelectorAll(host)) {
            if (pseudoText) textHosts.add(node);
            if (!hasFontStyle) continue;
            if (!ruleStyles.has(node)) ruleStyles.set(node, []);
            ruleStyles.get(node).push({ styles, unconditional: host === selector && !this.atrule });
          }
        } catch { if (hasFontStyle) looseRules.push(styles); }
      }});
    } catch {
      for (const font of projectFontsIn(code)) uncertain.add(font.family);
      unknownWeights ||= /font(?:-weight)?\s*:/i.test(code);
    }
  }
  const inline = new Map();
  const parseInline = value => {
    try {
      const tree = css.parse(value, { context: 'declarationList' });
      noteVariables(tree);
      return declarations(tree);
    } catch {
      for (const font of projectFontsIn(value)) uncertain.add(font.family);
      unknownWeights ||= /font(?:-weight)?\s*:/i.test(value);
      return {};
    }
  };
  for (const node of doc.querySelectorAll('[style]')) inline.set(node, parseInline(node.getAttribute('style')));
  for (const value of plan.fontPatchStyles) looseRules.push(parseInline(value));
  for (const styles of looseRules) {
    if (styles['font-family']) add(referenced(styles['font-family'].value), [null]);
    if (styles['font-weight']) unknownWeights = true;
  }
  for (const font of PROJECT_FONTS) if (uncertain.has(font.family)) add([font], [null]);

  const effective = new Map();
  for (const node of doc.querySelectorAll('*')) {
    const parent = effective.get(node.parentElement) || { weights: [normal], families: [] };
    const own = inline.get(node) || {};
    const rules = ruleStyles.get(node) || [];
    const weight = own['font-weight'];
    const family = own['font-family'];
    const weights = weight ? [...possibleWeights(weight.value, parent.weights)] : [];
    const attribute = node.getAttribute('font-family') || (node.localName === 'font' && node.getAttribute('face'));
    const attributeWeight = node.getAttribute('font-weight');
    if (!weight && !rules.some(rule => rule.unconditional && rule.styles['font-weight'])) {
      const fallback = attributeWeight || (boldElements.has(node.localName) ? 'bolder' : 'inherit');
      weights.push(...possibleWeights(fallback, parent.weights));
    }
    const families = family ? referenced(family.value) : projectFontsIn(attribute || '');
    if (!family || inherited.has(family.value.toLowerCase()) || /\b(?:revert|var\()/i.test(family.value)) families.push(...parent.families);
    for (const { styles } of rules) {
      const ruleWeight = styles['font-weight'];
      const ruleFamily = styles['font-family'];
      if (ruleWeight && (!weight || (ruleWeight.important && !weight.important) || textHosts.has(node))) weights.push(...possibleWeights(ruleWeight.value, parent.weights));
      if (ruleFamily && (!family || (ruleFamily.important && !family.important) || textHosts.has(node))) families.push(...referenced(ruleFamily.value));
    }
    const current = { weights: [...new Set(weights)], families: [...new Set(families)] };
    effective.set(node, current);
    if (plan.dynamicFontSelectors || textHosts.has(node) || node.matches('li,input,select,textarea,template') ||
        [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())) {
      add(current.families, current.weights);
    }
  }
  return PROJECT_FONTS.filter(font => usage.has(font.family)).map(font => {
    const weights = usage.get(font.family);
    const faces = unknownWeights || weights.has(null) ? font.faces : [...new Set([...weights].map(weight => nearestFace(font.faces, weight)))];
    return { ...font, faces };
  });
}
