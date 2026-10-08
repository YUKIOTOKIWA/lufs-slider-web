/** Reusable streaming DSP. No AudioBuffer dependency; input PCM is never mutated. */
export interface ProcessingSettings {
  autoGainDb: number
  outputDb: number
  widthPercent: number
  limiterEnabled: boolean
  ceilingDb: number
}

export const DEFAULT_PROCESSING_SETTINGS: Readonly<ProcessingSettings> = Object.freeze({
  autoGainDb: 0, outputDb: 0, widthPercent: 100, limiterEnabled: true, ceilingDb: -1,
})

export function dbToLinear(db: number): number {
  return 10 ** (db / 20)
}

function finiteClamp(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

export function normalizeSettings(settings: Partial<ProcessingSettings>): ProcessingSettings {
  return {
    autoGainDb: finiteClamp(settings.autoGainDb!, 0, -120, 120),
    outputDb: finiteClamp(settings.outputDb!, 0, -6, 6),
    widthPercent: finiteClamp(settings.widthPercent!, 100, 0, 200),
    limiterEnabled: typeof settings.limiterEnabled === 'boolean' ? settings.limiterEnabled : true,
    ceilingDb: finiteClamp(settings.ceilingDb!, -1, -2, -0.1),
  }
}

/**
 * AUTO GAIN -> OUTPUT LEVEL -> mid/side WIDTH -> linked lookahead LIMITER.
 * Fixed 5ms delay in both limiter modes; storage depends only on rate/channels.
 * Sample-peak ceiling, not an oversampled true-peak/mastering limiter.
 */
export class StreamingProcessor {
  readonly latencySamples: number
  private readonly rings: Float64Array[]
  private readonly peakValues: Float64Array
  private readonly peakFrames: Float64Array
  private readonly smoothCoefficient: number
  private readonly attackCoefficient: number
  private readonly releaseCoefficient: number
  private target: ProcessingSettings
  private autoDb: number
  private outputDb: number
  private width: number
  private envelope = 1
  private frame = 0
  private ringIndex = 0
  private head = 0
  private tail = 0

  constructor(sampleRate: number, channels: number, settings: Partial<ProcessingSettings> = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels < 1 || channels > 32) {
      throw new Error('Invalid processing format')
    }
    this.latencySamples = Math.max(1, Math.round(sampleRate * 0.005))
    this.rings = Array.from({ length: channels }, () => new Float64Array(this.latencySamples + 1))
    this.peakValues = new Float64Array(this.latencySamples + 2)
    this.peakFrames = new Float64Array(this.latencySamples + 2)
    this.smoothCoefficient = 1 - Math.exp(-1 / (sampleRate * 0.02))
    this.attackCoefficient = 1 - Math.exp(-1 / (sampleRate * 0.0005))
    this.releaseCoefficient = 1 - Math.exp(-1 / (sampleRate * 0.08))
    this.target = normalizeSettings(settings)
    this.autoDb = this.target.autoGainDb
    this.outputDb = this.target.outputDb
    this.width = this.target.widthPercent / 100
  }

  setSettings(settings: Partial<ProcessingSettings>) {
    this.target = normalizeSettings({ ...this.target, ...settings })
  }

  /** Arbitrary block size; provide preallocated output channels matching the constructor. */
  process(input: readonly Float32Array[], output: readonly Float32Array[]) {
    const samples = output[0]?.length ?? 0
    const ringSize = this.latencySamples + 1
    const queueSize = this.peakValues.length
    for (let i = 0; i < samples; i++) {
      this.autoDb += (this.target.autoGainDb - this.autoDb) * this.smoothCoefficient
      this.outputDb += (this.target.outputDb - this.outputDb) * this.smoothCoefficient
      this.width += (this.target.widthPercent / 100 - this.width) * this.smoothCoefficient
      const gain = dbToLinear(this.autoDb) * dbToLinear(this.outputDb)
      let peak = 0
      for (let channel = 0; channel < this.rings.length; channel++) {
        let value = (input[channel]?.[i] ?? 0) * gain
        if (this.rings.length === 2) {
          const left = (input[0]?.[i] ?? 0) * gain
          const right = (input[1]?.[i] ?? 0) * gain
          const mid = (left + right) * 0.5
          const side = (left - right) * 0.5 * this.width
          value = channel === 0 ? mid + side : mid - side
        }
        // Guard invalid PCM; ordinary finite over-range audio goes through the limiter.
        if (!Number.isFinite(value)) value = 0
        this.rings[channel]![this.ringIndex] = value
        peak = Math.max(peak, Math.abs(value))
      }
      // Monotonic deque: linked maximum over the delayed sample and its lookahead.
      while (this.head !== this.tail && this.peakFrames[this.head]! < this.frame - this.latencySamples) {
        this.head = (this.head + 1) % queueSize
      }
      while (this.head !== this.tail) {
        const previous = (this.tail + queueSize - 1) % queueSize
        if (this.peakValues[previous]! > peak) break
        this.tail = previous
      }
      this.peakValues[this.tail] = peak
      this.peakFrames[this.tail] = this.frame
      this.tail = (this.tail + 1) % queueSize
      // Leave room for final Float32 rounding, so stored samples respect the ceiling.
      const ceiling = dbToLinear(this.target.ceilingDb) * (1 - 1e-7)
      const futurePeak = this.peakValues[this.head]!
      const requiredGain = futurePeak > ceiling ? ceiling / futurePeak : 1
      const coefficient = requiredGain < this.envelope ? this.attackCoefficient : this.releaseCoefficient
      this.envelope += (requiredGain - this.envelope) * coefficient
      const readIndex = (this.ringIndex + 1) % ringSize
      let delayedPeak = 0
      for (const ring of this.rings) delayedPeak = Math.max(delayedPeak, Math.abs(ring[readIndex]!))
      // A shared scalar safety bound covers abrupt ceiling changes and attack rounding.
      // It scales both channels together rather than clipping individual samples.
      const safeGain = delayedPeak > ceiling ? ceiling / delayedPeak : 1
      const limiterGain = this.target.limiterEnabled ? Math.min(this.envelope, safeGain) : 1
      for (let channel = 0; channel < output.length; channel++) {
        output[channel]![i] = (this.rings[channel]?.[readIndex] ?? 0) * limiterGain
      }
      this.ringIndex = readIndex
      this.frame++
    }
  }
}
