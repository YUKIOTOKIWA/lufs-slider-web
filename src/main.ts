import './style.css'
import { UI_TEXT } from './ui-text'
import { createProcessedWav, processedFilename } from './audio/wav-export'
import { generateProcessedAnalysis } from './audio/processed-waveform'
import { sharedAmplitudeScale } from './audio/streaming-render'
import { analyzeIntegratedLufs } from './lufs'
import { createComparisonChain as createProcessingChain } from './audio/comparison-chain'
import type { ComparisonChain as ProcessingChain, PlaybackMode } from './audio/comparison-chain'
import type { ProcessingSettings } from './audio/processing-core'

const TARGET_PRESETS = [-16, -14, -12, -10, -9]

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header><span class="brand">LUFS SLIDER <span>WEB</span></span><span class="badge">${UI_TEXT.brandTag}</span></header>
  <main>
    <div class="intro"><p class="eyebrow">YOUR AUDIO, AT A GLANCE</p><h1>${UI_TEXT.introTitle}</h1><p>${UI_TEXT.introDescription}</p></div>
    <ol id="quick-start" class="quick-start" aria-label="${UI_TEXT.quickStartLabel}">${UI_TEXT.steps.map(step => `<li>${step}</li>`).join('')}</ol>
    <section id="drop-zone" class="drop-zone" aria-label="${UI_TEXT.dropLabel}">
      <span class="upload-icon" aria-hidden="true">↥</span><h2>${UI_TEXT.uploadTitle}</h2>
      <p>${UI_TEXT.audioFormats}</p>
      <button id="choose" type="button">${UI_TEXT.choose}</button><input id="file" type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.aiff,.aif" hidden aria-label="${UI_TEXT.fileLabel}">
      <p class="privacy-note">${UI_TEXT.privacy}</p>
    </section>
    <p id="status" class="status" role="status" aria-live="polite">${UI_TEXT.idleStatus}</p>
    <section class="player" aria-label="${UI_TEXT.playerLabel}">
      <div class="file-info"><div><p class="eyebrow">LOADED AUDIO</p><h2 id="filename">${UI_TEXT.unloaded}</h2></div><span id="duration" class="duration">--:--</span></div>
      <div class="loudness-panel" aria-label="${UI_TEXT.loudnessLabel}">
        <div class="loudness-metric"><p class="eyebrow">CURRENT</p><output id="current-lufs" class="metric-value" aria-live="polite">—</output><p class="metric-hint">${UI_TEXT.currentHint}</p></div>
        <div class="loudness-metric target-metric"><label class="eyebrow" for="target-lufs">TARGET</label><output id="target-value" class="metric-value" for="target-lufs">-14.0 <span>LUFS</span></output><input id="target-lufs" type="range" min="-24" max="-8" step="0.1" value="-14" aria-valuetext="-14.0 LUFS"><div class="target-range"><span>-24.0</span><span>-8.0 LUFS</span></div><div class="target-presets" role="group" aria-label="${UI_TEXT.presetGroup}">${TARGET_PRESETS.map(value => `<button id="target-preset-${Math.abs(value)}" type="button" aria-label="${UI_TEXT.presetLabel(value)}" aria-pressed="${value === -14}">${value}</button>`).join('')}</div></div>
        <div class="loudness-metric"><p class="eyebrow">AUTO GAIN</p><output id="gain" class="metric-value">—</output><p class="metric-hint">${UI_TEXT.gainHint}</p></div>
        <div class="loudness-metric actual-metric"><p class="eyebrow">ACTUAL</p><output id="actual-lufs" class="metric-value" aria-live="polite">—</output><p class="metric-hint">${UI_TEXT.actualHint}</p></div>
        <div class="loudness-metric"><p class="eyebrow">DIFFERENCE</p><output id="lufs-difference" class="metric-value">—</output><p id="difference-hint" class="metric-hint">${UI_TEXT.differenceHint}</p></div>
      </div>
      <p id="actual-status" class="analysis-status" role="status">${UI_TEXT.actualWaiting}</p>
      <p id="analysis-status" class="analysis-status" role="status">${UI_TEXT.analysisIntro}</p>
      <div class="settings-toolbar"><button id="reset-settings" type="button" aria-label="${UI_TEXT.resetLabel}">${UI_TEXT.reset}</button><span id="settings-status" role="status"></span></div>
      <div class="processing-panel" aria-label="${UI_TEXT.processingLabel}">
        <div class="processing-control"><label class="eyebrow" for="output-level">OUTPUT LEVEL</label><output id="output-value" class="metric-value" for="output-level">+0.0 <span>dB</span></output><input id="output-level" type="range" min="-6" max="6" step="0.1" value="0" aria-valuetext="0.0 dB"><div class="target-range"><span>-6.0</span><span>+6.0 dB</span></div></div>
        <div class="processing-control"><label class="eyebrow" for="stereo-width">STEREO WIDTH</label><output id="width-value" class="metric-value" for="stereo-width">100 <span>%</span></output><input id="stereo-width" type="range" min="0" max="200" step="1" value="100" aria-valuetext="100% ORIGINAL"><div class="target-range"><span>0 MONO</span><span>100 ORIGINAL</span><span>200 WIDE</span></div></div>
        <div class="processing-control limiter-control"><label class="limiter-toggle" for="limiter-enabled"><span class="eyebrow">LIMITER</span><span><input id="limiter-enabled" type="checkbox" checked><span id="limiter-value">ON</span></span></label><label class="ceiling-label" for="ceiling">CEILING</label><select id="ceiling"><option value="-0.1">-0.1 dBFS</option><option value="-0.5">-0.5 dBFS</option><option value="-1" selected>-1.0 dBFS</option><option value="-2">-2.0 dBFS</option></select></div>
      </div>
      <p id="processing-status" class="analysis-status" role="status">${UI_TEXT.processingIntro}</p>
      <div class="waveform-heading"><span id="waveform-label">PROCESSED WAVEFORM</span><span id="waveform-scale">${UI_TEXT.waveScale(1)}</span></div>
      <p id="waveform-status" class="waveform-status" role="status"></p>
      <div id="waveform" class="waveform"><canvas id="canvas" role="img" aria-label="音源の波形"></canvas><span id="empty-wave">${UI_TEXT.emptyWave}</span><div id="waveform-overlay" class="waveform-overlay" aria-hidden="true" hidden></div><div id="cursor" class="cursor" hidden></div></div>
      <label class="sr-only" for="seek">${UI_TEXT.seekLabel}</label><input id="seek" type="range" min="0" max="1" step="0.01" value="0" disabled>
      <div class="comparison-bar"><div class="comparison-buttons" role="group" aria-label="${UI_TEXT.comparisonLabel}"><button id="mode-original" aria-label="${UI_TEXT.originalLabel}" type="button" aria-pressed="false">ORIGINAL</button><button id="mode-processed" aria-label="${UI_TEXT.processedLabel}" type="button" aria-pressed="true">PROCESSED</button></div><span id="listening-mode" class="listening-mode" role="status">PROCESSED · ${UI_TEXT.selected}</span></div>
      <div class="transport"><div class="buttons"><button id="play" aria-label="${UI_TEXT.playLabel}" class="primary" disabled>▶ PLAY</button><button id="pause" aria-label="${UI_TEXT.pauseLabel}" disabled>Ⅱ PAUSE</button><button id="stop" aria-label="${UI_TEXT.stopLabel}" disabled>■ STOP</button></div><div class="time"><span id="current">0:00</span><span class="separator"> / </span><span id="total">0:00</span></div></div>
      <div class="export-bar"><button id="export-wav" aria-label="${UI_TEXT.exportLabel}" type="button" class="primary" disabled>EXPORT WAV</button><button id="cancel-export" aria-label="${UI_TEXT.cancelExportLabel}" type="button" hidden>${UI_TEXT.cancelExport}</button><a id="download-wav" hidden>${UI_TEXT.download}</a></div>
      <p id="export-note" class="export-note"></p>
      <p id="export-status" class="analysis-status" role="status" aria-live="polite">${UI_TEXT.exportReady}</p>
    </section>
    <footer>LOCAL AUDIO PLAYER <span>${UI_TEXT.privacy}</span></footer>
  </main>`

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const fileInput = get<HTMLInputElement>('file')
const dropZone = get<HTMLDivElement>('drop-zone')
const status = get<HTMLParagraphElement>('status')
const play = get<HTMLButtonElement>('play')
const pause = get<HTMLButtonElement>('pause')
const stop = get<HTMLButtonElement>('stop')
const seek = get<HTMLInputElement>('seek')
const canvas = get<HTMLCanvasElement>('canvas')
const cursor = get<HTMLDivElement>('cursor')
let context: AudioContext | undefined
let buffer: AudioBuffer | undefined
let source: AudioBufferSourceNode | undefined
let peaks = new Float32Array(0)
let processedPeaks: Float32Array = new Float32Array(0)
let actualLufs: number | null = null
let amplitudeScale = 1
let lastWaveMode = ''
let waveformKey = ''
let waveformVersion = 0
let waveformTimer: ReturnType<typeof setTimeout> | undefined
let waveformController: AbortController | undefined
let waveformUpdating = false
let waveformStale = false
let offset = 0
let startedAt = 0
let playing = false
let loading = false
let loadVersion = 0
let actionVersion = 0
let frame = 0
let processingChain: ProcessingChain | undefined
let endTimer: ReturnType<typeof setTimeout> | undefined
let processingFallback = ''
let playbackMode: PlaybackMode = 'processed'
const originalMode = get<HTMLButtonElement>('mode-original')
const processedMode = get<HTMLButtonElement>('mode-processed')
const outputLevel = get<HTMLInputElement>('output-level')
const stereoWidth = get<HTMLInputElement>('stereo-width')
const limiterEnabled = get<HTMLInputElement>('limiter-enabled')
const ceiling = get<HTMLSelectElement>('ceiling')
const targetLufs = get<HTMLInputElement>('target-lufs')
let currentLufs: number | null = null
let analysisController: AbortController | undefined
let exporting = false
let exportController: AbortController | undefined
let downloadUrl: string | undefined
let exportCompleted = false
let exportFeedbackTimer: ReturnType<typeof setTimeout> | undefined
const exportButton = get<HTMLButtonElement>('export-wav')
const cancelExport = get<HTMLButtonElement>('cancel-export')
const downloadLink = get<HTMLAnchorElement>('download-wav')
function setTaskStatus(id: string, message: string, busy = false) {
  get(id).textContent = message
  get(id).setAttribute('data-busy', String(busy))
}
function updateExportUI() {
  exportButton.disabled = !buffer || loading || Boolean(analysisController) || exporting || buffer.numberOfChannels > 2
  cancelExport.hidden = !exporting
  const label = exporting ? UI_TEXT.creatingWav : exportCompleted ? UI_TEXT.exportComplete : 'EXPORT WAV'
  if (exportButton.textContent !== label) exportButton.textContent = label
  exportButton.setAttribute('aria-label', `${label} · ${UI_TEXT.exportLabel}`)
}
function clearExportFeedback() {
  if (exportFeedbackTimer !== undefined) clearTimeout(exportFeedbackTimer)
  exportFeedbackTimer = undefined
  exportCompleted = false
  get('export-note').textContent = ''
}
function clearDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl)
  downloadUrl = undefined
  downloadLink.hidden = true
  downloadLink.removeAttribute('href')
}
async function exportWav() {
  if (!buffer || loading || analysisController || exporting || buffer.numberOfChannels > 2) return
  const audio = buffer, version = loadVersion, settings = processingSettings()
  const name = processedFilename(get('filename').textContent ?? 'audio')
  const controller = new AbortController()
  exportController = controller
  exporting = true
  clearExportFeedback()
  clearDownload()
  setTaskStatus('export-status', UI_TEXT.creatingWav, true)
  updateExportUI()
  try {
    const result = await createProcessedWav(audio, settings, controller.signal, percent => {
      if (exportController === controller && !controller.signal.aborted) setTaskStatus('export-status', UI_TEXT.exportProgress(percent), true)
    })
    if (controller.signal.aborted || version !== loadVersion || buffer !== audio) return
    downloadUrl = URL.createObjectURL(result.blob)
    downloadLink.href = downloadUrl
    downloadLink.download = name
    downloadLink.setAttribute('aria-label', `${UI_TEXT.download}: ${name}`)
    downloadLink.hidden = false
    downloadLink.click()
    get('export-note').textContent = [UI_TEXT.exportDetails(name, audio.sampleRate, audio.numberOfChannels),
      result.clippedSamples ? UI_TEXT.exportClamped : '', currentLufs === null ? UI_TEXT.autoGainZero : ''].filter(Boolean).join(' ')
    exportCompleted = true
    setTaskStatus('export-status', UI_TEXT.exportComplete)
    const completedUrl = downloadUrl
    exportFeedbackTimer = setTimeout(() => {
      if (version !== loadVersion || exporting || downloadUrl !== completedUrl) return
      exportFeedbackTimer = undefined
      exportCompleted = false
      setTaskStatus('export-status', UI_TEXT.exportReady)
      updateExportUI()
    }, 4000)
  } catch {
    if (exportController !== controller || version !== loadVersion) return
    setTaskStatus('export-status', controller.signal.aborted ? UI_TEXT.exportCancelled : UI_TEXT.exportFailed)
  } finally {
    if (exportController === controller) { exportController = undefined; exporting = false; updateExportUI() }
  }
}
exportButton.addEventListener('click', () => void exportWav())
cancelExport.addEventListener('click', () => exportController?.abort())

function updateGain() {
  const target = Number(targetLufs.value)
  updateProcessing()
  updateDifference()
  get('target-value').innerHTML = `${target.toFixed(1)} <span>LUFS</span>`
  targetLufs.setAttribute('aria-valuetext', `${target.toFixed(1)} LUFS`)
  for (const value of TARGET_PRESETS) get(`target-preset-${Math.abs(value)}`).setAttribute('aria-pressed', String(value === target))
  if (currentLufs === null) {
    get('gain').textContent = '—'
    return
  }
  // Use unrounded measurement; round only the final displayed values.
  const gain = target - currentLufs
  const rounded = Math.round(gain * 10) / 10
  get('gain').innerHTML = `${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)} <span>dB</span>`
}
targetLufs.addEventListener('input', updateGain)
for (const value of TARGET_PRESETS) get(`target-preset-${Math.abs(value)}`).addEventListener('click', () => {
  targetLufs.value = String(value)
  updateGain() // Same update path as slider input.
})
get('reset-settings').addEventListener('click', () => {
  targetLufs.value = '-14'
  outputLevel.value = '0'
  stereoWidth.value = '100'
  limiterEnabled.checked = true
  ceiling.value = '-1'
  updateGain() // Apply all settings once; retain audio, source, position and A/B mode.
  get('settings-status').textContent = UI_TEXT.resetDone
})

function processingSettings(): ProcessingSettings {
  return {
    autoGainDb: currentLufs === null ? 0 : Number(targetLufs.value) - currentLufs,
    outputDb: Number(outputLevel.value), widthPercent: Number(stereoWidth.value),
    limiterEnabled: limiterEnabled.checked, ceilingDb: Number(ceiling.value),
  }
}
function updateProcessing() {
  get('settings-status').textContent = ''
  const settings = processingSettings()
  const output = settings.outputDb
  get('output-value').innerHTML = `${output >= 0 ? '+' : ''}${output.toFixed(1)} <span>dB</span>`
  outputLevel.setAttribute('aria-valuetext', `${output.toFixed(1)} dB`)
  get('width-value').innerHTML = `${settings.widthPercent} <span>%</span>`
  stereoWidth.setAttribute('aria-valuetext', `${settings.widthPercent}%`)
  get('limiter-value').textContent = settings.limiterEnabled ? 'ON' : 'OFF'
  ceiling.disabled = !settings.limiterEnabled
  stereoWidth.disabled = buffer?.numberOfChannels !== 2
  processingChain?.update(settings)
  const note = currentLufs === null ? UI_TEXT.gainPending : ''
  const monoNote = buffer?.numberOfChannels === 1 ? UI_TEXT.monoNote : ''
  const limiterNote = !settings.limiterEnabled ? UI_TEXT.limiterOffNote : ''
  get('processing-status').textContent = processingFallback
    ? `${processingFallback} ${UI_TEXT.originalPlayback}`
    : buffer && buffer.numberOfChannels > 2
      ? UI_TEXT.processingUnavailable
      : playbackMode === 'original'
        ? UI_TEXT.originalSettings
        : `${UI_TEXT.processedPlayback}${note}${monoNote}${limiterNote}`
  scheduleProcessedWaveform(settings)
  updateComparisonUI()
}
function updateComparisonUI() {
  const unavailable = Boolean(processingFallback) || Boolean(buffer && buffer.numberOfChannels > 2)
  const effectiveMode = unavailable ? 'original' : playbackMode
  originalMode.setAttribute('aria-pressed', String(effectiveMode === 'original'))
  processedMode.setAttribute('aria-pressed', String(effectiveMode === 'processed'))
  processedMode.disabled = unavailable
  const label = `${effectiveMode.toUpperCase()} · ${playing ? UI_TEXT.listening : UI_TEXT.selected}`
  if (get('listening-mode').textContent !== label) get('listening-mode').textContent = label
  if (effectiveMode !== lastWaveMode) drawWave()
}
function updateDifference() {
  const hint = get('difference-hint'), value = get('lufs-difference')
  if (actualLufs === null) {
    value.textContent = '—'
    value.setAttribute('data-close', 'false')
    hint.textContent = UI_TEXT.differenceHint
    return
  }
  const raw = actualLufs - Number(targetLufs.value)
  const difference = Math.round(raw * 10) / 10
  value.innerHTML = `${difference >= 0 ? '+' : ''}${difference.toFixed(1)} <span>LU</span>`
  value.setAttribute('data-close', String(Math.abs(raw) <= 0.5))
  hint.textContent = Math.abs(raw) <= 0.5 ? UI_TEXT.differenceNear : raw < 0 ? UI_TEXT.differenceBelow : UI_TEXT.differenceAbove
}
function resetActual(calculating = false) {
  actualLufs = null
  get('actual-lufs').textContent = calculating ? UI_TEXT.calculating : '—'
  updateDifference()
  setTaskStatus('actual-status', calculating ? UI_TEXT.analyzingProcessed : UI_TEXT.actualWaiting, calculating)
}
function resetWaveform() {
  resetActual()
  waveformVersion++
  if (waveformTimer !== undefined) clearTimeout(waveformTimer)
  waveformTimer = undefined
  waveformController?.abort()
  waveformController = undefined
  waveformKey = ''
  waveformUpdating = false
  waveformStale = false
  processedPeaks = new Float32Array(0)
  amplitudeScale = 1
  setTaskStatus('waveform-status', '')
}
function scheduleProcessedWaveform(settings: ProcessingSettings) {
  if (!buffer || buffer.numberOfChannels > 2) return
  const key = JSON.stringify(settings)
  if (key === waveformKey) return
  waveformKey = key
  const audio = buffer
  const version = ++waveformVersion
  if (waveformTimer !== undefined) clearTimeout(waveformTimer)
  waveformController?.abort()
  const controller = new AbortController()
  waveformController = controller
  // Retain bounded previous peaks, explicitly marked stale until replaced.
  waveformStale = processedPeaks.length > 0
  waveformUpdating = true
  resetActual(true)
  setTaskStatus('waveform-status', UI_TEXT.updatingWaveform, true)
  drawWave()
  waveformTimer = setTimeout(async () => {
    waveformTimer = undefined
    try {
      const result = await generateProcessedAnalysis(audio, settings, controller.signal)
      if (version !== waveformVersion || controller.signal.aborted || buffer !== audio) return
      waveformUpdating = false
      waveformStale = false
      processedPeaks = result.peaks
      actualLufs = result.actualLufs
      if (result.analysisError) {
        get('actual-lufs').textContent = UI_TEXT.unmeasurable
        setTaskStatus('actual-status', result.analysisError)
      } else if (actualLufs === null) {
        get('actual-lufs').textContent = '−∞ LUFS'
        setTaskStatus('actual-status', UI_TEXT.actualSilent)
      } else {
        get('actual-lufs').innerHTML = `${actualLufs.toFixed(1)} <span>LUFS</span>`
        updateDifference()
        setTaskStatus('actual-status', UI_TEXT.actualReady +
          (!settings.limiterEnabled ? UI_TEXT.exportClippingNote : ''))
      }
      amplitudeScale = sharedAmplitudeScale(peaks, processedPeaks)
      setTaskStatus('waveform-status', UI_TEXT.waveformReady)
      drawWave()
    } catch {
      if (version !== waveformVersion || controller.signal.aborted || buffer !== audio) return
      waveformUpdating = false
      get('actual-lufs').textContent = UI_TEXT.unmeasurable
      setTaskStatus('actual-status', UI_TEXT.actualUnavailable)
      setTaskStatus('waveform-status', UI_TEXT.waveformUnavailable + (waveformStale ? ' ' + UI_TEXT.previousWaveNote : ''))
      waveformKey = ''
      drawWave()
    }
  }, 250)
}
function selectMode(mode: PlaybackMode) {
  playbackMode = mode
  processingChain?.setMode(mode)
  updateProcessing()
}
originalMode.addEventListener('click', () => selectMode('original'))
processedMode.addEventListener('click', () => selectMode('processed'))
outputLevel.addEventListener('input', updateProcessing)
stereoWidth.addEventListener('input', updateProcessing)
limiterEnabled.addEventListener('change', updateProcessing)
ceiling.addEventListener('change', updateProcessing)
updateProcessing()


function resetAnalysis() {
  analysisController?.abort()
  analysisController = undefined
  currentLufs = null
  get('current-lufs').textContent = '—'
  setTaskStatus('analysis-status', UI_TEXT.analysisWaiting)
  updateGain()
}
async function analyzeAudio(audio: AudioBuffer, version: number) {
  const controller = new AbortController()
  analysisController = controller
  get('current-lufs').textContent = UI_TEXT.analyzing
  setTaskStatus('analysis-status', UI_TEXT.analysisRunning, true)
  try {
    const result = await analyzeIntegratedLufs(audio, controller.signal)
    if (version !== loadVersion || controller.signal.aborted) return
    currentLufs = result
    if (result === null) {
      get('current-lufs').textContent = '−∞ LUFS'
      setTaskStatus('analysis-status', UI_TEXT.analysisSilent)
    } else {
      get('current-lufs').innerHTML = `${result.toFixed(1)} <span>LUFS</span>`
      setTaskStatus('analysis-status', UI_TEXT.analysisReady)
    }
    updateGain()
  } catch (error) {
    if (version !== loadVersion || controller.signal.aborted) return
    currentLufs = null
    get('current-lufs').textContent = UI_TEXT.unmeasurable
    setTaskStatus('analysis-status', error instanceof Error ? error.message : UI_TEXT.analysisFailed)
    updateGain()
  } finally {
    if (analysisController === controller) { analysisController = undefined; updateExportUI() }
  }
}

function formatTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor(value / 60) % 60
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` : `${minutes}:${String(value % 60).padStart(2, '0')}`
}
function position() {
  return Math.min(buffer?.duration ?? 0, playing && context ? offset + context.currentTime - startedAt : offset)
}
function update() {
  get('quick-start').hidden = Boolean(buffer)
  const time = position()
  seek.value = String(time)
  get('current').textContent = formatTime(time)
  seek.setAttribute('aria-valuetext', `${formatTime(time)} / ${formatTime(buffer?.duration ?? 0)}`)
  cursor.hidden = !buffer
  cursor.style.left = `${buffer ? time / buffer.duration * 100 : 0}%`
  play.disabled = !buffer || loading || playing
  pause.disabled = !buffer || loading || !playing
  stop.disabled = !buffer || loading
  seek.disabled = !buffer || loading
  updateComparisonUI()
  updateExportUI()
}
function tick() {
  update()
  if (playing) frame = requestAnimationFrame(tick)
}
function halt() {
  actionVersion++
  if (endTimer !== undefined) { clearTimeout(endTimer); endTimer = undefined }
  if (source) {
    source.onended = null
    source.stop()
    source.disconnect()
    source = undefined
  }
  processingChain?.dispose()
  processingChain = undefined
  playing = false
  cancelAnimationFrame(frame)
}
async function start() {
  if (!buffer || !context || loading || playing) return
  const version = ++actionVersion
  try {
    await context.resume()
    if (version !== actionVersion || loading || !buffer) return
    const audio = buffer
    let chain: ProcessingChain | undefined
    let fallback = ''
    try {
      chain = await createProcessingChain(context, audio.numberOfChannels, processingSettings(), playbackMode)
    } catch (error) {
      fallback = error instanceof Error ? error.message : UI_TEXT.processingInitFailed
    }
    if (version !== actionVersion || loading || buffer !== audio) { chain?.dispose(); return }
    processingFallback = fallback || chain?.fallbackReason || ''
    processingChain = chain
    chain?.setMode(playbackMode)
    // Settings may change while the worklet module is loading.
    updateProcessing()
    if (offset >= buffer.duration) offset = 0
    source = context.createBufferSource()
    source.buffer = buffer
    source.connect(processingChain?.input ?? context.destination)
    chain?.onFallback(() => {
      if (processingChain !== chain) return
      processingFallback = chain.fallbackReason
      updateProcessing()
    })
    startedAt = context.currentTime
    source.onended = () => {
      const finish = () => { offset = audio.duration; halt(); update() }
      // Drain the 5ms lookahead tail before disconnecting the processing node.
      if (processingChain) endTimer = setTimeout(finish, processingChain.latencySeconds * 1000 + 20)
      else finish()
    }
    source.start(0, offset)
    playing = true
    tick()
  } catch {
    if (version !== actionVersion) return
    halt()
    status.textContent = UI_TEXT.playFailed
    update()
  }
}
// Aggregate all samples into a bounded cache; yield periodically for large buffers.
async function makePeaks(audio: AudioBuffer, version: number) {
  const count = Math.min(4096, audio.length)
  const result = new Float32Array(count)
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const samples = audio.getChannelData(channel)
    for (let bin = 0; bin < count; bin++) {
      const end = Math.floor((bin + 1) * samples.length / count)
      let peak = result[bin]!
      for (let i = Math.floor(bin * samples.length / count); i < end; i++) peak = Math.max(peak, Math.abs(samples[i]!))
      result[bin] = peak
      if (bin % 128 === 0) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        if (version !== loadVersion) return undefined
      }
    }
  }
  return result
}
function drawWave() {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(ratio, ratio)
  ctx.strokeStyle = '#293a3b'
  ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke()
  const isProcessed = playbackMode === 'processed' && !processingFallback && Boolean(buffer && buffer.numberOfChannels <= 2)
  const values = isProcessed ? processedPeaks : peaks
  lastWaveMode = isProcessed ? 'processed' : 'original'
  const stale = isProcessed && waveformStale
  canvas.setAttribute('data-stale', String(stale))
  canvas.setAttribute('aria-busy', String(isProcessed && waveformUpdating))
  const overlay = get('waveform-overlay')
  overlay.hidden = !isProcessed || (!waveformUpdating && !stale)
  overlay.textContent = waveformUpdating ? UI_TEXT.updatingWaveform + (stale ? ' ' + UI_TEXT.previousWaveNote : '') : UI_TEXT.previousWaveNote
  get('waveform-label').textContent = `${lastWaveMode.toUpperCase()} WAVEFORM${stale ? ' · ' + UI_TEXT.previousSetting : ''}`
  get('waveform-scale').textContent = UI_TEXT.waveScale(amplitudeScale)
  canvas.setAttribute('data-mode', lastWaveMode)
  canvas.setAttribute('aria-label', UI_TEXT.waveLabel(lastWaveMode, stale))
  ctx.fillStyle = isProcessed ? '#65d8c1' : '#9ca9aa'
  const bars = Math.floor(width / 3)
  for (let bar = 0; bar < bars; bar++) {
    let peak = 0
    for (let i = Math.floor(bar * values.length / bars); i < Math.ceil((bar + 1) * values.length / bars); i++) peak = Math.max(peak, values[i] ?? 0)
    const size = Math.max(1, Math.min(1, peak / amplitudeScale) * (height - 32))
    if (values.length) ctx.fillRect(bar * 3, (height - size) / 2, 2, size)
  }
}
async function loadFile(file: File) {
  const version = ++loadVersion
  exportController?.abort()
  exportController = undefined
  exporting = false
  clearExportFeedback()
  clearDownload()
  get('settings-status').textContent = ''
  setTaskStatus('export-status', UI_TEXT.exportWaiting)
  resetWaveform()
  processingFallback = ''
  halt()
  offset = 0
  buffer = undefined
  resetAnalysis()
  peaks = new Float32Array(0)
  loading = true
  get('filename').textContent = file.name
  get('duration').textContent = '--:--'
  get('total').textContent = '0:00'
  get('empty-wave').hidden = false
  get('empty-wave').textContent = UI_TEXT.loadingAudio
  status.textContent = UI_TEXT.decodingAudio
  update(); drawWave()
  try {
    context ??= new AudioContext()
    const decoded = await context.decodeAudioData(await file.arrayBuffer())
    if (version !== loadVersion) return
    const data = await makePeaks(decoded, version)
    if (version !== loadVersion || !data) return
    buffer = decoded
    peaks = data
    amplitudeScale = sharedAmplitudeScale(peaks, processedPeaks)
    seek.max = String(buffer.duration)
    get('duration').textContent = formatTime(buffer.duration)
    get('total').textContent = formatTime(buffer.duration)
    get('empty-wave').hidden = true
    status.textContent = UI_TEXT.audioReady
    updateProcessing()
    void analyzeAudio(decoded, version)
  } catch {
    if (version !== loadVersion) return
    status.textContent = UI_TEXT.audioFailed
    get('empty-wave').textContent = UI_TEXT.chooseAgain
    setTaskStatus('analysis-status', UI_TEXT.analysisLoadFailed)
    updateProcessing()
  } finally {
    if (version === loadVersion) { loading = false; update(); drawWave() }
  }
}
get('choose').addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void loadFile(file); fileInput.value = '' })
let dragDepth = 0
window.addEventListener('dragover', event => event.preventDefault())
window.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; dropZone.classList.remove('dragging') })
dropZone.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; dropZone.classList.add('dragging') })
dropZone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove('dragging') } })
dropZone.addEventListener('drop', event => {
  event.preventDefault()
  const file = event.dataTransfer?.files[0]
  if (file) void loadFile(file)
})
play.addEventListener('click', () => void start())
pause.addEventListener('click', () => { offset = position(); halt(); update() })
stop.addEventListener('click', () => { halt(); offset = 0; update() })
seek.addEventListener('input', () => {
  const wasPlaying = playing
  halt()
  offset = Number(seek.value)
  update()
  if (wasPlaying) void start()
})
const resizeObserver = new ResizeObserver(drawWave)
resizeObserver.observe(canvas)
document.addEventListener('visibilitychange', () => { if (!document.hidden) update() })
if (import.meta.hot) import.meta.hot.dispose(() => { loadVersion++; exportController?.abort(); clearExportFeedback(); clearDownload(); resetWaveform(); analysisController?.abort(); halt(); resizeObserver.disconnect(); void context?.close() })
