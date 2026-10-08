import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const compile = file => ts.transpile(readFileSync(new URL(file, import.meta.url), 'utf8'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
const url = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const coreUrl = url(compile('../src/audio/processing-core.ts'))
const lufsUrl = url(compile('../src/lufs.ts'))
const renderUrl = url(compile('../src/audio/streaming-render.ts').replace("from './processing-core'", `from '${coreUrl}'`))
const accumulatorUrl = url(compile('../src/audio/processed-analysis.ts').replace("from '../lufs'", `from '${lufsUrl}'`).replace("from './streaming-render'", `from '${renderUrl}'`))
const { IntegratedLufsMeter, analyzeIntegratedLufs } = await import(lufsUrl)
const { StreamingRender } = await import(renderUrl)
const { ProcessedAccumulator } = await import(accumulatorUrl)
const { DEFAULT_PROCESSING_SETTINGS: defaults } = await import(coreUrl)
const { createProcessedWav } = await import(url(compile('../src/audio/wav-export.ts').replace("from './streaming-render'", `from '${renderUrl}'`).replace("from './processing-core'", `from '${coreUrl}'`)))
const { generateProcessedAnalysis } = await import(url(compile('../src/audio/processed-waveform.ts').replace(/^import workerUrl.*;$/m,"const workerUrl = '/unused';").replace("from './streaming-render'", `from '${renderUrl}'`).replace("from './processed-analysis'", `from '${accumulatorUrl}'`).replace("from './processing-core'", `from '${coreUrl}'`)))
const audio = (channels, rate=48000) => ({length:channels[0].length,sampleRate:rate,numberOfChannels:channels.length,getChannelData:c=>channels[c]})
const tone = (rate=48000,channels=1,amplitude=.1) => audio(Array.from({length:channels},()=>Float32Array.from({length:rate*2},(_,i)=>Math.sin(2*Math.PI*1000*i/rate)*amplitude)),rate)
const near = (a,b,tolerance=1e-7) => assert.ok(Number.isFinite(a)&&Math.abs(a-b)<tolerance,`${a} != ${b}`)
function measure(input,config={},chunk=4096) {
  const renderer=new StreamingRender(input.sampleRate,input.numberOfChannels,input.length,{...defaults,limiterEnabled:false,...config})
  const acc=new ProcessedAccumulator(input.sampleRate,input.numberOfChannels,input.length)
  for(let i=0;i<input.length;i+=chunk) acc.add(renderer.push(Array.from({length:input.numberOfChannels},(_,c)=>input.getChannelData(c).subarray(i,i+chunk))))
  acc.add(renderer.finish());return acc.finish()
}
test('neutral ORIGINAL and ACTUAL agree for mono/stereo at 44.1/48/96kHz; chunk boundaries are irrelevant',async()=>{
  for(const rate of [44100,48000,96000]) for(const channels of [1,2]) {
    const input=tone(rate,channels), current=await analyzeIntegratedLufs(input)
    near(measure(input).actualLufs,current,1e-10)
    near(measure(input,{},257).actualLufs,current,1e-10)
    const meter=new IntegratedLufsMeter(rate,channels,input.length)
    for(let i=0;i<input.length;i+=123)meter.push(Array.from({length:channels},(_,c)=>input.getChannelData(c).subarray(i,i+123)))
    near(meter.finish(),current,1e-10)
  }
})
test('AUTO and OUTPUT follow dB law; width measures actual M/S cancellation and mono remains unchanged',()=>{
  const input=tone(),base=measure(input).actualLufs
  near(measure(input,{autoGainDb:4.4}).actualLufs,base+4.4,1e-6)
  near(measure(input,{outputDb:-2.3}).actualLufs,base-2.3,1e-6)
  near(measure(input,{autoGainDb:4.4,outputDb:2.3}).actualLufs,base+6.7,1e-6)
  const l=input.getChannelData(0),stereo=audio([l,Float32Array.from(l,v=>-v)])
  assert.equal(measure(stereo,{widthPercent:0}).actualLufs,null)
  near(measure(stereo,{widthPercent:200}).actualLufs,measure(stereo).actualLufs+20*Math.log10(2),1e-6)
  near(measure(input,{widthPercent:0}).actualLufs,measure(input,{widthPercent:200}).actualLufs)
})
test('limiter reduction and all ceilings are reflected in measured loudness rather than nominal gain',()=>{
  const input=tone(48000,2,.8),base=measure(input).actualLufs
  near(measure(input,{autoGainDb:6}).actualLufs,base+6,1e-6)
  let previous=Infinity
  for(const ceilingDb of [-.1,-.5,-1,-2]) {
    const result=measure(input,{autoGainDb:6,limiterEnabled:true,ceilingDb})
    assert.ok(result.actualLufs<base+6-2)
    assert.ok(result.actualLufs<previous);previous=result.actualLufs
    assert.ok(result.peaks.every(p=>p<=10**(ceilingDb/20)))
  }
})
test('silence, short audio and memory contain only ring/filter state plus block energies',()=>{
  assert.equal(measure(tone(48000,1,0)).actualLufs,null)
  const short=measure(audio([new Float32Array(10)]))
  assert.match(short.analysisError,/0.4秒/);assert.equal(short.peaks.length,10)
  const meter=new IntegratedLufsMeter(48000,2,48000*3600)
  assert.equal(meter.states.length,2);assert.equal(meter.states[0].ring.length,19200)
  assert.equal(meter.energies.length,35997)
  assert.throws(()=>meter.finish(),/Incomplete/)
})
test('single-pass service fallback agrees with streamed meter and cancellation stops old work',async()=>{
  const saved=globalThis.Worker
  globalThis.Worker=class {constructor(){throw Error('unavailable')}}
  try {
    const input=tone(),config={...defaults,autoGainDb:6}
    const result=await generateProcessedAnalysis(input,config),expected=measure(input,config)
    assert.deepEqual(result,expected)
    const controller=new AbortController(),pending=generateProcessedAnalysis(input,config,controller.signal)
    setTimeout(()=>controller.abort(),0);await assert.rejects(pending,{name:'AbortError'})
    await assert.rejects(generateProcessedAnalysis(input,config,controller.signal),{name:'AbortError'})
  }finally{globalThis.Worker=saved}
})
test('exported 16bit WAV reloaded CURRENT matches ACTUAL with gain/width/limiter at all sample rates',async()=>{
  for(const rate of [44100,48000,96000]) for(const channels of [1,2]) for(const limiterEnabled of [true,false]) {
    const input=tone(rate,channels,limiterEnabled ? .8 : .15), config={...defaults,autoGainDb:4.4,outputDb:1.1,widthPercent:170,limiterEnabled,ceilingDb:-.5}
    const actual=measure(input,config).actualLufs,wav=await createProcessedWav(input,config),view=new DataView(await wav.blob.arrayBuffer())
    const pcm=Array.from({length:channels},(_,c)=>Float32Array.from({length:input.length},(_,i)=>view.getInt16(44+(i*channels+c)*2,true)/32768))
    near(await analyzeIntegratedLufs(audio(pcm,rate)),actual,.003)
  }
})
