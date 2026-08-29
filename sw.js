// Service worker for the Andhra Mahabharatham reader PWA.
// Bump CACHE_NAME whenever the app shell changes so old caches get cleared.
const CACHE_NAME = 'mahabharatham-shell-v3';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-72.png',
  './icon-96.png',
  './icon-128.png',
  './icon-144.png',
  './icon-152.png',
  './icon-192.png',
  './icon-256.png',
  './icon-384.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

// One file per parva, in canonical 01–18 order. Not all of these exist yet
// (08–15 are uploaded later) — installed individually below so a missing
// one never blocks caching the rest.
const DATA_FILES = [
  './datafiles/01Adi.js',
  './datafiles/02sabhA.js',
  './datafiles/03AraNya.js',
  './datafiles/04virATa.js',
  './datafiles/05udyOga.js',
  './datafiles/06bhIShma.js',
  './datafiles/07drONa.js',
  './datafiles/08karNa.js',
  './datafiles/09Salya.js',
  './datafiles/10sauptika.js',
  './datafiles/11strI.js',
  './datafiles/12SAMti.js',
  './datafiles/13AnuSAsanika.js',
  './datafiles/14aSvamEdha.js',
  './datafiles/15ASramavAsa.js',
  './datafiles/16mausala.js',
  './datafiles/17mahAprasthAnika.js',
  './datafiles/18svargArOhaNa.js',
  './dataupdatedOn.js'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache){
        return cache.addAll(APP_SHELL).then(function(){
          // Cache each data file independently so a parva that hasn't been
          // uploaded yet (404) doesn't abort caching everything else.
          return Promise.all(
            DATA_FILES.map(function(url){
              return cache.add(url).catch(function(){ /* not uploaded yet — fine */ });
            })
          );
        });
      })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_NAME; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){ return self.clients.claim(); })
  );
});

function networkFirst(request){
  return fetch(request)
    .then(function(response){
      if(response && response.ok){
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function(cache){ cache.put(request, copy); });
      }
      return response;
    })
    .catch(function(){ return caches.match(request); });
}

function cacheFirst(request){
  return caches.match(request).then(function(cached){
    if(cached) return cached;
    return fetch(request).then(function(response){
      if(response && response.ok){
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function(cache){ cache.put(request, copy); });
      }
      return response;
    });
  });
}

self.addEventListener('fetch', function(event){
  const req = event.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return; // don't intercept cross-origin requests (e.g. Google Fonts)

  // index.html, the per-parva datafiles, and dataupdatedOn.js all change
  // over time (new parvas, fixes, version bumps) — prefer fresh network
  // data but fall back to the last cached copy when offline.
  if(url.pathname.endsWith('/') || url.pathname.endsWith('index.html') ||
     url.pathname.indexOf('/datafiles/') !== -1 || url.pathname.endsWith('dataupdatedOn.js')){
    event.respondWith(networkFirst(req));
    return;
  }

  // Icons, manifest, etc. rarely change — serve from cache first.
  event.respondWith(cacheFirst(req));
});
