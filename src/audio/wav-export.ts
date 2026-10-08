import { StreamingRender, PeakAccumulator } from './streaming-render'
import type { RenderBlock } from './streaming-render'
import { normalizeSettings } from './processing-core'
import type { ProcessingSettings } from './processing-core'

type AudioData = Pick<AudioBuffer, 'length' | 'sampleRate' | 'numberOfChannels' | 'getChannelData'>
export interface WavResult { blob: Blob; peaks: Float32Array; clippedSamples: number }

/** Classic RIFF PCM header. Reject unsupported sizes before processing starts. */
export function wavHeader(rate: number, channels: number, frames: number): Uint8Array<ArrayBuffer> {
  const size = frames * channels * 2
  if (![rate, channels, frames].every(Number.isSafeInteger) || rate < 1 || channels < 1 || channels > 2 || frames < 1
    || size > 0xffffffff - 36 || rate * channels * 2 > 0xffffffff) throw new Error('WAVのサイズまたは音源形式が対応範囲外です（モノラル／ステレオ、RIFF最大4 GB）。')
  const bytes = new Uint8Array(44), view = new DataView(bytes.buffer)
  const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i) }
  tag(0, 'RIFF'); view.setUint32(4, 36 + size, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true)
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, size, true)
  return bytes
}

/** Consumes the renderer's unmodified, ephemeral PCM immediately. Only encoded bytes survive. */
export class WavWriter {
  private readonly parts: Blob[]
  private readonly accumulator: PeakAccumulator
  private offset = 0
  private clippedSamples = 0
  private readonly channels: number
  private readonly frames: number
  constructor(rate: number, channels: number, frames: number) {
    this.channels = channels
    this.frames = frames
    this.parts = [new Blob([wavHeader(rate, channels, frames)])]
    this.accumulator = new PeakAccumulator(frames)
  }
  append(block: RenderBlock) {
    const count = block.channels[0]?.length ?? 0
    if (block.offset !== this.offset || block.channels.length !== this.channels || block.channels.some(c => c.length !== count)
      || this.offset + count > this.frames) throw new Error('Invalid WAV PCM block')
    this.accumulator.add(block)
    const bytes = new Uint8Array(count * this.channels * 2), view = new DataView(bytes.buffer)
    for (let i = 0; i < count; i++) for (let c = 0; c < this.channels; c++) {
      const sample = block.channels[c]![i]!
      if (Math.abs(sample) > 1) this.clippedSamples++
      const value = Number.isNaN(sample) ? 0 : Math.max(-1, Math.min(1, sample))
      view.setInt16((i * this.channels + c) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
    }
    if (count) this.parts.push(new Blob([bytes]))
    this.offset += count
  }
  finish(): WavResult {
    if (this.offset !== this.frames) throw new Error('Incomplete WAV PCM stream')
    return { blob: new Blob(this.parts, { type: 'audio/wav' }), peaks: this.accumulator.peaks, clippedSamples: this.clippedSamples }
  }
}
export function processedFilename(name: string): string {
  return `${name.replace(/\.[^.]+$/, '') || 'audio'}-LUFS-processed.wav`
}

/** Cooperative bounded streaming: avoids a second full PCM buffer and keeps playback running. */
export async function createProcessedWav(audio: AudioData, settings: ProcessingSettings, signal?: AbortSignal,
  progress: (percent: number) => void = () => {}): Promise<WavResult> {
  const check = () => { if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError') }
  check()
  const writer = new WavWriter(audio.sampleRate, audio.numberOfChannels, audio.length)
  const renderer = new StreamingRender(audio.sampleRate, audio.numberOfChannels, audio.length, normalizeSettings({ ...settings }))
  progress(0)
  let lastProgress = 0
  for (let offset = 0; offset < audio.length; offset += 4096) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    check()
    const end = Math.min(offset + 4096, audio.length)
    writer.append(renderer.push(Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c).subarray(offset, end))))
    const percent = Math.min(99, Math.floor(end / audio.length * 100))
    if (percent !== lastProgress) { lastProgress = percent; progress(percent) }
  }
  check()
  writer.append(renderer.finish()) // flush lookahead, trim to original frame count
  const result = writer.finish()
  progress(100)
  return result
}
