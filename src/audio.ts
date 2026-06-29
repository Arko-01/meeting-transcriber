// Audio capture for live transcription.
//
// Captures the microphone and/or system/tab audio, mixes them into a single
// mono stream, resamples to 16 kHz (what Whisper expects) via an AudioContext,
// and emits Float32 sample blocks plus a running voice-activity level.

export type CaptureSources = {
  mic: boolean
  system: boolean
}

export type CaptureHandlers = {
  // Called for every block of 16 kHz mono samples.
  onAudio: (samples: Float32Array) => void
  // Smoothed RMS level (0..1) of the most recent block — drives the VU meter
  // and silence detection.
  onLevel: (level: number) => void
}

const TARGET_SAMPLE_RATE = 16000

export class AudioCapture {
  private ctx: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private mixer: GainNode | null = null
  private streams: MediaStream[] = []
  private sources: MediaStreamAudioSourceNode[] = []

  async start(sources: CaptureSources, handlers: CaptureHandlers) {
    if (!sources.mic && !sources.system) {
      throw new Error('Pick at least one audio source.')
    }

    // Forcing the context sample rate makes the browser resample both inputs
    // to 16 kHz for us — no manual resampling needed.
    this.ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    this.mixer = this.ctx.createGain()

    if (sources.mic) {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
      this.addStream(micStream)
    }

    if (sources.system) {
      // getDisplayMedia is the only way a web app can hear Zoom/Meet/Teams or
      // any other app: the user shares a tab/window/screen with audio enabled.
      const dispStream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: true,
      })
      if (dispStream.getAudioTracks().length === 0) {
        dispStream.getTracks().forEach((t) => t.stop())
        throw new Error(
          'No audio was shared. When the picker appears, choose a tab or "Entire Screen" and tick "Share system/tab audio".',
        )
      }
      // We only need the audio — drop the video track to save CPU.
      dispStream.getVideoTracks().forEach((t) => {
        t.stop()
        dispStream.removeTrack(t)
      })
      this.addStream(dispStream)
    }

    // ScriptProcessor is deprecated but universally supported and simple; the
    // heavy lifting (inference) happens off-thread in the worker anyway.
    const processor = this.ctx.createScriptProcessor(4096, 1, 1)
    this.processor = processor

    let smoothed = 0
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      // Copy — the underlying buffer is reused by the audio thread.
      const block = new Float32Array(input.length)
      block.set(input)

      let sumSq = 0
      for (let i = 0; i < block.length; i++) sumSq += block[i] * block[i]
      const rms = Math.sqrt(sumSq / block.length)
      smoothed = smoothed * 0.8 + rms * 0.2

      handlers.onAudio(block)
      handlers.onLevel(Math.min(1, smoothed * 4))
    }

    this.mixer.connect(processor)
    // ScriptProcessor only fires while connected to a destination. Route it
    // through a muted gain so we don't echo the captured audio back out.
    const sink = this.ctx.createGain()
    sink.gain.value = 0
    processor.connect(sink)
    sink.connect(this.ctx.destination)

    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  private addStream(stream: MediaStream) {
    if (!this.ctx || !this.mixer) return
    this.streams.push(stream)
    const src = this.ctx.createMediaStreamSource(stream)
    src.connect(this.mixer)
    this.sources.push(src)
  }

  // Returns true if any capture track is still live (the user may have ended
  // the share from the browser's native control bar).
  isLive(): boolean {
    return this.streams.some((s) => s.getTracks().some((t) => t.readyState === 'live'))
  }

  async stop() {
    this.processor?.disconnect()
    this.sources.forEach((s) => s.disconnect())
    this.mixer?.disconnect()
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    this.streams = []
    this.sources = []
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close()
    this.ctx = null
    this.processor = null
    this.mixer = null
  }
}

export const SAMPLE_RATE = TARGET_SAMPLE_RATE
