import { editorProjectFonts } from './project-fonts.js';

export const FONT_PROFILES = [
  { id:'auto', label:'自动识别内容' }, { id:'academic', label:'学术 / 知识讲解' }, { id:'business', label:'商务 / 汇报' },
  { id:'editorial', label:'人文 / 编辑排版' }, { id:'technical', label:'技术 / 数据' }, { id:'playful', label:'轻松 / 教学' },
];
export const FONT_CATALOG = [
  ['Microsoft YaHei','微软雅黑','sans'],['DengXian','等线','sans'],['SimSun','宋体','serif'],['KaiTi','楷体','serif'],['FangSong','仿宋','serif'],
  ['PingFang SC','苹方','sans'],['Songti SC','宋体 SC','serif'],['Noto Sans SC','思源黑体','sans'],['Noto Serif SC','思源宋体','serif'],
  ['Source Han Sans SC','思源黑体 SC','sans'],['Source Han Serif SC','思源宋体 SC','serif'],
  ['Aptos','Aptos','sans'],['Segoe UI','Segoe UI','sans'],['Arial','Arial','sans'],['Georgia','Georgia','serif'],['Times New Roman','Times New Roman','serif'],
  ['Cascadia Code','Cascadia Code','mono'],['Consolas','Consolas','mono'],['Menlo','Menlo','mono'],
].map(([family,label,category])=>({family,label,category}));
export function availableFonts(doc = globalThis.document) {
  const bundled = editorProjectFonts().map(({ family, label, category, stack }) => ({ family, label, category, stack, available: true, bundled: true }));
  if (!doc?.createElement) return [...FONT_CATALOG.map((f)=>({...f,available:null})), ...bundled];
  const canvas=doc.createElement('canvas'), context=canvas.getContext('2d'), sample='iiiiWWmm汉字0123456789';
  const width=(font)=>{context.font='48px '+font; return context.measureText(sample).width;};
  const mono=width('monospace'), serif=width('serif');
  return [...FONT_CATALOG.map((f)=>({...f,available: Math.abs(width(JSON.stringify(f.family)+',monospace')-mono)>.1 || Math.abs(width(JSON.stringify(f.family)+',serif')-serif)>.1})), ...bundled];
}
export function recommendFonts({ profile='auto', text='', fonts=availableFonts() }={}) {
  const chinese=/[\u3400-\u9fff]/.test(text);
  if(profile==='auto') profile=/公式|定理|证明|物理|数学|学术|课程|知识/.test(text)?'academic':/代码|技术|算法|数据|系统|软件/.test(text)?'technical':/儿童|有趣|小学|轻松/.test(text)?'playful':/文学|历史|艺术|诗|人文/.test(text)?'editorial':'business';
  const installed=fonts.filter((f)=>f.available!==false);
  const choose=(names,fallback)=>names.find((name)=>installed.some((f)=>f.family===name))||fallback;
  const sans=chinese?choose(['Microsoft YaHei','PingFang SC','Noto Sans SC','Source Han Sans SC','DengXian'],'sans-serif'):choose(['Aptos','Segoe UI','Arial'],'sans-serif');
  const serif=chinese?choose(['Noto Serif SC','Source Han Serif SC','Songti SC','SimSun'],sans):choose(['Georgia','Times New Roman'],sans);
  const heading=profile==='editorial'&&chinese?choose(['wds-font-huiwen-mincho','Noto Serif SC'],serif):profile==='academic'?serif:profile==='playful'&&chinese?choose(['wds-font-lxgw-marker','KaiTi','Microsoft YaHei'],sans):sans;
  const mono=choose(['Cascadia Code','Consolas','Menlo'],'monospace');
  const label = family => installed.find(font => font.family === family)?.label || family;
  return { profile,heading,body:sans,mono,stack:(family)=>installed.find(font => font.family === family)?.stack || ((['serif','sans-serif','monospace'].includes(family)?family:JSON.stringify(family))+','+(chinese?'"Microsoft YaHei","PingFang SC",':'')+(family===mono?'monospace':'sans-serif')),
    reason:`${FONT_PROFILES.find((p)=>p.id===profile)?.label||profile}：标题使用${label(heading)}，正文使用${label(sans)}，并保留回退字体。` };
}
