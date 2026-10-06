import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { MatchSummary } from '@openhoopscore/contracts';
import { MatchRow } from '@/components/Scoreboard';
import { api, ApiError } from '@/services/api';

/**
 * 首页：现场三种角色共用同一个入口。
 *
 * 设计理由是**现场只有一个网址**：主办方把首页地址印在易拉宝上，
 * 观众扫码进 /m/xxx，计分员从首页进计分台，管理员从首页进后台。
 * 所以首页要同时给出「输入分享码 / 进行中的比赛 / 三个角色入口」。
 */
export default function HomePage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .health()
      .then((health) => {
        if (!cancelled) setBackend(`后端在线 · 存储 ${health.storageDriver} · 投影内核 ${health.projectionVersion}`);
      })
      .catch(() => {
        if (!cancelled) setBackend(null);
      });

    void api
      .listMatches({ limit: 30 })
      .then((response) => {
        if (!cancelled) {
          setMatches(response.items);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`无法加载比赛列表：${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const joinByCode = async () => {
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    setJoining(true);
    try {
      const detail = await api.getMatchByCode(normalized);
      navigate(`/live/${detail.match.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'SHARE_CODE_NOT_FOUND'
          ? `没有找到分享码 ${normalized} 对应的比赛`
          : `进入失败：${(err as Error).message}`,
      );
    } finally {
      setJoining(false);
    }
  };

  const live = matches.filter((match) => match.status === 'live');
  const upcoming = matches.filter((match) => match.status === 'scheduled');
  const finished = matches.filter((match) => match.status === 'finished' || match.status === 'archived');

  return (
    <div className="page">
      <div className="page-header">
        <h1>篮迹计分 · 基层赛事平台</h1>
        {backend ? <span className="badge badge-online">● 后端正常</span> : <span className="badge badge-danger">后端未连接</span>}
      </div>

      <div className="page-body">
        <div className="card">
          <p className="card-title">观众：输入分享码看实时比分</p>
          <div className="row">
            <input
              className="input tabular"
              placeholder="6 位分享码，如 AB12CD"
              value={code}
              maxLength={12}
              style={{ flex: 2, letterSpacing: '0.16em', textTransform: 'uppercase' }}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void joinByCode();
              }}
            />
            <button type="button" className="btn btn-primary" onClick={() => void joinByCode()} disabled={joining || !code.trim()}>
              {joining ? '进入中…' : '进入观赛'}
            </button>
          </div>
          <p className="faint" style={{ marginTop: 8 }}>
            也可以直接扫大屏上的二维码，会自动进入对应比赛。
          </p>
        </div>

        {error ? <div className="error-box">{error}</div> : null}

        {live.length > 0 ? (
          <div className="card">
            <p className="card-title">正在进行</p>
            <div className="stack" style={{ gap: 4 }}>
              {live.map((match) => (
                <MatchRow key={match.id} summary={match} onClick={() => navigate(`/live/${match.id}`)} />
              ))}
            </div>
          </div>
        ) : null}

        {upcoming.length > 0 ? (
          <div className="card">
            <p className="card-title">即将开始</p>
            <div className="stack" style={{ gap: 4 }}>
              {upcoming.map((match) => (
                <MatchRow
                  key={match.id}
                  summary={match}
                  onClick={() => navigate(`/score/${match.id}`)}
                />
              ))}
            </div>
          </div>
        ) : null}

        {finished.length > 0 ? (
          <div className="card">
            <p className="card-title">已结束（可回看事件与比分）</p>
            <div className="stack" style={{ gap: 4 }}>
              {finished.map((match) => (
                <MatchRow key={match.id} summary={match} onClick={() => navigate(`/live/${match.id}`)} />
              ))}
            </div>
          </div>
        ) : null}

        {!loading && matches.length === 0 ? (
          <div className="card empty">
            <p>还没有任何比赛。</p>
            <Link className="btn btn-primary" to="/admin">
              去后台创建第一场比赛
            </Link>
          </div>
        ) : null}

        <div className="card">
          <p className="card-title">工作人员入口</p>
          <div className="row">
            <Link className="btn" to="/admin" style={{ textAlign: 'center' }}>
              赛事管理后台
            </Link>
            <Link className="btn" to={live[0] ? `/score/${live[0].id}` : '/admin'} style={{ textAlign: 'center' }}>
              计分台
            </Link>
            <Link className="btn" to={live[0] ? `/display/${live[0].id}` : '/admin'} style={{ textAlign: 'center' }}>
              大屏比分牌
            </Link>
          </div>
        </div>

        <p className="faint center">
          计分端支持离线记录：断网时事件先存本地 IndexedDB，恢复网络后自动幂等补传，比分不会丢也不会重复。
        </p>
      </div>
    </div>
  );
}
