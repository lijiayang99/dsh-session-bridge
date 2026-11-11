# dsh-session-bridge 0.5.0-rc.1

适用于 DeepSeek Harness Web 0.2.2-rc.1。全新安装可通过「插件 → 添加插件」输入宿主机可读的包绝对路径并启用。已有版本请先按下文迁移。

右栏「开始 → dsh-session-bridge」有「启用会话消息」和「启用跨窗口任务委托」两个独立开关，共用会话白名单。先创建并使用主控、开发和审核会话，将它们加到白名单。

## 宿主兼容诊断

右栏诊断使用服务端授权门禁生成的状态。该状态随配置结构返回，配置值无法改写它。侧栏仅显示固定状态和支持版本。

| 侧栏或安装状态 | 含义 |
| --- | --- |
| 宿主版本受支持 | 宿主通过固定的 DSH `0.2.2-rc.1` 版本检查。会话消息和任务委托分别显示保存后的开关状态。 |
| 当前宿主不受支持 | 插件已加载，但宿主身份或版本未通过授权门禁。侧栏不提供编辑，新会话消息和任务委托不开放。已有会话消息的回执查询和符合原条件的精确重复查询仍可用。 |
| 无法读取插件配置或宿主兼容状态 | 配置请求失败、配置条目或兼容标记缺失、设置数据无法读取，或读取所需的会话列表失败。可在右栏重新读取。 |
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
4. 先保持两个开关关闭，核对安装版本、白名单、已有历史或已确认空态。委托按原证据对照任务键、尝试 UUID 和结果。通过后按原授权范围恢复开关。候选期间若有新增委托，保留至少一条同类证据供回退核对。

### 回退到 0.4.2

1. 能操作候选时，停发、排空并关闭两个开关，读回关闭状态。按原证据核对已有普通回执和委托。在各自原主控用 `workflow_status` 和 `workflow_item_status` 查询，**原委托和候选新增委托两代均有记录时，各至少核对一条**，记录任务键、尝试 UUID 和结果。某一代确实为空时，记录是哪一代为空及确认依据。无需为升级或回退额外发送消息或派工。候选无法启动或历史读不到时，保留既有证据，将该功能记为待对账。
2. 禁用候选，完整停止使用同一 `DSH_HOME` 的所有宿主。备份当前配置和数据。按表恢复设置 ID、整个回执目录和**整个当前委托账本目录**到旧名称。保留已有记录、SQLite 文件及旁车文件。确实从未创建的数据目录记为缺省。有并存路径或来源不清时，分别保全现有数据，按下文对账后再移动。候选无法启动或历史有缺失时，仍可停用候选并恢复固定 0.4.2。启动旧包前，确认旧版生效配置中的两个功能开关均关闭。
3. 换回固定 0.4.2 后完整重启。核对版本、白名单和生效的关闭状态。按步骤 1 读回同一条普通回执及每一代已有的委托证据。某一代记录为空时，确认空态依据仍成立、完整现行账本已经迁回且新旧账本路径无并存。只有对应历史及设置均通过核对的功能才可恢复原开关。待对账的功能保持关闭。

### 停止与恢复门槛

- 历史缺失、尝试或结果不符，或无法区分空态与读不到时，停止恢复对应功能的开关，保留数据并对账。可以先在两个功能关闭的状态下恢复固定旧包。旧 0.4.2 找不到旧路径时会创建空账本。即使普通回执已能读取，仍须独立核对委托账本。历史缺失时不得对原任务重新授权或派发来补记录。
- 只完成部分迁移时，先停宿主，再按表逐项核对实际路径和设置。用备份、回执及原主控留存的委托证据确认当前完整数据。只完成剩余的移动，避免把已完成的部分再次覆盖。
- 新旧路径并存时，保留两侧，先核对来源。确认哪一侧是包含所需历史的完整数据后，将另一侧整个目录单独保全，再完成重命名和原生读回。发现空账本或分歧账本也按此处理。两侧均含独有历史或无法确认权威数据时，继续停用并逐项对账。不要覆盖、合并 SQLite 文件或按更新时间猜测。配置中两套条目并存时，同样先核对实际生效的设置及覆盖来源。

## 跨窗口任务

一项任务只交给一个明确窗口时，可直接输入「把『核对合成文件的摘要』委托给『开发窗口』」。插件从本轮所有者原文取目标和唯一白名单窗口，自动开立并入队一次。期限固定为 30 分钟，用途为执行原文目标，预算为一次尝试。需要其他窗口、返修预算或不同期限时，使用下述方案确认。

在原主控窗口输入「请把合成候选的实现交给开发窗口，把独立核查交给核查窗口，等两项都返回后交给审核窗口。审核退回就安排返修并复审」。主控生成方案，列出任务、目标、窗口标题、用途、有效期和总派工预算。看到完整预览且该轮结束后，在原主控回复「确认委托」。原主控 DSH 所有者的这条原生输入开立方案。窗口同名、目标或范围含糊时先澄清。回复「取消委托」可作废待确认方案。

主控在批准范围内并行派工、等齐汇总、按原任务返修和收口。共用执行窗口逐项领取。批次等待每项回报、失败或进入待核对，只返回一次结果通知。主控可查看部分失败并按剩余预算返修。遇到待核对或明确要求所有者决定的回报，主控从原窗口继续处理，确认后可输入 `继续委托 <任务>`。右栏「开始 → dsh-session-bridge → 原主控任务」可查看批次、尝试、执行窗口、回报、失败和接续状态。

### 工具与验收接口

| 工具 | 参数与约束 |
| --- | --- |
| `workflow_delegate_direct` | 无参数。只接受原主控所有者本轮明确引用的单窗口和目标原文。开立与一次派工写入同一笔账本事务。 |
| `workflow_propose` | `task`、`goal`、`ttlMinutes`、`budget`、`scopes`。每个范围用 `name`、`windows`（宿主窗口标题）和 `purpose`。用户要求正式审核时，审核范围加 `review: true`，成功收口须有通过的固定产物。预算为整个任务可新建的尝试数，最多 32，包含返修。返回 `preview` 时主控须原样作为整条最终回复展示。 |
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

## 普通互传

在发送窗口直接输入 `给审核窗口发消息：候选已就绪，请开始复核` 或 `把『候选已就绪，请开始复核』发给审核窗口`。助手调用普通发送工具，插件从本轮所有者消息取得原文，从宿主读取会话标题，并在白名单内解析唯一的收件窗口。插件生成请求号，精确重复调用返回同一回执。

标题缺失、同名或正文缺失时，助手会请你用唯一标题和正文重新说明。标题 `审核` 也可用 `审核窗口` 指代。若两种标题在白名单内都存在，先用唯一标题消歧。普通互传每次处理一个收件窗口。

输入 `请拟一条消息发给审核窗口` 或 `把刚才的摘要发给审核窗口` 时，助手在原窗口展示完整草稿。预览包含收件标题和正文，换行与控制字符以可见转义表示。预览轮结束且宿主确认没有待处理输入后，草稿才接受确认。所有者等这一轮结束，在同一窗口回复 `确认发送` 即可投递冻结的标题和正文。若预览轮结束时仍有排队输入，需重新提出发送请求。回复 `取消发送`、转入其他话题或超过两分钟未确认都会结束草稿。发送前再次核对窗口标题、白名单和当前轮次。

宿主自动追加的原生时间快照会保留同轮草稿和确认。所有者或中继发送的额外输入仍会使原草稿失效。

在发送会话由 DSH 所有者输入 `授权互传 目标会话ID 请求号`，下一行开始写准确正文。助手用 `send_session_message` 按原样发送，从原发送会话用 `session_message_status` 查投递和处理。精确重试只返回已有回执。迁移保留回执内容和去重键。目标轮次正常回复并落盘仅证明处理，项目验收仍要看结构化结果和产物。

### 从 0.4.4-rc.3 或 0.4.5-rc.2 换入或回退

排空在途消息和委托，保存两个开关与白名单的当前值，关闭两个开关并停用插件。完整停止宿主后备份当前配置、回执和委托账本，再换入固定包并完整重启。各版共用相同设置 ID、回执和账本路径。核对安装版本、白名单、开关和已有回执及委托记录，再按原授权恢复开关。

回退前在 0.5.0 核对并收口或取消其活动协作任务，等待读回已提交的收口状态，保全宿主未决的尝试及账本，保持两个开关关闭，再换回已核对的固定旧包。旧版能读回历史，活动、暂停和收口待核验的新版协作授权在旧版保持不可派发。若候选无法启动，完整保存升级后的数据后再执行回退，未能读回的协作任务按待对账处理。

### 协作任务隔离复验

用 DSH Web `0.2.2-rc.1`、Node `24.22.2` 和 Chrome。在源码目录离线打包。合成模型、临时 DSH_HOME 和浏览器使用 loopback 网络命名空间。

```sh
lab="$(mktemp -d)"
npm pack --offline --pack-destination "$lab"
npm install --prefix "$lab/tools" playwright-core@1.65.0
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/collaboration.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.4.tgz" full \
  "$lab/tools/node_modules/playwright-core/index.mjs" "$(command -v google-chrome)"
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/collaboration.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.4.tgz" stress
for test in collaboration-direct collaboration-recovery collaboration-expiry; do
  unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
    "$(command -v node)" "./test/$test.mjs" "$(command -v dsh)" \
    "$lab/local-dsh-session-bridge-0.5.0-rc.4.tgz"
done
bash .github/ci/run.sh
```

同布局换包用 `test/collaboration-rollback.mjs <dsh> <固定 0.4.5-rc.2 tgz> <候选 tgz>`，同样在 loopback 命名空间运行。基线包从 `87b06bf9fc8f9b3fc523d0ab227edd9d284c8609` 打包，SHA-256 为 `fb5de752634093c23be783fdf507b86e23ca362250ea787756de09f1e6ff6a91`。

恢复和真实模型闭环测试在一次性宿主启用逐步时间快照，复验派工、接续重启和收口。真实模型闭环用 `node ./test/collaboration-pilot.mjs "$(command -v dsh)" "$lab/local-dsh-session-bridge-0.5.0-rc.4.tgz" gpt-6.1-sol`。该脚本使用合成窗口和文件、loopback 模型适配器，以及已授权的 Codex 模型访问。适配器只传合成任务，并把模型选择交给宿主真实执行的委托工具。

### 自然语句隔离复验

使用固定 DSH Web 0.2.2-rc.1、Node 24.22.2、Chrome 和 Playwright Core 1.65.0。在候选源码目录运行下列命令。测试在仅有 loopback 的网络命名空间内启动 Web、浏览器和合成模型，并使用一次性配置与会话。

```sh
lab="$(mktemp -d)"
npm pack --offline --pack-destination "$lab"
npm install --prefix "$lab/tools" playwright-core@1.65.0
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/natural-send.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.4.tgz" \
  "$lab/tools/node_modules/playwright-core/index.mjs" "$(command -v google-chrome)"
unshare -Urn sh -c 'ip link set lo up && exec "$@"' sh \
  "$(command -v node)" ./test/natural-send-time-context.mjs "$(command -v dsh)" \
  "$lab/local-dsh-session-bridge-0.5.0-rc.4.tgz"
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
