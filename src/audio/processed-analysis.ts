import { IntegratedLufsMeter } from '../lufs'
import { PeakAccumulator } from './streaming-render'
import type { RenderBlock } from './streaming-render'
export interface ProcessedAnalysis { peaks: Float32Array; actualLufs: number | null; analysisError: string }

/** Fan out each rendered block before scratch reuse; never retains processed PCM. */
export class ProcessedAccumulator {
  private readonly peaks: PeakAccumulator
  private meter?: IntegratedLufsMeter
  private error = ''
  constructor(rate: number, channels: number, length: number) {
    this.peaks = new PeakAccumulator(length)
    // Short tracks still have a usable waveform, just no Integrated LUFS.
    try { this.meter = new IntegratedLufsMeter(rate, channels, length) }
    catch (error) { this.error = error instanceof Error ? error.message : 'LUFS解析に失敗しました。' }
  }
  add(block: RenderBlock) {
    this.peaks.add(block)
    this.meter?.push(block.channels)
  }
  finish(): ProcessedAnalysis {
    return { peaks: this.peaks.peaks, actualLufs: this.meter?.finish() ?? null, analysisError: this.error }
  }
}
