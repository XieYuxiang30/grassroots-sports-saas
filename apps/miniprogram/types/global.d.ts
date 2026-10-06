/// <reference types="@tarojs/taro" />

/**
 * Taro 全局构建期常量。
 * - API_BASE_URL: config/index.ts 的 defineConstants 注入的后端地址
 * - process.env.TARO_APP_*: Taro 注入的 TARO_APP_ 前缀环境变量
 */
declare const API_BASE_URL: string | undefined;

declare namespace NodeJS {
  interface ProcessEnv {
    TARO_ENV: 'weapp' | 'swan' | 'alipay' | 'h5' | 'rn' | 'tt' | 'qq' | 'jd' | 'harmony' | 'jdrn';
    NODE_ENV: 'development' | 'production';
    TARO_APP_API_BASE_URL?: string;
    /** Taro 是 vue3 时才有；这里保留防止第三方类型冲突。 */
    TARO_APP_ID?: string;
  }
}

/** 允许在 TS 中 import css 文件。 */
declare module '*.css';
declare module '*.scss';
declare module '*.less';
declare module '*.png';
declare module '*.jpg';
declare module '*.svg';
