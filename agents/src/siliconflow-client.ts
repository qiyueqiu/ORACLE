/**
 * SiliconFlow API 工具类
 * 用于调用 LLM 进行意图解析、决策和任务执行
 */

import axios, { type AxiosInstance } from 'axios';
import type { LLMResponse, LLMJsonResponse } from './types.js';

export interface ChatOptions {
  timeoutMs?: number;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  /** 透传任意供应商扩展字段到请求体（如 enable_thinking）*/
  extraBody?: Record<string, unknown>;
}

/** SiliconFlowClient 构造选项 */
export interface SiliconFlowClientOptions {
  /**
   * 若为 true,每次请求带 `enable_thinking: false`。
   * 用于关闭 DeepSeek-V3 / Qwen3 等混合推理模型的 thinking mode，
   * 使打分在同一条件下进行（单次生成，不扩展推理）。
   * OpenAI / Together / Groq 等外部端点不支持此字段——对应 client 不传此选项。
   */
  disableThinking?: boolean;
  /**
   * 瞬时错误（429 限流 / 5xx / 网络超时）的最大重试次数（指数退避）。默认 3。
   * 聚合端点（如云雾）在并发下常回 429；不重试会把限流误记为模型出不了 JSON 的
   * 兜底，污染路由能力测量。设 0 关闭重试。
   */
  maxRetries?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class SiliconFlowClient {
  private apiKey: string;
  private baseURL: string;
  private axios: AxiosInstance;

  /**
   * @param apiKey       LLM 服务的 API key
   * @param axiosInstance 可选自定义 axios（测试时传 mock adapter 包装的 instance）
   * @param baseURL      可选 OpenAI 兼容端点。默认 SiliconFlow；传入其他
   *                     `/v1` 兼容端点（如 https://api.openai.com/v1）即可路由到
   *                     别的提供商——打分/执行走的都是标准 /chat/completions，
   *                     故客户端对具体提供商无耦合（provider-agnostic）。
   */
  private disableThinking: boolean;
  private maxRetries: number;

  constructor(
    apiKey: string,
    axiosInstance?: AxiosInstance,
    baseURL?: string,
    options: SiliconFlowClientOptions = {},
  ) {
    this.apiKey = apiKey;
    this.baseURL = baseURL ?? 'https://api.siliconflow.cn/v1';
    // 每个 instance 独立的 axios（支持测试时传 mock adapter 包装的 instance）
    this.axios = axiosInstance || axios.create();
    this.disableThinking = options.disableThinking ?? false;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /** 瞬时错误判定:429（限流）、5xx（服务端）、网络/超时（无 response）。 */
  private isTransient(error: unknown): boolean {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 429) return true;
      if (status !== undefined && status >= 500 && status <= 599) return true;
      // 无 response = 网络错误 / 超时（ECONNABORTED、ECONNRESET 等）
      if (status === undefined) return true;
    }
    return false;
  }

  /**
   * 调用聊天完成接口
   */
  async chat(model: string, messages: ChatMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    const timeoutMs = options.timeoutMs ?? 30000; // 默认 30s 防卡
    const body = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 2000,
      top_p: options.top_p ?? 0.9,
      stream: false,
      // 关闭推理:构造时 disableThinking 则全局注入;单次调用 extraBody 可覆盖/补充。
      ...(this.disableThinking ? { enable_thinking: false } : {}),
      ...(options.extraBody ?? {}),
    };
    const requestConfig = {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    };

    // 有界指数退避:瞬时错误（429/5xx/超时）重试,退避 500ms·2^n + 抖动;
    // 非瞬时错误（4xx 语义错误）立即抛出,不浪费重试。
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.axios.post(`${this.baseURL}/chat/completions`, body, requestConfig);
        return {
          content: response.data.choices[0].message.content,
          usage: {
            prompt_tokens: response.data.usage?.prompt_tokens || 0,
            completion_tokens: response.data.usage?.completion_tokens || 0,
            total_tokens: response.data.usage?.total_tokens || 0,
          },
          model: response.data.model,
        };
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries && this.isTransient(error)) {
          const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        break;
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`SiliconFlow API error: ${message}`);
  }

  /**
   * 结构化输出调用（让 LLM 返回 JSON）
   * 修复：简化 prompt，避免模型把格式指令当作要分析的内容
   *
   * 返回的 data 字段类型为泛型 T（默认 unknown）；调用方负责按领域类型收窄。
   */
  async chatWithJson<T = unknown>(
    model: string,
    messages: ChatMessage[],
    schema: Record<string, unknown> = {},
    options: { max_tokens?: number; jsonMode?: boolean } = {},
  ): Promise<LLMJsonResponse<T>> {
    // 把格式要求合并到 system 消息，避免注入问题
    const schemaStr = JSON.stringify(schema, null, 2);
    const systemPrompt = `你是一个 JSON 生成器。请严格根据用户请求返回合法的 JSON，不要包含任何额外解释。\n\n要求的 JSON 格式：\n${schemaStr}`;

    const enhancedMessages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...messages];

    // max_tokens 默认 1000；打分等含多候选推导的调用可上调，避免大模型冗长输出被截断成非法 JSON。
    // jsonMode=true 时经 response_format 强制端点输出合法 JSON（OpenAI 兼容），
    // 主要救小模型的格式截断；对大模型是 no-op（本就输出合法 JSON）。
    const result = await this.chat(model, enhancedMessages, {
      temperature: 0.1,
      max_tokens: options.max_tokens ?? 1000,
      ...(options.jsonMode ? { extraBody: { response_format: { type: 'json_object' } } } : {}),
    });

    // 提取 JSON
    let content = result.content.trim();
    // 去掉可能的 markdown code block 标记
    content = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      content = jsonMatch[0];
    }

    try {
      return {
        ...result,
        data: JSON.parse(content) as T,
      };
    } catch {
      throw new Error(`Failed to parse JSON from LLM response: ${content.slice(0, 200)}`);
    }
  }
}
