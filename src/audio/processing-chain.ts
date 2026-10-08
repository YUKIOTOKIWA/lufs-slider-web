import workletUrl from './processing-worklet.ts?worker&url'
import { normalizeSettings } from './processing-core'
import type { ProcessingSettings } from './processing-core'

export interface ProcessingChain {
  readonly input: AudioNode
  readonly latencySeconds: number
  update(settings: ProcessingSettings): void
  dispose(): void
}

const moduleLoads = new WeakMap<AudioContext, Promise<void>>()

/** Builds a small streaming graph; it never reads or copies the source AudioBuffer. */
export async function createProcessingChain(
  context: AudioContext, channels: number, settings: ProcessingSettings, destination: AudioNode = context.destination,
): Promise<ProcessingChain> {
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    throw new Error('AudioWorkletを利用できません。HTTPSまたはlocalhostと対応ブラウザを使用してください。')
  }
  // Unknown surround layouts can downmix after the limiter; preserve original playback.
  if (channels !== 1 && channels !== 2) throw new Error('PROCESSED再生はモノラル／ステレオ音源に対応しています。')
  let pending = moduleLoads.get(context)
  if (!pending) {
    pending = context.audioWorklet.addModule(workletUrl)
    moduleLoads.set(context, pending)
  }
  try { await pending } catch (error) { moduleLoads.delete(context); throw error }
  const node = new AudioWorkletNode(context, 'lufs-processed-audio', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels],
    channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete',
    processorOptions: { channels, settings: normalizeSettings(settings) },
  })
  try { node.connect(destination) } catch (error) {
    node.port.postMessage({ type: 'dispose' }); node.port.close(); throw error
  }
  let disposed = false
  return {
    input: node,
    latencySeconds: Math.max(1, Math.round(context.sampleRate * 0.005)) / context.sampleRate,
    update(next) { if (!disposed) node.port.postMessage({ type: 'settings', settings: normalizeSettings(next) }) },
    dispose() {
      if (disposed) return
      disposed = true
      node.disconnect()
      node.port.postMessage({ type: 'dispose' })
      node.port.close()
    },
  }
}
