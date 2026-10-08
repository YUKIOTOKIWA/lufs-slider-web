import { ProcessedAccumulator } from './processed-analysis'
import { StreamingRender } from './streaming-render'
import type { ProcessingSettings } from './processing-core'

type Request = { type: 'init'; rate: number; channels: number; length: number; settings: ProcessingSettings }
  | { type: 'chunk'; channels: Float32Array[] } | { type: 'finish' }
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Request>) => void
  postMessage(message: unknown, transfer?: Transferable[]): void
}
let renderer: StreamingRender
let accumulator: ProcessedAccumulator
scope.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      renderer = new StreamingRender(data.rate, data.channels, data.length, data.settings)
      accumulator = new ProcessedAccumulator(data.rate, data.channels, data.length)
    } else if (data.type === 'chunk') accumulator.add(renderer.push(data.channels))
    else if (data.type === 'finish') {
      accumulator.add(renderer.finish())
      const result = accumulator.finish()
      scope.postMessage({ type: 'done', ...result }, [result.peaks.buffer])
      return
    }
    scope.postMessage({ type: 'next' })
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Waveform processing failed' })
  }
}
