import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MatchDetail, Season } from '@openhoopscore/contracts';
import {
  AddPlayerDto,
  CreateMatchDto,
  CreateSeasonDto,
  ListMatchesQueryDto,
  UpdateMatchDto,
} from './matches.dto';
import { MatchesService } from './matches.service';

/**
 * 赛事管理后台接口（Admin）。
 * 计分端与观众端通过 Socket.IO 实时拿比分，这里主要解决「赛前准备」。
 */
@ApiTags('赛事管理')
@Controller()
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  // ------------------------------------------------------------------ 赛季

  @Post('seasons')
  @ApiOperation({ summary: '创建赛季/赛事' })
  async createSeason(@Body() dto: CreateSeasonDto): Promise<Season> {
    return this.matches.createSeason(dto);
  }

  @Get('seasons')
  @ApiOperation({ summary: '赛季列表（含比赛数）' })
  async listSeasons() {
    return { items: await this.matches.listSeasons() };
  }

  // ------------------------------------------------------------------ 比赛

  @Post('matches')
  @ApiOperation({ summary: '创建比赛（同时录入两队球员名单，自动生成分享码）' })
  async createMatch(@Body() dto: CreateMatchDto): Promise<MatchDetail> {
    return this.matches.createMatch(dto);
  }

  @Get('matches')
  @ApiOperation({ summary: '比赛列表（比分由事件流实时投影）' })
  async listMatches(@Query() query: ListMatchesQueryDto) {
    return this.matches.listMatches(query);
  }

  /**
   * 扫码进房入口。
   * 必须放在 `matches/:id` 之前，否则 `by-code` 会被当成 id 匹配掉。
   */
  @Get('matches/by-code/:code')
  @ApiOperation({ summary: '按分享码查询比赛（观众扫码进房）' })
  async getByShareCode(@Param('code') code: string): Promise<MatchDetail> {
    return this.matches.getMatchByShareCode(code);
  }

  @Get('matches/:id')
  @ApiOperation({ summary: '比赛详情（含两队球员名单）' })
  async getMatch(@Param('id') id: string): Promise<MatchDetail> {
    return this.matches.getMatchDetail(id);
  }

  @Patch('matches/:id')
  @ApiOperation({ summary: '修改比赛信息（含状态）' })
  async updateMatch(@Param('id') id: string, @Body() dto: UpdateMatchDto): Promise<MatchDetail> {
    return this.matches.updateMatch(id, dto);
  }

  @Post('matches/:id/archive')
  @ApiOperation({ summary: '归档比赛（只改状态，事件流完整保留，随时可回放复盘）' })
  async archiveMatch(@Param('id') id: string): Promise<MatchDetail> {
    return this.matches.archiveMatch(id);
  }

  // ------------------------------------------------------------------ 球员

  @Post('matches/:id/players')
  @ApiOperation({ summary: '为某队补录球员' })
  async addPlayer(@Param('id') id: string, @Body() dto: AddPlayerDto) {
    return this.matches.addPlayer(id, dto);
  }

  @Delete('matches/:id/players/:playerId')
  @ApiOperation({ summary: '删除球员（赛前准备阶段使用）' })
  async deletePlayer(@Param('id') id: string, @Param('playerId') playerId: string) {
    return this.matches.deletePlayer(id, playerId);
  }

  // ------------------------------------------------------------------ 运维

  @Get('admin/stats')
  @ApiOperation({ summary: '存储规模统计（运维排查用）' })
  async stats() {
    return this.matches.storeStats();
  }
}
