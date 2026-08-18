import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { initializeShuxHomeTransition } from "@/node/compat/shuxTransition";
import { sanitizeShuxChildEnv } from "@/node/runtime/childProcessEnv";
import { cleanupObsoleteShuxBinArtifacts, getShuxHome } from "./paths";

const tempDirs: string[] = [];
const envKeysToRestore = ["HOME", "USERPROFILE", "SHUX_ROOT", "MUX_ROOT", "NODE_ENV"] as const;
const savedEnv = new Map<string, string | undefined>();

function createTempMuxRoot(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "mux-paths-test-"));
  tempDirs.push(dir);
  return dir;
}

function snapshotEnv(): void {
  for (const key of envKeysToRestore) {
    if (!savedEnv.has(key)) {
      savedEnv.set(key, process.env[key]);
    }
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
}

function withHomeDir(homeDir: string, run: () => void): void {
  snapshotEnv();
  const homedirSpy = spyOn(os, "homedir");
  homedirSpy.mockReturnValue(homeDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.SHUX_ROOT;
  delete process.env.MUX_ROOT;
  delete process.env.NODE_ENV;

  try {
    run();
  } finally {
    homedirSpy.mockRestore();
    restoreEnv();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cleanupObsoleteShuxBinArtifacts", () => {
  test("removes obsolete agent-browser wrapper files from mux bin", () => {
    const muxRoot = createTempMuxRoot();
    const binDir = join(muxRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "agent-browser"), "#!/bin/sh\n", "utf8");
    writeFileSync(join(binDir, "agent-browser.cmd"), "@echo off\n", "utf8");
    writeFileSync(join(binDir, "mux-askpass"), "#!/bin/sh\necho keep\n", "utf8");

    cleanupObsoleteShuxBinArtifacts(muxRoot);

    expect(existsSync(join(binDir, "agent-browser"))).toBe(false);
    expect(existsSync(join(binDir, "agent-browser.cmd"))).toBe(false);
    expect(existsSync(join(binDir, "mux-askpass"))).toBe(true);
    expect(readFileSync(join(binDir, "mux-askpass"), "utf8")).toContain("keep");
  });

  test("does not remove directories named like obsolete wrapper files", () => {
    const muxRoot = createTempMuxRoot();
    const binDir = join(muxRoot, "bin");
    const wrapperDir = join(binDir, "agent-browser");
    mkdirSync(wrapperDir, { recursive: true });

    cleanupObsoleteShuxBinArtifacts(muxRoot);

    expect(existsSync(wrapperDir)).toBe(true);
    expect(lstatSync(wrapperDir).isDirectory()).toBe(true);
  });

  test("is a no-op when mux bin does not exist", () => {
    const muxRoot = createTempMuxRoot();
    expect(() => cleanupObsoleteShuxBinArtifacts(muxRoot)).not.toThrow();
  });
});

describe("getShuxHome", () => {
  test("returns the canonical future path on a fresh home", () => {
    const homeDir = createTempMuxRoot();

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(join(homeDir, ".shux"));
    });
  });

  test("prefers a usable canonical directory over leftover trees", () => {
    const homeDir = createTempMuxRoot();
    mkdirSync(join(homeDir, ".shux"));
    mkdirSync(join(homeDir, ".mux"));

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(join(homeDir, ".shux"));
    });
  });

  test("prefers a healthy leftover tree when canonical storage is a regular file", () => {
    const homeDir = createTempMuxRoot();
    writeFileSync(join(homeDir, ".shux"), "not-a-directory", "utf8");
    mkdirSync(join(homeDir, ".mux"));

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(join(homeDir, ".mux"));
    });
  });

  test("prefers a healthy leftover tree when canonical storage is a broken symlink", () => {
    const homeDir = createTempMuxRoot();
    symlinkSync(join(homeDir, "missing-target"), join(homeDir, ".shux"));
    mkdirSync(join(homeDir, ".mux"));

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(join(homeDir, ".mux"));
    });
  });

  test("follows a transition fallback when canonical is unusable and leftover is new", async () => {
    const homeDir = createTempMuxRoot();
    writeFileSync(join(homeDir, ".shux"), "not-a-directory", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    withHomeDir(homeDir, () => {
      expect(result.status).toBe("legacy-fallback");
      expect(getShuxHome()).toBe(result.activePath);
      expect(getShuxHome()).toBe(join(homeDir, ".mux"));
      expect(lstatSync(join(homeDir, ".shux")).isFile()).toBe(true);
    });
  });

  test("follows session ROOT aliases after failed empty-canonical adoption", async () => {
    const homeDir = createTempMuxRoot();
    mkdirSync(join(homeDir, ".shux"));
    mkdirSync(join(homeDir, ".mux"));
    writeFileSync(join(homeDir, ".mux", "config.json"), "legacy", "utf8");
    const env: Record<string, string | undefined> = {};
    const rmdir = spyOn(fs, "rmdir").mockImplementation(() => {
      throw new Error("EBUSY: directory locked");
    });

    try {
      const result = await initializeShuxHomeTransition({ homeDir, env, platform: "linux" });

      expect(result.status).toBe("legacy-fallback");
      expect(env.SHUX_ROOT).toBe(result.activePath);
      expect(env.MUX_ROOT).toBe(result.activePath);
      expect(sanitizeShuxChildEnv(env).SHUX_ROOT).toBe(result.activePath);
      expect(sanitizeShuxChildEnv(env).MUX_ROOT).toBe(result.activePath);

      withHomeDir(homeDir, () => {
        process.env.SHUX_ROOT = env.SHUX_ROOT;
        process.env.MUX_ROOT = env.MUX_ROOT;
        expect(getShuxHome()).toBe(result.activePath);
        expect(getShuxHome()).toBe(join(homeDir, ".mux"));
      });
    } finally {
      rmdir.mockRestore();
    }
  });

  test("keeps explicit SHUX_ROOT even when leftover homes exist", () => {
    const homeDir = createTempMuxRoot();
    const explicitRoot = join(homeDir, "custom");
    writeFileSync(join(homeDir, ".shux"), "not-a-directory", "utf8");
    mkdirSync(join(homeDir, ".mux"));

    withHomeDir(homeDir, () => {
      process.env.SHUX_ROOT = explicitRoot;
      expect(getShuxHome()).toBe(explicitRoot);
    });
  });
});
