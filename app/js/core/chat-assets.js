// Public project-relative assets, grouped by the conversation that created them.
export function chatAssetDirectory(sessionId = 'default') {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) {
    throw Object.assign(new Error('会话 ID 无效'), { status: 400 });
  }
  return 'assets/chats/' + sessionId;
}
