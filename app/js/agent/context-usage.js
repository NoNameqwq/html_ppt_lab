import { estimateTokens } from './markdown.js';
import { messageTokens } from './conversation.js';

export function contextUsage(messages, tools, { limit, budget }) {
  const system = messageTokens(messages.filter((m) => m.role === 'system'));
  const conversation = messageTokens(messages.filter((m) => m.role !== 'system'));
  const definitions = tools.length ? estimateTokens(JSON.stringify(tools)) : 0;
  const tokens = system + definitions + conversation;
  return { tokens, limit, budget, percent: Math.min(100, Math.round(tokens / Math.max(1, limit) * 100)),
    breakdown: { system, tools: definitions, messages: conversation }, estimated: true };
}
export function formatTokens(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return +(n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
