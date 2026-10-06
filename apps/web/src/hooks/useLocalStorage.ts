import { useCallback, useState } from 'react';

/**
 * localStorage 状态钩子（SSR / 隐私模式安全）。
 *
 * 用途：记住计分口令、上次进入的比赛、界面偏好。
 * 注意：**不用它存事件队列** —— 那是 IndexedDB 的活（见 src/offline/queue.ts），
 * 因为事件数据需要事务性与更大容量，而偏好设置丢失无关紧要。
 */
export function useLocalStorage(key: string, initialValue: string): [string, (value: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return window.localStorage.getItem(key) ?? initialValue;
    } catch {
      return initialValue;
    }
  });

  const update = useCallback(
    (next: string) => {
      setValue(next);
      try {
        if (next) window.localStorage.setItem(key, next);
        else window.localStorage.removeItem(key);
      } catch {
        // 隐私模式：内存里保留即可
      }
    },
    [key],
  );

  return [value, update];
}
