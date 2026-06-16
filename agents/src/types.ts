/**
 * ORACLE Agent 编排层共享领域类型
 *
 * 这些类型刻画后端各模块之间流转的数据形状：配置、LLM 意图、
 * 候选 Agent、执行结果、SSE 事件等。链上合约类型由 TypeChain
 * 生成（../typechain-types），不在此重复定义。
 */

/** 资质类型：与链上 qualificationType 字符串及 QUALIFICATION_CONFIG 键一一对应 */
export type Qualification =
  | 'code_review'
  | 'data_analysis'
  | 'translation'
  | 'research'
  | 'creative'
  | 'weather'
  | 'content'
  | 'calc';

export const QUALIFICATIONS: readonly Qualification[] = [
  'code_review',
  'data_analysis',
  'translation',
  'research',
  'creative',
  'weather',
  'content',
  'calc',
] as const;

/** 运行时校验：把任意字符串收敛为合法 Qualification（默认 content） */
export function toQualification(value: unknown): Qualification {
  return typeof value === 'string' && (QUALIFICATIONS as readonly string[]).includes(value)
    ? (value as Qualification)
    : 'content';
}

/** 应用配置（全部源自环境变量，启动时校验） */
export interface AppConfig {
  PORT: number;
  SILICONFLOW_API_KEY: string;
  PROVIDER_URL: string;
  CHAIN_ID: number;
  CONTRACT_ADDRESSES: {
    AgentDID: string;
    AuditLog: string;
    Reputation: string;
  };
  ROUTER_SIGNER_PK: string;
  REPUTATION_SIGNER_PK: string;
  WORKER_DEMO_PK: string;
  EIP712_DOMAIN_NAME: string;
  EIP712_DOMAIN_VERSION: string;
  ACCESS_KEYS: string[];
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX: number;
}

/** LLM 解析出的任务意图 */
export interface Intent {
  intent: string;
  requiredQualification: Qualification;
  complexity: 'simple' | 'medium' | 'complex';
  priority: 'speed' | 'quality' | 'balance';
}

/** 候选 Agent（来自链上 AgentDID + Reputation） */
export interface Candidate {
  address: string;
  did: string;
  qualification: string;
  avgRating: number;
  ratingCount: number;
  isActive: boolean;
  score: number;
  reason?: string;
}

/** Router 评估结果 */
export interface EvalResult {
  candidates: Candidate[];
  decision: string;
}

/** Router 完整路由结果 */
export interface RouteResult {
  agent: Candidate;
  reason: string;
  executionLog: ExecutionLogEntry[];
}

/** 执行日志条目（Router / Worker 共用的结构化步骤记录） */
export interface ExecutionLogEntry {
  stepId: string;
  stepType: string;
  agent: string;
  address?: string;
  model?: string;
  phase: string;
  input: string;
  output: string;
  chainOfThought?: string;
  tokens?: number;
  timestamp: number;
  duration?: number;
}

/** Worker 执行结果 */
export interface ExecutionResult {
  result: string;
  chainOfThought: string;
  executionLog: ExecutionLogEntry[];
  tokens: number;
  model: string;
  agentType: string;
}

/** LLM 原始响应 */
export interface LLMResponse {
  content: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
}

/** LLM 结构化（JSON）响应：data 为解析后的 JSON，边界类型为 unknown，调用方需收窄 */
export interface LLMJsonResponse<T = unknown> extends LLMResponse {
  data: T;
}

/** SSE 事件类型（判别联合的 type 字段取值） */
export type SSEEventType =
  | 'start'
  | 'phase'
  | 'intent_parsed'
  | 'candidates'
  | 'evaluated'
  | 'selected'
  | 'thinking'
  | 'chain_of_thought'
  | 'result'
  | 'logged'
  | 'reputation_analyzed'
  | 'complete'
  | 'error';

/** SSE 事件 payload（taskId 由发送器统一注入） */
export type SSEEventData = Record<string, unknown>;
