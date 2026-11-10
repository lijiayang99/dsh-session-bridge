# dsh-session-bridge 0.4.3-rc.1

适用于 DeepSeek Harness Web 0.2.2-rc.1。全新安装可通过「插件 → 添加插件」输入宿主机可读的包绝对路径并启用。已有版本请先按下文迁移。

右栏「开始 → dsh-session-bridge」有「启用会话消息」和「启用跨窗口任务委托」两个独立开关，共用会话白名单。先创建并使用主控、开发和审核会话，将它们加到白名单。

## 迁移与回退

1. 在旧版停发并排空队列，核对未结委托，关闭两个开关并读回。记录白名单和待核对的回执。将旧插件禁用，再完整停止使用同一 `DSH_HOME` 的所有宿主进程。
2. 备份相关配置和下表中实际存在的目录。编辑当前 Web profile 的 `cordis.patch.yml` 中属于 `@local/dsh-session-bridge` 的设置条目。若使用 HOME 级或启动参数的配置补丁，也检查相同设置 ID 的覆盖项。

   | 位置 | 旧名称 | 新名称 |
   | --- | --- | --- |
   | 配置补丁的条目 ID | `session-bridge-settings` | `dsh-session-bridge-settings` |
   | `DSH_HOME` 下的回执目录 | `session-bridge/receipts` | `dsh-session-bridge/receipts` |
   | 当前 Web profile 下的委托账本目录 | `session-bridge-workflow` | `dsh-session-bridge-workflow` |

3. 只移动存在的旧目录，保留其中的回执、SQLite 文件及旁车文件。先确认新路径无冲突，再创建新回执目录的父目录并移动整个 `receipts` 目录。遇到新旧两份目录或配置同时存在时，先对账，再继续换包。
4. 启动同一宿主，移除已禁用的旧插件，添加并启用本候选，再完整重启。读回包名、版本、开关和白名单，核对一条历史回执和一条历史委托。按原授权范围恢复开关。
5. 需要回退时，先按相同流程停发、排空、禁用和停止宿主，再将当前目录及设置条目改回旧名称。回退时使用当前数据，其中包含本候选运行后新增的记录。启动后换回原包，重启并复核配置与回执，再恢复开关。

## 一次授权任务委托

在原主控会话以 DSH 所有者发送一条消息。首行写 `授权委托`，随后写 JSON。以下会话 ID 为合成示例。

```text
授权委托
{"task":"fix-sample","ttlMinutes":120,"goal":"开发提交候选，审核如退回则返修并复审。通过后报告最终候选和审核依据。","scopes":[{"name":"develop","targets":["synth-developer"]},{"name":"review","targets":["synth-reviewer"]}]}
```

主控调用 `workflow_dispatch`，执行窗口从短任务通知调用 `workflow_claim`，再以 `workflow_report` 提交结构化结果。原主控从结果通知调用 `workflow_consume`，可在该轮继续派工或调用 `workflow_close` 收口。使用原主控会话的 `workflow_status` 查看任务和回执。需要人工决定或中断后对账时，由所有者输入 `继续委托 fix-sample` 恢复主控上下文。取消用 `取消委托 fix-sample`。单条待核对项由原主控所有者输入 `对账委托 任务ID 尝试UUID task`（结果方向用 `result`），换行填写判断。可用 `workflow_item_status` 读回证据和操作人。

账本将终态记录归入历史索引以释放活跃额度。报告交付与接续轮结束分别核对，中断会保留该轮已提交的派工。损坏的接续会归档为 `quarantined`，可查询原值与原因，且同一主控可继续接收健康结果。原 0.4.0 账本会原地迁移，换包前备份整个委托账本目录。

同一执行窗口串行领取。忙时等待，未知投递或中断执行保留待核对。取消和到期阻止后续派发和自动接续，已经运行的工具仍由宿主控制。授权中的 scope 约束派工路由与类别，文件权限和外部操作由 DSH 宿主审批和工具权限决定。

## 普通互传

在发送会话由 DSH 所有者输入 `授权互传 目标会话ID 请求号`，下一行开始写准确正文。助手用 `send_session_message` 按原样发送，从原发送会话用 `session_message_status` 查投递和处理。精确重试只返回已有回执。迁移保留回执内容和去重键。目标轮次正常回复并落盘仅证明处理，项目验收仍要看结构化结果和产物。
