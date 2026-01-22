#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const os = require("os");

function parseArgs(argv) {
  const args = {
    apply: false,
    move: false,
    overwrite: false,
    from: null,
    to: null,
  };

  for (const token of argv.slice(2)) {
    if (token === "--apply") args.apply = true;
    else if (token === "--move") args.move = true;
    else if (token === "--overwrite") args.overwrite = true;
    else if (token.startsWith("--from=")) args.from = token.slice("--from=".length);
    else if (token.startsWith("--to=")) args.to = token.slice("--to=".length);
    else if (token === "-h" || token === "--help") args.help = true;
  }

  return args;
}

function getDefaultUserDataDir() {
  const home = os.homedir();
  const appDirName = "recaply-electron";

  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", appDirName);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, appDirName);
  }
  return path.join(home, ".config", appDirName);
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function mkdirp(p, apply) {
  if (!apply) return;
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dst, apply, overwrite) {
  if (!apply) return;
  if (!overwrite && exists(dst)) return;
  mkdirp(path.dirname(dst), apply);
  fs.copyFileSync(src, dst);
}

function copyDir(srcDir, dstDir, apply, overwrite) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  mkdirp(dstDir, apply);

  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dst, apply, overwrite);
    } else if (entry.isFile()) {
      copyFile(src, dst, apply, overwrite);
    }
  }
}

function removeDir(srcDir, apply) {
  if (!apply) return;
  fs.rmSync(srcDir, { recursive: true, force: true });
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`
Usage:
  pnpm migrate:outputs              # dry-run (default)
  pnpm migrate:outputs -- --apply   # copy data

Options:
  --apply        Actually write changes (default is dry-run)
  --move         Remove source after copy (requires --apply)
  --overwrite    Overwrite existing destination files
  --from=PATH    Source outputs dir (default: backend/outputs)
  --to=PATH      Destination outputs dir (default: userData/outputs)
`);
    process.exit(0);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const source = path.resolve(repoRoot, args.from || "backend/outputs");

  const userData = getDefaultUserDataDir();
  const dest = path.resolve(
    args.to || process.env.RECAPLY_OUTPUT_DIR || path.join(userData, "outputs")
  );

  const apply = args.apply;
  const move = args.move;

  console.log(`[migrate-outputs] mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`[migrate-outputs] from: ${source}`);
  console.log(`[migrate-outputs] to:   ${dest}`);

  if (!exists(source)) {
    console.log("[migrate-outputs] source does not exist; nothing to migrate.");
    return;
  }

  const items = fs.readdirSync(source, { withFileTypes: true });
  const candidates = items.filter((e) => e.isDirectory() || e.isFile());
  if (candidates.length === 0) {
    console.log("[migrate-outputs] source is empty; nothing to migrate.");
    return;
  }

  mkdirp(dest, apply);

  const planned = [];
  for (const entry of candidates) {
    const srcPath = path.join(source, entry.name);
    const dstPath = path.join(dest, entry.name);
    planned.push({ name: entry.name, srcPath, dstPath, kind: entry.isDirectory() ? "dir" : "file" });
  }

  for (const item of planned) {
    const dstExists = exists(item.dstPath);
    const note = dstExists ? (args.overwrite ? "overwrite" : "skip-existing") : "copy";
    console.log(`[migrate-outputs] ${item.kind} ${item.name} -> ${note}`);

    if (!apply) continue;

    if (item.kind === "dir") {
      if (dstExists && !args.overwrite) continue;
      copyDir(item.srcPath, item.dstPath, apply, args.overwrite);
    } else {
      copyFile(item.srcPath, item.dstPath, apply, args.overwrite);
    }
  }

  if (apply && move) {
    console.log("[migrate-outputs] --move enabled: removing source directory");
    removeDir(source, apply);
  }

  console.log("[migrate-outputs] done");
}

main();

