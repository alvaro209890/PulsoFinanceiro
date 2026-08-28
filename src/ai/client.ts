/**
 * Cliente HTTP OpenAI-compatible para IA via 9Router (ag/gemini-3.7-flash-high).
 * docs/10-camada-ia.md.
 */
import { getConfig } from '../config.js';

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIChatCompletionOptions {
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormatJson?: boolean;
}

export interface AIChatCompletionResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | undefined;
}

export class AIClientError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly responseBody: string,
    message: string
  ) {
    super(message);
  }
}

export async function callAI(
  options: AIChatCompletionOptions
): Promise<AIChatCompletionResponse> {
  const cfg = getConfig();
  const baseUrl = cfg.aiBaseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (cfg.aiApiKey) {
    headers['Authorization'] = `Bearer ${cfg.aiApiKey}`;
  }

  const payload: Record<string, unknown> = {
    model: cfg.aiModel,
    messages: options.messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 1000,
  };

  if (options.responseFormatJson) {
    payload['response_format'] = { type: 'json_object' };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new AIClientError(
      res.status,
      errorText,
      `Erro na chamada da IA (${res.status}): ${errorText.slice(0, 300)}`
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const choice = data.choices?.[0];
  const content = choice?.message?.content?.trim() ?? '';

  return {
    content,
    model: data.model ?? cfg.aiModel,
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}
