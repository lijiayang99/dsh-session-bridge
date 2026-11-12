# dsh-session-bridge 0.5.0-rc.22

适用于 DeepSeek Harness Web 0.2.2-rc.1，Node 24.9 或更新版本。

打开右栏「开始 → dsh-session-bridge」，启用会话互传并勾选要互传的既有独立窗口。勾选的任意两窗可双向发送。取消勾选一端或关闭总开关后，新的桥接消息停止投递。已进入宿主收件队列的消息由 DSH 处理。

直接在聊天中说明要让哪个窗口做什么。Agent 可以先查可达窗口，再发送问题、追加要求、回报进展或将结果发回原窗口。文件、命令、外部操作和原生子代理使用各自的 DSH 权限与审批。

## Agent 工具

`workflow_message` 支持三种用法。

| 用法 | 参数 |
| --- | --- |
| 查可达窗口 | 无参数或 `{"action":"list"}`。返回其他已勾选的独立窗口的标题和 ID。 |
| 发消息 | `to` 为完整标题或 ID，`text` 为正文。可省略 `action` 和 `request_id`。收到消息的 Agent 可按消息里的发送方 ID 回传。 |
| 查已有回执 | `{"action":"status","request_id":"…"}`。旧任务的会话消息回执可另附 `job`。 |

标题同名时使用可达列表中的 ID。宿主在实际投递前核对两端选中状态和收件绑定。同一发送轮重复调用同一目标和正文会返回原回执，跨轮重试可以复用原请求号。投递结果未知时可查回执，插件不会自动重发。原生子代理继续使用宿主的 `send_message`。

## 换包与回退

`rc.22` 使用 `messagingEnabled` 和 `messagingSessions`。首次换入时默认关闭、名单为空。历史 `enabled`、`workflowEnabled` 和 `allowedSessions` 留给旧包回退。右栏保存当前的两项设置。

从固定 `rc.20` 换包前，核对在途会话和任务，备份当前 Web profile 配置、普通回执目录和工作流账本。停用旧插件后换入候选。候选不会打开旧工作流账本或继续旧队列。原会话消息回执保留在同一目录。

回退时关闭候选总开关，等待在途投递结算。先将旧 `enabled` 配置设为关闭，再停用候选并换回固定 `rc.20`。核对安装版本、旧回执、账本和未结队列，确认后按需要恢复旧开关。旧调度器在旧开关重新打开后会按旧账本恢复，先处理需要继续暂停或撤回的旧任务。

## 隔离复验

```bash
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \\
  node test/collaboration-allowlist-rc22.mjs "$dsh" "$fixed_rc20" "$candidate" "$playwright_module" "$chrome"
```

脚本用独立临时 Web profile、合成模型和会话，从旧包热换入候选。通过 Chrome 勾选两端，核对跨工作区互传、回执去重、设置重启持久和回退。
