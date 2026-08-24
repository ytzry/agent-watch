/**
 * 屏幕常亮（Wake Lock）：打开页面即保持屏幕不熄屏（手机看板场景）
 *
 * 实现：Screen Wake Lock API（navigator.wakeLock.request('screen')）
 * - 支持：Chrome/Edge 84+、Safari 16.4+（iOS 需 PWA/添加到主屏幕才有意义）
 * - 限制：仅 HTTPS/localhost 可用；移动端页面不可见（切后台/锁屏）时系统会
 *   自动释放 wake lock，页面重新可见后需重新请求（本模块自动恢复）
 */

let sentinel = null;

/** 浏览器是否支持 Wake Lock API */
export function isWakeLockSupported() {
  return typeof navigator !== 'undefined' && !!navigator.wakeLock;
}

/**
 * 请求屏幕常亮（幂等：已持有则不做任何事）。
 * @returns {Promise<boolean>} 是否成功持有
 */
export async function acquireWakeLock() {
  if (!isWakeLockSupported()) return false;
  if (sentinel) return true;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
    return true;
  } catch {
    // 页面不可见时会被拒绝（NotAllowedError），由 visibilitychange 恢复逻辑兜底
    return false;
  }
}

/**
 * 页面可见性恢复时重建 wake lock（切后台/锁屏期间系统已自动释放）。
 * @returns {() => void} 取消监听的清理函数
 */
export function watchVisibilityForWakeLock() {
  const onVisibility = () => {
    if (document.visibilityState === 'visible') acquireWakeLock();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}
