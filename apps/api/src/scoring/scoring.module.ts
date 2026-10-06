import { Module } from '@nestjs/common';
import { MatchEngine } from './match-engine';
import { ScoringController } from './scoring.controller';
import { ScoringService } from './scoring.service';

/**
 * 计分模块：事件写入、撤销、投影、排行榜。
 *
 * `RealtimeModule` 是全局模块，所以这里不需要 import 它就能注入 RealtimeService；
 * 反向的依赖（实时模块要用计分服务）通过 RealtimeRegistry 端口注册解决，
 * 依赖方向始终是单向的，不会出现循环依赖。
 */
@Module({
  controllers: [ScoringController],
  providers: [ScoringService, MatchEngine],
  exports: [ScoringService, MatchEngine],
})
export class ScoringModule {}
