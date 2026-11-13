/* Wire validation only: archived messages, including interrupted reasoning, stay intact. */
export function isSendableMessage(message) {
  if (!message) return false;
  if (message.role !== 'assistant') return true;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return true;
  const content = message.content;
  if (typeof content === 'string') return !!content.trim();
  if (Array.isArray(content)) return content.some((part) => {
    if (typeof part === 'string') return !!part.trim();
    if (!part) return false;
    if (part.type === 'text') return typeof part.text === 'string' && !!part.text.trim();
    return !!part.type;
  });
  return false;
}
