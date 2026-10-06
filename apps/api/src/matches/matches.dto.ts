import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MATCH_STATUSES, SHOT_TYPES } from '@openhoopscore/contracts';
import type { GameEventType, ShotType } from '@openhoopscore/contracts';
import { GAME_EVENT_TYPES } from '@openhoopscore/contracts';

/* ============================ 赛季 ============================ */

export class CreateSeasonDto {
  @ApiProperty({ description: '赛季名称，如「2024 社区篮球联赛」', maxLength: 120 })
  @IsString()
  @IsNotEmpty({ message: '赛季名称不能为空' })
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: '主办方' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  organizer?: string | null;

  @ApiPropertyOptional({ description: '开始日期 YYYY-MM-DD' })
  @IsOptional()
  @IsISO8601()
  startDate?: string | null;

  @ApiPropertyOptional({ description: '结束日期 YYYY-MM-DD' })
  @IsOptional()
  @IsISO8601()
  endDate?: string | null;
}

/* ============================ 比赛 ============================ */

export class CreatePlayerDto {
  @ApiProperty({ description: '球员姓名' })
  @IsString()
  @IsNotEmpty({ message: '球员姓名不能为空' })
  @MaxLength(80)
  name!: string;

  @ApiProperty({ description: '球衣号码（同队唯一）' })
  @IsString()
  @IsNotEmpty({ message: '球衣号码不能为空' })
  @MaxLength(8)
  jerseyNumber!: string;

  @ApiPropertyOptional({ description: '是否首发' })
  @IsOptional()
  @IsBoolean()
  isStarter?: boolean;
}

export class CreateTeamDto {
  @ApiProperty({ description: '队伍全称' })
  @IsString()
  @IsNotEmpty({ message: '队伍名称不能为空' })
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: '队伍简称（大屏用）' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  shortName?: string;

  @ApiPropertyOptional({ description: '主题色 #RRGGBB' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string;

  @ApiPropertyOptional({ description: '球员名单', type: [CreatePlayerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30, { message: '单队球员不超过 30 人' })
  @ValidateNested({ each: true })
  @Type(() => CreatePlayerDto)
  players?: CreatePlayerDto[];
}

export class CreateMatchDto {
  @ApiPropertyOptional({ description: '所属赛季 id' })
  @IsOptional()
  @IsUUID()
  seasonId?: string | null;

  @ApiProperty({ description: '赛事名称' })
  @IsString()
  @IsNotEmpty({ message: '赛事名称不能为空' })
  @MaxLength(120)
  competition!: string;

  @ApiProperty({ description: '比赛标题，如「A 组第 3 轮」' })
  @IsString()
  @IsNotEmpty({ message: '比赛标题不能为空' })
  @MaxLength(160)
  title!: string;

  @ApiPropertyOptional({ description: '场地' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  venue?: string | null;

  @ApiPropertyOptional({ description: '计划开赛时间' })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string | null;

  @ApiPropertyOptional({ description: '赛制：quarters（4 节制）/ halves（2 节制）', enum: ['quarters', 'halves'] })
  @IsOptional()
  @IsIn(['quarters', 'halves'])
  periodFormat?: 'quarters' | 'halves';

  @ApiPropertyOptional({ description: '单节时长（秒）', minimum: 60, maximum: 3600 })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(3600)
  periodSeconds?: number;

  @ApiPropertyOptional({ description: '常规节数', minimum: 1, maximum: 8 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  regulationPeriods?: number;

  @ApiProperty({ description: '主队', type: CreateTeamDto })
  @ValidateNested()
  @Type(() => CreateTeamDto)
  home!: CreateTeamDto;

  @ApiProperty({ description: '客队', type: CreateTeamDto })
  @ValidateNested()
  @Type(() => CreateTeamDto)
  away!: CreateTeamDto;
}

export class UpdateMatchDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  competition?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  venue?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string | null;

  @ApiPropertyOptional({ enum: MATCH_STATUSES })
  @IsOptional()
  @IsIn(MATCH_STATUSES as unknown as string[])
  status?: (typeof MATCH_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(3600)
  periodSeconds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  regulationPeriods?: number;
}

export class AddPlayerDto extends CreatePlayerDto {
  @ApiProperty({ description: '加到哪一边', enum: ['home', 'away'] })
  @IsIn(['home', 'away'])
  side!: 'home' | 'away';
}

/* ============================ 事件 / 计分 ============================ */

/**
 * 单条事件草稿。
 *
 * 注意 `clientEventId` 是**幂等键**：计分端每次点击都先生成本地唯一 id，
 * 断网重连后重复推送同一条也不会重复计分。所以它是必填且必须由客户端生成。
 */
export class GameEventDraftDto {
  @ApiPropertyOptional({ description: '本地生成的临时 id（服务端会重写）' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ description: '事件类型', enum: GAME_EVENT_TYPES })
  @IsIn(GAME_EVENT_TYPES as unknown as string[])
  type!: GameEventType;

  @ApiPropertyOptional({ description: '所属队伍 id' })
  @IsOptional()
  @IsUUID()
  teamId?: string | null;

  @ApiPropertyOptional({ description: '所属球员 id' })
  @IsOptional()
  @IsUUID()
  playerId?: string | null;

  @ApiProperty({ description: '第几节（从 1 开始）', minimum: 1, maximum: 20 })
  @IsInt()
  @Min(1)
  @Max(20)
  period!: number;

  @ApiPropertyOptional({ description: '该节剩余秒数' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  gameClockSeconds?: number | null;

  @ApiProperty({ description: '计分设备本地时间（ISO 8601）' })
  @IsISO8601()
  clientTimestamp!: string;

  @ApiProperty({ description: '计分设备标识' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientId!: string;

  @ApiProperty({ description: '幂等键，本地唯一' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientEventId!: string;

  @ApiPropertyOptional({
    description: '事件结构化数据：score → {points, shotType}；substitution → {playerInId, playerOutId}；void → {targetEventId}',
  })
  @IsOptional()
  payload?: Record<string, unknown>;
}

export class SubmitEventsDto {
  @ApiPropertyOptional({ description: '计分口令（也可用请求头 x-scorer-passcode）' })
  @IsOptional()
  @IsString()
  passcode?: string;

  @ApiProperty({ description: '计分设备标识' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientId!: string;

  @ApiPropertyOptional({ description: '客户端已确认的最大 seq' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sinceSeq?: number;

  @ApiProperty({ description: '事件列表（离线补传可以一次多条）', type: [GameEventDraftDto] })
  @IsArray()
  @ArrayMaxSize(1000, { message: '单批事件过多，请分批补传' })
  @ValidateNested({ each: true })
  @Type(() => GameEventDraftDto)
  events!: GameEventDraftDto[];
}

export class UndoDto {
  @ApiPropertyOptional({ description: '计分口令' })
  @IsOptional()
  @IsString()
  passcode?: string;

  @ApiProperty({ description: '计分设备标识' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientId!: string;

  @ApiPropertyOptional({ description: '指定要撤销的事件 id；不传则撤销最近一步' })
  @IsOptional()
  @IsUUID()
  targetEventId?: string;

  @ApiPropertyOptional({ description: '连续撤销步数', minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  steps?: number;

  @ApiPropertyOptional({ description: '撤销原因（审计）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class PreviewComputeDto {
  @ApiProperty({ description: '客户端本地待确认事件', type: [GameEventDraftDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GameEventDraftDto)
  events!: GameEventDraftDto[];
}

export class SetClockDto {
  @ApiPropertyOptional({ description: '计分口令' })
  @IsOptional()
  @IsString()
  passcode?: string;

  @ApiProperty({ description: '计分设备标识' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientId!: string;

  @ApiPropertyOptional({ description: '节次', minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  period?: number;

  @ApiPropertyOptional({ description: '该节剩余秒数' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  gameClockSeconds?: number | null;

  @ApiPropertyOptional({ description: '计时器是否在跑' })
  @IsOptional()
  @IsBoolean()
  running?: boolean;
}

export class FinishMatchDto {
  @ApiPropertyOptional({ description: '计分口令' })
  @IsOptional()
  @IsString()
  passcode?: string;

  @ApiProperty({ description: '计分设备标识' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientId!: string;

  @ApiPropertyOptional({ description: '结束原因', enum: ['normal', 'forfeit', 'aborted'] })
  @IsOptional()
  @IsIn(['normal', 'forfeit', 'aborted'])
  reason?: 'normal' | 'forfeit' | 'aborted';
}

export class ReconcileDto {
  @ApiProperty({ description: '本地待确认的 clientEventId 列表', type: [String] })
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  clientEventIds!: string[];
}

export class ListMatchesQueryDto {
  @ApiPropertyOptional({ description: '按赛季过滤' })
  @IsOptional()
  @IsUUID()
  seasonId?: string;

  @ApiPropertyOptional({ description: '按状态过滤', enum: MATCH_STATUSES })
  @IsOptional()
  @IsIn(MATCH_STATUSES as unknown as string[])
  status?: (typeof MATCH_STATUSES)[number];

  @ApiPropertyOptional({ description: '返回条数', minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class LeaderboardQueryDto {
  @ApiPropertyOptional({ description: '排序字段', enum: ['points', 'fouls', 'threePointersMade'] })
  @IsOptional()
  @IsIn(['points', 'fouls', 'threePointersMade'])
  sortedBy?: 'points' | 'fouls' | 'threePointersMade';
}

export const SHOT_TYPE_VALUES = SHOT_TYPES satisfies readonly ShotType[];
