import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, MUTATION_CHANNELS } from '../shared/ipc.js'
import type { RendererApi } from '../shared/ipc.js'

/**
 * The entire capability surface available to the renderer.
 *
 * Named methods only — `ipcRenderer` itself is never exposed, so the renderer
 * cannot reach a channel that is not listed here. Every payload is re-validated
 * against a Zod schema in the main process before it reaches a repository.
 */
const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>

const api: RendererApi = {
  status: () => invoke(CHANNELS.appStatus),
  listCategories: () => invoke(CHANNELS.categoriesList),
  categoryDetail: (req) => invoke(CHANNELS.categoryDetail, req),
  categoryRows: (req) => invoke(CHANNELS.categoryRows, req),
  componentDetail: (req) => invoke(CHANNELS.componentDetail, req),
  search: (req) => invoke(CHANNELS.search, req),
  resync: () => invoke(CHANNELS.resync),

  createComponent: (req) => invoke(MUTATION_CHANNELS.componentCreate, req),
  updateComponent: (req) => invoke(MUTATION_CHANNELS.componentUpdate, req),
  deleteComponent: (req) => invoke(MUTATION_CHANNELS.componentDelete, req),
  setPackage: (req) => invoke(MUTATION_CHANNELS.packageSet, req),
  confirmPackage: (req) => invoke(MUTATION_CHANNELS.packageConfirm, req),
  setSpec: (req) => invoke(MUTATION_CHANNELS.specSet, req),
  categorySpecs: (req) => invoke(MUTATION_CHANNELS.categorySpecs, req),

  createProfile: (req) => invoke(MUTATION_CHANNELS.profileCreate, req),
  setDefaultProfile: (req) => invoke(MUTATION_CHANNELS.profileSetDefault, req),
  setOverride: (req) => invoke(MUTATION_CHANNELS.profileSetOverride, req),
  addExternal: (req) => invoke(MUTATION_CHANNELS.externalAdd, req),
  updateExternal: (req) => invoke(MUTATION_CHANNELS.externalUpdate, req),
  deleteExternal: (req) => invoke(MUTATION_CHANNELS.externalDelete, req),

  compare: (req) => invoke(MUTATION_CHANNELS.compare, req),
  exportJson: () => invoke(MUTATION_CHANNELS.exportJson),
  exportCsv: (req) => invoke(MUTATION_CHANNELS.exportCsv, req),
  providerStatus: () => invoke(MUTATION_CHANNELS.providerStatus),

  listSpecDefs: (req) => invoke(MUTATION_CHANNELS.specDefsList, req),
  addSpecDef: (req) => invoke(MUTATION_CHANNELS.specDefAdd, req),
  removeSpecDef: (req) => invoke(MUTATION_CHANNELS.specDefRemove, req),
  updateSpecDef: (req) => invoke(MUTATION_CHANNELS.specDefUpdate, req),
  dimensions: () => invoke(MUTATION_CHANNELS.dimensions),
  leaders: (req) => invoke(MUTATION_CHANNELS.leaders, req),

  ingestDatasheet: (req) => invoke(MUTATION_CHANNELS.ingestDatasheet, req),
  applyReview: (req) => invoke(MUTATION_CHANNELS.applyReview, req),
  discardReview: (req) => invoke(MUTATION_CHANNELS.discardReview, req),
  getAiSettings: () => invoke(MUTATION_CHANNELS.aiSettingsGet),
  setAiSettings: (req) => invoke(MUTATION_CHANNELS.aiSettingsSet, req),
}

contextBridge.exposeInMainWorld('api', api)
