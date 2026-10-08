import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'

const compiled = ts.transpile(readFileSync(new URL('../src/audio/comparison-chain.ts', import.meta.url), 'utf8'), {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
}).replace(/^import .*;$/gm, '').replace(/^export /gm, '')
function harness(factory) {
  class Param {
    value = 1; events = []
    setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]) }
    linearRampToValueAtTime(value, time) { this.events.push(['ramp', value, time]) }
    cancelAndHoldAtTime(time) { this.events.push(['hold', time]) }
    cancelScheduledValues(time) { this.events.push(['cancel', time]) }
  }
  class Node {
    connections = []; listeners = {}; gain = new Param(); delayTime = new Param()
    connect(node) { this.connections.push(node); return node }
    disconnect(node) { this.connections = node ? this.connections.filter(x => x !== node) : [] }
    addEventListener(name, fn) { this.listeners[name] = fn }
    removeEventListener(name) { delete this.listeners[name] }
  }
  const nodes = [], updates = []
  const dsp = { input: new Node(), latencySeconds: 0.005, disposed: false,
    update(settings) { updates.push(settings) }, dispose() { this.disposed = true; this.input.disconnect() },
  }
  const context = { currentTime: 0, sampleRate: 48000, destination: new Node(),
    createGain() { const node = new Node(); nodes.push(node); return node },
    createDelay() { const node = new Node(); nodes.push(node); return node },
  }
  const sandbox = { Error, context, createProcessingChain: factory ?? (async (_ctx, _channels, _settings, destination) => { dsp.input.connect(destination); return dsp }) }
  vm.createContext(sandbox)
  vm.runInContext(compiled, sandbox)
  return { context, nodes, dsp, updates, Param, sandbox, run: expression => vm.runInContext(expression, sandbox) }
}
test('one input splits into matched ORIGINAL and PROCESSED paths with exclusive initial gains', async () => {
  const { nodes, dsp, context, run } = harness()
  const chain = await run("createComparisonChain(context, 2, {}, 'processed')")
  const [input, original, processed, delay] = nodes
  assert.deepEqual(input.connections, [delay, dsp.input])
  assert.deepEqual(delay.connections, [original])
  assert.deepEqual(dsp.input.connections, [processed])
  assert.deepEqual(original.connections, [context.destination])
  assert.deepEqual(processed.connections, [context.destination])
  assert.equal(original.gain.value, 0); assert.equal(processed.gain.value, 1)
  assert.equal(delay.delayTime.value, chain.latencySeconds)
  assert.equal(chain.latencySeconds, 0.005)
  chain.dispose()
})
test('20ms crossfade, exact mute endpoints, and continuous fast reversals allocate no nodes', async () => {
  const { nodes, context, run } = harness()
  const chain = await run("createComparisonChain(context, 2, {}, 'processed')")
  chain.setMode('original')
  assert.deepEqual(nodes[1].gain.events.at(-1), ['ramp', 1, 0.02])
  assert.deepEqual(nodes[2].gain.events.at(-1), ['ramp', 0, 0.02])
  context.currentTime = 0.005; chain.setMode('processed')
  assert.deepEqual(nodes[1].gain.events.at(-2), ['set', 0.25, 0.005])
  assert.deepEqual(nodes[2].gain.events.at(-2), ['set', 0.75, 0.005])
  for (let i = 0; i < 100; i++) { context.currentTime += 0.001; chain.setMode(i % 2 ? 'original' : 'processed') }
  assert.equal(nodes.length, 4)
  context.currentTime += 0.1; chain.setMode('processed')
  assert.equal(nodes[1].gain.events.at(-1)[1], 0)
  assert.equal(nodes[2].gain.events.at(-1)[1], 1)
  chain.dispose()
})
test('crossfade compatibility path tracks the current ramp when cancelAndHoldAtTime is unavailable', () => {
  const { sandbox, Param, run } = harness()
  sandbox.original = new Param(); sandbox.processed = new Param()
  sandbox.original.cancelAndHoldAtTime = sandbox.processed.cancelAndHoldAtTime = undefined
  const fade = run("new ComparisonCrossfade(original, processed, 'processed', 0)")
  fade.select('original', 1)
  fade.select('processed', 1.01)
  assert.equal(sandbox.original.events.at(-3)[0], 'cancel')
  assert.ok(Math.abs(sandbox.original.events.at(-2)[1] - 0.5) < 1e-12)
  assert.ok(Math.abs(fade.valueAt(1.02) - 0.75) < 1e-12)
  assert.equal(fade.valueAt(2), 1)
})
test('settings remain live while ORIGINAL is selected; no reconnections on mode changes', async () => {
  const { context, nodes, updates, run } = harness()
  const chain = await run("createComparisonChain(context, 1, {}, 'original')")
  assert.equal(nodes[1].gain.value, 1); assert.equal(nodes[2].gain.value, 0)
  const connections = nodes[0].connections.slice()
  chain.update({ outputDb: 4, widthPercent: 200, limiterEnabled: false })
  context.currentTime = 1; chain.setMode('processed')
  assert.deepEqual(updates[0], { outputDb: 4, widthPercent: 200, limiterEnabled: false })
  assert.deepEqual(nodes[0].connections, connections)
  assert.equal(nodes[3].delayTime.value, 0.005)
  chain.dispose()
})
test('DSP initialization failure retains only delayed ORIGINAL and exposes the reason', async () => {
  const { nodes, run } = harness(async () => { throw Error('worklet unavailable') })
  const chain = await run("createComparisonChain(context, 2, {}, 'processed')")
  assert.equal(chain.processedAvailable, false)
  assert.equal(chain.fallbackReason, 'worklet unavailable')
  assert.equal(nodes[1].gain.value, 1); assert.equal(nodes[2].gain.value, 0)
  chain.setMode('processed')
  assert.equal(nodes[2].gain.events.at(-1)[1], 0)
  assert.equal(nodes[0].connections.length, 1)
  chain.dispose()
})
test('runtime error switches smoothly to delayed ORIGINAL without replacing source input', async () => {
  const { nodes, dsp, run } = harness()
  const chain = await run("createComparisonChain(context, 2, {}, 'processed')")
  let notified = 0; chain.onFallback(() => notified++)
  dsp.input.listeners.processorerror()
  assert.equal(chain.processedAvailable, false)
  assert.equal(notified, 1); assert.equal(dsp.disposed, true)
  assert.equal(chain.input, nodes[0])
  assert.deepEqual(nodes[0].connections, [nodes[3]])
  assert.deepEqual(nodes[1].gain.events.at(-1), ['ramp', 1, 0.02])
  assert.deepEqual(nodes[2].gain.events.at(-1), ['ramp', 0, 0.02])
  chain.dispose()
})
test('disposal is idempotent, disconnects all paths and ignores later settings or mode changes', async () => {
  const { nodes, dsp, updates, run } = harness()
  const chain = await run('createComparisonChain(context, 2, {})')
  chain.dispose(); chain.dispose()
  const count = nodes[1].gain.events.length
  chain.update({ outputDb: 4 }); chain.setMode('original')
  assert.equal(dsp.disposed, true)
  assert.equal(nodes.every(node => node.connections.length === 0), true)
  assert.equal(nodes[1].gain.events.length, count)
  assert.equal(updates.length, 0)
  assert.equal(dsp.input.listeners.processorerror, undefined)
})

test('ORIGINAL delay follows the latency reported by the DSP chain', async () => {
  const { nodes, dsp, context, run } = harness()
  context.sampleRate = 44100
  dsp.latencySeconds = 221 / 44100
  const chain = await run('createComparisonChain(context, 2, {})')
  assert.equal(chain.latencySeconds, dsp.latencySeconds)
  assert.equal(nodes[3].delayTime.value, dsp.latencySeconds)
  chain.dispose()
})
