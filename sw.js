const CACHE_NAME = "lectio-v67-primeira-experiencia";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/main.js",
  "./js/reader.js",
  "./js/search.js",
  "./js/util.js",
  "./js/share-image.js",
  "./js/oracoes.js",
  "./js/rosario.js",
  "./js/storage.js",
  "./js/crypto.js",
  "./js/gemini.js",
  "./js/firebase-config.js",
  "./livros.json",
  "./livros-ms.json",
  "./livros-en.json",
  "./livros-leandro.json",
  "./livros-pastoral.json",
  "./livros-biblioteca-expandida.json",
  "./biblioteca-expandida.manifest.json",
  "./dados-oracoes/index.json",
  "./dados-oracoes/curadoria.json",
  "./dados-oracoes/essenciais.json",
  "./dados-oracoes/jesus.json",
  "./dados-oracoes/maria.json",
  "./dados-oracoes/santos.json",
  "./dados-oracoes/anjos.json",
  "./dados-oracoes/rosario.json",
  "./dados-oracoes/ladainhas.json",
  "./dados-oracoes/novenas.json",
  "./dados-oracoes/rosario-guiado.json",
  "./dados-oracoes/tercos-guiados.json",
  "./dados-oracoes/liturgicas.json",
  "./dados-oracoes/intencoes.json",
  "./referencias/cruzadas.json",
  "./referencias/catecismo.json",
  "./referencias/catecismo-texto.json"
];

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.allSettled(SHELL.map(async url => {
    const req = new Request(url, { cache: "reload" });
    const res = await fetch(req);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await cache.put(req, res);
  }));
  const failed = results
    .map((r, i) => r.status === "rejected" ? `${SHELL[i]} (${r.reason?.message || r.reason})` : null)
    .filter(Boolean);
  if (failed.length) console.warn("[Lectio SW] Pré-cache parcial:", failed);
}

function cacheMatch(req, opts = {}) {
  return caches.match(req, { ignoreSearch: !!opts.ignoreSearch });
}

async function putInCache(req, res) {
  if (!res || !res.ok) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(req, res.clone());
}

self.addEventListener("install", event => {
  event.waitUntil(
    precacheShell()
      .catch(err => console.warn("[Lectio SW] Pré-cache falhou", err))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Não intercepta APIs/CDNs externos; evita cachear respostas opacas ou tokens.
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => cacheMatch("./index.html", { ignoreSearch: true }))
    );
    return;
  }

  // Textos bíblicos e JSONs: network-first para evitar cache velho;
  // fallback ao cache se estiver offline.
  if (url.pathname.endsWith(".json")) {
    event.respondWith(
      fetch(req)
        .then(res => {
          putInCache(req, res).catch(() => null);
          return res;
        })
        .catch(() => cacheMatch(req))
    );
    return;
  }

  // Shell do app: stale-while-revalidate.
  event.respondWith(
    cacheMatch(req, { ignoreSearch: true }).then(cached => {
      const fresh = fetch(req).then(res => {
        putInCache(req, res).catch(() => null);
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
