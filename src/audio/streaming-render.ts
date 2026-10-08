import { StreamingProcessor } from './processing-core'
import type { ProcessingSettings } from './processing-core'

export interface RenderBlock { offset: number; channels: Float32Array[] }

/** Shared offline PCM engine for waveform generation and future export.
 * Same DSP as the AudioWorklet. Removes leading lookahead and drains its tail,
 * so returned samples retain the original length/time axis. Consume each block
 * before calling push/finish again: output views reuse bounded scratch storage.
 */
export class StreamingRender {
  private readonly dsp: StreamingProcessor
  private readonly scratch: Float32Array[]
  private readonly length: number
  private received = 0
  private rendered = 0
  private emitted = 0
  private finished = false

  constructor(rate: number, channels: number, length: number, settings: ProcessingSettings, capacity = 16384) {
    if (!Number.isInteger(length) || length < 1) throw new Error('Invalid audio length')
    this.dsp = new StreamingProcessor(rate, channels, settings)
    this.length = length
    this.scratch = Array.from({ length: channels }, () => new Float32Array(Math.max(capacity, this.dsp.latencySamples)))
  }

  push(input: readonly Float32Array[]): RenderBlock {
    const count = input[0]?.length ?? 0
    if (this.finished || input.length !== this.scratch.length || input.some(channel => channel.length !== count)
      || count > this.scratch[0]!.length || this.received + count > this.length) throw new Error('Invalid PCM chunk')
    this.received += count
    return this.render(input, count)
  }

  finish(): RenderBlock {
    if (this.finished || this.received !== this.length) throw new Error('Incomplete PCM stream')
    this.finished = true
    return this.render([], this.dsp.latencySamples)
  }

  private render(input: readonly Float32Array[], count: number): RenderBlock {
    const output = this.scratch.map(channel => channel.subarray(0, count))
    this.dsp.process(input, output)
    const skip = Math.min(count, Math.max(0, this.dsp.latencySamples - this.rendered))
    const size = Math.min(count - skip, this.length - this.emitted)
    const block = { offset: this.emitted, channels: output.map(channel => channel.subarray(skip, skip + size)) }
    this.rendered += count
    this.emitted += size
    return block
  }
}

/** Same bin boundaries as Phase 1's ORIGINAL peak aggregation. No normalization. */
export class PeakAccumulator {
  readonly peaks: Float32Array
  private readonly length: number
  constructor(length: number) {
    if (!Number.isInteger(length) || length < 1) throw new Error('Invalid audio length')
    this.length = length
    this.peaks = new Float32Array(Math.min(4096, length))
  }
  add(block: RenderBlock) {
    for (let i = 0; i < (block.channels[0]?.length ?? 0); i++) {
      const bin = Math.min(this.peaks.length - 1, Math.ceil((block.offset + i + 1) * this.peaks.length / this.length) - 1)
      for (const channel of block.channels) this.peaks[bin] = Math.max(this.peaks[bin]!, Math.abs(channel[i]!))
    }
  }
}

/** One shared scale, including over-full-scale samples when the limiter is OFF. */
export function sharedAmplitudeScale(original: Float32Array, processed: Float32Array): number {
  let scale = 1
  for (const values of [original, processed]) for (const value of values) if (Number.isFinite(value)) scale = Math.max(scale, value)
  return scale
}
