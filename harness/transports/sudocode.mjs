// SudoCode transport only. Does not rewrite system/messages or tool descriptions.
import { createHash, randomUUID } from 'node:crypto';
import { Stream } from '@anthropic-ai/sdk/core/streaming';

const CLAUDE_UA = 'claude-cli/2.1.221 (external, sdk-cli)';
const deviceId = createHash('sha256').update('pi-sudocode-claude-code-compat').digest('hex');

function completeSudoCodeStream(response, signal) {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
    return response;
  }
  let started = false;
  let stopped = false;
  let valid = true;
  let stopReason;
  const blocks = new Map();

  function observe(sse) {
    if (!valid) return;
    try {
      const event = JSON.parse(sse.data);
      if (event.type !== sse.event) throw new Error("Mismatched SSE event");
      switch (event.type) {
        case "ping":
          break;
        case "message_start":
          valid = !started && !stopped;
          started = true;
          break;
        case "content_block_start":
          valid = started && !stopped && !stopReason && event.index === blocks.size;
          if (valid) blocks.set(event.index, {
            type: event.content_block.type, input: event.content_block.input,
            json: "", hasJson: false, closed: false,
          });
          break;
        case "content_block_delta": {
          const block = blocks.get(event.index);
          valid = !!block && !block.closed && !stopped && !stopReason;
          if (valid && block && event.delta.type === "input_json_delta") {
            valid = block.type === "tool_use" && typeof event.delta.partial_json === "string";
            block.hasJson = true;
            block.json += event.delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const block = blocks.get(event.index);
          valid = !!block && !block.closed && !stopped && !stopReason;
          if (valid && block) {
            if (block.type === "tool_use") {
              const input = block.hasJson ? JSON.parse(block.json) : block.input;
              valid = input !== null && typeof input === "object" && !Array.isArray(input);
            }
            block.closed = true;
            block.json = "";
          }
          break;
        }
        case "message_delta":
          valid = started && !stopped && !stopReason && [...blocks.values()].every(block => block.closed);
          stopReason = event.delta?.stop_reason ?? undefined;
          break;
        case "message_stop":
          stopped = true;
          break;
        default:
          valid = false;
      }
    } catch {
      // Disable repair; leave malformed events to Pi's normal error handling.
      valid = false;
    }
  }

  const encoder = new TextEncoder();
  let tail = "";
  let interrupt;
  const monitored = response.body.pipeThrough(new TransformStream({
    start(controller) {
      // Unblock pending writes so aborting also cancels the upstream body.
      interrupt = () => controller.error(signal?.reason);
      signal?.addEventListener("abort", interrupt, { once: true });
      if (signal?.aborted) interrupt();
    },
    transform(chunk, controller) {
      tail = (tail + String.fromCharCode(...chunk.subarray(-4))).slice(-4);
      controller.enqueue(chunk);
    },
    flush(controller) {
      // Make the SDK forward a trailing partial event instead of silently discarding it.
      if (!/(?:\r\n\r\n|\n\n|\r\r)$/.test(tail)) controller.enqueue(encoder.encode("\n\n"));
    },
  }), { signal: signal ?? undefined });

  async function* repairedBody() {
    try {
      // Forward complete frames so Pi never sees a CRLF pair split across chunks.
      for await (const sse of Stream.rawEvents(new Response(monitored))) {
        observe(sse);
        yield encoder.encode(`${sse.raw.join("\n")}\n\n`);
      }
      signal?.throwIfAborted();
      const hasTools = [...blocks.values()].some(block => block.type === "tool_use");
      if (valid && started && !stopped && ["end_turn", "stop_sequence", "tool_use"].includes(stopReason ?? "")
        && (stopReason === "tool_use") === hasTools && [...blocks.values()].every(block => block.closed)
        && /(?:\r\n\r\n|\n\n|\r\r)$/.test(tail)) {
        yield encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }
    } finally {
      if (interrupt) signal?.removeEventListener("abort", interrupt);
    }
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(ReadableStream.from(repairedBody()), {
    status: response.status, statusText: response.statusText, headers,
  });
}

export function wrapFetch(fetchImpl) {
  const sessionId = randomUUID();
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://api.sudocode.chat' || url.pathname !== '/v1/messages') {
      return fetchImpl(input, init);
    }
    const request = new Request(input, init);
    const payload = await request.json();
    payload.context_management = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };
    payload.metadata = {
      ...payload.metadata,
      user_id: JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: sessionId }),
    };
    if (Array.isArray(payload.tools)) {
      payload.tools = payload.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
    }
    if (payload.thinking?.type === 'adaptive') delete payload.thinking.display;
    url.searchParams.set('beta', 'true');
    const headers = new Headers(request.headers);
    headers.delete('x-api-key');
    headers.delete('content-length');
    headers.set('user-agent', CLAUDE_UA);
    headers.set('x-app', 'cli');
    const response = await fetchImpl(url, {
      ...init, method: request.method, headers, body: JSON.stringify(payload), signal: request.signal,
    });
    return completeSudoCodeStream(response, request.signal);
  };
}
