(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const scroller = document.scrollingElement || document.documentElement;

  document.addEventListener('click', function (event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const anchor = target.closest('a');
    if (!anchor) {
      return;
    }
    const href = anchor.getAttribute('href');
    if (!href) {
      return;
    }
    event.preventDefault();

    if (href.charAt(0) === '#') {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch (err) {
        /* 保留原值 */
      }
      const heading = document.getElementById(id);
      if (heading) {
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }

    vscode.postMessage({ type: 'openLink', href: href });
  });

  window.addEventListener('message', function (event) {
    const message = event.data || {};
    if (message.type !== 'content') {
      return;
    }
    // 流式刷新时保留滚动位置，不然每批更新都会弹回顶部
    const scrollTop = scroller.scrollTop;
    document.body.innerHTML = String(message.html || '');
    scroller.scrollTop = scrollTop;
  });
})();
