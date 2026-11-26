// Shared branch transactions for the disk backend and the standalone workspace.
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const session = value => {
  const id = String(value || 'default');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw fail('会话 ID 无效', 400);
  return id;
};

export function createProjectBranches(adapter) {
  const view = state => ({ active: state?.active || null, branches: state?.items || [] });
  const capture = async (id, label) => adapter.capture({ kind: 'branch', label,
    conversation: { sessionId: id, projectId: adapter.projectId, phase: 'after' }, chat: await adapter.readChat(id) });
  async function recover() {
    const state = await adapter.readState();
    if (!state?.pending) return state;
    const { previous, rollback, source, created, targetId, targetChat } = state.pending;
    await adapter.restore(rollback, { rewindConversation: true, targetSessionId: source, archiveConversation: false });
    if (targetId && targetChat) await adapter.saveChat(targetId, targetChat);
    if (created) await adapter.deleteChat(created);
    await adapter.writeState(previous);
    return previous;
  }
  async function current(sourceId) {
    let state = await recover();
    if (!state) {
      const chat = await adapter.readChat(sourceId);
      const version = await capture(sourceId, '主分支 · 初始状态');
      state = { active: sourceId, items: [{ id: sourceId, name: chat.title || '主分支', head: version.id, createdAt: Date.now() }] };
      await adapter.writeState(state);
    }
    if (state.active !== sourceId) throw fail('项目分支已切换，请重新打开当前分支后操作');
    return state;
  }
  async function checkpoint(state) {
    const branch = state.items.find(item => item.id === state.active);
    if (!branch) throw fail('当前分支记录损坏');
    const version = await capture(branch.id, branch.name + ' · 离开前状态');
    branch.head = version.id; branch.updatedAt = Date.now();
    await adapter.writeState(state);
    return version.id;
  }
  async function transact(state, target, versionId, chat, created = null, rewind = false) {
    // Read and validate the target before creating any recovery journal.
    await adapter.readVersionChat(versionId);
    const rollback = await checkpoint(state), previous = structuredClone(state);
    const targetChat = !created && target.id !== state.active ? await adapter.readChat(target.id) : null;
    const pending = { ...state, pending: { previous, rollback, source: state.active, created,
      ...(targetChat ? { targetId: target.id, targetChat } : {}) } };
    await adapter.writeState(pending);
    try {
      const result = await adapter.restore(versionId, { rewindConversation: true, targetSessionId: target.id, archiveConversation: false, preserveConversationMetadata: rewind });
      if (chat) await adapter.saveChat(target.id, chat);
      target.head = rewind ? versionId : (await capture(target.id, target.name + ' · 分支状态')).id;
      target.updatedAt = Date.now();
      const next = { active: target.id, items: state.items.filter(item => item.id !== target.id).concat(target) };
      await adapter.writeState(next);
      return { ...result, ...view(next), conversation: { sessionId: target.id, archivedSession: null } };
    } catch (error) {
      // The durable journal remains available if rollback itself cannot finish.
      try { await recover(); }
      catch (rollbackError) { throw fail('分支操作中断，恢复日志已保留。请释放文件占用后重试：' + rollbackError.message); }
      throw error;
    }
  }
  return {
    recover,
    async list() { return view(await recover()); },
    async fork(body = {}) {
      const source = session(body.sourceSessionId), state = await current(source);
      const name = String(body.name || '分支 ' + (state.items.length + 1)).trim().slice(0, 120);
      if (!name) throw fail('请输入分支名称', 400);
      // A historical fork never overwrites the live state of the source branch.
      const versionId = body.versionId || (await checkpoint(state));
      const chat = structuredClone(await adapter.readVersionChat(versionId));
      const id = 'branch-' + crypto.randomUUID();
      chat.title = name; chat.origin = { sessionId: source, versionId, branch: true };
      if (body.empty === true) { chat.messages = []; chat.summary = null; }
      return transact(state, { id, name, createdAt: Date.now(), origin: chat.origin }, versionId, chat, id);
    },
    async switch(body = {}) {
      const source = session(body.sourceSessionId), targetId = session(body.sessionId), state = await current(source);
      if (targetId === source) return { ...view(state), conversation: { sessionId: source, archivedSession: null } };
      let target = state.items.find(item => item.id === targetId);
      if (!target) {
        const version = await adapter.findSessionVersion(targetId);
        if (!version) throw fail('旧对话没有可恢复的项目快照，无法作为独立分支切换');
        const chat = await adapter.readChat(targetId);
        target = { id: targetId, name: chat.title || '历史对话', head: version.id, createdAt: chat.updatedAt || Date.now() };
      }
      return transact(state, { ...target }, target.head, await adapter.readChat(targetId));
    },
    async rewind(body = {}) {
      const source = session(body.sourceSessionId), state = await current(source);
      return transact(state, { ...state.items.find(item => item.id === source) }, body.versionId, null, null, true);
    },
    async rename(body = {}) {
      const state = await recover(), id = session(body.sessionId);
      const branch = state?.items.find(item => item.id === id);
      if (!branch) throw fail('分支不存在', 404);
      const name = String(body.name || '').trim().slice(0, 120);
      if (!name) throw fail('请输入分支名称', 400);
      branch.name = name; await adapter.writeState(state);
      const chat = await adapter.readChat(id); await adapter.saveChat(id, { ...chat, title: name });
      return view(state);
    },
  };
}
