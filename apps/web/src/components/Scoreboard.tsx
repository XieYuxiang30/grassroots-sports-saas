import type { MatchSummary, MatchState, Scoreboard } from '@openhoopscore/contracts';

/**
 * 比分牌组件（观众端 / 大屏 / 计分端共用）。
 *
 * 只接受「够渲染比分」的最小数据，因此三端可以传各自的来源：
 *   - 观众端传 socket 推来的 Scoreboard；
 *   - 计分端传本地乐观推导的 MatchState.scoreboard（含未同步事件）；
 *   - 大屏传什么都可以，样式由 variant 决定。
 */
export interface ScoreboardViewProps {
  scoreboard: Scoreboard;
  variant?: 'compact' | 'display';
  /** 比赛标题，大屏底部显示。 */
  title?: string;
  /** 右上角附加信息（连接状态等）。 */
  extra?: React.ReactNode;
}

export function ScoreboardView({ scoreboard, variant = 'compact', title, extra }: ScoreboardViewProps) {
  if (variant === 'display') {
    return (
      <div className="display-scoreboard">
        <div className="display-team">
          <div className="display-team-name" style={{ color: scoreboard.home.color }}>
            {scoreboard.home.name}
          </div>
          <div className="display-score tabular">{scoreboard.home.score}</div>
        </div>
        <div className="display-mid">
          <div className="display-score-sep">:</div>
          <div className="display-period">
            第 {scoreboard.period} 节 · {statusLabel(scoreboard.status)}
          </div>
        </div>
        <div className="display-team away">
          <div className="display-team-name" style={{ color: scoreboard.away.color }}>
            {scoreboard.away.name}
          </div>
          <div className="display-score tabular">{scoreboard.away.score}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="scoreboard">
      <div className="scoreboard-team">
        <div className="scoreboard-name">{scoreboard.home.name}</div>
        <div className="scoreboard-color" style={{ background: scoreboard.home.color }} />
        <div className="scoreboard-score tabular" style={{ color: scoreboard.home.color }}>
          {scoreboard.home.score}
        </div>
      </div>
      <div className="scoreboard-mid">
        <div className="scoreboard-period">第 {scoreboard.period} 节</div>
        <div className="faint">{statusLabel(scoreboard.status)}</div>
        {title ? <div className="faint">{title}</div> : null}
        {extra}
      </div>
      <div className="scoreboard-team away">
        <div className="scoreboard-name">{scoreboard.away.name}</div>
        <div className="scoreboard-color" style={{ background: scoreboard.away.color }} />
        <div className="scoreboard-score tabular" style={{ color: scoreboard.away.color }}>
          {scoreboard.away.score}
        </div>
      </div>
    </div>
  );
}

export function statusLabel(status: MatchState['status'] | MatchSummary['status']): string {
  switch (status) {
    case 'scheduled':
      return '未开始';
    case 'live':
      return '进行中';
    case 'finished':
      return '已结束';
    case 'archived':
      return '已归档';
    default:
      return String(status);
  }
}

/** 比赛列表里的一行（首页与后台共用）。 */
export function MatchRow({ summary, onClick }: { summary: MatchSummary; onClick?: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-ghost"
      style={{ textAlign: 'left', display: 'block', padding: '12px 14px', width: '100%' }}
      onClick={onClick}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {summary.homeName} vs {summary.awayName}
          </div>
          <div className="faint" style={{ marginTop: 2 }}>
            {summary.competition} · {summary.title}
            {summary.venue ? ` · ${summary.venue}` : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div className="tabular" style={{ fontSize: 18, fontWeight: 700 }}>
            {summary.scoreText}
          </div>
          <div className="faint">{statusLabel(summary.status)}</div>
        </div>
      </div>
    </button>
  );
}
