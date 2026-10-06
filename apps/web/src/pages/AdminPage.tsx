import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { MatchDetail, MatchSummary, Player } from '@openhoopscore/contracts';
import { MatchRow, statusLabel } from '@/components/Scoreboard';
import { ShareCard } from '@/components/ShareCard';
import { api, ApiError } from '@/services/api';

/**
 * ============================================================================
 * 赛事管理后台
 * ============================================================================
 * 覆盖方案里的「第二阶段：赛事管理后台」：
 *   - 创建比赛（含两队球员名单，一次填完就能开打）
 *   - 列表管理（状态、分享码、进入计分台 / 大屏）
 *   - 比赛详情里补录 / 删除球员、查看分享二维码、归档比赛
 *
 * 表单设计原则：**用 textarea 批量粘贴名单**。现场最常见的做法是领队在微信里
 * 发一段「4 张三 / 5 李四 / 6 王五」，让管理员一个个加输入框是灾难。
 * 所以这里支持「号码 姓名」每行一个的批量录入。
 */
export default function AdminPage() {
  const { matchId } = useParams();
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [detail, setDetail] = useState<MatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.listMatches({ limit: 100 });
      setMatches(response.items);
      setError(null);
    } catch (err) {
      setError(`加载比赛列表失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!matchId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void api
      .getMatch(matchId)
      .then((response) => {
        if (!cancelled) setDetail(response);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`加载比赛详情失败：${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>赛事管理后台</h1>
        <Link className="btn btn-ghost" to="/">
          首页
        </Link>
      </div>

      <div className="page-body">
        {error ? <div className="error-box">{error}</div> : null}
        {notice ? <div className="warn-box">{notice}</div> : null}

        {detail ? (
          <MatchDetailPanel
            detail={detail}
            onChanged={(updated) => {
              setDetail(updated);
              void reload();
            }}
            onNotice={setNotice}
          />
        ) : (
          <>
            <div className="card">
              <div className="row" style={{ alignItems: 'center' }}>
                <p className="card-title" style={{ margin: 0, flex: 1 }}>
                  比赛列表（{matches.length}）
                </p>
                <button type="button" className="btn btn-primary" style={{ flex: 'none' }} onClick={() => setShowCreate((value) => !value)}>
                  {showCreate ? '收起' : '+ 创建比赛'}
                </button>
              </div>
            </div>

            {showCreate ? (
              <CreateMatchForm
                onCreated={async (created) => {
                  setNotice(`已创建比赛「${created.match.title}」，分享码 ${created.match.shareCode}`);
                  setShowCreate(false);
                  await reload();
                }}
              />
            ) : null}

            {loading ? (
              <div className="card empty">
                <div className="spinner" style={{ margin: '0 auto' }} />
              </div>
            ) : matches.length === 0 ? (
              <div className="card empty">还没有比赛，点上面的「创建比赛」开始</div>
            ) : (
              <div className="card">
                <div className="stack" style={{ gap: 4 }}>
                  {matches.map((match) => (
                    <div key={match.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <MatchRow summary={match} />
                      <div className="row" style={{ padding: '0 12px 10px' }}>
                        <Link className="btn" to={`/admin/matches/${match.id}`} style={{ textAlign: 'center' }}>
                          管理名单
                        </Link>
                        <Link className="btn" to={`/score/${match.id}`} style={{ textAlign: 'center' }}>
                          计分台
                        </Link>
                        <Link className="btn" to={`/display/${match.id}`} style={{ textAlign: 'center' }}>
                          大屏
                        </Link>
                        <Link className="btn" to={`/live/${match.id}`} style={{ textAlign: 'center' }}>
                          观众端
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 创建比赛 */

interface SimplePlayer {
  jerseyNumber: string;
  name: string;
}

function parseRoster(text: string): SimplePlayer[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // 支持「4 张三」「4号 张三」「张三 4」「4,张三」「4、张三」
      const normalized = line.replace(/[，,、|/]+/g, ' ').replace(/号/g, ' ').replace(/\s+/g, ' ').trim();
      const tokens = normalized.split(' ');
      if (tokens.length === 1) return { jerseyNumber: '', name: tokens[0]! };
      const firstIsNumber = /^\d{1,3}$/.test(tokens[0]!);
      return firstIsNumber
        ? { jerseyNumber: tokens[0]!, name: tokens.slice(1).join(' ') }
        : { jerseyNumber: tokens[tokens.length - 1]!, name: tokens.slice(0, -1).join(' ') };
    })
    .filter((player) => player.name);
}

function CreateMatchForm({ onCreated }: { onCreated: (detail: MatchDetail) => void | Promise<void> }) {
  const [competition, setCompetition] = useState('');
  const [title, setTitle] = useState('');
  const [venue, setVenue] = useState('');
  const [homeName, setHomeName] = useState('');
  const [awayName, setAwayName] = useState('');
  const [homeRoster, setHomeRoster] = useState('');
  const [awayRoster, setAwayRoster] = useState('');
  const [periodFormat, setPeriodFormat] = useState<'quarters' | 'halves'>('quarters');
  const [periodSeconds, setPeriodSeconds] = useState(600);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!competition.trim() || !title.trim()) {
      setError('赛事名称与比赛标题都要填');
      return;
    }
    if (!homeName.trim() || !awayName.trim()) {
      setError('两队名称都要填');
      return;
    }
    const home = parseRoster(homeRoster);
    const away = parseRoster(awayRoster);
    // 号码留空时自动补全，避免因为「懒得填号码」而记不了分
    const fillJersey = (players: SimplePlayer[]): SimplePlayer[] =>
      players.map((player, index) => ({ ...player, jerseyNumber: player.jerseyNumber || String(index + 1) }));

    setSubmitting(true);
    try {
      const created = await api.createMatch({
        competition: competition.trim(),
        title: title.trim(),
        venue: venue.trim() || null,
        periodFormat,
        periodSeconds,
        regulationPeriods: periodFormat === 'halves' ? 2 : 4,
        home: { name: homeName.trim(), players: fillJersey(home) },
        away: { name: awayName.trim(), players: fillJersey(away) },
      });
      await onCreated(created);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      setError(
        apiError?.code === 'PLAYER_DUPLICATE_JERSEY'
          ? '球员号码重复：同一支队伍里每个号码只能出现一次'
          : `创建失败：${(err as Error).message}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card stack">
      <p className="card-title">创建比赛</p>
      {error ? <div className="error-box">{error}</div> : null}

      <div className="row">
        <div className="field">
          <label htmlFor="competition">赛事名称 *</label>
          <input
            id="competition"
            className="input"
            placeholder="如：2024 社区篮球联赛"
            value={competition}
            onChange={(event) => setCompetition(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="title">比赛标题 *</label>
          <input
            id="title"
            className="input"
            placeholder="如：A 组第 3 轮"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="venue">场地</label>
          <input id="venue" className="input" placeholder="如：街道体育馆" value={venue} onChange={(event) => setVenue(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="format">赛制</label>
          <select
            id="format"
            className="select"
            value={periodFormat}
            onChange={(event) => setPeriodFormat(event.target.value as 'quarters' | 'halves')}
          >
            <option value="quarters">4 节制</option>
            <option value="halves">2 节制（上下半场）</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="periodSeconds">每节时长（秒）</label>
          <input
            id="periodSeconds"
            className="input tabular"
            type="number"
            min={60}
            max={3600}
            step={60}
            value={periodSeconds}
            onChange={(event) => setPeriodSeconds(Number(event.target.value) || 600)}
          />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="homeName">主队名称 *</label>
          <input id="homeName" className="input" placeholder="如：东街猛虎" value={homeName} onChange={(event) => setHomeName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="awayName">客队名称 *</label>
          <input id="awayName" className="input" placeholder="如：西巷飞鹰" value={awayName} onChange={(event) => setAwayName(event.target.value)} />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="homeRoster">主队名单（每行「号码 姓名」，可留空）</label>
          <textarea
            id="homeRoster"
            className="input"
            rows={5}
            placeholder={'4 张三\n5 李四\n6 王五'}
            value={homeRoster}
            onChange={(event) => setHomeRoster(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="awayRoster">客队名单（每行「号码 姓名」，可留空）</label>
          <textarea
            id="awayRoster"
            className="input"
            rows={5}
            placeholder={'7 赵六\n8 钱七'}
            value={awayRoster}
            onChange={(event) => setAwayRoster(event.target.value)}
          />
        </div>
      </div>

      <p className="faint">
        支持直接粘贴微信里发来的名单：每行「4 张三」「张三 4」「4、张三」都能识别；不填号码会自动按顺序编号 1、2、3…
      </p>

      <button type="button" className="btn btn-primary btn-block" onClick={() => void submit()} disabled={submitting}>
        {submitting ? '创建中…' : '创建比赛并生成分享码'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ 比赛详情 */

function MatchDetailPanel({
  detail,
  onChanged,
  onNotice,
}: {
  detail: MatchDetail;
  onChanged: (detail: MatchDetail) => void;
  onNotice: (message: string | null) => void;
}) {
  const [side, setSide] = useState<'home' | 'away'>('home');
  const [rosterText, setRosterText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const updated = await api.getMatch(detail.match.id);
    onChanged(updated);
  };

  const addPlayers = async () => {
    setError(null);
    const parsed = parseRoster(rosterText);
    if (parsed.length === 0) {
      setError('请按「号码 姓名」每行一个填写');
      return;
    }
    setBusy(true);
    try {
      for (const [index, player] of parsed.entries()) {
        await api.addPlayer(detail.match.id, {
          side,
          name: player.name,
          jerseyNumber: player.jerseyNumber || String(detail.teams[side].players.length + index + 1),
        });
      }
      setRosterText('');
      await refresh();
      onNotice(`已为${side === 'home' ? '主队' : '客队'}添加 ${parsed.length} 名球员`);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      setError(
        apiError?.code === 'PLAYER_DUPLICATE_JERSEY'
          ? '号码重复：该队已有同号球员，请修改后重试'
          : `添加失败：${(err as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const removePlayer = async (player: Player) => {
    if (!window.confirm(`确认删除 ${player.jerseyNumber} 号 ${player.name}？已记录的该球员事件不会被删除。`)) return;
    setBusy(true);
    try {
      await api.deletePlayer(detail.match.id, player.id);
      await refresh();
    } catch (err) {
      setError(`删除失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!window.confirm('归档后不能再计分，但事件流完整保留、随时可回放复盘。确认归档？')) return;
    setBusy(true);
    try {
      const updated = await api.archiveMatch(detail.match.id);
      onChanged(updated);
      onNotice('比赛已归档');
    } catch (err) {
      setError(`归档失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const shareUrl = `${window.location.origin}/m/${detail.match.shareCode}`;

  return (
    <>
      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>
              {detail.match.competition} · {detail.match.title}
            </div>
            <div className="faint">
              {detail.match.venue ?? '未填场地'} · {statusLabel(detail.match.status)} ·{' '}
              {detail.match.periodFormat === 'halves' ? '2 节制' : '4 节制'} · 每节 {detail.match.periodSeconds / 60} 分钟
            </div>
          </div>
          <Link className="btn" to="/admin" style={{ flex: 'none' }}>
            返回列表
          </Link>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <Link className="btn btn-primary" to={`/score/${detail.match.id}`} style={{ textAlign: 'center' }}>
            进入计分台
          </Link>
          <Link className="btn" to={`/display/${detail.match.id}`} style={{ textAlign: 'center' }}>
            大屏比分牌
          </Link>
          <button type="button" className="btn btn-danger" onClick={() => void archive()} disabled={busy || detail.match.status === 'archived'}>
            归档比赛
          </button>
        </div>
      </div>

      <ShareCard shareCode={detail.match.shareCode} shareUrl={shareUrl} matchTitle={detail.match.title} />

      {error ? <div className="error-box">{error}</div> : null}

      <div className="card stack">
        <p className="card-title">补充球员名单</p>
        <div className="row">
          <div className="field">
            <label htmlFor="side">加到哪支队伍</label>
            <select id="side" className="select" value={side} onChange={(event) => setSide(event.target.value as 'home' | 'away')}>
              <option value="home">{detail.teams.home.name}（主）</option>
              <option value="away">{detail.teams.away.name}（客）</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="roster">名单（每行「号码 姓名」）</label>
          <textarea
            id="roster"
            className="input"
            rows={4}
            placeholder={'9 周九\n10 吴十'}
            value={rosterText}
            onChange={(event) => setRosterText(event.target.value)}
          />
        </div>
        <button type="button" className="btn btn-primary" onClick={() => void addPlayers()} disabled={busy}>
          {busy ? '提交中…' : '添加到名单'}
        </button>
      </div>

      <div className="card">
        <p className="card-title">当前名单</p>
        <table className="table">
          <thead>
            <tr>
              <th>队伍</th>
              <th>号码</th>
              <th>姓名</th>
              <th>首发</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...detail.teams.home.players.map((player) => ({ player, team: detail.teams.home.name })),
              ...detail.teams.away.players.map((player) => ({ player, team: detail.teams.away.name }))].map(
              ({ player, team }) => (
                <tr key={player.id}>
                  <td>{team}</td>
                  <td className="tabular">{player.jerseyNumber}</td>
                  <td>{player.name}</td>
                  <td>{player.isStarter ? '是' : ''}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="btn btn-ghost" onClick={() => void removePlayer(player)} disabled={busy}>
                      删除
                    </button>
                  </td>
                </tr>
              ),
            )}
            {detail.teams.home.players.length + detail.teams.away.players.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty faint">
                  还没有球员。可以先用团队得分计分，也可以随时补录。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
