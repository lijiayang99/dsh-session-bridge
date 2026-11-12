# dsh-session-bridge

当前版本为 `0.5.0-rc.22`，固定包已通过独立技术复审。适用于 DSH Web `0.2.2-rc.1`，需要 Node `24.9+`。包名为 `@local/dsh-session-bridge`。

## 从 GitHub 换包

在「插件 → 添加插件」输入以下地址。DSH Web 的「更新」处理 npm registry 来源，GitHub 来源通过「添加插件」手动换包。

```text
github:lijiayang99/dsh-session-bridge#a995e342a8563e1594f000a099bff11217e6f4b9
```

从 rc.20 换入时，先核对在途会话和任务，备份 Web profile 配置、普通回执和工作流账本，再停用旧插件。rc.22 首次换入时总开关关闭、名单为空。按包内规程可回退至固定 rc.20。[固定安装源码](https://github.com/lijiayang99/dsh-session-bridge/tree/a995e342a8563e1594f000a099bff11217e6f4b9) · [换包与回退](../README.md#换包与回退)

## 窗口互传

在右栏「开始 → dsh-session-bridge」启用会话互传，并勾选参与互传的独立窗口。勾选的两窗可通过 `workflow_message` 双向发消息和回报，取消勾选任一端或关闭总开关后停止新的桥接投递。原生子代理继续使用宿主的 `send_message` 和原有权限。[Agent 工具](../README.md#agent-工具)

## 历史版本

rc.20 固定安装地址为 `github:lijiayang99/dsh-session-bridge#3aca787e3be38ce6a852a44410115dda8b757296`。rc.20 及更早版本的用法、安装地址与隔离回退记录见上一版首页。[历史版本说明](https://github.com/lijiayang99/dsh-session-bridge/blob/97d68d2d6137de3ef58f96d8c6fc013fc3588771/.github/README.md)
