/**
 * Cocos Creator File Parser
 *
 * Parses .fire (scene) and .prefab files into structured raw data.
 * These files are JSON arrays where objects reference each other via {__id__: N} indices.
 *
 * Supported Cocos Creator versions: 2.x
 */

import path from 'path';

// ─── Raw Cocos Entry Types ────────────────────────────────────────────────────

export interface CocosEntry {
  __type__: string;
  [key: string]: any;
}

export interface CocosRef {
  __id__: number;
}

export interface CocosVec2 {
  x: number;
  y: number;
}

export interface CocosSize {
  width: number;
  height: number;
}

// ─── Parsed Output Types ─────────────────────────────────────────────────────

export type CocosNodeType = 'scene' | 'node';
export type CocosAssetType = 'scene-file' | 'prefab-file';

export interface ParsedCocosNode {
  /** Unique ID: cocos:node:{filePath}:{entryIndex} */
  id: string;
  /** Display name */
  name: string;
  /** Source file (relative path) */
  filePath: string;
  /** Whether this is the scene root or a regular node */
  nodeType: CocosNodeType;
  /** Whether node is active in scene */
  active: boolean;
  /** Serialized position JSON */
  position: string;
  /** Serialized size JSON */
  size: string;
  /** Entry index in the .fire/.prefab array */
  entryIndex: number;
  /** Indices of child cc.Node entries */
  childIndices: number[];
  /** Indices of component entries */
  componentIndices: number[];
  /** Index of prefab root (if this node is a prefab instance) */
  prefabRootIndex?: number;
}

export interface ParsedCocosComponent {
  /** Unique ID: cocos:comp:{filePath}:{entryIndex} */
  id: string;
  /** Component type string (e.g. "cc.Label", "MyLoginController") */
  name: string;
  /** Source file (relative path) */
  filePath: string;
  /** Whether this is a user script (not an engine component) */
  isScript: boolean;
  /** Script UUID (for isScript=true), resolved to path separately */
  scriptUuid: string;
  /** Entry index */
  entryIndex: number;
}

export interface ParsedCocosFile {
  /** Stable ID for the file-level node */
  fileNodeId: string;
  /** Index of the root GameNode for this file (for prefabs: cc.Prefab.data.__id__; for scenes: cc.Scene index) */
  rootNodeIndex?: number;
  /** Display name (filename without extension) */
  name: string;
  /** Relative file path */
  filePath: string;
  /** 'scene-file' for .fire, 'prefab-file' for .prefab */
  assetType: CocosAssetType;
  /** All cc.Node / cc.Scene entries */
  nodes: ParsedCocosNode[];
  /** All component entries */
  components: ParsedCocosComponent[];
  /** Index → nodeId / compId mapping (for relation building) */
  indexMap: Map<number, string>;
}

// ─── Engine component type detection ────────────────────────────────────────

const ENGINE_COMPONENT_PREFIXES = [
  'cc.Label', 'cc.Sprite', 'cc.Button', 'cc.Layout', 'cc.ScrollView',
  'cc.EditBox', 'cc.RichText', 'cc.ProgressBar', 'cc.Toggle', 'cc.PageView',
  'cc.Widget', 'cc.Canvas', 'cc.Camera', 'cc.AudioSource', 'cc.Animation',
  'cc.ParticleSystem', 'cc.Mask', 'cc.MotionStreak', 'cc.TiledMap',
  'cc.Node', 'cc.Scene', 'cc.Component', 'cc.UITransform',
];

function isEngineComponent(type: string): boolean {
  return ENGINE_COMPONENT_PREFIXES.some(prefix => type === prefix || type.startsWith('cc.'));
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a .fire or .prefab file content into structured data.
 * Returns null if the content is invalid or not a Cocos Creator asset.
 */
export function parseCocosFileContent(
  relativePath: string,
  content: string,
): ParsedCocosFile | null {
  let entries: CocosEntry[];
  try {
    entries = JSON.parse(content);
  } catch {
    return null;
  }

  if (!Array.isArray(entries) || entries.length === 0) return null;

  const isScene = relativePath.endsWith('.fire');
  const isPrefab = relativePath.endsWith('.prefab');
  if (!isScene && !isPrefab) return null;

  // Verify it's actually a Cocos Creator file
  const rootEntry = entries[0];
  if (!rootEntry || typeof rootEntry.__type__ !== 'string') return null;
  if (!rootEntry.__type__.startsWith('cc.')) return null;

  const assetType: CocosAssetType = isScene ? 'scene-file' : 'prefab-file';
  const baseName = path.basename(relativePath, isScene ? '.fire' : '.prefab');
  const fileNodeId = isScene
    ? `Scene:${relativePath}`
    : `GamePrefab:${relativePath}`;

  const nodes: ParsedCocosNode[] = [];
  const components: ParsedCocosComponent[] = [];
  const indexMap = new Map<number, string>();

  // Single pass: classify each entry
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry.__type__ !== 'string') continue;

    const type = entry.__type__;

    if (type === 'cc.Node' || type === 'cc.Scene') {
      const nodeId = `GameNode:${relativePath}:${i}`;
      indexMap.set(i, nodeId);

      const pos = entry._position || entry.position || { x: 0, y: 0 };
      const sz = entry._contentSize || entry.contentSize || { width: 0, height: 0 };

      const childIndices: number[] = [];
      if (Array.isArray(entry._children)) {
        for (const ref of entry._children) {
          if (ref && typeof ref.__id__ === 'number') {
            childIndices.push(ref.__id__);
          }
        }
      }

      const componentIndices: number[] = [];
      if (Array.isArray(entry._components)) {
        for (const ref of entry._components) {
          if (ref && typeof ref.__id__ === 'number') {
            componentIndices.push(ref.__id__);
          }
        }
      }

      // Detect prefab instance root
      let prefabRootIndex: number | undefined;
      if (entry._prefab && typeof entry._prefab.__id__ === 'number') {
        prefabRootIndex = entry._prefab.__id__;
      }

      nodes.push({
        id: nodeId,
        name: entry._name || entry.name || 'Unnamed',
        filePath: relativePath,
        nodeType: type === 'cc.Scene' ? 'scene' : 'node',
        active: entry._active !== false,
        position: JSON.stringify({ x: pos.x ?? 0, y: pos.y ?? 0 }),
        size: JSON.stringify({ width: sz.width ?? 0, height: sz.height ?? 0 }),
        entryIndex: i,
        childIndices,
        componentIndices,
        prefabRootIndex,
      });
    } else if (isEngineComponent(type) || (!type.startsWith('cc.') && type.includes('.'))) {
      // Engine component or user script component
      const compId = `GameComponent:${relativePath}:${i}`;
      indexMap.set(i, compId);

      const isScript = !isEngineComponent(type);
      let scriptUuid = '';
      if (isScript) {
        // User scripts may store their UUID in _scriptAsset or similar
        const scriptRef = entry._scriptAsset || entry.scriptAsset;
        if (scriptRef && typeof scriptRef.__uuid__ === 'string') {
          scriptUuid = scriptRef.__uuid__;
        }
      }

      components.push({
        id: compId,
        name: type,
        filePath: relativePath,
        isScript,
        scriptUuid,
        entryIndex: i,
      });
    } else if (!isEngineComponent(type) && !type.includes('.')) {
      // Short-name user script component (e.g. "LoginController" without namespace)
      const compId = `GameComponent:${relativePath}:${i}`;
      indexMap.set(i, compId);

      const scriptRef = entry._scriptAsset || entry.scriptAsset;
      let scriptUuid = '';
      if (scriptRef && typeof scriptRef.__uuid__ === 'string') {
        scriptUuid = scriptRef.__uuid__;
      }

      components.push({
        id: compId,
        name: type,
        filePath: relativePath,
        isScript: true,
        scriptUuid,
        entryIndex: i,
      });
    }
  }

  // Add fileNodeId to indexMap for the file-level asset (sentinel -1)
  indexMap.set(-1, fileNodeId);
  // Also add a stable label-prefixed version so getNodeLabel can resolve it
  // (indexMap is internal — the IDs already have Label: prefix)

  // Determine root node index
  let rootNodeIndex: number | undefined;
  if (isScene) {
    // For .fire: find the cc.Scene entry
    const sceneIdx = entries.findIndex(e => e?.__type__ === 'cc.Scene');
    if (sceneIdx >= 0) rootNodeIndex = sceneIdx;
  } else {
    // For .prefab: cc.Prefab entry (index 0) has data: { __id__: N }
    const prefabEntry = entries.find(e => e?.__type__ === 'cc.Prefab');
    if (prefabEntry?.data && typeof prefabEntry.data.__id__ === 'number') {
      rootNodeIndex = prefabEntry.data.__id__;
    } else {
      // Fallback: find the cc.Node with no parent (index 1 in most prefabs)
      const childSet = new Set<number>();
      for (const node of nodes) {
        for (const ci of node.childIndices) childSet.add(ci);
      }
      const rootNode = nodes.find(n => !childSet.has(n.entryIndex));
      if (rootNode) rootNodeIndex = rootNode.entryIndex;
    }
  }

  return {
    fileNodeId,
    name: baseName,
    filePath: relativePath,
    assetType,
    nodes,
    components,
    indexMap,
    rootNodeIndex,
  };
}
