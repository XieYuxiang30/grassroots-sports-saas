import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { MatchDetail, MatchSummary, Season, TeamSide } from '@openhoopscore/contracts';
import { APP_CONFIG, type AppConfig } from '../config/config.tokens';
import { DomainError } from '../common/domain-error';
import { generateShareCode, normalizeShareCode } from '../common/share-code';
import { STORE } from '../store/store.module';
import type { CreateMatchRecord, MatchAggregate, StorePort } from '../store/store.port';
import type { AddPlayerDto, CreateMatchDto, CreateSeasonDto, ListMatchesQueryDto, UpdateMatchDto } from './matches.dto';
import { MatchEngine } from '../scoring/match-engine';
import { RealtimeRegistry } from '../realtime/realtime.ports';

/**
 * 赛事管理服务（Admin 后台的业务层）：
 *   - 创建赛季 / 比赛，录入两队球员名单；
 *   - 生成唯一的扫码进房分享码；
 *   - 列表页需要的「当前比分」由事件流实时投影出来，不存在比赛表里。
 */
@Injectable()
export class MatchesService implements OnModuleInit {
  private readonly logger = new Logger(MatchesService.name);

  constructor(
    @Inject(STORE) private readonly store: StorePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly engine: MatchEngine,
  ) {}

  /** 注册到实时模块的端口表（避免实时模块反向 import 赛事模块）。 */
  onModuleInit(): void {
    RealtimeRegistry.registerMatches({
      getMatchDetail: (matchId: string) => this.getMatchDetail(matchId),
    });
  }

  // ------------------------------------------------------------------ 赛季

  async createSeason(dto: CreateSeasonDto): Promise<Season> {
    return this.store.createSeason({
      name: dto.name,
      organizer: dto.organizer ?? null,
      startDate: dto.startDate ?? null,
      endDate: dto.endDate ?? null,
    });
  }

  async listSeasons() {
    return this.store.listSeasons();
  }

  // ------------------------------------------------------------------ 比赛

  async createMatch(dto: CreateMatchDto): Promise<MatchDetail> {
    if (dto.seasonId) {
      const season = await this.store.findSeasonById(dto.seasonId);
      if (!season) throw DomainError.notFound('SEASON_NOT_FOUND', `赛季不存在：${dto.seasonId}`);
    }

    if (dto.home.name.trim() === dto.away.name.trim()) {
      throw new DomainError('INVALID_EVENT', '主队与客队名称不能相同');
    }

    const record: CreateMatchRecord = {
      seasonId: dto.seasonId ?? null,
      competition: dto.competition.trim(),
      title: dto.title.trim(),
      venue: dto.venue?.trim() ?? null,
      scheduledAt: dto.scheduledAt ?? null,
      periodFormat: dto.periodFormat ?? 'quarters',
      periodSeconds: dto.periodSeconds ?? 600,
      regulationPeriods: dto.regulationPeriods ?? (dto.periodFormat === 'halves' ? 2 : 4),
      shareCode: await this.uniqueShareCode(),
      home: {
        name: dto.home.name.trim(),
        shortName: (dto.home.shortName ?? dto.home.name).trim().slice(0, 40),
        color: dto.home.color ?? '#E4572E',
        players: (dto.home.players ?? []).map((player) => ({
          name: player.name.trim(),
          jerseyNumber: player.jerseyNumber.trim(),
          isStarter: player.isStarter ?? false,
        })),
      },
      away: {
        name: dto.away.name.trim(),
        shortName: (dto.away.shortName ?? dto.away.name).trim().slice(0, 40),
        color: dto.away.color ?? '#2563EB',
        players: (dto.away.players ?? []).map((player) => ({
          name: player.name.trim(),
          jerseyNumber: player.jerseyNumber.trim(),
          isStarter: player.isStarter ?? false,
        })),
      },
    };

    this.assertNoDuplicateJersey(record.home.players, record.home.name);
    this.assertNoDuplicateJersey(record.away.players, record.away.name);

    const aggregate = await this.store.createMatch(record);
    this.logger.log(`创建比赛 ${aggregate.match.id}（${aggregate.match.title}）分享码 ${aggregate.match.shareCode}`);
    return this.toDetail(aggregate);
  }

  private assertNoDuplicateJersey(players: { jerseyNumber: string }[], teamName: string): void {
    const seen = new Set<string>();
    for (const player of players) {
      if (seen.has(player.jerseyNumber)) {
        throw DomainError.conflict('PLAYER_DUPLICATE_JERSEY', `${teamName} 内球衣号码 ${player.jerseyNumber} 重复`);
      }
      seen.add(player.jerseyNumber);
    }
  }

  /** 生成不与现有比赛冲突的分享码（32^6 空间，冲突概率极低，仍然重试保护）。 */
  private async uniqueShareCode(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = generateShareCode();
      const existing = await this.store.findMatchByShareCode(code);
      if (!existing) return code;
    }
    throw DomainError.conflict('SHARE_CODE_CONFLICT', '分享码生成冲突，请重试');
  }

  async listMatches(query: ListMatchesQueryDto): Promise<{ items: MatchSummary[]; total: number }> {
    const aggregates = await this.store.listMatches({
      seasonId: query.seasonId,
      status: query.status,
      limit: query.limit ?? 50,
    });
    const items = await Promise.all(aggregates.map((aggregate) => this.toSummary(aggregate)));
    return { items, total: items.length };
  }

  async getMatchDetail(matchId: string): Promise<MatchDetail> {
    const aggregate = await this.store.findMatchById(matchId);
    if (!aggregate) throw DomainError.notFound('MATCH_NOT_FOUND', `比赛不存在：${matchId}`);
    return this.toDetail(aggregate);
  }

  async getMatchByShareCode(rawCode: string): Promise<MatchDetail> {
    const code = normalizeShareCode(rawCode);
    const aggregate = await this.store.findMatchByShareCode(code);
    if (!aggregate) throw DomainError.notFound('SHARE_CODE_NOT_FOUND', `分享码 ${code} 对应的比赛不存在`);
    return this.toDetail(aggregate);
  }

  async updateMatch(matchId: string, dto: UpdateMatchDto): Promise<MatchDetail> {
    const updated = await this.store.updateMatch(matchId, {
      ...(dto.competition !== undefined ? { competition: dto.competition } : {}),
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.venue !== undefined ? { venue: dto.venue } : {}),
      ...(dto.scheduledAt !== undefined ? { scheduledAt: dto.scheduledAt } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.periodSeconds !== undefined ? { periodSeconds: dto.periodSeconds } : {}),
      ...(dto.regulationPeriods !== undefined ? { regulationPeriods: dto.regulationPeriods } : {}),
    });
    if (!updated) throw DomainError.notFound('MATCH_NOT_FOUND', `比赛不存在：${matchId}`);
    return this.toDetail(updated);
  }

  async archiveMatch(matchId: string): Promise<MatchDetail> {
    return this.updateMatch(matchId, { status: 'archived' });
  }

  // ------------------------------------------------------------------ 球员

  async addPlayer(matchId: string, dto: AddPlayerDto) {
    const aggregate = await this.store.findMatchById(matchId);
    if (!aggregate) throw DomainError.notFound('MATCH_NOT_FOUND', `比赛不存在：${matchId}`);
    const team = aggregate.teams[dto.side as TeamSide];
    if (team.players.some((player) => player.jerseyNumber === dto.jerseyNumber.trim())) {
      throw DomainError.conflict('PLAYER_DUPLICATE_JERSEY', `${team.name} 内球衣号码 ${dto.jerseyNumber} 已存在`);
    }
    const player = await this.store.addPlayer(matchId, dto.side, {
      name: dto.name.trim(),
      jerseyNumber: dto.jerseyNumber.trim(),
      isStarter: dto.isStarter ?? false,
    });
    if (!player) throw DomainError.notFound('MATCH_NOT_FOUND', `比赛不存在：${matchId}`);
    return player;
  }

  async deletePlayer(matchId: string, playerId: string): Promise<{ deleted: boolean }> {
    const deleted = await this.store.deletePlayer(matchId, playerId);
    if (!deleted) throw DomainError.notFound('PLAYER_NOT_FOUND', '球员不存在或不属于本场比赛');
    return { deleted };
  }

  // ------------------------------------------------------------------ 映射

  toDetail(aggregate: MatchAggregate): MatchDetail {
    return {
      match: aggregate.match,
      season: null,
      teams: { home: aggregate.teams.home, away: aggregate.teams.away },
    };
  }

  /**
   * 列表项：比分必须从事件流算出来。
   * 只有「进行中 / 已结束」的比赛才读事件，避免列表页把整库事件都拉出来。
   */
  async toSummary(aggregate: MatchAggregate): Promise<MatchSummary> {
    let homeScore = 0;
    let awayScore = 0;
    let period = 1;

    if (aggregate.match.status !== 'scheduled') {
      const events = await this.store.listEvents(aggregate.match.id, { sinceSeq: 0 });
      const state = this.engine.buildState(aggregate, events);
      homeScore = state.scoreboard.home.score;
      awayScore = state.scoreboard.away.score;
      period = state.period;
    }

    return {
      id: aggregate.match.id,
      competition: aggregate.match.competition,
      title: aggregate.match.title,
      venue: aggregate.match.venue,
      status: aggregate.match.status,
      scheduledAt: aggregate.match.scheduledAt,
      shareCode: aggregate.match.shareCode,
      period,
      homeName: aggregate.teams.home.shortName || aggregate.teams.home.name,
      awayName: aggregate.teams.away.shortName || aggregate.teams.away.name,
      homeScore,
      awayScore,
      scoreText: `${homeScore} : ${awayScore}`,
      updatedAt: aggregate.match.updatedAt,
    };
  }

  /** 供健康检查与调试：当前存储驱动与规模。 */
  async storeStats() {
    const matches = await this.store.listMatches({ limit: 500 });
    let eventCount = 0;
    for (const aggregate of matches) {
      eventCount += await this.store.countEvents(aggregate.match.id);
    }
    return {
      driver: this.store.driver,
      matchCount: matches.length,
      eventCount,
      scorerPasscodeConfigured: this.config.scorerPasscode !== 'hoop2024',
    };
  }
}
