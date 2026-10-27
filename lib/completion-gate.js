/**
 * dsh-project-hub — completion-gate.js
 * Rigorous module task completion detector & token-saving gate.
 */

import { writeTagDoc } from './doc-manager.js'

/**
 * Filter to evaluate if a turn genuinely completed a modular task.
 * Avoids updating on pure conversation, minor inspections, or interrupted turns.
 */
export function isGenuineTaskCompletion(turnEndEvent, sessionState) {
  if (!turnEndEvent) return false

  // Gate 1: Check turn completion kind
  const reason = turnEndEvent.reason
  if (!reason || reason.kind !== 'completed') {
    // Interrupted, aborted, error, or maxTokens cut -> DO NOT update
    return false
  }

  // Gate 2: Check for physical side-effects in the turn
  // A genuine task completion must have involved real file writes/edits or build commands.
  const turn = turnEndEvent.turn || {}
  const messages = turn.messages || []
  let hasFileMutation = false

  for (const msg of messages) {
    if (msg && msg.role === 'assistant' && Array.isArray(msg.toolCalls)) {
      for (const call of msg.toolCalls) {
        const name = (call && call.name) || ''
        if (
          name.includes('write_file') ||
          name.includes('edit_file') ||
          name.includes('create_file') ||
          name.includes('run_command') ||
          name.includes('patch')
        ) {
          hasFileMutation = true
          break
        }
      }
    }
    if (hasFileMutation) break
  }

  // If there were zero file operations or tool calls modifying workspace, reject
  if (!hasFileMutation && !sessionState?.hasExplicitToolCall) {
    return false
  }

  return true
}

/**
 * Register the explicit model tool `record_module_done`.
 * Allows 100% deterministic, zero-waste token delivery.
 *
 * Accepts either a Cordis context carrying the `tools` service or the tools
 * service itself, because the plugin registers through
 * `ctx.inject(['tools'], (toolCtx) => toolCtx.effect(...))` (the contract the
 * shipped `@deepseek-ai/dsh-hint-ball` host half verifies on this DSH build).
 */
export function registerModuleDoneTool(ctxOrTools, rootOrGetter) {
  // The 「总工作区」 root can be hot-switched at runtime (POST
  // /project-hub/settings), so a getter is resolved at EXECUTE time. A plain
  // string is still accepted for direct callers/tests.
  const resolveRoot = () => {
    const value = typeof rootOrGetter === 'function' ? rootOrGetter() : rootOrGetter
    return value === undefined || value === null ? '' : String(value)
  }

  try {
    const tools = ctxOrTools && ctxOrTools.tools ? ctxOrTools.tools : ctxOrTools
    if (!tools || typeof tools.register !== 'function') return null

    return tools.register({
      name: 'record_module_done',
      description:
        '在确实完成了某个模块的具体开发任务时调用此工具。将本次任务的核心成果、涉及文件与约束沉淀为高保真 Markdown 档案，供后续任务衔接。绝不要在未完成任务时随意调用。',
      parameters: {
        type: 'object',
        properties: {
          projectId: {
            type: 'string',
            description: '所属项目 ID（如 novel-video, claw-game）',
          },
          bigTag: {
            type: 'string',
            description: '归属大标签/业务子系统（如 [Media-多媒体渲染], [UI-交互界面]）',
          },
          smallTag: {
            type: 'string',
            description: '归属小标签/具体功能点（如 音画时间轴对齐）',
          },
          summary: {
            type: 'string',
            description: '核心目标与技术背景概述',
          },
          details: {
            type: 'string',
            description: '核心实现细节、关键算法与踩坑避雷约定',
          },
          deliverables: {
            type: 'array',
            items: { type: 'string' },
            description: '本次改动或交付的核心文件相对路径列表',
          },
        },
        required: ['projectId', 'bigTag', 'smallTag', 'summary'],
      },
      output: {
        schema: { type: 'object' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args, sessionCtx) {
        const globalRoot = resolveRoot()
        const cwd = (sessionCtx && sessionCtx.session && sessionCtx.session.header && sessionCtx.session.header.cwd) || globalRoot
        const sessionId = (sessionCtx && sessionCtx.session && sessionCtx.session.id) || ''

        try {
          const res = writeTagDoc(globalRoot, {
            projectId: args.projectId,
            bigTag: args.bigTag,
            smallTag: args.smallTag,
            workspacePath: cwd,
            sessionId,
            summary: args.summary,
            details: args.details,
            deliverables: args.deliverables,
          })
          return {
            ok: true,
            filePath: res.filePath,
            message: `模块【${args.smallTag}】档案已成功沉淀，物理工作区已标注为: ${cwd}`,
          }
        } catch (error) {
          return { ok: false, error: String(error) }
        }
      },
    })
  } catch {
    return null
  }
}
