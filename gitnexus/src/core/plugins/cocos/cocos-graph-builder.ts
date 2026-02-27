/**
 * Cocos Graph Builder
 *
 * Converts ParsedCocosFile structures into GraphNode and GraphRelationship objects
 * compatible with GitNexus's KnowledgeGraph interface.
 */

import { GraphNode, GraphRelationship, KnowledgeGraph } from '../../graph/types.js';
import { ParsedCocosFile } from './cocos-file-parser.js';

/**
 * Add all nodes and relationships from a parsed Cocos file into the knowledge graph.
 */
export function addCocosFileToGraph(
  graph: KnowledgeGraph,
  parsed: ParsedCocosFile,
): void {
  // ── 1. Add file-level node (Scene or GamePrefab) ──────────────────────────
  if (parsed.assetType === 'scene-file') {
    graph.addNode({
      id: parsed.fileNodeId,
      label: 'Scene',
      properties: {
        name: parsed.name,
        filePath: parsed.filePath,
        nodeCount: parsed.nodes.length,
        componentCount: parsed.components.length,
      } as any,
    });
  } else {
    graph.addNode({
      id: parsed.fileNodeId,
      label: 'GamePrefab',
      properties: {
        name: parsed.name,
        filePath: parsed.filePath,
        uuid: '',
        nodeCount: parsed.nodes.length,
      } as any,
    });
  }

  // ── 2. Add GameNode entries ───────────────────────────────────────────────
  for (const node of parsed.nodes) {
    graph.addNode({
      id: node.id,
      label: 'GameNode',
      properties: {
        name: node.name,
        filePath: node.filePath,
        active: node.active,
        position: node.position,
        size: node.size,
      } as any,
    });
  }

  // ── 3. Add GameComponent entries ──────────────────────────────────────────
  for (const comp of parsed.components) {
    graph.addNode({
      id: comp.id,
      label: 'GameComponent',
      properties: {
        name: comp.name,
        filePath: comp.filePath,
        isScript: comp.isScript,
        scriptPath: '',    // resolved later by cocos-script-resolver
        scriptUuid: comp.scriptUuid, // keep for resolver
      } as any,
    });
  }

  // ── 4. Build relationships ────────────────────────────────────────────────

  // File → root GameNode (CONTAINS_NODE)
  const rootId = parsed.rootNodeIndex !== undefined
    ? parsed.indexMap.get(parsed.rootNodeIndex)
    : undefined;
  if (rootId && rootId !== parsed.fileNodeId) {
    graph.addRelationship({
      id: `cocos:rel:${parsed.fileNodeId}:root:${rootId}`,
      type: 'CONTAINS_NODE',
      sourceId: parsed.fileNodeId,
      targetId: rootId,
      confidence: 1.0,
      reason: 'cocos-asset-root',
    });
  }

  // Node → child nodes (CONTAINS_NODE)
  for (const node of parsed.nodes) {
    for (const childIdx of node.childIndices) {
      const childId = parsed.indexMap.get(childIdx);
      if (childId && childId !== node.id) {
        graph.addRelationship({
          id: `cocos:rel:${node.id}:child:${childId}`,
          type: 'CONTAINS_NODE',
          sourceId: node.id,
          targetId: childId,
          confidence: 1.0,
          reason: 'cocos-node-hierarchy',
        });
      }
    }

    // Node → components (HAS_COMPONENT)
    for (const compIdx of node.componentIndices) {
      const compId = parsed.indexMap.get(compIdx);
      if (compId) {
        graph.addRelationship({
          id: `cocos:rel:${node.id}:comp:${compId}`,
          type: 'HAS_COMPONENT',
          sourceId: node.id,
          targetId: compId,
          confidence: 1.0,
          reason: 'cocos-component-attachment',
        });
      }
    }
  }
}

/**
 * Build a lookup map from script UUID → GraphNode ID for all GameComponent nodes
 * with isScript=true. Used by cocos-script-resolver.
 */
export function buildScriptUuidIndex(graph: KnowledgeGraph): Map<string, string> {
  const index = new Map<string, string>();
  graph.forEachNode(node => {
    if (node.label === 'GameComponent') {
      const uuid = (node.properties as any).scriptUuid as string;
      if (uuid) {
        index.set(uuid, node.id);
      }
    }
  });
  return index;
}
