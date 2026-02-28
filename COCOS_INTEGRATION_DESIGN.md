# Cocos AssetNexus × GitNexus 集成设计

> 目标：将 SQLite-based game-context-server（Cocos Creator 资产扫描器）融合进 GitNexus，以 GitNexus 为主体，Cocos 成为其中一个领域插件。

---

## 零、两个系统现状

### GitNexus（主体）

| 维度 | 现状 |
|---|---|
| 存储 | KuzuDB（嵌入式属性图数据库）|
| 解析 | Tree-sitter（9 种编程语言）|
| 管线 | 7 阶段 Pipeline（扫描→结构→解析→导入→调用→社区→流程）|
| 图类型 | 27+ 节点表 + 单一 CodeRelation 边表 |
| MCP | 7 工具 + 6 资源 |
| 搜索 | BM25 + 语义向量（384 维 HNSW）|

### game-context-server（待融合）

| 维度 | 现状 |
|---|---|
| 存储 | SQLite + FTS5 |
| 解析 | 自定义 .fire/.prefab JSON 解析器 |
| 图类型 | scene / node / component / prefab + 边 |
| MCP | asset_query / asset_impact / asset_community / asset_loading_flow 等 |
| 搜索 | SQLite FTS5 全文检索 |

---

## 一、集成目标

```
GitNexus
├── 代码智能（现有）
│   ├── TypeScript / Python / Go / Rust / Java ...
│   └── 函数调用链、类继承、执行流程
│
└── 游戏资产智能（新增）
    ├── Cocos Creator .fire / .prefab 场景树
    ├── 节点组件关系
    ├── Prefab 实例化链
    └── 脚本与节点绑定
```

**效果：** 一个 GitNexus 实例，同时能回答：
- "这个 TypeScript 函数被哪些地方调用？"（代码层）
- "这个 Prefab 在哪些场景里被实例化？"（资产层）
- "修改 LoginPanel 脚本，会影响哪些场景节点？"（**跨层**）

---

## 二、架构方案

### 方案对比

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. 独立 SQLite 并行 | 保留 SQLite，共享 MCP Server | 改动小 | 两套存储，无法跨层查询 |
| B. Cocos 作为新语言插件 | .fire/.prefab 当"源文件"走 tree-sitter | 复用度高 | AST 解析不适用 JSON 场景文件 |
| **C. Cocos 专用 Pipeline Phase** | 新增 `game-asset-processor.ts`，扩展 KuzuDB Schema，节点直接写入图 | 统一存储、跨层查询、复用 MCP/搜索 | 需要扩展 Schema 和工具 |

**选择方案 C**，理由：
1. 统一进 KuzuDB → 可以用一条 Cypher 查询横跨代码节点和游戏节点
2. 复用 GitNexus 的 MCP 服务、资源系统、多 repo 架构
3. 保留 game-context-server 的解析逻辑，只替换存储层

---

## 三、Schema 扩展

### 新增节点类型

```typescript
// 追加到 NODE_TABLES
'Scene',       // 对应 .fire 场景文件
'GameNode',    // 场景/Prefab 内的节点
'GamePrefab',  // .prefab 文件
'GameComponent' // 挂载在节点上的组件
```

### 新增节点表 DDL

```sql
CREATE NODE TABLE Scene (
  id STRING,
  name STRING,
  filePath STRING,          -- db://Scene/Game.fire
  nodeCount INT64,
  componentCount INT64,
  PRIMARY KEY (id)
);

CREATE NODE TABLE GameNode (
  id STRING,
  name STRING,
  filePath STRING,          -- 所在 .fire/.prefab 文件路径
  active BOOLEAN,
  position STRING,          -- JSON: {x, y}
  size STRING,              -- JSON: {width, height}
  PRIMARY KEY (id)
);

CREATE NODE TABLE GamePrefab (
  id STRING,
  name STRING,
  filePath STRING,          -- db://prefab/lobby/login/LoginPanel.prefab
  uuid STRING,
  nodeCount INT64,
  PRIMARY KEY (id)
);

CREATE NODE TABLE GameComponent (
  id STRING,
  name STRING,              -- cc.Label / cc.Sprite / cc.Button / MyScript
  filePath STRING,          -- 所在文件
  isScript BOOLEAN,         -- true = 用户脚本, false = 引擎组件
  scriptPath STRING,        -- 脚本路径（isScript=true 时）
  PRIMARY KEY (id)
);
```

### 新增关系类型

```typescript
// 追加到 REL_TYPES
'CONTAINS_NODE',    // Scene/GamePrefab → GameNode（场景/预制体包含节点）
'HAS_COMPONENT',    // GameNode → GameComponent（节点挂载组件）
'INSTANTIATES',     // Scene/GameNode → GamePrefab（实例化预制体）
'SCRIPT_REFS',      // GameComponent → Function/Class（脚本引用代码符号）⭐ 跨层
```

> `SCRIPT_REFS` 是**跨层连接**的关键边：游戏节点 → 代码函数，实现"修改这个函数影响哪些场景"。

---

## 四、Pipeline 扩展

在现有 7 阶段后增加第 8 阶段：

```
Phase 1: extracting      (扫描文件路径)
Phase 2: structure       (文件夹结构)
Phase 3: parsing         (Tree-sitter 解析代码)
Phase 4: imports         (导入解析)
Phase 5: calls           (函数调用检测)
Phase 6: communities     (Leiden 社区聚类)
Phase 7: processes       (执行流程追踪)
Phase 8: game-assets     ← 新增：Cocos 资产扫描  ✨
```

### 新文件：`src/core/ingestion/game-asset-processor.ts`

核心逻辑（移植自 game-context-server）：

```typescript
export async function processGameAssets(
  graph: KnowledgeGraph,
  repoPath: string,
  onProgress: (p: PipelineProgress) => void
): Promise<void> {
  // 1. 检测是否有 Cocos Creator 项目（assets/ 目录 + .fire 文件）
  const isCocos = await detectCocosProject(repoPath);
  if (!isCocos) return; // 非 Cocos 项目跳过

  // 2. 扫描所有 .fire / .prefab 文件（移植 asset-scanner.ts）
  const files = await scanCocosFiles(repoPath);

  // 3. 解析每个文件，构建节点和边（移植 parser.ts + graph-builder.ts）
  for (const file of files) {
    const { nodes, edges } = await parseCocosFile(file);
    // 4. 写入 graph（已在内存，后续统一 flush 到 KuzuDB）
    addGameNodesToGraph(graph, nodes, edges);
  }

  // 5. 建立脚本→代码符号的跨层连接（SCRIPT_REFS）
  await resolveScriptRefs(graph);
}
```

### mtime 增量缓存

game-context-server 已实现 `file_cache` mtime 缓存机制，移植方式：

- GitNexus 在 KuzuDB 里增加一张 `FileCache` 表（id, path, mtime, contentHash）
- game-asset-processor 扫描前先查 FileCache，未变化的文件跳过
- 与代码文件共用同一套增量机制

---

## 五、MCP 工具扩展

在现有 7 个工具基础上增加 3 个游戏资产专属工具：

### 新增工具

| 工具名 | 功能 | 等价旧工具 |
|---|---|---|
| `game_context` | 查看场景/节点/Prefab 的完整信息（父子关系、组件列表、实例化来源）| `context` |
| `game_impact` | 某 Prefab 或脚本被哪些场景使用，影响半径 | `impact` |
| `game_query` | 按名称/类型/场景搜索游戏资产 | `query` |

### 跨层查询示例（`cypher` 工具直接支持）

```cypher
-- 修改 LoginController.ts，哪些场景节点会受影响？
MATCH (f:File {name: "LoginController.ts"})<-[:CodeRelation {type: 'SCRIPT_REFS'}]-(gc:GameComponent)
      <-[:CodeRelation {type: 'HAS_COMPONENT'}]-(gn:GameNode)
      <-[:CodeRelation {type: 'CONTAINS_NODE'}]-(s:Scene)
RETURN s.name, gn.name, gc.name
```

---

## 六、新增 MCP Resources

```
gitnexus://repo/{name}/game-assets     ← 游戏资产概览（场景数/节点数/Prefab 数）
gitnexus://repo/{name}/scenes          ← 所有场景列表
gitnexus://repo/{name}/prefabs         ← 所有 Prefab 列表
```

---

## 七、文件变更清单

```
gitnexus/
├── src/
│   ├── core/
│   │   ├── ingestion/
│   │   │   ├── pipeline.ts                    ← 追加 Phase 8 调用
│   │   │   └── game-asset-processor.ts        ← 新建（移植解析逻辑）
│   │   ├── kuzu/
│   │   │   └── schema.ts                      ← 追加 4 个节点表 + 4 个关系类型
│   │   └── plugins/
│   │       └── cocos/
│   │           ├── cocos-detector.ts          ← 检测是否 Cocos 项目
│   │           ├── cocos-file-parser.ts       ← .fire/.prefab JSON 解析
│   │           ├── cocos-graph-builder.ts     ← 构建图节点/边
│   │           └── cocos-script-resolver.ts   ← 脚本→代码跨层连接
│   └── mcp/
│       ├── tools.ts                           ← 追加 game_context / game_impact / game_query
│       └── resources.ts                       ← 追加 game-assets / scenes / prefabs
└── skills/
    └── gitnexus-game-assets.md                ← 新增使用指南
```

**不动的文件：**
- KuzuDB adapter（只加表，不改查询逻辑）
- Community / Process processor（Leiden 对游戏节点同样适用）
- MCP Server 框架（直接注册新工具）
- 多 repo 注册表架构

---

## 八、移植策略

game-context-server 代码按功能拆分映射：

| 原文件 | 移植到 | 改动 |
|---|---|---|
| `scanner/asset-scanner.ts` | `plugins/cocos/cocos-file-parser.ts` | 去掉 SQLite 写入，改为返回节点/边数组 |
| `db/sqlite.ts` | 删除 | 存储改用 KuzuDB |
| `analysis/community.ts` | 删除 | 复用 GitNexus Leiden |
| `analysis/loading-flow.ts` | `plugins/cocos/cocos-script-resolver.ts` | 适配图接口 |
| `mcp/tools.ts` | `src/mcp/tools.ts`（追加） | 改用 KuzuDB 查询 |

---

## 九、实施顺序

```
Step 1: 扩展 schema.ts（加节点表 + 关系类型）
Step 2: 实现 cocos-file-parser.ts（移植核心解析逻辑）
Step 3: 实现 cocos-graph-builder.ts（写入 graph 接口）
Step 4: 实现 cocos-script-resolver.ts（跨层 SCRIPT_REFS）
Step 5: 实现 game-asset-processor.ts（串联上面模块）
Step 6: 修改 pipeline.ts（追加 Phase 8）
Step 7: 添加 MCP 工具（game_context / game_impact / game_query）
Step 8: 添加 MCP 资源（game-assets / scenes / prefabs）
Step 9: 测试（用 AsiaPoker 项目验证）
```

---

## 十、价值总结

| 能力 | game-context-server | GitNexus（集成后）|
|---|---|---|
| 代码调用链 | ❌ | ✅ |
| 游戏资产图 | ✅ | ✅ |
| **跨层查询**（脚本影响哪些场景）| ❌ | ✅ ⭐ |
| 多 repo 管理 | ❌ | ✅ |
| 语义搜索 | ❌ | ✅ |
| 增量扫描 | ✅ | ✅（移植）|
| 单一 MCP 入口 | ❌（两个服务）| ✅ |
