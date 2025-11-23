
export const stopNativeAudio = () => {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
};

// --- GLOBAL STATE ---
let activeUtterances: SpeechSynthesisUtterance[] = [];
let isStopped = false;

// Helper to trigger voice loading (async)
const preloadVoices = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.getVoices();
    }
};

// Mobile Safari/Chrome require a direct user interaction to "unlock" the synth.
export const warmupTTS = () => {
    if (typeof window === 'undefined') return;
    
    // 1. Unlock Web Audio API
    unlockAudioContext();

    // 2. Unlock SpeechSynthesis
    if ('speechSynthesis' in window) {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        // Create a silent, tiny utterance to 'grab' the audio focus
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        u.rate = 2; // Fast
        window.speechSynthesis.speak(u);
    }
}

export const speak = (text: string, language: string, onEnd: () => void) => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    console.warn('Speech synthesis not supported');
    onEnd();
    return;
  }

  // Explicitly resume synthesis for mobile
  if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
  }
  
  // Reset state
  stopGlobalAudio();
  window.speechSynthesis.cancel();
  activeUtterances = [];
  isStopped = false;

  // --- IMPROVED CHUNKING STRATEGY ---
  // Fix: The previous regex split by space if punctuation was missing.
  // Now we strictly look for sentence endings (. ! ? |) or play the whole block.
  // This solves the "one word at a time" stuttering in Hindi/Tamil.
  
  const normalizedText = text.replace(/\|/g, '.'); // Handle Hindi 'Poorna Viram'
  
  // Match sentences ending in punctuation OR take the whole remainder if no punctuation
  const rawChunks = normalizedText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalizedText];
  const chunks = rawChunks.map(c => c.trim()).filter(c => c.length > 0);

  if (chunks.length === 0) {
      onEnd();
      return;
  }

  // --- SMART VOICE SELECTION ---
  const langMap: Record<string, string> = {
      'en': 'en-US',
      'te': 'te-IN',
      'hi': 'hi-IN',
      'ta': 'ta-IN',
      'kn': 'kn-IN'
  };
  
  const targetLang = langMap[language] || 'en-US';
  
  const voices = window.speechSynthesis.getVoices();
  
  // Prioritize "Google" or "Enhanced" voices for better quality on Android/iOS
  const preferredVoice = 
      voices.find(v => v.lang === targetLang && (v.name.includes("Google") || v.name.includes("Enhanced") || v.name.includes("Premium"))) ||
      voices.find(v => v.lang === targetLang) || 
      voices.find(v => v.lang.startsWith(language));

  let currentIndex = 0;

  const playNextChunk = () => {
      if (isStopped || currentIndex >= chunks.length) {
          activeUtterances = [];
          onEnd();
          return;
      }

      const chunk = chunks[currentIndex];
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = targetLang;
      
      if (preferredVoice) {
          utterance.voice = preferredVoice;
      }

      // Tuning for better sound
      utterance.rate = 0.9; // Normal speed
      utterance.pitch = 1.0; 

      utterance.onend = () => {
          activeUtterances = activeUtterances.filter(u => u !== utterance);
          currentIndex++;
          playNextChunk();
      };

      utterance.onerror = (e) => {
          console.warn('TTS Error:', e);
          activeUtterances = activeUtterances.filter(u => u !== utterance);
          currentIndex++;
          playNextChunk();
      };

      activeUtterances.push(utterance);
      window.speechSynthesis.speak(utterance);
  };

  playNextChunk();
};

// --- Web Audio API (High Quality) ---

let globalAudioContext: AudioContext | null = null;
let globalSource: AudioBufferSourceNode | null = null;

export const audioCache: Record<string, AudioBuffer> = {};

// --- IndexedDB ---
const DB_NAME = 'GovindaMitraAudioDB_v12'; // Incremented version to clear old cache
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
    // DO NOT force sampleRate. Let the browser decide (fixes mobile playback).
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    globalAudioContext = new AudioContextClass();
  }
  return globalAudioContext;
}

export function unlockAudioContext() {
  const ctx = getGlobalAudioContext();
  
  if (ctx.state === 'suspended') {
    ctx.resume().catch(e => console.error("Ctx resume failed", e));
  }
  
  // Play silent buffer to force unlock on iOS/Android
  try {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (e) {
    // Ignore
  }
}

export function initializeAudioUnlocker() {
    if (typeof window === 'undefined') return;

    preloadVoices();
    if ('speechSynthesis' in window) {
         window.speechSynthesis.onvoiceschanged = () => { /* Load triggers */ };
    }

    const unlock = () => {
        unlockAudioContext();
        warmupTTS(); 
        
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
    console.error("Decode failed", e);
    throw e;
  }
}

/**
 * Manually decodes PCM data to AudioBuffer.
 * This is more robust than WAV headers for Desktop browsers.
 */
export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1,
): Promise<AudioBuffer> {
  // Convert Int16 PCM to Float32
  const numSamples = data.byteLength / 2; // 16-bit
  const audioBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);
  const channelData = audioBuffer.getChannelData(0);
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

  for (let i = 0; i < numSamples; i++) {
     // Gemini output is Little Endian
     const int16 = dataView.getInt16(i * 2, true);
     // Normalize to [-1.0, 1.0]
     channelData[i] = int16 < 0 ? int16 / 32768 : int16 / 32767;
  }
  
  return audioBuffer;
}

export function playGlobalAudio(buffer: AudioBuffer, onEnded?: () => void) {
  stopGlobalAudio(); 
  const ctx = getGlobalAudioContext();
  
  // FORCE RESUME for reliability on Desktop
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
          console.error("Resume failed", e);
          play();
      });
  } else {
      play();
  }
}

export function stopGlobalAudio() {
  isStopped = true;
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
        