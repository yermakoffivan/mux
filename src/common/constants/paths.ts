import { existsSync, lstatSync, rmSync, statSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import {
  LEGACY_CMUX_HOME_DIR_NAME,
  LEGACY_MUX_HOME_DIR_NAME,
  resolveShuxEnvironmentValue,
} from "@/common/compat/legacyMux";
import { SHUX_HOME_DIR_NAME } from "@/common/constants/product";

/**
 * Session-dir file holding the active chat history epoch (latest compaction
 * boundary onward). Example: ~/.shux/sessions/<workspace>/chat.jsonl
 */
export const CHAT_FILE_NAME = "chat.jsonl";

export const TIMELINE_FILE_NAME = "timeline.jsonl";

/**
 * Session-dir file holding sealed pre-boundary chat history. HistoryService
 * rotates everything before the latest durable context boundary out of
 * chat.jsonl into this append-only archive so per-turn reads/rewrites stay
 * O(active epoch) instead of O(lifetime history).
 */
export const CHAT_ARCHIVE_FILE_NAME = "chat-archive.jsonl";

/**
 * Per-workspace sidecar recording headless AI usage (status generation,
 * memory consolidation/harvest) that produces no chat.jsonl assistant row.
 * Appended by SessionUsageService.recordHeadlessUsage and ingested into the
 * analytics events table by the ETL so dashboard totals include this spend.
 */
export const HEADLESS_USAGE_FILE_NAME = "headless-usage.jsonl";

const OBSOLETE_SHUX_BIN_ARTIFACTS = ["agent-browser", "agent-browser.cmd"] as const;

/**
 * Remove obsolete shux-managed bin wrappers that are no longer created at startup.
 * Keep this startup cleanup narrow so we don't delete unrelated user-managed files.
 */
export function cleanupObsoleteShuxBinArtifacts(rootDir?: string): void {
  const binDir = join(rootDir ?? getShuxHome(), "bin");

  for (const artifactName of OBSOLETE_SHUX_BIN_ARTIFACTS) {
    const artifactPath = join(binDir, artifactName);

    try {
      if (!existsSync(artifactPath)) {
        continue;
      }

      const stats = lstatSync(artifactPath);
      if (stats.isDirectory()) {
        continue;
      }

      rmSync(artifactPath, { force: true });
    } catch {
      // Startup cleanup is best-effort; permission drift on a stale wrapper should not
      // abort app launch or prevent the remaining artifacts from being cleaned up.
      continue;
    }
  }
}

/**
 * True only for a usable directory tree. Regular files and broken aliases must
 * not be treated as configuration or session storage.
 */
function isHealthyDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Get the root directory for all shux configuration and data.
 * SHUX_ROOT is canonical; MUX_ROOT remains a downgrade-compatible alias.
 * Appends '-dev' when NODE_ENV=development.
 *
 * Prefer a usable canonical directory, then the first healthy leftover tree.
 * A file or broken symlink at ~/.shux is not a home: after
 * initializeShuxHomeTransition() falls back to ~/.mux, this helper must keep
 * returning that leftover path. A genuinely empty home still returns the
 * canonical future path.
 *
 * Main-process only: this helper lives in constants/ for organization, but it
 * reads process.env / homedir and must not be imported from renderer code.
 * The lint disable below is the documented renderer-boundary exception.
 */
export function getShuxHome(): string {
  // eslint-disable-next-line no-restricted-globals, no-restricted-syntax -- main-only home resolution; see file comment
  const explicitRoot = resolveShuxEnvironmentValue("ROOT", process.env);
  if (explicitRoot) {
    return explicitRoot;
  }

  // eslint-disable-next-line no-restricted-globals, no-restricted-syntax -- main-only NODE_ENV suffix; see file comment
  const suffix = process.env.NODE_ENV === "development" ? "-dev" : "";
  const homeDir = os.homedir();
  const canonicalPath = join(homeDir, SHUX_HOME_DIR_NAME + suffix);
  if (isHealthyDirectory(canonicalPath)) {
    return canonicalPath;
  }

  const legacyMuxPath = join(homeDir, LEGACY_MUX_HOME_DIR_NAME + suffix);
  if (isHealthyDirectory(legacyMuxPath)) {
    return legacyMuxPath;
  }

  if (!suffix) {
    const legacyCmuxPath = join(homeDir, LEGACY_CMUX_HOME_DIR_NAME);
    if (isHealthyDirectory(legacyCmuxPath)) {
      return legacyCmuxPath;
    }
  }

  return canonicalPath;
}

/**
 * Get the directory where workspace git worktrees are stored.
 * Example: ~/.shux/src/my-project/feature-branch
 *
 * @param rootDir - Optional root directory (defaults to getShuxHome())
 */
export function getShuxSrcDir(rootDir?: string): string {
  const root = rootDir ?? getShuxHome();
  return join(root, "src");
}

/**
 * Get the directory where session chat histories are stored.
 * Example: ~/.shux/sessions/workspace-id/chat.jsonl
 *
 * @param rootDir - Optional root directory (defaults to getShuxHome())
 */
export function getShuxSessionsDir(rootDir?: string): string {
  const root = rootDir ?? getShuxHome();
  return join(root, "sessions");
}

/**
 * Get the directory where mux backend logs are stored.
 * Example: ~/.shux/logs/mux.log
 *
 * @param rootDir - Optional root directory (defaults to getShuxHome())
 */
export function getShuxLogsDir(rootDir?: string): string {
  const root = rootDir ?? getShuxHome();
  return join(root, "logs");
}

/**
 * Get the default directory for new projects created with bare names.
 * Example: ~/.shux/projects/my-project
 *
 * @param rootDir - Optional root directory (defaults to getShuxHome())
 */
export function getShuxProjectsDir(rootDir?: string): string {
  const root = rootDir ?? getShuxHome();
  return join(root, "projects");
}

/**
 * Get the extension metadata file path (shared with VS Code extension).
 *
 * @param rootDir - Optional root directory (defaults to getShuxHome())
 */
export function getShuxExtensionMetadataPath(rootDir?: string): string {
  const root = rootDir ?? getShuxHome();
  return join(root, "extensionMetadata.json");
}
