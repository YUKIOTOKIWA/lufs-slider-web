import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'

function compile(file) {
  return ts.transpile(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  })
}
const core = await import(`data:text/javascript;base64,${Buffer.from(compile('../src/audio/processing-core.ts')).toString('base64')}`)
const { StreamingProcessor, dbToLinear, normalizeSettings } = core
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
const fill = (value, count = 4800) => new Float32Array(count).fill(value)
function render(input, settings, blockSize = 128, rate = 48000) {
  const dsp = new StreamingProcessor(rate, input.length, settings)
  const length = input[0].length
  const output = input.map(() => new Float32Array(length + dsp.latencySamples))
  for (let start = 0; start < output[0].length; start += blockSize) {
    const end = Math.min(start + blockSize, output[0].length)
    dsp.process(input.map(samples => samples.subarray(start, Math.min(end, length))), output.map(samples => samples.subarray(start, end)))
  }
  return output.map(samples => samples.slice(dsp.latencySamples))
}

test('GAIN uses 10^(dB/20); AUTO + OUTPUT are applied in series without mutating PCM', () => {
  near(dbToLinear(0), 1)
  near(dbToLinear(6), 1.9952623149688795)
  const input = [fill(0.1), fill(-0.04)]
  const copies = input.map(samples => samples.slice())
  const output = render(input, { autoGainDb: 4.4, outputDb: 1.2, limiterEnabled: false })
  for (let c = 0; c < 2; c++) {
    near(output[c][100], input[c][100] * 10 ** (5.6 / 20))
    assert.deepEqual(input[c], copies[c])
  }
})
test('M/S: 0% mono, 100% identity, 200% side expansion; mono is unaffected', () => {
  const input = [fill(0.6), fill(0.2)]
  for (const [widthPercent, expected] of [[0, [0.4, 0.4]], [100, [0.6, 0.2]], [200, [0.8, 0]]]) {
    const output = render(input, { widthPercent, limiterEnabled: false })
    near(output[0][100], expected[0]); near(output[1][100], expected[1])
    near((output[0][100] + output[1][100]) / 2, 0.4)
  }
  near(render([fill(0.6)], { widthPercent: 200, limiterEnabled: false })[0][100], 0.6)
})
test('streaming result does not depend on render block size and drains the final sample', () => {
  const input = [Float32Array.from({ length: 3000 }, (_, i) => 0.2 * Math.sin(i / 9))]
  input[0][2999] = 0.4
  const expected = render(input, { limiterEnabled: false }, 128)
  for (const size of [1, 64, 257, 1024]) assert.deepEqual(render(input, { limiterEnabled: false }, size), expected)
  assert.equal(expected[0][2999], input[0][2999])
})
test('linked limiter respects every ceiling after AUTO/OUTPUT/WIDTH, including transients', () => {
  const left = Float32Array.from({ length: 48000 }, (_, i) => i % 997 === 0 ? 10 : 2 * Math.sin(i / 7))
  const right = Float32Array.from(left, x => x * 0.25)
  for (const ceilingDb of [-0.1, -0.5, -1, -2]) {
    const output = render([left, right], { autoGainDb: 6, outputDb: 6, widthPercent: 200, ceilingDb })
    const ceiling = dbToLinear(ceilingDb)
    for (let i = 0; i < left.length; i++) {
      assert.ok(Math.abs(output[0][i]) <= ceiling)
      assert.ok(Math.abs(output[1][i]) <= ceiling)
      // Width 200 maps L=x, R=.25x to L=1.375x, R=-.125x.
      near(output[1][i], -output[0][i] / 11)
    }
  }
})
test('limiter attenuates an entire sine waveform rather than flat-topping it', () => {
  const sine = Float32Array.from({ length: 48000 }, (_, i) => 2 * Math.sin(2 * Math.PI * 1000 * i / 48000))
  const result = render([sine], {})[0].slice(24000)
  let squareSum = 0, peak = 0
  for (const sample of result) { squareSum += sample * sample; peak = Math.max(peak, Math.abs(sample)) }
  near(peak / Math.sqrt(squareSum / result.length), Math.SQRT2, 0.01)
})
test('OFF bypasses attenuation with the same latency; lowering ceiling stays safe immediately', () => {
  const dsp = new StreamingProcessor(48000, 1, { limiterEnabled: false })
  const source = [fill(2, 4096)], output = [fill(0, 4096)]
  dsp.process(source, output)
  assert.equal(output[0][1000], 2)
  dsp.setSettings({ limiterEnabled: true, ceilingDb: -2 })
  dsp.process(source, output)
  assert.ok(output[0].every(value => Math.abs(value) <= dbToLinear(-2)))
  dsp.setSettings({ limiterEnabled: false })
  dsp.process(source, output)
  assert.equal(output[0][1000], 2)
})
test('slider updates ramp without reallocating storage, and invalid settings stay finite', () => {
  const dsp = new StreamingProcessor(48000, 1, { limiterEnabled: false })
  const rings = dsp.rings
  const input = [fill(0.1, 48000)], output = [fill(0, 48000)]
  dsp.process(input, output)
  dsp.setSettings({ autoGainDb: 6, outputDb: 6, widthPercent: 200 })
  dsp.process(input, output)
  near(output[0][0], 0.1)
  near(output[0][47999], 0.1 * dbToLinear(12))
  assert.equal(dsp.rings, rings)
  assert.equal(rings[0].length, 241)
  assert.deepEqual(normalizeSettings({ autoGainDb: NaN, outputDb: Infinity, widthPercent: -5, ceilingDb: 2 }), {
    autoGainDb: 0, outputDb: 0, widthPercent: 0, ceilingDb: -0.1, limiterEnabled: true,
  })
})
test('lookahead ducks before a transient and releases smoothly afterwards', () => {
  const input = fill(0.1, 48000); input[12000] = 5
  const output = render([input], {})[0]
  assert.ok(output[11990] < 0.03)
  near(output[12000], dbToLinear(-1), 1e-4)
  assert.ok(output[12001] < 0.03)
  assert.ok(output[47999] > 0.099)
})
test('AudioWorklet wrapper handles messages, empty input and disposal', () => {
  let Registered
  class Base { port = { onmessage: null, close() {} } }
  const sandbox = { StreamingProcessor, sampleRate: 48000, AudioWorkletProcessor: Base, registerProcessor(name, cls) { assert.equal(name, 'lufs-processed-audio'); Registered = cls } }
  vm.createContext(sandbox)
  vm.runInContext(compile('../src/audio/processing-worklet.ts').replace(/^import .*;$/gm, ''), sandbox)
  const worklet = new Registered({ processorOptions: { channels: 1, settings: { limiterEnabled: false } } })
  const output = [[fill(0, 512)]]
  assert.equal(worklet.process([[fill(0.2, 512)]], output), true)
  near(output[0][0][300], 0.2)
  worklet.port.onmessage({ data: { type: 'settings', settings: { outputDb: -6 } } })
  assert.equal(worklet.process([], output), true)
  worklet.port.onmessage({ data: { type: 'dispose' } })
  assert.equal(worklet.process([], output), false)
})
test('processing graph loads one module per context, preserves channel count, updates and disposes', async () => {
  const instances = []
  class Node {
    constructor(context, name, options) { this.options = options; this.messages = []; this.port = { postMessage: msg => this.messages.push(msg), close: () => { this.closed = true } }; instances.push(this) }
    connect(target) { this.target = target }
    disconnect() { this.disconnected = true }
  }
  const sandbox = { AudioWorkletNode: Node, normalizeSettings, workletUrl: '/mock-worklet.js' }
  vm.createContext(sandbox)
  vm.runInContext(compile('../src/audio/processing-chain.ts').replace(/^import .*;$/gm, '').replace(/^export /gm, ''), sandbox)
  let loads = 0
  sandbox.context = { sampleRate: 48000, destination: {}, audioWorklet: { async addModule(url) { assert.equal(url, '/mock-worklet.js'); loads++ } } }
  const a = await vm.runInContext('createProcessingChain(context, 2, {})', sandbox)
  const b = await vm.runInContext('createProcessingChain(context, 1, {})', sandbox)
  assert.equal(loads, 1)
  assert.equal(instances[0].options.channelCountMode, 'explicit')
  assert.equal(instances[0].options.outputChannelCount[0], 2)
  assert.equal(instances[1].options.outputChannelCount[0], 1)
  near(a.latencySeconds, 0.005)
  a.update({ outputDb: 3 }); assert.equal(instances[0].messages[0].settings.outputDb, 3)
  a.dispose(); a.dispose(); a.update({ outputDb: 2 })
  assert.equal(instances[0].messages.length, 2)
  assert.equal(instances[0].messages[1].type, 'dispose')
  assert.equal(instances[0].closed, true); assert.equal(instances[0].disconnected, true)
  b.dispose()
  await assert.rejects(vm.runInContext('createProcessingChain(context, 6, {})', sandbox), /モノラル／ステレオ/)
})
