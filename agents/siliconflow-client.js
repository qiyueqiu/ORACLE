/**
 * SiliconFlow API 工具类
 * 用于调用 LLM 进行意图解析、决策和任务执行
 */

const axios = require('axios');

class SiliconFlowClient {
  constructor(apiKey, axiosInstance) {
    this.apiKey = apiKey;
    this.baseURL = 'https://api.siliconflow.cn/v1';
    // 每个 instance 独立的 axios（支持测试时传 mock adapter 包装的 instance）
    this.axios = axiosInstance || axios.create();
  }

  /**
   * 调用聊天完成接口
   * @param {string} model - 模型名称
   * @param {Array} messages - 消息列表
   * @param {Object} options - 额外选项
   */
  async chat(model, messages, options = {}) {
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
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
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
      throw new Error(`SiliconFlow API error: ${error.message}`);
    }
  }

  /**
   * 结构化输出调用（让 LLM 返回 JSON）
   * 修复：简化 prompt，避免模型把格式指令当作要分析的内容
   */
  async chatWithJson(model, messages, schema = {}) {
    // 把格式要求合并到 system 消息，避免注入问题
    const schemaStr = JSON.stringify(schema, null, 2);
    const systemPrompt = `你是一个 JSON 生成器。请严格根据用户请求返回合法的 JSON，不要包含任何额外解释。\n\n要求的 JSON 格式：\n${schemaStr}`;

    const enhancedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

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
        data: JSON.parse(content),
      };
    } catch (e) {
      throw new Error(`Failed to parse JSON from LLM response: ${content.slice(0, 200)}`);
    }
  }
}

module.exports = { SiliconFlowClient };