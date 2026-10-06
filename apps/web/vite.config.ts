import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

/**
 * 前端构建配置。
 *
 * 几个关键点（都踩过坑，别随手改）：
 *
 * 1. **PWA**：计分端要在平板/手机上像 App 一样用，离线也要能打开。
 *    Service Worker 缓存外壳与静态资源，事件数据则存在 IndexedDB（见 src/offline）。
 *    注意接口与 Socket.IO 永远走网络（见下方 navigateFallbackDenylist），
 *    比分绝不能命中缓存。
 *
 * 2. **api / socket.io 代理**：开发时前端与后端分端口，用代理把两个前缀转过去，
 *    前端代码里就只需要写相对路径，与生产环境同源部署保持一致。
 *
 * 3. **base 设为 '/'**：分享链接形如 https://host/m/ABC123，需要 history 路由 + 服务端回落。
 *
 * 4. **依赖预构建（optimizeDeps）绝不能 exclude 浏览器要用的 CJS 包**。
 *    debug / socket.io-client / engine.io-client 这些是 CommonJS 模块，
 *    浏览器的 ESM 加载器看不懂 `module.exports`。一旦把某个包 exclude 掉，
 *    Vite 就不再把它转成 ESM，直接把源码丢给浏览器，于是白屏并报：
 *      Uncaught SyntaxError: The requested module '.../debug/src/browser.js'
 *      does not provide an export named 'default'
 *    正确做法是 **include + dedupe**：让 Vite 预构建成稳定的 ESM 副本，
 *    并保证整个依赖图只用同一份（见 resolve.dedupe 的说明）。
 */
export default defineConfig(({ mode }) => {
  const target = process.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001';
  const isProd = mode === 'production';

  return {
    base: '/',
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'robots.txt'],
        manifest: {
          name: '篮迹计分 · 基层赛事',
          short_name: '篮迹计分',
          description: '基层赛事实时计分与观赛平台：计分员离线也能记，观众扫码就能看',
          theme_color: '#0B1220',
          background_color: '#0B1220',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          lang: 'zh-CN',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
          navigateFallback: '/index.html',
          // 接口与实时通道永远走网络，绝不能命中缓存（比分必须是实时的）
          navigateFallbackDenylist: [/^\/api/, /^\/socket\.io/, /^\/docs/],
          runtimeCaching: [{ urlPattern: /^\/api\//, handler: 'NetworkOnly' }],
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      // 用 import.meta.url 定位源码目录，而不是 process.cwd()：
      // 从仓库根或任意目录启动 dev server 时别名都必须指向同一个 src。
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
      /**
       * 把 debug 去重到单一副本 —— 这是本仓库必须显式处理的一处。
       *
       * debug 是 CommonJS（`module.exports = debug`，没有 default 导出），
       * 而本 monorepo 里同时存在 2.6.9 / 4.3.6 / 4.3.7 / 4.4.3 多份：
       * express 要 4.3.6、socket.io-client 要 ~4.3.2、vite 自己要 ^4.4.0。
       * 不去重时，Vite 可能把「A 副本的 browser.js」与「B 副本的导出形状」拼在一起，
       * 浏览器侧就报 `does not provide an export named 'default'`。
       * 去重后所有引用都落到 apps/web/node_modules/debug（package.json 已固定 4.4.3，
       * 与 vite 自身依赖范围一致），预构建只产出一份，问题消失。
       */
      dedupe: ['debug', 'react', 'react-dom', 'socket.io-client'],
    },
    server: {
      port: 5176,
      strictPort: false,
      proxy: {
        '/api': { target, changeOrigin: true },
        '/socket.io': { target, changeOrigin: true, ws: true },
      },
    },
    optimizeDeps: {
      // 显式声明：浏览器要用的依赖全部交给 Vite 预构建成 ESM。
      // 这里只 include、绝不 exclude（原因见文件头第 4 条）。
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react-router-dom',
        'socket.io-client',
        'engine.io-client',
        'qrcode',
        'debug',
      ],
      esbuildOptions: {
        /**
         * 必须显式指定 target: 'esnext'。
         *
         * Vite 默认会把依赖预构建的 target 设成
         * `['es2020','edge88','firefox78','chrome87','safari14']`，而 esbuild
         * **不支持**为了兼容这些较老环境而把解构语法降级，于是整个预构建直接失败：
         *
         *   ERROR: Transforming destructuring to the configured target environment
         *          ("chrome87","edge88","es2020","firefox78","safari14") is not supported yet
         *     node_modules/debug/src/browser.js:260:6
         *       const { formatters } = module.exports;
         *             ^
         *   Error: Build failed with 147 errors
         *
         * 一旦预构建失败，`optimized` 就是空的，浏览器请求每个依赖都得到
         * 504 (Outdated Optimize Dep)，页面白屏。
         *
         * 设为 esnext 的代价：预构建产物不做语法降级，因此要求浏览器本身支持
         * 现代语法。本项目的使用场景是近几年的平板/手机（微信内置浏览器、
         * iOS Safari 15+、Android Chrome 100+），这个要求完全满足；
         * 换来的是依赖预构建稳定可用。若将来要支持很老的设备，
         * 应改用 @vitejs/plugin-legacy，而不是在这里压低 target。
         */
        target: 'esnext',
        // debug 的浏览器实现会读 process.env.DEBUG / NODE_ENV，
        // 浏览器里没有 process 对象，必须替换掉，否则直接 ReferenceError。
        define: {
          'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
          'process.env.DEBUG': 'undefined',
        },
      },
    },
    define: {
      // 少数依赖（例如 socket.io 的部分分支）会直接引用 process.env.NODE_ENV
      'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
    },
    build: {
      outDir: 'dist',
      sourcemap: !isProd,
      chunkSizeWarningLimit: 900,
      // 与预构建保持一致：交给目标浏览器自己处理现代语法。
      // 若需兼容老设备，请引入 @vitejs/plugin-legacy 并为它单独配置 target。
      target: 'esnext',
    },
  };
});
