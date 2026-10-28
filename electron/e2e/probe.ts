import * as fs from 'node:fs';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { withTimeout } from '../lib/async';
import { listViewEntries, listVideoSlots } from '../services/slot-registry';

/* ---------------- 冒烟/E2E 探针（--lm-smoke 启动参数触发；原嵌在 createWindow 内） ---------------- */

/** LM_E2E=1 时注入 UI 渲染层的端到端脚本（在页面上下文执行，返回断言结果对象）。
 *  直接跑在真实用户数据上：收藏夹先快照、结束完整还原，对用户数据零副作用。 */
export const E2E_PROBE_SCRIPT = `(async () => {
  const out = {};
  const modal = document.getElementById('modalBack');
  out.modalInitiallyHidden = modal.classList.contains('hidden');
  // 普通网页地址（bilibili 主页）：提交后应停留在对话框并给出友好提示，
  // 不会关闭对话框去打开原始页面
  document.querySelector('.placeholder').click();
  await new Promise((res) => setTimeout(res, 150));
  const badInput = document.getElementById('urlInput');
  badInput.value = 'https://www.bilibili.com/';
  badInput.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('addForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((res) => setTimeout(res, 200));
  out.webpageRejected = !modal.classList.contains('hidden');
  out.webpageErr = document.getElementById('addErr').textContent;
  document.getElementById('cancelBtn').click();
  await new Promise((res) => setTimeout(res, 150));
  const urls = [
    'https://live.bilibili.com/1986380859', // 直播中 → B站 API 直连
    'https://live.douyin.com/531854687617', // 抖音未开播（女流66）→ 捕获 enter 响应判定 → 未开播占位格
    'https://live.bilibili.com/21452505', // 未开播 → 未开播占位格
  ];
  for (const u of urls) {
    document.querySelector('.placeholder').click();
    await new Promise((res) => setTimeout(res, 150));
    const input = document.getElementById('urlInput');
    input.value = u;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('addForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 700));
  }
  // 确认后对话框应立即关闭（问题1场景），加载格立即出现
  out.modalClosedImmediately = modal.classList.contains('hidden');
  out.pendingShownDuringAdd = !!document.querySelector('.cell.pending');
  // 抖音解析最长约 15s：等全部格子就位（pending 格会被真实格替换）再断言
  for (let i = 0; i < 44 && document.querySelectorAll('.cell[data-id]:not(.pending)').length < urls.length; i++) {
    await new Promise((res) => setTimeout(res, 500));
  }
  out.streamCellCount = document.querySelectorAll('.cell[data-id]').length;
  out.offlineCellCount = document.querySelectorAll('.cell.kind-offline').length;
  out.pendingLeftAfterSettle = document.querySelectorAll('.cell.pending').length;
  out.videoCellCount = document.querySelectorAll('.cell[data-id] video').length;
  const dyChip = document.querySelector('.chip.douyin');
  out.douyinLoginClass = dyChip ? dyChip.className : 'none';
  // 播放中再次打开对话框（问题1场景）
  document.querySelector('.placeholder').click();
  await new Promise((res) => setTimeout(res, 300));
  out.modalOpenWithStreams = !modal.classList.contains('hidden');
  document.getElementById('cancelBtn').click();
  await new Promise((res) => setTimeout(res, 300));
  out.modalClosedAfterCancel = modal.classList.contains('hidden');
  // 双击副窗口 → 与主窗口互换
  const cellIds = () => [...document.querySelectorAll('.cell[data-id]')].map((c) => c.dataset.id);
  const beforeSwap = cellIds();
  const dbl = () => document.querySelector('.cell[data-id]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  if (beforeSwap.length >= 2) {
    document.querySelectorAll('.cell[data-id]')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 600));
    out.orderAfterSubDblClick = cellIds();
    // 双击主窗口 → 铺满；再次双击 → 还原
    dbl();
    await new Promise((res) => setTimeout(res, 600));
    out.focusOn = document.getElementById('stage').classList.contains('focus');
    dbl();
    await new Promise((res) => setTimeout(res, 600));
    out.focusOff = !document.getElementById('stage').classList.contains('focus');
    out.orderAfterAll = cellIds();
  }
  // E2E 直接跑在真实用户数据上：先快照收藏夹（含分组），结束后完整还原
  // （收藏测试按 url 去重保存，可能覆盖用户已有条目的别名）
  const favSnapshot = await window.lm.getFavoriteEntries();
  // 收藏流程：星标 → 输入别名 → 面板列表 → 点击添加
  const favBtnCell = document.querySelector('.cell[data-id] .cell-fav');
  if (favBtnCell) {
    favBtnCell.click();
    await new Promise((res) => setTimeout(res, 250));
    out.favModalShown = !document.getElementById('favBack').classList.contains('hidden');
    const ai = document.getElementById('favAlias');
    ai.value = 'E2E收藏';
    document.getElementById('favForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 500));
    // 记录本次写入的条目，测试末尾按 url 移除（save 按 url 去重，
    // 可能覆盖同名旧条目，按 url 删除才准确）
    out.favSavedUrl = (await window.lm.getFavoriteEntries()).find((f) => f.kind === 'item' && f.alias === 'E2E收藏')?.url ?? null;
    document.getElementById('favBtn').click();
    await new Promise((res) => setTimeout(res, 300));
    out.favPanelShown = !document.getElementById('favWrap').classList.contains('hidden');
    out.favItemCount = document.querySelectorAll('.fav-item').length;
    const before = document.querySelectorAll('.cell[data-id]').length;
    const first = document.querySelector('.fav-item');
    if (first) {
      first.click();
      await new Promise((res) => setTimeout(res, 4000)); // B站直连约 1-2s
      out.cellCountAfterFavAdd = document.querySelectorAll('.cell[data-id]').length - before;
      out.favPanelClosedAfterAdd = document.getElementById('favWrap').classList.contains('hidden');
    }
    document.getElementById('favClose').click();
    await new Promise((res) => setTimeout(res, 200));
  }
  // 收藏拖动排序（合成 DragEvent）：把「拖拽A」拖到「拖拽C」之后，应变为 B,C,A
  const favItemByAlias = (a) => [...document.querySelectorAll('.fav-item')]
    .find((it) => it.querySelector('.alias').textContent === a);
  const favAliases = () => [...document.querySelectorAll('.fav-item .alias')].map((e2) => e2.textContent);
  const dragFavs = [
    { url: 'https://live.bilibili.com/9001', platform: 'bilibili', alias: '拖拽A' },
    { url: 'https://live.bilibili.com/9002', platform: 'bilibili', alias: '拖拽B' },
    { url: 'https://live.douyin.com/9003', platform: 'douyin', alias: '拖拽C' },
  ];
  for (const saved of (await window.lm.getFavoriteEntries()).filter((e) => e.kind === 'item')) {
    if (dragFavs.some((d) => d.url === saved.url)) window.lm.removeFavorite(saved.url);
  }
  await new Promise((res) => setTimeout(res, 250));
  for (const f of dragFavs) window.lm.saveFavorite(f);
  await new Promise((res) => setTimeout(res, 400));
  document.getElementById('favBtn').click();
  await new Promise((res) => setTimeout(res, 250));
  const sub3 = (list) => ['拖拽A', '拖拽B', '拖拽C'].map((a) => list.indexOf(a));
  out.favOrderBeforeDrag = sub3(favAliases());
  const itemA = favItemByAlias('拖拽A');
  const itemC = favItemByAlias('拖拽C');
  const dt = new DataTransfer();
  itemA.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const rc = itemC.getBoundingClientRect();
  itemC.dispatchEvent(new DragEvent('dragover', {
    bubbles: true, cancelable: true, clientX: rc.left + 5, clientY: rc.bottom - 2, dataTransfer: dt,
  }));
  itemA.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await new Promise((res) => setTimeout(res, 400));
  out.favOrderAfterDrag = sub3(favAliases());
  out.favOrderPersisted = sub3(
    (await window.lm.getFavoriteEntries()).filter((e) => e.kind === 'item').map((f) => f.alias),
  );
  for (const f of dragFavs) window.lm.removeFavorite(f.url);
  document.getElementById('favClose').click();
  await new Promise((res) => setTimeout(res, 250));
  // 分组流程（全部用 E2E 专用数据，自清理）：新建 → 数据层移入 → 收起 → 级联删除
  window.lm.saveFavorite({ url: 'https://live.bilibili.com/9100', platform: 'bilibili', alias: '分组测试' });
  await new Promise((res) => setTimeout(res, 300));
  window.lm.createGroup('E2E分组');
  await new Promise((res) => setTimeout(res, 300));
  let entriesNow = await window.lm.getFavoriteEntries();
  const eg = entriesNow.find((e) => e.kind === 'group' && e.name === 'E2E分组');
  out.groupCreated = !!eg;
  if (eg) {
    window.lm.reorderFavorites(
      entriesNow.map((e) =>
        e.kind === 'group'
          ? { kind: 'group', id: e.id }
          : e.url === 'https://live.bilibili.com/9100'
            ? { kind: 'item', url: e.url, groupId: eg.id }
            : { kind: 'item', url: e.url, ...(e.groupId ? { groupId: e.groupId } : {}) },
      ),
    );
    await new Promise((res) => setTimeout(res, 300));
    entriesNow = await window.lm.getFavoriteEntries();
    out.itemMovedIntoGroup = !!entriesNow.find(
      (e) => e.kind === 'item' && e.url === 'https://live.bilibili.com/9100' && e.groupId === eg.id,
    );
    window.lm.toggleGroup(eg.id, true);
    await new Promise((res) => setTimeout(res, 300));
    document.getElementById('favBtn').click();
    await new Promise((res) => setTimeout(res, 250));
    out.groupRowCollapsed = !!document.querySelector('.fav-group[data-gid="' + eg.id + '"].collapsed');
    out.groupCollapsedHidesItems = !document.querySelector('.fav-item[data-gid="' + eg.id + '"]');
    window.lm.deleteGroup(eg.id);
    await new Promise((res) => setTimeout(res, 300));
    entriesNow = await window.lm.getFavoriteEntries();
    out.groupCascadeDeleted = !entriesNow.some(
      (e) => (e.kind === 'group' && e.id === eg.id) || (e.kind === 'item' && e.groupId === eg.id),
    );
    document.getElementById('favClose').click();
    await new Promise((res) => setTimeout(res, 250));
  }
  // 直连格右下角刷新按钮：点击后应显示「刷新中…」并触发重新解析
  const vCell = document.querySelector('.cell.kind-video[data-id]');
  const rBtn = vCell ? vCell.querySelector('.cell-refresh') : null;
  out.videoRefreshBtn = !!rBtn;
  if (rBtn) {
    rBtn.click();
    await new Promise((res) => setTimeout(res, 120));
    out.videoRefreshState = vCell.querySelector('.v-state').textContent;
  }
  // 未开播格刷新按钮：点击后显示「检测中…」，探测完成回到「仍未开播」
  //（主播已开播时该格会被替换为直连格，原元素从 DOM 脱离）
  const oCell = document.querySelector('.cell.kind-offline[data-id]');
  const oBtn = oCell ? oCell.querySelector('.cell-refresh') : null;
  out.offlineRefreshBtn = !!oBtn;
  if (oBtn) {
    oBtn.click();
    await new Promise((res) => setTimeout(res, 150));
    out.offlineHintDuringCheck = oCell.querySelector('.cell-offline .txt').textContent;
    for (let i = 0; i < 20 && oCell.isConnected
      && oCell.querySelector('.cell-offline .txt').textContent === '检测中…'; i++) {
      await new Promise((res) => setTimeout(res, 500));
    }
    out.offlineHintAfterCheck = oCell.isConnected
      ? oCell.querySelector('.cell-offline .txt').textContent
      : '已开播升级为直连格';
  }
  // 还原收藏夹到快照状态：删除 E2E 新增项、恢复被覆盖的别名/条目，
  // 并按快照顺序与分组归属整体重排（对用户数据零副作用）
  const favNow = await window.lm.getFavoriteEntries();
  for (const f of favNow) {
    if (f.kind === 'item' && !favSnapshot.some((s) => s.kind === 'item' && s.url === f.url)) {
      window.lm.removeFavorite(f.url);
    }
  }
  for (const s of favSnapshot) {
    if (s.kind !== 'item') continue;
    const c = (await window.lm.getFavoriteEntries()).find((f) => f.kind === 'item' && f.url === s.url);
    if (!c || c.alias !== s.alias || c.platform !== s.platform) {
      window.lm.saveFavorite({ url: s.url, platform: s.platform, alias: s.alias });
    }
  }
  await new Promise((res) => setTimeout(res, 250));
  window.lm.reorderFavorites(
    favSnapshot.map((s) =>
      s.kind === 'group'
        ? { kind: 'group', id: s.id }
        : { kind: 'item', url: s.url, ...(s.groupId ? { groupId: s.groupId } : {}) },
    ),
  );
  await new Promise((res) => setTimeout(res, 250));
  out.favoritesRestored =
    JSON.stringify(await window.lm.getFavoriteEntries()) === JSON.stringify(favSnapshot);
  return out;
})()`;

/** 冒烟收尾：可选 E2E（LM_E2E=1）→ 主进程侧诊断 → 截图 → 退出 */
export async function runSmokeSequence(win: BrowserWindow): Promise<void> {
  if (process.env.LM_E2E === '1') {
    try {
      const r = await win.webContents.executeJavaScript(E2E_PROBE_SCRIPT);
      console.log('[live-matrix] E2E ' + JSON.stringify(r));
    } catch (err) {
      console.log('[live-matrix] E2E 失败: ' + err);
    }
  }
  // 主进程侧最终视图位置（应回到网格布局：主窗口大格 + 副窗口小格）
  console.log(
    `[live-matrix] bounds:最终 ${JSON.stringify(listViewEntries().map(([id, e]) => ({ id, b: e.view.getBounds() })))}`,
  );
  // 直连视频格状态（UI 页面内 <video> 元素）
  try {
    const vs = await withTimeout(
      win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.cell[data-id] video')].map((v) => ({
          ready: v.readyState, paused: v.paused, w: v.videoWidth, t: Math.round(v.currentTime),
          state: (v.closest('.cell')?.querySelector('.v-state') || {}).textContent || '',
        }))`,
      ),
      3000,
    );
    console.log(`[live-matrix] diag videos=${JSON.stringify(vs)}`);
  } catch {
    /* 页面可能尚未就绪 */
  }
  // 直连槽位信息
  for (const [id, s] of listVideoSlots()) {
    console.log(`[live-matrix] diag direct=${id} src=${s.url} fmt=${s.media.format} qn=${s.media.qn ?? '?'}`);
  }
  // 主进程侧诊断：每个直播视图的 bounds 与页面内播放器几何
  for (const [id, e] of listViewEntries()) {
    let probe: unknown = null;
    try {
      probe = await e.view.webContents.executeJavaScript(`(() => {
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
        };
        return {
          url: location.href.slice(0, 80),
          ready: document.readyState,
          vp: [innerWidth, innerHeight],
          scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
          bodyClass: document.body ? document.body.className : '',
          videos: [...document.querySelectorAll('video')].map(rect),
          closeBtn: !!document.getElementById('lm-close-x'),
          refreshBtn: !!document.getElementById('lm-refresh-x'),
          key: [...document.querySelectorAll('#live-player,#playerWraper,#fullscreen-container,#player-ctnr,div[data-e2e="living-container"]')]
            .slice(0, 5)
            .map((el) => ({ id: el.id || el.getAttribute('data-e2e') || '', r: rect(el) })),
        };
      })()`);
    } catch {
      /* 页面可能尚未就绪 */
    }
    console.log(
      `[live-matrix] 诊断 view=${id} bounds=${JSON.stringify(e.view.getBounds())} probe=${JSON.stringify(probe)}`,
    );
  }
  // view 格页内右下角刷新按钮：点击后应触发整页 reload（navigation type 变为 reload）
  for (const [id, e] of listViewEntries()) {
    try {
      const hasBtn = await withTimeout(
        e.view.webContents.executeJavaScript(`!!document.getElementById('lm-refresh-x')`),
        3000,
      );
      if (!hasBtn) continue;
      await e.view.webContents.executeJavaScript(`document.getElementById('lm-refresh-x').click()`);
      await new Promise((res) => setTimeout(res, 1500));
      const navType = await withTimeout(
        e.view.webContents.executeJavaScript(`(performance.getEntriesByType('navigation')[0] || {}).type || ''`),
        3000,
      );
      console.log(`[live-matrix] view刷新按钮 id=${id} navType=${navType}`);
      break;
    } catch {
      /* 页面可能尚未就绪 */
    }
  }
  try {
    const img = await win.webContents.capturePage();
    if (img && !img.isEmpty()) {
      fs.writeFileSync('/tmp/lm-smoke.png', img.toPNG());
      console.log('[live-matrix] 冒烟截图: /tmp/lm-smoke.png');
    }
  } catch {
    /* 截图失败不影响退出码 */
  }
  app.quit();
}
