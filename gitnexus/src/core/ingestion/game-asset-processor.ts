/**
 * Game Asset Processor — Phase 8 of the GitNexus ingestion pipeline
 *
 * Scans Cocos Creator .fire (scene) and .prefab files in the repository,
 * builds game asset nodes and relationships, and adds them to the graph.
 *
 * This phase runs after all code phases so that SCRIPT_REFS cross-layer
 * edges can connect game components to already-indexed code symbols.
 *
 * Auto-skips: if no Cocos Creator files are found, the phase is a no-op
 * and costs only a fast glob check.
 */

import fs from 'fs/promises';
import path from 'path';
import { KnowledgeGraph } from '../graph/types.js';
import { PipelineProgress } from '../../types/pipeline.js';
import { isCocosProject } from '../plugins/cocos/cocos-detector.js';
import { parseCocosFileContent } from '../plugins/cocos/cocos-file-parser.js';
import { addCocosFileToGraph } from '../plugins/cocos/cocos-graph-builder.js';
import { resolveScriptRefs, buildMetaUuidMap } from '../plugins/cocos/cocos-script-resolver.js';
import { ScannedFile } from './filesystem-walker.js';

const COCOS_EXTENSIONS = new Set(['.fire', '.prefab']);
const PARALLEL_BATCH = 32;

/**
 * Process all Cocos Creator game assets in the repository.
 *
 * @param graph       - The in-memory knowledge graph (code already indexed)
 * @param repoPath    - Absolute path to the repository root
 * @param scannedFiles - Already-scanned file list from Phase 1 (reused, no re-scan)
 * @param onProgress  - Progress callback
 */
export async function processGameAssets(
  graph: KnowledgeGraph,
  repoPath: string,
  scannedFiles: ScannedFile[],
  onProgress: (progress: PipelineProgress) => void,
): Promise<{ scenesFound: number; prefabsFound: number; nodesAdded: number; relsAdded: number }> {
  const startNodeCount = graph.nodeCount;
  const startRelCount = graph.relationshipCount;

  // ── Quick detection — reuse scanned file list ──────────────────────────────
  const cocosFiles = scannedFiles.filter(f => {
    const ext = path.extname(f.path).toLowerCase();
    return COCOS_EXTENSIONS.has(ext);
  });

  if (cocosFiles.length === 0) {
    // Fallback: check for Cocos marker files (in case they were filtered)
    const hasCocos = await isCocosProject(repoPath);
    if (!hasCocos) {
      onProgress({
        phase: 'game-assets',
        percent: 99,
        message: 'No Cocos Creator assets detected — skipping',
        stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: graph.nodeCount },
      });
      return { scenesFound: 0, prefabsFound: 0, nodesAdded: 0, relsAdded: 0 };
    }
  }

  const total = cocosFiles.length;
  onProgress({
    phase: 'game-assets',
    percent: 95,
    message: `Found ${total} Cocos Creator asset files (.fire/.prefab)`,
    stats: { filesProcessed: 0, totalFiles: total, nodesCreated: graph.nodeCount },
  });

  // ── Parse meta files for UUID→path mapping ────────────────────────────────
  const allPaths = scannedFiles.map(f => f.path);
  const metaUuidMap = await buildMetaUuidMap(allPaths, async (relPath) => {
    try {
      return await fs.readFile(path.join(repoPath, relPath), 'utf-8');
    } catch {
      return null;
    }
  });

  // ── Parse .fire/.prefab files in parallel batches ────────────────────────
  let scenesFound = 0;
  let prefabsFound = 0;
  let processed = 0;

  for (let i = 0; i < cocosFiles.length; i += PARALLEL_BATCH) {
    const batch = cocosFiles.slice(i, i + PARALLEL_BATCH);

    await Promise.all(batch.map(async (file) => {
      try {
        const content = await fs.readFile(path.join(repoPath, file.path), 'utf-8');
        const parsed = parseCocosFileContent(file.path, content);
        if (parsed) {
          addCocosFileToGraph(graph, parsed);
          if (parsed.assetType === 'scene-file') scenesFound++;
          else prefabsFound++;
        }
      } catch { /* skip unreadable files */ }
    }));

    processed += batch.length;
    const percent = 95 + Math.round((processed / total) * 4); // 95→99%
    onProgress({
      phase: 'game-assets',
      percent: Math.min(percent, 99),
      message: `Processing Cocos assets... (${processed}/${total})`,
      stats: { filesProcessed: processed, totalFiles: total, nodesCreated: graph.nodeCount },
    });
  }

  // ── Resolve script cross-layer references ─────────────────────────────────
  resolveScriptRefs(graph, metaUuidMap);

  const nodesAdded = graph.nodeCount - startNodeCount;
  const relsAdded = graph.relationshipCount - startRelCount;

  onProgress({
    phase: 'game-assets',
    percent: 99,
    message: `Game assets: ${scenesFound} scenes, ${prefabsFound} prefabs → ${nodesAdded} nodes, ${relsAdded} rels`,
    stats: { filesProcessed: total, totalFiles: total, nodesCreated: graph.nodeCount },
  });

  return { scenesFound, prefabsFound, nodesAdded, relsAdded };
}
