# opencode-auto-compact

给 OpenCode 增加固定阈值的自动上下文压缩：会话空闲且上下文超过 200000 token 时，自动压缩该会话的上下文。

同时支持 OpenCode v1 与 v2。

读者：安装并使用插件的 OpenCode 用户。

## 功能

插件只在同时满足两个条件时触发压缩：

1. 会话进入空闲状态（当前回合已结束，没有进行中的任务）。
2. 该会话的上下文长度超过 200000 token。

两个条件缺一不可。会话忙碌时不会触发；上下文不超过阈值时不会触发。

阈值 200000 token 是固定值。插件不提供选项、环境变量或配置文件来修改它。

触发后由 OpenCode 压缩该会话的上下文，只保留摘要继续后续工作。压缩失败时插件不中断会话，限制重试频率后在下一次空闲时再试。

其余时间插件不介入会话内容，不注入提示，不修改配置，不产生额外网络请求。

## 安装

安装方式是把插件文件复制到 OpenCode 配置目录。

```sh
git clone git@github.com:xxmawhu/opencode-auto-compact.git
cd opencode-auto-compact
bash install.sh
```

默认目标目录是 `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`。需要换目录时设置 `OPENCODE_CONFIG_DIR`：

```sh
OPENCODE_CONFIG_DIR=/path/to/opencode bash install.sh
```

安装脚本只复制文件，不构建、不联网、不改 `opencode.json`。重复执行会覆盖旧副本。

安装后重启 OpenCode，插件在启动时加载。

## 更新与卸载

```sh
git pull
bash install.sh
```

```sh
bash install.sh --uninstall
```

更新和卸载后都需要重启 OpenCode。

## 验证

1. 重启 OpenCode。
2. 打开 `opencode debug info`，`plugins:` 列表中出现 `opencode-auto-compact` 的两个入口文件。
3. 让任一长会话的上下文超过 200000 token，结束当前回合。
4. 会话空闲后自动压缩，无需手动操作。

## 兼容性

- OpenCode v1 与 v2 均可使用。
- 运行时只依赖 OpenCode 自身接口，没有第三方运行时依赖。
- 同时安装两个入口时插件只生效一次，不会重复触发压缩。
