# P1-HE8 · claim / release / complete_completion_delivery

通知交付租约、次数上限、拒绝过时回调、delivered/dropped 分离

证据类型 `SRC`。本轮未执行项目代码或测试。

[固定提交源码](https://github.com/NousResearch/hermes-agent/blob/b3710e60823f108945fce9804201fb3b001a716c/tools/async_delegation.py#L461-L556)

完整源文件 [本地快照](原研究包 evidence/source-files)，SHA256 `1bcff60c59c453f1e3d7d049bcf525b727df07c1d7e1eeb45ba0776598c3c2b6`。

```text
   461  def claim_completion_delivery(delegation_id: str, claim_id: str) -> bool:
   462      """Claim one pending completion across competing consumers/processes."""
   463      if remote := worker_ledger():
   464          return remote.claim(delegation_id, claim_id)
   465      now = time.time()
   466      with _DB_LOCK, _transaction() as conn:
   467          row = conn.execute(
   468              "SELECT delivery_state FROM async_delegations WHERE delegation_id=?", (delegation_id,)).fetchone()
   469          if row is None:
   470              return True  # legacy event created before durable dispatch
   471          cur = conn.execute("""UPDATE async_delegations SET delivery_claim=?, delivery_claimed_at=?,
   472                        delivery_attempts=delivery_attempts+1, updated_at=?
   473                 WHERE delegation_id=? AND delivery_state='pending'
   474                   AND (delivery_claim IS NULL OR delivery_claimed_at < ?)""",
   475              (claim_id, now, now, delegation_id, now - _CLAIM_LEASE_S))
   476          return cur.rowcount == 1
   477  
   478  
   479  def is_interim_delegation_event(evt: dict[str, Any]) -> bool:
   480      """An early per-task notice for a batch that is still running. It shares the batch's
   481      ``delegation_id`` but is NOT the durable completion: it must never claim, acknowledge or
   482      dedup against the final result's row (independent review reproduced exactly that loss)."""
   483      return evt.get("type") == "async_delegation" and bool(evt.get("task_failure_notice"))
   484  
   485  
   486  def claim_event_delivery(evt: dict[str, Any], consumer: str) -> Optional[str]:
   487      """Claim a durable delegation event; non-durable events (and interim notices) need no token."""
   488      if is_interim_delegation_event(evt):
   489          return ""
   490      delegation_id = str(evt.get("delegation_id") or "") if evt.get("type") == "async_delegation" else ""
   491      if not delegation_id:
   492          return ""
   493      claim_id = f"{consumer}:{os.getpid()}:{uuid.uuid4().hex}"
   494      return claim_id if claim_completion_delivery(delegation_id, claim_id) else None
   495  
   496  
   497  def release_completion_delivery(delegation_id: str, claim_id: str) -> bool:
   498      """Release a failed delivery claim so another consumer may retry. Attempts are
   499      counted at claim time; once the budget is exhausted the row converges to
   500      terminal ``dropped`` (only pending rows replay on restart)."""
   501      if remote := worker_ledger():
   502          return remote.release(delegation_id, claim_id)
   503      now = time.time()
   504      with _DB_LOCK, _transaction() as conn:
   505          capped = conn.execute("""UPDATE async_delegations SET delivery_state='dropped',
   506                        delivery_claim=NULL, delivery_claimed_at=NULL, updated_at=?
   507                 WHERE delegation_id=? AND delivery_state='pending'
   508                   AND delivery_claim=? AND delivery_attempts>=?""",
   509              (now, delegation_id, claim_id, _MAX_DELIVERY_ATTEMPTS))
   510          if capped.rowcount == 1:
   511              logger.warning("Async delegation %s exhausted its %d delivery attempts; "
   512                             "marking terminally dropped (result remains queryable).",
   513                             delegation_id, _MAX_DELIVERY_ATTEMPTS)
   514              return True
   515          cur = conn.execute("""UPDATE async_delegations SET delivery_claim=NULL,
   516                        delivery_claimed_at=NULL, updated_at=?
   517                 WHERE delegation_id=? AND delivery_state='pending'
   518                   AND delivery_claim=?""", (now, delegation_id, claim_id))
   519          return cur.rowcount == 1
   520  
   521  
   522  def defer_completion_delivery(delegation_id: str, claim_id: str) -> bool:
   523      """Return an unadmitted completion to pending without spending a delivery attempt."""
   524      if remote := worker_ledger():
   525          return remote.defer(delegation_id, claim_id)
   526      return _update_delivery("""UPDATE async_delegations SET delivery_claim=NULL,
   527                    delivery_claimed_at=NULL, delivery_attempts=MAX(0, delivery_attempts-1),
   528                    updated_at=?
   529             WHERE delegation_id=? AND delivery_state='pending' AND delivery_claim=?""",
   530          (time.time(), delegation_id, claim_id))
   531  
   532  
   533  def drop_completion_delivery(delegation_id: str, claim_id: str) -> bool:
   534      """Terminally drop a claimed completion whose target is permanently gone (the
   535      spawning session ended at an explicit user boundary such as /new or reset).
   536      ``dropped`` — not ``delivered`` — keeps the ack honest; not ``pending`` keeps
   537      restart recovery from replaying it into a fail-closed drop forever."""
   538      if remote := worker_ledger():
   539          return remote.drop(delegation_id, claim_id)
   540      return _update_delivery("""UPDATE async_delegations SET delivery_state='dropped',
   541                    updated_at=?, delivery_claim=NULL,
   542                    delivery_claimed_at=NULL
   543             WHERE delegation_id=? AND delivery_state='pending'
   544               AND delivery_claim=?""", (time.time(), delegation_id, claim_id))
   545  
   546  
   547  def complete_completion_delivery(delegation_id: str, claim_id: str) -> bool:
   548      """Acknowledge acceptance for the consumer holding this claim."""
   549      if remote := worker_ledger():
   550          return remote.ack(delegation_id, claim_id)
   551      now = time.time()
   552      return _update_delivery("""UPDATE async_delegations SET delivery_state='delivered',
   553                    delivered_at=?, updated_at=?, delivery_claim=NULL,
   554                    delivery_claimed_at=NULL
   555             WHERE delegation_id=? AND delivery_state='pending'
   556               AND delivery_claim=?""", (now, now, delegation_id, claim_id))
```
