import { createProcessingChain } from './processing-chain'
import type { ProcessingChain } from './processing-chain'
import type { ProcessingSettings } from './processing-core'

export type PlaybackMode = 'original' | 'processed'
export const CROSSFADE_SECONDS = 0.02

/** Complementary linear gains avoid the level bump of equal-power fades on correlated audio. */
export class ComparisonCrossfade {
  private readonly original: AudioParam
  private readonly processed: AudioParam
  private from: number
  private to: number
  private start = 0
  private end = 0

  constructor(original: AudioParam, processed: AudioParam, mode: PlaybackMode, now: number) {
    this.original = original
    this.processed = processed
    this.from = this.to = mode === 'processed' ? 1 : 0
    original.setValueAtTime(1 - this.to, now)
    processed.setValueAtTime(this.to, now)
  }

  valueAt(time: number) {
    if (time >= this.end || this.end === this.start) return this.to
    if (time <= this.start) return this.from
    return this.from + (this.to - this.from) * (time - this.start) / (this.end - this.start)
  }

  select(mode: PlaybackMode, now: number) {
    const target = mode === 'processed' ? 1 : 0
    if (target === this.to) return
    const value = this.valueAt(now)
    for (const [param, current, next] of [
      [this.original, 1 - value, 1 - target], [this.processed, value, target],
    ] as const) {
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now)
      else param.cancelScheduledValues(now)
      param.setValueAtTime(current, now)
      param.linearRampToValueAtTime(next, now + CROSSFADE_SECONDS)
    }
    this.from = value
    this.to = target
    this.start = now
    this.end = now + CROSSFADE_SECONDS
  }
}

export interface ComparisonChain extends ProcessingChain {
  readonly processedAvailable: boolean
  readonly fallbackReason: string
  setMode(mode: PlaybackMode): void
  onFallback(handler: () => void): void
}

/** One source feeds both paths continuously; only complementary output gains change. */
export async function createComparisonChain(
  context: AudioContext, channels: number, settings: ProcessingSettings, mode: PlaybackMode = 'processed',
): Promise<ComparisonChain> {
  const input = context.createGain()
  const original = context.createGain()
  const processed = context.createGain()
  let latencySeconds = Math.max(1, Math.round(context.sampleRate * 0.005)) / context.sampleRate
  const delay = context.createDelay(Math.max(0.1, latencySeconds))
  for (const node of [input, original, processed, delay]) {
    node.channelCount = channels
    node.channelCountMode = 'explicit'
    node.channelInterpretation = 'discrete'
  }
  delay.delayTime.value = latencySeconds
  // Mute everything until the async graph construction has completed.
  original.gain.value = processed.gain.value = 0
  let dsp: ProcessingChain | undefined
  let reason = ''
  let disposed = false
  let fallbackHandler: (() => void) | undefined
  try {
    try { dsp = await createProcessingChain(context, channels, settings, processed) }
    catch (error) { reason = error instanceof Error ? error.message : '音声処理を初期化できませんでした。' }
    if (dsp) {
      latencySeconds = dsp.latencySeconds
      delay.delayTime.value = latencySeconds
    }
    input.connect(delay)
    delay.connect(original)
    original.connect(context.destination)
    processed.connect(context.destination)
    if (dsp) input.connect(dsp.input)
  } catch (error) {
    dsp?.dispose()
    for (const node of [input, original, processed, delay]) node.disconnect()
    throw error
  }
  const fade = new ComparisonCrossfade(original.gain, processed.gain, dsp ? mode : 'original', context.currentTime)
  const onProcessorError = () => {
    if (disposed || !dsp) return
    const failed = dsp
    dsp = undefined
    reason = '音声処理でエラーが発生しました。'
    fade.select('original', context.currentTime)
    input.disconnect(failed.input)
    failed.input.removeEventListener('processorerror', onProcessorError)
    failed.dispose()
    fallbackHandler?.()
  }
  dsp?.input.addEventListener('processorerror', onProcessorError)
  return {
    input, latencySeconds,
    get processedAvailable() { return Boolean(dsp) },
    get fallbackReason() { return reason },
    update(next) { if (!disposed) dsp?.update(next) },
    setMode(next) { if (!disposed) fade.select(dsp ? next : 'original', context.currentTime) },
    onFallback(handler) { fallbackHandler = handler },
    dispose() {
      if (disposed) return
      disposed = true
      fallbackHandler = undefined
      dsp?.input.removeEventListener('processorerror', onProcessorError)
      dsp?.dispose()
      dsp = undefined
      for (const node of [input, original, processed, delay]) node.disconnect()
    },
  }
}
