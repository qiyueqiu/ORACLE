/**
 * Worker Agent - LLM 驱动的任务执行器
 * 负责接收任务、调用 LLM 处理、返回结果
 */

const { SiliconFlowClient } = require('./siliconflow-client');

class WorkerAgent {
  constructor(apiKey, agentInfo) {
    this.llm = new SiliconFlowClient(apiKey);
    this.info = agentInfo; // { address, did, qualification }
    this.executionLog = [];
  }

  /**
   * 执行任务
   */
  async execute(taskDescription, context = {}) {
    const prompt = this.buildPrompt(taskDescription, context);
    const stepId = this.generateStepId();
    const startTime = Date.now();

    try {
      // 根据任务类型选择合适的模型
      const model = this.selectModel(taskDescription);

      const result = await this.chatWithChainOfThought(model, prompt);

      const logEntry = {
        stepId,
        stepType: 'llm_call',
        agent: this.info.did,
        address: this.info.address,
        model,
        phase: 'task_execution',
        input: prompt,
        output: result.content,
        chainOfThought: result.chainOfThought,
        tokens: result.usage.total_tokens,
        timestamp: Math.floor(startTime / 1000),
        duration: Date.now() - startTime,
      };

      this.executionLog.push(logEntry);

      return {
        result: result.content,
        chainOfThought: result.chainOfThought,
        executionLog: this.executionLog,
        tokens: result.usage.total_tokens,
      };
    } catch (error) {
      throw new Error(`Task execution failed: ${error.message}`);
    }
  }

  /**
   * 构建提示词
   */
  buildPrompt(taskDescription, context) {
    const qualHints = {
      weather: '你是一个天气服务助手。根据用户描述，提供天气相关信息。',
      content: '你是一个内容创作助手。根据用户需求，创作相关内容。',
      calc: '你是一个计算助手。帮助用户进行各种计算任务。',
    };

    const basePrompt = qualHints[this.info.qualification] || '你是一个 AI 助手。';

    return `${basePrompt}

任务描述: ${taskDescription}

${context.selectedAgent ? `说明: 你是被选中的最优 Agent，信誉评分: ${context.reputation || 'N/A'}` : ''}

请:
1. 思考如何完成这个任务
2. 执行任务
3. 返回清晰的结果

返回格式:
<思考>
{你的思考过程}
</思考>

<结果>
{最终答案}
</结果>`;
  }

  /**
   * 带思考链的对话
   */
  async chatWithChainOfThought(model, prompt) {
    const response = await this.llm.chat(model, [
      {
        role: 'system',
        content: '你是一个专业的 AI 助手。请使用 <思考> 标签展示你的思考过程，然后用 <结果> 标签给出最终答案。'
      },
      { role: 'user', content: prompt }
    ], { temperature: 0.7, max_tokens: 1500 });

    // 提取思考链和结果
    const content = response.content;
    let chainOfThought = '';
    let result = content;

    const thinkMatch = content.match(/<思考>([\s\S]*?)<\/思考>/);
    if (thinkMatch) {
      chainOfThought = thinkMatch[1].trim();
    }

    const resultMatch = content.match(/<结果>([\s\S]*?)<\/result>/i);
    if (resultMatch) {
      result = resultMatch[1].trim();
    }

    return {
      content: result,
      chainOfThought,
      usage: response.usage,
    };
  }

  /**
   * 根据任务选择模型
   */
  selectModel(taskDescription) {
    // 简单任务用小模型，复杂任务用大模型
    const isComplex = taskDescription.length > 100 ||
                      taskDescription.includes('分析') ||
                      taskDescription.includes('计算') ||
                      taskDescription.includes('创作');

    if (isComplex) {
      return 'deepseek-ai/DeepSeek-V3';
    }
    return 'Qwen/Qwen2.5-7B-Instruct';
  }

  generateStepId() {
    return `0x${Buffer.from(`${Date.now()}-${Math.random()}`).toString('hex').slice(0, 64)}`;
  }
}

module.exports = { WorkerAgent };
