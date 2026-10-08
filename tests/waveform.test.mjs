import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'
const compile = file => ts.transpile(readFileSync(new URL(file, import.meta.url), 'utf8'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
const url = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const coreUrl = url(compile('../src/audio/processing-core.ts'))
const { StreamingProcessor, dbToLinear, DEFAULT_PROCESSING_SETTINGS } = await import(coreUrl)
const renderUrl = url(compile('../src/audio/streaming-render.ts').replace("from './processing-core'", `from '${coreUrl}'`))
const { StreamingRender, PeakAccumulator, sharedAmplitudeScale } = await import(renderUrl)
const lufsUrl = url(compile('../src/lufs.ts'))
const accumulatorUrl = url(compile('../src/audio/processed-analysis.ts').replace("from '../lufs'", `from '${lufsUrl}'`).replace("from './streaming-render'", `from '${renderUrl}'`))
const { ProcessedAccumulator } = await import(accumulatorUrl)
const serviceCode = compile('../src/audio/processed-waveform.ts').replace(/^import workerUrl.*;$/m, "const workerUrl = '/test-worker.js';").replace("from './streaming-render'", `from '${renderUrl}'`).replace("from './processed-analysis'", `from '${accumulatorUrl}'`).replace("from './processing-core'", `from '${coreUrl}'`)
const { generateProcessedPeaks, generateProcessedAnalysis } = await import(url(serviceCode))
const workerCode = compile('../src/audio/waveform-worker.ts').replace(/^import .*;$/gm, '')
const settings = changes => ({ ...DEFAULT_PROCESSING_SETTINGS, ...changes })
function audio(channels, rate = 48000) { return { length: channels[0].length, sampleRate: rate, numberOfChannels: channels.length, getChannelData: c => channels[c] } }
function originalPeaks(channels) {
  const length = channels[0].length, peaks = new Float32Array(Math.min(4096, length))
  for (let b = 0; b < peaks.length; b++) for (let i = Math.floor(b * length / peaks.length); i < Math.floor((b + 1) * length / peaks.length); i++) for (const channel of channels) peaks[b] = Math.max(peaks[b], Math.abs(channel[i]))
  return peaks
}
function render(channels, config, chunk = 1024, rate = 48000) {
  const renderer = new StreamingRender(rate, channels.length, channels[0].length, config)
  const accumulator = new PeakAccumulator(channels[0].length)
  for (let offset = 0; offset < channels[0].length; offset += chunk) accumulator.add(renderer.push(channels.map(c => c.subarray(offset, offset + chunk))))
  accumulator.add(renderer.finish())
  return accumulator.peaks
}
test('bin boundaries, full length and final sample match ORIGINAL with neutral DSP', () => {
  for (const length of [1, 7, 239, 241, 4096, 10003, 16385]) {
    const channels = [Float32Array.from({ length }, (_, i) => Math.sin(i * .5) * .2)]
    channels[0][length - 1] = .75
    const expected = originalPeaks(channels)
    for (const chunk of [1, 128, 1024, 16384]) assert.deepEqual(render(channels, settings({ limiterEnabled: false }), chunk), expected)
  }
})
test('offline PCM matches the worklet DSP sample-for-sample and input PCM is unchanged', () => {
  const channels = [Float32Array.from({ length: 10003 }, (_, i) => Math.sin(i * .2)), Float32Array.from({ length: 10003 }, (_, i) => Math.cos(i * .4) * .4)]
  const copies = channels.map(c => c.slice())
  const config = settings({ autoGainDb: 5.6, outputDb: 2, widthPercent: 170, ceilingDb: -.5 })
  const dsp = new StreamingProcessor(48000, 2, config)
  const output = channels.map(() => new Float32Array(10003 + dsp.latencySamples))
  dsp.process(channels, output)
  const reference = originalPeaks(output.map(c => c.subarray(dsp.latencySamples)))
  assert.deepEqual(render(channels, config, 257), reference)
  assert.deepEqual(channels, copies)
})
test('AUTO/OUTPUT and actual mid-side cancellation affect peaks; mono width is stable', () => {
  const mono = new Float32Array(10003).fill(.2)
  const gained = render([mono], settings({ autoGainDb: 4.4, outputDb: 1.2, limiterEnabled: false }))
  assert.ok(Math.abs(gained[2000] - .2 * dbToLinear(5.6)) < 1e-6)
  const inverse = Float32Array.from(mono, x => -x)
  assert.ok(render([mono, inverse], settings({ widthPercent: 0 })).every(x => x === 0))
  assert.deepEqual(render([mono], settings({ widthPercent: 200 })), render([mono], settings({ widthPercent: 0 })))
})
test('limiter applies a real ceiling, while OFF retains peaks above full scale', () => {
  const input = new Float32Array(20003).fill(.6)
  input[20002] = 3
  const off = render([input], settings({ autoGainDb: 6, limiterEnabled: false }))
  assert.ok(off.at(-1) > 5)
  for (const ceilingDb of [-.1, -.5, -1, -2]) {
    const on = render([input], settings({ autoGainDb: 6, ceilingDb }))
    assert.ok(on.every(x => x <= dbToLinear(ceilingDb)))
  }
})
test('both displays use one amplitude scale, never individual normalization', () => {
  assert.equal(sharedAmplitudeScale(new Float32Array([.2]), new Float32Array([.8])), 1)
  assert.equal(sharedAmplitudeScale(new Float32Array([.2]), new Float32Array([2])), 2)
})
test('offline scratch storage is reused and only bounded peaks are retained', () => {
  const renderer = new StreamingRender(48000, 1, 32768, settings({ limiterEnabled: false }))
  const first = renderer.push([new Float32Array(16384)])
  const second = renderer.push([new Float32Array(16384)])
  assert.equal(first.channels[0].buffer, second.channels[0].buffer)
  const tail = renderer.finish()
  assert.equal(tail.offset + tail.channels[0].length, 32768)
  assert.equal(new PeakAccumulator(48_000 * 3600).peaks.length, 4096)
  assert.throws(() => renderer.finish(), /Incomplete/)
})
test('Worker service uses one transferred chunk at a time, matches fallback and respects abort', async () => {
  const saved = globalThis.Worker, workers = []
  class FakeWorker {
    stopped = false; chunkSizes = []
    constructor() {
      workers.push(this)
      const sandbox = { StreamingRender, PeakAccumulator, ProcessedAccumulator, postMessage: (data, transfer = []) => {
        const message = structuredClone(data, { transfer })
        queueMicrotask(() => { if (!this.stopped) this.onmessage({ data: message }) })
      } }
      vm.createContext(sandbox); vm.runInContext(workerCode, sandbox); this.scope = sandbox
    }
    postMessage(data, transfer = []) {
      if (data.type === 'chunk') this.chunkSizes.push(data.channels[0].length)
      const message = structuredClone(data, { transfer })
      queueMicrotask(() => { if (!this.stopped) this.scope.onmessage({ data: message }) })
    }
    terminate() { this.stopped = true }
  }
  try {
    const input = audio([Float32Array.from({ length: 50003 }, (_, i) => Math.sin(i * .1) * .8)])
    const copy = input.getChannelData(0).slice(), config = settings({ autoGainDb: 6 })
    globalThis.Worker = FakeWorker
    const analysisResult = await generateProcessedAnalysis(input, config)
    const workerResult = analysisResult.peaks
    const pcmRender = new StreamingRender(input.sampleRate, 1, input.length, config)
    const measured = new ProcessedAccumulator(input.sampleRate, 1, input.length)
    for (let i = 0; i < input.length; i += 4096) measured.add(pcmRender.push([copy.subarray(i, i + 4096)]))
    measured.add(pcmRender.finish())
    assert.deepEqual(analysisResult, measured.finish())
    assert.deepEqual(workerResult, render([copy], config))
    assert.ok(workers[0].chunkSizes.every(n => n <= 16384))
    assert.equal(workers[0].chunkSizes.reduce((a,b) => a+b), 50003)
    assert.equal(workers[0].stopped, true)
    assert.deepEqual(input.getChannelData(0), copy)
    const controller = new AbortController(), pending = generateProcessedPeaks(input, config, controller.signal)
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(workers.at(-1).stopped, true)
    globalThis.Worker = class { constructor() { throw Error('unavailable') } }
    assert.deepEqual(await generateProcessedPeaks(input, config), workerResult)
    const fallbackController = new AbortController(), fallback = generateProcessedPeaks(input, config, fallbackController.signal)
    fallbackController.abort(); await assert.rejects(fallback, { name: 'AbortError' })
  } finally { globalThis.Worker = saved }
})
