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
    stream: false,
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

  const text = await res.text();
  let content = '';
  let model = cfg.aiModel;
  let usage: AIChatCompletionResponse['usage'] = undefined;

  // Lida com resposta JSON pura ou Server-Sent Events (SSE) se o router enviar stream por padrão
  if (text.startsWith('data:')) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data:') && !line.includes('[DONE]')) {
        try {
          const chunk = JSON.parse(line.slice(5).trim());
          const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '';
          content += delta;
          if (chunk.model) model = chunk.model;
        } catch {}
      }
    }
  } else {
    try {
      const data = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
        model?: string;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };
      content = data.choices?.[0]?.message?.content?.trim() ?? '';
      if (data.model) model = data.model;
      if (data.usage) {
        usage = {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        };
      }
    } catch {
      content = text.trim();
    }
  }

  return {
    content: content.trim(),
    model,
    usage,
  };
}
