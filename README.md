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

阈值必须低于所用模型的上下文窗口。窗口更小时宿主会先重置上下文，插件永不触发。
实测 `go/deepseek-v4.1-flash`（窗口约 163k）在约 152k 处被宿主重置；窗口 ≥ 250k 的模型可正常越阈。

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

安装布局固定：唯一入口 `plugin/opencode-auto-compact.ts`，共享实现位于 OpenCode 扫描目录之外的 `opencode-auto-compact-lib/`。启动日志不会出现 `failed to load plugin` 告警；插件在同一进程只生效一次，不会重复触发压缩。安装脚本会清理旧版本遗留的 `plugins/opencode-auto-compact.ts`，避免宿主重复加载。

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
2. 确认扫描目录只有一个入口文件：

   ```sh
   ls "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugin/opencode-auto-compact.ts"
   ```

   v1 还可在 `opencode debug info` 的 `plugins:` 列表中核对。v2 已移除 `debug info` 子命令，
   改按第 3 步的运行记录核对；`opencode plugin list` 依赖后台服务，不作为判据。

3. 查看运行记录，每次启动新增一行 `auto-compact runtime activated`，`entry` 标注本次宿主代次：

   ```sh
   grep -c '"message":"auto-compact runtime activated"' \
     "${XDG_STATE_HOME:-$HOME/.local/state}/opencode-auto-compact/auto-compact.log"
   ```

   重启前后计数相差 1 表示入口只加载一次；同一次启动出现两行表示入口被重复加载。
   v1 启动日志中的 `failed to load plugin` 应为 0。

4. 让任一长会话的上下文超过 200000 token，结束当前回合。多轮读不同内容才能累积上下文；
   反复读同一文件会被宿主去重，每轮增量只有数百 token。
5. 会话空闲后自动压缩，无需手动操作。
6. 复核结果看日志的分类计数与 `effectiveTokens` 数值（本次评估计入的有效提示 token 数）。
   日志行数每启动一个宿主就增加，不作判据。

## 运行记录

插件把每次空闲评估与压缩结果写到自己的日志文件：

```text
${XDG_STATE_HOME:-~/.local/state}/opencode-auto-compact/auto-compact.log
```

每次评估一行，压缩成功一行，记录会话 ID、当时的 token 数与阈值。文件超过 2 MiB 时轮转为 `auto-compact.log.1`。

日志里出现 `idle session evaluated against the fixed threshold` 表示插件已生效但上下文未达阈值；出现 `compacted an idle session over the fixed threshold` 表示已自动压缩。

同一个日志文件由该用户的多个 OpenCode 进程共同追加：每次启动各写一行启动记录与一行订阅记录。判断是否生效按各条消息的条数与 `effectiveTokens` 数值，不要按日志行数。

## 兼容性

- OpenCode v1 与 v2 均可使用。
- 运行时只依赖 OpenCode 自身接口，没有第三方运行时依赖。
- 单个入口同时服务 v1 与 v2，插件每进程只生效一次，不会重复触发压缩。
