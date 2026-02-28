import { KnowledgeGraph } from '../../../graph/types.js';
import { resolveMetaPathByUuidLike } from './uuid-codec.js';

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function normalizePathKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Phase 1 script binding enhancer.
 *
 * Resolves GameComponent(isScript=true) to code symbols with stronger UUID-aware logic,
 * including Cocos compressed UUID component types.
 */
export function enhanceScriptRelations(
  graph: KnowledgeGraph,
  metaUuidMap: Map<string, string>,
): { edgesAdded: number; componentsResolved: number } {
  const startRelCount = graph.relationshipCount;

  const codeSymbolByName = new Map<string, string[]>();
  const codeFileByBaseName = new Map<string, string[]>();
  const codeFileByPath = new Map<string, string>();

  graph.forEachNode(node => {
    if (node.label === 'Class' || node.label === 'Function' || node.label === 'Method') {
      const name = String(node.properties.name || '');
      if (!name) return;
      const existing = codeSymbolByName.get(name) || [];
      existing.push(node.id);
      codeSymbolByName.set(name, existing);
    }

    if (node.label === 'File') {
      const fpRaw = String(node.properties.filePath || '');
      if (!fpRaw) return;
      const fp = normalizePathKey(fpRaw);
      if (!fp.endsWith('.ts') && !fp.endsWith('.js')) return;

      codeFileByPath.set(fp, node.id);

      const base = fp.split('/').pop()?.replace(/\.[tj]s$/, '') || '';
      if (!base) return;
      const existing = codeFileByBaseName.get(base) || [];
      existing.push(node.id);
      codeFileByBaseName.set(base, existing);
    }
  });

  const addedEdgeIds = new Set<string>();
  let componentsResolved = 0;

  graph.forEachNode(node => {
    if (node.label !== 'GameComponent') return;

    const props = node.properties as any;
    if (!props.isScript) return;

    const componentTypeName = String(node.properties.name || '');
    const scriptUuid = String(props.scriptUuid || '');

    const targetIds = new Set<string>();
    let resolvedScriptPath = '';
    let matchedByUuid = false;

    // Strategy A: direct class/function/method name match for plain identifiers.
    if (IDENTIFIER_RE.test(componentTypeName)) {
      const byName = codeSymbolByName.get(componentTypeName);
      if (byName) {
        for (const id of byName) targetIds.add(id);
      }
    }

    // Strategy B: UUID-based path resolution (supports compressed UUID tokens).
    const uuidCandidates = [scriptUuid, componentTypeName].filter(Boolean);
    for (const candidate of uuidCandidates) {
      const resolvedPath = resolveMetaPathByUuidLike(metaUuidMap, candidate);
      if (!resolvedPath) continue;

      const normalizedPath = normalizePathKey(resolvedPath);
      if (!resolvedScriptPath && (normalizedPath.endsWith('.ts') || normalizedPath.endsWith('.js'))) {
        resolvedScriptPath = normalizedPath;
      }

      // Exact file path hit
      const fileId = codeFileByPath.get(normalizedPath);
      if (fileId) {
        targetIds.add(fileId);
        matchedByUuid = true;
      }

      // Basename fallback
      const base = normalizedPath.split('/').pop()?.replace(/\.[tj]s$/, '') || '';
      if (base) {
        const byFile = codeFileByBaseName.get(base);
        if (byFile) {
          for (const id of byFile) targetIds.add(id);
          matchedByUuid = true;
        }

        const byClass = codeSymbolByName.get(base);
        if (byClass) {
          for (const id of byClass) targetIds.add(id);
          matchedByUuid = true;
        }
      }
    }

    // Strategy C: filename fallback when component type looks like identifier.
    if (targetIds.size === 0 && IDENTIFIER_RE.test(componentTypeName)) {
      const byFile = codeFileByBaseName.get(componentTypeName);
      if (byFile) {
        for (const id of byFile) targetIds.add(id);
      }
    }

    for (const targetId of targetIds) {
      const relId = `cocos:phase1:scriptref:${node.id}:${targetId}`;
      if (addedEdgeIds.has(relId)) continue;
      addedEdgeIds.add(relId);

      graph.addRelationship({
        id: relId,
        type: 'SCRIPT_REFS',
        sourceId: node.id,
        targetId,
        confidence: matchedByUuid ? 0.95 : targetIds.size === 1 ? 0.9 : 0.7,
        reason: matchedByUuid ? 'cocos-script-uuid-match' : 'cocos-script-name-match',
      });
    }

    // Back-fill scriptPath for explainability even if no target edge was produced.
    if (resolvedScriptPath && !props.scriptPath) {
      props.scriptPath = resolvedScriptPath;
    } else if (targetIds.size > 0 && !props.scriptPath) {
      const first = graph.getNode(Array.from(targetIds)[0]);
      if (first?.properties?.filePath) {
        props.scriptPath = first.properties.filePath;
      }
    }

    if (targetIds.size > 0 || !!props.scriptPath) {
      componentsResolved++;
    }
  });

  return {
    edgesAdded: graph.relationshipCount - startRelCount,
    componentsResolved,
  };
}
