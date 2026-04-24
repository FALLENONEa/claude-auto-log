# claude-auto-log

Claude Code 自动日志 + 工作日报一键安装器。

## 安装

```bash
npx claude-auto-log install
```

或在本地目录测试：

```bash
node ./bin/claude-auto-log.js install --time 18:00
```

如需只安装 Claude 侧逻辑、不注册系统定时任务：

```bash
node ./bin/claude-auto-log.js install --time 18:00 --no-scheduler
```

## 功能

- 自动写入 Claude Code Stop hook
- 自动安装日志脚本与日报脚本
- Windows 自动注册 Task Scheduler
- macOS 自动注册 launchd
- Linux 自动注册 crontab

## 命令

```bash
claude-auto-log install --time 18:00
claude-auto-log status
claude-auto-log uninstall
```
