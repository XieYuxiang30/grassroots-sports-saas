import path from 'node:path';
import type { UserConfigExport } from '@tarojs/cli';

/** 后端默认地址；可用环境变量 TARO_APP_API_BASE_URL 覆盖（构建期注入）。 */
const DEFAULT_API_BASE_URL = 'http://localhost:3000';

const resolveApiBaseUrl = (): string => {
  const fromEnv = process.env.TARO_APP_API_BASE_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim().replace(/\/+$/, '');
  return DEFAULT_API_BASE_URL;
};

/**
 * 这里用 CommonJS（`module.exports`）而不是 `export default`：
 * Taro CLI 以 commonjs 方式 require 本文件，CommonJS 是唯一在所有构建路径下都通行的写法。
 */
const config = {
  projectName: 'openhoopscore-miniprogram',
  date: '2025-1-1',
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    375: 2,
    828: 1.81 / 2,
  },
  sourceRoot: 'src',
  outputRoot: 'dist',
  plugins: [],
  defineConstants: {
    /** 显式常量，方便非 Taro 运行环境（如单测）读取。Taro 也会自动注入 TARO_APP_* 环境变量。 */
    API_BASE_URL: JSON.stringify(resolveApiBaseUrl()),
  },
  alias: {
    '@': path.resolve(__dirname, '..', 'src'),
    /** 直接指向 contracts 的 TS 源码目录（其 index.ts 存在重名再导出、且 dist 未构建），
     *  小程序端统一通过 `src/contracts/index.ts` 按模块精确引用。 */
    '@openhoopscore/contracts': path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'packages',
      'contracts',
      'src',
    ),
  },
  copy: {
    patterns: [],
    options: {},
  },
  framework: 'react',
  compiler: 'webpack5',
  cache: {
    enable: false,
  },
  mini: {
    postcss: {
      pxtransform: {
        enable: true,
        config: {},
      },
      cssModules: {
        enable: false,
      },
    },
    webpackChain(chain: { merge: (value: Record<string, unknown>) => void }) {
      // socket.io-client / engine.io-client 会引用 node 内置模块与浏览器轮询实现，
      // 小程序端一律置空，强制走全局 WebSocket。
      chain.merge({
        resolve: {
          fallback: {
            http: false,
            https: false,
            url: false,
            zlib: false,
            fs: false,
            net: false,
            tls: false,
            crypto: false,
            stream: false,
            buffer: false,
            xmlhttprequest: false,
          },
        },
      });
    },
  },
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
    output: {
      filename: 'js/[name].[hash:8].js',
      chunkFilename: 'js/[name].[chunkhash:8].js',
    },
    miniCssExtractPluginOption: {
      ignoreOrder: true,
      filename: 'css/[name].[hash].css',
      chunkFilename: 'css/[name].[chunkhash].css',
    },
    postcss: {
      autoprefixer: {
        enable: true,
        config: {},
      },
      cssModules: {
        enable: false,
      },
    },
  },
} satisfies UserConfigExport<'webpack5'>;

export default config;

module.exports = config;
