import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RealtimeService } from './realtime.service';

/** 实时通道的运维接口：现场排查「到底有几台设备在计分」。 */
@ApiTags('实时通道')
@Controller('matches/:id/realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Get('scorers')
  @ApiOperation({ summary: '当前在线计分设备（用于提示「另一台平板也在计分」）' })
  async scorers(@Param('id') id: string) {
    return {
      matchId: id,
      online: this.realtime.onlineScorers(id),
    };
  }
}
