# 批次状态接口

总控或执行者首次记录发布／核实断点时读取；纯资料维护不使用平台提交状态。本地脚本只保存状态与生成决策，不操作平台、不唤醒智能体；通常直接执行，无需加载源码。

```text
node <skill-dir>/scripts/run_state.mjs init <run-dir>/state.json <run-dir>/request.json
node <skill-dir>/scripts/run_state.mjs apply <run-dir>/state.json <run-dir>/event.json
node <skill-dir>/scripts/run_state.mjs inspect <run-dir>/state.json
node <skill-dir>/scripts/run_state.mjs inspect <run-dir>/state.json --record <record-id>
node <skill-dir>/scripts/run_state.mjs inspect <run-dir>/state.json --full
```

默认返回进度摘要及下一条动作，完整证据仍落盘。日常用摘要；处理或核查单条时用 `--record`，最终对账或排查跨记录冲突才用 `--full`。不要每步输出全量状态或整个文件。

摘要保留 `revision,worker,total,counts,canFinish,orchestrationAction`、精简控制权状态及 `cleanupMethod`，另有 `earliestNextCheckAt,nextAction`；先遵循调度动作，执行者仍运行时不能因 nextAction 又启动写入者。`apply` 的 `changed` 只含事件类型和变更记录数。`--record` 在摘要中加入完整 `record`，`--full` 返回原全量 `actions`；完整回写等记录证据用单条模式查。旧 CLI 调用若依赖默认 `actions`，需改用 `--full`；脚本编程接口未变。

请求：`{"batchId":"batch-example","recordIds":["record-a","record-b"],"requireFinalVerification":false}`。清单固定去重；最后一项按用户是否要求最终入仓／在售设置。

每个事件携带最新 `expectedRevision`；执行者事件还需 `workerId,generation`，逐条事件需 `recordId`。用 UTF-8 JSON 文件传参。revision 冲突先重读，不覆盖新状态；执行者恢复后先核对当前 generation 和页面事实。

## 总控事件

| type | 字段与条件 |
|---|---|
| `assign` | `workerId`；替换或重新分配前确认旧执行与工具调用已停止，再加 `previousWorkerStopped:true`。 |
| `reconcile_not_submitted` | `recordId,evidence,conclusive:true`；必须确凿证明未创建，一次查空不满足。 |
| `block` | `recordIds,kind:platform/auth/missing_input/control,evidence,nextAction`。有商品 ID 需 `stage:verification/writeback`；结果不明需 `stage:submission_resolution`，仅明确平台拒绝才加 `submissionRejected:true`。 |
| `unblock` | `recordIds,evidence`；恢复原断点、保留回执，未知提交仍先核实。 |
| `stop` / `resume_user` | 用户停止／明确恢复的 `evidence`，不能自行恢复用户授权。 |

阻塞也要回写；确因认证／控制权无法回写时，用 `writebackUnavailableEvidence` 记录事实，不伪造写回。`origin` 区分提交路径与历史商品，统计新增还需成功回执；`businessStatus` 保留阻塞前已确认的业务阶段。

## 执行者事件

| type | 字段与条件 |
|---|---|
| `worker_report` | `workerId,generation,kind:running/interrupted/done`，不需要 recordId；只报告执行状态。 |
| `step` / `fault` | `step,progressKey` 或 `code,message,recoverable`；真实新进展才改 progressKey。 |
| `begin_submit` | 点击前落盘唯一 `attemptId`。此后没有确定结果就先核实，即使不能证明已点击。 |
| `receipt` | 回执到达立即保存 `itemId,evidence`，未到核实时间时另存 ISO 格式 `nextCheckAt`。 |
| `existing` | 查重命中历史商品时存 `itemId,evidence,nextCheckAt`（可选），不伪造提交意图。 |
| `verify` | 匹配的 `itemId,outcome:warehouse/on_sale,evidence`。 |
| `writeback` | 实际写入且读回一致后存 `evidence,readbackConfirmed:true`；平台状态更新后需再回写。 |

## 控制权与持久化

`control_acquired` 保存 `spaceId,evidence`；实际释放并核实后，`control_released` 保存 `method:finish/handOff,evidence`。这些事件不能代替浏览器操作，时机见[浏览器收尾](supervision.md#浏览器收尾)。

旧 generation 被拒绝，不能据此断言旧远端请求已取消。`.lock` 残留时确认其进程和其他写入者已停止再清锁；状态缺失或损坏时从已保存回执、平台和飞书证据重建，禁止从头盲目提交。
