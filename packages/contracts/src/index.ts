/**
 * 共享领域模型与实时协议。
 *
 * 这个包是整个平台唯一的「契约」来源：
 *   - 后端（apps/api）用它校验事件、计算比分；
 *   - 计分端 PWA 与观众端 H5 用它做类型安全的读写；
 *   - 小程序端（apps/miniprogram）通过同一个协议接入。
 *
 * 设计原则：**只存事件，不存结果**（Event Sourcing）。
 * 当前比分永远是事件的投影，因此可以回放、可以撤销、可以离线补传后重排。
 */

export * from './ids';
export * from './events';
export * from './state';
export * from './api';
export * from './realtime';
export * from './clock';
export * from './score';
