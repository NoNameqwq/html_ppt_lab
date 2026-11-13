/* Shared, incremental SSE decoder. A chunk is not an event or a UTF-8 boundary. */
export async function* readSSE(body, { signal } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = '', data = [];
  const parseLine = (line) => {
    if (!line) {
      if (!data.length) { event = ''; return null; }
      const item = { event, data: data.join('\n') };
      event = ''; data = [];
      return item;
    }
    if (line[0] === ':') return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
    return null;
  };
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const item = parseLine(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
        if (item) yield item;
      }
      if (done) break;
    }
    if (buffer) parseLine(buffer.replace(/\r$/, ''));
    const tail = parseLine('');
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
