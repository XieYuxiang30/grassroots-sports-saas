#!/usr/bin/env node
// ============================================================================
// 构建 / 预览 / 开发服务器启动器（进程内转译 vite.config.ts）
// ============================================================================
//
// 为什么不直接 `vite build`
// ------------------------
// Vite 加载 vite.config.ts 时会用 esbuild 的 Go 二进制把配置打包成临时文件，
// 而 esbuild 的 JS API 是通过**子进程 + 管道 stdio** 与那个二进制通信的。
// 在受限环境（部分沙箱、企业策略、被禁止创建管道句柄的容器）里，这个 spawn 会
// 直接 EPERM 失败，报错信息是 `Error: spawn EPERM`，看起来像配置语法错误，很容易误判。
//
// 这个脚本的做法
// --------------
// 用 esbuild 的**进程内** transformSync（纯 JS 调用，不 spawn）把
// vite.config.ts 转成 CommonJS，落一个临时文件，再 require 它拿到配置对象，
// 最后直接调用 Vite 的编程式 API。这样 Vite 全程不需要再解析 TS 配置。
//
// 用法：
//   node scripts/vite-run.mjs build          生产构建
//   node scripts/vite-run.mjs dev            开发服务器
//   node scripts/vite-run.mjs preview        预览构建产物

import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadConfig(mode, command = 'build') {
  // 用包内的 typescript：它没有任何原生依赖，进程内即可完成 TS → CJS。
  // 刻意**不用 esbuild** —— esbuild 在 require 阶段就会 spawn 原生服务进程，
  // 在禁止创建管道的环境里直接 EPERM，导致连配置文件都读不到。
  const ts = require('typescript');
  const configPath = join(webRoot, 'vite.config.ts');
  const source = readFileSync(configPath, 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2021,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
    },
    fileName: configPath,
  });

  // CJS 里不能出现 import.meta（会直接 SyntaxError: Cannot use 'import.meta' outside a module）。
  // 配置里用它只是为了定位项目根目录（`new URL('./src', import.meta.url)`），
  // 所以替换成**配置文件自身的 file:// URL** —— 语义完全等价，且路径正确。
  const selfUrlLiteral = JSON.stringify(pathToFileURL(configPath).href);
  const code = result.outputText.replace(/import\.meta\.url/g, selfUrlLiteral);

  // 临时文件必须留在 apps/web 目录内：
  // 它 require 的是配置里 import 的包（vite / @vitejs/plugin-react / vite-plugin-pwa），
  // 放到系统临时目录会让 Node 的模块解析找不到这些包，报 Cannot find module 'vite'。
  const tempDir = mkdtempSync(join(webRoot, 'node_modules', '.vite-config-'));
  const tempFile = join(tempDir, 'vite.config.generated.cjs');
  writeFileSync(tempFile, code, 'utf8');

  try {
    const loaded = require(tempFile);
    const factory = loaded.default ?? loaded;
    // Vite 的 defineConfig 可能是函数（接收 { mode, command }）或对象
    return typeof factory === 'function' ? await factory({ mode, command }) : factory;
  } finally {
    if (process.env.DEBUG_VITE_CONFIG) {
      console.log('[vite-run] 保留临时配置文件:', tempFile);
    } else {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* 忽略清理失败 */
      }
    }
  }
}

/**
 * 解析命令行：第一个参数是命令（dev / build / preview），其余原样转发给 Vite。
 *
 * 为什么要转发：`--force`（忽略缓存重新预构建）、`--debug`（打印依赖优化细节）
 * 这类排查参数非常有用，如果被启动器吞掉，使用者就失去了排查手段。
 * 例如：
 *   node scripts/vite-run.mjs dev --force --debug
 */
function parseArgs(argv) {
  const known = new Set(['dev', 'build', 'preview']);
  const [first, ...rest] = argv;
  const command = known.has(first) ? first : 'dev';
  const raw = known.has(first) ? rest : argv;
  // 过滤掉 pnpm/npm 用来分隔参数的字面量 "--"：
  // `pnpm ... dev -- --force` 会把 "--" 本身也传进来，Vite 收到它会当成位置参数报错。
  const passthrough = raw.filter((arg) => arg !== '--');
  return { command, passthrough };
}

async function main() {
  const { command, passthrough } = parseArgs(process.argv.slice(2));
  const mode = process.env.NODE_ENV ?? (command === 'build' ? 'production' : 'development');
  const inlineConfig = await loadConfig(mode, command === 'dev' ? 'serve' : command);

  const hasForce = passthrough.includes('--force') || passthrough.includes('-f');
  console.log(
    `[vite-run] 命令=${command} 模式=${mode}${passthrough.length ? ` 透传参数=${passthrough.join(' ')}` : ''}` +
      `${command === 'dev' && !hasForce ? '  （依赖若异常可加 --force 重新预构建）' : ''}`,
  );

  const vite = await import('vite');

  if (command === 'dev') {
    const server = await vite.createServer({
      ...inlineConfig,
      mode,
      configFile: false,
      // --force 对应 Vite 的 optimizeDeps.force：忽略缓存重新预构建
      ...(hasForce ? { optimizeDeps: { ...(inlineConfig.optimizeDeps ?? {}), force: true } } : {}),
    });
    await server.listen();
    server.printUrls();

    // 关键：必须持有 server 引用并把进程挂到信号上。
    // 否则在被后台拉起 / 标准输入是管道的情况下，Node 可能判定事件循环为空，
    // 打印完地址就立刻退出 —— 表现为「命令返回 0，但端口上什么都没有」。
    const keepAlive = setInterval(() => {}, 1 << 30);

    const shutdown = async (signal) => {
      console.log(`\n[vite-run] 收到 ${signal}，正在关闭开发服务器…`);
      clearInterval(keepAlive);
      try {
        await server.close();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    console.log('[vite-run] 开发服务器已就绪（Ctrl+C 退出）');
    return;
  }

  if (command === 'preview') {
    const server = await vite.preview({ ...inlineConfig, mode, configFile: false });
    server.printUrls();
    // preview 同样需要保活
    setInterval(() => {}, 1 << 30);
    return;
  }

  const result = await vite.build({ ...inlineConfig, mode, configFile: false });

  // 打印产物摘要，构建日志一眼能看出「到底生成了什么」
  const bundles = Array.isArray(result) ? result.flatMap((item) => item.output ?? []) : (result.output ?? []);
  const rows = bundles
    .filter((item) => item.type === 'chunk' || item.type === 'asset')
    .map((item) => ({
      name: item.fileName,
      size: item.type === 'chunk' ? Buffer.byteLength(item.code, 'utf8') : (item.source?.length ?? 0),
    }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 12);

  console.log('\n构建完成，主要产物：');
  for (const row of rows) {
    console.log(`  ${(row.size / 1024).toFixed(1).padStart(8)} KB  ${row.name}`);
  }
}

main().catch((error) => {
  const text = `${error?.stack ?? ''}\n${error?.message ?? ''}`;

  // 这个环境的典型症状：禁止创建「子进程 + 管道 stdio」，而 esbuild 正是靠它驱动原生二进制。
  // 明确说清「不是代码问题、该怎么办」，而不是丢一段堆栈让人去猜。
  if (text.includes('EPERM') && text.includes('spawn')) {
    console.error(
      [
        '',
        '──────────────────────────────────────────────────────────────────────',
        '[vite-run] 无法启动：当前终端禁止创建“子进程 + 管道 stdio”。',
        '',
        '  Vite 的依赖预构建 / TS 转译 / 生产打包都依赖 esbuild，',
        '  而 esbuild 通过子进程管道与它的原生二进制通信；受限环境（沙箱、',
        '  企业安全策略、部分容器）会直接拒绝该操作，报错就是上面的 spawn EPERM。',
        '',
        '  这与本项目代码无关。请换一个普通终端执行：',
        '',
        '      pnpm --filter @openhoopscore/web dev        # 开发服务器',
        '      pnpm --filter @openhoopscore/web build      # 生产构建',
        '',
        '  或者用 Docker 构建（容器内没有这个限制）：',
        '',
        '      docker build -t openhoopscore .',
        '',
        '  在当前受限环境里，仍然可以验证前端逻辑（不需要打包器）：',
        '',
        '      pnpm --filter @openhoopscore/web typecheck   # 类型检查',
        '      pnpm test:web-offline                        # 离线链路 36 项断言',
        '──────────────────────────────────────────────────────────────────────',
      ].join('\n'),
    );
    process.exit(2);
  }

  console.error('[vite-run] 失败：', error);
  process.exit(1);
});
