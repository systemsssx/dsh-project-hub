/**
 * dsh-project-hub — doc-manager.js
 * Manages the three-tier workspace hierarchy:
 *   Root Workspace (e.g. C:\work)
 *     -> Project Workspace (e.g. C:\work\<projectId>)
 *       -> Subtask Workspace (e.g. C:\work\<projectId>\subtasks\<subtaskName>)
 * Also manages two-tier tag markdown documentation under:
 *   <projectDir>/.dsh-hub/docs/<bigTag>/<smallTag>.md
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, basename, dirname, isAbsolute } from 'node:path'

/** Sanitize string for valid directory/filename */
export function sanitizeName(str) {
  if (!str) return 'untitled'
  return String(str).replace(/[<>:"/\\|?*]+/g, '-').trim() || 'item'
}

/** Format local date string YYYYMMDD-HHmmss */
export function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Format local date string "YYYY-MM-DD HH:mm" (append-record headings). */
export function localMinuteStamp(date) {
  const d = date instanceof Date ? date : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Characters Windows forbids in a file name; control chars are rejected too. */
const INVALID_TAG_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/

/**
 * Validate one 大标签 / 小标签 before it is used as a path segment.
 * Pure: no filesystem access. Returns `{ ok: true, value }` or
 * `{ ok: false, code, message }` with a user-facing Chinese message.
 *
 * Rejected: non-strings, empty/blank strings, leading/trailing whitespace,
 * `.` / `..`, the Windows-reserved characters (`\ / : * ? " < > |`) and
 * control chars, names ending in a dot/space (Windows would strip it, making
 * the real file differ from the requested name) and names over 80 chars.
 */
export function validateTagName(raw, label) {
  const field = label || '标签'
  if (typeof raw !== 'string') return { ok: false, code: 'tag_invalid', message: `${field}必须是字符串。` }
  if (!raw || !raw.trim()) return { ok: false, code: 'tag_required', message: `${field}不能为空。` }
  if (raw.trim() !== raw) {
    return { ok: false, code: 'tag_invalid', message: `${field}不能包含前后空格：「${raw}」。` }
  }
  if (/^\.+$/.test(raw)) return { ok: false, code: 'tag_invalid', message: `${field}不能是「${raw}」。` }
  if (INVALID_TAG_CHARS.test(raw)) {
    return {
      ok: false,
      code: 'tag_invalid',
      message: `${field}不能包含 \\ / : * ? " < > | 或控制字符：「${raw}」。`,
    }
  }
  if (/[. ]$/.test(raw)) {
    return { ok: false, code: 'tag_invalid', message: `${field}不能以空格或句点结尾：「${raw}」。` }
  }
  if (raw.length > 80) {
    return { ok: false, code: 'tag_invalid', message: `${field}过长（最多 80 个字符）。` }
  }
  return { ok: true, value: raw }
}

/** List one 大标签's MD files directly under an explicit project directory. */
export function listBigTagDocs(projectDir, bigTag) {
  const bigDir = join(projectDir, '.dsh-hub', 'docs', sanitizeName(bigTag || ''))
  if (!existsSync(bigDir)) return []
  const rows = []
  const mdFiles = readdirSync(bigDir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith('.md'))
    .map((f) => f.name)
    .sort()
  for (const mdName of mdFiles) {
    const fullPath = join(bigDir, mdName)
    let workspacePath = projectDir
    let updatedAt = ''
    try {
      const raw = readFileSync(fullPath, 'utf8')
      const wsMatch = /workspace_path:\s*["']?([^"'\n\r]+)["']?/i.exec(raw)
      if (wsMatch) workspacePath = wsMatch[1].trim().replace(/\\\\/g, '\\')
      const timeMatch = /last_updated:\s*["']?([^"'\n\r]+)["']?/i.exec(raw)
      if (timeMatch) updatedAt = timeMatch[1].trim()
    } catch {
      /* ignore read errors */
    }
    rows.push({ smallTag: mdName.replace(/\.md$/, ''), file: fullPath, workspacePath, updatedAt })
  }
  return rows
}

/** Ensure a directory exists */
export function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** Get projects config file path */
function getProjectsJsonPath(globalRoot) {
  return join(globalRoot, '.dsh-hub', 'projects.json')
}

/**
 * Initialize project registry if not present.
 * Auto-detects common existing folders in globalRoot if empty.
 */
export function initProjectRegistry(globalRoot) {
  ensureDir(join(globalRoot, '.dsh-hub'))
  const p = getProjectsJsonPath(globalRoot)
  if (!existsSync(p)) {
    const initialProjects = [
      {
        id: 'novel-video',
        name: '小说视频生成工作流',
        path: join(globalRoot, 'novel-video'),
        defaultTags: ['Media-多媒体渲染', 'UI-交互界面', 'Core-业务核心'],
      },
      {
        id: 'game-claw',
        name: '抓娃娃机控制系统',
        path: join(globalRoot, 'claw-game'),
        defaultTags: ['Physics-物理核心', 'UI-控制台', 'Assets-资源管线'],
      },
      {
        id: 'epub-tool',
        name: '电子书 UI 自动化管线',
        path: join(globalRoot, 'epub-tool'),
        defaultTags: ['UI-交互界面', 'Parser-解析器', 'Pipeline-构建管线'],
      },
    ]
    writeFileSync(p, JSON.stringify(initialProjects, null, 2), 'utf8')
    return initialProjects
  }
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/**
 * Remove ONE project **from the registry only** — an “unregister / 移出列表”
 * operation, never a physical delete.
 *
 * Deliberately scoped: this function reads `.dsh-hub/projects.json`, filters the
 * entry out and writes the file back through the exact same JSON shape
 * `initProjectRegistry`/`createProject` use. It performs **no** `rm`/`unlink`/
 * `rmdir`/`rename` and never touches `<projectDir>`, `subtasks/` or
 * `.dsh-hub/docs/**`, so the user can re-register the same folder later and all
 * knowledge-base markdown survives untouched.
 *
 * Idempotent: a second call for the same id reports `removed: false` and leaves
 * the registry file byte-identical.
 *
 * @param globalRoot - Root workspace that owns `.dsh-hub/projects.json`.
 * @param projectId - Registry id to unregister.
 * @returns `{ removed, projectId, project?, projects }`.
 */
export function removeProjectFromRegistry(globalRoot, projectId) {
  const raw = projectId == null ? '' : String(projectId).trim()
  const projects = initProjectRegistry(globalRoot)
  if (!raw) return { removed: false, projectId: '', projects }

  const index = projects.findIndex(
    (item) => item && (item.id === raw || sanitizeName(item.id) === raw),
  )
  if (index < 0) return { removed: false, projectId: raw, projects }

  const removedProject = projects[index]
  const next = projects.slice(0, index).concat(projects.slice(index + 1))
  writeFileSync(getProjectsJsonPath(globalRoot), JSON.stringify(next, null, 2), 'utf8')
  return {
    removed: true,
    projectId: removedProject.id,
    project: removedProject,
    projects: next,
  }
}

/** List all projects with their two-tier tags & MD count */
export function listProjectsWithDocs(globalRoot) {
  const projects = initProjectRegistry(globalRoot)
  return projects.map((proj) => {
    const projDir = proj.path || join(globalRoot, proj.id)
    const docsDir = join(projDir, '.dsh-hub', 'docs')
    ensureDir(docsDir)

    const tagTree = {}
    let mdCount = 0

    if (existsSync(docsDir)) {
      const bigDirs = readdirSync(docsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)

      for (const bigTag of bigDirs) {
        tagTree[bigTag] = []
        const bigDirPath = join(docsDir, bigTag)
        const mdFiles = readdirSync(bigDirPath, { withFileTypes: true })
          .filter((f) => f.isFile() && f.name.endsWith('.md'))
          .map((f) => f.name)

        for (const mdName of mdFiles) {
          mdCount++
          const fullPath = join(bigDirPath, mdName)
          const smallTag = mdName.replace(/\.md$/, '')
          let workspacePath = projDir
          let updatedAt = ''
          try {
            const raw = readFileSync(fullPath, 'utf8')
            const wsMatch = /workspace_path:\s*["']?([^"'\n\r]+)["']?/i.exec(raw)
            if (wsMatch) workspacePath = wsMatch[1].trim().replace(/\\\\/g, '\\')
            const timeMatch = /last_updated:\s*["']?([^"'\n\r]+)["']?/i.exec(raw)
            if (timeMatch) updatedAt = timeMatch[1].trim()
          } catch {
            /* ignore read errors */
          }
          tagTree[bigTag].push({
            smallTag,
            file: fullPath,
            workspacePath,
            updatedAt,
          })
        }
      }
    }

    // Ensure default tags are represented in tree even if empty
    if (Array.isArray(proj.defaultTags)) {
      for (const t of proj.defaultTags) {
        if (!tagTree[t]) tagTree[t] = []
      }
    }

    return {
      ...proj,
      projDir,
      tagTree,
      mdCount,
    }
  })
}

/** Create a new project */
export function createProject(globalRoot, { id, name, defaultTags }) {
  const cleanId = sanitizeName(id || name)
  const projDir = join(globalRoot, cleanId)
  ensureDir(projDir)
  ensureDir(join(projDir, '.dsh-hub', 'docs'))
  ensureDir(join(projDir, 'subtasks'))

  const p = getProjectsJsonPath(globalRoot)
  const projects = initProjectRegistry(globalRoot)
  const existing = projects.find((x) => x.id === cleanId)

  const tags = Array.isArray(defaultTags) && defaultTags.length > 0
    ? defaultTags
    : ['UI-交互界面', 'Core-业务核心', 'Media-多媒体渲染']

  if (!existing) {
    projects.push({
      id: cleanId,
      name: name || cleanId,
      path: projDir,
      defaultTags: tags,
    })
    writeFileSync(p, JSON.stringify(projects, null, 2), 'utf8')
  }

  // Pre-create big tag folders
  for (const t of tags) {
    ensureDir(join(projDir, '.dsh-hub', 'docs', sanitizeName(t)))
  }

  return { id: cleanId, name: name || cleanId, path: projDir }
}

/**
 * Calculate the exact sub-workspace directory.
 * If 0 tags: project root.
 * If 1 tag: project/subtasks/<tag>/
 * If >1 tags: project/subtasks/combo-<date>-<tag1>-<tag2>/
 */
export function computeSubWorkspace(globalRoot, projectId, selectedSmallTags) {
  const projects = initProjectRegistry(globalRoot)
  const proj = projects.find((x) => x.id === projectId)
  const projDir = proj && proj.path ? proj.path : join(globalRoot, projectId)
  ensureDir(projDir)

  if (!Array.isArray(selectedSmallTags) || selectedSmallTags.length === 0) {
    return {
      cwd: projDir,
      mode: 'root',
      desc: '项目根工作区',
    }
  }

  if (selectedSmallTags.length === 1) {
    const singleName = sanitizeName(selectedSmallTags[0])
    const singleDir = join(projDir, 'subtasks', singleName)
    ensureDir(singleDir)
    return {
      cwd: singleDir,
      mode: 'single',
      desc: `单标签专属子工作区 (${singleName})`,
    }
  }

  // Multiple tags -> new combo sub-workspace
  const tagSummary = selectedSmallTags.slice(0, 3).map(sanitizeName).join('-')
  const comboDir = join(projDir, 'subtasks', `combo-${stamp().slice(0, 8)}-${tagSummary}`)
  ensureDir(comboDir)
  return {
    cwd: comboDir,
    mode: 'combo',
    desc: `多标签复合子工作区 (${selectedSmallTags.length} 标签隔离)`,
  }
}

/**
 * Return the existing frontmatter of `content` with ONLY `last_updated`
 * replaced/inserted. Every other field, the body and the line endings of the
 * untouched parts stay byte-identical (append mode must never rewrite them).
 */
function touchLastUpdated(content, now) {
  const value = JSON.stringify(now)
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(content)
  if (!match) return content
  const inner = match[2]
  const rest = content.slice(match[0].length)
  const next = /^last_updated\s*:.*$/m.test(inner)
    ? inner.replace(/^last_updated\s*:.*$/m, `last_updated: ${value}`)
    : (inner ? inner + '\n' : '') + `last_updated: ${value}`
  return match[1] + next + match[3] + rest
}

/**
 * One appended archive section: a timestamped heading plus ONLY this call's
 * summary / details / deliverables. The five-section template is never
 * repeated — the hand-written body above stays exactly as it was.
 */
function appendSectionText(config, now) {
  const title = typeof config.title === 'string' ? config.title.trim() : ''
  const heading = title
    ? `## 追加记录（${localMinuteStamp(now)}） · ${title}`
    : `## 追加记录（${localMinuteStamp(now)}）`
  const parts = []
  const summary = typeof config.summary === 'string' ? config.summary.trim() : ''
  const details = typeof config.details === 'string' ? config.details.trim() : ''
  const deliverables = Array.isArray(config.deliverables)
    ? config.deliverables.filter((file) => file !== undefined && file !== null).map((file) => String(file))
    : []
  if (summary) parts.push(summary)
  if (details) parts.push(details)
  if (deliverables.length > 0) {
    parts.push(['**涉及文件**', ...deliverables.map((file) => `- \`${file}\``)].join('\n'))
  }
  if (parts.length === 0) parts.push('（本次未提供正文内容）')
  return [heading, '', parts.join('\n\n')].join('\n')
}

/**
 * Write (or append to) the standardized markdown file for one small tag.
 *
 * `mode`:
 *   - 'append' (DEFAULT) — when the file already exists, its whole body is
 *     kept (hand-written sections included) and ONE timestamped
 *     `## 追加记录（YYYY-MM-DD HH:mm）` section is appended with this call's
 *     summary / details / deliverables. Frontmatter: only `last_updated` is
 *     touched. When the file does not exist the 5-section template is created.
 *   - 'overwrite' — legacy behaviour: rewrite the file from the 5-section
 *     template (destroys hand-written text; explicit callers only).
 *   - 'create' — create only; throws `error.code = 'doc_exists'` when the file
 *     already exists (used by POST /project-hub/create-doc).
 *
 * `projectPath` (absolute) overrides the `projectId` registry lookup, so a
 * folder can be written without being registered.
 *
 * @returns `{ filePath, frontmatter, mode, appended }`.
 */
export function writeTagDoc(globalRoot, options) {
  const config = options || {}
  const {
    projectId,
    projectName,
    projectPath,
    bigTag,
    smallTag,
    workspacePath,
    sessionId,
    summary,
    details,
    deliverables,
    title,
    mode,
  } = config
  const createOnly = mode === 'create'
  const appendMode = !createOnly && mode !== 'overwrite'

  const projects = initProjectRegistry(globalRoot)
  const proj = projects.find((x) => x && x.id === projectId)
  let projDir = proj && proj.path ? proj.path : join(globalRoot, projectId || '')
  if (typeof projectPath === 'string' && projectPath.trim() && isAbsolute(projectPath.trim())) {
    projDir = resolve(projectPath.trim())
  }
  const cleanBig = sanitizeName(bigTag || 'General')
  const cleanSmall = sanitizeName(smallTag || 'misc')

  const targetDir = join(projDir, '.dsh-hub', 'docs', cleanBig)
  ensureDir(targetDir)
  const filePath = join(targetDir, `${cleanSmall}.md`)

  const now = new Date().toISOString()
  const frontmatter = [
    '---',
    `project_id: ${JSON.stringify(projectId)}`,
    `project_name: ${JSON.stringify(projectName || proj?.name || projectId)}`,
    `big_tag: ${JSON.stringify(cleanBig)}`,
    `small_tag: ${JSON.stringify(cleanSmall)}`,
    `workspace_path: ${JSON.stringify(workspacePath || projDir)}`,
    `last_updated: ${JSON.stringify(now)}`,
    `session_id: ${JSON.stringify(sessionId || '')}`,
    'status: "completed"',
    '---',
  ].join('\n')

  // ── Append mode: existing file is preserved, one dated section is added. ──
  if (appendMode && existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8')
    const updated = touchLastUpdated(existing, now)
    const section = appendSectionText(config, new Date())
    const body = `${updated.replace(/[\r\n]+$/, '')}\n\n${section}\n`
    writeFileSync(filePath, body, 'utf8')
    return { filePath, frontmatter, mode: 'append', appended: true }
  }

  // ── Create-only mode: never clobber an existing archive. ─────────────────
  if (createOnly && existsSync(filePath)) {
    const error = new Error(`已存在同名小标签档案：「${cleanSmall}.md」（大小写不同也视为同名）。`)
    error.code = 'doc_exists'
    throw error
  }

  const displayTitle = typeof title === 'string' && title.trim() ? title.trim() : cleanSmall
  const body = [
    frontmatter,
    '',
    `# 模块全景档案：${displayTitle}`,
    `> **物理工作区**：\`${workspacePath || projDir}\`  `,
    `> **最后更新**：${now} | **归属大标签**：\`[${cleanBig}]\``,
    '',
    '### 一、 核心目标与技术背景',
    summary || '本模块为项目规划的关键功能单元，记录该模块的架构目标与开发状态。',
    '',
    '### 二、 核心实现细节与关键变更',
    details || '已完成核心逻辑与接口实现。',
    '',
    '### 三、 涉及的核心文件与职责',
    Array.isArray(deliverables) && deliverables.length > 0
      ? deliverables.map((f) => `- \`${f}\``).join('\n')
      : '- 暂无交付文件清单',
    '',
    '### 四、 踩坑记录、硬性约束与重要约定',
    '- 保持环境配置与工作区路径隔离，避免跨项目硬编码绝对路径。',
    '',
    '### 五、 未完成项与下一步推荐方向',
    '- [ ] 根据后续业务需要持续演进本模块。',
    '',
  ].join('\n')

  writeFileSync(filePath, body, 'utf8')
  return {
    filePath,
    frontmatter,
    mode: createOnly ? 'create' : appendMode ? 'append' : 'overwrite',
    appended: false,
  }
}

/**
 * Read specific small tag markdown files from a project.
 */
export function readTagDocs(globalRoot, projectId, selectedSmallTags) {
  const projects = initProjectRegistry(globalRoot)
  const proj = projects.find((x) => x.id === projectId)
  const projDir = proj && proj.path ? proj.path : join(globalRoot, projectId)
  const docsDir = join(projDir, '.dsh-hub', 'docs')

  if (!existsSync(docsDir) || !Array.isArray(selectedSmallTags)) return []

  const results = []
  const bigDirs = readdirSync(docsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  for (const bigTag of bigDirs) {
    const bigDirPath = join(docsDir, bigTag)
    for (const tag of selectedSmallTags) {
      const cleanSmall = sanitizeName(tag)
      const targetFile = join(bigDirPath, `${cleanSmall}.md`)
      if (existsSync(targetFile)) {
        try {
          const content = readFileSync(targetFile, 'utf8')
          // Extract workspace path
          let ws = projDir
          const wsMatch = /workspace_path:\s*["']?([^"'\n\r]+)["']?/i.exec(content)
          if (wsMatch) ws = wsMatch[1].trim().replace(/\\\\/g, '\\')
          results.push({
            bigTag,
            smallTag: cleanSmall,
            file: targetFile,
            workspacePath: ws,
            content,
          })
        } catch {
          /* ignore */
        }
      }
    }
  }
  return results
}
