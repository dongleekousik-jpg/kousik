// audio.ts
/* Robust TTS + WebAudio helpers for Govinda Mitra
   - Works on mobile and desktop
   - Native speechSynthesis with voice heuristics + gap between chunks
   - WebAudio fallback for PCM/base64 audio from server
   - IndexedDB caching
   - AudioContext unlock helper
*/

export const stopNativeAudio = () => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try { window.speechSynthesis.cancel(); } catch (e) { console.warn('stopNativeAudio failed', e); }
};

// ----------------- Global state -----------------
let activeUtterances: SpeechSynthesisUtterance[] = [];
let isStopped = false;

// ----------------- IndexedDB -----------------
const DB_NAME = 'GovindaMitraAudioDB_v12';
const DB_VERSION = 1;
const STORE_NAME = 'audio_store';

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject('IndexedDB not supported'); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
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
    tx.oncomplete = () => { try { db.close(); } catch {} };
  } catch (e) { console.warn('Failed to save audio to DB', e); }
};

export const getAudioFromDB = async (key: string): Promise<string | null> => {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    return await new Promise((resolve) => {
      request.onsuccess = () => { resolve((request.result as string) || null); try { db.close(); } catch {} };
      request.onerror = () => { resolve(null); try { db.close(); } catch {} };
    });
  } catch (e) {
    console.warn('Failed to read audio from DB', e);
    return null;
  }
};

// ----------------- WebAudio core -----------------
let globalAudioContext: AudioContext | null = null;
let globalSource: AudioBufferSourceNode | null = null;

export const audioCache: Record<string, AudioBuffer> = {};

export function getGlobalAudioContext(): AudioContext {
  if (typeof window === 'undefined') throw new Error('AudioContext not available in this environment');
  if (!globalAudioContext) {
    const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) throw new Error('Web Audio API not supported');
    globalAudioContext = new AudioContextClass();
  }
  return globalAudioContext;
}

export function unlockAudioContext() {
  if (typeof window === 'undefined') return;
  try {
    const ctx = getGlobalAudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(e => console.error('resume failed', e));
    // iOS unlock trick
    try {
      const buffer = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      if (typeof src.start === 'function') src.start(0);
      if (typeof src.stop === 'function') src.stop(0);
    } catch (e) {}
  } catch (e) {
    // ignore in non-browser
  }
}

// ----------------- Helpers: base64 <-> Uint8 -----------------
export function decode(base64: string): Uint8Array {
  const clean = base64.replace(/[\s\r\n]+/g, '');
  const binary = atob(clean);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ----------------- Voice loading and selection -----------------
async function waitForVoices(timeout = 2000): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  const synth = window.speechSynthesis;
  let voices = synth.getVoices();
  if (voices && voices.length > 0) return voices;

  return new Promise((resolve) => {
    let resolved = false;
    const tryResolve = () => {
      if (resolved) return;
      voices = synth.getVoices();
      if (voices && voices.length > 0) {
        resolved = true;
        cleanup();
        resolve(voices);
      }
    };
    const onVoicesChanged = () => tryResolve();
    const cleanup = () => {
      try { (synth as any).onvoiceschanged = null; } catch {}
      clearInterval(poll);
      clearTimeout(timer);
    };
    try { (synth as any).onvoiceschanged = onVoicesChanged; } catch {}
    const poll = setInterval(tryResolve, 120);
    const timer = setTimeout(() => { if (!resolved) { resolved = true; cleanup(); resolve(synth.getVoices() || []); } }, timeout);
  });
}

function pickVoiceForLanguage(voices: SpeechSynthesisVoice[], appLang: string): SpeechSynthesisVoice | null {
  if (!voices || voices.length === 0) return null;
  const map: Record<string, string> = { en: 'en-US', te: 'te-IN', hi: 'hi-IN', ta: 'ta-IN', kn: 'kn-IN' };
  const preferred = (map[appLang] || appLang).toLowerCase();
  // exact match
  let v = voices.find(x => x.lang && x.lang.toLowerCase() === preferred);
  if (v) return v;
  // base match
  const base = preferred.split('-')[0];
  v = voices.find(x => x.lang && x.lang.toLowerCase().startsWith(base));
  if (v) return v;
  // name heuristics
  const heuristics = ['telugu', 'google', 'wavenet', 'microsoft', 'amazon', 'lekha'];
  const lower = (x: SpeechSynthesisVoice) => ((x.name || '') + ' ' + (x.voiceURI || '')).toLowerCase();
  // strong telugu name match
  v = voices.find(x => lower(x).includes('telugu'));
  if (v) return v;
  for (const h of heuristics) {
    v = voices.find(x => lower(x).includes(h) && x.lang && x.lang.toLowerCase().startsWith(base));
    if (v) return v;
  }
  // fallback to en-IN then anything with base
  v = voices.find(x => x.lang && x.lang.toLowerCase().startsWith('en-in'));
  if (v) return v;
  v = voices.find(x => (x.lang && x.lang.toLowerCase().includes(base)) || lower(x).includes(base));
  return v || voices[0] || null;
}

export async function getAvailableVoices(): Promise<SpeechSynthesisVoice[]> {
  return await waitForVoices(3000);
}

// ----------------- TTS speak (native chunked + gap) -----------------
/**
 * speak(text, language, onEnd)
 * language: app-level code: 'te','hi','en','ta','kn'
 */
export const speak = async (text: string, language: string, onEnd: () => void) => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    console.warn('Speech synthesis not supported');
    onEnd();
    return;
  }

  // Stop any web audio and native speech in progress
  try { stopGlobalAudio(); } catch (e) {}
  try { window.speechSynthesis.cancel(); } catch (e) {}

  // Normalize and chunk text into sentences (respect punctuation)
  const normalizedText = text.replace(/\|/g, '.');
  const rawChunks = normalizedText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalizedText];
  const chunks = rawChunks.map(c => c.trim()).filter(c => c.length > 0);
  if (chunks.length === 0) { onEnd(); return; }

  // Ensure voices loaded
  const voices = await waitForVoices(2000);
  const chosenVoice = pickVoiceForLanguage(voices, language);
  if (!chosenVoice) {
    console.warn('No matching voice found for', language, 'available:', voices.map(v => `${v.name}(${v.lang})`).slice(0,20));
  }

  // gap config (desktop benefits from a short gap)
  const gapMs = 120;
  let idx = 0;
  let stopped = false;

  const playChunk = () => {
    if (stopped || idx >= chunks.length) {
      activeUtterances = [];
      onEnd();
      return;
    }
    const chunk = chunks[idx];
    const u = new SpeechSynthesisUtterance(chunk);

    const langMap: Record<string, string> = { en: 'en-US', te: 'te-IN', hi: 'hi-IN', ta: 'ta-IN', kn: 'kn-IN' };
    u.lang = langMap[language] || 'en-US';
    if (chosenVoice) u.voice = chosenVoice;
    u.rate = 0.95;
    u.pitch = 1.0;
    u.volume = 1.0;

    u.onend = () => {
      activeUtterances = activeUtterances.filter(a => a !== u);
      idx++;
      setTimeout(() => { playChunk(); }, gapMs);
    };

    u.onerror = (e) => {
      console.warn('TTS utterance error', e);
      activeUtterances = activeUtterances.filter(a => a !== u);
      idx++;
      setTimeout(() => { playChunk(); }, gapMs);
    };

    activeUtterances.push(u);
    try { window.speechSynthesis.speak(u); } catch (e) {
      console.error('speak failed', e);
      // continue with next chunk
      idx++;
      setTimeout(() => { playChunk(); }, gapMs);
    }
  };

  // Start playback
  isStopped = false;
  activeUtterances = [];
  stopped = false;
  playChunk();
};

// ----------------- WebAudio decode and playback (PCM16 LE) -----------------
export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1,
): Promise<AudioBuffer> {
  // total 16-bit samples
  const totalSamples = Math.floor(data.byteLength / 2);
  if (totalSamples === 0) return ctx.createBuffer(numChannels, 1, sampleRate);
  const frameCount = Math.floor(totalSamples / numChannels);
  const int16 = new Int16Array(data.buffer, data.byteOffset, frameCount * numChannels);
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const out = buffer.getChannelData(ch);
    let j = ch;
    for (let i = 0; i < frameCount; i++, j += numChannels) {
      const val = int16[j];
      out[i] = val < 0 ? val / 32768 : val / 32767;
    }
  }
  return buffer;
}

export function playGlobalAudio(buffer: AudioBuffer, onEnded?: () => void) {
  stopGlobalAudio();
  const ctx = getGlobalAudioContext();
  const play = () => {
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => { if (onEnded) onEnded(); };
      source.start(0);
      globalSource = source;
    } catch (e) {
      console.error('Source start failed', e);
      if (onEnded) onEnded?.();
    }
  };

  if (ctx.state === 'suspended') {
    ctx.resume().then(play).catch(e => { console.error('resume failed', e); play(); });
  } else {
    play();
  }
}

export function stopGlobalAudio() {
  isStopped = true;
  // stop native synthesis
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
  if (globalSource) {
    try { globalSource.onended = null; } catch {}
    try { globalSource.stop(); } catch {}
    try { globalSource.disconnect(); } catch {}
    globalSource = null;
  }
}

// ----------------- Pause / Resume -----------------
export function pauseGlobalAudio() {
  try {
    if (globalAudioContext && globalAudioContext.state === 'running') globalAudioContext.suspend();
  } catch (e) {}
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
    }
  } catch (e) {}
}

export function resumeGlobalAudio() {
  try {
    if (globalAudioContext && globalAudioContext.state === 'suspended') globalAudioContext.resume();
  } catch (e) {}
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  } catch (e) {}
}

// ----------------- Init unlocker (call once on app mount) -----------------
export function initializeAudioUnlocker() {
  if (typeof window === 'undefined') return;
  // Preload voices (non-blocking)
  try { window.speechSynthesis.getVoices(); } catch (e) {}
  if ('speechSynthesis' in window) {
    try { (window.speechSynthesis as any).onvoiceschanged = () => { /* no-op: triggers load */ }; } catch {}
  }

  const unlock = () => {
    try { unlockAudioContext(); } catch (e) {}
    try {
      // warmup a tiny silent utterance to allow speechSynthesis on some platforms
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    } catch (e) {}
    window.removeEventListener('touchstart', unlock);
    window.removeEventListener('click', unlock);
    window.removeEventListener('keydown', unlock);
  };

  window.addEventListener('touchstart', unlock, { passive: true });
  window.addEventListener('click', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
}

// ----------------- Debug helper -----------------
export function debugListVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    console.log('No speechSynthesis available');
    return;
  }
  console.log('voices:', window.speechSynthesis.getVoices().map(v => `${v.name} — ${v.lang} — ${v.voiceURI}`).slice(0,200));
}

// ----------------- Export remaining helpers (already exported above where needed) -----------------
export { /* functions already exported explicitly above */ };
