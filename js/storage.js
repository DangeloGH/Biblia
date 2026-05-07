/* =========================================================
   STORAGE — Firestore (logado) ou localStorage (offline/anônimo)
   ========================================================= */

import {
  FIREBASE_READY, db, doc, getDoc, setDoc, updateDoc, deleteField, deleteDoc,
  collection, getDocs
} from "./firebase-config.js";

let _uid = null;
export function setUid(uid) { _uid = uid; }
export function getUid() { return _uid; }

function lsKey(suffix) {
  return `lectio.${suffix}`;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ---------- KEY GEMINI ----------
export async function saveEncryptedKey(blob, model) {
  const data = { gemini: blob, model: model || "gemini-2.5-flash", updatedAt: Date.now() };

  if (FIREBASE_READY && _uid) {
    try {
      await setDoc(doc(db, "users", _uid), { keyVault: data }, { merge: true });
    } catch (e) {}
  }

  writeJson(lsKey("keyVault"), data);
}

export async function loadEncryptedKey() {
  if (FIREBASE_READY && _uid) {
    try {
      const snap = await getDoc(doc(db, "users", _uid));
      if (snap.exists() && snap.data().keyVault) {
        const data = snap.data().keyVault;
        writeJson(lsKey("keyVault"), data);
        return data;
      }
    } catch (e) {
      console.warn("Firestore offline", e);
    }
  }

  return readJson(lsKey("keyVault"), null);
}

export async function clearEncryptedKey() {
  if (FIREBASE_READY && _uid) {
    try {
      await updateDoc(doc(db, "users", _uid), { keyVault: deleteField() });
    } catch (e) {}
  }
  localStorage.removeItem(lsKey("keyVault"));
}

// ---------- HIGHLIGHTS ----------
// shape: { "livro/cap/v": "gold" | "rose" | ... }
export async function loadHighlights() {
  const local = readJson(lsKey("hl"), {});

  if (FIREBASE_READY && _uid) {
    try {
      const snap = await getDoc(doc(db, "users", _uid, "data", "highlights"));
      if (snap.exists()) {
        const remote = snap.data().items || {};
        const merged = { ...local, ...remote };
        writeJson(lsKey("hl"), merged);
        return merged;
      }
    } catch (e) {}
  }

  return local;
}

export async function setHighlight(key, color) {
  return setHighlights([key], color);
}

// Atualiza várias marcações de uma vez.
// Importante: no Firestore NÃO usamos merge:true aqui, porque remover uma chave
// dentro de items com merge pode preservar a marcação antiga no servidor.
export async function setHighlights(keys, color) {
  const all = await loadHighlights();
  for (const key of keys) {
    if (!key) continue;
    if (color === "none") delete all[key];
    else all[key] = color;
  }

  writeJson(lsKey("hl"), all);

  if (FIREBASE_READY && _uid) {
    try {
      await setDoc(doc(db, "users", _uid, "data", "highlights"), { items: all });
    } catch (e) {
      console.warn("Falha ao salvar marcações no Firestore; mantendo local.", e);
    }
  }

  return all;
}

// ---------- NOTAS ----------
export async function loadNotes() {
  const local = readJson(lsKey("notes"), {});

  if (FIREBASE_READY && _uid) {
    try {
      const snap = await getDoc(doc(db, "users", _uid, "data", "notes"));
      if (snap.exists()) {
        const remote = snap.data().items || {};
        const merged = { ...local, ...remote };
        writeJson(lsKey("notes"), merged);
        return merged;
      }
    } catch (e) {}
  }

  return local;
}

export async function setNote(key, text) {
  const all = await loadNotes();
  if (!text || !text.trim()) delete all[key];
  else all[key] = text;

  writeJson(lsKey("notes"), all);

  if (FIREBASE_READY && _uid) {
    try {
      await setDoc(doc(db, "users", _uid, "data", "notes"), { items: all });
    } catch (e) {
      console.warn("Falha ao salvar notas no Firestore; mantendo local.", e);
    }
  }
}

// ---------- PROGRESSO + PREFS ----------
export function saveProgress(livro, cap) {
  writeJson(lsKey("progress"), { livro, cap });
}

export function loadProgress() {
  return readJson(lsKey("progress"), null);
}

// ---------- CAPÍTULOS LIDOS ----------
// shape: { "livro/cap": true }
export async function loadReadChapters() {
  const local = readJson(lsKey("readChapters"), {});

  if (FIREBASE_READY && _uid) {
    try {
      const snap = await getDoc(doc(db, "users", _uid, "data", "readChapters"));
      if (snap.exists()) {
        const remote = snap.data().items || {};
        const merged = { ...local, ...remote };
        writeJson(lsKey("readChapters"), merged);
        return merged;
      }
    } catch (e) {}
  }

  return local;
}

export async function setReadChapter(key, isRead) {
  const all = await loadReadChapters();
  if (isRead) all[key] = true;
  else delete all[key];

  writeJson(lsKey("readChapters"), all);

  if (FIREBASE_READY && _uid) {
    try {
      await setDoc(doc(db, "users", _uid, "data", "readChapters"), { items: all });
    } catch (e) {
      console.warn("Falha ao salvar progresso de leitura no Firestore; mantendo local.", e);
    }
  }

  return all;
}

export function savePref(key, val) {
  const all = readJson(lsKey("prefs"), {});
  all[key] = val;
  writeJson(lsKey("prefs"), all);
}

export function loadPrefs() {
  return readJson(lsKey("prefs"), {});
}