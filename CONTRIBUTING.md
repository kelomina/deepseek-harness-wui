# Contributing

## 提交规范

使用 Conventional Commits：

```
feat(shell): add dsh process manager
fix(sessions): answer approvals with result envelope
docs(hard-limits): document restart policy
chore(runtime): bump @deepseek-ai/dsh to 0.1.0-rc.6
```

## 工作流

1. 从 `main` 切分支：`git switch -c feat/<name>`。
2. 改动前阅读 AGENTS.md、docs/HARD_LIMITS.md 与本项目文档。
3. 运行最窄验证（docs/DEVELOPMENT.md 验收清单）。
4. 提交（hooks 自动检查密钥/大文件/提交信息）。
5. 合并回 main 前确保：build + cargo check + 运行验收通过。

## 禁止

- 提交任何凭据、`.env`、私钥。
- 直接修改 dsh 上游或提交 `runtime/node_modules`、`src-tauri/target`、`dist`。
- 绕过 pre-commit/commit-msg hooks（`--no-verify` 需要说明理由）。
