/* =========================================================
   FIREBASE CONFIG — arquivo REAL importado pelo app
   ---------------------------------------------------------
   Este arquivo é seguro: se a configuração estiver vazia,
   incompleta, mascarada ou com erro de Firebase/CDN, o Lectio
   NÃO quebra. Ele cai para modo offline/localStorage.

   PARA ATIVAR LOGIN GOOGLE + SINCRONIZAÇÃO ENTRE DISPOSITIVOS:
   1. Abra https://console.firebase.google.com → seu projeto.
   2. Authentication → Sign-in method → ative Google.
   3. Firestore Database → crie o banco e use regras por usuário.
   4. Cole abaixo o objeto Web App do Firebase, substituindo COLE_AQUI.
   5. Em Authentication → Settings → Authorized domains, adicione
      o domínio onde o Lectio está hospedado.

   IMPORTANTE:
   - Use somente o domínio em authDomain, sem http:// e sem markdown.
   - Use somente o bucket em storageBucket, sem http:// e sem markdown.
   - apiKey/appId Web do Firebase são públicos por design; quem protege
     os dados são as regras do Firestore.
   - Em produção, restrinja Authorized domains no Firebase Auth.
   - No Google Cloud Console, restrinja a API key por HTTP referrer.
   - Publique o arquivo firestore.rules antes de liberar sincronização.
   ========================================================= */

export const firebaseConfig = {
  apiKey: "AIzaSyC-Uwot9A41bc-mlxrh6Z4fjiyax4GphrY",
  authDomain: "lectio-biblia.firebaseapp.com",
  projectId: "lectio-biblia",
  storageBucket: "lectio-biblia.firebasestorage.app",
  messagingSenderId: "311996410237",
  appId: "1:311996410237:web:cff807885fdab887200414",
  measurementId: "G-ZMYS887V1Z"
};

/* =========================================================
   A partir daqui é boilerplate. Não precisa editar.
   ========================================================= */

let FIREBASE_READY = false;
let app = null;
let auth = null;
let db = null;
let FIREBASE_STATUS = {
  ready: false,
  mode: "offline",
  message: "Firebase não configurado; modo offline ativo.",
  cleanedConfig: null,
  error: null
};

let GoogleAuthProvider = class {
  constructor() {
    throw new Error("Firebase não configurado. Edite js/firebase-config.js ou use o modo offline.");
  }
};
let signInWithPopup = async () => {
  throw new Error("Firebase não configurado. Edite js/firebase-config.js ou use o modo offline.");
};
let signInAnonymously = async () => {
  throw new Error("Firebase não configurado. Edite js/firebase-config.js ou use o modo offline.");
};
let signOut = async () => {};
let onAuthStateChanged = (_auth, callback) => {
  queueMicrotask(() => callback(null));
  return () => {};
};

// Stubs Firestore — nunca chamados quando FIREBASE_READY=false,
// mas precisam existir para os imports do app não quebrarem.
let doc = (...path) => ({ __offlineDoc: path });
let collection = (...path) => ({ __offlineCollection: path });
let getDoc = async () => ({ exists: () => false, data: () => ({}) });
let getDocs = async () => ({ docs: [] });
let setDoc = async () => {};
let updateDoc = async () => {};
let deleteDoc = async () => {};
let deleteField = () => Symbol("deleteField");

function normalizeFirebaseValue(key, value) {
  if (typeof value !== "string") return value;
  let v = value.trim();

  // Corrige colagem acidental em Markdown: [dominio](https://dominio)
  const md = v.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (md) v = md[1] || md[2];

  // authDomain/storageBucket devem ser só hostname/bucket, sem protocolo.
  if ((key === "authDomain" || key === "storageBucket") && /^https?:\/\//i.test(v)) {
    try { v = new URL(v).hostname; } catch {}
  }

  return v.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function cleanedConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = normalizeFirebaseValue(k, v);
  return out;
}

function isPlaceholder(v) {
  if (!v || typeof v !== "string") return true;
  const s = v.trim();
  if (!s) return true;
  if (/^(COLE_AQUI|SUA_API_KEY|SUA_CHAVE|SEU_PROJETO|seu-projeto|000000000000|---)$/i.test(s)) return true;
  if (/^(x+|X+)$/.test(s)) return true;
  // Detecta configs mascaradas como "...-xx", "G-xx", "1:...:web:xx".
  if (/(^|[^a-z0-9])x{2,}([^a-z0-9]|$)/i.test(s)) return true;
  if (s.includes("...") || s.includes("[") || s.includes("]") || s.includes("(")) return true;
  return false;
}

function validateConfig(cfg) {
  const required = ["apiKey", "authDomain", "projectId", "appId"];
  const missing = required.filter(k => isPlaceholder(cfg?.[k]));
  if (missing.length) {
    return {
      ok: false,
      message: `Firebase incompleto (${missing.join(", ")}); modo offline ativo.`
    };
  }
  if (!/^[^\s/]+\.firebaseapp\.com$/i.test(cfg.authDomain) && !/^[^\s/]+\.web\.app$/i.test(cfg.authDomain)) {
    return {
      ok: false,
      message: "authDomain inválido. Use algo como seu-projeto.firebaseapp.com, sem http://."
    };
  }
  return { ok: true, message: "Config Firebase preenchida." };
}

const ACTIVE_FIREBASE_CONFIG = cleanedConfig(firebaseConfig);
const validation = validateConfig(ACTIVE_FIREBASE_CONFIG);
FIREBASE_STATUS.cleanedConfig = ACTIVE_FIREBASE_CONFIG;
FIREBASE_STATUS.message = validation.message;

if (validation.ok) {
  try {
    const appMod  = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js");
    const authMod = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js");
    const fsMod   = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");

    app  = appMod.initializeApp(ACTIVE_FIREBASE_CONFIG);
    auth = authMod.getAuth(app);
    db   = fsMod.getFirestore(app);

    GoogleAuthProvider = authMod.GoogleAuthProvider;
    signInWithPopup    = authMod.signInWithPopup;
    signInAnonymously  = authMod.signInAnonymously;
    signOut            = authMod.signOut;
    onAuthStateChanged = authMod.onAuthStateChanged;

    doc          = fsMod.doc;
    collection   = fsMod.collection;
    getDoc       = fsMod.getDoc;
    getDocs      = fsMod.getDocs;
    setDoc       = fsMod.setDoc;
    updateDoc    = fsMod.updateDoc;
    deleteDoc    = fsMod.deleteDoc;
    deleteField  = fsMod.deleteField;

    FIREBASE_READY = true;
    FIREBASE_STATUS = {
      ready: true,
      mode: "firebase",
      message: "Firebase carregado com sucesso.",
      cleanedConfig: ACTIVE_FIREBASE_CONFIG,
      error: null
    };
  } catch (err) {
    FIREBASE_STATUS = {
      ready: false,
      mode: "offline",
      message: "Firebase indisponível; modo offline ativo.",
      cleanedConfig: ACTIVE_FIREBASE_CONFIG,
      error: err?.message || String(err)
    };
    console.warn("[Lectio] Firebase indisponível; seguindo em modo offline.", err);
  }
} else {
  console.info("[Lectio] " + validation.message);
}

export {
  FIREBASE_READY,
  FIREBASE_STATUS,
  app,
  auth,
  db,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signOut,
  onAuthStateChanged,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteField,
  deleteDoc,
  collection,
  getDocs
};
