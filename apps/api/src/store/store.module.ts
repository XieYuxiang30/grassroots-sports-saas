import { Global, Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.tokens';
import { JsonFileStore } from './json-file.store';
import { MemoryStore } from './memory.store';
import { PrismaStore } from './prisma.store';
import type { StorePort } from './store.port';

export const STORE = 'STORE_PORT';

/**
 * 存储模块：按 `STORAGE_DRIVER` 选择驱动。
 *
 * - `json`（默认）：零基础设施，落盘到 `DATA_DIR/hoop-store.json`，开箱即用；
 * - `prisma`：PostgreSQL + Prisma，正式环境推荐（迁移脚本见 prisma/migrations）；
 * - `memory`：仅测试使用，进程退出即清空。
 */
@Global()
@Module({
  providers: [
    {
      provide: STORE,
      inject: [APP_CONFIG],
      useFactory: async (config: AppConfig): Promise<StorePort> => {
        const logger = new Logger('StoreModule');
        let store: StorePort;

        switch (config.storageDriver) {
          case 'prisma':
            store = new PrismaStore();
            break;
          case 'memory':
            store = new MemoryStore();
            break;
          default:
            store = new JsonFileStore(config.dataDir);
            break;
        }

        await store.init();
        if (store instanceof JsonFileStore) {
          logger.log(`存储驱动：json（数据文件 ${store.location}）`);
        } else {
          logger.log(`存储驱动：${store.driver}`);
        }
        return store;
      },
    },
  ],
  exports: [STORE],
})
export class StoreModule {}
