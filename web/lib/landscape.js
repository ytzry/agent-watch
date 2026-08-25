/**
 * 移动端强制横屏工具（home 全屏横屏 / 设置页随全屏保持横屏共用）
 *
 * 小屏竖屏全屏时把宿主旋转 90° 模拟横屏（宽=视口高、高=视口宽）。
 * transform 内联写入而非依赖 CSS 伪类，保证全屏态下旋转一定生效。
 */

/** 小屏判定：手机尺寸（任一边 < 600px）。大屏竖屏（平板/桌面窄窗）全屏不自动旋转 */
export function isSmallScreen() {
  return Math.min(window.innerWidth, window.innerHeight) < 600;
}

/** 当前是否处于「小屏竖屏 + 全屏」的强制横屏状态 */
export function isForceLandscape() {
  const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  return inFs && isSmallScreen() && window.innerHeight > window.innerWidth;
}

/** 竖屏旋转尺寸定位：宿主宽=视口高、高=视口宽，rotate(90deg) 后视觉居中 */
export function applyRotate(host) {
  const vw = window.innerWidth, vh = window.innerHeight;
  host.style.width = vh + 'px';
  host.style.height = vw + 'px';
  host.style.left = vw + 'px';
  host.style.top = '0px';
  host.style.transform = 'rotate(90deg)';
  host.style.transformOrigin = 'top left';
  const page = host.shadowRoot?.querySelector('.page');
  if (page) {
    page.style.width = vh + 'px';
    page.style.height = vw + 'px';
  }
  // 旋转后实际宽度 = 视口高，据此决定多列数（绕开容器查询兼容问题）
  host.style.setProperty('--landscape-cols', vh >= 1100 ? 3 : 2);
}

/** 清除旋转定位，恢复竖屏布局 */
export function resetRotate(host) {
  host.style.left = '';
  host.style.top = '';
  host.style.width = '';
  host.style.transform = '';
  host.style.transformOrigin = '';
  host.style.height = window.innerHeight + 'px';
  host.style.removeProperty('--landscape-cols');
  const page = host.shadowRoot?.querySelector('.page');
  if (page) { page.style.width = ''; page.style.height = ''; }
}

/** 按当前全屏/朝向状态同步宿主的强制横屏，返回是否处于旋转态 */
export function syncLandscapeState(host) {
  if (isForceLandscape()) {
    host.setAttribute('data-force-landscape', '');
    applyRotate(host);
    return true;
  }
  if (host.hasAttribute('data-force-landscape')) {
    host.removeAttribute('data-force-landscape');
    resetRotate(host);
  }
  return false;
}