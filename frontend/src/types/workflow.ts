/**
 * 工作流步骤接口
 */
export interface WorkflowStep {
  /** 步骤名称/标识符 */
  step: string;
  /** 步骤状态 */
  status: "pending" | "running" | "completed" | "error";
  /** 可选的消息 */
  message?: string;
  /** 时间戳 */
  timestamp: number;
  /** 可选的总结信息 (仅在完成时) */
  summary?: string;
  /** 可选的输出路径 (仅在完成时) */
  outputPath?: string;
  isCritical?: boolean; // 标记错误是否是致命的
}
