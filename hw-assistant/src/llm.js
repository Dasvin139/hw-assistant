export const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_MODEL = 'qwen2.5:7b';

export function isLoopback(baseUrl) {
  try {
    const h = new URL(baseUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

export function createOpenAICompatProvider({ baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, apiKey = '' } = {}) {
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };

  return {
    name: `${model} @ ${new URL(baseUrl).host}`,
    local: isLoopback(baseUrl),

    async ping() {
      try {
        const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(1500) });
        return res.ok;
      } catch {
        return false;
      }
    },

    async chat({ messages, tools }) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          tool_choice: 'auto',
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        }),
      });
      if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`);
      const data = await res.json();
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error('LLM returned no message.');
      const toolCalls = (message.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function?.name, argsRaw: tc.function?.arguments }));
      return { message, text: message.content ?? '', toolCalls };
    },
  };
}
