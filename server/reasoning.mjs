// Provider wire conventions; imported by both the server and private browser bundle.
export function applyReasoning(payload, { reasoningEffort, wire, model, base = '' }) {
  if (!reasoningEffort || reasoningEffort === 'auto') return payload;
  if (reasoningEffort !== 'none') {
    if (wire !== 'anthropic') payload.reasoning_effort = reasoningEffort;
    return payload;
  }
  if (wire === 'anthropic') payload.thinking = { type: 'disabled' };
  else if (/deepseek|kimi|moonshot/i.test(model + ' ' + base)) payload.thinking = { type: 'disabled' };
  else if (/qwen|qwq|dashscope/i.test(model + ' ' + base)) payload.enable_thinking = false;
  else payload.reasoning_effort = 'none';
  return payload;
}

export function reasoningDisabled(payload) {
  return payload.reasoning_effort === 'none' || payload.thinking?.type === 'disabled' || payload.enable_thinking === false;
}
