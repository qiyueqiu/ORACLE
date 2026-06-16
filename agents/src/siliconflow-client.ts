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
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class SiliconFlowClient {
  private apiKey: string;
  private baseURL: string;
  private axios: AxiosInstance;

  constructor(apiKey: string, axiosInstance?: AxiosInstance) {
    this.apiKey = apiKey;
    this.baseURL = 'https://api.siliconflow.cn/v1';
    // 每个 instance 独立的 axios（支持测试时传 mock adapter 包装的 instance）
    this.axios = axiosInstance || axios.create();
  }

  /**
   * 调用聊天完成接口
   */
  async chat(model: string, messages: ChatMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    const timeoutMs = options.timeoutMs ?? 30000; // 默认 30s 防卡
    try {
      const response = await this.axios.post(
        `${this.baseURL}/chat/completions`,
        {
          model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.max_tokens ?? 2000,
          top_p: options.top_p ?? 0.9,
          stream: false,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: timeoutMs,
        },
      );

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
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`SiliconFlow API error: ${message}`);
    }
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
  ): Promise<LLMJsonResponse<T>> {
    // 把格式要求合并到 system 消息，避免注入问题
    const schemaStr = JSON.stringify(schema, null, 2);
    const systemPrompt = `你是一个 JSON 生成器。请严格根据用户请求返回合法的 JSON，不要包含任何额外解释。\n\n要求的 JSON 格式：\n${schemaStr}`;

    const enhancedMessages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...messages];

    const result = await this.chat(model, enhancedMessages, { temperature: 0.1, max_tokens: 1000 });

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
