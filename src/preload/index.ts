import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from '../shared/ipc.js'
import type {
  AppStatus,
  CategoryDetail,
  CategoryNavItem,
  CategoryRow,
  CategoryRowsRequest,
  ComponentDetail,
  IdRequest,
  RendererApi,
  SearchHit,
  SearchRequest,
  SlugRequest,
} from '../shared/ipc.js'

/**
 * The entire capability surface available to the renderer.
 *
 * Named methods only — `ipcRenderer` itself is never exposed, so the renderer
 * cannot reach a channel that is not listed here.
 */
const api: RendererApi = {
  status: () => ipcRenderer.invoke(CHANNELS.appStatus) as Promise<AppStatus>,
  listCategories: () => ipcRenderer.invoke(CHANNELS.categoriesList) as Promise<CategoryNavItem[]>,
  categoryDetail: (req: SlugRequest) =>
    ipcRenderer.invoke(CHANNELS.categoryDetail, req) as Promise<CategoryDetail | null>,
  categoryRows: (req: CategoryRowsRequest) =>
    ipcRenderer.invoke(CHANNELS.categoryRows, req) as Promise<CategoryRow[]>,
  componentDetail: (req: IdRequest) =>
    ipcRenderer.invoke(CHANNELS.componentDetail, req) as Promise<ComponentDetail | null>,
  search: (req: SearchRequest) => ipcRenderer.invoke(CHANNELS.search, req) as Promise<SearchHit[]>,
  resync: () => ipcRenderer.invoke(CHANNELS.resync) as Promise<AppStatus>,
}

contextBridge.exposeInMainWorld('api', api)
