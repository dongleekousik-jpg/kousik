
export const stopNativeAudio = () => {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
};

// Global reference isn't strictly needed if we queue, but good for safety
let currentUtterance: SpeechSynthesisUtterance | null = null;

// Helper to trigger voice loading (async) but we won't await it in speak()
const preloadVoices = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.getVoices();
    }
};

export const speak = (text: string, language: string, onEnd: () => void) => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    console.warn('Speech synthesis not supported');
    onEnd();
    return;
  }

  // Mobile Fix: explicitly resume synthesis to prevent "stuck" state
  if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
  }
  
  // Cancel any ongoing speech immediately
  stopGlobalAudio();
  window.speechSynthesis.cancel();

  // --- CHUNKING STRATEGY ---
  // Long text fails on many Android/Chrome TTS engines.
  // We split by sentence boundaries to keep chunks small.
  // Regex looks for periods, questions, exclamations followed by space or end of string.
  const rawChunks = text.match(/[^.!?]+[.!?]+|[^\s]+(?=\s|$)/g) || [text];
  
  // Clean up chunks
  const chunks = rawChunks.map(c => c.trim()).filter(c => c.length > 0);

  if (chunks.length === 0) {
      onEnd();
      return;
  }

  // --- LANGUAGE SETUP ---
  const langMap: Record<string, string> = {
      'en': 'en-US',
      'te': 'te-IN',
      'hi': 'hi-IN',
      'ta': 'ta-IN',
      'kn': 'kn-IN'
  };
  
  const targetLang = langMap[language] || 'en-US';
  
  // Attempt to find voice ONCE
  const voices = window.speechSynthesis.getVoices();
  // Try exact match -> loose match -> language only match
  const matchingVoice = voices.find(v => v.lang === targetLang) || 
                        voices.find(v => v.lang.replace('_', '-').toLowerCase() === targetLang.toLowerCase()) ||
                        voices.find(v => v.lang.startsWith(language));

  // Queue all chunks
  chunks.forEach((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = targetLang;
      
      if (matchingVoice) {
          utterance.voice = matchingVoice;
      }

      // Adjust rate for non-English to be slightly slower for clarity
      utterance.rate = language === 'en' ? 0.95 : 0.85;
      utterance.pitch = 1.0;

      // Only fire onEnd for the very last chunk
      if (index === chunks.length - 1) {
          utterance.onend = () => {
              currentUtterance = null;
              onEnd();
          };
          utterance.onerror = (e) => {
              console.error('TTS Error (last chunk):', e);
              currentUtterance = null;
              onEnd();
          };
      } else {
          utterance.onerror = (e) => console.warn('TTS Error (chunk):', e);
      }

      currentUtterance = utterance; // Keep ref to latest
      window.speechSynthesis.speak(utterance);
  });
};

// Web Audio API implementation for Gemini TTS

let globalAudioContext: AudioContext | null = null;
let globalSource: AudioBufferSourceNode | null = null;

export const audioCache: Record<string, AudioBuffer> = {};

// --- IndexedDB for Persistent Caching ---
const DB_NAME = 'GovindaMitraAudioDB_v10';
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

// Critical for mobile: Unlock audio context on user interaction
export function unlockAudioContext() {
  const ctx = getGlobalAudioContext();
  
  if (ctx.state === 'suspended') {
    ctx.resume().then(() => {
        // console.log("AudioContext resumed");
    }).catch(e => console.error("Failed to resume audio context", e));
  }
  
  // Play silent buffer to unlock iOS/Safari
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

// Initialize Global Unlock Listeners for Mobile
// This should be called once when the App mounts
export function initializeAudioUnlocker() {
    if (typeof window === 'undefined') return;

    // Trigger voice loading immediately
    preloadVoices();
    if ('speechSynthesis' in window) {
         window.speechSynthesis.onvoiceschanged = () => {
             // Just listening to trigger load
         };
    }

    const unlock = () => {
        unlockAudioContext();
        // Also prime TTS engine for iOS
        if ('speechSynthesis' in window) {
            window.speechSynthesis.resume(); 
            window.speechSynthesis.getVoices(); // Another attempt to load voices
        }
        // Remove listeners after first successful unlock attempt
        window.removeEventListener('touchstart', unlock);
        window.removeEventListener('click', unlock);
        window.removeEventListener('keydown', unlock);
    };

    window.addEventListener('touchstart', unlock, { passive: true });
    window.addEventListener('click', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
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

export function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
