/**
 * dsh-ima-kb — Tencent ima (ima.copilot) knowledge-base tools for DeepSeek Harness.
 *
 * ## Why this file carries no BARE imports
 *
 * The constraint is on **bare specifiers only** — `@deepseek-ai/…`, `js-yaml`, any package
 * name. Relative imports among this plugin's own files are fine and are used below (two of
 * them, for `./client.js` and `./fanout.js`). An earlier version of this header claimed "there
 * is no `import` statement below", which was **false as written** and is exactly the kind of
 * overstatement that makes a later reader "fix" a correct file; a reviewer caught it.
 *
 * The constraint itself is real. The sanctioned install (`dsh plugin --profile web add <path>`)
 * links this package into `~/.dsh/profiles/web/node_modules/dsh-ima-kb`, and Node resolves a
 * symlinked module's own bare specifiers from the link's **real path** —
 * `$DSH_HOME/plugins/dsh-ima-kb` — which has no `node_modules` above it. Measured, not assumed:
 * importing this package by name from the profile directory fails with
 *
 *     ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
 *        imported from C:\Users\…\.dsh\plugins\dsh-ima-kb\lib\index.js
 *
 * while the identical imports from a file *inside the profile directory* succeed. So a bare
 * import here cannot resolve, and adding one reintroduces the failure. The two helpers this file
 * needs from `@deepseek-ai/dsh-tools` — the parameter-spec → JSON-Schema compiler and the
 * `defineTool` wrapper — are therefore implemented below against the contract read out of that
 * package's own source. A third-party package that must live elsewhere (COS's SDK) is loaded by
 * **dynamic** import from this package's own `node_modules`, which the real path does reach.
 *
 * ## Plane
 *
 * A HOST-plane row, one instance per process: a knowledge base is account-level and shared
 * by every session. It publishes **no** Cordis service and only registers tools into
 * `ctx.tools`, so there is no `provide()`, no service name to collide with, and no realm to
 * place it in.
 *
 * ## What it can and cannot do — measured, and the descriptions must not overstate it
 *
 * - **Find** works well. Listing knowledge bases and fanning a query across all of them is
 *   the core capability.
 * - **Read** is nearly absent. `get_media_info` returns a URL only for `media_type: 2`
 *   (网页) inside an **owned** knowledge base; subscribed libraries answer `220030`, and no
 *   `download_url` exists anywhere in this build. For the readable case the tool returns the
 *   source URL and DSH's own `web_fetch` retrieves the text — this integration supplies a
 *   pointer, never the body.
 * - **Write** is proven for URL import, end to end with a `media_id` and a read-back. File
 *   upload can obtain a COS grant (`create_media` answered `code 0`), but the upload itself
 *   and the following `add_knowledge` are not implemented here.
 *
 * @module dsh-ima-kb
 */

import { ImaClient, ImaError, mediaLabel, MEDIA_FOLDER } from './client.js'
import { fanOutSearch, renderReport, HIT_CAP } from './fanout.js'

/** Cordis plugin name for loader diagnostics. */
export const name = 'ima-kb'

/** The two host services this row consumes: the credential seam and the tool registry. */
export const inject = ['credentials', 'tools']

/** Reference-name grammar, copied from `credentialRef`'s implementation. */
const REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Extension → media type and MIME type, from the service's documented MediaType enum.
 *
 * `media_type: 16` (视频解析) is deliberately absent: ima only accepts those inside the
 * desktop client, so offering the extension here would fail at the service instead of at
 * the tool boundary.
 */
const EXT_PROFILE = {
  pdf: { mediaType: 1, contentType: 'application/pdf', label: 'PDF' },
  doc: { mediaType: 3, contentType: 'application/msword', label: 'Word' },
  docx: { mediaType: 3, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  ppt: { mediaType: 4, contentType: 'application/vnd.ms-powerpoint', label: 'PPT' },
  pptx: { mediaType: 4, contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PPT' },
  xls: { mediaType: 5, contentType: 'application/vnd.ms-excel', label: 'Excel' },
  xlsx: { mediaType: 5, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel' },
  csv: { mediaType: 5, contentType: 'text/csv', label: 'Excel(CSV)' },
  md: { mediaType: 7, contentType: 'text/markdown', label: 'Markdown' },
  markdown: { mediaType: 7, contentType: 'text/markdown', label: 'Markdown' },
  png: { mediaType: 9, contentType: 'image/png', label: '图片' },
  jpg: { mediaType: 9, contentType: 'image/jpeg', label: '图片' },
  jpeg: { mediaType: 9, contentType: 'image/jpeg', label: '图片' },
  webp: { mediaType: 9, contentType: 'image/webp', label: '图片' },
  txt: { mediaType: 13, contentType: 'text/plain', label: 'TXT' },
  xmind: { mediaType: 14, contentType: 'application/x-xmind', label: 'Xmind' },
  mp3: { mediaType: 15, contentType: 'audio/mpeg', label: '音频' },
  m4a: { mediaType: 15, contentType: 'audio/x-m4a', label: '音频' },
  wav: { mediaType: 15, contentType: 'audio/wav', label: '音频' },
  aac: { mediaType: 15, contentType: 'audio/aac', label: '音频' },
}

/**
 * Size ceilings per media type, in MB.
 *
 * ⚠️ **These come from the third-party documentation and are NOT measured** (unlike every
 * other limit this plugin enforces, which was read off the live service). They are still
 * worth checking before a request, because the alternative is discovering the limit by
 * uploading a file the service then rejects. Re-measure before relying on an exact number.
 */
const SIZE_LIMIT_MB = {
  5: 10,  // Excel
  13: 10, // TXT
  14: 10, // Xmind
  7: 10,  // Markdown
  9: 30,  // 图片
  1: 200, // PDF
  3: 200, // Word
  4: 200, // PPT
  15: 200, // 音频（另有「最长 2 小时」限制，未实测）
}

/** Defaults for every config field, applied by the schema below. */
const DEFAULTS = {
  clientIdRef: 'IMA_OPENAPI_CLIENTID',
  apiKeyRef: 'IMA_OPENAPI_APIKEY',
  requestTimeoutMs: 20000,
  maxRetries: 2,
  searchConcurrency: 4,
  maxRows: 25,
  skipKnowledgeBaseIds: [],
  preferOwned: true,
}

/**
 * Config schema, hand-written as a Standard Schema object.
 *
 * Cordis asks a plugin's `Config` for exactly one thing — `runtime.Config['~standard']
 * .validate(config)`, synchronously — so this satisfies the loader without importing a
 * schema library. A bad field is still reported at load time, as
 * `invalid config: … (at <field>)`, which is the text the mount check surfaces.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-ima-kb',
    /**
     * Validate and default one config object.
     * @param raw - the row's config, as the loader read it from YAML.
     * @returns `{ value }` with defaults applied, or `{ issues }` naming each bad field.
     */
    validate(raw) {
      const issues = []
      const input = raw === undefined || raw === null ? {} : raw
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'config must be an object' }] }
      }
      const value = { ...DEFAULTS }
      for (const field of ['clientIdRef', 'apiKeyRef']) {
        const given = input[field]
        if (given === undefined) continue
        if (typeof given !== 'string' || !REFERENCE_NAME.test(given)) {
          issues.push({
            message: `${field} expected a credential reference name (letters, digits and underscore, not leading with a digit) but got ${JSON.stringify(given)}`,
            path: [field],
          })
          continue
        }
        value[field] = given
      }
      for (const field of ['requestTimeoutMs', 'maxRetries', 'searchConcurrency', 'maxRows']) {
        const given = input[field]
        if (given === undefined) continue
        if (!Number.isInteger(given) || given <= 0) {
          issues.push({ message: `${field} expected a positive integer but got ${JSON.stringify(given)}`, path: [field] })
          continue
        }
        value[field] = given
      }
      if (input.skipKnowledgeBaseIds !== undefined) {
        const list = input.skipKnowledgeBaseIds
        if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
          issues.push({ message: 'skipKnowledgeBaseIds expected an array of strings', path: ['skipKnowledgeBaseIds'] })
        } else value.skipKnowledgeBaseIds = list
      }
      if (input.preferOwned !== undefined) {
        if (typeof input.preferOwned !== 'boolean') {
          issues.push({ message: `preferOwned expected a boolean but got ${JSON.stringify(input.preferOwned)}`, path: ['preferOwned'] })
        } else value.preferOwned = input.preferOwned
      }
      const known = new Set([...Object.keys(DEFAULTS)])
      for (const key of Object.keys(input)) {
        if (!known.has(key)) issues.push({ message: `unknown config field "${key}"`, path: [key] })
      }
      return issues.length > 0 ? { issues } : { value }
    },
  },
}

/**
 * Compile one declared parameter into JSON Schema and collect its `required` entry.
 *
 * This mirrors `parameterSchemaSpecToJsonSchema` for the subset of the spec DSL these tools
 * declare. A construct outside that subset throws here, at registration, rather than
 * reaching the model as a parameter the runtime never enforces.
 *
 * @param name - the parameter name, for error messages.
 * @param spec - the declared spec.
 * @returns a raw JSON Schema node.
 */
function compileParameter(name, spec) {
  if (spec === null || typeof spec !== 'object') {
    throw new Error(`ima-kb: parameter "${name}" must be a schema spec object`)
  }
  const node = { type: spec.type }
  if (spec.description !== undefined) node.description = spec.description
  if (spec.type === 'array') {
    if (spec.items === undefined) throw new Error(`ima-kb: parameter "${name}" of type array requires items`)
    node.items = compileParameter(`${name}[]`, spec.items)
  }
  if (spec.type === 'object') {
    if (spec.properties === undefined) throw new Error(`ima-kb: parameter "${name}" of type object requires properties`)
    const properties = {}
    const required = []
    for (const [key, child] of Object.entries(spec.properties)) {
      const { schema, isRequired } = compileProperty(key, child)
      properties[key] = schema
      if (isRequired) required.push(key)
    }
    node.properties = properties
    if (required.length > 0) node.required = required
  }
  return node
}

/**
 * Compile one property entry, reporting whether it is required.
 * @param key - the property name.
 * @param spec - the declared spec.
 * @returns the schema node and the required flag.
 */
function compileProperty(key, spec) {
  return { schema: compileParameter(key, spec), isRequired: spec?.required === true }
}

/**
 * Compile a parameter-spec map into an open object-rooted JSON Schema.
 * @param spec - the tool's `parameters`.
 * @returns the raw schema the registry stores and the model sees.
 */
export function parameterSchemaSpecToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, child] of Object.entries(spec)) {
    const { schema, isRequired } = compileProperty(key, child)
    properties[key] = schema
    if (isRequired) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * Validate model-supplied arguments against a compiled parameter schema.
 *
 * The registry validates at dispatch, but doing it here too means a tool body can rely on
 * its declared types and a bad call is reported as `invalid arguments: …` rather than
 * surfacing as a downstream `undefined` inside an ima payload.
 *
 * @param schema - the compiled schema from {@link parameterSchemaSpecToJsonSchema}.
 * @param args - the candidate arguments.
 * @returns path-qualified violations; empty means valid.
 */
function findViolations(schema, args, path = '') {
  const violations = []
  const at = path === '' ? '(root)' : path
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return [`${at} expected an object`]
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) violations.push(`${at}.${key} is required`)
  }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    const value = args[key]
    if (value === undefined) continue
    violations.push(...findViolationsForValue(sub, value, `${path}.${key}`))
  }
  return violations
}

/**
 * Validate one value against one schema node.
 * @param schema - the node.
 * @param value - the value.
 * @param path - the path so far, for messages.
 * @returns violations.
 */
function findViolationsForValue(schema, value, path) {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' ? [] : [`${path} expected a string`]
    case 'integer':
      return Number.isInteger(value) ? [] : [`${path} expected an integer`]
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [] : [`${path} expected a number`]
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} expected a boolean`]
    case 'array':
      if (!Array.isArray(value)) return [`${path} expected an array`]
      return value.flatMap((entry, index) => findViolationsForValue(schema.items, entry, `${path}[${index}]`))
    default:
      return []
  }
}

/**
 * Define a registry-ready tool.
 *
 * A local stand-in for `@deepseek-ai/dsh-tools`'s `defineTool`, implementing the two things
 * the registry actually consumes: `parameters` precompiled to JSON Schema (a definition
 * without it registers and then shows the model no parameters at all — the silent failure
 * this function exists to prevent), and `output.schema` carried through for
 * `assertSupportedJsonSchema` at registration.
 *
 * @param options - name, description, parameter spec, output projection, and execute.
 * @returns the definition to pass to `ctx.tools.register`.
 */
function defineTool(options) {
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  const output = {
    schema: options.output.schema,
    render: options.output.render,
  }
  return {
    name: options.name,
    description: options.description,
    parameters,
    output,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe }),
    async execute(args, exec) {
      const violations = findViolations(parameters, args, '')
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    },
  }
}

/** Render one text block. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * Build the model-facing body describing what is known about one item's readability.
 * @param title - the item title.
 * @param info - the normalised result of `getMediaInfo`.
 * @returns the text to show.
 */
function describeMedia(title, info) {
  if (info.readable) {
    return `${title}\n可回读：是（网页条目）\n原始 URL：${info.sourceUrl}\n`
      + '用 web_fetch 抓取该 URL 即可取得正文 —— 正文由 DSH 抓取，不是 ima 提供的。'
  }
  return `${title}\n可回读：否\n原因：${info.note}\n`
    + 'ima 开放接口不提供该类型的正文，请到 ima 客户端内查看。'
}

/**
 * Fan out over an explicit list of knowledge bases, used when the caller named ids.
 * @param api - the client.
 * @param libraries - the resolved knowledge-base entries.
 * @param query - the query.
 * @returns the same report shape `fanOutSearch` produces.
 */
async function searchGiven(api, libraries, query) {
  const perLibrary = []
  for (const kb of libraries) {
    try {
      const result = await api.searchKnowledge(kb.id, query)
      perLibrary.push({ kb, ...result, error: undefined })
    } catch (error) {
      perLibrary.push({
        kb,
        items: [],
        truncated: false,
        returned: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const hits = []
  for (const library of perLibrary) {
    for (const item of library.items) {
      const t = item.title.toLowerCase()
      const q = query.toLowerCase().trim()
      const score = t === q ? 100 : t.startsWith(q) ? 80 : t.includes(q) ? 60 : 30
      hits.push({
        ...item,
        knowledgeBaseId: library.kb.id,
        knowledgeBaseName: library.kb.name,
        owned: library.kb.owned,
        score,
        reason: score === 100 ? '标题完全匹配' : score === 80 ? '标题前缀匹配' : score === 60 ? '标题包含' : '仅服务端匹配（标题无查询词）',
        libraryTruncated: library.truncated,
      })
    }
  }
  hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.title.localeCompare(b.title, 'zh-Hans-CN')))
  const seen = new Set()
  const deduped = hits.filter((h) => (seen.has(h.mediaId) ? false : (seen.add(h.mediaId), true)))
  return {
    query,
    librariesSearched: perLibrary.length,
    librariesSkipped: [],
    hits: deduped,
    totalReturned: perLibrary.reduce((n, l) => n + l.returned, 0),
    truncatedLibraries: perLibrary.filter((l) => l.truncated).map((l) => l.kb.name),
    failedLibraries: perLibrary.filter((l) => l.error).map((l) => ({ name: l.kb.name, error: l.error })),
    catalogueTruncated: false,
  }
}

/**
 * Mount the ima tools.
 * @param ctx - plugin context carrying `credentials` and the host tool registry.
 * @param config - the validated configuration.
 */
export function apply(ctx, config) {
  /** Build a client per operation, so a rotated credential reaches the very next call. */
  const client = () => ImaClient.fromCredentials(ctx.credentials, config.clientIdRef, config.apiKeyRef, {
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    onLog: (event) => ctx.logger?.warn?.(`dsh-ima-kb: ${event.message}`),
  })

  /**
   * Turn a credential or transport failure into a readable refusal. A *success* is never
   * fabricated: the guard only rewrites failures, and the missing-credential message names
   * the exact reference and where to put it.
   */
  const guard = async (run) => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof ImaError) return `ima 调用失败：${error.message}`
      return `ima 调用异常：${error instanceof Error ? error.message : String(error)}`
    }
  }

  ctx.tools.register(defineTool({
    name: 'ima_kb_list',
    description:
      '列出当前 ima 账号可访问的知识库（含自建与订阅），带条目数、角色、类型。'
      + '这是其他 ima 工具的前置：fan-out 检索的清单，也是判断某个库是否自有的依据。',
    parameters: {
      query: { type: 'string', description: '可选：按名称过滤知识库；省略则全部列出。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      return guard(async () => {
        const api = await client()
        const page = await api.listAllKnowledgeBases(args.query ?? '')
        if (page.items.length === 0) {
          return args.query ? `没有名称匹配「${args.query}」的知识库。` : '该账号下没有可访问的知识库。'
        }
        const lines = [`ima 知识库清单（${page.items.length} 个${page.truncated ? '，已达翻页上限、可能未列完' : ''}）：`, '']
        for (const kb of page.items) {
          lines.push(
            `- ${kb.name}${kb.owned ? '（自有）' : '（订阅）'}`
            + `\n    条目数：${kb.contentCount}｜成员：${kb.memberCount}｜角色：${kb.roleType || '未知'}｜类型：${kb.baseType || '未知'}`
            + `\n    knowledge_base_id：${kb.id}`,
          )
          if (kb.description) lines.push(`    简介：${kb.description.replace(/\s+/g, ' ').slice(0, 120)}`)
        }
        lines.push('')
        lines.push('注意：**订阅**知识库的条目正文无法通过 ima 开放接口读取（实测 220030）；自有知识库中仅「网页」类型可回读原始 URL。')
        return lines.join('\n')
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ima_kb_search',
    description:
      '跨全部可访问知识库检索。ima 本身没有跨库检索接口，本工具做并行 fan-out 并按标题匹配强度本地排序。'
      + '结果只含标题与条目定位，**不含正文片段**；每个库最多返回 100 条，达到上限会显式标注可能被截断。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词。建议先宽后窄：过窄会因 100 条上限而丢失结果。' },
      knowledgeBaseIds: { type: 'array', items: { type: 'string' }, description: '可选：只检索这些 knowledge_base_id；省略则检索全部可访问知识库。' },
      maxRows: { type: 'integer', description: '可选：最多显示多少条，默认取配置值。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      return guard(async () => {
        const api = await client()
        if (Array.isArray(args.knowledgeBaseIds) && args.knowledgeBaseIds.length > 0) {
          const catalogue = await api.listAllKnowledgeBases('')
          const wanted = new Set(args.knowledgeBaseIds)
          const libraries = catalogue.items.filter((kb) => wanted.has(kb.id))
          const missing = args.knowledgeBaseIds.filter((id) => !catalogue.items.some((kb) => kb.id === id))
          if (libraries.length === 0) {
            return `指定的知识库都不在清单中：${missing.join('、')}。先用 ima_kb_list 取正确的 id。`
          }
          const rendered = renderReport(await searchGiven(api, libraries, args.query), { maxRows: args.maxRows ?? config.maxRows })
          return missing.length > 0 ? `${rendered}\n\n（另有 ${missing.length} 个指定 id 未找到：${missing.join('、')}）` : rendered
        }
        const report = await fanOutSearch({
          client: api,
          query: args.query,
          concurrency: config.searchConcurrency,
          skipKnowledgeBaseIds: config.skipKnowledgeBaseIds,
          preferOwned: config.preferOwned,
        })
        return renderReport(report, { maxRows: args.maxRows ?? config.maxRows })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ima_kb_browse',
    description:
      '浏览某个知识库的内容（含子文件夹），按游标翻页。返回条目与文件夹，文件夹可再用本工具深入。'
      + 'ima 的目录常带一层与库同名的“顶层文件夹”，从根浏览即可看到。',
    parameters: {
      knowledgeBaseId: { type: 'string', required: true, description: '目标知识库 id（来自 ima_kb_list）。' },
      folderId: { type: 'string', description: '可选：要展开的文件夹 id；省略则列出库的顶层。' },
      cursor: { type: 'string', description: '可选：翻页游标，首次省略。' },
      limit: { type: 'integer', description: '可选：每页条数，1–50，默认 30。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      return guard(async () => {
        const api = await client()
        const limit = Math.min(Math.max(args.limit ?? 30, 1), 50)
        const page = await api.listKnowledge(args.knowledgeBaseId, args.folderId, args.cursor ?? '', limit)
        const path = page.path.map((p) => p.name).filter(Boolean).join(' / ')
        const lines = [`路径：${path || '(根)'}｜本页 ${page.items.length} 条｜${page.isEnd ? '已到末尾' : '还有下一页'}`, '']
        if (page.items.length === 0) lines.push('该文件夹为空。')
        for (const item of page.items) {
          lines.push(item.isFolder
            ? `- [文件夹] ${item.title}\n    folder_id：${item.mediaId}`
            : `- [${mediaLabel(item.mediaType)}] ${item.title}\n    media_id：${item.mediaId}`)
        }
        if (!page.isEnd && page.nextCursor) {
          lines.push('')
          lines.push(`下一页 cursor：${page.nextCursor}`)
        }
        return lines.join('\n')
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ima_media_info',
    description:
      '查询一个知识库条目的可读性，并在可读时给出原始 URL。实测：仅**自有**知识库中的「网页」条目可回读；'
      + '订阅知识库的条目、以及 PDF／笔记／文件夹等类型一律返回 220030，此时本工具会明确说明无法回读。',
    parameters: {
      mediaId: { type: 'string', required: true, description: '条目 id（来自 ima_kb_search 或 ima_kb_browse）。' },
      title: { type: 'string', description: '可选：条目标题，仅用于回显。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      return guard(async () => {
        const api = await client()
        return describeMedia(args.title ?? args.mediaId, await api.getMediaInfo(args.mediaId))
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ima_import_url',
    description:
      '把一个或多个网页 URL 导入指定知识库（ima 会抓取解析并入库），支持批量 1–10 条。这是已验证可用的写入能力。'
      + '注意：folder_id 必须传**真实根目录 id**，不能传 knowledge_base_id —— 后者会被 ima 以 222000 拒绝；省略 folder_id 时本工具会自动解析根目录。',
    parameters: {
      knowledgeBaseId: { type: 'string', required: true, description: '目标知识库 id。' },
      urls: { type: 'array', items: { type: 'string' }, required: true, description: '要导入的 http/https URL，1–10 条。' },
      folderId: { type: 'string', description: '可选：目标文件夹 id；省略则导入根目录。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => false,
    async execute(args) {
      return guard(async () => {
        const urls = (args.urls ?? []).filter((u) => /^https?:\/\//i.test(u))
        if (urls.length === 0) return '没有可导入的 URL：必须是 http:// 或 https:// 开头（ima 不支持 file://）。'
        if (urls.length > 10) return `一次最多导入 10 条，收到 ${urls.length} 条。`
        const api = await client()
        const folderId = args.folderId ?? await api.resolveRootFolder(args.knowledgeBaseId)
        const results = await api.importUrls(args.knowledgeBaseId, folderId, urls)
        const lines = [`导入结果（目标目录 id：${folderId}）：`, '']
        for (const url of urls) {
          const r = results[url]
          if (!r) lines.push(`- 未返回结果：${url}`)
          else if (r.ret_code === 0) lines.push(`- 成功：${url}\n    media_id：${r.media_id}`)
          else lines.push(`- 失败（ret_code ${r.ret_code}）：${url}`)
        }
        return lines.join('\n')
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ima_upload_file',
    description:
      '把本机文件上传到指定的**自有**知识库：同名检查 → create_media 取 COS 凭证 → 签名直传 → add_knowledge 挂载。'
      + '支持 pdf/word/ppt/excel/md/txt/图片/xmind/音频。上传前按类型校验大小上限；同名文件默认拦下。',
    parameters: {
      path: { type: 'string', required: true, description: '本机文件绝对路径。' },
      knowledgeBaseId: { type: 'string', required: true, description: '目标知识库 id；必须是自有库。' },
      folderId: { type: 'string', description: '可选：目标文件夹 id；省略则用根目录。' },
      title: { type: 'string', description: '可选：入库标题；省略则用文件名。' },
      allowDuplicate: { type: 'boolean', description: '可选：true 时跳过同名检查强制上传。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => false,
    async execute(args) {
      return guard(async () => {
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        const absolute = path.resolve(args.path)
        let stat
        try {
          stat = await fs.stat(absolute)
        } catch {
          return `找不到文件：${absolute}`
        }
        if (!stat.isFile()) return `不是文件：${absolute}`

        const ext = path.extname(absolute).replace(/^\./, '').toLowerCase()
        const profile = EXT_PROFILE[ext]
        if (!profile) return `不支持的后缀 .${ext}。支持：${Object.keys(EXT_PROFILE).join('、')}`

        const limitMb = SIZE_LIMIT_MB[profile.mediaType] ?? 200
        const sizeMb = stat.size / (1024 * 1024)
        if (sizeMb > limitMb) {
          return `文件 ${sizeMb.toFixed(1)}MB 超过 ${profile.label} 的上限 ${limitMb}MB，ima 会拒绝。请先压缩或拆分。`
        }

        const api = await client()
        const fileName = path.basename(absolute)

        if (!args.allowDuplicate) {
          const repeated = await api.checkRepeatedNames(args.knowledgeBaseId, args.folderId, [
            { name: fileName, media_type: profile.mediaType },
          ])
          if (repeated.some((r) => r.is_repeated)) {
            return `知识库中已存在同名文件「${fileName}」，已停止上传以避免重复入库。如需强制上传，传 allowDuplicate=true。`
          }
        }

        const { mediaId, cosCredential } = await api.createMedia({
          fileName,
          fileSize: stat.size,
          contentType: profile.contentType,
          knowledgeBaseId: args.knowledgeBaseId,
          fileExt: ext,
        })
        if (!mediaId || !cosCredential) return 'create_media 未返回 media_id 或 COS 凭证，已中止。'

        const content = await fs.readFile(absolute)
        const uploaded = await api.uploadToCos(cosCredential, content)
        const added = await api.addKnowledge({
          mediaType: profile.mediaType,
          mediaId,
          title: args.title ?? fileName,
          knowledgeBaseId: args.knowledgeBaseId,
          folderId: args.folderId,
          cosKey: uploaded.cosKey,
          fileName,
          fileSize: stat.size,
        })

        return `上传成功：${args.title ?? fileName}\n`
          + `  类型：${profile.label}（media_type ${profile.mediaType}）\n`
          + `  大小：${sizeMb.toFixed(2)}MB → COS ${uploaded.host}\n`
          + `  media_id：${added.media_id ?? mediaId}\n`
          + '注意：ima 开放接口**不提供正文回读**，该文件入库后需到 ima 客户端查看内容。'
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ima_note_create',
    description:
      '在 ima 笔记中新建一篇 Markdown 笔记。实测 import_doc 会真正校验并接受内容，是可用写入能力。'
      + '返回的 doc_id 可用 ima_note_get 读回。',
    parameters: {
      content: { type: 'string', required: true, description: '笔记正文，Markdown 格式。' },
      title: { type: 'string', description: '可选：笔记标题。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => false,
    async execute(args) {
      return guard(async () => {
        const api = await client()
        const data = await api.importDoc(args.content, args.title)
        const id = data.doc_id ?? data.note_id ?? data.id
        const lines = [`笔记已创建${args.title ? `：${args.title}` : ''}`]
        if (id) lines.push(`doc_id：${id}`)
        const other = Object.keys(data).filter((k) => !['doc_id', 'note_id', 'id'].includes(k))
        if (other.length > 0) lines.push(`其他返回字段：${other.join('、')}`)
        if (!id) lines.push(`（未识别出 doc_id，完整返回：${JSON.stringify(data).slice(0, 300)}）`)
        return lines.join('\n')
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ima_note_get',
    description:
      '读取 ima 笔记正文。实测该接口强制校验归属：非本人笔记返回 210005 GetNoteContent not author。'
      + '正文按 maxChars 截断，避免刷爆上下文。',
    parameters: {
      docId: { type: 'string', required: true, description: '笔记 id（doc_id）。' },
      format: { type: 'integer', description: '可选：目标内容格式，默认 0。' },
      maxChars: { type: 'integer', description: '可选：正文最多返回多少字符，默认 4000。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      return guard(async () => {
        const api = await client()
        const data = await api.getDocContent(args.docId, args.format ?? 0)
        const body = data.content ?? data.doc_content ?? data.text ?? data.body ?? ''
        if (typeof body !== 'string' || body.length === 0) {
          return `未取到正文。返回字段：${Object.keys(data).join('、') || '(空)'}`
        }
        const cap = args.maxChars ?? 4000
        const clipped = body.length > cap
        return `${data.title ? `# ${data.title}\n\n` : ''}${body.slice(0, cap)}`
          + (clipped ? `\n\n…（已截断，原文共 ${body.length} 字符；调大 maxChars 取更多）` : '')
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ima_note_list',
    description:
      '列出 ima 笔记与笔记本。账号下没有笔记时返回空列表是正常结果，不是错误。'
      + '（ima 的 search_note 接口实测报 100001 参数错误，本插件不使用它。）',
    parameters: {
      cursor: { type: 'string', description: '可选：翻页游标，首次省略。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      return guard(async () => {
        const api = await client()
        const notebooks = await api.listNotebooks()
        const notes = await api.listNotes(args.cursor ?? '', 20)
        const folders = notebooks.note_folder_infos ?? []
        const list = notes.note_book_list ?? []
        const lines = [`笔记本：${folders.length} 个｜笔记：${list.length} 篇`]
        for (const folder of folders) {
          lines.push(`- [笔记本] ${folder.name ?? folder.title ?? '(未命名)'}｜id ${folder.folder_id ?? folder.id ?? '?'}`)
        }
        for (const note of list) {
          lines.push(`- [笔记] ${note.title ?? '(无标题)'}\n    doc_id：${note.doc_id ?? note.note_id ?? '?'}`)
        }
        if (folders.length === 0 && list.length === 0) lines.push('（该账号下暂无笔记。用 ima_note_create 可以新建。）')
        if (notes.is_end === false && notes.next_cursor) lines.push(`\n下一页 cursor：${notes.next_cursor}`)
        return lines.join('\n')
      })
    },
  }))

  ctx.logger?.info?.(
    `dsh-ima-kb 已挂载：credential refs ${config.clientIdRef} / ${config.apiKeyRef}，`
    + `fan-out 并发 ${config.searchConcurrency}，命中上限 ${HIT_CAP}`,
  )
}

export { MEDIA_FOLDER }
