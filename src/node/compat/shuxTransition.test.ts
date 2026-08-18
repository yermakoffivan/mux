import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  ensureShuxDirectoryTransition,
  initializeShuxHomeTransition,
  initializeShuxUserDataTransition,
} from "./shuxTransition";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "shux-transition-test-"));
  tempDirs.push(dir);
  return dir;
}

async function expectMissingPath(path: string): Promise<void> {
  try {
    await fs.lstat(path);
  } catch {
    return;
  }
  throw new Error(`expected ${path} to be missing`);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("initializeShuxHomeTransition", () => {
  test("creates canonical storage and downgrade-compatible aliases for a fresh install", async () => {
    const homeDir = await createTempDir();

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    const canonicalPath = join(homeDir, ".shux");
    expect(result).toMatchObject({
      canonicalPath,
      activePath: canonicalPath,
      status: "canonical",
      issues: [],
    });
    expect((await fs.lstat(canonicalPath)).isDirectory()).toBe(true);
    expect(await fs.realpath(join(homeDir, ".mux"))).toBe(await fs.realpath(canonicalPath));
    expect(await fs.realpath(join(homeDir, ".cmux"))).toBe(await fs.realpath(canonicalPath));
  });

  test("second startup is a no-op once aliases already point at canonical storage", async () => {
    const homeDir = await createTempDir();

    const first = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
    await fs.writeFile(join(first.canonicalPath, "config.json"), "kept", "utf8");

    const second = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    expect(second).toMatchObject({
      canonicalPath: first.canonicalPath,
      activePath: first.canonicalPath,
      status: "canonical",
      issues: [],
    });
    expect(await fs.readFile(join(first.canonicalPath, "config.json"), "utf8")).toBe("kept");
    expect(await fs.realpath(join(homeDir, ".mux"))).toBe(await fs.realpath(first.canonicalPath));
    expect(await fs.realpath(join(homeDir, ".cmux"))).toBe(await fs.realpath(first.canonicalPath));
  });

  test("moves existing mux data and keeps upgrade and downgrade writes on one directory", async () => {
    const homeDir = await createTempDir();
    const legacyPath = join(homeDir, ".mux");
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "config.json"), "legacy", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
    const canonicalPath = join(homeDir, ".shux");

    expect(result.status).toBe("migrated");
    expect(await fs.readFile(join(canonicalPath, "config.json"), "utf8")).toBe("legacy");
    expect(await fs.realpath(legacyPath)).toBe(await fs.realpath(canonicalPath));

    await fs.writeFile(join(canonicalPath, "from-shux"), "new", "utf8");
    expect(await fs.readFile(join(legacyPath, "from-shux"), "utf8")).toBe("new");

    await fs.writeFile(join(legacyPath, "from-mux"), "old", "utf8");
    expect(await fs.readFile(join(canonicalPath, "from-mux"), "utf8")).toBe("old");
  });

  test("moves a cmux-only tree and still creates the mux alias", async () => {
    const homeDir = await createTempDir();
    const cmuxPath = join(homeDir, ".cmux");
    await fs.mkdir(cmuxPath);
    await fs.writeFile(join(cmuxPath, "config.json"), "cmux", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
    const canonicalPath = join(homeDir, ".shux");

    expect(result.status).toBe("migrated");
    expect(await fs.readFile(join(canonicalPath, "config.json"), "utf8")).toBe("cmux");
    expect(await fs.realpath(join(homeDir, ".mux"))).toBe(await fs.realpath(canonicalPath));
    expect(await fs.realpath(cmuxPath)).toBe(await fs.realpath(canonicalPath));
  });

  test("rolls a just-migrated tree back when the primary alias cannot be created", async () => {
    const homeDir = await createTempDir();
    const legacyPath = join(homeDir, ".mux");
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "config.json"), "legacy", "utf8");

    const symlink = spyOn(fs, "symlink").mockImplementation(() => {
      throw new Error("EPERM: alias blocked");
    });

    try {
      const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

      expect(result.status).toBe("legacy-fallback");
      expect(result.activePath).toBe(legacyPath);
      expect(await fs.readFile(join(legacyPath, "config.json"), "utf8")).toBe("legacy");
      expect((await fs.lstat(legacyPath)).isDirectory()).toBe(true);
      await expectMissingPath(join(homeDir, ".shux"));
    } finally {
      symlink.mockRestore();
    }
  });

  test("does not treat a broken alias or file as a migratable directory", async () => {
    const homeDir = await createTempDir();
    await fs.symlink(join(homeDir, "missing-target"), join(homeDir, ".mux"));
    await fs.writeFile(join(homeDir, ".cmux"), "not-a-directory", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
    const canonicalPath = join(homeDir, ".shux");

    expect(result.status).toBe("conflict");
    expect((await fs.lstat(canonicalPath)).isDirectory()).toBe(true);
    expect((await fs.lstat(join(homeDir, ".mux"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(join(homeDir, ".cmux"))).isFile()).toBe(true);
    expect(await fs.readdir(canonicalPath)).toEqual([]);
  });

  test("transitions development storage without repointing production cmux", async () => {
    const homeDir = await createTempDir();
    const legacyDevPath = join(homeDir, ".mux-dev");
    const productionCmuxPath = join(homeDir, ".cmux");
    await fs.mkdir(legacyDevPath);
    await fs.mkdir(productionCmuxPath);

    const result = await initializeShuxHomeTransition({
      homeDir,
      env: { NODE_ENV: "development" },
      platform: "linux",
    });

    expect(result.canonicalPath).toBe(join(homeDir, ".shux-dev"));
    expect(await fs.realpath(legacyDevPath)).toBe(await fs.realpath(result.canonicalPath));
    expect((await fs.lstat(productionCmuxPath)).isDirectory()).toBe(true);
  });

  test("does not move explicit roots and mirrors SHUX_ROOT to MUX_ROOT", async () => {
    const homeDir = await createTempDir();
    const explicitRoot = join(homeDir, "custom");
    const leftoverMux = join(homeDir, ".mux");
    await fs.mkdir(leftoverMux);
    await fs.writeFile(join(leftoverMux, "config.json"), "untouched", "utf8");
    const env: Record<string, string | undefined> = { SHUX_ROOT: explicitRoot };

    const result = await initializeShuxHomeTransition({ homeDir, env, platform: "linux" });

    expect(result).toEqual({
      canonicalPath: explicitRoot,
      activePath: explicitRoot,
      status: "canonical",
      issues: [],
    });
    expect(env.MUX_ROOT).toBe(explicitRoot);
    // Explicit roots skip default-home moves, mkdirs, and alias creation.
    expect(await fs.readFile(join(leftoverMux, "config.json"), "utf8")).toBe("untouched");
    expect((await fs.lstat(leftoverMux)).isDirectory()).toBe(true);
    await expectMissingPath(join(homeDir, ".shux"));
    await expectMissingPath(explicitRoot);
  });

  test("leaves independent canonical and legacy directories untouched", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const legacyPath = join(homeDir, ".mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(canonicalPath, "canonical"), "new", "utf8");
    await fs.writeFile(join(legacyPath, "legacy"), "old", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    expect(result.status).toBe("conflict");
    expect(result.issues).toHaveLength(1);
    expect(await fs.readFile(join(canonicalPath, "canonical"), "utf8")).toBe("new");
    expect(await fs.readFile(join(legacyPath, "legacy"), "utf8")).toBe("old");
    expect((await fs.lstat(legacyPath)).isDirectory()).toBe(true);
  });
});

describe("ensureShuxDirectoryTransition", () => {
  test("requests an absolute Windows junction without asserting NTFS behavior", async () => {
    const root = await createTempDir();
    const canonicalPath = join(root, "shux");
    const legacyPath = join(root, "mux");
    const symlink = spyOn(fs, "symlink").mockImplementation(() => Promise.resolve());

    try {
      const result = await ensureShuxDirectoryTransition({
        canonicalPath,
        legacyPaths: [legacyPath],
        platform: "win32",
      });

      expect(result.status).toBe("canonical");
      expect(symlink).toHaveBeenCalledWith(resolve(canonicalPath), legacyPath, "junction");
    } finally {
      symlink.mockRestore();
    }
  });
});

describe("initializeShuxUserDataTransition", () => {
  test("moves Electron userData and leaves the old app-name path pointing forward", async () => {
    const appDataDir = await createTempDir();
    const legacyPath = join(appDataDir, "mux");
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "window-state.json"), "{}", "utf8");

    const result = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(result.status).toBe("migrated");
    expect(result.canonicalPath).toBe(join(appDataDir, "shux"));
    expect(await fs.readFile(join(result.canonicalPath, "window-state.json"), "utf8")).toBe("{}");
    expect(await fs.realpath(legacyPath)).toBe(await fs.realpath(result.canonicalPath));
    expect(await fs.realpath(join(appDataDir, "Mux"))).toBe(
      await fs.realpath(result.canonicalPath)
    );
  });

  test("migrates the historical Linux Mux userData name", async () => {
    const appDataDir = await createTempDir();
    const legacyPath = join(appDataDir, "Mux");
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "window-state.json"), "{}", "utf8");

    const result = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(result.status).toBe("migrated");
    expect(await fs.readFile(join(result.canonicalPath, "window-state.json"), "utf8")).toBe("{}");
    expect(await fs.realpath(legacyPath)).toBe(await fs.realpath(result.canonicalPath));
    expect(await fs.realpath(join(appDataDir, "mux"))).toBe(
      await fs.realpath(result.canonicalPath)
    );
  });

  test("adopts a populated legacy tree into an empty canonical userData directory", async () => {
    const appDataDir = await createTempDir();
    const canonicalPath = join(appDataDir, "shux");
    const legacyPath = join(appDataDir, "mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "window-state.json"), "{}", "utf8");

    const result = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(result.status).toBe("migrated");
    expect(await fs.readFile(join(canonicalPath, "window-state.json"), "utf8")).toBe("{}");
    expect(await fs.realpath(legacyPath)).toBe(await fs.realpath(canonicalPath));
    expect(await fs.realpath(join(appDataDir, "Mux"))).toBe(await fs.realpath(canonicalPath));
    expect((await fs.lstat(canonicalPath)).isDirectory()).toBe(true);
  });

  test("does not merge or delete independent populated userData trees", async () => {
    const appDataDir = await createTempDir();
    const canonicalPath = join(appDataDir, "shux");
    const muxPath = join(appDataDir, "mux");
    const productNamePath = join(appDataDir, "Mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(muxPath);
    await fs.mkdir(productNamePath);
    await fs.writeFile(join(canonicalPath, "from-shux"), "new", "utf8");
    await fs.writeFile(join(muxPath, "from-mux"), "old", "utf8");
    await fs.writeFile(join(productNamePath, "from-Mux"), "older", "utf8");

    const result = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(result.status).toBe("conflict");
    expect(await fs.readFile(join(canonicalPath, "from-shux"), "utf8")).toBe("new");
    expect(await fs.readFile(join(muxPath, "from-mux"), "utf8")).toBe("old");
    expect(await fs.readFile(join(productNamePath, "from-Mux"), "utf8")).toBe("older");
    expect((await fs.lstat(muxPath)).isDirectory()).toBe(true);
    expect((await fs.lstat(productNamePath)).isDirectory()).toBe(true);
  });
});
