import { Global, Module } from '@nestjs/common';
import { RealtimeController } from './realtime.controller';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * 实时模块（全局）。
 *
 * 依赖方向是单向的：
 *   业务模块（Scoring / Matches）→ RealtimeService   —— 直接依赖，用来广播
 *   RealtimeService → 业务模块                        —— 通过 RealtimeRegistry 端口，
 *                                                        在各自 onModuleInit 时注册进来
 * 这样既能让 REST 写入也走同一套广播，又不会产生循环依赖。
 */
@Global()
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
