

export const stopNativeAudio = () => {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
};

// Global reference to prevent garbage collection of the utterance
let currentUtterance: SpeechSynthesisUtterance | null = null;

const waitForVoices = (): Promise<SpeechSynthesisVoice[]> => {
    return new Promise((resolve) => {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
            resolve(voices);
            return;
        }
        
        // Timeout to prevent hanging if voices never load
        const timeout = setTimeout(() => {
            resolve([]);
        }, 3000);

        window.speechSynthesis.onvoiceschanged = () => {
            clearTimeout(timeout);
            resolve(window.speechSynthesis.getVoices());
        };
    });
};

export const speak = async (text: string, language: string, onEnd: () => void) => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    console.warn('Speech synthesis not supported');
    onEnd();
    return;
  }

  // Mobile Fix: explicitly resume synthesis to prevent "stuck" state on Android/iOS
  if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
  }
  
  // Cancel any ongoing speech immediately
  stopGlobalAudio();
  window.speechSynthesis.cancel();

  // Create utterance
  const utterance = new SpeechSynthesisUtterance(text);
  currentUtterance = utterance; // Keep reference!

  // --- CRITICAL: Set correct BCP 47 Language Tags for Mobile ---
  // This tells iOS/Android to switch to the correct language engine (e.g. Telugu)
  // instead of trying to read Telugu text with an English voice.
  const langMap: Record<string, string> = {
      'en': 'en-US',
      'te': 'te-IN',
      'hi': 'hi-IN',
      'ta': 'ta-IN',
      'kn': 'kn-IN'
  };
  
  const targetLang = langMap[language] || 'en-US';
  utterance.lang = targetLang;

  // Robust Voice Selection: Wait for voices to load first
  const voices = await waitForVoices();
  
  // Try to find a voice that specifically matches the requested language
  const matchingVoice = voices.find(v => v.lang === targetLang) || 
                        voices.find(v => v.lang.includes(language));

  if (matchingVoice) {
      utterance.voice = matchingVoice;
      console.log(`Selected Voice: ${matchingVoice.name} (${matchingVoice.lang})`);
  } else {
      console.log(`No specific voice found for ${targetLang}, relying on OS default.`);
  }

  // Rate/Pitch adjustment
  // Keep rate slightly slower for non-English to ensure clarity
  utterance.rate = language === 'en' ? 0.9 : 0.85; 
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

  try {
     window.speechSynthesis.speak(utterance);
  } catch (e) {
     console.error("Speech synthesis failed immediately", e);
     onEnd();
  }
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
        console.log("AudioContext resumed successfully");
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

    const unlock = () => {
        unlockAudioContext();
        // Also prime TTS engine for iOS
        if ('speechSynthesis' in window) {
            window.speechSynthesis.resume(); 
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
