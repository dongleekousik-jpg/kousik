
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
const DB_NAME = 'GovindaMitraAudioDB_v10';
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
    globalAudioContext = new AudioContextClass();
  }
  return globalAudioContext;
}

// CRITICAL FOR MOBILE: Keeps the audio thread open while fetching data
export function startKeepAlive() {
    const ctx = getGlobalAudioContext();
    
    // Resume context if suspended (must be done in click handler)
    if (ctx.state === 'suspended') {
        ctx.resume().catch(e => console.error("Ctx resume failed", e));
    }

    // Play a silent buffer in a loop to keep the hardware active
    try {
        if (keepAliveSource) {
            try { keepAliveSource.stop(); } catch(e){}
            keepAliveSource.disconnect();
        }
        
        const buffer = ctx.createBuffer(1, 1, 22050); // Tiny buffer
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true; // Loop silence
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
    
    // Unlock Web Audio
    unlockAudioContext();

    // Unlock SpeechSynthesis (Native)
    if ('speechSynthesis' in window) {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        // Silent utterance to wake up the engine
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        u.rate = 2; 
        window.speechSynthesis.speak(u);
    }
}

export function initializeAudioUnlocker() {
    if (typeof window === 'undefined') return;

    if ('speechSynthesis' in window) {
         window.speechSynthesis.onvoiceschanged = () => { /* Load triggers */ };
    }

    const unlock = () => {
        unlockAudioContext();
        
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

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  // Mobile Safari sometimes needs a copy of the buffer
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  
  return new Promise((resolve, reject) => {
      ctx.decodeAudioData(arrayBuffer, 
          (buffer) => resolve(buffer),
          (err) => reject(err)
      );
  });
}

export function playGlobalAudio(buffer: AudioBuffer, onEnded?: () => void) {
  stopGlobalAudio(); // Stops previous playback AND KeepAlive
  
  const ctx = getGlobalAudioContext();
  
  // Ensure we are running
  if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
          startSource(ctx, buffer, onEnded);
      }).catch(e => {
          console.error("Failed to resume ctx before play", e);
          startSource(ctx, buffer, onEnded);
      });
  } else {
      startSource(ctx, buffer, onEnded);
  }
}

function startSource(ctx: AudioContext, buffer: AudioBuffer, onEnded?: () => void) {
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
}

export function stopGlobalAudio() {
  isStopped = true;
  stopKeepAlive(); // Stop the silence loop
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
  // If resuming, we might need to restart keepAlive if nothing is playing? 
  // Ideally, resume() handles the current active source.
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
  const voices = window.speechSynthesis.getVoices();
  
  // Prioritize "Google" or "Enhanced" voices for better quality
  const preferredVoice = 
      voices.find(v => v.lang === targetLang && (v.name.includes("Google") || v.name.includes("Enhanced"))) ||
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
      if (preferredVoice) utterance.voice = preferredVoice;

      utterance.rate = 0.85; 
      utterance.pitch = 1.0; 

      utterance.onend = () => {
          activeUtterances = activeUtterances.filter(u => u !== utterance);
          currentIndex++;
          playNextChunk();
      };

      utterance.onerror = () => {
          activeUtterances = activeUtterances.filter(u => u !== utterance);
          currentIndex++;
          playNextChunk();
      };

      activeUtterances.push(utterance);
      window.speechSynthesis.speak(utterance);
  };

  playNextChunk();
};
