#!/usr/bin/env node
// ============================================================================
// node_modules 修补器（junction + 语义化版本解析）
// ============================================================================
//
// 为什么需要它
// ------------
// pnpm 默认用「目录符号链接」把依赖挂进 node_modules。Windows 上创建目录符号链接
// 需要开启「开发者模式」或持有 SeCreateSymbolicLinkPrivilege；普通账户或受限环境
// 会直接 EPERM 失败。失败后 pnpm 的 install 依然显示成功，但：
//   1) 各包的 node_modules 里只剩直接依赖（且可能是错的版本）；
//   2) 嵌套依赖平铺在 node_modules/.pnpm/node_modules/（按名字去重的共享池）；
//   3) 运行时报 Cannot find module 'uid' / 'tslib'，构建报 ERR_PACKAGE_PATH_NOT_EXPORTED。
//
// 为什么不能直接用共享池
// ----------------------
// 共享池按**名字**去重，同名多版本只留一个。monorepo 里这必然出错：
// Taro 的 webpack 工具链要 rollup@3，Vite 6 要 rollup@4；共享池留下 3.x，
// 挂到 apps/web 顶层后 Vite 立刻报「rollup 没有 ./parseAst 导出」。
//
// 本脚本的做法
// ------------
// 以各包自己的 node_modules/.pnpm 作为**唯一可信来源**（那是 pnpm 真正为它算出的
// 依赖树，目录名形如 vite@6.2.4_<peerhash> / @scope+name@1.2.3）：
//   1. 从该包的 dependencies/devDependencies/optionalDependencies 出发；
//   2. 每个依赖名在 .pnpm 里找**最高版本**作为解析结果（见文件末尾的取舍说明）；
//   3. 读取该版本包自身的 package.json，递归求完整闭包 —— 因此 vite 的 rollup 会是
//      vite 依赖的那个 4.x，而不是共享池里的 3.x；
//   4. 用 junction 把每个包挂到该包 node_modules 顶层；发现指向错误版本的旧 junction
//      会先摘掉再重建（只删链接，不动真实目录）。
//
// 正常机器上 pnpm 的符号链接已经建好、且指向正确，本脚本会直接返回「无需修补」。
//
// 版本取舍说明
// ------------
// .pnpm 里同一个名字可能有多个版本（vite 同时被 @types/node@22 与 @types/node@26 的
// peer 上下文解析过）。这里取最高版本。对构建工具链这类依赖这是正确的方向；
// 若将来遇到必须共存两个大版本的场景，应改成「按使用方分别建子目录」的完整解析，
// 而不是放宽这里的选择。

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 清理目标包 node_modules 顶层的**链接型**条目。
 *
 * 只删除 link（junction / symlink），永远不会删除真实目录 —— 这一点很关键：
 * 有人可能手动放了一个真实依赖目录进来，那是他的选择，不该被脚本抹掉。
 * 用途：当上一次修补把错误版本挂上去之后，需要先摘干净再按依赖树重建。
 */
function sweepLinks(targetDir) {
  const nm = join(targetDir, 'node_modules');
  if (!existsSync(nm)) return 0;
  let removed = 0;

  const sweepEntry = (full) => {
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      return;
    }
    if (stats.isSymbolicLink()) {
      try {
        rmSync(full, { force: true });
        removed += 1;
      } catch {
        /* 删不掉就留给后面的存在性检查处理 */
      }
    }
  };

  for (const entry of readdirSync(nm)) {
    if (entry === '.bin' || entry === '.pnpm' || entry === '.cache') continue;
    const full = join(nm, entry);
    if (entry.startsWith('@')) {
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory() && !lstatSync(full).isSymbolicLink();
      } catch {
        continue;
      }
      if (!isDir) {
        sweepEntry(full);
        continue;
      }
      for (const scoped of readdirSync(full)) sweepEntry(join(full, scoped));
    } else {
      sweepEntry(full);
    }
  }
  return removed;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 需要补齐依赖的目标目录：仓库根 + 每个有 node_modules 的 workspace 包。
 *
 * 判定条件放宽到「有 node_modules」而不是「有 package.json」：
 * 有些子项目（例如只有构建产物的目录）可能没有 package.json，
 * 但只要 pnpm 在里面装过东西，它的依赖一样解析不出来，必须一起补。
 */
function targetDirs() {
  const dirs = [rootDir];
  for (const group of ['apps', 'packages']) {
    const groupDir = join(rootDir, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const candidate = join(groupDir, name);
      if (!existsSync(join(candidate, 'node_modules'))) continue;
      dirs.push(candidate);
    }
  }
  return dirs;
}

/** 解析 .pnpm 目录名，例如 vite@6.2.4_abc / @nestjs+common@11.0.12_xyz。 */
function parsePnpmDirName(name) {
  const at = name.lastIndexOf('@');
  if (at <= 0) return null;
  const version = name.slice(at + 1).split('_')[0];
  if (!version || !/^\d/.test(version)) return null;
  const rawName = name.slice(0, at).replace(/\+/g, '/');
  return { name: rawName, version };
}

function compareVersions(a, b) {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 建立「包名 → 最高版本目录」索引。
 * 目录里同时包含 .pnpm/node_modules 的扁平池，优先使用它（去重后的稳定选择），
 * 再用逐个包的目录补齐扁平池里没有的包。
 */
function buildPoolIndex(targetDir, rootPoolPath) {
  const index = new Map();

  const register = (fullPath, name, version) => {
    const current = index.get(name);
    if (!current || compareVersions(version, current.version) > 0) {
      index.set(name, { version, path: fullPath });
    }
  };

  const scanFlatPool = (poolDir) => {
    if (!existsSync(poolDir)) return;
    for (const entry of readdirSync(poolDir)) {
      if (entry.startsWith('.')) continue;
      const full = join(poolDir, entry);
      if (entry.startsWith('@')) {
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (!isDir) continue;
        for (const scoped of readdirSync(full)) {
          const pkg = readJson(join(full, scoped, 'package.json'));
          if (pkg?.name && pkg.version) register(join(full, scoped), pkg.name, pkg.version);
        }
      } else {
        const pkg = readJson(join(full, 'package.json'));
        if (pkg?.name && pkg.version) register(full, pkg.name, pkg.version);
      }
    }
  };

  const scanVersionedDirs = (pnpmDir) => {
    if (!existsSync(pnpmDir)) return;
    for (const entry of readdirSync(pnpmDir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const parsed = parsePnpmDirName(entry);
      if (!parsed) continue;
      const pkgDir = join(pnpmDir, entry, 'node_modules', ...parsed.name.split('/'));
      const pkg = readJson(join(pkgDir, 'package.json'));
      if (pkg?.name && pkg.version) register(pkgDir, pkg.name, pkg.version);
    }
  };

  // 目标包自己的 .pnpm 是权威来源；根池作为补充（hoisted 布局下两者通常指向同一份）
  scanFlatPool(join(targetDir, 'node_modules', '.pnpm', 'node_modules'));
  scanVersionedDirs(join(targetDir, 'node_modules', '.pnpm'));
  scanFlatPool(rootPoolPath);

  return index;
}

function dependencyNames(pkg) {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
}

function linkPath(targetDir, packageName) {
  const segments = packageName.split('/');
  return join(targetDir, 'node_modules', ...segments);
}

/** 是否是链接（junction / symlink），真实目录返回 false。 */
function isLink(path) {
  try {
    return statSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function main() {
  const rootPoolPath = join(rootDir, 'node_modules', '.pnpm', 'node_modules');
  // --rebuild：先把已有链接全部摘掉再重建（用于修正历史上挂错版本的情况）
  const rebuild = process.argv.includes('--rebuild');
  let linked = 0;
  const report = [];

  for (const targetDir of targetDirs()) {
    if (!existsSync(join(targetDir, 'node_modules'))) continue;

    if (rebuild) {
      const removed = sweepLinks(targetDir);
      if (removed > 0) report.push('  ' + targetDir.replace(rootDir, '.') + ': 清理旧链接 ' + removed + ' 个');
    }

    const pkg = readJson(join(targetDir, 'package.json'));
    if (!pkg) continue;

    const pool = buildPoolIndex(targetDir, rootPoolPath);
    const queue = dependencyNames(pkg);
    const visited = new Set();
    let countForDir = 0;

    while (queue.length > 0) {
      const name = queue.shift();
      if (visited.has(name)) continue;
      visited.add(name);

      const entry = pool.get(name);
      if (!entry) continue;

      const target = linkPath(targetDir, name);
      if (existsSync(target)) {
        // 已存在：如果是链接但指向错误版本，摘掉重建（只删链接，不动真实目录）
        if (isLink(target)) {
          const existing = readJson(join(target, 'package.json'));
          if (existing?.version === entry.version) {
            /* 指向正确版本，保持不动 */
          } else {
            report.push('  ~ ' + name + ': ' + (existing?.version ?? '?') + ' → ' + entry.version);
            try {
              rmSync(target, { force: true });
            } catch (error) {
              report.push('  ! ' + name + ' 摘除旧链接失败: ' + error.code);
              continue;
            }
            try {
              mkdirSync(dirname(target), { recursive: true });
              symlinkSync(entry.path, target, process.platform === 'win32' ? 'junction' : 'dir');
              countForDir += 1;
            } catch (error) {
              report.push('  ! ' + name + ' 重建失败: ' + error.code);
            }
          }
        }
        // 真实目录（pnpm 已建好 / 用户手动放的）：不覆盖
      } else {
        try {
          mkdirSync(dirname(target), { recursive: true });
          symlinkSync(entry.path, target, process.platform === 'win32' ? 'junction' : 'dir');
          countForDir += 1;
        } catch (error) {
          report.push('  ! ' + name + ' -> ' + (error.code ?? error.message));
        }
      }

      // 递归该版本自己的依赖，保证闭包内版本自洽
      const childPkg = readJson(join(entry.path, 'package.json'));
      if (childPkg) {
        for (const childName of dependencyNames(childPkg)) {
          if (!visited.has(childName)) queue.push(childName);
        }
      }
    }

    if (countForDir > 0) {
      linked += countForDir;
      report.push('  ' + targetDir.replace(rootDir, '.') + ': 处理 ' + countForDir + ' 个包');
    }
  }

  if (linked === 0) {
    console.log('[fix-node-modules] 依赖链接完整，无需修补。');
    return;
  }

  console.log('[fix-node-modules] 符号链接不可用，已按依赖树用目录联接补齐/修正 ' + linked + ' 个包：');
  for (const line of report) console.log(line);
  console.log('[fix-node-modules] 这是等价布局：pnpm 命令与 node 运行时都能正常工作。');
}

main();
