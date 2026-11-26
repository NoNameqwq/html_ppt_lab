/* The app API catalog is shared by the server and the Agent. No arbitrary URLs. */
const entry = (id, method, path, description, permission = 'read', params = {}) => ({ id, method, path, description, permission, params });
export const API_CATALOG = [
  entry('projects.list', 'GET', '/api/projects', '列出文件库全部工程'),
  entry('projects.get', 'GET', '/api/projects/{projectId}', '工程元信息与文件列表'),
  entry('projects.create', 'POST', '/api/projects', '新建工程', 'edit', { name: 'string', templateId: 'string（先查 templates.list）' }),
  entry('projects.import', 'POST', '/api/projects/import', '导入 HTML、PPT/PPTX、内置示例或本地文件，PPT 返回 importReport', 'full', { name: 'string', fileName: 'string', content: 'HTML string', dataUrl:'PPT base64 data URL',sourcePath: '本地文件路径', importId:'对话附件的暂存 ID',pptMode:'editable（默认可编辑）或 faithful（PowerPoint 逐页图片）',sampleId: '内置示例 ID' }),
  entry('projects.update', 'PATCH', '/api/projects/{projectId}', '重命名、修改工程元信息；archived=true 归档，false 恢复，保留文件和历史', 'edit', { name: 'string', theme: 'string', cover: 'string', archived: 'boolean' }),
  entry('projects.duplicate', 'POST', '/api/projects/{projectId}/duplicate', '复制工程', 'edit'),
  entry('projects.delete', 'DELETE', '/api/projects/{projectId}', '删除用户明确要求删除的工程', 'full'),
  entry('projects.upgrade', 'POST', '/api/projects/{projectId}/upgrade-runtime', '更新工程运行时', 'full'),
  entry('files.read', 'GET', '/api/projects/{projectId}/file', '读取工程文件，query.path 为相对路径', 'read', { path: 'query: string' }),
  entry('files.write', 'PUT', '/api/projects/{projectId}/file', '写入工程文件；当前工程使用 file_write 自动保存和重载', 'full', { path: 'string', content: 'string' }),
  entry('assets.upload', 'POST', '/api/projects/{projectId}/assets', '上传素材并返回工程内相对 URL', 'edit', { name: 'string', dataUrl: 'base64 data URL' }),
  entry('images.generate', 'POST', '/api/projects/{projectId}/generate-image', '生成图片并保存到当前对话素材目录，返回路径，不插入或切换页面；使用时另调 deck_insert_image。必须由用户手动开启生图。', 'edit', { prompt: 'string', model: '可选，已发现或用户指定的模型', size: 'auto / 1024x1024 / 1536x1024 / 1024x1536', quality: 'auto / low / medium / high', background: 'auto / opaque / transparent（GPT）', outputFormat: 'png / jpeg / webp（GPT）', outputCompression: '0–100，JPEG/WebP（GPT）' }),
  entry('images.models', 'GET', '/api/image-models', '使用用户已保存的生图配置发现可用图像模型，不生成图片或开启生图'),
  entry('patches.read', 'GET', '/api/projects/{projectId}/patches', '读取原稿补丁'),
  entry('patches.write', 'PUT', '/api/projects/{projectId}/patches', '保存原稿补丁', 'full', { patches: 'array' }),
  entry('config.read', 'GET', '/api/projects/{projectId}/deck-config', '读取全局效果配置'),
  entry('config.write', 'PUT', '/api/projects/{projectId}/deck-config', '保存全局效果配置', 'full', { config: 'object' }),
  entry('timeline.read', 'GET', '/api/projects/{projectId}/timeline', '读取完整时间线'),
  entry('timeline.write', 'PUT', '/api/projects/{projectId}/timeline', '保存时间线', 'edit', { timeline: 'object' }),
  entry('history.read', 'GET', '/api/projects/{projectId}/history', '读取修改历史'),
  entry('history.write', 'PUT', '/api/projects/{projectId}/history', '保存修改历史', 'full', { ops: 'array' }),
  entry('versions.list', 'GET', '/api/projects/{projectId}/versions', '列出完整工程版本、对话关联及旧版 HTML 备份'),
  entry('versions.inspect', 'GET', '/api/projects/{projectId}/versions/detail', '查看版本与当前工程的文件变化', 'read', { versionId: 'query: string' }),
  entry('versions.create', 'POST', '/api/projects/{projectId}/versions', '保存一个命名工程版本', 'edit', { label: 'string' }),
  entry('versions.restore', 'POST', '/api/projects/{projectId}/versions/restore', '按用户要求恢复工程版本。对话保留；同步回退对话请由用户点击消息旁的回退入口。', 'full', { versionId: 'string' }),
  entry('versions.preview','GET','/api/projects/{projectId}/versions/{versionId}/preview','预览历史交付，query.versionId 指定版本', 'read',{versionId:'query: string'}),
  entry('versions.present','GET','/api/projects/{projectId}/versions/{versionId}/present','放映历史交付，query.versionId 指定版本','read',{versionId:'query: string'}),
  entry('versions.export','GET','/api/projects/{projectId}/versions/{versionId}/export','下载历史版本的 HTML，query.versionId 指定版本','read',{versionId:'query: string'}),
  entry('export.html', 'GET', '/api/projects/{projectId}/export', '生成 HTML 下载链接'),
  entry('preview.thumbnail', 'GET', '/api/projects/{projectId}/thumb', '生成预览链接，query.slide 为从 0 开始的页码'),
  entry('templates.list', 'GET', '/api/templates', '列出新建模板'),
  entry('elements.list', 'GET', '/api/elements', '列出跨工程共享的收藏元素，返回名称、尺寸和说明'),
  entry('elements.get', 'GET', '/api/elements/{elementId}', '读取收藏元素完整 HTML、内嵌素材及样式，query.elementId 指定收藏 ID'),
  entry('elements.save', 'POST', '/api/elements', '保存自包含元素到跨工程收藏库；收藏画布选中元素时也可用 app_run_command favorites.save', 'edit', { name:'string',html:'自包含的单个元素 HTML',css:'局部样式',w:'number',h:'number',description:'string' }),
  entry('elements.update', 'PATCH', '/api/elements/{elementId}', '重命名收藏元素或修改说明，query.elementId 指定收藏 ID','edit',{name:'string',description:'string'}),
  entry('elements.delete', 'DELETE', '/api/elements/{elementId}', '删除用户明确要求删除的收藏元素，query.elementId 指定收藏 ID','full'),
  entry('templates.save', 'POST', '/api/templates', '保存当前工程为模板，或导入 HTML / ZIP / PPT 模板', 'full',{projectId:'已有工程 ID',name:'string',desc:'string',content:'HTML string',fileName:'文件名',dataUrl:'base64 data URL'}),
  entry('templates.update', 'PATCH', '/api/templates/{templateId}', '修改自定义模板名称和说明', 'edit',{name:'string',desc:'string'}),
  entry('templates.delete', 'DELETE', '/api/templates/{templateId}', '删除用户明确要求删除的自定义模板', 'full'),
  entry('templates.export', 'GET', '/api/templates/{templateId}/export', '下载包含模板与素材的 ZIP'),
  entry('imports.stage','POST','/api/imports','暂存 PPT / PPTX 附件供后续 projects.import 使用','full',{fileName:'string',dataUrl:'base64 data URL'}),
  entry('samples.list', 'GET', '/api/samples', '列出可导入的示例'),
  entry('skills.list', 'GET', '/api/skills', '列出内置技能内容'),
  entry('settings.read', 'GET', '/api/settings', '读取设置，密钥已脱敏'),
  entry('settings.write', 'PUT', '/api/settings', '修改模型、Agent、界面、联网设置', 'full', { agent: 'object', ui: 'object', providers: 'array', search: 'object' }),
  entry('models.list', 'POST', '/api/ai/models', '获取服务商模型列表', 'read', { providerId: 'string' }),
  entry('models.cache', 'GET', '/api/ai/models-cache', '查看模型能力缓存状态'),
  entry('filesystem.list', 'GET', '/api/fs/list', '浏览本地导入目录，query.path 为用户指定目录', 'full', { path: 'query: string' }),
  entry('filesystem.read', 'GET', '/api/fs/read', '读取用户指定的本地导入文件，query.path 为文件路径', 'full', { path: 'query: string' }),
  entry('search.web', 'POST', '/api/search', '联网搜索；须启用联网', 'read', { query: 'string' }),
];

export function apiURL(operation, projectId, query = {}) {
  if (operation.path.includes('{projectId}') && !projectId) throw new Error('需要 projectId 或打开一个工程。');
  if(operation.path.includes('{templateId}')&&!query.templateId)throw new Error('请在 query.templateId 指定模板 ID');
  if(operation.path.includes('{versionId}')&&!query.versionId)throw new Error('请在 query.versionId 指定版本 ID');
  if(operation.path.includes('{elementId}')&&!query.elementId)throw new Error('请在 query.elementId 指定收藏 ID');
  const url = operation.path.replace('{projectId}', encodeURIComponent(projectId || '')).replace('{templateId}',encodeURIComponent(query.templateId||'')).replace('{versionId}',encodeURIComponent(query.versionId||'')).replace('{elementId}',encodeURIComponent(query.elementId||''));
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value != null) params.set(key, String(value));
  return url + (params.size ? '?' + params : '');
}
