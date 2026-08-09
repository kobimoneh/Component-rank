import type { RendererApi } from '../shared/ipc.js'

declare global {
  interface Window {
    readonly api: RendererApi
  }
}

export {}
