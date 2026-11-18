// Archive only changes metadata; project files, conversations and versions stay in place.
export function archivePatch(project, patch, timestamp = Date.now()) {
  if (patch.archived === undefined) return {};
  if (typeof patch.archived !== 'boolean') throw Object.assign(new Error('archived 必须是布尔值'), { status: 400 });
  return { archived: patch.archived, archivedAt: patch.archived ? (project.archived && project.archivedAt || timestamp) : 0 };
}
