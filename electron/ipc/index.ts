import { registerFavoritesIpc } from './favorites';
import { registerLayoutIpc } from './layout';
import { registerLoginIpc } from './login';
import { registerStreamIpc } from './stream';
import { registerVolumeIpc } from './volume';
import { registerWinIpc } from './win';

/** IPC 总装配：按命名空间分文件注册。
 *  预留接缝：浏览页功能未来新增 ipc/browse.ts 并在此挂载 registerBrowseIpc()。 */
export function registerIpc(): void {
  registerStreamIpc();
  registerLayoutIpc();
  registerVolumeIpc();
  registerFavoritesIpc();
  registerLoginIpc();
  registerWinIpc();
}
