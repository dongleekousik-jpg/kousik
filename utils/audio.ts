
export const stopNativeAudio = () => {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
};

// --- GLOBAL STATE ---
let activeUtterances: SpeechSynthesisUtterance[] = [];
let isStopped = false;

// --- Web Audio API (High Quality) ---
let globalAudioContext: AudioContext | null = null;
let globalSource: AudioBufferSourceNode | null = null;
let keepAliveSource: AudioBufferSourceNode | null = null;

export const audioCache: Record<string, AudioBuffer> = {};

// --- IndexedDB ---
const DB_NAME = 'GovindaMitraAudioDB_v11';
const STORE_NAME = 'audio_store';

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
        reject('IndexedDB not supported');
        return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const saveAudioToDB = async (key: string, base64: string) => {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(base64, key);
  } catch (e) {
    console.warn('Failed to save audio to DB', e);
  }
};

export const getAudioFromDB = async (key: string): Promise<string | null> => {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result as string || null);
      request.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
};

export function getGlobalAudioContext(): AudioContext {
  if (!globalAudioContext) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    globalAudioContext = new AudioContextClass({ sampleRate: 24000 }); // Match Gemini 24kHz
  }
  return globalAudioContext;
}

// CRITICAL FOR MOBILE: Keeps the audio thread open with "Near Silence"
export function startKeepAlive() {
    const ctx = getGlobalAudioContext();
    
    if (ctx.state === 'suspended') {
        ctx.resume().catch(e => console.error("Ctx resume failed", e));
    }

    try {
        if (keepAliveSource) {
            try { keepAliveSource.stop(); } catch(e){}
            keepAliveSource.disconnect();
        }
        
        // Create a buffer with tiny random noise (imperceptible but keeps hardware awake)
        const bufferSize = 4096; 
        const buffer = ctx.createBuffer(1, bufferSize, 24000);
        const data = buffer.getChannelData(0);
        for(let i=0; i<bufferSize; i++) {
            data[i] = (Math.random() * 0.000001); // Near zero
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true; 
        source.connect(ctx.destination);
        source.start(0);
        keepAliveSource = source;
    } catch (e) {
        console.warn("KeepAlive failed", e);
    }
}

export function stopKeepAlive() {
    if (keepAliveSource) {
        try { keepAliveSource.stop(); } catch(e){}
        keepAliveSource.disconnect();
        keepAliveSource = null;
    }
}

export function unlockAudioContext() {
  const ctx = getGlobalAudioContext();
  if (ctx.state === 'suspended') {
    ctx.resume().catch(e => console.error("Ctx resume failed", e));
  }
}

export const warmupTTS = () => {
    if (typeof window === 'undefined') return;
    unlockAudioContext();
    if ('speechSynthesis' in window) {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        window.speechSynthesis.cancel(); 
    }
}

export function initializeAudioUnlocker() {
    if (typeof window === 'undefined') return;

    if ('speechSynthesis' in window) {
         window.speechSynthesis.onvoiceschanged = () => { };
    }

    const unlock = () => {
        unlockAudioContext();
        window.removeEventListener('touchstart', unlock);
        window.removeEventListener('click', unlock);
    };

    window.addEventListener('touchstart', unlock, { passive: true });
    window.addEventListener('click', unlock, { passive: true });
}

// --- WAV HEADER INJECTION STRATEGY ---
// Instead of manual Float32 conversion (which fails often), we wrap the RAW PCM
// in a valid WAV container and let the browser decode it natively.

function addWavHeader(samples: Uint8Array, sampleRate: number = 24000, numChannels: number = 1, bitDepth: number = 16): ArrayBuffer {
    const buffer = new ArrayBuffer(44 + samples.length);
    const view = new DataView(buffer);

    // RIFF identifier
    writeString(view, 0, 'RIFF');
    // RIFF chunk length
    view.setUint32(4, 36 + samples.length, true);
    // RIFF type
    writeString(view, 8, 'WAVE');
    // format chunk identifier
    writeString(view, 12, 'fmt ');
    // format chunk length
    view.setUint32(16, 16, true);
    // sample format (raw)
    view.setUint16(20, 1, true);
    // channel count
    view.setUint16(22, numChannels, true);
    // sample rate
    view.setUint32(24, sampleRate, true);
    // byte rate (sampleRate * blockAlign)
    view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
    // block align (channel count * bytes per sample)
    view.setUint16(32, numChannels * (bitDepth / 8), true);
    // bits per sample
    view.setUint16(34, bitDepth, true);
    // data chunk identifier
    writeString(view, 36, 'data');
    // data chunk length
    view.setUint32(40, samples.length, true);

    // Write the PCM samples
    const bytes = new Uint8Array(buffer, 44);
    bytes.set(samples);

    return buffer;
}

function writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// This is the main function components should call
export async function base64ToAudioBuffer(base64: string, ctx: AudioContext): Promise<AudioBuffer> {
    // 1. Decode Base64 string to raw binary string
    const binaryString = window.atob(base64.replace(/\s/g, ''));
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    // 2. Add WAV Header (24kHz, 16-bit Mono is standard for Gemini Flash)
    const wavBytes = addWavHeader(bytes, 24000, 1, 16);

    // 3. Decode using browser's native decoder (Robust & Hardware Accelerated)
    return await ctx.decodeAudioData(wavBytes);
}

export function playGlobalAudio(buffer: AudioBuffer, onEnded?: () => void) {
  stopGlobalAudio(); 
  
  const ctx = getGlobalAudioContext();
  
  const play = () => {
       try {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => {
            if (onEnded) onEnded();
        };
        source.start(0);
        globalSource = source;
    } catch (e) {
        console.error("Source start failed", e);
        if(onEnded) onEnded();
    }
  };
  
  if (ctx.state === 'suspended') {
      ctx.resume().then(play).catch(e => {
          console.error("Resume failed, trying play anyway", e);
          play();
      });
  } else {
      play();
  }
}

export function stopGlobalAudio() {
  isStopped = true;
  stopKeepAlive(); 
  stopNativeAudio();

  if (globalSource) {
    globalSource.onended = null;
    try {
      globalSource.stop();
    } catch (e) { }
    globalSource.disconnect();
    globalSource = null;
  }
}

export function pauseGlobalAudio() {
  if (globalAudioContext && globalAudioContext.state === 'running') {
    globalAudioContext.suspend();
  }
  stopKeepAlive();
}

export function resumeGlobalAudio() {
  if (globalAudioContext && globalAudioContext.state === 'suspended') {
    globalAudioContext.resume();
  }
}

// --- NATIVE TTS (FALLBACK) ---
export const speak = (text: string, language: string, onEnd: () => void) => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    onEnd();
    return;
  }

  stopGlobalAudio();
  window.speechSynthesis.cancel();
  activeUtterances = [];
  isStopped = false;

  const rawChunks = text.match(/[^.!?]+[.!?]+|[^\s]+(?=\s|$)/g) || [text];
  const chunks = rawChunks.map(c => c.trim()).filter(c => c.length > 0);

  if (chunks.length === 0) {
      onEnd();
      return;
  }

  const langMap: Record<string, string> = {
      'en': 'en-US',
      'te': 'te-IN',
      'hi': 'hi-IN',
      'ta': 'ta-IN',
      'kn': 'kn-IN'
  };
  
  const targetLang = langMap[language] || 'en-US';
  let currentChunkIndex = 0;

  const playNextChunk = () => {
      if (isStopped || currentChunkIndex >= chunks.length) {
          onEnd();
          return;
      }

      const chunk = chunks[currentChunkIndex];
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = targetLang;
      utterance.rate = 0.9;
      utterance.pitch = 1.0;

      const voices = window.speechSynthesis.getVoices();
      const preferredVoice = 
        voices.find(v => v.lang === targetLang && (v.name.includes("Google") || v.name.includes("Enhanced"))) ||
        voices.find(v => v.lang === targetLang);
      
      if (preferredVoice) utterance.voice = preferredVoice;

      utterance.onend = () => {
          currentChunkIndex++;
          playNextChunk();
      };
      
      utterance.onerror = () => {
          currentChunkIndex++;
          playNextChunk();
      };

      activeUtterances.push(utterance);
      window.speechSynthesis.speak(utterance);
  };

  playNextChunk();
};
