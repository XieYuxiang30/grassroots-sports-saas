import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * 分享卡片：把「扫码进房」这件事做扎实。
 *
 * 现场的现实约束：
 *   - 观众可能用微信扫一扫 → 必须是可扫的**真实图片**，不是 canvas 截图；
 *   - 主办方要把二维码投到大屏上 → 需要足够大、对比度足够高；
 *   - 也可能口头报码 → 同时把 6 位分享码用大字显示出来。
 * 因此这里生成 dataURL 图片，并提供「复制链接」「下载二维码」两个实用动作。
 */
export interface ShareCardProps {
  shareCode: string;
  shareUrl: string;
  matchTitle?: string;
  compact?: boolean;
}

export function ShareCard({ shareCode, shareUrl, matchTitle, compact = false }: ShareCardProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(shareUrl, {
      width: 512,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b1220', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shareUrl]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="card">
      <p className="card-title">观众扫码看实时比分</p>
      <div className="qr-wrap">
        {qrDataUrl ? (
          <img src={qrDataUrl} alt={`比赛 ${shareCode} 的扫码链接`} />
        ) : (
          <div className="spinner" aria-label="二维码生成中" />
        )}
        <div className="share-code">{shareCode}</div>
        <div className="faint">扫码或手输分享码（不区分大小写）</div>
        {!compact ? (
          <>
            <div className="faint" style={{ wordBreak: 'break-all', textAlign: 'center' }}>
              {matchTitle ? `${matchTitle} · ` : ''}
              {shareUrl}
            </div>
            <div className="row" style={{ width: '100%' }}>
              <button type="button" className="btn" onClick={copy}>
                {copied ? '已复制' : '复制观赛链接'}
              </button>
              {qrDataUrl ? (
                <a className="btn" href={qrDataUrl} download={`hoop-${shareCode}.png`} style={{ textAlign: 'center' }}>
                  下载二维码
                </a>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
