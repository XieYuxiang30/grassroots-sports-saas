import { Global, Module } from '@nestjs/common';
import { MatchesController } from './matches.controller';
import { MatchesService } from './matches.service';
import { ScoringModule } from '../scoring/scoring.module';

/** 赛事管理模块：Admin 后台的赛季 / 比赛 / 球员维护。 */
@Global()
@Module({
  imports: [ScoringModule],
  controllers: [MatchesController],
  providers: [MatchesService],
  exports: [MatchesService],
})
export class MatchesModule {}
