# dsh-ima-kb

把腾讯 **ima**（ima.copilot）的知识库接进 DeepSeek Harness：注册 9 个宿主平面工具，
让任意会话都能检索、浏览、并（有限地）读取你的 ima 知识库。

本文件里每一条接口行为都是**在真实账号上实测**得到的，并标注了与第三方文档不符之处。
请把"实测"当作依据，不要把它当作可有可无的注释 —— 下面第 2 节全是文档说错了的地方。

---

## 1. 它解决什么

ima 没有跨知识库检索接口，没有相关度分数，命中还有 100 条硬上限。把接口原样透传给模型，
模型得到的是"看起来完整、实际被截断、且无法判断相关度"的结果。本插件的价值就在这一层：

| 工具 | 作用 |
| --- | --- |
| `ima_kb_list` | 列出全部可访问知识库（自有/订阅、条目数、角色、类型） |
| `ima_kb_search` | **跨全部知识库并行检索**，按标题匹配强度本地排序，去重，显式标注截断 |
| `ima_kb_browse` | 按游标浏览知识库内容与子文件夹 |
| `ima_media_info` | 判断某条能否回读；可读时给出原始 URL |
| `ima_import_url` | 把网页 URL 批量导入知识库（1–10 条） |
| `ima_upload_file` | **上传本机文件到自有知识库**：查重 → create_media → COS 直传 → add_knowledge |
| `ima_note_create` | 新建 Markdown 笔记到 ima |
| `ima_note_get` | 读取笔记正文（按 maxChars 截断，避免刷爆上下文） |
| `ima_note_list` | 列出笔记本与笔记 |

设计上刻意把**限制**与**结果**放在同一段文本里返回。只给结果的工具会让模型把一个被截断、
无片段、无相关度的列表当成完整答案讲给用户听。

## 2. 实测的接口真相（与第三方文档冲突之处）

### 2.1 字段名在不同接口之间不一致

| 接口 | 返回的字段 |
| --- | --- |
| `search_knowledge_base` | `kb_id` / `kb_name`，另加 `member_count` `content_count` `description` `creator` `role_type` `base_type` |
| `get_knowledge_base`、`get_addable_knowledge_base_list` | `id` / `name` |

把 `id` 当成 `search_knowledge_base` 的字段会读到 `undefined`，并表现成"知识库为空"。
插件在客户端层统一归一化。

### 2.2 `search_knowledge` 不返回任何翻页字段

实测返回体只有 `info_list`，**没有** `is_end`、也**没有** `next_cursor`。文档声称的翻页不存在。

### 2.3 100 条硬上限是真的

对一个 18,500 条的自有知识库查询一个高频词，返回**恰好 100 条**，且没有任何截断信号。
所以 `len == 100` 就应当被视为"可能还有更多"——插件据此打出显式警告。

### 2.4 `highlight_content` 恒为空

`highlight_content` 字段存在于每一条命中里，但在**三次不同查询、共 143 条**命中中**全部为空**。
所以检索只能证明"该文档存在"，**不能**证明"正文含该查询词"。任何要求"给出原文片段作为证据"
的用法在此接口下都不成立。

### 2.5 正文基本读不到

`get_media_info` 的实测结果：

| 条目 | 结果 |
| --- | --- |
| 网页（`media_type` 2），**自有**知识库 | `code 0`，返回 `url_info.url` ✅ |
| 网页，**订阅**知识库 | `220030 没有权限通过skill获取订阅知识库的文件` |
| PDF / 笔记 / 其他，自有知识库 | `220030 该文件获取失败，请至ima内查看处理` |
| 文件夹（`media_type` 99） | `220030` |

**本版本没有任何 `download_url`。** 唯一的读取闭环是：网页类型 → 拿到原始 URL → 用 DSH 自己的
`web_fetch` 抓正文。也就是说，ima 提供的是**指针**，正文由 DSH 取。

### 2.6 根目录 id 不等于知识库 id

文档说根目录的 `folder_id` 等于 `knowledge_base_id`。实测把 `knowledge_base_id` 当 `folder_id` 传，
`import_urls` 与 `get_knowledge_list` 都会以 `222000 文件夹不存在` 拒绝。

真实的根目录 id 要从 `get_knowledge_list` 的 `current_path[0].folder_id` 读，它与知识库 id 不同。
插件在需要根目录时会自动解析。

### 2.7 `search_knowledge_base` 的 `limit` 上限是 20

文档写 `1-50`，实测 `limit: 50` 被拒绝：`code 51, invalid SearchKnowledgeBaseReq.Limit:
value must be inside range (0, 20]`。插件改为按 20 分页并沿游标取全量清单——否则超过 20 个
知识库的账号会静默漏扫。

### 2.8 文件夹是 `media_type: 99`

`get_knowledge_list` 会把文件夹和文件混在同一个 `knowledge_list` 里，文件夹用 **99** 标记，
而文档的 MediaType 枚举里根本没有这个值。

### 2.9 笔记接口存在但不完整

`openapi/note/v1/list_notebook` 返回 `code 0`，`search_note` 传文档里的参数形状会返回
`100001 ListNoteBook param is error`。本插件因此**只做知识库**，不碰笔记。

## 3. 安装与配置

### 3.1 安装（宿主平面一行）

```powershell
dsh plugin --profile web add C:\Users\<你>\.dsh\plugins\dsh-ima-kb
```

插件必须放在 `$DSH_HOME/plugins/` 之下、**仓库之外**：本机主仓库只负责 preset，
不承载 Cordis 插件。

### 3.2 配置行

写进 `$DSH_HOME/profiles/web/cordis.patch.yml`。必须用 `insert:` 包装 —— 没有它的行是
"按 id 覆盖既有行"，对这个不存在的 id 只会记一条警告然后跳过：

```yaml
- insert:
    - id: ima-kb
      name: 'dsh-ima-kb'
      config:
        clientIdRef: IMA_OPENAPI_CLIENTID
        apiKeyRef: IMA_OPENAPI_APIKEY
        searchConcurrency: 4
        maxRows: 25
        preferOwned: true
```

### 3.3 凭证

**绝不把密钥写进 `cordis.yml`。** 配置里只写引用名，值存在 `$DSH_HOME/.credentials.yaml`
的 `refs:` 段：

```yaml
version: 1
refs:
  IMA_OPENAPI_CLIENTID: <你的 Client ID>
  IMA_OPENAPI_APIKEY: <你的 API Key>
```

该文件由 `dsh-credentials-local` 用 chokidar 监听，**改动会热加载，无需重启**。
凭证在 `https://ima.qq.com/agent-interface` 生成（需先登录 ima 账号）。

## 4. 两个必须知道的工程约束

### 4.1 本插件的宿主半边**不能有 bare import**（裸包名）

约束只针对**裸标识符** —— `@deepseek-ai/…`、`js-yaml`、任何包名。
**插件自己文件之间的相对 import 完全没问题**，下面就在用（`./client.js`、`./fanout.js` 两个）。
本节早先写成"里没有任何 import"是**说法错误**（当时的 `lib/index.js` 头部注释也这么写），
已被评审指出并改正 —— 那种写法恰好会诱使后来者去"修好"一个本来正确的文件。

约束本身是真的。`sanctioned` 的安装方式（`dsh plugin add`）会把这个包软链接进
`profiles/web/node_modules/`，而 Node 解析软链接模块自身的**裸标识符**时用的是链接的
**真实路径**（`$DSH_HOME/plugins/dsh-ima-kb`）——那个目录之上没有 `node_modules`。实测：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
   imported from C:\Users\…\.dsh\plugins\dsh-ima-kb\lib\index.js
```

而**同样的 import 写在 profile 目录里的文件中却成功**（对照实验）。所以
`lib/index.js` 不 import 任何**包**：`defineTool`、参数 schema 编译器、以及 Config 的
Standard Schema 校验都是在包内按 `@deepseek-ai/dsh-tools` 与 cordis 的契约自己实现的。
**不要"好心"把它们改成裸包名 import —— 那会立刻复现上面这个错误。**

需要第三方包时（如 COS 的 SDK），做法是把它装进**插件自己的** `node_modules`
（`npm install` 于插件目录），再用**动态 import** 载入 —— 真实路径向上第一跳就能解析到。

### 4.2 挂载验证的边界

`agentPresets.standingKeyFor(id)` 是唯一的挂载验证，但它需要 `cordis_*` 工具，
而那些工具只在 shipped `cordis` preset 的会话里存在。**本插件开发时所在会话没有它们**，
所以验证方式是：

1. `dsh --profile web --dump-config` —— 行确实进入组合树，且无 patch 警告；
2. 一个从 profile 目录按**包名**导入、跑真实 `apply()`、并用真实凭证执行全部工具的检查脚本。

第 2 项能证明模块解析、Config 校验、参数 schema 编译、以及每个工具的执行路径；
它**不能**证明 Cordis 的服务注入，那只有真实挂载才会显示。

## 5. COS 上传：三个实测的坑（以及为什么必须用官方 SDK）

文件上传的链路是 `create_media` → COS 直传 → `add_knowledge`。前两个坑是**真机上传撞出来的**，
不是读文档看出来的：

1. **`bucket_name` 里已经含 appid**。它读作 `ima-share-kb-1258344701`，而 `appid` 是
   `1258344701`。照"`${bucket}-${appid}`"拼会得到 `ima-share-kb-1258344701-1258344701`，
   COS 直接回 `NoSuchBucket`。
2. **`custom_domain` 是 CDN 域名，不能用来上传**。`ima-share-kb.image.myqcloud.com` 对 PUT
   回 **403 且 body 为空**，响应头里是 `server: Lego Server` + `x-cache-lookup` ——
   腾讯 CDN 边缘就把请求挡了，根本没到 COS。写请求必须打到 COS 源站
   `${bucket}.cos.${region}.myqcloud.com`。
3. **签名必须交给官方 SDK**。手写签名器被**证伪**而非仅被怀疑：五种推导写法全部
   `SignatureDoesNotMatch`，而证据把差异点钉得很死 —— COS 回显的 `<FormatString>` 与发送的
   规范串**逐字节相同**（`put\n/{key}\n\n`），却给出**不同的散列**，因此唯一的变量是派生出的
   签名密钥。去掉 `x-cos-security-token` 头后报 `InvalidAccessKeyId`，反过来证明这是会话凭证、
   token 传法是对的。所以改用 `cos-nodejs-sdk-v5`（腾讯官方），以**动态 import** 载入
   —— 静态 import 会触发 4.1 的失败模式。**不要再手写签名器**，除非重跑上面那个实验。

依赖：`cos-nodejs-sdk-v5` 装在插件**自己的** `node_modules` 里（`npm install` 于插件目录），
因此从 realpath 向上第一跳就能解析到，与 4.1 的约束不冲突。

## 6. 尚未实现 / 尚未验证

- **笔记搜索**：`search_note` 实测报 `100001 ListNoteBook param is error`（换参数名也无效），
  本插件不使用它。笔记的 create / get / list 三条通路**均已实测可用**。
- **删除**：**开放接口完全没有删除能力**。知识库侧 `delete_knowledge`／`del_knowledge`／
  `delete_media`，笔记侧 `delete_doc`／`del_doc`／`delete_note`／`remove_doc`／`trash_doc`
  —— 全部返回 **404**。误导入或误创建的条目只能在 ima 客户端里手工处理。
- **大小上限**（Excel/TXT/MD ≤10MB、图片 ≤30MB、PDF/Word/PPT ≤200MB）来自第三方文档，
  **未实测**；插件按它做上传前拦截，但不要把它当成已验证的精确值。

## 7. 卸载

```powershell
dsh plugin --profile web remove dsh-ima-kb
```

并从 `cordis.patch.yml` 删掉那一行。凭证可保留（无副作用）或从
`.credentials.yaml` 的 `refs:` 段移除。
