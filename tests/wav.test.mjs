import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const compile = file => ts.transpile(readFileSync(new URL(file, import.meta.url), 'utf8'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
const url = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const core = url(compile('../src/audio/processing-core.ts'))
const render = url(compile('../src/audio/streaming-render.ts').replace("from './processing-core'", `from '${core}'`))
const { StreamingRender, PeakAccumulator } = await import(render)
const { DEFAULT_PROCESSING_SETTINGS: defaults } = await import(core)
const { WavWriter, wavHeader, createProcessedWav, processedFilename } = await import(url(compile('../src/audio/wav-export.ts').replace("from './streaming-render'", `from '${render}'`).replace("from './processing-core'", `from '${core}'`)))
const audio = (channels, rate = 48000) => ({ length: channels[0].length, sampleRate: rate, numberOfChannels: channels.length, getChannelData: c => channels[c] })
test('RIFF header, stereo interleave, signed PCM endpoints and overflow clamping', async () => {
  const writer = new WavWriter(44100, 2, 4)
  writer.append({ offset: 0, channels: [new Float32Array([-2, -.5, 0, 2]), new Float32Array([1, .5, -1, NaN])] })
  const result = writer.finish(), bytes = await result.blob.arrayBuffer(), v = new DataView(bytes)
  assert.equal(Buffer.from(bytes).subarray(0,4).toString(), 'RIFF')
  assert.equal(Buffer.from(bytes).subarray(8,16).toString(), 'WAVEfmt ')
  assert.equal(Buffer.from(bytes).subarray(36,40).toString(), 'data')
  for (const [offset,value,size] of [[4,52,4],[16,16,4],[20,1,2],[22,2,2],[24,44100,4],[28,176400,4],[32,4,2],[34,16,2],[40,16,4]]) assert.equal(size === 4 ? v.getUint32(offset,true) : v.getUint16(offset,true),value)
  assert.deepEqual(Array.from({length:8},(_,i)=>v.getInt16(44+i*2,true)),[-32768,32767,-16384,16384,0,-32768,32767,0])
  assert.equal(result.clippedSamples,2)
  assert.throws(()=>wavHeader(48000,2,2**31), /範囲外/)
  assert.throws(()=>wavHeader(48000,3,10), /範囲外/)
  assert.equal(processedFilename('song.mix.mp3'),'song.mix-LUFS-processed.wav')
})
test('PCM entering WAV encoder exactly equals shared render; export peaks equal waveform peaks and tail length is preserved', async () => {
  const append = WavWriter.prototype.append
  try {
    for (const rate of [44100,48000,96000]) for (const length of [1,239,10003]) for (const channels of [1,2]) {
      const input = Array.from({length:channels},(_,c)=>Float32Array.from({length},(_,i)=>i===length-1 ? .95 : Math.sin(i*(.1+c*.02))*.3))
      const copies = input.map(c=>c.slice())
      for (const limiterEnabled of [true,false]) {
        const config={...defaults,autoGainDb:4.4,outputDb:1.2,widthPercent:170,limiterEnabled,ceilingDb:-.5}
        const reference=new StreamingRender(rate,channels,length,config), expected=input.map(()=>new Float32Array(length)), peaks=new PeakAccumulator(length)
        const consume = block => { peaks.add(block); block.channels.forEach((c,i)=>expected[i].set(c,block.offset)) }
        for(let offset=0;offset<length;offset+=257) consume(reference.push(input.map(c=>c.subarray(offset,offset+257))))
        consume(reference.finish())
        let seen=0
        WavWriter.prototype.append=function(block) {
          block.channels.forEach((c,i)=>assert.deepEqual(c,expected[i].subarray(block.offset,block.offset+c.length)))
          seen+=block.channels[0].length
          return append.call(this,block)
        }
        const result=await createProcessedWav(audio(input,rate),config), v=new DataView(await result.blob.arrayBuffer())
        assert.equal(seen,length); assert.equal(v.byteLength,44+length*channels*2)
        assert.deepEqual(result.peaks,peaks.peaks); assert.deepEqual(input,copies)
        for(let i=0;i<length;i++) for(let c=0;c<channels;c++) {
          const sample=Math.max(-1,Math.min(1,expected[c][i]))
          assert.equal(v.getInt16(44+(i*channels+c)*2,true),Math.round(sample*(sample<0?32768:32767)))
        }
      }
    }
  } finally { WavWriter.prototype.append=append }
})
test('settings snapshot, monotonic progress, yielding and cancellation', async () => {
  const input=audio([new Float32Array(10003).fill(.2)]), config={...defaults,limiterEnabled:false}, progress=[]
  let yielded=false; setTimeout(()=>{yielded=true},0)
  const pending=createProcessedWav(input,config,undefined,p=>progress.push(p)); config.outputDb=6
  const result=await pending
  assert.equal(yielded,true); assert.equal(progress[0],0); assert.equal(progress.at(-1),100)
  assert.ok(progress.every((p,i)=>i===0||p>progress[i-1])); assert.ok(result.peaks.every(p=>Math.abs(p-.2)<1e-7))
  const controller=new AbortController(), cancelled=createProcessedWav(input,config,controller.signal)
  controller.abort(); await assert.rejects(cancelled,{name:'AbortError'})
  await assert.rejects(createProcessedWav(input,config,controller.signal),{name:'AbortError'})
})
