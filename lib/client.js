/**
 * Tencent ima OpenAPI client.
 *
 * Every shape in this file was measured against the live API on 2026-09-12 rather than
 * taken from documentation, because the published third-party descriptions disagree with
 * the service on four points that matter. Each divergence is marked [MEASURED] below, and
 * the comment records what the documentation claimed so a later reader does not "fix" the
 * code back to the documented behaviour.
 *
 * Transport is plain HTTPS POST with a JSON body. There is no local server: the ima
 * desktop client is a Chromium shell with no control surface (no CDP, no debug port, no
 * local index), so this client is the only route to a knowledge base from here.
 *
 * @module dsh-ima-kb/client
 */

/** API origin. [MEASURED] unsent credentials answer HTTP 401 here, so the path is real. */
export const BASE_URL = 'https://ima.qq.com'

/** Knowledge-base (wiki) API prefix. [MEASURED] single-valued on the live service. */
const WIKI = '/openapi/wiki/v1'

/** Note API prefix. [MEASURED] endpoints answer; the account simply owns no notes yet. */
const NOTE = '/openapi/note/v1'

/** Retryable business codes: request rate control and downstream network failure. */
const RETRYABLE = new Set([110010, 110021])

/** Folder marker. [MEASURED] folders arrive in `knowledge_list` with `media_type: 99`,
 * which the documentation's MediaType enum does not list at all. */
export const MEDIA_FOLDER = 99

/** Human labels for the media_type values this client can actually encounter. */
const MEDIA_LABEL = {
  1: 'PDF',
  2: '网页',
  3: 'Word',
  4: 'PPT',
  5: 'Excel',
  6: '微信公众号文章',
  7: 'Markdown',
  9: '图片',
  11: '笔记',
  12: 'AI 会话',
  13: 'TXT',
  14: 'Xmind',
  15: '录音',
  99: '文件夹',
}

/**
 * Label one media_type for a model-facing string.
 * @param mediaType - the numeric type as returned by the service.
 * @returns a Chinese label, or `类型 N` when the value is one this build does not know.
 */
export function mediaLabel(mediaType) {
  return MEDIA_LABEL[mediaType] ?? `类型 ${mediaType}`
}

/**
 * The error a failed ima call raises. It carries the upstream business code and message so
 * a tool result can show the service's own words, which are already Chinese and actionable.
 */
export class ImaError extends Error {
  /**
   * @param message - model-facing text, derived from the upstream `msg`.
   * @param code - upstream business code, or an HTTP status when the envelope was missing.
   * @param detail - optional extra context (path, retry count).
   */
  constructor(message, code, detail) {
    super(message)
    this.name = 'ImaError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Unwrap the response envelope.
 *
 * [MEASURED] Failure shapes differ across the service and are not interchangeable:
 * a malformed *business* call answers `{ code: 220030, msg: "…" }`, while a malformed
 * *parameter* call answers under the older naming, e.g. `{ retcode: 110001, errmsg: "…" }`.
 * Both are accepted here; treating one as authoritative silently reports success for a
 * failure, which is the single worst outcome for a tool an agent trusts.
 *
 * @param payload - the parsed JSON body.
 * @param path - request path, for the error's detail field.
 * @returns the `data` object, or `{}` when the call legitimately returns no data.
 * @throws {ImaError} when the envelope reports a non-success business code.
 */
function unwrap(payload, path) {
  if (payload === null || typeof payload !== 'object') {
    throw new ImaError('ima 返回了非 JSON 对象响应', 'bad-response', { path })
  }
  const code = payload.code ?? payload.retcode
  if (code !== 0) {
    const msg = payload.msg ?? payload.errmsg ?? '未知错误'
    throw new ImaError(`ima 接口失败（code ${code}）：${msg}`, code, { path })
  }
  return payload.data ?? {}
}

/** Sleep, used only between retries. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * One authenticated ima API client.
 *
 * It holds the resolved credential for the lifetime of one operation batch rather than for
 * the plugin's lifetime: the seam is read per call so a rotated key reaches the next
 * request, which is why {@link ImaClient.fromCredentials} is cheap and re-invoked.
 */
export class ImaClient {
  /**
   * @param options - the credential pair, the per-request timeout, and the retry budget.
   */
  constructor(options) {
    /** @type {string} */ this.clientId = options.clientId
    /** @type {string} */ this.apiKey = options.apiKey
    /** @type {number} */ this.timeoutMs = options.timeoutMs ?? 20000
    /** @type {number} */ this.maxRetries = options.maxRetries ?? 2
    /** @type {(event: object) => void} */ this.onLog = options.onLog ?? (() => {})
  }

  /**
   * Build a client from a credential provider, or fail with a message that says exactly
   * which reference is missing. A tool that silently returns nothing when unconfigured is
   * worse than one that refuses, because the model reports the emptiness as evidence.
   *
   * @param credentials - the harness `credentials` seam.
   * @param clientIdRef - reference name holding the ima Client ID.
   * @param apiKeyRef - reference name holding the ima API Key.
   * @param options - timeout, retry budget, and logger.
   * @returns the client.
   * @throws {ImaError} when either reference resolves to nothing.
   */
  static async fromCredentials(credentials, clientIdRef, apiKeyRef, options = {}) {
    const [clientId, apiKey] = await Promise.all([
      credentials.resolve(clientIdRef),
      credentials.resolve(apiKeyRef),
    ])
    const missing = []
    if (clientId === undefined || clientId.value === '') missing.push(clientIdRef)
    if (apiKey === undefined || apiKey.value === '') missing.push(apiKeyRef)
    if (missing.length > 0) {
      throw new ImaError(
        `ima 凭证未配置：缺少 ${missing.join('、')}。`
          + '\n请登录 https://ima.qq.com/agent-interface 生成 Client ID 与 API Key，'
          + '然后写入凭证存储（$DSH_HOME/.credentials.yaml 的 refs 段），键名与上面一致。',
        'missing-credential',
      )
    }
    return new ImaClient({ clientId: clientId.value, apiKey: apiKey.value, ...options })
  }

  /**
   * POST one JSON body to one ima path, retrying only the codes the service marks retryable.
   *
   * @param path - path beginning with `/openapi/`.
   * @param body - the request body.
   * @returns the unwrapped `data` object.
   * @throws {ImaError} on transport failure, timeout, non-2xx status, or a business failure.
   */
  async call(path, body) {
    let attempt = 0
    for (;;) {
      attempt += 1
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      let response
      let text
      try {
        response = await fetch(`${BASE_URL}${path}`, {
          method: 'POST',
          headers: {
            'ima-openapi-clientid': this.clientId,
            'ima-openapi-apikey': this.apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        text = await response.text()
      } catch (error) {
        clearTimeout(timer)
        const aborted = error instanceof Error && error.name === 'AbortError'
        if (attempt <= this.maxRetries) {
          this.onLog({ level: 'warn', message: `ima ${path} ${aborted ? '超时' : '网络失败'}，重试 ${attempt}` })
          await delay(400 * attempt)
          continue
        }
        throw new ImaError(
          aborted ? `ima 请求超时（${this.timeoutMs}ms）：${path}` : `ima 网络失败：${path}`,
          'transport',
          { path, cause: error instanceof Error ? error.message : String(error) },
        )
      } finally {
        clearTimeout(timer)
      }

      if (response.status === 401 || response.status === 403) {
        throw new ImaError(
          `ima 拒绝凭证（HTTP ${response.status}）。请在 https://ima.qq.com/agent-interface 重新生成后更新凭证存储。`,
          response.status,
          { path },
        )
      }
      if (!response.ok) {
        if (response.status >= 500 && attempt <= this.maxRetries) {
          await delay(400 * attempt)
          continue
        }
        throw new ImaError(`ima 返回 HTTP ${response.status}：${path}`, response.status, { path })
      }

      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new ImaError(`ima 返回了无法解析的响应：${path}`, 'bad-response', { path, body: text.slice(0, 200) })
      }

      const code = payload.code ?? payload.retcode
      if (RETRYABLE.has(code) && attempt <= this.maxRetries) {
        this.onLog({ level: 'warn', message: `ima ${path} 触发频控/下游错误（${code}），重试 ${attempt}` })
        await delay(500 * attempt)
        continue
      }
      return unwrap(payload, path)
    }
  }

  /**
   * List knowledge bases. [MEASURED] this endpoint answers with `kb_id`/`kb_name` plus
   * `member_count`, `content_count`, `description`, `creator`, `role_type` and `base_type`
   * — note the two field names differ from every other endpoint, which uses `id`/`name`.
   * Normalising here is what keeps a caller from reading `undefined` as an empty library.
   *
   * @param query - search text; empty string lists from the start.
   * @param cursor - paging cursor; empty string starts. This endpoint DOES page.
   * @param limit - page size. [MEASURED] the ceiling is **20**: the documentation says
   * `1-50`, but `limit: 50` is rejected with code 51, `value must be inside range (0, 20]`.
   * @returns normalised entries plus the cursor state.
   */
  async searchKnowledgeBase(query = '', cursor = '', limit = 20) {
    const data = await this.call(`${WIKI}/search_knowledge_base`, { query, cursor, limit: Math.min(limit, 20) })
    const list = Array.isArray(data.info_list) ? data.info_list : []
    return {
      items: list.map((entry) => ({
        id: entry.kb_id ?? entry.id,
        name: entry.kb_name ?? entry.name ?? '(未命名)',
        description: entry.description ?? '',
        creator: entry.creator ?? '',
        roleType: entry.role_type ?? '',
        baseType: entry.base_type ?? '',
        contentCount: Number(entry.content_count ?? 0),
        memberCount: Number(entry.member_count ?? 0),
        owned: entry.role_type === '创建者',
      })),
      nextCursor: data.next_cursor,
      isEnd: data.is_end,
    }
  }

  /**
   * List every knowledge base the account can reach, following the cursor.
   *
   * Worth doing properly because the fan-out search is only as complete as this catalogue:
   * a library missing here is silently absent from every search result. Unlike
   * `search_knowledge` — which returns no cursor at all — this endpoint does page, so an
   * account with more than 20 libraries is still scanned in full.
   *
   * @param query - optional name filter.
   * @param maxPages - safety bound, so a cursor that never terminates cannot hang a tool.
   * @returns every entry, and whether the bound was hit before the list ended.
   */
  async listAllKnowledgeBases(query = '', maxPages = 25) {
    const items = []
    let cursor = ''
    let isEnd = true
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.searchKnowledgeBase(query, cursor, 20)
      items.push(...result.items)
      isEnd = result.isEnd !== false
      if (isEnd || !result.nextCursor) return { items, isEnd: true, truncated: false }
      cursor = result.nextCursor
    }
    return { items, isEnd, truncated: true }
  }

  /**
   * Fetch knowledge-base detail by id. The request field is `ids` and the response is an
   * `infos` map keyed by id — not a list, which is the shape a reader expects.
   *
   * @param ids - up to 20 knowledge-base ids.
   * @returns a map of id to detail.
   */
  async getKnowledgeBase(ids) {
    const data = await this.call(`${WIKI}/get_knowledge_base`, { ids })
    return data.infos ?? {}
  }

  /**
   * Browse one knowledge base, or one folder inside it.
   *
   * [MEASURED] traversal has a trap worth stating plainly: the API documentation claims the
   * root folder's id equals the knowledge-base id, and the live service *rejects* that with
   * `222000 文件夹不存在`. The real root folder id is a numeric id that arrives in
   * `current_path[0].folder_id`, so {@link resolveRootFolder} reads it instead of guessing.
   *
   * @param knowledgeBaseId - the knowledge base.
   * @param folderId - a folder id, or omitted for the knowledge base's own top level.
   * @param cursor - paging cursor; empty string starts.
   * @param limit - page size, 1..50.
   * @returns normalised entries, the path, and the cursor state.
   */
  async listKnowledge(knowledgeBaseId, folderId, cursor = '', limit = 50) {
    const body = { cursor, limit, knowledge_base_id: knowledgeBaseId }
    if (folderId) body.folder_id = folderId
    const data = await this.call(`${WIKI}/get_knowledge_list`, body)
    const list = Array.isArray(data.knowledge_list) ? data.knowledge_list : []
    return {
      items: list.map((entry) => ({
        mediaId: entry.media_id,
        title: entry.title ?? '(无标题)',
        mediaType: entry.media_type,
        parentFolderId: entry.parent_folder_id,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        isFolder: entry.media_type === MEDIA_FOLDER,
      })),
      path: Array.isArray(data.current_path) ? data.current_path : [],
      nextCursor: data.next_cursor,
      isEnd: data.is_end,
    }
  }

  /**
   * Search inside ONE knowledge base.
   *
   * Three [MEASURED] limits are enforced by adding fields the service does not send, so a
   * caller cannot mistake a truncated page for a complete answer:
   *
   * - The response carries `info_list` and **nothing else** — no `is_end`, no `next_cursor`.
   *   Paging is impossible, and the documentation's claim that pagination exists is wrong.
   * - The list is hard-capped at 100 hits, measured by querying a library with 18,500 items
   *   for a term matching more than 100: exactly 100 came back, with no truncation signal.
   * - `highlight_content` is present in every item and **empty in every item**, across 143
   *   hits from three different queries. The documentation's "content match returns a
   *   highlighted fragment" does not hold, so no caller may present a hit as evidence that
   *   the wanted text is in that document.
   *
   * @param knowledgeBaseId - the knowledge base to search.
   * @param query - the search text.
   * @returns hits with a `truncated` flag and a `contentCount` for honest reporting.
   */
  async searchKnowledge(knowledgeBaseId, query) {
    const data = await this.call(`${WIKI}/search_knowledge`, {
      query,
      cursor: '',
      knowledge_base_id: knowledgeBaseId,
    })
    const list = Array.isArray(data.info_list) ? data.info_list : []
    return {
      items: list.map((entry) => ({
        mediaId: entry.media_id,
        title: entry.title ?? '(无标题)',
        mediaType: entry.media_type,
        parentFolderId: entry.parent_folder_id,
        // Kept rather than dropped: a later service revision may start populating it, and
        // silently discarding it would hide that improvement.
        highlight: entry.highlight_content ?? '',
      })),
      /** [MEASURED] 100 is the cap, so a 100-length list may be missing hits. */
      truncated: list.length >= 100,
      returned: list.length,
    }
  }

  /**
   * Read one item's metadata.
   *
   * [MEASURED] this is the endpoint the documentation oversells. It returns real content
   * only for `media_type: 2` (网页) inside a knowledge base the caller *owns*:
   *
   * | item | result |
   * | --- | --- |
   * | 网页, owned KB | `code 0`, `{ url_info: { url } }` |
   * | 网页, subscribed KB | `220030 没有权限通过skill获取订阅知识库的文件` |
   * | PDF / 笔记 / 其他, owned KB | `220030 该文件获取失败，请至ima内查看处理` |
   * | folder | `220030` |
   *
   * There is no full-text read for documents, and no `download_url` at all in this build.
   *
   * @param mediaId - the item id.
   * @returns a normalised result naming which of the above happened.
   */
  async getMediaInfo(mediaId) {
    try {
      const data = await this.call(`${WIKI}/get_media_info`, { media_id: mediaId })
      const url = data.url_info?.url
      return {
        readable: typeof url === 'string' && url.length > 0,
        mediaType: data.media_type,
        sourceUrl: url,
        note: typeof url === 'string' && url.length > 0
          ? '这是网页条目：正文需从 sourceUrl 抓取（DSH 的 web_fetch 可以做）。'
          : '该条目没有可回读的正文，请到 ima 客户端内查看。',
      }
    } catch (error) {
      if (error instanceof ImaError) {
        return { readable: false, mediaType: undefined, sourceUrl: undefined, note: error.message }
      }
      throw error
    }
  }

  /**
   * Look up the real root folder id for a knowledge base.
   *
   * @param knowledgeBaseId - the knowledge base.
   * @returns the numeric root folder id.
   * @throws {ImaError} when the service reports no path for the library.
   */
  async resolveRootFolder(knowledgeBaseId) {
    const page = await this.listKnowledge(knowledgeBaseId, undefined, '', 1)
    const root = page.path[0]?.folder_id
    if (typeof root !== 'string' || root.length === 0) {
      throw new ImaError(
        `无法解析知识库 ${knowledgeBaseId} 的根目录 id`,
        'no-root-folder',
      )
    }
    return root
  }

  /**
   * Import web pages into a knowledge base. [MEASURED] works end to end, and the result is
   * observable: one URL in, `ret_code 0` plus a `media_id`, and the new entry appears in
   * `get_knowledge_list`.
   *
   * @param knowledgeBaseId - target knowledge base.
   * @param folderId - target folder; the real root id, never the knowledge-base id.
   * @param urls - 1..10 URLs.
   * @returns per-URL results.
   */
  async importUrls(knowledgeBaseId, folderId, urls) {
    const data = await this.call(`${WIKI}/import_urls`, {
      knowledge_base_id: knowledgeBaseId,
      folder_id: folderId,
      urls,
    })
    return data.results ?? {}
  }

  /**
   * Check whether names already exist in a folder, so an upload can be stopped before it
   * duplicates. [MEASURED] works; `is_repeated` is the field to read.
   *
   * @param knowledgeBaseId - target knowledge base.
   * @param folderId - target folder, or omitted for the top level.
   * @param params - `{ name, media_type }` entries, 1..2000.
   * @returns the service's per-name results.
   */
  async checkRepeatedNames(knowledgeBaseId, folderId, params) {
    const body = { knowledge_base_id: knowledgeBaseId, params }
    if (folderId) body.folder_id = folderId
    const data = await this.call(`${WIKI}/check_repeated_names`, body)
    return Array.isArray(data.results) ? data.results : []
  }

  /**
   * Create a media record and obtain the COS upload grant for it. [MEASURED] returns
   * `code 0` with a full `cos_credential` for an owned knowledge base, which is what makes
   * {@link ImaClient.uploadToCos} possible.
   *
   * @param request - file name, size, MIME type, extension, and target knowledge base.
   * @returns the media id and the COS grant.
   */
  async createMedia(request) {
    const data = await this.call(`${WIKI}/create_media`, {
      file_name: request.fileName,
      file_size: request.fileSize,
      content_type: request.contentType,
      knowledge_base_id: request.knowledgeBaseId,
      file_ext: request.fileExt,
    })
    return { mediaId: data.media_id, cosCredential: data.cos_credential }
  }

  /**
   * Upload bytes to Tencent COS using the grant `create_media` returned.
   *
   * This delegates the request signature to Tencent's own `cos-nodejs-sdk-v5`, loaded with a
   * **dynamic** import so the no-static-import rule the module header explains still holds
   * (the SDK lives in this package's own `node_modules`, which Node reaches from the real
   * path, so the dynamic import resolves where a static one would not).
   *
   * The hand-rolled signer this replaced was falsified rather than merely distrusted. Five
   * derivation formulations all produced `SignatureDoesNotMatch`, and the evidence pinned the
   * disagreement precisely: COS echoed back a `<FormatString>` byte-identical to the canonical
   * string being sent — `put\n/{key}\n\n` — while reporting a **different** hash for it, which
   * makes the derived signing key the only remaining variable. Dropping the
   * `x-cos-security-token` header isolated the credential as session-based
   * (`InvalidAccessKeyId`). Do not reintroduce a hand-rolled signer without re-running that
   * experiment; the canonical-string half was already proven right.
   *
   * Two separate host traps were found the same way and are still honoured below:
   *
   * 1. `bucket_name` already carries the appid — it reads `ima-share-kb-1258344701` while
   *    `appid` is `1258344701` — so composing `${bucket}-${appid}` doubles it and COS answers
   *    `NoSuchBucket`. Both spellings are tried because the SDK's `Bucket` argument takes the
   *    appid separately and the documented composition is therefore ambiguous here.
   * 2. `custom_domain` (`ima-share-kb.image.myqcloud.com`) is the **CDN** host: a PUT there
   *    answers **403 with an empty body** plus `server: Lego Server` and `x-cache-lookup`,
   *    i.e. the CDN edge rejecting it before COS sees it. It is never used for uploads.
   *
   * @param credential - the `cos_credential` object from {@link ImaClient.createMedia}.
   * @param content - the file bytes.
   * @returns the COS object location and the ETag when COS reports one.
   * @throws {ImaError} on a transport failure or a non-2xx answer.
   */
  async uploadToCos(credential, content) {
    const bucket = credential.bucket_name
    const cosKey = credential.cos_key
    if (!bucket || !credential.region || !cosKey) {
      throw new ImaError('COS 凭证缺少 bucket/region/cos_key，无法上传', 'bad-credential', { fields: Object.keys(credential) })
    }
    let COS
    try {
      ;({ default: COS } = await import('cos-nodejs-sdk-v5'))
    } catch (error) {
      throw new ImaError(
        '缺少 COS SDK：请在插件目录执行 npm install cos-nodejs-sdk-v5。'
        + `（${error instanceof Error ? error.message : String(error)}）`,
        'cos-sdk-missing',
      )
    }

    const cos = new COS({
      SecretId: credential.secret_id,
      SecretKey: credential.secret_key,
      SecurityToken: credential.token,
    })

    // The SDK composes `Bucket` with the appid itself, and `bucket_name` already carries it;
    // try the bare name first, then the composed spelling, so neither convention is assumed.
    const candidates = [bucket, `${bucket}-${credential.appid}`]
    let lastError
    for (const candidate of candidates) {
      try {
        const result = await cos.putObject({
          Bucket: candidate,
          Region: credential.region,
          Key: cosKey,
          Body: content,
          ContentLength: content.byteLength,
        })
        const etag = result?.ETag ?? result?.headers?.etag
        return { host: `${candidate}.cos.${credential.region}.myqcloud.com`, cosKey, etag }
      } catch (error) {
        lastError = error
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new ImaError(`COS 上传被拒绝：${detail.slice(0, 300)}`, 'cos-rejected', { bucket: candidates })
  }

  /**
   * Attach an uploaded media record to a knowledge base, completing the upload flow.
   *
   * @param request - the media id from `create_media`, the target library, and file facts.
   * @returns the service's response data.
   */
  async addKnowledge(request) {
    return this.call(`${WIKI}/add_knowledge`, {
      media_type: request.mediaType,
      media_id: request.mediaId,
      title: request.title,
      knowledge_base_id: request.knowledgeBaseId,
      ...(request.folderId ? { folder_id: request.folderId } : {}),
      file_info: {
        cos_key: request.cosKey,
        file_size: request.fileSize,
        last_modify_time: Math.floor(Date.now() / 1000),
        file_name: request.fileName,
      },
    })
  }

  /**
   * Create a note from Markdown.
   *
   * [MEASURED] real, and it validates input: an empty `content` is rejected with
   * `210001 content too long or empty`, so the path reached the business layer rather than
   * 404ing. `content_format: 1` is Markdown.
   *
   * @param content - the note body.
   * @param title - optional note title.
   * @returns the service's response data, which carries the new note's id.
   */
  async importDoc(content, title) {
    return this.call(`${NOTE}/import_doc`, {
      content,
      content_format: 1,
      ...(title ? { title } : {}),
    })
  }

  /**
   * Read a note's body. [MEASURED] the path exists and enforces authorship: a `doc_id` that
   * is not the caller's answers `210005 GetNoteContent not author`.
   *
   * @param docId - the note id.
   * @param targetContentFormat - `0` asks for the plain form.
   * @returns the service's response data.
   */
  async getDocContent(docId, targetContentFormat = 0) {
    return this.call(`${NOTE}/get_doc_content`, { doc_id: docId, target_content_format: targetContentFormat })
  }

  /**
   * List note notebooks.
   * @returns the service's response data.
   */
  async listNotebooks() {
    return this.call(`${NOTE}/list_notebook`, { cursor: '', limit: 20 })
  }

  /**
   * Create a knowledge base. [MEASURED] the route is real and validates its input. Two
   * required fields were pinned by rejected requests, in this order:
   *
   *   1. `code 51, invalid CreateKnowledgeBaseReq.Name: value does not match regex pattern
   *      "^\S[\S ]{0,23}\S?$"` — the name is 1..25 characters, may contain spaces, and may
   *      not start or end with one;
   *   2. `code 51, invalid CreateKnowledgeBaseReq.Type: value must be in list [KBT_MINE_KB
   *      KBT_SHARED_KB KBT_SUBSCRIBED_CREATE_KB]` — the type is required too.
   *
   * `KBT_MINE_KB` is the personal-library value the account's own knowledge bases use.
   *
   * @param name - the knowledge base name, 1..25 characters.
   * @param type - one of `KBT_MINE_KB` | `KBT_SHARED_KB` | `KBT_SUBSCRIBED_CREATE_KB`.
   * @returns the service's response data, which carries the new knowledge base id.
   */
  async createKnowledgeBase(name, type = 'KBT_MINE_KB') {
    return this.call(`${WIKI}/create_knowledge_base`, { name, type })
  }

  /**
   * Create a folder inside a knowledge base. [MEASURED] `knowledge_base_id` and `name` are
   * both required; with them supplied the service answers a business error for an unknown
   * knowledge base (`220004 invalid knowledge_base_id`), which is how the field list was
   * pinned down. The name ceiling is reported as 1..255 runes.
   *
   * This corrects a claim the README used to carry — that the API can only CONSUME folder
   * ids. It can create them.
   *
   * @param knowledgeBaseId - the owning knowledge base.
   * @param name - the folder name, 1..255 characters.
   * @returns the service's response data, which carries the new folder id.
   */
  async createFolder(knowledgeBaseId, name) {
    return this.call(`${WIKI}/create_folder`, { knowledge_base_id: knowledgeBaseId, name })
  }

  /**
   * List notes.
   * @param cursor - paging cursor; empty string starts.
   * @param limit - page size.
   * @returns the service's response data.
   */
  async listNotes(cursor = '', limit = 20) {
    return this.call(`${NOTE}/list_note`, { cursor, limit })
  }
}

export { WIKI, NOTE }
