# dsh 接入完成度报告

> 扫描日期：2026-08-18（**2026-08-23 对 dsh 0.1.1-rc.2 重扫，见文末「重扫附录」**）
> 依据版本：`node_modules/@deepseek-ai/dsh-host-apiproxy`（`.npmrc` 精确锁定版本）
> 真相源：`lib/types/api/rpc-map.d.ts`（52 个客户端请求方法）、`lib/types/api/events.d.ts`（事件面）

## 一、结论

dsh 官方暴露 **52 个客户端请求方法**，接入前已用 **32 个**（约 62%），未接入 **20 个**。
缺口集中在 4 个完整功能域：**子代理（subagent）、目标（goal）、技能（skill）、会话队列/附件/搜索**，
以及部分 settings / workspace 排序 / host.openPath 能力；事件面另有 5 类帧未消费。

## 二、接入前已用清单（32/52）

| 域 | 方法 |
|---|---|
| session（9/12） | list、create、history、models、selectModel、rename、fork、prompt、cancel |
| host（4/5） | describe、pickDirectory、listDirectory、createDirectory |
| workspace（5/7） | list、create、rename、delete、archiveSession |
| agentPreset（6/6） | list、select、read、copy、openDocument、remove（全接入） |
| credentials（3/3） | describe、set、unset（全接入） |
| llm（3/3） | providers、models、discoverModels（全接入） |
| settings（2/5） | describe、mutate |
| 事件流 | events.mux / events.host / respond（审批·提问应答） |

## 三、未接入清单（20/52，本次接入目标）

| 域 | 方法 | 用途 |
|---|---|---|
| subagent（4） | list、history、prompt、interrupt | 子代理查看/对话/中断 |
| goal（6） | create、edit、pause、resume、complete、clear | 目标管理 |
| skill（1） | skill.list | 技能列表 |
| session（3） | search、attachment、updateQueue | 会话搜索、附件上传、队列管理 |
| settings（3） | update、replace、openDocument | 设置整体更新/替换/打开文档 |
| workspace（2） | insertBefore、insertSessionBefore | 工作区/会话排序 |
| host（1） | openPath | 系统资源管理器打开路径 |

## 四、事件面缺口（5 类帧）

- `session/queue` — 待处理消息队列快照（与 session.updateQueue 配对）
- `session/jobs` — 后台任务快照
- `session/projection` — 实时投影帧（此前只读历史 tail 的 permissions 投影）
- `session/subscribed` — 订阅基线帧
- `host/remote-event` — 宿主转发的 allowlist cordis 事件

## 五、接入方案（2026-08-18 已全部实施）

1. **store 层**：新增全部 20 个方法的封装；dispatchMux/dispatchHost 补 5 类帧消费。
2. **UI 层**：
   - 会话搜索（SessionsPage 搜索框 → session.search）→ 已实施：侧边栏搜索框 + 结果区
   - 附件上传（对话输入区 → session.attachment）→ 已实施："+"按钮选图 + imageLimits 预检 + 缩略图 chips
   - 队列面板（session/queue 事件 + updateQueue 撤销队列项）→ 已实施：队列坞（编辑/插队/移除）+ 后台任务区
   - 子代理查看（会话内子代理列表 → subagent.list/history，中断 → interrupt）→ 已实施：会话头「子代理」面板
   - 目标管理（独立面板 → goal.*）→ 已实施：会话头 GoalBar（投影驱动 + 六动词）
   - 技能列表（设置页 → skill.list）→ 已实施：env-bar「技能」菜单（点击插入 /name）
   - 工作区/会话排序（insertBefore / insertSessionBefore）→ 已实施：工作区页 ↑↓ + 侧栏右键上移/下移
   - 打开路径（工作区菜单 → host.openPath）→ 已实施：工作区页「打开目录」（canOpenPath 门禁）
   - 设置文档（settings.openDocument）→ 已实施：设置页「打开设置文档」；另接入 settings.update（DeepSeek 保存）与 settings.replace（恢复默认）
3. **验证**：npm run build（tsc+vite）通过、cargo check 通过；live 冒烟与风险记录见 docs/RISKS.md「2026-08-18：dsh 全量接入」。

## 六、边界与局限

- `session-export` / `downloads` / `jobs` 等类型为宿主内部模块或事件 payload，不计入 52 项请求面。
- dsh 处于 developer preview，升级依赖后需重扫本报告。

## 七、重扫附录（2026-08-23，dsh 0.1.1-rc.2 vs 0.1.0-rc.6）

### 客户端协议面（本项目接入面）

| 面 | 结论 |
|---|---|
| rpc-map（52 方法） | **零增删**（类型文件逐字节一致） |
| events（事件帧） | **零增删** |
| host.describe | 返回新增 `home` 字段 → 已接入：状态页「宿主信息」显示宿主主目录 |
| 错误分类 rpc.d.ts | 移除 `settings-not-exposed` 成员 → 应用无引用，无需处理 |
| sessions 投影映射 | `SessionProjectionStateMap` 声明微调（imageLimits/sessionListMetadata）→ 无代码影响 |

### 设置命名空间

- **新增 `agent-default-model`**：全局默认模型 `{ provider, model, reasoningEffort? }`，带 CAS revision，
  applies=live。**已接入**：设置页「模型提供商」tab 新增「默认模型（新会话）」卡片
  （读 = settings.describe；写 = settings.update + expectedRevision；下拉复用 llm.models 目录与模型 reasoning.efforts；
  写路径 live 实证：CAS 幂等回写 ok、值不变，证据 `evidence/settings-describe-rc2.txt`）。

### runtime 包组合（host 侧，非客户端接入面）

- 新增包：`dsh-authorization`、`dsh-file-reference(+local)`、`dsh-tool-pwsh-persistent`、
  UI 类 `dsh-client-ui-renderer / ui-brand-official / ui-reference`；组合配置树新增挂载
  `session-reference`、`file-reference-local`、`ui-*` 三插件与 openBrowser 钩子——均为宿主内部能力，
  不经 apiproxy 暴露新 RPC，应用无需接入。
- 移除包：`dsh-client-ui-slots`、`dsh-client-web`、`dsh-client-web-react`、`dsh-client-schema-form`、
  `dsh-client-ui-primitives` 及 markdown/shiki 渲染链依赖。
  - `dsh-client-ui-slots`：影响 vendored 注入器链接对（仅类型级引用）→ 安装器已容错跳过 + 自愈信号修正（见 RISKS 08-23 升级段）。
  - 其余为本应用未引用的官方 shell/渲染包 → 插件 UI 挂载路径自 rc.2 起不复存在，维持只读清单决策（设置页说明文字已同步更新）。
