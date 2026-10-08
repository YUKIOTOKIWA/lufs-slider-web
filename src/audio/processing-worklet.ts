import { StreamingProcessor } from './processing-core'
import type { ProcessingSettings } from './processing-core'

// Worklet globals are intentionally scoped to this module, not the UI's DOM types.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: typeof ProcessedAudioWorklet): void

class ProcessedAudioWorklet extends AudioWorkletProcessor {
  private readonly dsp: StreamingProcessor
  private disposed = false

  constructor(options: { processorOptions: { channels: number; settings: ProcessingSettings } }) {
    super()
    this.dsp = new StreamingProcessor(sampleRate, options.processorOptions.channels, options.processorOptions.settings)
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'settings') this.dsp.setSettings(event.data.settings)
      if (event.data?.type === 'dispose') {
        this.disposed = true
        this.port.close()
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.disposed) return false
    // Empty input is rendered as silence, allowing the lookahead tail to drain.
    this.dsp.process(inputs[0] ?? [], outputs[0] ?? [])
    return true
  }
}

registerProcessor('lufs-processed-audio', ProcessedAudioWorklet)
