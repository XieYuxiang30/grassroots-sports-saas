import { Global, Module } from '@nestjs/common';
import { loadConfig, type AppConfig } from './app.config';
import { APP_CONFIG } from './config.tokens';

/**
 * 全局配置模块：一次性解析环境变量并注入 `APP_CONFIG`。
 * 用自定义 provider 而不是 @nestjs/config 的原因：我们需要**强类型**配置对象，
 * 且要在启动阶段就对错误配置（例如选了 prisma 却没给 DATABASE_URL）直接报错。
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
