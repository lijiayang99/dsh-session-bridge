# dsh-session-bridge 0.5.0-rc.20

适用于 DeepSeek Harness Web 0.2.2-rc.1。全新安装可通过「插件 → 添加插件」输入宿主机可读的包绝对路径并启用。已有版本请先按下文迁移。

在当前会话打开右栏「开始 → dsh-session-bridge」。总开关同时控制会话互传和任务委托。关闭后停止新的桥接投递。已经进入宿主队列的工作由 DSH 处理。重新启用后，仍有效的新版本授权和已入账队列可继续执行，按原回执去重。

状态日志按时间显示当前窗口参与的最近 160 条事件，含双方窗口标题、方向、状态和可用的固定原因。原主控与执行窗口均可读取各自参与的记录。重启或关闭总开关后仍可查看；任务和消息正文在各自会话中读取。

## 宿主兼容诊断

右栏诊断使用服务端授权门禁生成的状态。该状态随配置结构返回，配置值无法改写它。侧栏仅显示固定状态和支持版本。

| 侧栏或安装状态 | 含义 |
| --- | --- |
| 设置可读取 | 宿主通过固定的 DSH `0.2.2-rc.1` 版本检查。右栏显示保存后的总开关状态。 |
| 当前宿主不受支持 | 插件已加载，但宿主身份或版本未通过授权门禁。侧栏不提供编辑，新会话消息和任务委托不开放。已有会话消息的回执查询仍可用。 |
| 无法读取插件配置或宿主兼容状态 | 配置请求失败、配置条目或兼容标记缺失、设置数据无法读取。关闭并重新打开右栏可重试。 |
| 添加插件提示版本不兼容 | 插件管理器可能先按 `engines.dsh` 拒绝，侧栏此时尚未加载。在支持结构化错误的管理器里，`incompatible-version` 会显示运行的 DSH 版本与包的宿主要求。以添加对话框为准。 |

包的宿主要求仍为 DSH `0.2.2-rc.1`，Node 要求仍为 `24.9+`。从已完成命名迁移的版本换入时，设置 ID、回执和账本路径沿用。

## 迁移与回退

迁移使用同一个 Web profile 和 `DSH_HOME`。设置、普通回执和委托账本分别保存，换包时三者都要核对。

| 位置 | 旧名称（0.4.2） | 新名称 |
| --- | --- | --- |
| `@local/dsh-session-bridge` 配置条目 ID | `session-bridge-settings` | `dsh-session-bridge-settings` |
| `DSH_HOME` 下的回执目录 | `session-bridge/receipts` | `dsh-session-bridge/receipts` |
| 当前 Web profile 下的委托账本目录 | `session-bridge-workflow` | `dsh-session-bridge-workflow` |

### 从 0.4.2 升级

1. 在旧版停发并排空队列，核对未结委托。关闭会话消息与任务委托两个开关并读回。记录白名单和已有历史的核对样本。普通回执记请求号和结果，原委托用 `workflow_status` 与 `workflow_item_status` 记录主控窗口、任务键、尝试 UUID 和结果。确实没有记录的功能记为空态。
2. 禁用旧插件，完整停止所有使用同一 `DSH_HOME` 的宿主进程。备份当前配置和两个数据目录。调整当前 Web profile 的 `cordis.patch.yml` 中本包的条目 ID。若 HOME 级或启动参数补丁有同一条目的覆盖，一并核对。
3. 确认目标路径无冲突后，按表把**整个回执目录和整个委托账本目录**移到新名称。保留 SQLite 文件、旁车文件及其他内容。启动同一宿主，移除已禁用的旧插件，添加并启用候选，再完整重启。
4. 保持总开关关闭，核对安装版本、已有历史或已确认空态。委托按原证据对照任务键、尝试 UUID 和结果。通过后按需要开启总开关。候选期间若有新增委托，保留至少一条同类证据供回退核对。

### 回退到 0.4.2

1. 能操作候选时，核对在途工作并关闭总开关，读回关闭状态。按原证据核对已有普通回执和委托。在各自原主控用 `workflow_status` 和 `workflow_item_status` 查询，**原委托和候选新增委托两代均有记录时，各至少核对一条**，记录任务键、尝试 UUID 和结果。某一代确实为空时，记录是哪一代为空及确认依据。无需为升级或回退额外发送消息或派工。候选无法启动或历史读不到时，保留既有证据，将该功能记为待对账。
2. 禁用候选，完整停止使用同一 `DSH_HOME` 的所有宿主。备份当前配置和数据。按表恢复设置 ID、整个回执目录和**整个当前委托账本目录**到旧名称。保留已有记录、SQLite 文件及旁车文件。确实从未创建的数据目录记为缺省。有并存路径或来源不清时，分别保全现有数据，按下文对账后再移动。候选无法启动或历史有缺失时，仍可停用候选并恢复固定 0.4.2。启动旧包前，确认旧版生效配置中的两个功能开关均关闭。
3. 换回固定 0.4.2 后完整重启。核对版本、白名单和生效的关闭状态。按步骤 1 读回同一条普通回执及每一代已有的委托证据。某一代记录为空时，确认空态依据仍成立、完整现行账本已经迁回且新旧账本路径无并存。只有对应历史及设置均通过核对的功能才可恢复原开关。待对账的功能保持关闭。

### 停止与恢复门槛

- 历史缺失、尝试或结果不符，或无法区分空态与读不到时，停止恢复对应功能的开关，保留数据并对账。可以先在两个功能关闭的状态下恢复固定旧包。旧 0.4.2 找不到旧路径时会创建空账本。即使普通回执已能读取，仍须独立核对委托账本。历史缺失时不得对原任务重新授权或派发来补记录。
- 只完成部分迁移时，先停宿主，再按表逐项核对实际路径和设置。用备份、回执及原主控留存的委托证据确认当前完整数据。只完成剩余的移动，避免把已完成的部分再次覆盖。
- 新旧路径并存时，保留两侧，先核对来源。确认哪一侧是包含所需历史的完整数据后，将另一侧整个目录单独保全，再完成重命名和原生读回。发现空账本或分歧账本也按此处理。两侧均含独有历史或无法确认权威数据时，继续停用并逐项对账。不要覆盖、合并 SQLite 文件或按更新时间猜测。配置中两套条目并存时，同样先核对实际生效的设置及覆盖来源。

## 跨窗口任务

在原主控直接说「请让运维窗口检查合成电脑状态，不要做任何修改」或「你问一下02窗口，合成任务的进展怎么样？」。宿主从原生所有者输入取得任务和限制，按完整标题或当前工作区内的唯一短号核对目标。来源轮正常结束且持久证据吻合后，宿主把原文送到该窗口。目标同名或范围不清时，在原窗口澄清。

单窗口直接任务有效期为 30 分钟。执行窗口可以直接答复，宿主将答复送回原主控。执行窗口也可以提交带证据的结构化回报，原主控可用 `workflow_status` 核对收口。任务的只读等限制随原文送达，实际文件、命令和外部操作继续由各窗口的 DSH 权限及审批控制。

在原主控窗口输入「请把合成候选的实现交给开发窗口，把独立核查交给核查窗口，等两项都返回后交给审核窗口。审核退回就安排返修并复审」。主控生成方案，列出任务、目标、窗口标题、用途、有效期和总派工预算。看到完整预览且该轮结束后，在原主控回复「确认委托」。原主控 DSH 所有者的这条原生输入开立方案。窗口同名、目标或范围含糊时先澄清。回复「取消委托」可作废待确认方案。

主控在批准范围内并行派工、等齐汇总、按原任务返修和收口。共用执行窗口逐项领取。批次等待每项回报、失败或进入待核对，只返回一次结果通知。主控可查看部分失败并按剩余预算返修。遇到待核对或明确要求所有者决定的回报，主控从原窗口继续处理，确认后可输入 `继续委托 <任务>`。原主控可用 `workflow_status` 查询批次和各次尝试的证据。

### 原生子代理

如果任务可在主控窗口下另起子代理，直接请主控派一个本地子代理。固定 Web 的 Standard preset 提供宿主的 `subagent` 和 `send_message`。父子双方可以追加指示、提问和报告进展，子代理结束后宿主向父窗口回报。父子互传使用宿主的 `send_message`。总开关开启时，插件为可用的原生父窗口补上宿主因同轮主动发消息而省略的不同结束正文。已主动发过的相同正文只出现一次。

原生本地子代理带有宿主记录的父子血缘、父窗口的 sandbox 和 preset。宿主把子代理的审批策略设置为 `never`。遇到权限阻塞时，子代理把阻塞、所需动作及原因回给主控，由主控用 DSH 原生权限和审批继续处理。

### 同一任务持续往返

明确点名已存在的独立窗口时，可以说「请让99窗口核对合成候选并回报结果」。宿主核对原生所有者轮、当前工作区短号及目标是否可用后，按目标正文建立一项任务。复合或不清楚的要求先由主控拟定具体窗口、目标、用途、期限和预算。看到启用往返的完整预览后，在原窗口说「好」或「可以」。单窗口、一次派工的方案在确认轮结束后自动派工。多窗口方案沿用正式派工和审核流程。

同一任务内可直接追加、发问、回报进展或阻塞。比如「再问02窗口，刚才的合成记录还有什么变化？」。已有唯一绑定时，追加沿用原任务。主控有多项活动任务时，原生输入需指定足以消歧的窗口或任务。确认同一任务后，模型可用该任务内的已领取执行窗作为提示，宿主核对后选路。普通最终答复随本轮结束自动回到原主控。同一轮使用 `workflow_report` 提交结构化结果时，以该结果回传。

每次消息只在发送轮正常结束且核实原生来源后入宿主收件队列，使用任务内稳定请求号去重。混合输入、撤销、到期或收口会阻止继续发送。原主控已入宿主队列的同任务撤回也会挡住待发送消息。启动后可核对保留的回执，未投递或投递不明的消息不会自动重发。第三窗口须处于已批准的派工范围并领取自己的任务。独立窗口继续使用各自的宿主权限和审批。

### 用相邻对话问一个窗口

在原主控输入「你看一下02窗口今天干了啥，你问一下他」，或者先说「你看一下02窗口今天干了啥」，等该轮结束后再说「你问一下他」。前一句建立本轮话题，实际查问由带「问」的原生所有者输入触发。也可以直接说「帮我问问02窗口，插件还有哪些坑？」或「你问一下00-main做了那些事情」。直接连写完整窗口标题时，宿主从会话目录核对标题及后接问题的原文。派工按原话里的问题发送。独立分句撤回或追加外发、派工时，这句不走自动查问。多个窗口的任务可走方案预览和确认。

数字短号按标题开头的独立数字匹配，例如 `02-合成查询`。短号只在原主控所属工作区内匹配，未分组时只查未分组会话。集合内多个候选时，请回一个完整且唯一的标题，例如「是『02-合成查询』」。如果系统问要问什么，直接回复完整问题即可。相邻话题绑定前轮已解析的窗口和原文，目标变化时重新询问。上下文最长保留两分钟，取消、无关输入、中继、提前排队或宿主重启后请重新给出窗口和问题。

### 工具与验收接口

| 工具 | 参数与约束 |
| --- | --- |
| `workflow_message` | 明确的原生请求由宿主处理。无参数调用可查看当前请求状态。既有任务中可用 `text` 发送进展、问题或追加内容。可选 `target` 仅用于已绑定任务内的参与者提示，接受标题或已知 ID。请求拟稿时可传 `text`，返回完整可见预览。 |
| `workflow_propose` | `task`、`goal`、`ttlMinutes`、`budget`、`scopes`。用 `conversation: true` 生成可持续往返的可见方案。每个范围用 `name`、`windows`（宿主窗口标题）和 `purpose`。用户要求正式审核时，审核范围加 `review: true`，成功收口须有通过的固定产物。预算为整个任务可新建的尝试数，最多 32，包含返修。返回 `preview` 时主控须原样作为整条最终回复展示。 |
| `workflow_confirm` | 所有者在原窗口新回复「确认委托」后，无参数调用。成功返回冻结的任务、范围、已解析窗口 ID、预算和到期时间，可在该轮继续派工。 |
| `workflow_dispatch_batch` | `task`、`batch`、`completion`、`assignments`。每项填写 `item`、`attempt`、`target`、`scope`、`instructions`、`acceptance`。一次原子入账，成员固定，最多 16 项。等齐后原主控调用 `workflow_consume` 得到 `batch.items`。单项仍用 `workflow_dispatch`。 |
| `workflow_claim`、`workflow_report` | 执行窗口领取到本次尝试及用途后再执行。产出固定产物时，回报 `artifacts`，支持 `git:<40 位小写十六进制>` 或 `sha256:<64 位小写十六进制>`。 |
| 审核绑定 | 派工增加 `reviewOf`（原任务内产物尝试 ID）和 `artifact`（该尝试已回报的固定引用）。审核窗口在对应领取轮回报 `approved` 或 `changes_requested` 时，须用 `reviewedArtifact` 回传同一个引用。返修从原条目增加尝试号，复审重新绑定。 |
| `workflow_close` | 协作任务提供 `task`、`outcome`（`completed`、`partial` 或 `failed`）、`summary`，可带 `finalArtifacts`。返回 `closing` 后结束本轮。插件读到同一原生轮正常结束的持久证据后自动提交收口。成功收口须核实最新尝试与结果接续。有审核时，最终引用还须对应最新产物尝试的通过结论。 |

取消用 `取消委托 <任务>`。取消和到期会挡住后续派工与接续。已经进入宿主投递边界的尝试单独显示待核对，现有宿主工具负责停止执行。恢复只在已证实安全的边界继续。领取后缺回报、结果接续中断或已派出的下游动作不明时，由主控按回执对账。所有者核实已消费的结果后，可在原窗口用 `对账委托 <任务> <结果对应的尝试ID> result` 并换行写判断。账本保留中断和对账两份证据，已消费通知不会重发。插件校验窗口、预算、尝试与摘要绑定，任务正文与用途的语义仍由所有者和执行模型核对。文件、命令和外部操作继续由 DSH 权限及原生审批控制。产物引用可用本地 Git 或 SHA-256 对实际内容核验。

待核验的收口请求会冻结新派工，原主控仍可查看状态。同轮精确重试返回原请求，冲突请求会被拒绝。收口轮中断或缺少结束证据时，任务暂停并保留请求记录。原主控所有者核对未决接续后，可用 `继续委托 <任务>` 在新的原生轮请求收口。

固定宿主在轮次内追加的原生时间快照不会改变任务上下文。所有者或中继在同一轮提交额外输入时，暂停该轮的工作流操作，结果接续和收口会保留待核对状态。

### 原结构化授权

在原主控会话以 DSH 所有者发送一条消息。首行写 `授权委托`，随后写 JSON。以下会话 ID 为合成示例。

```text
授权委托
{"task":"fix-sample","ttlMinutes":120,"goal":"开发提交候选，审核如退回则返修并复审。通过后报告最终候选和审核依据。","scopes":[{"name":"develop","targets":["synth-developer"]},{"name":"review","targets":["synth-reviewer"]}]}
```

主控调用 `workflow_dispatch`，执行窗口从短任务通知调用 `workflow_claim`，再以 `workflow_report` 提交结构化结果。原主控从结果通知调用 `workflow_consume`，可在该轮继续派工或调用 `workflow_close` 收口。使用原主控会话的 `workflow_status` 查看任务和回执。需要人工决定或中断后对账时，由所有者输入 `继续委托 fix-sample` 恢复主控上下文。取消用 `取消委托 fix-sample`。单条待核对项由原主控所有者输入 `对账委托 任务ID 尝试UUID task`（结果方向用 `result`），换行填写判断。可用 `workflow_item_status` 读回证据和操作人。

账本将终态记录归入历史索引以释放活跃额度。报告交付与接续轮结束分别核对，中断会保留该轮已提交的派工。损坏的接续会归档为 `quarantined`，可查询原值与原因，且同一主控可继续接收健康结果。原 0.4.0 账本会原地迁移，换包前备份整个委托账本目录。

同一执行窗口串行领取。忙时等待，未知投递或中断执行保留待核对。取消和到期阻止后续派发和自动接续，已经运行的工具仍由宿主控制。授权中的 scope 约束派工路由与类别，文件权限和外部操作由 DSH 宿主审批和工具权限决定。

## 直接发送一条消息

在发送窗口说「给审核窗口发消息：候选已就绪，请开始复核」。本轮正常结束后，宿主按标题核对收件窗口并发送原文。若收件窗口与当前唯一任务绑定，消息沿该任务追加。标题或任务有多个候选时，宿主提示澄清。

如果请助手拟写正文，先在原窗口查看完整预览。核对收件人及正文后，回复「确认」或「可以」即可发送。预览只接受原窗口的下一条原生所有者确认，最长保留两分钟。宿主自动追加的原生时间快照保留预览和确认；同轮额外的所有者或中继输入会使本轮授权失效。

原发送窗口可用 `session_message_status` 读回已有回执。此前的回执、账本和去重键可继续查询。

### 左栏传递状态

普通互传、委托派工和结果回传在左侧会话行显示短期状态。宿主实际尝试投递时，两行均在视口内才出现从发送行到接收行的小飞机。结果回传沿相反方向飞。排队、已投递、执行、回传以及失败或待核对各有独立文字。已投递表示宿主接收了消息，任务验收以原主控会话中的结果和核对证据为准。原主控完成归档对账后，左栏显示已对账。

会话行折叠、滚出或隐藏，以及启用系统减少动态效果时，状态仍可在可见行上读取。重新展开或打开页面不会补播。每个页面只建立一条所有者活动订阅，同时最多显示四架飞机。活动数据仅保存在内存，限 128 条。委托活动保留至授权期限，普通互传的活动状态最多保留 15 分钟，终态保留 18 秒。活动流向宿主所有者提供在会话行显示方向、类型和状态所需的数据。

### 从 rc.18 停机换包与回退

1. 核对在途消息和委托，记录旧配置的 `enabled`、`workflowEnabled`、`allowedSessions`，以及用于核对的原回执、任务和结果。禁用旧插件并停止宿主。备份当前配置、回执和委托账本。三者的名称和路径沿用。
2. 在同一 Web profile 和 `DSH_HOME` 换入固定 rc.19 并重启。以保存的 `enabled` 决定总开关。旧 `workflowEnabled` 和 `allowedSessions` 保留在配置里供旧包回退。rc.19 将旧任务和回执留作核对，旧任务的排队条目不会补投。需要继续的任务由原主控所有者用明确的新请求授权。
3. 回退前核对在途工作，在 rc.19 收口或撤回活动委托并读回结果。保存完整账本和回执。换包前确认生效配置的 `enabled` 和旧 `workflowEnabled` 均为 `false`。右栏写入 `enabled`，旧 `workflowEnabled` 通过宿主设置另行核对。
4. 禁用候选并停止宿主，换回固定 rc.18 后重启。核对版本、两项关闭状态、原回执和两代结果。旧包恢复原开关前，先核对旧队列是否还有待执行授权。需要保留暂停的任务时，保持旧工作流开关关闭。

### 从 rc.19 停机换包与回退

两版使用同一配置项、Web profile、回执目录和委托账本。先核对并记录在途任务、开关和原回执，停用插件并完整停止宿主，备份配置和数据后换入固定包。重启后先保持总开关关闭，核对安装版本、开关、原回执与历史。按实际任务需要开启后，仍有效的已入账任务可继续处理。

回退前关闭总开关并读回，核对或收口在途工作，保全现有账本和回执。停用并停止宿主后换回固定 rc.19，先核对版本和两代历史，再恢复原开关。两个旧包共用持久去重记录，回退核验可直接查询已有结果。

### rc.20 隔离复验

使用 DSH Web 0.2.2-rc.1 和合成 loopback 模型。测试脚本建立临时 Web profile 和 `DSH_HOME`。

```bash
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  node test/collaboration-rc20.mjs "$dsh" "$candidate" "$playwright_module" "$chrome"

unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  node test/upgrade-rollback-rc20.mjs "$dsh" "$fixed_rc19" "$candidate"

unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  node test/collaboration-native-rc20.mjs "$dsh" "$candidate" "$playwright_module" "$chrome"
```

### 历史 rc.18 协作任务隔离复验

用 DSH Web `0.2.2-rc.1`、Node `24.22.2` 和 Chrome。在源码目录离线打包。合成模型、临时 DSH_HOME 和浏览器使用 loopback 网络命名空间。

```sh
lab="$(mktemp -d)"
npm pack --offline --pack-destination "$lab"
npm install --prefix "$lab/tools" playwright-core@1.65.0
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/collaboration.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.18.tgz" full \
  "$lab/tools/node_modules/playwright-core/index.mjs" "$(command -v google-chrome)"
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/collaboration.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.18.tgz" stress
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/collaboration-auto.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.18.tgz" \
  "$lab/tools/node_modules/playwright-core/index.mjs" "$(command -v google-chrome)"
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/sidebar-transfers.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.18.tgz" \
  "$lab/tools/node_modules/playwright-core/index.mjs" "$(command -v google-chrome)"
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/collaboration-contextual.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.18.tgz" \
  "$lab/tools/node_modules/playwright-core/index.mjs" "$(command -v google-chrome)"
for test in collaboration-autonomy collaboration-conversation collaboration-auto collaboration-direct collaboration-recovery collaboration-expiry; do
  unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
    "$(command -v node)" "./test/$test.mjs" "$(command -v dsh)" \
    "$lab/local-dsh-session-bridge-0.5.0-rc.18.tgz"
done
bash .github/ci/run.sh
```

固定 rc.8 与 rc.9 的停机换包与回退复验使用 `test/collaboration-auto-rollback.mjs <dsh> <固定 rc.8 tgz> <rc.9 tgz>`，在同一隔离方式下运行。脚本校验 rc.8 包指纹，并读回两项配置、白名单、普通回执和 rc.9 的直派收口。

0.4.5-rc.2 同布局换包用 `test/collaboration-rollback.mjs <dsh> <固定 0.4.5-rc.2 tgz> <候选 tgz>`，同样在 loopback 命名空间运行。基线包从 `87b06bf9fc8f9b3fc523d0ab227edd9d284c8609` 打包，SHA-256 为 `fb5de752634093c23be783fdf507b86e23ca362250ea787756de09f1e6ff6a91`。

恢复和真实模型闭环测试在一次性宿主启用逐步时间快照，复验派工、接续重启和收口。真实模型闭环用 `node ./test/collaboration-pilot.mjs "$(command -v dsh)" "$lab/local-dsh-session-bridge-0.5.0-rc.18.tgz" gpt-6.1-sol`。该脚本使用合成窗口和文件、loopback 模型适配器，以及已授权的 Codex 模型访问。适配器只传合成任务，并把模型选择交给宿主真实执行的委托工具。

### 历史 rc.18 自然语句隔离复验

使用固定 DSH Web 0.2.2-rc.1、Node 24.22.2、Chrome 和 Playwright Core 1.65.0。在候选源码目录运行下列命令。测试在仅有 loopback 的网络命名空间内启动 Web、浏览器和合成模型，并使用一次性配置与会话。

```sh
lab="$(mktemp -d)"
npm pack --offline --pack-destination "$lab"
npm install --prefix "$lab/tools" playwright-core@1.65.0
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/natural-send.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.18.tgz" \
  "$lab/tools/node_modules/playwright-core/index.mjs" "$(command -v google-chrome)"
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/natural-send-time-context.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.18.tgz"
bash .github/ci/run.sh
```

测试会在模型输出预览前通过原生 `session/prompt` 提交 `queue` 与 `steer` 两种确认，核对入队、预览、确认处理和轮结束的顺序，并验证零投递。正常路径在浏览器显示完整预览且该轮结束后提交确认。

时间快照用例在固定宿主分别触发草稿工具回报后和确认工具前的时间刷新，核对原生事件顺序、投递和去重。同轮出现拥有相同文字的所有者或中继输入时，验证草稿失效和零投递。

## 迁移与回退隔离复验

用固定 DSH Web `0.2.2-rc.1`、Node `24.22.2` 和 pnpm `12.18.0`，在 0.4.4-rc.3 源码目录（`b6b5af3`）执行。基线从固定 `0.4.2` 源码提交打包。测试在临时 HOME、XDG、DSH_HOME 和仅有 loopback 的网络命名空间内，使用合成会话及模型。

```sh
lab="$(mktemp -d)"
mkdir "$lab/stable"
git archive 83fcb3dbc2e2a8ea4723c2abafabb32e1532e765 | tar -x -C "$lab/stable"
(cd "$lab/stable" && npm pack --offline --pack-destination "$lab")
npm pack --offline --pack-destination "$lab"
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/migration.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.4.2.tgz" \
  "$lab/local-dsh-session-bridge-0.4.4-rc.3.tgz"
```

原生复验覆盖升级、半迁移、新旧路径并存和完整回退，也覆盖仅有普通互传且候选无法启动、以及候选未新增委托的回退。测试另在一次性环境故意绕过失败门槛，证实只搬回设置和回执时，0.4.2 仍会创建空账本并接受原任务键。随后隔离该错误账本，从候选当前账本恢复两代历史并核对防重。

## 宿主兼容诊断复验

下列 smoke 在 Linux 的 loopback 网络命名空间启动临时 DSH Web 和本地合成模型。在 0.4.4-rc.3 源码目录（`b6b5af3`）用 Node `24.22.2`、pnpm `12.18.0`、DSH Web `0.2.2-rc.1`、Chrome 与 Playwright Core `1.65.0` 可复跑。

```sh
lab="$(mktemp -d)"
npm pack --offline --pack-destination "$lab"
npm install --prefix "$lab/tools" playwright-core@1.65.0
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/diagnostics.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.4.4-rc.3.tgz" \
  "$lab/tools/node_modules/playwright-core/index.mjs" "$(command -v google-chrome)"
```

脚本用原生安装 RPC 验证不兼容探针包被拒、侧栏尚未注册，也用宿主的兼容判定函数检查原包面对模拟的未知版本。另在固定 Web 实现上替换合成启动器的版本身份，用原样归档检验运行时拒绝及侧栏诊断。此探针验证未知身份的拒绝边界，实际其他 DSH 版本的加载行为未纳入 smoke。
