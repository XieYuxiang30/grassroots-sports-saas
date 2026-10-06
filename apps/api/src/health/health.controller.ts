import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { HealthResponse } from '@openhoopscore/contracts';
import { APP_CONFIG, PROJECTION_VERSION, SERVICE_VERSION, type AppConfig } from '../config/config.tokens';
import { STORE } from '../store/store.module';
import type { StorePort } from '../store/store.port';

/** 存活探针 + 部署自检：一眼看出「引擎跑的是什么驱动、投影内核是哪个版本」。 */
@ApiTags('系统')
@Controller()
export class HealthController {
  constructor(
    @Inject(STORE) private readonly store: StorePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('health')
  @ApiOperation({ summary: '健康检查（含存储驱动与投影内核版本，多端排查不一致时用）' })
  health(): HealthResponse {
    return {
      status: 'ok',
      service: 'openhoopscore-api',
      version: SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      storageDriver: this.store.driver,
      serverTime: new Date().toISOString(),
      projectionVersion: PROJECTION_VERSION,
    };
  }

  @Get('config/public')
  @ApiOperation({ summary: '前端启动配置（不含任何密钥）' })
  publicConfig() {
    return {
      projectionVersion: PROJECTION_VERSION,
      storageDriver: this.store.driver,
      socketPath: '/socket.io',
      realtimeNamespace: '/',
      maxSyncBatch: this.config.maxSyncBatch,
      maxEventsPerMatch: this.config.maxEventsPerMatch,
      // 只暴露「口令是否还是默认值」，绝不返回口令本身
      scorerPasscodeIsDefault: this.config.scorerPasscode === 'hoop2024',
    };
  }
}
