// Persists recorded tracks in IndexedDB so they survive reloads.
const DB_NAME = 'portastudio';
const STORE = 'tracks';

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

/** Saves one track: index plus raw channel data and sample rate. */
export function saveTrackData(index, sampleRate, channels) {
  return run('readwrite', (s) => {
    s.put({ sampleRate, channels }, index);
  });
}

/** Returns an array of 4 entries: { sampleRate, channels } or null. */
export async function loadTrackData() {
  const out = [null, null, null, null];
  for (let i = 0; i < 4; i++) {
    const rec = await run('readonly', (s) => s.get(i));
    if (rec) out[i] = rec;
  }
  return out;
}

export function clearTrackData() {
  return run('readwrite', (s) => {
    s.clear();
  });
}
