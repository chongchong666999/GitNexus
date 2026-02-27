/**
 * Cocos Script Resolver
 *
 * Creates SCRIPT_REFS cross-layer edges that connect GameComponent nodes
 * (Cocos scene script components) to Function/Class/Method nodes (code symbols).
 *
 * This is the key cross-layer bridge: it allows queries like
 * "which scenes are affected if I change LoginController.ts?"
 *
 * Resolution strategy:
 * 1. Match by script file name: component type "LoginController" → find Class/Function named "LoginController"
 * 2. Match by script path in meta files: component scriptUuid → .meta file → .ts path → graph node
 */

import { KnowledgeGraph } from '../../graph/types.js';

/**
 * Resolve script component → code symbol connections and add SCRIPT_REFS edges.
 *
 * @param graph - The knowledge graph (already has code symbols and game asset nodes)
 * @param metaUuidMap - Optional map of UUID → relative file path (from .meta files)
 */
export function resolveScriptRefs(
  graph: KnowledgeGraph,
  metaUuidMap?: Map<string, string>,
): void {
  // Build lookup: class/function name → node ID (for code symbols)
  const codeSymbolByName = new Map<string, string[]>();
  graph.forEachNode(node => {
    if (node.label === 'Class' || node.label === 'Function' || node.label === 'Method') {
      const name = node.properties.name;
      if (!codeSymbolByName.has(name)) {
        codeSymbolByName.set(name, []);
      }
      codeSymbolByName.get(name)!.push(node.id);
    }
  });

  // Build lookup: script file path (basename without ext) → class/function node IDs
  const codeSymbolByFile = new Map<string, string[]>();
  graph.forEachNode(node => {
    if (node.label === 'File') {
      const fp = node.properties.filePath;
      if (fp && (fp.endsWith('.ts') || fp.endsWith('.js'))) {
        const baseName = fp.split('/').pop()?.replace(/\.[tj]s$/, '') || '';
        if (baseName) {
          const existing = codeSymbolByFile.get(baseName) || [];
          existing.push(node.id);
          codeSymbolByFile.set(baseName, existing);
        }
      }
    }
  });

  // Resolve each GameComponent with isScript=true
  const addedRels = new Set<string>();

  graph.forEachNode(node => {
    if (node.label !== 'GameComponent') return;
    const props = node.properties as any;
    if (!props.isScript) return;

    const componentTypeName = node.properties.name;
    const scriptUuid = props.scriptUuid as string;

    let targetIds: string[] = [];

    // Strategy 1: match by component type name (e.g. "LoginController")
    const byName = codeSymbolByName.get(componentTypeName);
    if (byName && byName.length > 0) {
      targetIds = byName;
    }

    // Strategy 2: match by UUID → file path (if meta map provided)
    if (targetIds.length === 0 && scriptUuid && metaUuidMap) {
      const scriptPath = metaUuidMap.get(scriptUuid);
      if (scriptPath) {
        const baseName = scriptPath.split('/').pop()?.replace(/\.[tj]s$/, '') || '';
        const byFile = codeSymbolByFile.get(baseName);
        if (byFile && byFile.length > 0) {
          targetIds = byFile;
        }
        // Also try by class name matching file name
        const byClassName = codeSymbolByName.get(baseName);
        if (byClassName && byClassName.length > 0) {
          targetIds = [...new Set([...targetIds, ...byClassName])];
        }
      }
    }

    // Strategy 3: match by filename pattern (component name as filename)
    if (targetIds.length === 0) {
      const byFile = codeSymbolByFile.get(componentTypeName);
      if (byFile && byFile.length > 0) {
        // Use the File nodes as targets (coarser, but still cross-layer)
        targetIds = byFile;
      }
    }

    // Add SCRIPT_REFS edges
    for (const targetId of targetIds) {
      const relId = `cocos:scriptref:${node.id}:${targetId}`;
      if (!addedRels.has(relId)) {
        addedRels.add(relId);
        graph.addRelationship({
          id: relId,
          type: 'SCRIPT_REFS',
          sourceId: node.id,
          targetId,
          confidence: targetIds.length === 1 ? 0.9 : 0.7,
          reason: 'cocos-script-name-match',
        });
      }
    }

    // Back-fill scriptPath on the GameComponent node using the first resolved target
    if (targetIds.length > 0 && !(node.properties as any).scriptPath) {
      const firstTarget = graph.getNode(targetIds[0]);
      if (firstTarget && firstTarget.properties.filePath) {
        (node.properties as any).scriptPath = firstTarget.properties.filePath;
      }
    }
  });
}

/**
 * Parse .meta files in a scanned file list to build a UUID → filePath map.
 * Used by resolveScriptRefs for more accurate UUID-based matching.
 */
export async function buildMetaUuidMap(
  scannedPaths: string[],
  readFile: (path: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const uuidMap = new Map<string, string>();

  const metaPaths = scannedPaths.filter(p => p.endsWith('.meta'));

  await Promise.all(
    metaPaths.map(async (metaPath) => {
      const content = await readFile(metaPath);
      if (!content) return;
      try {
        const meta = JSON.parse(content);
        if (meta.uuid && typeof meta.uuid === 'string') {
          // The source file path = meta path without .meta extension
          const sourcePath = metaPath.slice(0, -5);
          uuidMap.set(meta.uuid, sourcePath);
        }
      } catch { /* ignore parse errors */ }
    })
  );

  return uuidMap;
}
