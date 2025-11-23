
export const stopNativeAudio = () => {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
};

// --- GLOBAL STATE ---
// We must keep references to active utterances to prevent Garbage Collection
// which causes audio to stop abruptly on Chrome/Android.
let activeUtterances: SpeechSynthesisUtterance[] = [];
let isStopped = false;

// Helper to trigger voice loading (async)
const preloadVoices = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.getVoices();
    }
};

// Mobile Safari/Chrome require a direct user interaction to "unlock" the synth.
// Call this immediately on button click, before any async/fetch operations.
export const warmupTTS = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    
    // Resume if suspended
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();

    // Create a silent, tiny utterance to 'grab' the audio focus
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    u.rate = 10;
    window.speechSynthesis.speak(u);
}

export const speak = (text: string, language: string, onEnd: () => void) => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    console.warn('Speech synthesis not supported');
    onEnd();
    return;
  }

  // Mobile Fix: explicitly resume synthesis
  if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
  }
  
  // Cancel any ongoing speech and reset state
  stopGlobalAudio();
  window.speechSynthesis.cancel();
  activeUtterances = [];
  isStopped = false;

  // --- CHUNKING STRATEGY ---
  // Split by sentence boundaries. This is crucial for long text on Android.
  const rawChunks = text.match(/[^.!?]+[.!?]+|[^\s]+(?=\s|$)/g) || [text];
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
  
  // Attempt to find voice
  const voices = window.speechSynthesis.getVoices();
  const matchingVoice = voices.find(v => v.lang === targetLang) || 
                        voices.find(v => v.lang.replace('_', '-').toLowerCase() === targetLang.toLowerCase()) ||
                        voices.find(v => v.lang.startsWith(language));

  // --- SEQUENTIAL PLAYBACK ---
  // We play chunks one by one. This is safer than queuing them all at once.
  let currentIndex = 0;

  const playNextChunk = () => {
      if (isStopped || currentIndex >= chunks.length) {
          activeUtterances = []; // Clean up
          onEnd();
          return;
      }

      const chunk = chunks[currentIndex];
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = targetLang;
      
      if (matchingVoice) {
          utterance.voice = matchingVoice;
      }

      // Tuning for better sound
      utterance.rate = 0.9; 
      utterance.pitch = 1.0; 

      utterance.onend = () => {
          // Remove this utterance from active list to allow GC
          activeUtterances = activeUtterances.filter(u => u !== utterance);
          currentIndex++;
          playNextChunk();
      };

      utterance.onerror = (e) => {
          console.warn('TTS Error:', e);
          activeUtterances = activeUtterances.filter(u => u !== utterance);
          currentIndex++;
          playNextChunk(); // Try next chunk even if one fails
      };

      // Store ref to prevent GC
      activeUtterances.push(utterance);
      window.speechSynthesis.speak(utterance);
  };

  playNextChunk();
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
    ctx.resume().catch(e => console.error("Failed to resume audio context", e));
  }
  
  // Play silent buffer to unlock iOS/Safari WebAudio
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
export function initializeAudioUnlocker() {
    if (typeof window === 'undefined') return;

    preloadVoices();
    if ('speechSynthesis' in window) {
         window.speechSynthesis.onvoiceschanged = () => { /* Load triggers */ };
    }

    const unlock = () => {
        unlockAudioContext();
        warmupTTS(); // Also unlock SpeechSynthesis
        
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
  // Flag sequential native TTS to stop
  isStopped = true;
  stopNativeAudio();

  // Stop Web Audio
  if (globalSource) {
    globalSource.onended = null;
    try {
      globalSource.stop();
    } catch (e) { /* Ignore */ }
    globalSource.disconnect();
    globalSource = null;
  }
}

export function pauseGlobalAudio() {
  if (globalAudioContext && globalAudioContext.state === 'running') {
    globalAudioContext.suspend();
  }
  if (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
  }
}

export function resumeGlobalAudio() {
  if (globalAudioContext && globalAudioContext.state === 'suspended') {
    globalAudioContext.resume();
  }
  if (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
  }
}
