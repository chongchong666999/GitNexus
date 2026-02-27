/**
 * MCP Tool Definitions
 * 
 * Defines the tools that GitNexus exposes to external AI agents.
 * All tools support an optional `repo` parameter for multi-repo setups.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      default?: any;
      items?: { type: string };
      enum?: string[];
    }>;
    required: string[];
  };
}

export const GITNEXUS_TOOLS: ToolDefinition[] = [
  {
    name: 'list_repos',
    description: `List all indexed repositories available to GitNexus.

Returns each repo's name, path, indexed date, last commit, and stats.

WHEN TO USE: First step when multiple repos are indexed, or to discover available repos.
AFTER THIS: READ gitnexus://repo/{name}/context for the repo you want to work with.

When multiple repos are indexed, you MUST specify the "repo" parameter
on other tools (query, context, impact, etc.) to target the correct one.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'query',
    description: `Query the code knowledge graph for execution flows related to a concept.
Returns processes (call chains) ranked by relevance, each with its symbols and file locations.

WHEN TO USE: Understanding how code works together. Use this when you need execution flows and relationships, not just file matches. Complements grep/IDE search.
AFTER THIS: Use context() on a specific symbol for 360-degree view (callers, callees, categorized refs).

Returns results grouped by process (execution flow):
- processes: ranked execution flows with relevance priority
- process_symbols: all symbols in those flows with file locations and module (functional area)
- definitions: standalone types/interfaces not in any process

Hybrid ranking: BM25 keyword + semantic vector search, ranked by Reciprocal Rank Fusion.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query' },
        task_context: { type: 'string', description: 'What you are working on (e.g., "adding OAuth support"). Helps ranking.' },
        goal: { type: 'string', description: 'What you want to find (e.g., "existing auth validation logic"). Helps ranking.' },
        limit: { type: 'number', description: 'Max processes to return (default: 5)', default: 5 },
        max_symbols: { type: 'number', description: 'Max symbols per process (default: 10)', default: 10 },
        include_content: { type: 'boolean', description: 'Include full symbol source code (default: false)', default: false },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cypher',
    description: `Execute Cypher query against the code knowledge graph.

WHEN TO USE: Complex structural queries that search/explore can't answer. READ gitnexus://repo/{name}/schema first for the full schema.
AFTER THIS: Use context() on result symbols for deeper context.

SCHEMA:
- Nodes: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process
- Multi-language nodes (use backticks): \`Struct\`, \`Enum\`, \`Trait\`, \`Impl\`, etc.
- All edges via single CodeRelation table with 'type' property
- Edge types: CONTAINS, DEFINES, CALLS, IMPORTS, EXTENDS, IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS
- Edge properties: type (STRING), confidence (DOUBLE), reason (STRING), step (INT32)

EXAMPLES:
• Find callers of a function:
  MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: "validateUser"}) RETURN a.name, a.filePath

• Find community members:
  MATCH (f)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community) WHERE c.heuristicLabel = "Auth" RETURN f.name

• Trace a process:
  MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE p.heuristicLabel = "UserLogin" RETURN s.name, r.step ORDER BY r.step

OUTPUT: Returns { markdown, row_count } — results formatted as a Markdown table for easy reading.

TIPS:
- All relationships use single CodeRelation table — filter with {type: 'CALLS'} etc.
- Community = auto-detected functional area (Leiden algorithm)
- Process = execution flow trace from entry point to terminal
- Use heuristicLabel (not label) for human-readable community/process names`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cypher query to execute' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'context',
    description: `360-degree view of a single code symbol.
Shows categorized incoming/outgoing references (calls, imports, extends, implements), process participation, and file location.

WHEN TO USE: After query() to understand a specific symbol in depth. When you need to know all callers, callees, and what execution flows a symbol participates in.
AFTER THIS: Use impact() if planning changes, or READ gitnexus://repo/{name}/process/{processName} for full execution trace.

Handles disambiguation: if multiple symbols share the same name, returns candidates for you to pick from. Use uid param for zero-ambiguity lookup from prior results.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (e.g., "validateUser", "AuthService")' },
        uid: { type: 'string', description: 'Direct symbol UID from prior tool results (zero-ambiguity lookup)' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        include_content: { type: 'boolean', description: 'Include full symbol source code (default: false)', default: false },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'detect_changes',
    description: `Analyze uncommitted git changes and find affected execution flows.
Maps git diff hunks to indexed symbols, then traces which processes are impacted.

WHEN TO USE: Before committing — to understand what your changes affect. Pre-commit review, PR preparation.
AFTER THIS: Review affected processes. Use context() on high-risk symbols. READ gitnexus://repo/{name}/process/{name} for full traces.

Returns: changed symbols, affected processes, and a risk summary.`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'What to analyze: "unstaged" (default), "staged", "all", or "compare"', enum: ['unstaged', 'staged', 'all', 'compare'], default: 'unstaged' },
        base_ref: { type: 'string', description: 'Branch/commit for "compare" scope (e.g., "main")' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'rename',
    description: `Multi-file coordinated rename using the knowledge graph + text search.
Finds all references via graph (high confidence) and regex text search (lower confidence). Preview by default.

WHEN TO USE: Renaming a function, class, method, or variable across the codebase. Safer than find-and-replace.
AFTER THIS: Run detect_changes() to verify no unexpected side effects.

Each edit is tagged with confidence:
- "graph": found via knowledge graph relationships (high confidence, safe to accept)
- "text_search": found via regex text search (lower confidence, review carefully)`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name to rename' },
        symbol_uid: { type: 'string', description: 'Direct symbol UID from prior tool results (zero-ambiguity)' },
        new_name: { type: 'string', description: 'The new name for the symbol' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        dry_run: { type: 'boolean', description: 'Preview edits without modifying files (default: true)', default: true },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'impact',
    description: `Analyze the blast radius of changing a code symbol.
Returns affected symbols grouped by depth, plus risk assessment, affected execution flows, and affected modules.

WHEN TO USE: Before making code changes — especially refactoring, renaming, or modifying shared code. Shows what would break.
AFTER THIS: Review d=1 items (WILL BREAK). Use context() on high-risk symbols.

Output includes:
- risk: LOW / MEDIUM / HIGH / CRITICAL
- summary: direct callers, processes affected, modules affected
- affected_processes: which execution flows break and at which step
- affected_modules: which functional areas are hit (direct vs indirect)
- byDepth: all affected symbols grouped by traversal depth

Depth groups:
- d=1: WILL BREAK (direct callers/importers)
- d=2: LIKELY AFFECTED (indirect)
- d=3: MAY NEED TESTING (transitive)

EdgeType: CALLS, IMPORTS, EXTENDS, IMPLEMENTS
Confidence: 1.0 = certain, <0.8 = fuzzy match`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of function, class, or file to analyze' },
        direction: { type: 'string', description: 'upstream (what depends on this) or downstream (what this depends on)' },
        maxDepth: { type: 'number', description: 'Max relationship depth (default: 3)', default: 3 },
        relationTypes: { type: 'array', items: { type: 'string' }, description: 'Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS (default: usage-based)' },
        includeTests: { type: 'boolean', description: 'Include test files (default: false)' },
        minConfidence: { type: 'number', description: 'Minimum confidence 0-1 (default: 0.7)' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['target', 'direction'],
    },
  },

  // ── Cocos Creator Game Asset Tools ──────────────────────────────────────────

  {
    name: 'game_query',
    description: `Search Cocos Creator game assets — scenes, prefabs, nodes, and components.

WHEN TO USE: Finding game assets in a Cocos Creator project. Use when you want to:
- Find which scenes use a specific prefab
- Find all nodes named "loginPanel" across scenes
- List all script components of a given type
- Discover what's in a specific scene

AFTER THIS: Use game_context() on a specific asset for full hierarchy view, or game_impact() to check what uses it.

Returns: matching assets grouped by type (Scene, GamePrefab, GameNode, GameComponent) with file locations.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or keyword to search for (node name, scene name, component type, prefab name)' },
        type: {
          type: 'string',
          description: 'Filter by asset type: "scene", "prefab", "node", "component" (default: all)',
          enum: ['scene', 'prefab', 'node', 'component'],
        },
        limit: { type: 'number', description: 'Max results to return (default: 20)', default: 20 },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['query'],
    },
  },

  {
    name: 'game_context',
    description: `Get complete context for a Cocos Creator scene or prefab — full node hierarchy, components, script attachments, and cross-layer code connections.

WHEN TO USE: Understanding a scene's structure or a prefab's contents. Use when you need:
- Complete node tree of a scene
- All script components attached to nodes in a scene/prefab
- Which TypeScript classes are used in this scene (cross-layer)
- Instantiation sources (where this prefab is used)

AFTER THIS: Use game_impact() to check blast radius, or use context() on linked code symbols.

Returns: hierarchy tree, component list, script refs (cross-layer links to code).`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Scene or prefab name (e.g. "LoginScene", "LoginPanel")' },
        includeInactive: { type: 'boolean', description: 'Include inactive nodes (default: false)', default: false },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['name'],
    },
  },

  {
    name: 'game_impact',
    description: `Analyze blast radius for a Cocos Creator asset — what scenes/nodes would be affected if this prefab or script changes.

WHEN TO USE: Before modifying a prefab or a script that's used in scenes. Answers:
- "If I change LoginPanel.prefab, which scenes are affected?"
- "If I refactor LoginController.ts, which scene nodes use it?"
- "How many scenes depend on this shared prefab?"

Performs cross-layer analysis: script changes → affected game nodes → affected scenes.

AFTER THIS: Review affected scenes. Use context() on the script symbol for code-level blast radius.

Returns: affected scenes, prefabs, and node paths grouped by distance.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Prefab name, scene name, or script/class name to analyze' },
        direction: {
          type: 'string',
          description: '"upstream" = what uses this asset (default), "downstream" = what this asset depends on',
          enum: ['upstream', 'downstream'],
          default: 'upstream',
        },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['target'],
    },
  },
];
