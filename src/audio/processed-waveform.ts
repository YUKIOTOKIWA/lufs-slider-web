import { ProcessedAccumulator } from './processed-analysis'
import type { ProcessedAnalysis } from './processed-analysis'
import workerUrl from './waveform-worker.ts?worker&url'
import { StreamingRender } from './streaming-render'
import { normalizeSettings } from './processing-core'
import type { ProcessingSettings } from './processing-core'

type AudioData = Pick<AudioBuffer, 'length' | 'sampleRate' | 'numberOfChannels' | 'getChannelData'>
const CHUNK_SIZE = 16384
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Waveform cancelled', 'AbortError')
}

/** One PCM chunk in flight; never clones or retains a complete processed track. */
export async function generateProcessedAnalysis(audio: AudioData, settings: ProcessingSettings, signal?: AbortSignal): Promise<ProcessedAnalysis> {
  checkAbort(signal)
  const snapshot = normalizeSettings({ ...settings })
  if (audio.numberOfChannels !== 1 && audio.numberOfChannels !== 2) throw new Error('波形処理はモノラル／ステレオ音源に対応しています。')
  try {
    return await new Promise<ProcessedAnalysis>((resolve, reject) => {
      const worker = new Worker(workerUrl, { type: 'module' })
      let offset = 0
      const cleanup = () => { worker.terminate(); signal?.removeEventListener('abort', abort) }
      const abort = () => { cleanup(); reject(new DOMException('Waveform cancelled', 'AbortError')) }
      signal?.addEventListener('abort', abort, { once: true })
      worker.onerror = () => { cleanup(); reject(new Error('Waveform worker failed')) }
      worker.onmessageerror = () => { cleanup(); reject(new Error('Waveform worker message failed')) }
      worker.onmessage = ({ data }) => {
        if (signal?.aborted) { abort(); return }
        try {
          if (data.type === 'next') {
            if (offset < audio.length) {
              const end = Math.min(offset + CHUNK_SIZE, audio.length)
              const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel).slice(offset, end))
              offset = end
              worker.postMessage({ type: 'chunk', channels }, channels.map(channel => channel.buffer))
            } else worker.postMessage({ type: 'finish' })
          } else if (data.type === 'done') { cleanup(); resolve({ peaks: data.peaks, actualLufs: data.actualLufs, analysisError: data.analysisError }) }
          else if (data.type === 'error') { cleanup(); reject(new Error(data.message)) }
        } catch (error) { cleanup(); reject(error) }
      }
      try {
        worker.postMessage({ type: 'init', rate: audio.sampleRate, channels: audio.numberOfChannels, length: audio.length, settings: snapshot })
      } catch (error) { cleanup(); reject(error) }
    })
  } catch {
    checkAbort(signal)
    // Worker unavailable: same engine, cooperative smaller slices keep the UI responsive.
    const renderer = new StreamingRender(audio.sampleRate, audio.numberOfChannels, audio.length, snapshot)
    const accumulator = new ProcessedAccumulator(audio.sampleRate, audio.numberOfChannels, audio.length)
    for (let offset = 0; offset < audio.length; offset += 4096) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      checkAbort(signal)
      const end = Math.min(offset + 4096, audio.length)
      accumulator.add(renderer.push(Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel).subarray(offset, end))))
    }
    checkAbort(signal)
    accumulator.add(renderer.finish())
    return accumulator.finish()
  }
}

/** Compatibility API; waveform and meter share a single render. */
export async function generateProcessedPeaks(audio: AudioData, settings: ProcessingSettings, signal?: AbortSignal): Promise<Float32Array> {
  return (await generateProcessedAnalysis(audio, settings, signal)).peaks
}
