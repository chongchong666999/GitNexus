import { KnowledgeGraph } from '../../../graph/types.js';
import { ParsedCocosFile } from '../cocos-file-parser.js';
import { resolveMetaPathByUuidLike } from './uuid-codec.js';

export interface CocosUuidReference {
  entryIndex: number;
  fieldPath: string;
  uuidLike: string;
}

function collectUuidRefs(
  value: any,
  entryIndex: number,
  path: string,
  out: CocosUuidReference[],
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectUuidRefs(value[i], entryIndex, `${path}[${i}]`, out);
    }
    return;
  }

  if (!value || typeof value !== 'object') return;

  if (typeof value.__uuid__ === 'string' && value.__uuid__) {
    out.push({
      entryIndex,
      fieldPath: `${path}.__uuid__`,
      uuidLike: value.__uuid__,
    });
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === '__uuid__') continue;
    collectUuidRefs(child, entryIndex, `${path}.${key}`, out);
  }
}

export function extractUuidReferencesFromCocosContent(content: string): CocosUuidReference[] {
  let entries: any;
  try {
    entries = JSON.parse(content);
  } catch {
    return [];
  }

  if (!Array.isArray(entries)) return [];

  const refs: CocosUuidReference[] = [];
  for (let i = 0; i < entries.length; i++) {
    collectUuidRefs(entries[i], i, `entry[${i}]`, refs);
  }
  return refs;
}

/**
 * Build INSTANTIATES edges from prefab UUID references found in Cocos serialized data.
 *
 * Source side:
 * - Prefer source GameNode for the entry (or parent node when entry is GameComponent)
 * - Fallback to Scene node for .fire
 * - Fallback to root GameNode for .prefab
 *
 * Target side:
 * - UUID resolved through meta map to a .prefab file => GamePrefab:{path}
 */
export function enhancePrefabInstantiationRelations(
  graph: KnowledgeGraph,
  parsed: ParsedCocosFile,
  content: string,
  metaUuidMap: Map<string, string>,
): { edgesAdded: number; refsMatched: number } {
  const startRelCount = graph.relationshipCount;

  const refs = extractUuidReferencesFromCocosContent(content);
  if (refs.length === 0) {
    return { edgesAdded: 0, refsMatched: 0 };
  }

  const componentParentNodeByEntry = new Map<number, string>();
  for (const node of parsed.nodes) {
    for (const compEntryIndex of node.componentIndices) {
      componentParentNodeByEntry.set(compEntryIndex, node.id);
    }
  }

  const rootNodeId = parsed.rootNodeIndex !== undefined
    ? parsed.indexMap.get(parsed.rootNodeIndex)
    : undefined;

  const edgeKeySet = new Set<string>();
  let refsMatched = 0;

  for (const ref of refs) {
    const targetPath = resolveMetaPathByUuidLike(metaUuidMap, ref.uuidLike);
    if (!targetPath || !targetPath.endsWith('.prefab')) continue;

    const targetId = `GamePrefab:${targetPath}`;

    const directSourceId = parsed.indexMap.get(ref.entryIndex);
    let sourceId = directSourceId;

    // Relation schema allows GameNode/Scene -> GamePrefab (not GameComponent -> GamePrefab).
    if (sourceId?.startsWith('GameComponent:')) {
      sourceId = componentParentNodeByEntry.get(ref.entryIndex) || sourceId;
    }

    if (!sourceId || sourceId.startsWith('GameComponent:')) {
      if (parsed.assetType === 'scene-file') {
        sourceId = parsed.fileNodeId; // Scene
      } else {
        sourceId = rootNodeId; // GameNode root in prefab file
      }
    }

    if (!sourceId) continue;

    const edgeKey = `${sourceId}|${targetId}`;
    if (edgeKeySet.has(edgeKey)) continue;
    edgeKeySet.add(edgeKey);

    const isPrefabField = ref.fieldPath.toLowerCase().includes('prefab');

    graph.addRelationship({
      id: `cocos:phase1:instantiate:${parsed.fileNodeId}:${sourceId}:${targetId}`,
      type: 'INSTANTIATES',
      sourceId,
      targetId,
      confidence: isPrefabField ? 0.95 : 0.8,
      reason: isPrefabField ? 'cocos-prefab-field-ref' : 'cocos-prefab-uuid-ref',
    });

    refsMatched++;
  }

  return {
    edgesAdded: graph.relationshipCount - startRelCount,
    refsMatched,
  };
}
