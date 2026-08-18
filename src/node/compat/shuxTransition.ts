import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  LEGACY_CMUX_HOME_DIR_NAME,
  LEGACY_MUX_HOME_DIR_NAME,
  LEGACY_MUX_PRODUCT_NAME,
  LEGACY_MUX_PRODUCT_SLUG,
  installLegacyMuxEnvironmentAliases,
  resolveShuxEnvironmentValue,
  type ShuxEnvironment,
} from "@/common/compat/legacyMux";
import { SHUX_HOME_DIR_NAME } from "@/common/constants/product";

export type ShuxTransitionStatus = "canonical" | "migrated" | "legacy-fallback" | "conflict";

export interface ShuxDirectoryTransitionResult {
  canonicalPath: string;
  activePath: string;
  status: ShuxTransitionStatus;
  issues: string[];
}

interface ShuxDirectoryTransitionOptions {
  canonicalPath: string;
  legacyPaths: string[];
  platform?: NodeJS.Platform;
}

interface ShuxHomeTransitionOptions {
  env?: ShuxEnvironment;
  homeDir?: string;
  nodeEnv?: string;
  platform?: NodeJS.Platform;
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only for a usable directory tree. Broken aliases and non-directories must
 * not be renamed into the canonical path as if they were migratable data.
 */
async function isHealthyDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isEmptyRealDirectory(path: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(path);
    // Junctions/symlinks can look directory-like after stat(); only replace a real empty dir.
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return false;
    }
    return (await fs.readdir(path)).length === 0;
  } catch {
    return false;
  }
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await fs.readdir(path)).length > 0;
  } catch {
    // Unreadable trees are treated as populated so we never adopt them as empty.
    return true;
  }
}

async function pathsResolveToSameEntry(left: string, right: string): Promise<boolean> {
  try {
    return (await fs.realpath(left)) === (await fs.realpath(right));
  } catch {
    return false;
  }
}

function dedupeResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const key = resolve(path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(path);
  }
  return unique;
}

async function sameExistingEntry(left: string, right: string): Promise<boolean> {
  return resolve(left) === resolve(right) || (await pathsResolveToSameEntry(left, right));
}

async function findFirstHealthyDirectory(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await isHealthyDirectory(path)) {
      return path;
    }
  }
  return undefined;
}

/**
 * Case-insensitive volumes expose `mux` and `Mux` as one directory. Count that
 * as a single tree so we migrate once instead of reporting a false conflict.
 */
async function findSolePopulatedIndependentLegacy(
  legacyPaths: string[],
  canonicalPath: string
): Promise<string | undefined> {
  const populated: string[] = [];
  for (const legacyPath of legacyPaths) {
    if (!(await isHealthyDirectory(legacyPath)) || !(await directoryHasEntries(legacyPath))) {
      continue;
    }
    if (await sameExistingEntry(legacyPath, canonicalPath)) {
      continue;
    }
    let alreadyCounted = false;
    for (const existing of populated) {
      if (await sameExistingEntry(existing, legacyPath)) {
        alreadyCounted = true;
        break;
      }
    }
    if (alreadyCounted) {
      continue;
    }
    populated.push(legacyPath);
  }
  return populated.length === 1 ? populated[0] : undefined;
}

async function createDirectoryAlias(
  targetPath: string,
  aliasPath: string,
  platform: NodeJS.Platform
): Promise<void> {
  // Windows directory junctions do not require Developer Mode or elevation, unlike
  // ordinary directory symlinks. Absolute targets also avoid cwd-dependent junctions.
  // Linux/macOS tests may pass platform "win32" to assert this argv contract; that
  // does not prove NTFS junction semantics.
  await fs.symlink(resolve(targetPath), aliasPath, platform === "win32" ? "junction" : "dir");
}

/**
 * Move a legacy directory to its canonical shux path and leave old-name directory
 * aliases pointing forward. Older mux builds therefore keep reading and writing the
 * same files after an upgrade and subsequent downgrade.
 *
 * This function is deliberately non-destructive: independent populated paths are
 * reported as conflicts rather than merged, replaced, or deleted.
 */
export async function ensureShuxDirectoryTransition(
  options: ShuxDirectoryTransitionOptions
): Promise<ShuxDirectoryTransitionResult> {
  const platform = options.platform ?? process.platform;
  const issues: string[] = [];
  const canonicalPath = options.canonicalPath;
  const legacyPaths = dedupeResolvedPaths(options.legacyPaths);
  const canonicalExistedInitially = await pathEntryExists(canonicalPath);
  let migratedFrom: string | undefined;
  let createdCanonical = false;

  if (!canonicalExistedInitially) {
    const sourcePath = await findFirstHealthyDirectory(legacyPaths);

    if (sourcePath) {
      try {
        await fs.rename(sourcePath, canonicalPath);
        migratedFrom = sourcePath;
      } catch (error) {
        issues.push(`Could not move ${sourcePath} to ${canonicalPath}: ${String(error)}`);
        return {
          canonicalPath,
          activePath: sourcePath,
          status: "legacy-fallback",
          issues,
        };
      }
    } else {
      try {
        await fs.mkdir(canonicalPath, { recursive: true });
        createdCanonical = true;
      } catch (error) {
        issues.push(`Could not create ${canonicalPath}: ${String(error)}`);
        const fallbackPath = legacyPaths[0];
        try {
          await fs.mkdir(fallbackPath, { recursive: true });
        } catch (fallbackError) {
          issues.push(`Could not create fallback ${fallbackPath}: ${String(fallbackError)}`);
        }
        return {
          canonicalPath,
          activePath: fallbackPath,
          status: "legacy-fallback",
          issues,
        };
      }
    }
  } else if (await isEmptyRealDirectory(canonicalPath)) {
    // An empty canonical dir plus one populated legacy tree is a leftover split
    // (Electron may mkdir the new app name before we run). Adopt the legacy tree
    // instead of leaving two independent homes. Two populated trees stay conflicts.
    const sourcePath = await findSolePopulatedIndependentLegacy(legacyPaths, canonicalPath);
    if (sourcePath) {
      try {
        await fs.rmdir(canonicalPath);
        await fs.rename(sourcePath, canonicalPath);
        migratedFrom = sourcePath;
      } catch (error) {
        issues.push(`Could not move ${sourcePath} into empty ${canonicalPath}: ${String(error)}`);
        if (!(await pathEntryExists(canonicalPath))) {
          try {
            await fs.mkdir(canonicalPath, { recursive: true });
          } catch (restoreError) {
            issues.push(`Could not restore ${canonicalPath}: ${String(restoreError)}`);
            return {
              canonicalPath,
              activePath: sourcePath,
              status: "legacy-fallback",
              issues,
            };
          }
        }
      }
    }
  }

  for (const legacyPath of legacyPaths) {
    if (await pathEntryExists(legacyPath)) {
      if (!(await sameExistingEntry(legacyPath, canonicalPath))) {
        issues.push(
          `Both ${legacyPath} and ${canonicalPath} exist independently; left both unchanged`
        );
      }
      continue;
    }

    try {
      await createDirectoryAlias(canonicalPath, legacyPath, platform);
    } catch (error) {
      issues.push(`Could not create compatibility alias ${legacyPath}: ${String(error)}`);

      // If this run just moved or created the canonical directory, roll it back to
      // the primary legacy path rather than strand existing users without a path an
      // older binary can open. A pre-existing canonical directory is never moved.
      const primaryLegacyPath = legacyPaths[0];
      if ((migratedFrom != null || createdCanonical) && legacyPath === primaryLegacyPath) {
        try {
          await fs.rename(canonicalPath, primaryLegacyPath);
          return {
            canonicalPath,
            activePath: primaryLegacyPath,
            status: "legacy-fallback",
            issues,
          };
        } catch (rollbackError) {
          issues.push(`Could not roll back to ${primaryLegacyPath}: ${String(rollbackError)}`);
        }
      }
    }
  }

  const hasConflict = issues.some((issue) => issue.includes("exist independently"));
  return {
    canonicalPath,
    activePath: canonicalPath,
    status: hasConflict ? "conflict" : migratedFrom ? "migrated" : "canonical",
    issues,
  };
}

export async function initializeShuxUserDataTransition(options: {
  appDataDir: string;
  platform?: NodeJS.Platform;
}): Promise<ShuxDirectoryTransitionResult> {
  // Linux Chromium userData used the case-sensitive product name `Mux` while
  // other platforms stored `mux`. Include both and let same-entry dedupe keep
  // case-insensitive volumes from treating them as two trees.
  return await ensureShuxDirectoryTransition({
    canonicalPath: join(options.appDataDir, "shux"),
    legacyPaths: [
      join(options.appDataDir, LEGACY_MUX_PRODUCT_SLUG),
      join(options.appDataDir, LEGACY_MUX_PRODUCT_NAME),
    ],
    platform: options.platform,
  });
}

/**
 * Initialize the default ~/.shux storage transition.
 * Explicit SHUX_ROOT / MUX_ROOT locations are never moved, created, or aliased.
 */
export async function initializeShuxHomeTransition(
  options: ShuxHomeTransitionOptions = {}
): Promise<ShuxDirectoryTransitionResult> {
  const env = options.env ?? process.env;
  installLegacyMuxEnvironmentAliases(env);

  const explicitRoot = resolveShuxEnvironmentValue("ROOT", env);
  if (explicitRoot) {
    return {
      canonicalPath: explicitRoot,
      activePath: explicitRoot,
      status: "canonical",
      issues: [],
    };
  }

  const homeDir = options.homeDir ?? homedir();
  const suffix = (options.nodeEnv ?? env.NODE_ENV) === "development" ? "-dev" : "";
  const canonicalPath = join(homeDir, SHUX_HOME_DIR_NAME + suffix);
  const legacyPaths = [join(homeDir, LEGACY_MUX_HOME_DIR_NAME + suffix)];
  if (!suffix) {
    legacyPaths.push(join(homeDir, LEGACY_CMUX_HOME_DIR_NAME));
  }

  return await ensureShuxDirectoryTransition({
    canonicalPath,
    legacyPaths,
    platform: options.platform,
  });
}
