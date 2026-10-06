import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { GameEventDraft, SubmitEventsResult, UndoResult } from '@openhoopscore/contracts';
import { RealtimeService } from '../realtime/realtime.service';
import { ScoringService } from './scoring.service';
import { FinishMatchDto, LeaderboardQueryDto, PreviewComputeDto, ReconcileDto, SetClockDto, SubmitEventsDto, UndoDto } from '../matches/matches.dto';

/**
 * 计分与观赛接口。
 *
 * 两条等价链路（都在这里收口到 ScoringService）：
 *   - REST：计分端离线时用 `POST /api/matches/:id/events` 批量补传；
 *     观众端首屏用 `GET .../live` 一次性拿全量。
 *   - Socket.IO：在线时用 `scoring:submit` 低延迟提交，服务端立即广播。
 */
@ApiTags('计分与观赛')
@Controller('matches/:id')
export class ScoringController {
  constructor(
    private readonly scoring: ScoringService,
    private readonly realtime: RealtimeService,
  ) {}

  @Get('live')
  @ApiOperation({ summary: '比赛实时状态（比分 + 图文直播 + 撤销栈），观众端首屏用' })
  async live(@Param('id') id: string, @Query('feedLimit') feedLimit?: string) {
    const limit = feedLimit ? Math.min(Math.max(Number.parseInt(feedLimit, 10) || 200, 1), 500) : 200;
    return this.scoring.getLive(id, { feedLimit: limit });
  }

  @Get('scoreboard')
  @ApiOperation({ summary: '只要比分牌（大屏轮询兜底）' })
  async scoreboard(@Param('id') id: string) {
    return this.scoring.getScoreboard(id);
  }

  @Get('state')
  @ApiOperation({ summary: '完整比赛状态（含球员统计）' })
  async state(@Param('id') id: string) {
    return this.scoring.getState(id);
  }

  @Get('leaderboard')
  @ApiOperation({ summary: '球员得分榜' })
  async leaderboard(@Param('id') id: string, @Query() query: LeaderboardQueryDto) {
    return this.scoring.getLeaderboard(id, query.sortedBy ?? 'points');
  }

  @Get('events')
  @ApiOperation({ summary: '增量拉取事件（断线重连 / 直播回放）' })
  async events(@Param('id') id: string, @Query('sinceSeq') sinceSeq?: string, @Query('limit') limit?: string) {
    return this.scoring.getEvents(
      id,
      sinceSeq ? Math.max(0, Number.parseInt(sinceSeq, 10) || 0) : 0,
      limit ? Math.min(Math.max(Number.parseInt(limit, 10) || 1000, 1), 5000) : 1000,
    );
  }

  @Post('events')
  @ApiOperation({ summary: '提交事件（在线实时 + 离线批补传共用；服务端幂等去重 + 重排）' })
  async submitEvents(
    @Param('id') id: string,
    @Body() dto: SubmitEventsDto,
    @Headers('x-scorer-passcode') passcodeHeader?: string,
  ): Promise<SubmitEventsResult> {
    const outcome = await this.scoring.submitEvents({
      ...dto,
      matchId: id,
      passcode: dto.passcode ?? passcodeHeader,
      events: dto.events as unknown as GameEventDraft[],
    });
    // REST 写入同样要广播：否则电视上的大屏会停在这一刻
    await this.realtime.publishSubmit(outcome);
    return outcome.result;
  }

  @Post('undo')
  @ApiOperation({ summary: '撤销（不删历史：追加 void 事件，比分自动回退）' })
  async undo(
    @Param('id') id: string,
    @Body() dto: UndoDto,
    @Headers('x-scorer-passcode') passcodeHeader?: string,
  ): Promise<UndoResult> {
    const outcome = await this.scoring.undo({
      matchId: id,
      clientId: dto.clientId,
      passcode: dto.passcode ?? passcodeHeader,
      targetEventId: dto.targetEventId,
      steps: dto.steps,
    });
    await this.realtime.publishUndo(outcome);
    return outcome.result;
  }

  @Post('clock')
  @ApiOperation({ summary: '设置节次 / 比赛时钟（仅节次变化会写入事件）' })
  async setClock(
    @Param('id') id: string,
    @Body() dto: SetClockDto,
    @Headers('x-scorer-passcode') passcodeHeader?: string,
  ) {
    const outcome = await this.scoring.setClock({
      matchId: id,
      clientId: dto.clientId,
      passcode: dto.passcode ?? passcodeHeader,
      period: dto.period,
      gameClockSeconds: dto.gameClockSeconds,
      running: dto.running,
    });
    await this.realtime.publishStatePatch(id, outcome.state, 'clock');
    return { state: outcome.state };
  }

  @Post('finish')
  @ApiOperation({ summary: '结束比赛' })
  async finish(
    @Param('id') id: string,
    @Body() dto: FinishMatchDto,
    @Headers('x-scorer-passcode') passcodeHeader?: string,
  ) {
    const outcome = await this.scoring.finishMatch({
      matchId: id,
      clientId: dto.clientId,
      passcode: dto.passcode ?? passcodeHeader,
      reason: dto.reason,
    });
    await this.realtime.publishFinished(id, outcome.state, dto.reason ?? 'normal');
    return { state: outcome.state };
  }

  @Post('preview')
  @ApiOperation({ summary: '无副作用试算：校验计分端本地投影与服务端是否一致' })
  async preview(@Param('id') id: string, @Body() dto: PreviewComputeDto) {
    return this.scoring.previewCompute({ matchId: id, events: dto.events as unknown as GameEventDraft[] });
  }

  @Post('reconcile')
  @ApiOperation({ summary: '本地队列对账：哪些离线事件服务端其实已经收到' })
  async reconcile(@Param('id') id: string, @Body() dto: ReconcileDto) {
    return this.scoring.reconcile(id, dto.clientEventIds);
  }
}
