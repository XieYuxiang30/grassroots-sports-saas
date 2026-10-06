import { useCallback, useEffect, useMemo, useState } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import { Button, Input, Text, View } from '@tarojs/components';
import type { MatchSummary } from '../../contracts';
import {
  ApiError,
  getHealth,
  listMatches,
  resolveShareCode,
  sortMatchesForDisplay,
} from '../../services/api';
import { LAST_SHARE_CODE_STORAGE_KEY } from '../../constants';
import { buildShareUrl, normalizeShareCodeInput, parseShareCode } from '../../utils/share-code';
import './index.css';

const WEB_ORIGIN = 'http://localhost:3000';

const STATUS_LABEL: Record<MatchSummary['status'], string> = {
  scheduled: '未开始',
  live: '进行中',
  finished: '已结束',
  archived: '已归档',
};

export default function IndexPage() {
  const [code, setCode] = useState('');
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [healthText, setHealthText] = useState<string>('正在检测后端…');

  const liveMatches = useMemo(
    () => sortMatchesForDisplay(matches).filter((item) => item.status === 'live'),
    [matches],
  );
  const otherMatches = useMemo(
    () => sortMatchesForDisplay(matches).filter((item) => item.status !== 'live'),
    [matches],
  );

  const checkHealth = useCallback(async () => {
    try {
      const health = await getHealth();
      setHealthText(`${health.service} v${health.version} · ${health.storageDriver}`);
    } catch {
      setHealthText('后端未连通（仍可尝试进入已缓存的房间）');
    }
  }, []);

  const loadMatches = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listMatches();
      setMatches(response.items ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '获取比赛列表失败');
      setMatches([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMatches();
    void checkHealth();
  }, [loadMatches, checkHealth]);

  // 从直播间返回时刷新列表（比分可能已经变了）。
  useDidShow(() => {
    void loadMatches();
  });

  const enterByCode = useCallback(async (rawCode: string) => {
    const parsed = parseShareCode(rawCode);
    if (!parsed) {
      setError('分享码应为 6 位字母数字，例如 ABC123');
      return;
    }
    setEntering(true);
    setError(null);
    try {
      const resolved = await resolveShareCode(parsed);
      try {
        Taro.setStorageSync(LAST_SHARE_CODE_STORAGE_KEY, parsed);
      } catch {
        // 存储失败不影响进入房间。
      }
      await Taro.navigateTo({ url: `/pages/live/index?matchId=${resolved.matchId}` });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `没有找到分享码 ${parsed} 对应的比赛`);
    } finally {
      setEntering(false);
    }
  }, []);

  const enterByMatchId = useCallback(async (matchId: string) => {
    setEntering(true);
    setError(null);
    try {
      await Taro.navigateTo({ url: `/pages/live/index?matchId=${matchId}` });
    } finally {
      setEntering(false);
    }
  }, []);

  const handleScan = useCallback(async () => {
    try {
      const result = await Taro.scanCode({ scanType: ['qrCode', 'barCode'] });
      const parsed = parseShareCode(result.result) ?? parseShareCode(result.path);
      if (!parsed) {
        setError(`二维码里没有分享码：${result.result || '(空)'}`);
        return;
      }
      setCode(parsed);
      await enterByCode(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 用户主动取消扫码不提示错误。
      if (!/cancel/i.test(message)) setError(`扫码失败：${message}`);
    }
  }, [enterByCode]);

  const handleCopyShareUrl = useCallback(async (shareCode: string) => {
    try {
      await Taro.setClipboardData({ data: buildShareUrl(WEB_ORIGIN, shareCode) });
      await Taro.showToast({ title: '链接已复制', icon: 'success' });
    } catch {
      await Taro.showToast({ title: '复制失败', icon: 'none' });
    }
  }, []);

  const renderMatch = (item: MatchSummary) => (
    <View key={item.id} className="match" onClick={() => void enterByMatchId(item.id)}>
      <View className="match__head">
        <Text className="match__title">{item.title || item.competition}</Text>
        <Text className={`match__status match__status--${item.status}`}>
          {STATUS_LABEL[item.status]}
        </Text>
      </View>
      <View className="match__score">
        <Text className="match__team">{item.homeName}</Text>
        <Text className="match__digits">{item.scoreText || `${item.homeScore} : ${item.awayScore}`}</Text>
        <Text className="match__team">{item.awayName}</Text>
      </View>
      <View className="match__foot">
        <Text className="muted">
          {item.competition}
          {item.venue ? ` · ${item.venue}` : ''}
        </Text>
        <Text className="match__code" onClick={() => void handleCopyShareUrl(item.shareCode)}>
          码 {item.shareCode}
        </Text>
      </View>
    </View>
  );

  return (
    <View className="page">
      <View className="card hero">
        <Text className="hero__title">扫码看实时比分</Text>
        <Text className="hero__sub">输入 6 位分享码，或直接扫现场的二维码</Text>
        <Input
          className="hero__input"
          type="text"
          value={code}
          maxlength={6}
          placeholder="ABC123"
          placeholderClass="hero__placeholder"
          onInput={(event) => setCode(normalizeShareCodeInput(event.detail.value))}
          onConfirm={() => void enterByCode(code)}
        />
        <View className="hero__actions">
          <Button
            className="btn btn--primary"
            loading={entering}
            disabled={entering || code.length < 6}
            onClick={() => void enterByCode(code)}
          >
            进入直播间
          </Button>
          <Button className="btn btn--ghost" onClick={() => void handleScan()}>
            扫一扫
          </Button>
        </View>
        {error ? <Text className="danger hero__error">{error}</Text> : null}
        <Text className="muted hero__health">后端：{healthText}</Text>
      </View>

      <View className="card">
        <View className="row row--between">
          <Text className="card__title">进行中（{liveMatches.length}）</Text>
          <Text className="muted" onClick={() => void loadMatches()}>
            {loading ? '刷新中…' : '刷新'}
          </Text>
        </View>
        {liveMatches.length === 0 ? (
          <Text className="muted">暂无进行中的比赛</Text>
        ) : (
          liveMatches.map(renderMatch)
        )}
      </View>

      <View className="card">
        <Text className="card__title">其他比赛（{otherMatches.length}）</Text>
        {otherMatches.length === 0 ? (
          <Text className="muted">暂无其他比赛</Text>
        ) : (
          otherMatches.slice(0, 20).map(renderMatch)
        )}
      </View>
    </View>
  );
}
