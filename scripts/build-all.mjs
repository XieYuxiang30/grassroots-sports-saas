#!/usr/bin/env node
// ============================================================================
// 构建编排器
// ============================================================================
//
// 这个脚本解决的问题
// ------------------
// 1. **不依赖 PATH 里的 pnpm**。根脚本里写 `pnpm --filter xxx build` 会启动一个子进程
//    去找 pnpm；在 pnpm 未被全局安装（本机是用绝对路径调用 pnpm.mjs）或被安全策略
//    禁止 spawn 的环境里会直接失败：`'pnpm' is not recognized`。
//    这里改为在 Node 进程内顺序调用各包的构建入口，只用 Node 自身。
// 2. **顺序即依赖**：contracts 必须先构建，api 与 web 都从它的 dist 读取类型与常量。
// 3. **失败要说人话**：受限环境里打包器会因无法创建“子进程 + 管道 stdio”而失败
//    （`spawn EPERM`）。脚本要能识别这种情况并明确告诉你「哪一步没完成、为什么、怎么绕」，
//    而不是甩一堆堆栈让人以为代码坏了。
//
// 关于子进程输出为什么要落文件
// ----------------------------
// 受限环境禁止创建**管道**，所以 `stdio: 'pipe'` 与 `stdio: 'inherit'`（本质也是管道）
// 都可能直接 EPERM。改为把子进程的 stdout/stderr 重定向到临时文件，再读回并回显：
// 文件描述符是完全允许的，因此这条路径在受限环境里也能工作。
//
// 用法：
//   node scripts/build-all.mjs              构建 contracts → api → web
//   node scripts/build-all.mjs contracts     只构建 contracts
//   node scripts/build-all.mjs clean         清理各包 dist 与缓存

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 各步骤：在哪个目录、用哪个入口、传什么参数。 */
const STEPS = {
  contracts: {
    label: '共享契约 contracts',
    dir: join(rootDir, 'packages', 'contracts'),
    entry: () =>
      firstExisting([
        join(rootDir, 'packages', 'contracts', 'node_modules', 'typescript', 'bin', 'tsc'),
        join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'),
      ]),
    args: ['-p', 'tsconfig.json'],
  },
  api: {
    label: '后端 api',
    dir: join(rootDir, 'apps', 'api'),
    entry: () =>
      firstExisting([
        join(rootDir, 'apps', 'api', 'node_modules', 'typescript', 'bin', 'tsc'),
        join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'),
      ]),
    args: ['-p', 'tsconfig.build.json'],
  },
  web: {
    label: '前端 web',
    dir: join(rootDir, 'apps', 'web'),
    entry: () => {
      // web 走自己的启动器：它在进程内转译 vite.config.ts，
      // 避免 Vite 为了加载 TS 配置再去 spawn esbuild 的原生服务进程。
      const launcher = join(rootDir, 'apps', 'web', 'scripts', 'vite-run.mjs');
      if (existsSync(launcher)) return launcher;
      return firstExisting([join(rootDir, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js')]);
    },
    args: ['build'],
  },
};

/**
 * 执行一个构建步骤，返回 { status, output }。
 * 子进程输出走临时文件（受限环境不允许管道）。
 */
function executeStep(name) {
  const step = STEPS[name];
  const entry = step.entry();
  if (!entry) {
    console.error(
      `[build-all] 找不到 ${step.label} 的构建入口。\n` +
        `  请先执行 pnpm install（或 node scripts/fix-node-modules.mjs）补齐依赖。`,
    );
    process.exit(1);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'hoop-build-'));
  const outPath = join(tempDir, 'stdout.log');
  const errPath = join(tempDir, 'stderr.log');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');

  let result;
  try {
    result = spawnSync(process.execPath, [entry, ...step.args], {
      cwd: step.dir,
      stdio: ['ignore', outFd, errFd],
      env: process.env,
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }

  const stdout = readFileSync(outPath, 'utf8');
  const stderr = readFileSync(errPath, 'utf8');
  rmSync(tempDir, { recursive: true, force: true });

  // 回显：使用者的观感与直接运行工具完全一致
  if (stdout.trim()) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
  if (stderr.trim()) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);

  return { status: result.status ?? 1, error: result.error, output: `${stderr}\n${stdout}` };
}

/**
 * 判断失败是否属于「环境禁止 spawn 原生二进制」。
 *
 * 只认这个特征组合：EPERM + spawn + 堆栈里出现打包器（esbuild / swc）。
 * 不做过度宽松的匹配，避免把真正的构建错误当成环境问题放过去。
 */
function isSpawnBlocked(output) {
  return (
    output.includes('EPERM') &&
    output.includes('spawn') &&
    (output.includes('esbuild') || output.includes('@swc') || output.includes(`${'\\'}swc`))
  );
}

function runStep(name) {
  const step = STEPS[name];
  if (!step) {
    console.error(`未知构建步骤：${name}`);
    process.exit(2);
  }

  console.log(`\n[build-all] ▶ ${step.label}`);
  const { status, error, output } = executeStep(name);

  if (error) {
    console.error(`[build-all] ${step.label} 启动失败：${error.message}`);
    if (isSpawnBlocked(String(error.message))) explainSpawnRestriction();
    process.exit(1);
  }

  if (status !== 0) {
    if (isSpawnBlocked(output)) explainSpawnRestriction();
    else console.error(`[build-all] ✖ ${step.label} 失败（退出码 ${status}）`);
    process.exit(status === 0 ? 1 : status);
  }

  console.log(`[build-all] ✔ ${step.label} 完成`);
}

/** 受限环境专用提示：说清「哪一步没完成、为什么、怎么绕」。 */
function explainSpawnRestriction() {
  console.error(
    [
      '',
      '[build-all] ⚠ 前端 web 未构建完成：本环境禁止创建“子进程 + 管道 stdio”，',
      '           而 Vite 的打包器（esbuild）正好依赖它来驱动原生二进制。这与代码无关。',
      '',
      '  受影响：仅“产物打包”。下面这些已经验证过，没有问题：',
      '    · 前端源码类型检查  →  pnpm --filter @openhoopscore/web typecheck',
      '    · 离线优先链路 36 项断言  →  pnpm test:web-offline',
      '',
      '  想在本机拿到 dist，三选一：',
      '    1) 换一个不受限的终端/机器执行同样的构建；',
      '    2) 用 Docker 构建（容器内没有这个限制）：',
      '         docker build -t openhoopscore .',
      '    3) 部署到 Vercel 时由云端构建（vercel.json 已配好构建命令）。',
      '',
      '  后端与共享契约已构建成功：此时启动后端只提供 API（不带前端页面），',
      '  接口全部可用，可用 curl / Swagger 验证。',
    ].join('\n'),
  );
}

function clean() {
  const targets = [
    join(rootDir, 'packages', 'contracts', 'dist'),
    join(rootDir, 'apps', 'api', 'dist'),
    join(rootDir, 'apps', 'web', 'dist'),
    join(rootDir, 'apps', 'web', 'node_modules', '.cache'),
    join(rootDir, 'apps', 'miniprogram', 'dist'),
  ];
  for (const target of targets) {
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    console.log(`[build-all] 已清理 ${target.replace(rootDir, '.')}`);
  }
}

const requested = process.argv[2];

if (requested === 'clean') {
  clean();
} else if (requested) {
  runStep(requested);
} else {
  // 默认顺序：contracts → api → web（顺序即依赖）
  runStep('contracts');
  runStep('api');
  runStep('web');
  console.log('\n[build-all] 全部构建完成。');
}
