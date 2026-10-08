/**
 * Integrated loudness for mono/stereo PCM, following BS.1770 / EBU R128.
 * Specification: https://www.itu.int/rec/R-REC-BS.1770
 * Rate-dependent K-weighting parameterization:
 * https://github.com/jiixyj/libebur128/blob/master/ebur128/ebur128.c
 * No downsampling, playback processing, or modification of the input PCM.
 */
type AudioData = Pick<AudioBuffer, 'sampleRate' | 'length' | 'numberOfChannels' | 'getChannelData'>
type Coefficients = readonly [number, number, number, number, number]

function kWeighting(sampleRate: number): [Coefficients, Coefficients] {
  const shelfK = Math.tan(Math.PI * 1681.974450955533 / sampleRate)
  const shelfQ = 0.7071752369554196
  const highGain = 10 ** (3.999843853973347 / 20)
  const middleGain = highGain ** 0.4996667741545416
  const shelfDenominator = 1 + shelfK / shelfQ + shelfK * shelfK
  const shelf: Coefficients = [
    (highGain + middleGain * shelfK / shelfQ + shelfK * shelfK) / shelfDenominator,
    2 * (shelfK * shelfK - highGain) / shelfDenominator,
    (highGain - middleGain * shelfK / shelfQ + shelfK * shelfK) / shelfDenominator,
    2 * (shelfK * shelfK - 1) / shelfDenominator,
    (1 - shelfK / shelfQ + shelfK * shelfK) / shelfDenominator,
  ]
  const highPassK = Math.tan(Math.PI * 38.13547087602444 / sampleRate)
  const highPassQ = 0.5003270373238773
  const highPassDenominator = 1 + highPassK / highPassQ + highPassK * highPassK
  // BS.1770 RLB numerator is [1, -2, 1], without normalization by a0.
  const highPass: Coefficients = [1, -2, 1,
    2 * (highPassK * highPassK - 1) / highPassDenominator,
    (1 - highPassK / highPassQ + highPassK * highPassK) / highPassDenominator,
  ]
  return [shelf, highPass]
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError')
}

/** Shared CURRENT/ACTUAL meter. Retains only 400ms rings and block energies. */
export class IntegratedLufsMeter {
  private readonly windowSize: number
  private readonly hopSize: number
  private readonly energies: Float64Array
  private readonly filters: [Coefficients, Coefficients]
  private readonly states: { ring: Float64Array; z: Float64Array; sum: number }[]
  private received = 0
  private readonly length: number
  constructor(rate: number, channels: number, length: number) {
    if (channels < 1 || channels > 2 || !Number.isInteger(channels)) throw new Error('LUFS解析はモノラル／ステレオ音源に対応しています。')
    if (!Number.isFinite(rate) || rate < 8000) throw new Error('このサンプルレートはLUFS解析に対応していません。')
    this.windowSize = Math.round(rate * 0.4)
    this.hopSize = Math.round(rate * 0.1)
    if (!Number.isInteger(length) || length < this.windowSize) throw new Error('LUFS解析には0.4秒以上の音源が必要です。')
    this.length = length
    this.energies = new Float64Array(Math.floor((length - this.windowSize) / this.hopSize) + 1)
    this.filters = kWeighting(rate)
    this.states = Array.from({ length: channels }, () => ({ ring: new Float64Array(this.windowSize), z: new Float64Array(4), sum: 0 }))
  }
  push(channels: readonly Float32Array[]) {
    const count = channels[0]?.length ?? 0
    if (channels.length !== this.states.length || channels.some(c => c.length !== count) || this.received + count > this.length) throw new Error('Invalid LUFS PCM chunk')
    const [shelf, highPass] = this.filters
    for (let channel = 0; channel < channels.length; channel++) {
      const state = this.states[channel]!, samples = channels[channel]!, z = state.z
      for (let i = 0; i < count; i++) {
        const weighted = shelf[0] * samples[i]! + z[0]!
        z[0] = shelf[1] * samples[i]! - shelf[3] * weighted + z[1]!
        z[1] = shelf[2] * samples[i]! - shelf[4] * weighted
        const output = highPass[0] * weighted + z[2]!
        z[2] = highPass[1] * weighted - highPass[3] * output + z[3]!
        z[3] = highPass[2] * weighted - highPass[4] * output
        const index = this.received + i, ringIndex = index % this.windowSize
        const square = output * output
        state.sum += square - state.ring[ringIndex]!
        state.ring[ringIndex] = square
        if (index + 1 >= this.windowSize && (index + 1 - this.windowSize) % this.hopSize === 0) {
          this.energies[(index + 1 - this.windowSize) / this.hopSize]! += Math.max(0, state.sum) / this.windowSize
        }
      }
    }
    this.received += count
  }
  /** null means silence or all complete blocks below the absolute gate. */
  finish(): number | null {
    if (this.received !== this.length) throw new Error('Incomplete LUFS PCM stream')
    const absoluteThreshold = 10 ** ((-70 + 0.691) / 10)
    let absoluteSum = 0, absoluteCount = 0
    for (const energy of this.energies) {
      if (!Number.isFinite(energy)) throw new Error('音声データからLUFSを計算できませんでした。')
      if (energy > absoluteThreshold) { absoluteSum += energy; absoluteCount++ }
    }
    if (!absoluteCount) return null
    const threshold = Math.max(absoluteThreshold, absoluteSum / absoluteCount / 10)
    let gatedSum = 0, gatedCount = 0
    for (const energy of this.energies) if (energy > threshold) { gatedSum += energy; gatedCount++ }
    return gatedCount ? -0.691 + 10 * Math.log10(gatedSum / gatedCount) : null
  }
}

export async function analyzeIntegratedLufs(audio: AudioData, signal?: AbortSignal): Promise<number | null> {
  checkAbort(signal)
  const meter = new IntegratedLufsMeter(audio.sampleRate, audio.numberOfChannels, audio.length)
  let sliceStart = performance.now()
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  for (let offset = 0; offset < audio.length; offset += 4096) {
    checkAbort(signal)
    meter.push(Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c).subarray(offset, offset + 4096)))
    if (offset === 0 || performance.now() - sliceStart >= 8) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      sliceStart = performance.now()
    }
  }
  checkAbort(signal)
  return meter.finish()
}
