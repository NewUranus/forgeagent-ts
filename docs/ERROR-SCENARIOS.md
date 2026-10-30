# 错误场景清单

ForgeAgent 可能遇到的错误场景，包括还没有实现处理的场景。整理于 2026-10-27，依据当时的代码和测试。

**列说明**

- **实现状态**：已实现 / 部分（有处理，但行为不理想或只覆盖一部分）/ 未实现。
- **需要 token**：否 = 用故障代理回放、mock 或自定义回复就能测；恢复率要 = 只测机制不需要 token，测模型能不能从错误中恢复需要真实模型；要 = 只能用真实模型测。
- **次数**：结果确定的场景跑 1 次即可；涉及真实模型行为的场景结果有随机性，需要多次（至少 3 次，要和基线比较时跑 5–10 次）。
- **评测状态**：
  - **故障注入**：`npm run faults` 端到端评测过（真实 API 路径加回放录制，见 `src/eval/faults.ts`）。
  - **单元测试**：有单元测试或脚本化测试（假 fetch / 自定义回复），但没有做端到端的故障注入评测。
  - **未评测**：没有找到对应的测试。
  - 目前没有任何场景用真实模型评测过"恢复率"。

**汇总**：故障注入 3 个（同时有单元测试），只有单元测试 29 个，未评测 21 个（其中 6 个是还没实现的功能）。另外，故障注入评测中新发现了 1 个问题（第 54 条），已于 2026-10-27 修复。

## 一、模型 API 层

| # | 场景 | 模拟方式 | 预期行为 | 实现状态 | 拦截文件 | 需要 token | 次数 | 评测状态 | 依据 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 429 限流 + Retry-After | 代理返回 429 | 重试，等待不早于 Retry-After | 已实现 | `src/model/retry.ts`、`src/config.ts`、`src/model/client.ts` | 否 | 1 | **故障注入** | `429-retry-after-seconds`、`429-retry-after-date`、`429-backoff`、`429-mid-run`、`429-stream` 全部符合；单元测试 `withRetry retries transient errors…` |
| 2 | 5xx / 408 / 409 / 425 | 代理返回对应状态码 | 指数退避加抖动后重试 | 已实现 | `src/model/retry.ts`、`src/model/client.ts` | 否 | 1 | 单元测试 | `API run retries transient failures…`（假 fetch 返回 503）；`isRetryable` 状态码列表 |
| 3 | 重试次数耗尽 | 连续 4 次失败 | `model_error`，报告照常写出 | 已实现 | `src/model/retry.ts`、`src/agent.ts` | 否 | 1 | **故障注入** | `429-exhausted` 符合；单元测试中 503 连续失败 |
| 4 | Retry-After 超过 2 分钟 | 429 + `Retry-After: 300` | 不等待，直接失败 | 已实现 | `src/model/retry.ts` | 否 | 1 | **故障注入** | `429-wait-too-long` 符合；单元测试 `longWait` |
| 5 | 401 / 403 / 404（密钥、额度或模型名错误） | 代理返回对应状态码 | 不重试，立即 `model_error`；评测在这次运行后停止 | 已实现 | `src/model/retry.ts`、`src/eval/run.ts` | 否 | 1 | 单元测试 | `isRetryable`、`withRetry` 401；真实评测中出现过 403 `insufficient_quota`（`eval/results/eval-2026-10-25T07-27-17-273Z-fix-r10-2tasks-report.md`） |
| 6 | 普通 400 参数错误 | 代理返回 400 | 不重试 | 已实现 | `src/model/retry.ts` | 否 | 1 | 单元测试 | `isRetryable` 400 |
| 7 | 网络断开 / DNS 失败 | 代理销毁 socket | 按网络错误重试 | 已实现 | `src/model/retry.ts` | 否 | 1 | 单元测试（部分） | 只断言了 `TypeError` 可重试，没有真实断开连接 |
| 8 | 非流式请求超时 | 代理挂起超过 60 秒 | 超时后重试 | 已实现 | `src/config.ts`、`src/model/retry.ts` | 否 | 1 | 未评测 | — |
| 9 | 流在中途断开 | 发一半 SSE 后断开 | 整次重试，丢掉半截输出 | 已实现 | `src/model/stream.ts`、`src/model/client.ts` | 否 | 1 | 未评测 | — |
| 10 | 流空闲超时 | 60 秒不发数据 | 抛 `StreamIdleError` 后重试 | 已实现 | `src/model/stream.ts` | 否 | 1 | 未评测 | — |
| 11 | 流里返回 error 块 | SSE 中插入 `{"error":...}` | 应当重试；现在抛普通 Error，不重试，直接结束 | 部分 | `src/model/stream.ts` | 否 | 1 | 未评测 | — |
| 12 | 流里的工具调用缺 id 或名称 | 篡改 SSE 分片 | 报错；不重试 | 部分 | `src/model/stream.ts` | 否 | 1 | 单元测试 | `assembleChunks joins content and tool-call fragments…`（只测了抛错） |
| 13 | 服务端上下文超限 1–2 次 | 返回带 context length 的 400 | 预算乘 0.7 后重发，任务通过 | 已实现 | `src/agent.ts`、`src/model/retry.ts` | 否 | 1 | 单元测试 | `a server-side context overflow shrinks the window and resends the same round` |
| 14 | 服务端上下文超限 3 次，或关闭上下文管理 | 同上，次数更多 | `server_context_limit` | 已实现 | `src/agent.ts` | 否 | 1 | 单元测试（部分） | `with context management off, a server overflow ends as server_context_limit`；连续 3 次超限没有测 |
| 15 | 客户端预算放不下固定前缀和最近一组 | 把 `CONTEXT_WINDOW_TOKENS` 调得很小 | 发请求前停止，`context_limit` | 已实现 | `src/context/context.ts`、`src/agent.ts` | 否 | 1 | 单元测试 | `API gets the selected window; irreducible overflow makes no API call…` |
| 16 | 模型摘要调用失败 | `--summary llm` 时摘要请求返回 500 | 回退到规则摘要 | 已实现 | `src/agent.ts`、`src/context/summary.ts` | 否 | 1 | 单元测试 | `a failed llm summary falls back to the rule summary…` |
| 17 | `choices` 为空或缺少 `message` | 代理返回 `{"choices":[]}` | 应当重试；现在直接 `model_error` 结束 | 未实现 | — | 否 | 1 | 未评测 | — |
| 18 | `finish_reason=length`，输出被截断 | 代理截断内容或工具参数 | 应当识别后续写或重发；现在没有检查 | 未实现 | — | 否 | 1 | 未评测 | — |
| 19 | 熔断 / 切换备用模型 | 主模型持续 5xx | 切到备用模型 | 未实现 | — | 否 | 1 | 未评测 | — |

## 二、模型输出层（模型"做错事"）

| # | 场景 | 模拟方式 | 预期行为 | 实现状态 | 拦截文件 | 需要 token | 次数 | 评测状态 | 依据 |
|---|---|---|---|---|---|---|---|---|---|
| 20 | 工具参数是坏 JSON | 代理篡改 `arguments` | 工具报错，回传给模型 | 已实现 | `src/agent.ts` | 恢复率要 | 机制 1 / 恢复率多次 | 未评测 | — |
| 21 | 调用不存在或被消融的工具 | 篡改工具名 | 按未知工具拒绝 | 已实现 | `src/agent.ts`、`src/tools.ts` | 恢复率要 | 机制 1 / 恢复率多次 | 单元测试 | `edit-tool off withholds edit_file and refuses calls to it…` |
| 22 | 参数类型错误或有多余参数 | 篡改参数 | 参数校验报错 | 已实现 | `src/tools.ts` | 恢复率要 | 机制 1 / 恢复率多次 | 未评测 | 没有找到专门的测试 |
| 23 | 路径越界、符号链接、受保护目录 | 参数改成 `../` 之类 | 拒绝访问 | 已实现 | `src/workspace.ts` | 否 | 1 | 单元测试 | `working copy, tools and six calculator cases`；MCP 路径越界 |
| 24 | `edit_file` 的 old_str 找不到或不唯一 | 自定义回复 | 报错并说明原因 | 已实现 | `src/tools.ts` | 恢复率要 | 机制 1 / 恢复率多次 | 单元测试 | `applyEdit replaces exactly one occurrence and explains ambiguous or missing matches` |
| 25 | 通过工具修改测试文件或测试配置 | 自定义回复 | 拒绝写入 | 已实现 | `src/tools.ts`、`src/guard.ts` | 否 | 1 | 单元测试 | `tools refuse test configs and test-setting edits…`；`edit_file and write_file protect tests…` |
| 26 | 连续 3 次相同调用 | 自定义回复 | 先提醒一次，再次出现时 `loop_detected` | 已实现 | `src/loop.ts`、`src/agent.ts` | 恢复率要 | 机制 1 / 恢复率多次 | 单元测试 | `repeating the same call gets one warning, then the run stops as loop_detected` |
| 27 | 测试结果连续不变，期间没有写入 | 自定义回复 | 同上 | 已实现 | `src/loop.ts` | 恢复率要 | 机制 1 / 恢复率多次 | 单元测试 | `loop detector: streaks of identical calls, unchanged test results and failed checks` |
| 28 | 因同一原因反复没通过结束检查 | 自定义回复 | 同上 | 已实现 | `src/loop.ts`、`src/agent.ts` | 恢复率要 | 机制 1 / 恢复率多次 | 单元测试 | 同上 |
| 29 | 没跑测试或没跑全量测试就宣布完成 | 自定义回复 | 结束检查拦下并给出反馈 | 已实现 | `src/agent.ts` | 恢复率要 | 机制 1 / 恢复率多次 | 单元测试 | `a passing partial run never verifies…`；`passing baseline or earlier tests cannot hide a later write…` |
| 30 | 轮数耗尽 | `MAX_ROUNDS=2` | `round_limit` | 已实现 | `src/agent.ts` | 否 | 1 | 单元测试 | `runEval runs every attempt, survives failures…`；`limits end the run with distinct reasons…`；真实评测中出现过 `round_limit` |
| 31 | 子 agent 出错、超轮、重复，或一轮超过 3 个 | 自定义回复 | 主 agent 总能拿到一个结果 | 已实现 | `src/subagents.ts`、`src/agent.ts` | 恢复率要 | 机制 1 / 恢复率多次 | 单元测试 | `at most three sub-agents per turn…`；`a sub-agent that never concludes stops at its round limit…` |
| 32 | plan-execute 计划无效或重规划超限 | 自定义回复 | `planning_failed` / `replan_limit` | 已实现 | `src/strategy/plan-execute.ts` | 恢复率要 | 机制 1 / 恢复率多次 | 单元测试 | `limits end the run with distinct reasons: replan_limit, planning_failed, round_limit` |
| 33 | 工具调用 id 重复 | 篡改响应 | 应当拒绝这一轮；现在构建窗口时抛错，整次运行变成 `execution_error` | 部分 | `src/context/context.ts` | 否 | 1 | 单元测试（部分） | `invalid budgets and broken tool relationships are rejected`（只测了窗口构建拒绝，没有测运行层面） |
| 34 | 仓库文件里夹带指令（提示注入） | 在 `AGENTS.md` 里写指令 | 当作数据处理，不执行 | 部分 | `src/context/project.ts` | 要 | 多次 | 单元测试（部分） | `project notes are labelled as data and capped`；模型是否照做没有评测 |

## 三、工具和环境层

| # | 场景 | 模拟方式 | 预期行为 | 实现状态 | 拦截文件 | 需要 token | 次数 | 评测状态 | 依据 |
|---|---|---|---|---|---|---|---|---|---|
| 35 | 测试超时 | 测试里放死循环 | 杀掉整个进程组，返回 `time_out` | 已实现 | `src/tools.ts` | 否 | 1 | 单元测试 | `test timeout is a result…`；`sandboxed tests … a timeout kills the container` |
| 36 | 测试命令不存在或崩溃 | 在 `task.json` 里配置错误命令 | 作为测试失败记录，不中断运行 | 已实现 | `src/agent.ts`、`src/tools.ts` | 否 | 1 | 未评测 | — |
| 37 | 准备命令失败 | setup 命令 `exit 1` | `setup_error` | 已实现 | `src/agent.ts` | 否 | 1 | 单元测试 | `setup runs before the baseline; a failing setup stops the run before any model call` |
| 38 | 读取二进制文件 | 在项目里放一个二进制文件 | 报错 | 已实现 | `src/tools.ts` | 否 | 1 | 未评测 | 只测了 `search_code` 跳过二进制，没有测 `read_file` |
| 39 | 写入失败（权限、磁盘满） | 把文件设为只读 | 工具报错，并把之前的测试验证作废 | 部分：只有通用捕获 | `src/agent.ts` | 否 | 1 | 未评测 | — |
| 40 | 在工具之外改了测试 | 运行中由外部改测试文件 | 结束检查拦下 | 已实现 | `src/guard.ts`、`src/agent.ts` | 否 | 1 | 单元测试 | `exit check blocks completion when tests change outside the tools` |
| 41 | 回写时源目录已被改动 | 运行中修改源文件 | `source_conflict` | 已实现 | `src/agent.ts` | 否 | 1 | 单元测试 | `apply revalidation is counted and a source conflict still produces a report` |
| 42 | 回写前复验失败 | 让复验测试失败 | `apply_validation_failed` | 已实现 | `src/agent.ts` | 否 | 1 | 未评测 | 只测了复验次数，没有测复验失败 |
| 43 | git 模式下源仓库有未提交改动 | 留一个未提交的修改 | 拒绝启动 | 已实现 | `src/workspace.ts` | 否 | 1 | 单元测试 | `git mode refuses non-repositories, subdirectories and uncommitted changes` |
| 44 | Docker 沙箱不可用 | `DOCKER=不存在的命令` | 测试执行失败，作为结果返回 | 部分 | `src/tools.ts` | 否 | 1 | 未评测 | 容器超时有测试，Docker 不可用没有 |
| 45 | MCP 服务超时、无效响应或崩溃 | 写一个故意出错的假 MCP 服务 | 报错，关闭子进程 | 已实现 | `src/mcp/client.ts` | 否 | 1 | 单元测试（部分） | `MCP discovery, errors, and real file/test tools over stdio`（错误响应）；超时和崩溃没有测 |
| 46 | Embedding 服务不可用 | 把 `EMBEDDING_BASE_URL` 指向错误地址 | 降级为只用 BM25，并附上说明 | 已实现 | `src/rag/docs.ts`、`src/rag/embedding.ts` | 否 | 1 | 单元测试 | `hybrid search: … embedding failures fall back to BM25` |
| 47 | Qdrant 没有运行 | 不启动 Qdrant | 明确报错，提示怎么启动 | 已实现 | `src/rag/qdrant-store.ts` | 否 | 1 | 未评测 | Qdrant 相关测试在未运行时直接跳过 |

## 四、运行控制（都还没实现）

| # | 场景 | 预期行为 | 实现状态 | 需要 token | 次数 | 评测状态 |
|---|---|---|---|---|---|---|
| 48 | Ctrl-C / SIGINT 中断 | 先保存报告，清理子进程和容器，再退出 | 未实现 | 否 | 1 | 未评测 |
| 49 | token 或费用预算上限 | 超出预算时以 `budget_limit` 结束 | 未实现 | 否 | 1 | 未评测 |
| 50 | 整次运行的墙钟超时 | 超时后结束，报告照常写出 | 未实现 | 否 | 1 | 未评测 |
| 51 | 崩溃后断点续跑 | 从第 N 轮继续；现在的回放只能完整重放整段录制 | 未实现 | 否 | 1 | 未评测 |
| 52 | 会写文件的子 agent 之间互相冲突 | 用 worktree 隔离后再合并 | 未实现 | 要 | 多次 | 未评测 |
| 53 | 并发评测共享同一份限流额度 | 全局令牌桶；现在评测只能按顺序跑 | 未实现 | 否 | 1 | 未评测 |

## 五、评测中新发现

| # | 场景 | 模拟方式 | 预期行为 | 实际行为 | 拦截文件 | 需要 token | 次数 | 评测状态 |
|---|---|---|---|---|---|---|---|---|
| 54 | 429 + `insufficient_quota`（额度耗尽） | 代理返回 429，body 带 `insufficient_quota` | 不重试，立即失败；评测停止 | 修复前：重试 3 次后才失败，评测也不停止。**已修复**：`isQuotaExhausted` 按响应内容识别，`isRetryable` 不再重试；报告记录 `account_error`，评测遇到后停止 | `src/model/retry.ts`、`src/agent.ts`、`src/eval/run.ts` | 否 | 1 | **故障注入：符合预期**（`429-insufficient-quota`）；单元测试 `an exhausted quota is never retried…`、`an account error stops the eval…` |
