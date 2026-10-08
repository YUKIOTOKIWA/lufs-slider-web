import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'

const compiled = ts.transpile(readFileSync(new URL('../src/lufs.ts', import.meta.url), 'utf8'), {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
})
const { analyzeIntegratedLufs } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
function audio({ rate = 48000, seconds = 2, channels = 1, frequency = 1000, amplitude = 1, envelope = () => 1 } = {}) {
  const samples = Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) =>
    amplitude * envelope(i / rate) * Math.sin(2 * Math.PI * frequency * i / rate))
  return { sampleRate: rate, length: samples.length, numberOfChannels: channels, getChannelData: () => samples }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
function near(actual, expected, tolerance = 0.05) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < tolerance, `${actual} expected ${expected} ± ${tolerance}`)
}

test('BS.1770 reference: full-scale 1kHz mono sine is approximately -3.01 LUFS', async () => {
  near(await analyzeIntegratedLufs(audio()), -3.01)
})
test('sample-rate-dependent K-weighting agrees at 44.1 / 48 / 96 kHz', async () => {
  for (const rate of [44100, 48000, 96000]) near(await analyzeIntegratedLufs(audio({ rate, amplitude: 0.1 })), -23.01)
})
test('channel energy sum and amplitude law; deterministic repeat', async () => {
  const mono = await analyzeIntegratedLufs(audio({ amplitude: 0.1 }))
  near(await analyzeIntegratedLufs(audio({ amplitude: 0.1, channels: 2 })), mono + 10 * Math.log10(2), 1e-8)
  near(await analyzeIntegratedLufs(audio({ amplitude: 0.2 })), mono + 20 * Math.log10(2), 1e-8)
  assert.equal(await analyzeIntegratedLufs(audio({ amplitude: 0.1 })), mono)
})
test('frequency weighting is applied rather than plain RMS', async () => {
  const mid = await analyzeIntegratedLufs(audio({ amplitude: 0.1 }))
  const low = await analyzeIntegratedLufs(audio({ amplitude: 0.1, frequency: 50 }))
  const high = await analyzeIntegratedLufs(audio({ amplitude: 0.1, frequency: 10000 }))
  assert.ok(low < mid - 3)
  assert.ok(high > mid + 2)
})
test('absolute gate: silence and a below-threshold tone have no finite value', async () => {
  assert.equal(await analyzeIntegratedLufs(audio({ amplitude: 0 })), null)
  assert.equal(await analyzeIntegratedLufs(audio({ amplitude: 0.00001 })), null)
})
test('relative gate excludes quiet passages above the absolute gate', async () => {
  const reference = await analyzeIntegratedLufs(audio({ seconds: 4, amplitude: 0.1 }))
  const quietTail = await analyzeIntegratedLufs(audio({ seconds: 8, amplitude: 0.1, envelope: t => t < 4 ? 1 : 0.01 }))
  const silentTail = await analyzeIntegratedLufs(audio({ seconds: 8, amplitude: 0.1, envelope: t => t < 4 ? 1 : 0 }))
  near(quietTail, reference, 0.2)
  near(silentTail, reference, 0.2)
})
test('complete 400ms blocks only; short and unknown multichannel layouts are explicit errors', async () => {
  await assert.rejects(analyzeIntegratedLufs(audio({ seconds: 0.399 })), /0.4秒/)
  near(await analyzeIntegratedLufs(audio({ seconds: 0.4 })), -3.01)
  await assert.rejects(analyzeIntegratedLufs(audio({ channels: 6 })), /モノラル／ステレオ/)
})
test('abort before and during analysis; PCM is unchanged', async () => {
  const controller = new AbortController()
  const input = audio({ seconds: 20 })
  const copy = input.getChannelData().slice()
  const pending = analyzeIntegratedLufs(input, controller.signal)
  setTimeout(() => controller.abort(), 0)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(input.getChannelData(), copy)
  await assert.rejects(analyzeIntegratedLufs(input, controller.signal), { name: 'AbortError' })
})

const uiCompiled = ts.transpile(readFileSync(new URL('../src/ui-text.ts', import.meta.url), 'utf8'), {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
})
const { UI_TEXT } = await import(`data:text/javascript;base64,${Buffer.from(uiCompiled).toString('base64')}`)

function playerHarness({ createChain, generatePeaks, createWav, exportTimers } = {}) {
  const elements = new Map()
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      value: ({ 'target-lufs': '-14', 'output-level': '0', 'stereo-width': '100', ceiling: '-1' })[id] ?? '0',
      checked: id === 'limiter-enabled', style: {}, clientWidth: 600, clientHeight: 180,
      attributes: {}, listeners: {}, classList: { add() {}, remove() {} },
      addEventListener(n, f) { this.listeners[n] = f }, removeAttribute(name) { delete this.attributes[name] }, click() { this.clicks = (this.clicks ?? 0) + 1 }, setAttribute(name, value) { this.attributes[name] = value },
      getContext() { return { scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {} } },
    })
    return elements.get(id)
  }
  let context
  class Context {
    currentTime = 0; destination = {}
    constructor() { context = this }
    async resume() {}
    async decodeAudioData(data) { if (data === 'bad') throw Error('decode'); return { ...audio(), duration: 2 } }
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} } }
  }
  const jobs = []
  let objectUrls = 0
  const sandbox = {
    document: { querySelector() { return {} }, getElementById: get, addEventListener() {} },
    window: { devicePixelRatio: 1, addEventListener() {} }, AudioContext: Context,
    ResizeObserver: class { observe() {} }, requestAnimationFrame() { return 1 }, cancelAnimationFrame() {},
    setTimeout: (callback, delay) => {
      if (delay === 4000 && exportTimers) { exportTimers.push(callback); return {} }
      return setTimeout(callback, delay)
    }, clearTimeout, AbortController, Error, DOMException, UI_TEXT,
    createProcessedWav: createWav ?? (async () => ({ blob: new Blob(), clippedSamples: 0 })),
    processedFilename: name => name.replace(/\.[^.]+$/, "") + "-LUFS-processed.wav",
    Blob, URL: { createObjectURL: () => "blob:test-" + ++objectUrls, revokeObjectURL() {} },
    generateProcessedAnalysis: async (...args) => { const result = await (generatePeaks ?? (async () => new Float32Array(4096).fill(0.5)))(...args); return result instanceof Float32Array ? { peaks: result, actualLufs: -14.2, analysisError: "" } : result },
    sharedAmplitudeScale: (original, processed) => Math.max(1, ...original, ...processed),
    // Audio graph is tested separately; these regressions keep the timing boundary synchronous.
    createProcessingChain: createChain ?? (async () => { throw new Error('Mocked unavailable worklet') }),
    analyzeIntegratedLufs: (_audio, signal) => new Promise((resolve, reject) => jobs.push({ signal, resolve, reject })),
  }
  vm.createContext(sandbox)
  const player = ts.transpile(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  }).replace(/^import .*;$/gm, '').replace(/if \(import.meta.hot\)[\s\S]*$/, '').replace(/export \{\};?/g, '')
  vm.runInContext(player, sandbox)
  return { get, jobs, context: () => context, run: code => vm.runInContext(code, sandbox) }
}
test('UI: automatic analysis, realtime signed gain, target retention and stale-result prevention', async () => {
  const { get, jobs, run } = playerHarness()
  await run("loadFile({name:'first.wav',arrayBuffer:async()=> 'ok'})")
  assert.equal(get('current-lufs').textContent, 'ANALYZING...')
  assert.equal(get('play').disabled, false)
  jobs[0].resolve(-18.4)
  await flush()
  assert.match(get('gain').innerHTML, /\+4.4/)
  get('target-lufs').value = '-24'; get('target-lufs').listeners.input()
  assert.match(get('gain').innerHTML, /-5.6/)
  await run("loadFile({name:'second.wav',arrayBuffer:async()=> 'ok'})")
  assert.equal(get('gain').textContent, '—')
  assert.equal(get('target-lufs').value, '-24')
  await run("loadFile({name:'third.wav',arrayBuffer:async()=> 'ok'})")
  assert.equal(jobs[1].signal.aborted, true)
  jobs[2].resolve(-20); await flush()
  jobs[1].resolve(-10); await flush()
  assert.equal(run('currentLufs'), -20)
  await run("loadFile({name:'silence.wav',arrayBuffer:async()=> 'ok'})")
  jobs[3].resolve(null); await flush()
  assert.equal(get('current-lufs').textContent, '−∞ LUFS')
  assert.equal(get('gain').textContent, '—')
  await run("loadFile({name:'failure.wav',arrayBuffer:async()=> 'ok'})")
  jobs[4].reject(Error('failed')); await flush()
  assert.equal(get('current-lufs').textContent, '測定不可')
  assert.equal(get('play').disabled, false)
})
test('Phase 1 regression: pause/resume, seek, stop, end/replay and decode failure during analysis', async () => {
  const { get, run, context } = playerHarness()
  await run("loadFile({name:'test.wav',arrayBuffer:async()=> 'ok'})")
  assert.equal(get('total').textContent, '0:02')
  await run('start()'); context().currentTime = 0.5
  get('pause').listeners.click(); assert.equal(run('offset'), 0.5)
  await run('start()'); context().currentTime = 1; near(run('position()'), 1, 1e-8)
  get('seek').value = '1.5'; get('seek').listeners.input(); await flush()
  assert.equal(run('playing'), true); assert.equal(run('position()'), 1.5)
  get('stop').listeners.click(); assert.equal(run('offset'), 0); assert.equal(run('playing'), false)
  await run('start()'); run('source.onended()'); assert.equal(get('current').textContent, '0:02')
  await run('start()'); assert.equal(run('offset'), 0)
  await run("loadFile({name:'bad.wav',arrayBuffer:async()=> 'bad'})")
  assert.equal(get('play').disabled, true); assert.equal(get('gain').textContent, '—')
})

function mockChain() {
  const chain = { latencySeconds: 0, disposed: false, settings: [], events: {},
    fallbackReason: '', setMode(mode) { this.mode = mode }, onFallback(handler) { this.fallback = handler },
    update(settings) { this.settings.push(settings) }, dispose() { this.disposed = true },
  }
  chain.input = { addEventListener(name, handler) { chain.events[name] = handler } }
  return chain
}
test('processed playback updates AUTO gain and controls without restarting; runtime failure preserves playback', async () => {
  const chain = mockChain()
  const { get, jobs, run } = playerHarness({ createChain: async () => chain })
  await run("loadFile({name:'test.wav',arrayBuffer:async()=> 'ok'})")
  await run('start()')
  const source = run('source')
  jobs[0].resolve(-18.4); await flush()
  near(chain.settings.at(-1).autoGainDb, 4.4)
  get('output-level').value = '2.3'; get('output-level').listeners.input()
  near(chain.settings.at(-1).outputDb, 2.3)
  assert.equal(run('source'), source)
  assert.equal(run('playing'), true)
  chain.fallbackReason = '音声処理でエラーが発生しました。'
  chain.fallback()
  assert.equal(run('processingChain'), chain)
  assert.equal(run('source'), source)
  assert.equal(run('playing'), true)
  assert.match(get('processing-status').textContent, /ORIGINAL音声を再生/)
  get('stop').listeners.click()
})
test('STOP cancels pending worklet initialization and disposes a late-created graph', async () => {
  let resolve
  const { get, run } = playerHarness({ createChain: () => new Promise(r => { resolve = r }) })
  await run("loadFile({name:'test.wav',arrayBuffer:async()=> 'ok'})")
  const pending = run('start()'); await flush()
  get('stop').listeners.click()
  const chain = mockChain(); resolve(chain); await pending
  assert.equal(chain.disposed, true)
  assert.equal(run('playing'), false)
  assert.equal(run('source'), undefined)
})
test('a failed old worklet initialization cannot replace the newer audio status or source', async () => {
  const pendingGraphs = []
  const { get, run } = playerHarness({ createChain: () => new Promise((resolve, reject) => pendingGraphs.push({ resolve, reject })) })
  await run("loadFile({name:'old.wav',arrayBuffer:async()=> 'ok'})")
  const oldStart = run('start()'); await flush()
  await run("loadFile({name:'new.wav',arrayBuffer:async()=> 'ok'})")
  const newStart = run('start()'); await flush()
  const chain = mockChain(); pendingGraphs[1].resolve(chain); await newStart
  const source = run('source')
  pendingGraphs[0].reject(Error('old error')); await oldStart
  assert.equal(run('source'), source)
  assert.equal(run('playing'), true)
  assert.equal(run('processingChain'), chain)
  assert.doesNotMatch(get('processing-status').textContent, /ORIGINAL音声を再生/)
  get('stop').listeners.click()
})

test('A/B switches keep the same source and position; settings stay live in ORIGINAL', async () => {
  const chains = []
  const { get, run, context } = playerHarness({ createChain: async () => { const chain = mockChain(); chains.push(chain); return chain } })
  assert.equal(get('mode-processed').attributes['aria-pressed'], 'true')
  await run("loadFile({name:'test.wav',arrayBuffer:async()=> 'ok'})")
  await run('start()'); context().currentTime = 0.5
  const source = run('source'), position = run('position()')
  get('mode-original').listeners.click()
  assert.equal(chains[0].mode, 'original')
  assert.equal(get('mode-original').attributes['aria-pressed'], 'true')
  get('output-level').value = '4.5'; get('output-level').listeners.input()
  assert.equal(chains[0].settings.at(-1).outputDb, 4.5)
  for (let i = 0; i < 100; i++) get(i % 2 ? 'mode-original' : 'mode-processed').listeners.click()
  assert.equal(run('source'), source); assert.equal(run('position()'), position)
  assert.equal(chains.length, 1)
  get('mode-processed').listeners.click()
  assert.equal(chains[0].settings.at(-1).outputDb, 4.5)
  get('stop').listeners.click()
})
test('both A/B modes retain selection through pause, resume, stop, seek and natural end', async () => {
  for (const mode of ['original', 'processed']) {
    const { get, run, context } = playerHarness({ createChain: async () => mockChain() })
    await run("loadFile({name:'test.wav',arrayBuffer:async()=> 'ok'})")
    get(`mode-${mode}`).listeners.click()
    await run('start()'); context().currentTime = 0.5
    get('pause').listeners.click(); assert.equal(run('offset'), 0.5)
    const other = mode === 'original' ? 'processed' : 'original'
    get(`mode-${other}`).listeners.click(); await run('start()')
    assert.equal(run('processingChain.mode'), other)
    get('stop').listeners.click(); assert.equal(run('playbackMode'), other)
    get(`mode-${mode}`).listeners.click(); await run('start()')
    get('seek').value = '1.5'; get('seek').listeners.input(); await flush()
    assert.equal(run('processingChain.mode'), mode); assert.equal(run('position()'), 1.5)
    run('source.onended()'); await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(run('offset'), 2); assert.equal(run('playing'), false)
    assert.equal(run('playbackMode'), mode)
    await run('start()'); assert.equal(run('offset'), 0)
    get('stop').listeners.click()
  }
})

test('waveform UI debounces settings, changes A/B colors/mode and ignores stale calculations', async () => {
  const tasks = []
  const { get, run } = playerHarness({ generatePeaks: (_audio, settings, signal) => new Promise(resolve => tasks.push({ settings, signal, resolve })) })
  await run("loadFile({name:'wave.wav',arrayBuffer:async()=> 'ok'})")
  for (let i = 0; i < 20; i++) { get('output-level').value = String(i / 10); get('output-level').listeners.input() }
  assert.equal(get('waveform-status').textContent, 'UPDATING WAVEFORM...')
  await new Promise(resolve => setTimeout(resolve, 280))
  assert.equal(tasks.length, 1); assert.equal(tasks[0].settings.outputDb, 1.9)
  get('mode-original').listeners.click()
  assert.equal(get('canvas').attributes['data-mode'], 'original')
  get('mode-processed').listeners.click()
  assert.equal(get('canvas').attributes['data-mode'], 'processed')
  assert.equal(tasks.length, 1)
  get('output-level').value = '4'; get('output-level').listeners.input()
  assert.equal(tasks[0].signal.aborted, true)
  await new Promise(resolve => setTimeout(resolve, 280))
  tasks[1].resolve(new Float32Array(4096).fill(2)); await flush()
  assert.equal(run('amplitudeScale'), 2)
  tasks[0].resolve(new Float32Array(4096).fill(9)); await flush()
  assert.equal(run('processedPeaks[0]'), 2)
  get('mode-original').listeners.click(); assert.equal(run('amplitudeScale'), 2)
  get('output-level').value = '-4'; get('output-level').listeners.input()
  await new Promise(resolve => setTimeout(resolve, 280))
  await run("loadFile({name:'replacement.wav',arrayBuffer:async()=> 'ok'})")
  assert.equal(tasks[2].signal.aborted, true)
  tasks[2].resolve(new Float32Array(4096).fill(7)); await flush()
  assert.equal(run('processedPeaks.length'), 0)
  await run("loadFile({name:'bad.wav',arrayBuffer:async()=> 'bad'})")
})

test('EXPORT always processes current settings in ORIGINAL, snapshots controls, prevents duplicates and preserves playback', async () => {
  const tasks=[]
  const {get,jobs,run}=playerHarness({createChain:async()=>mockChain(),createWav:(audio,settings,signal,progress)=>new Promise((resolve,reject)=>tasks.push({audio,settings,signal,progress,resolve,reject}))})
  await run("loadFile({ name: 'song.mp3', arrayBuffer: async () => 'ok' })")
  assert.equal(get('export-wav').disabled,true)
  jobs[0].resolve(-18.4); await new Promise(r=>setTimeout(r,0))
  assert.equal(get('export-wav').disabled,false)
  get('mode-original').listeners.click(); await run('start()')
  const source=run('source')
  get('export-wav').listeners.click();get('export-wav').listeners.click()
  assert.equal(tasks.length,1); assert.equal(get('export-wav').disabled,true)
  assert.ok(Math.abs(tasks[0].settings.autoGainDb-4.4)<1e-10)
  get('output-level').value='6';get('output-level').listeners.input()
  assert.equal(tasks[0].settings.outputDb,0)
  tasks[0].progress(50);assert.equal(get('export-status').textContent,'PROCESSING 50%')
  tasks[0].resolve({blob:new Blob(),clippedSamples:0});await new Promise(r=>setTimeout(r,0))
  assert.equal(get('download-wav').download,'song-LUFS-processed.wav');assert.equal(get('download-wav').clicks,1)
  assert.equal(run('source'),source);assert.equal(run('playing'),true)
  get('export-wav').listeners.click()
  await run("loadFile({ name: 'next.wav', arrayBuffer: async () => 'ok' })")
  assert.equal(tasks[1].signal.aborted,true)
  tasks[1].resolve({blob:new Blob(),clippedSamples:0});await new Promise(r=>setTimeout(r,0))
  assert.equal(get('download-wav').hidden,true);assert.equal(get('download-wav').clicks,1)
  await run('halt()')
})

test('EXPORT cancellation and failure release busy state without offering incomplete WAV', async () => {
  const tasks=[]
  const {get,jobs,run}=playerHarness({createWav:(_audio,_settings,signal)=>new Promise((resolve,reject)=>{tasks.push({resolve,reject});signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true})})})
  await run("loadFile({ name: 'silent.wav', arrayBuffer: async () => 'ok' })")
  jobs[0].resolve(null);await new Promise(r=>setTimeout(r,0))
  get('export-wav').listeners.click();get('cancel-export').listeners.click()
  await new Promise(r=>setTimeout(r,0))
  assert.equal(get('export-wav').disabled,false);assert.equal(get('cancel-export').hidden,true)
  assert.equal(get('download-wav').hidden,true);assert.match(get('export-status').textContent,/キャンセル/)
  get('export-wav').listeners.click();tasks[1].reject(Error('allocation failed'))
  await new Promise(r=>setTimeout(r,0))
  assert.equal(get('export-wav').disabled,false);assert.match(get('export-status').textContent,/WAV.*もう一度/);assert.doesNotMatch(get('export-status').textContent,/allocation failed/)
})

test('ACTUAL UI shares debounce, computes signed difference, ignores stale results and stays independent of A/B',async()=>{
  const tasks=[]
  const {get,jobs,run}=playerHarness({createChain:async()=>mockChain(),generatePeaks:(_audio,settings,signal)=>new Promise(resolve=>tasks.push({settings,signal,resolve}))})
  await run("loadFile({name:'actual.wav',arrayBuffer:async()=> 'ok'})")
  jobs[0].resolve(-18.7);await flush()
  for(let i=0;i<20;i++){get('output-level').value=String(i/10);get('output-level').listeners.input()}
  assert.equal(get('actual-lufs').textContent,'CALCULATING...')
  assert.equal(get('lufs-difference').textContent,'—')
  await new Promise(r=>setTimeout(r,280));assert.equal(tasks.length,1)
  await run('start()');const source=run('source')
  get('mode-original').listeners.click();assert.equal(tasks.length,1)
  tasks[0].resolve({peaks:new Float32Array(4096).fill(.8),actualLufs:-14.2,analysisError:''});await flush()
  assert.match(get('actual-lufs').innerHTML,/-14.2/);assert.match(get('lufs-difference').innerHTML,/-0.2/)
  get('mode-processed').listeners.click();assert.equal(run('actualLufs'),-14.2);assert.equal(run('source'),source)
  get('target-lufs').value='-12';get('target-lufs').listeners.input()
  assert.equal(get('actual-lufs').textContent,'CALCULATING...');assert.equal(tasks[0].signal.aborted,true)
  await new Promise(r=>setTimeout(r,280))
  get('ceiling').value='-2';get('ceiling').listeners.change();assert.equal(tasks[1].signal.aborted,true)
  await new Promise(r=>setTimeout(r,280))
  tasks[2].resolve({peaks:new Float32Array(4096),actualLufs:-11.8,analysisError:''});await flush()
  tasks[1].resolve({peaks:new Float32Array(4096),actualLufs:-99,analysisError:''});await flush()
  assert.equal(run('actualLufs'),-11.8);assert.match(get('lufs-difference').innerHTML,/\+0.2/)
  get('stereo-width').value='0';get('stereo-width').listeners.input();await new Promise(r=>setTimeout(r,280))
  tasks[3].resolve({peaks:new Float32Array(4096),actualLufs:null,analysisError:''});await flush()
  assert.equal(get('actual-lufs').textContent,'−∞ LUFS');assert.equal(get('lufs-difference').textContent,'—')
  get('output-level').value='-1';get('output-level').listeners.input();await new Promise(r=>setTimeout(r,280))
  await run("loadFile({name:'replacement.wav',arrayBuffer:async()=> 'ok'})")
  assert.equal(tasks[4].signal.aborted,true)
  tasks[4].resolve({peaks:new Float32Array(4096),actualLufs:-9,analysisError:''});await flush()
  assert.equal(run('actualLufs'),null)
  await run("loadFile({name:'bad.wav',arrayBuffer:async()=> 'bad'})")
})

test('Phase 7 PRESET uses the slider update path; RESET retains source, audio, position and A/B mode',async()=>{
  const chain=mockChain(),{get,jobs,run,context}=playerHarness({createChain:async()=>chain})
  await run("loadFile({name:'settings.wav',arrayBuffer:async()=> 'ok'})")
  jobs[0].resolve(-18.7);await flush();await run('start()');context().currentTime=.75
  get('mode-original').listeners.click()
  const source=run('source'),buffer=run('buffer'),position=run('position()')
  for(const value of [-16,-14,-12,-10,-9]){
    const updates=chain.settings.length
    get(`target-preset-${Math.abs(value)}`).listeners.click()
    assert.equal(get('target-lufs').value,String(value))
    near(chain.settings.at(-1).autoGainDb,value+18.7)
    assert.equal(chain.settings.length,updates+1)
    assert.equal(get(`target-preset-${Math.abs(value)}`).attributes['aria-pressed'],'true')
    assert.equal(jobs.length,1)
  }
  get('target-lufs').value='-13.5';get('target-lufs').listeners.input()
  for(const value of [-16,-14,-12,-10,-9])assert.equal(get(`target-preset-${Math.abs(value)}`).attributes['aria-pressed'],'false')
  get('output-level').value='5';get('output-level').listeners.input()
  get('stereo-width').value='200';get('stereo-width').listeners.input()
  get('limiter-enabled').checked=false;get('limiter-enabled').listeners.change()
  get('ceiling').value='-.1';get('ceiling').listeners.change()
  const updates=chain.settings.length
  get('reset-settings').listeners.click()
  assert.equal(chain.settings.length,updates+1)
  assert.deepEqual(JSON.parse(JSON.stringify(chain.settings.at(-1))),{autoGainDb:4.699999999999999,outputDb:0,widthPercent:100,limiterEnabled:true,ceilingDb:-1})
  assert.equal(get('target-lufs').value,'-14');assert.equal(get('ceiling').disabled,false)
  assert.equal(run('source'),source);assert.equal(run('buffer'),buffer);assert.equal(run('position()'),position)
  assert.equal(run('playing'),true);assert.equal(run('playbackMode'),'original')
  assert.match(get('settings-status').textContent,/初期値/)
  await run("loadFile({name:'bad.wav',arrayBuffer:async()=> 'bad'})")
  get('reset-settings').listeners.click();assert.equal(get('play').disabled,true)
})

test('Phase 7 keeps previous waveform explicitly stale while updating, then replaces it; errors never label it current',async()=>{
  const tasks=[],{get,run}=playerHarness({generatePeaks:(_audio,_settings,signal)=>new Promise((resolve,reject)=>tasks.push({signal,resolve,reject}))})
  await run("loadFile({name:'wave.wav',arrayBuffer:async()=> 'ok'})")
  await new Promise(r=>setTimeout(r,280))
  tasks[0].resolve(new Float32Array(4096).fill(.8));await flush()
  const peaks=run('processedPeaks')
  get('output-level').value='2';get('output-level').listeners.input()
  assert.equal(run('processedPeaks'),peaks);assert.equal(run('waveformUpdating'),true)
  assert.equal(get('canvas').attributes['data-stale'],'true');assert.equal(get('canvas').attributes['aria-busy'],'true')
  assert.equal(get('waveform-overlay').hidden,false);assert.match(get('waveform-label').textContent,/前の設定/)
  assert.equal(get('actual-lufs').textContent,'CALCULATING...')
  assert.equal(get('actual-status').attributes['data-busy'],'true')
  get('mode-original').listeners.click();assert.equal(get('waveform-overlay').hidden,true)
  assert.equal(get('canvas').attributes['data-stale'],'false')
  get('mode-processed').listeners.click();assert.equal(get('waveform-overlay').hidden,false)
  await new Promise(r=>setTimeout(r,280))
  tasks[1].resolve(new Float32Array(4096).fill(.5));await flush()
  assert.equal(run('processedPeaks[0]'),.5);assert.equal(get('canvas').attributes['data-stale'],'false')
  assert.equal(get('waveform-overlay').hidden,true);assert.equal(get('actual-status').attributes['data-busy'],'false')
  get('output-level').value='3';get('output-level').listeners.input();await new Promise(r=>setTimeout(r,280))
  tasks[2].reject(Error('failed'));await flush()
  assert.equal(run('processedPeaks[0]'),.5);assert.equal(run('waveformUpdating'),false)
  assert.equal(get('canvas').attributes['data-stale'],'true');assert.match(get('waveform-status').textContent,/前の設定/)
  await run("loadFile({name:'bad.wav',arrayBuffer:async()=> 'bad'})")
  assert.equal(run('processedPeaks.length'),0);assert.equal(get('waveform-overlay').hidden,true)
})

test('Phase 7 difference hint and onboarding express state with text and keep numerical LU values',async()=>{
  const {get,run}=playerHarness()
  run('update()');assert.equal(get('quick-start').hidden,false)
  await run("loadFile({name:'loaded.wav',arrayBuffer:async()=> 'ok'})")
  assert.equal(get('quick-start').hidden,true)
  for(const [actual,close,pattern] of [[-14.1,true,/近い/],[-13.5,true,/近い/],[-15,false,/低い/],[-12,false,/高い/]]){
    run(`actualLufs=${actual};updateDifference()`)
    assert.equal(get('lufs-difference').attributes['data-close'],String(close))
    assert.match(get('difference-hint').textContent,pattern)
  }
  run('resetActual(true)');assert.equal(get('lufs-difference').attributes['data-close'],'false')
  assert.equal(get('difference-hint').textContent,UI_TEXT.differenceHint)
  await run("loadFile({name:'bad.wav',arrayBuffer:async()=> 'bad'})")
  assert.equal(get('quick-start').hidden,false)
})

test('Phase 7 export completion returns to normal after 4 seconds, retains download notes, and old timers cannot overwrite new state',async()=>{
  const exportTimers=[],tasks=[],{get,jobs,run}=playerHarness({exportTimers,createWav:()=>new Promise(resolve=>tasks.push({resolve}))})
  await run("loadFile({name:'export.wav',arrayBuffer:async()=> 'ok'})")
  jobs[0].resolve(-18.7);await flush()
  get('export-wav').listeners.click();assert.equal(get('export-status').attributes['data-busy'],'true')
  tasks[0].resolve({blob:new Blob(),clippedSamples:5});await flush()
  assert.equal(get('export-wav').textContent,'WAV EXPORTED');assert.equal(get('export-status').textContent,'WAV EXPORTED')
  assert.equal(get('export-status').attributes['data-busy'],'false');assert.match(get('export-note').textContent,/クランプ/)
  assert.equal(exportTimers.length,1);exportTimers[0]()
  assert.equal(get('export-wav').textContent,'EXPORT WAV');assert.equal(get('export-status').textContent,UI_TEXT.exportReady)
  assert.equal(get('download-wav').hidden,false);assert.match(get('export-note').textContent,/クランプ/)
  get('export-wav').listeners.click();tasks[1].resolve({blob:new Blob(),clippedSamples:0});await flush()
  get('export-wav').listeners.click();assert.equal(get('export-note').textContent,'')
  exportTimers[1]();assert.equal(get('export-status').textContent,'CREATING WAV...')
  await run("loadFile({name:'bad.wav',arrayBuffer:async()=> 'bad'})")
  tasks[2].resolve({blob:new Blob(),clippedSamples:0});await flush();exportTimers[1]()
  assert.equal(get('export-status').textContent,UI_TEXT.exportWaiting);assert.equal(get('download-wav').hidden,true)
})
