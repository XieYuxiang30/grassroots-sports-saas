import type { UserConfigExport } from '@tarojs/cli';

export default {
  mini: {},
  h5: {
    /** 生产构建关闭 sourcemap，减小包体。 */
    enableSourceMap: false,
  },
} satisfies UserConfigExport<'webpack5'>;
