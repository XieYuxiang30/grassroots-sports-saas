import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '@/services/api';

/**
 * 扫码落地页 `/m/:code`。
 *
 * 二维码里放的就是这个地址，所以它是**所有观众的入口**，必须做到：
 *   1. 不需要任何操作就自动进直播间（少一步点击就少一批走掉的用户）；
 *   2. 分享码解析要宽容：大小写、空格、被聊天软件加了参数都要能认；
 *   3. 失败时给出可操作的建议（手输分享码、去首页看进行中的比赛），不要一个红叉了事。
 */
export default function JoinPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound' | 'error'>('loading');
  const [message, setMessage] = useState<string>('正在进房…');

  useEffect(() => {
    if (!code) {
      setStatus('notfound');
      setMessage('链接里没有分享码');
      return;
    }
    let cancelled = false;

    void api
      .getMatchByCode(code)
      .then((detail) => {
        if (cancelled) return;
        setStatus('ok');
        setMessage(`已找到比赛：${detail.match.competition} · ${detail.match.title}，正在进入…`);
        navigate(`/live/${detail.match.id}`, { replace: true });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'SHARE_CODE_NOT_FOUND') {
          setStatus('notfound');
          setMessage(`没有找到分享码 ${code.toUpperCase()} 对应的比赛`);
        } else {
          setStatus('error');
          setMessage(`进入比赛失败：${(error as Error).message}`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, navigate]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>扫码观赛</h1>
        <Link className="btn btn-ghost" to="/">
          首页
        </Link>
      </div>
      <div className="page-body" style={{ maxWidth: 460 }}>
        <div className="card stack center" style={{ textAlign: 'center' }}>
          {status === 'loading' || status === 'ok' ? <div className="spinner" /> : null}
          <div>{message}</div>
          <div className="share-code">{code.toUpperCase()}</div>
          {status === 'notfound' || status === 'error' ? (
            <>
              <p className="faint">
                可能原因：分享码输错了、比赛已被删除，或者后端未启动。请向计分员确认大屏上的分享码。
              </p>
              <Link className="btn btn-primary btn-block" to="/">
                去首页看进行中的比赛
              </Link>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
