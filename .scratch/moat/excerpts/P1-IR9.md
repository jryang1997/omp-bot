# P1-IR9 · resume_parent

保存的真实父 scope、幂等键、BlockedDependentRunGate 前置条件

证据类型 `SRC`。本轮未执行项目代码或测试。

[固定提交源码](https://github.com/nearai/ironclaw/blob/b0b999d96781516ee05e6ba961d6f3ead900da96/crates/loop/ironclaw_turn_runner/src/subagent/await_edge/resolver.rs#L585-L636)

完整源文件 [本地快照](原研究包 evidence/source-files)，SHA256 `44ae4f9084b6f1211d0d32a7b667d9516a9591e1789804f0524b1cfc79a50ebb`。

```text
   585      async fn resume_parent(
   586          &self,
   587          edge: &AwaitEdge,
   588          parent_run_id: TurnRunId,
   589          child_run_id: TurnRunId,
   590      ) -> Result<(), TurnError> {
   591          let actor =
   592              edge.parent_run_context
   593                  .actor
   594                  .clone()
   595                  .ok_or_else(|| TurnError::InvalidRequest {
   596                      reason: "subagent parent run context missing actor for resume".to_string(),
   597                  })?;
   598          let coordinator = self
   599              .coordinator
   600              .get()
   601              .ok_or_else(|| TurnError::Unavailable {
   602                  reason: "await-edge resolver coordinator is not bound".to_string(),
   603              })?;
   604          // Use the parent's real scope captured at open/reconstruct time
   605          // (`edge.parent_run_context.scope`), not a hand-rebuilt `TurnScope`
   606          // from the child's axes + `parent_thread_id` — a rebuilt scope
   607          // defaults `thread_owner` to `ActorFallback`, which doesn't match a
   608          // parent scope carrying `TurnThreadOwner::ExplicitUser` and makes
   609          // `resume_turn` fail closed with `ScopeNotFound` (found live against
   610          // the e2e harness).
   611          let parent_scope = edge.parent_run_context.scope.clone();
   612          let result = coordinator
   613              .resume_turn(ResumeTurnRequest {
   614                  scope: parent_scope,
   615                  actor,
   616                  run_id: parent_run_id,
   617                  gate_resolution_ref: edge.gate_ref.clone(),
   618                  idempotency_key: IdempotencyKey::new(format!(
   619                      "subagent-resume:{parent_run_id}:{child_run_id}"
   620                  ))
   621                  .map_err(|reason| TurnError::InvalidRequest { reason })?,
   622                  // Pin the resume to the dependent-run gate so a child
   623                  // termination cannot unblock a parent that is actually
   624                  // waiting on an unrelated approval/auth/resource gate.
   625                  precondition: ResumeTurnPrecondition::BlockedDependentRunGate,
   626                  resume_disposition: None,
   627              })
   628              .await;
   629          result.map(|_| ()).or_else(|error| {
   630              if is_benign_already_resumed(&error) {
   631                  Ok(())
   632              } else {
   633                  Err(error)
   634              }
   635          })?;
   636          Ok(())
```
