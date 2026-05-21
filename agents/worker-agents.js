/**
 * 专业化 Worker Agent 工厂
 * 根据资质类型创建不同专长的 Agent
 */

const { SiliconFlowClient } = require('./siliconflow-client');

const QUALIFICATION_CONFIG = {
  code_review: {
    name: '代码审查助手',
    icon: '🔍',
    systemPrompt: `你是一位资深代码审查专家。你的职责：
1. 分析代码的逻辑正确性
2. 检测潜在的安全漏洞
3. 评估代码质量和可维护性
4. 提供具体的优化建议
请使用 <思考> 标签展示分析过程，<结果> 标签给出最终审查报告。`,
    complexModel: 'deepseek-ai/DeepSeek-V3',
    simpleModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  data_analysis: {
    name: '数据分析助手',
    icon: '📊',
    systemPrompt: `你是一位专业的数据分析师。你的职责：
1. 理解数据分析需求
2. 提供统计分析方法建议
3. 解读数据趋势和模式
4. 给出数据驱动的结论和建议
请使用 <思考> 标签展示分析过程，<结果> 标签给出最终分析结果。`,
    complexModel: 'deepseek-ai/DeepSeek-V3',
    simpleModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  translation: {
    name: '翻译助手',
    icon: '🌐',
    systemPrompt: `你是一位专业多语言翻译专家。你的职责：
1. 准确翻译文本内容
2. 保持原文的语气和风格
3. 处理专业术语和文化差异
4. 提供翻译注释（必要时）
请使用 <思考> 标签展示翻译策略，<结果> 标签给出最终翻译结果。`,
    complexModel: 'Qwen/Qwen2.5-7B-Instruct',
    simpleModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  research: {
    name: '研究助手',
    icon: '🔬',
    systemPrompt: `你是一位严谨的研究分析专家。你的职责：
1. 深入分析研究主题
2. 整理关键信息和观点
3. 对比不同立场和论据
4. 形成结构化的研究总结
请使用 <思考> 标签展示研究思路，<结果> 标签给出最终研究报告。`,
    complexModel: 'deepseek-ai/DeepSeek-V3',
    simpleModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  creative: {
    name: '创意写作助手',
    icon: '✍️',
    systemPrompt: `你是一位富有创造力的写作专家。你的职责：
1. 根据需求创作各类内容（文案、故事、诗歌等）
2. 把握文字的节奏和韵律
3. 运用恰当的修辞手法
4. 确保内容的原创性和吸引力
请使用 <思考> 标签展示创作思路，<结果> 标签给出最终作品。`,
    complexModel: 'deepseek-ai/DeepSeek-V3',
    simpleModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  weather: {
    name: '天气服务助手',
    icon: '🌤️',
    systemPrompt: `你是一个天气服务助手。根据用户描述，提供天气相关的信息和建议。
请使用 <思考> 标签展示分析过程，<结果> 标签给出最终回复。`,
    complexModel: 'Qwen/Qwen2.5-7B-Instruct',
    simpleModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  content: {
    name: '内容创作助手',
    icon: '📝',
    systemPrompt: `你是一个内容创作助手。根据用户需求，创作相关内容。
请使用 <思考> 标签展示创作思路，<结果> 标签给出最终内容。`,
    complexModel: 'deepseek-ai/DeepSeek-V3',
    simpleModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  calc: {
    name: '计算助手',
    icon: '🔢',
    systemPrompt: `你是一个计算助手。帮助用户进行各种计算任务。请展示详细的计算过程。
请使用 <思考> 标签展示计算步骤，<结果> 标签给出最终答案。`,
    complexModel: 'deepseek-ai/DeepSeek-V3',
    simpleModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
};

class WorkerAgent {
  constructor(apiKey, agentInfo) {
    this.llm = new SiliconFlowClient(apiKey);
    this.info = agentInfo;
    this.config = QUALIFICATION_CONFIG[agentInfo.qualification] || QUALIFICATION_CONFIG.content;
    this.executionLog = [];
  }

  async execute(taskDescription, context = {}) {
    const model = this.selectModel(taskDescription);
    const prompt = this.buildPrompt(taskDescription, context);
    const stepId = this.generateStepId();
    const startTime = Date.now();

    const result = await this.chatWithChainOfThought(model, prompt);

    const logEntry = {
      stepId,
      stepType: 'llm_call',
      agent: this.info.did,
      address: this.info.address,
      model,
      phase: 'task_execution',
      input: taskDescription,
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
      model,
      agentType: this.info.qualification,
    };
  }

  buildPrompt(taskDescription, context) {
    return `${this.config.systemPrompt}

任务描述: ${taskDescription}

${context.selectedAgent ? `说明: 你是被系统选中的最优 Agent (${this.config.name})，信誉评分: ${context.reputation || 'N/A'}` : ''}`;
  }

  async chatWithChainOfThought(model, prompt) {
    const response = await this.llm.chat(model, [
      { role: 'system', content: this.config.systemPrompt },
      { role: 'user', content: prompt }
    ], { temperature: 0.7, max_tokens: 2000 });

    const content = response.content;
    let chainOfThought = '';
    let result = content;

    const thinkMatch = content.match(/<思考>([\s\S]*?)<\/思考>/);
    if (thinkMatch) chainOfThought = thinkMatch[1].trim();

    const resultMatch = content.match(/<结果>([\s\S]*?)<\/结果>/i);
    if (resultMatch) result = resultMatch[1].trim();
    else {
      const resultMatch2 = content.match(/<结果>([\s\S]*?)<\/result>/i);
      if (resultMatch2) result = resultMatch2[1].trim();
    }

    return { content: result, chainOfThought, usage: response.usage };
  }

  selectModel(taskDescription) {
    const isComplex = taskDescription.length > 100 ||
      taskDescription.includes('分析') ||
      taskDescription.includes('详细') ||
      taskDescription.includes('复杂');
    return isComplex ? this.config.complexModel : this.config.simpleModel;
  }

  generateStepId() {
    return `0x${Buffer.from(`${Date.now()}-${Math.random()}`).toString('hex').slice(0, 64)}`;
  }
}

module.exports = { WorkerAgent, QUALIFICATION_CONFIG };
