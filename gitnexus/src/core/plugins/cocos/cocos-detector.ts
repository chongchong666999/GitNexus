/**
 * Cocos Creator Project Detector
 *
 * Determines whether a repository contains a Cocos Creator project
 * by looking for characteristic assets directory structure with .fire/.prefab files.
 */

import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';

/**
 * Returns true if the repo looks like a Cocos Creator project.
 * Heuristic: check for at least one .fire or .prefab file under assets/.
 * Fast — does a shallow glob before committing to full parsing.
 */
export async function isCocosProject(repoPath: string): Promise<boolean> {
  // Check for Cocos Creator marker files
  const markers = [
    'creator.d.ts',
    'assets/main.js',
    'project.json',
  ];

  for (const marker of markers) {
    try {
      await fs.access(path.join(repoPath, marker));
      return true;
    } catch { /* not found */ }
  }

  // Fallback: glob for .fire/.prefab files (deeper check)
  try {
    const fireFiles = await glob('**/*.fire', {
      cwd: repoPath,
      nodir: true,
      ignore: ['node_modules/**', '.git/**'],
    });
    if (fireFiles.length > 0) return true;

    const prefabFiles = await glob('**/*.prefab', {
      cwd: repoPath,
      nodir: true,
      ignore: ['node_modules/**', '.git/**'],
    });
    return prefabFiles.length > 0;
  } catch {
    return false;
  }
}
