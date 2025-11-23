

export const stopNativeAudio = () => {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
};

// Global reference to prevent garbage collection of the utterance
let currentUtterance: SpeechSynthesisUtterance | null = null;

export const speak = (text: string, language: string, onEnd: () => void) => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    console.warn('Speech synthesis not supported');
    onEnd();
    return;
  }

  // Cancel any ongoing speech
  stopGlobalAudio();
  window.speechSynthesis.cancel();

  const playUtterance = () => {
      const voices = window.speechSynthesis.getVoices();
      const utterance = new SpeechSynthesisUtterance(text);
      currentUtterance = utterance; // Keep reference to prevent GC

      // Robust Voice Selection
      let selectedVoice = null;
      if (language === 'te') {
          selectedVoice = voices.find(v => v.lang.includes('te') && v.name.includes('Google')) || voices.find(v => v.lang.includes('te'));
      } else if (language === 'hi') {
          selectedVoice = voices.find(v => v.lang.includes('hi') && v.name.includes('Google')) || voices.find(v => v.lang.includes('hi'));
      } else if (language === 'ta') {
          selectedVoice = voices.find(v => v.lang.includes('ta') && v.name.includes('Google')) || voices.find(v => v.lang.includes('ta'));
      } else if (language === 'kn') {
          selectedVoice = voices.find(v => v.lang.includes('kn') && v.name.includes('Google')) || voices.find(v => v.lang.includes('kn'));
      } else {
          selectedVoice = voices.find(v => v.lang === 'en-IN') || 
                          voices.find(v => v.name.includes('Google US English')) ||
                          voices.find(v => v.lang.includes('en'));
      }

      if (selectedVoice) {
          utterance.voice = selectedVoice;
      }

      utterance.rate = 0.85; // Slightly slower for clarity
      utterance.pitch = 1.0;

      utterance.onend = () => {
        currentUtterance = null;
        onEnd();
      };

      utterance.onerror = (e) => {
        console.error('TTS Error:', e);
        currentUtterance = null;
        onEnd();
      };

      window.speechSynthesis.speak(utterance);
  };

  // ROBUST VOICE LOADING:
  // Chrome sometimes loads voices asynchronously. We try to play immediately.
  // If voices are empty, we wait for 'onvoiceschanged'.
  // BUT: We also set a safety timeout (1s). If event never fires, we play anyway (default voice).
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
      playUtterance();
  } else {
      let hasExecuted = false;
      const safePlay = () => {
          if (hasExecuted) return;
          hasExecuted = true;
          window.speechSynthesis.onvoiceschanged = null; // Clean up
          playUtterance();
      };

      // Listener for when voices are ready
      window.speechSynthesis.onvoiceschanged = safePlay;

      // Safety timeout: If voices take too long (or event missed), force play with default voice
      setTimeout(safePlay, 1000);
  }
};

// Web Audio API implementation

let globalAudioContext: AudioContext | null = null;
let globalSource: AudioBufferSourceNode | null = null;

export const audioCache: Record<string, AudioBuffer> = {};

// --- IndexedDB for Persistent Caching ---
const DB_NAME = 'GovindaMitraAudioDB_v11'; // Increment version to clear old cache
const DB_VERSION = 1;
const STORE_NAME = 'audio_store';

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
        reject('IndexedDB not supported');
        return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
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
    console.warn('Failed to read audio from DB', e);
    return null;
  }
};

// ----------------------------------------

export function getGlobalAudioContext(): AudioContext {
  if (!globalAudioContext) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    globalAudioContext = new AudioContextClass();
  }
  return globalAudioContext;
}

// CRITICAL FOR MOBILE: This must be called inside a synchronous click handler
export function prepareAudioContext() {
  const ctx = getGlobalAudioContext();
  
  // 1. Resume if suspended
  if (ctx.state === 'suspended') {
    ctx.resume().catch(e => console.error("Failed to resume audio context", e));
  }

  // 2. Play a tiny silent buffer to unlock the audio engine on iOS/Android
  try {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (e) {
    // Ignore errors during unlock
  }
}

export function decode(base64: string): Uint8Array {
  try {
    const cleanBase64 = base64.replace(/[\s\n\r]/g, '');
    const binaryString = atob(cleanBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    console.error("Failed to decode base64 string", e);
    throw e;
  }
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const length = Math.floor(data.byteLength / 2);
  const dataInt16 = new Int16Array(data.buffer, data.byteOffset, length);
  const frameCount = length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

export function playGlobalAudio(buffer: AudioBuffer, onEnded?: () => void) {
  stopGlobalAudio(); // Stop any existing audio
  const ctx = getGlobalAudioContext();
  
  // Double check state
  if (ctx.state === 'suspended') {
      ctx.resume().catch(e => console.error("Failed to resume audio context", e));
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => {
    if (onEnded) onEnded();
  };
  source.start(0);
  globalSource = source;
}

export function stopGlobalAudio() {
  // Stop Web Audio
  if (globalSource) {
    globalSource.onended = null;
    try {
      globalSource.stop();
    } catch (e) {
      // Ignore
    }
    globalSource.disconnect();
    globalSource = null;
  }
  // Stop Native TTS
  stopNativeAudio();
}

export function pauseGlobalAudio() {
  if (globalAudioContext && globalAudioContext.state === 'running') {
    globalAudioContext.suspend();
  }
}

export function resumeGlobalAudio() {
  if (globalAudioContext && globalAudioContext.state === 'suspended') {
    globalAudioContext.resume();
  }
}
