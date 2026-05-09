import { randomUUID } from 'node:crypto';
import type { ChatCompletionRequest, OpenAIUsage } from './types.js';

export interface ResponsesRequest {
  model: string;
  input?: unknown;
  instructions?: string | null;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  [key: string]: unknown;
}

interface ResponsesOutputItem {
  id: string;
  type: 'message';
  status: 'completed' | 'in_progress';
  role: 'assistant';
  content: Array<{ type: 'output_text'; text: string }>;
}

interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface ResponsesResponse {
  id: string;
  object: 'response';
  status: 'completed' | 'failed';
  output: ResponsesOutputItem[];
  output_text: string;
  model: string;
  usage: ResponsesUsage | null;
}

export function buildChatBody(body: ResponsesRequest): ChatCompletionRequest {
  const messages: unknown[] = [];

  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  messages.push(...inputToMessages(body.input));

  const chatBody: ChatCompletionRequest = {
    model: body.model,
    messages
  };

  if (body.stream === true) chatBody.stream = true;
  if (typeof body.temperature === 'number') chatBody.temperature = body.temperature;
  if (typeof body.top_p === 'number') chatBody.top_p = body.top_p;
  if (typeof body.max_output_tokens === 'number') chatBody.max_tokens = body.max_output_tokens;

  return chatBody;
}

function inputToMessages(input: unknown): unknown[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (Array.isArray(input)) {
    const messages = input
      .map((item) => inputItemToMessage(item))
      .filter((message): message is { role: string; content: string } => message !== undefined);
    if (messages.length > 0) return messages;
    const text = collectInputText(input);
    return text ? [{ role: 'user', content: text }] : [];
  }
  if (input !== undefined && input !== null) return [{ role: 'user', content: String(input) }];
  return [];
}

function inputItemToMessage(item: unknown): { role: string; content: string } | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const candidate = item as Record<string, unknown>;
  if (candidate.type !== 'message') return undefined;
  const role = typeof candidate.role === 'string' ? candidate.role : 'user';
  const content = extractInputContent(candidate.content);
  return content ? { role, content } : undefined;
}

function extractInputContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return collectInputText(content);
  return content !== undefined && content !== null ? String(content) : '';
}

function collectInputText(parts: unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part === null || part === undefined) continue;
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (typeof part === 'object') {
      const item = part as Record<string, unknown>;
      if (item.type === 'input_text' && typeof item.text === 'string') {
        texts.push(item.text);
      }
    }
  }
  return texts.join('');
}

export function chatToResponsesResponse(
  chatJson: Record<string, unknown>,
  model: string
): ResponsesResponse {
  const id = `resp_${randomUUID()}`;
  const choices = Array.isArray(chatJson.choices) ? chatJson.choices : [];
  const firstChoice = choices[0] as
    | { message?: { role?: string; content?: unknown }; finish_reason?: string }
    | undefined;
  const content = extractTextContent(firstChoice?.message?.content);
  const outputItemId = `msg_${randomUUID()}`;

  const output: ResponsesOutputItem[] = [
    {
      id: outputItemId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: content ? [{ type: 'output_text', text: content }] : []
    }
  ];

  return {
    id,
    object: 'response',
    status: 'completed',
    output,
    output_text: content,
    model,
    usage: convertUsage(chatJson.usage)
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'object' && item !== null) {
          const c = item as Record<string, unknown>;
          if (c.type === 'text' && typeof c.text === 'string') return c.text;
        }
        return typeof item === 'string' ? item : '';
      })
      .join('');
  }
  return content !== null && content !== undefined ? String(content) : '';
}

function convertUsage(usage: unknown): ResponsesUsage | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as OpenAIUsage;
  return {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)
  };
}

export function createResponsesStream(
  chatStream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const responseId = `resp_${randomUUID()}`;
  const outputItemId = `msg_${randomUUID()}`;
  const contentPartId = `part_${randomUUID()}`;
  let buffer = '';
  let emitted = false;
  let accumulatedText = '';
  let usage: OpenAIUsage | undefined;

  function emitStart(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder
  ) {
    if (emitted) return;
    emitted = true;
    emit(
      controller,
      encoder,
      `event: response.created\ndata: ${JSON.stringify(createCreatedEvent(responseId, model))}\n\n`
    );
    emit(
      controller,
      encoder,
      `event: response.output_item.added\ndata: ${JSON.stringify(createOutputItemAddedEvent(outputItemId))}\n\n`
    );
    emit(
      controller,
      encoder,
      `event: response.content_part.added\ndata: ${JSON.stringify(createContentPartAddedEvent(outputItemId, contentPartId))}\n\n`
    );
  }

  function processDataLine(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    data: string
  ): void {
    if (data === '[DONE]') return;
    let parsed: {
      choices?: Array<{ delta?: { role?: string; content?: string } }>;
      usage?: OpenAIUsage;
    };
    try {
      parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { role?: string; content?: string } }>;
        usage?: OpenAIUsage;
      };
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    emitStart(controller, encoder);
    const delta = parsed.choices?.[0]?.delta;
    if (typeof delta?.content === 'string') {
      accumulatedText += delta.content;
      emit(
        controller,
        encoder,
        `event: response.output_text.delta\ndata: ${JSON.stringify(createOutputTextDeltaEvent(outputItemId, delta.content))}\n\n`
      );
    }
    usage = parsed.usage ?? usage;
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = chatStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6).trim();
            processDataLine(controller, encoder, data);
          }
        }
        if (buffer) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith('data: ') && trimmed.slice(6).trim() !== '[DONE]') {
            processDataLine(controller, encoder, trimmed.slice(6).trim());
          }
        }

        emitStart(controller, encoder);

        emit(
          controller,
          encoder,
          `event: response.output_text.done\ndata: ${JSON.stringify(createOutputTextDoneEvent(outputItemId, accumulatedText))}\n\n`
        );

        const completed = createCompletedEvent(
          responseId,
          model,
          outputItemId,
          accumulatedText,
          usage
        );
        emit(
          controller,
          encoder,
          `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`
        );
        emit(controller, encoder, 'data: [DONE]\n\n');
      } finally {
        reader.releaseLock();
        controller.close();
      }
    }
  });
}

function emit(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  data: string
): void {
  controller.enqueue(encoder.encode(data));
}

function createCreatedEvent(id: string, model: string): Record<string, unknown> {
  return {
    type: 'response.created',
    response: {
      id,
      object: 'response',
      status: 'in_progress',
      model
    }
  };
}

function createOutputItemAddedEvent(id: string): Record<string, unknown> {
  return {
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      id,
      object: 'response.output_item',
      type: 'message',
      status: 'in_progress',
      role: 'assistant'
    }
  };
}

function createContentPartAddedEvent(itemId: string, partId: string): Record<string, unknown> {
  return {
    type: 'response.content_part.added',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: {
      id: partId,
      object: 'response.content_part',
      type: 'output_text',
      text: ''
    }
  };
}

function createOutputTextDeltaEvent(itemId: string, delta: string): Record<string, unknown> {
  return {
    type: 'response.output_text.delta',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta
  };
}

function createOutputTextDoneEvent(itemId: string, text: string): Record<string, unknown> {
  return {
    type: 'response.output_text.done',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text
  };
}

function createCompletedEvent(
  id: string,
  model: string,
  outputItemId: string,
  outputText: string,
  usage: OpenAIUsage | undefined
): Record<string, unknown> {
  return {
    type: 'response.completed',
    response: {
      id,
      object: 'response',
      status: 'completed',
      model,
      output: [
        {
          id: outputItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: outputText }]
        }
      ],
      output_text: outputText,
      usage: usage
        ? {
            input_tokens: usage.prompt_tokens ?? 0,
            output_tokens: usage.completion_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0
          }
        : null
    }
  };
}
