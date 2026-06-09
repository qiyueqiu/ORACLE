// ORACLE Subgraph Mapping（M2 改造 10）
// 处理 AuditLog 事件 → 写入 GraphQL 可查询实体

import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import {
  ScheduleLogged,
  ExecutionUpdated,
  RatingSubmitted,
  RouterDecisionLogged,
} from "../generated/AuditLog/AuditLog";
import {
  ScheduleRecord as ScheduleRecordEntity,
  Agent as AgentEntity,
  RouterDecision as RouterDecisionEntity,
  Rating as RatingEntity,
} from "../generated/schema";

export function handleScheduleLogged(event: ScheduleLogged): void {
  let record = new ScheduleRecordEntity(event.params.recordId.toString());
  record.timestamp = event.block.timestamp;
  record.requester = event.params.requester;
  record.taskCommitment = event.params.taskCommitment;
  record.decisionReason = event.params.reason;
  record.executionStatus = 0;  // PENDING
  record.targetAgent = event.params.targetAgent.toHexString();
  record.save();
  log.info("ScheduleLogged recordId={} target={}", [
    event.params.recordId.toString(),
    event.params.targetAgent.toHexString(),
  ]);
}

export function handleExecutionUpdated(event: ExecutionUpdated): void {
  let record = ScheduleRecordEntity.load(event.params.recordId.toString());
  if (record == null) {
    log.warning("ExecutionUpdated for unknown recordId={}", [event.params.recordId.toString()]);
    return;
  }
  record.executionStatus = event.params.status;
  record.executionResult = event.params.result;
  record.workerSigner = event.params.workerSigner;
  record.save();
}

export function handleRatingSubmitted(event: RatingSubmitted): void {
  let record = ScheduleRecordEntity.load(event.params.recordId.toString());
  if (record == null) return;
  record.reputationRating = event.params.rating;
  record.save();
  let rating = new RatingEntity(event.params.recordId.toString());
  rating.record = record.id;
  rating.rating = event.params.rating;
  rating.timestamp = event.block.timestamp;
  rating.save();
}

export function handleRouterDecisionLogged(event: RouterDecisionLogged): void {
  let record = ScheduleRecordEntity.load(event.params.recordId.toString());
  if (record == null) return;
  record.routerSigner = event.params.routerSigner;
  record.decisionDigest = event.params.decisionDigest;
  record.save();
  let decision = new RouterDecisionEntity(event.params.recordId.toString());
  decision.record = record.id;
  decision.routerSigner = event.params.routerSigner;
  decision.decisionDigest = event.params.decisionDigest;
  decision.timestamp = event.block.timestamp;
  decision.save();
}
