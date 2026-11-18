// null follows the provider's catalog, including models discovered in the future.
export function normalizeVisibleModels(value) {
  return Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))] : null;
}

export function providerModels(provider) {
  const models = [], seen = new Set();
  for (const raw of [...(Array.isArray(provider.models) ? provider.models : []), { id: provider.model }]) {
    const m = typeof raw === 'string' ? { id: raw } : raw;
    const id = String(m?.id || m?.name || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id); models.push({ ...m, id });
  }
  return models;
}

export function visibleProviderModels(provider) {
  const visible = normalizeVisibleModels(provider.visibleModels);
  return providerModels(provider).filter(m => visible === null || visible.includes(m.id));
}
