/**
 * Cross-knowledge-base search for ima.
 *
 * The ima OpenAPI requires a single `knowledge_base_id` per search call and offers no
 * cross-library endpoint, no relevance score, and a hard 100-hit cap with no pagination
 * fields. A thin passthrough would hand all three problems to the model. This module
 * solves them, and — more importantly — reports them, because a ranking that looks
 * authoritative while being a guess is worse than no ranking at all.
 *
 * @module dsh-ima-kb/fanout
 */

import { mediaLabel } from './client.js'

/** The service's hard cap. [MEASURED] a query matching more than 100 hits returns exactly 100. */
export const HIT_CAP = 100

/**
 * Run `tasks` with at most `limit` in flight, preserving result order.
 *
 * @param items - the inputs.
 * @param limit - maximum concurrent tasks; values below 1 are treated as 1.
 * @param worker - async function receiving one item.
 * @returns results in input order.
 */
async function mapLimit(items, limit, worker) {
  const width = Math.max(1, Math.min(limit, items.length || 1))
  const results = new Array(items.length)
  let next = 0
  async function run() {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, run))
  return results
}

/**
 * Score one hit by how its *title* relates to the query, and say which rule fired.
 *
 * The reason travels with the score so the rendered output can state why a row leads. This
 * is the honest form of the ranking the API does not provide: it ranks titles, which is all
 * the service exposes, because `highlight_content` is empty in every measured response.
 *
 * @param title - the hit's title.
 * @param query - the user's query, as typed.
 * @returns a score and a short Chinese reason.
 */
function scoreHit(title, query) {
  const t = title.toLowerCase()
  const q = query.toLowerCase().trim()
  if (q.length === 0) return { score: 10, reason: '无查询词' }
  if (t === q) return { score: 100, reason: '标题完全匹配' }
  if (t.startsWith(q)) return { score: 80, reason: '标题前缀匹配' }
  if (t.includes(q)) return { score: 60, reason: '标题包含' }
  // The service matched something other than a visible title: folded folder name, tag, or
  // body text it does not return. Ranked last and labelled as such rather than guessed at.
  return { score: 30, reason: '仅服务端匹配（标题无查询词）' }
}

/**
 * Search across every accessible knowledge base.
 *
 * @param options - the client, the query, and the strategy knobs.
 * @returns a report object with ranked hits, per-library status, and explicit gaps.
 */
export async function fanOutSearch(options) {
  const {
    client,
    query,
    concurrency = 4,
    maxHitsPerLibrary = HIT_CAP,
    skipKnowledgeBaseIds = [],
    preferOwned = true,
    maxPages = 25,
  } = options

  // The catalogue must be complete or a library is silently absent from every result, so
  // this walks the cursor rather than taking the first page of 20.
  const catalogue = await client.listAllKnowledgeBases('', maxPages)
  const skip = new Set(skipKnowledgeBaseIds)
  const libraries = catalogue.items.filter((kb) => kb.id && !skip.has(kb.id))

  const perLibrary = await mapLimit(libraries, concurrency, async (kb) => {
    try {
      const result = await client.searchKnowledge(kb.id, query)
      return { kb, ...result, error: undefined }
    } catch (error) {
      // One library failing must not void the answer from the others: a permission error on
      // a subscribed library is routine, not exceptional.
      return {
        kb,
        items: [],
        truncated: false,
        returned: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  const hits = []
  for (const library of perLibrary) {
    for (const item of library.items.slice(0, maxHitsPerLibrary)) {
      const { score, reason } = scoreHit(item.title, query)
      hits.push({
        ...item,
        knowledgeBaseId: library.kb.id,
        knowledgeBaseName: library.kb.name,
        owned: library.kb.owned,
        score,
        reason,
        libraryTruncated: library.truncated,
      })
    }
  }

  // Deterministic ordering: score, then owned-before-subscribed when the caller wants it,
  // then a stable title/id tiebreak so two identical runs cannot reorder rows.
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (preferOwned && a.owned !== b.owned) return a.owned ? -1 : 1
    const byTitle = a.title.localeCompare(b.title, 'zh-Hans-CN')
    return byTitle !== 0 ? byTitle : String(a.mediaId).localeCompare(String(b.mediaId))
  })

  // Duplicate detection. Two libraries legitimately hold the same document; the same
  // *media_id* appearing twice is a service artefact and is dropped outright.
  const seenMedia = new Set()
  const deduped = []
  for (const hit of hits) {
    if (seenMedia.has(hit.mediaId)) continue
    seenMedia.add(hit.mediaId)
    deduped.push(hit)
  }

  const truncatedLibraries = perLibrary.filter((l) => l.truncated).map((l) => l.kb.name)
  const failedLibraries = perLibrary.filter((l) => l.error).map((l) => ({ name: l.kb.name, error: l.error }))
  const totalReturned = perLibrary.reduce((sum, l) => sum + l.returned, 0)

  return {
    query,
    librariesSearched: perLibrary.length,
    librariesSkipped: libraries.length === catalogue.items.length ? [] : catalogue.items.filter((k) => skip.has(k.id)).map((k) => k.name),
    hits: deduped,
    totalReturned,
    truncatedLibraries,
    failedLibraries,
    catalogueTruncated: catalogue.truncated === true,
  }
}

/**
 * Render a fan-out report for a model, keeping the disclosure inseparable from the data.
 *
 * The limits ride the same string as the hits on purpose: a model that receives only the
 * rows will confidently describe a truncated, title-only, excerpt-free result as a
 * complete answer. Every caveat here is one that was measured, not defensive boilerplate.
 *
 * @param report - the object {@link fanOutSearch} returned.
 * @param options - rendering knobs: how many hits, and how much of each row.
 * @returns the model-facing text.
 */
export function renderReport(report, options = {}) {
  const maxRows = options.maxRows ?? 25
  const lines = []
  lines.push(`跨库检索「${report.query}」：扫描 ${report.librariesSearched} 个知识库，命中 ${report.totalReturned} 条（去重后 ${report.hits.length} 条）。`)

  const limits = []
  if (report.truncatedLibraries.length > 0) {
    limits.push(
      `⚠️ 以下知识库命中达到 ${HIT_CAP} 条上限，**结果被静默截断**，可能还有更多：`
      + report.truncatedLibraries.join('、')
      + '。请把查询词收窄后重新检索。',
    )
  }
  limits.push('⚠️ 检索结果**不含正文片段**：ima 的 `highlight_content` 实测恒为空，命中只说明该文档存在，不证明正文含查询词。')
  limits.push('⚠️ 排序为**本地启发式**（按标题匹配强度），ima 不返回相关度分数。')
  if (report.failedLibraries.length > 0) {
    limits.push(
      '⚠️ 以下知识库检索失败（其余结果不受影响）：'
      + report.failedLibraries.map((f) => `${f.name}（${f.error}）`).join('；'),
    )
  }
  if (report.catalogueTruncated) limits.push('⚠️ 知识库清单本身未列完，可能还有未扫描的库。')
  lines.push(...limits)
  lines.push('')

  if (report.hits.length === 0) {
    lines.push('没有命中。可尝试：换用更短的关键词、去掉专有名词后缀、或确认目标知识库在清单中。')
    return lines.join('\n')
  }

  lines.push(`按本地排序取前 ${Math.min(maxRows, report.hits.length)} 条：`)
  for (const hit of report.hits.slice(0, maxRows)) {
    lines.push(
      `- [${hit.reason}] ${hit.title}`
      + `\n    类型：${mediaLabel(hit.mediaType)}｜知识库：${hit.knowledgeBaseName}`
      + `${hit.owned ? '（自有）' : '（订阅）'}｜media_id：${hit.mediaId}`,
    )
  }
  if (report.hits.length > maxRows) {
    lines.push(`（另有 ${report.hits.length - maxRows} 条未显示。）`)
  }
  lines.push('')
  lines.push('要读某条的正文：先看它的类型。网页（media_type 2）且属于**自有**知识库时，可用 ima_media_info 取回原始 URL，再用 web_fetch 抓正文；其余类型 ima 开放接口无法回读，需到 ima 客户端查看。')
  return lines.join('\n')
}
