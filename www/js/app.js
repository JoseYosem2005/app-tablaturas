/*
 * Tab Finder — Web/Capacitor
 * Tablaturas Guitar Pro desde GProTab.net
 *
 * Puerto de la version Kivy/Python original. La logica de red usa
 * CapacitorHttp (peticion nativa) en vez de fetch() del WebView,
 * porque gprotab.net no manda cabeceras CORS y un fetch normal
 * seria bloqueado por el navegador. CapacitorHttp hace la peticion
 * fuera del WebView, asi que no aplica CORS.
 */

const BASE_URL = "https://gprotab.net";
const TOP_N = 5;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

const EXT_COLOR = {
  GP5: "#10b981",
  GP4: "#3b82f6",
  GPX: "#8b5cf6",
  GP3: "#f43f5e",
  GP: "#f59e0b",
};

// Directorios que Capacitor Filesystem soporta SIN pedir permisos
// peligrosos (no hay Directory.* en runtime, son strings literales
// que el plugin nativo interpreta directamente).
const DOWNLOAD_DIR_KEY = "tabfinder_download_dir";
const DEFAULT_DOWNLOAD_DIR = "EXTERNAL_STORAGE";
const VALID_DIRS = new Set(["EXTERNAL_STORAGE", "DOCUMENTS", "CACHE"]);

function getDownloadDir() {
  try {
    const v = localStorage.getItem(DOWNLOAD_DIR_KEY);
    if (v && VALID_DIRS.has(v)) return v;
  } catch (e) {
    // localStorage puede fallar en algunos webviews restringidos
  }
  return DEFAULT_DOWNLOAD_DIR;
}

function setDownloadDir(v) {
  if (!VALID_DIRS.has(v)) return;
  try {
    localStorage.setItem(DOWNLOAD_DIR_KEY, v);
  } catch (e) {
    // se ignora — si no se puede persistir, se usa solo en esta sesion
  }
}

// ---------------------------------------------------------------------------
// Helpers de red — usan el plugin nativo CapacitorHttp
// ---------------------------------------------------------------------------

function getHttp() {
  const plugins = window.Capacitor && window.Capacitor.Plugins;
  if (!plugins || !plugins.CapacitorHttp) {
    throw new Error(
      "CapacitorHttp no esta disponible. Esta app debe correr dentro del shell nativo de Capacitor (no en un navegador suelto)."
    );
  }
  return plugins.CapacitorHttp;
}

async function fetchPage(url, retries = 4) {
  const http = getHttp();
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await http.request({
        method: "GET",
        url,
        headers: HEADERS,
        connectTimeout: 30000,
        readTimeout: 30000,
      });
      if (res.status === 200) return res.data;
      if (res.status === 404) return null;
      if (res.status === 429) {
        await sleep(2 ** (attempt + 1) * 1000);
        continue;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message || "conexion";
    }
    if (attempt < retries - 1) await sleep(2 ** attempt * 1000);
  }
  throw new Error(
    lastErr === "conexion" ? "Sin conexion a internet." : `No se pudo conectar (${lastErr}).`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

function stripAccents(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function toSlug(s) {
  let out = stripAccents(s).toLowerCase();
  out = out.replace(/[^a-z0-9\s-]/g, "");
  out = out.trim().replace(/[\s_]+/g, "-");
  out = out.replace(/-+/g, "-");
  return out;
}

function slugVariants(s) {
  const base = toSlug(s);
  const variants = [base];
  for (const article of ["the-", "los-", "las-", "el-", "la-"]) {
    if (base.startsWith(article)) variants.push(base.slice(article.length));
  }
  if (!base.startsWith("the-")) variants.push(base + "-the");
  return [...new Set(variants)];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArtistPage(html, artistSlug) {
  const pattern = new RegExp(
    "/en/tabs/" + escapeRegex(artistSlug) + "/([^\"'>\\s]+)",
    "gi"
  );
  const seen = new Set();
  const results = [];
  let m;
  while ((m = pattern.exec(html)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    results.push({
      nombre: titleCase(slug.replace(/-/g, " ")),
      cancion_slug: slug,
      artista: titleCase(artistSlug.replace(/-/g, " ")),
      ext: "GP",
      url_tab: `${BASE_URL}/en/tabs/${artistSlug}/${slug}`,
      url: `${BASE_URL}/en/tabs/${artistSlug}/${slug}?download`,
      rating: 0,
      votes: 0,
      downloads: 0,
      size_kb: 0,
      score: 0,
      stars: "",
      meta_ok: false,
    });
  }
  return results;
}

function titleCase(s) {
  return s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
}

function filterBySong(results, songVariants) {
  return results.filter((r) =>
    songVariants.some((sv) => r.cancion_slug === sv || r.cancion_slug.startsWith(sv + "-"))
  );
}

function preliminaryScore(r) {
  const m = r.cancion_slug.match(/-(\d+)$/);
  const n = m ? parseInt(m[1], 10) : 0;
  return -n - r.cancion_slug.length * 0.01;
}

function topCandidates(results, n) {
  return [...results].sort((a, b) => preliminaryScore(b) - preliminaryScore(a)).slice(0, n);
}

async function enrichDetails(r) {
  try {
    const html = await fetchPage(r.url_tab, 3);
    if (html) {
      let m = html.match(/The file is in (\w+) format/i);
      if (m) {
        r.ext = m[1].toUpperCase();
        r.nombre = titleCase(r.cancion_slug.replace(/-/g, " ")) + "." + m[1].toLowerCase();
      }
      m = html.match(/\*\*(\d+(?:\.\d+)?)\/5\*\*\s*-\s*(\d+)\s*vote/i) ||
        html.match(/(\d+(?:\.\d+)?)\/5.*?(\d+)\s*vote/i);
      if (m) {
        r.rating = parseFloat(m[1]);
        r.votes = parseInt(m[2], 10);
      }
      m = html.match(/(\d[\d\s,]*)\s*(?:times downloaded|downloads)/i);
      if (m) r.downloads = parseInt(m[1].replace(/[\s,]/g, ""), 10);
      m = html.match(/~?([\d.]+)\s*kb/i);
      if (m) r.size_kb = parseFloat(m[1]);
    }
  } catch (e) {
    // se ignora — la card se muestra con metadata parcial
  }

  r.score =
    r.rating * Math.log2(r.votes + 2) +
    Math.log10(r.downloads + 1) +
    Math.log2(r.size_kb + 1) * 0.5;
  const filled = Math.round(r.rating);
  r.stars = "★".repeat(filled) + "☆".repeat(5 - filled);
  r.meta_ok = true;
  return r;
}

async function buscarTablaturas(artista, cancion, onProgress) {
  const aVariants = slugVariants(artista);
  const sVariants = slugVariants(cancion);
  const allMatches = [];
  const seenSlugs = new Set();

  for (const aSlug of aVariants) {
    onProgress(`Buscando artista: ${aSlug}…`);
    const html = await fetchPage(`${BASE_URL}/en/tabs/${aSlug}`, 4).catch(() => null);
    if (!html) continue;

    const tabs = parseArtistPage(html, aSlug);
    let matches = filterBySong(tabs, sVariants);
    if (matches.length === 0) {
      onProgress(`Sin coincidencia exacta — mostrando todos los tabs de ${aSlug}`);
      matches = tabs.slice(0, 60);
    }
    for (const r of matches) {
      if (!seenSlugs.has(r.cancion_slug)) {
        seenSlugs.add(r.cancion_slug);
        allMatches.push(r);
      }
    }
    await sleep(300);
  }

  if (allMatches.length === 0) return [];

  const candidates = topCandidates(allMatches, TOP_N);
  onProgress(`${allMatches.length} versiones — analizando las ${candidates.length} mejores…`);

  const enriched = [];
  for (let i = 0; i < candidates.length; i++) {
    onProgress(`Analizando ${i + 1}/${candidates.length}: ${titleCase(candidates[i].cancion_slug.replace(/-/g, " "))}…`);
    enriched.push(await enrichDetails(candidates[i]));
    await sleep(250);
  }

  enriched.sort((a, b) => b.score - a.score);
  return enriched;
}

// ---------------------------------------------------------------------------
// Descarga — usa CapacitorHttp (binario en base64) + plugin Filesystem
// ---------------------------------------------------------------------------

async function descargarArchivo(url, nombre, onProgress) {
  const http = getHttp();
  onProgress("Descargando…");

  const res = await http.request({
    method: "GET",
    url,
    headers: HEADERS,
    responseType: "arraybuffer",
    connectTimeout: 45000,
    readTimeout: 45000,
  });

  if (res.status === 404) throw new Error("Archivo no encontrado en GProTab.");
  if (res.status !== 200) throw new Error(`Error HTTP ${res.status}`);

  const plugins = window.Capacitor && window.Capacitor.Plugins;
  if (!plugins || !plugins.Filesystem) {
    throw new Error("El plugin Filesystem de Capacitor no esta disponible.");
  }

  // CapacitorHttp con responseType arraybuffer devuelve la data ya en base64
  const base64Data = res.data;

  // NOTA: "Directory" NO es un plugin ni existe en window.Capacitor.Plugins.
  // Es solo un enum de conveniencia que exporta el paquete npm de Filesystem
  // para quien usa bundler/import. Como esta app no usa bundler, se pasa
  // directamente el string literal que ese enum representa internamente
  // (ver getDownloadDir(), configurable desde el panel de ajustes).
  const dirValue = getDownloadDir();

  const { Filesystem } = plugins;
  let dest = nombre;
  try {
    await Filesystem.writeFile({
      path: `tablaturas/${dest}`,
      data: base64Data,
      directory: dirValue,
      recursive: true,
    });
  } catch (e) {
    throw new Error("No se pudo guardar el archivo: " + (e.message || e));
  }

  onProgress("Descarga completa");
  return `tablaturas/${dest}`;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const els = {
  artist: document.getElementById("artist"),
  song: document.getElementById("song"),
  searchBtn: document.getElementById("searchBtn"),
  count: document.getElementById("count"),
  results: document.getElementById("results"),
  status: document.getElementById("status"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsClose: document.getElementById("settingsClose"),
  settingsSave: document.getElementById("settingsSave"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  dirSelect: document.getElementById("dirSelect"),
};

let busy = false;

function setStatus(msg, color) {
  els.status.textContent = msg;
  els.status.style.color = color || "var(--muted)";
}

function setBusy(v) {
  busy = v;
  els.searchBtn.disabled = v;
  els.searchBtn.textContent = v ? "Buscando…" : "BUSCAR TABLATURA";
}

function renderResults(results) {
  els.results.innerHTML = "";
  results.forEach((r, i) => {
    const rank = i + 1;
    const card = document.createElement("div");
    card.className = "card" + (rank === 1 ? " rank-1" : "");

    const bar = document.createElement("div");
    bar.className = "card-bar";
    bar.style.background = EXT_COLOR[r.ext] || "var(--muted)";
    card.appendChild(bar);

    const content = document.createElement("div");
    content.className = "card-content";

    const top = document.createElement("div");
    top.className = "card-top";
    const badge = document.createElement("span");
    badge.className = "rank-badge" + (rank <= 3 ? ` medal-${rank}` : "");
    badge.textContent = `#${rank}`;
    const name = document.createElement("span");
    name.className = "card-name";
    name.textContent = r.nombre;
    top.appendChild(badge);
    top.appendChild(name);
    content.appendChild(top);

    if (r.meta_ok) {
      const stars = document.createElement("div");
      stars.className = "card-stars";
      stars.textContent = `${r.stars}  ${r.rating}/5${r.votes ? `  (${r.votes} votos)` : ""}`;
      content.appendChild(stars);

      const metaParts = [];
      if (r.downloads) metaParts.push(`${r.downloads.toLocaleString()} descargas`);
      if (r.size_kb) metaParts.push(`${Math.round(r.size_kb)} kb`);
      metaParts.push(r.artista);
      const meta = document.createElement("div");
      meta.className = "card-meta";
      meta.textContent = metaParts.join(" · ");
      content.appendChild(meta);
    } else {
      const meta = document.createElement("div");
      meta.className = "card-meta";
      meta.textContent = r.artista;
      content.appendChild(meta);
    }

    card.appendChild(content);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const btn = document.createElement("button");
    btn.className = "btn-download";
    btn.textContent = "↓ Bajar";
    btn.addEventListener("click", () => handleDownload(r, btn));
    actions.appendChild(btn);
    card.appendChild(actions);

    els.results.appendChild(card);
  });
}

async function handleDownload(result, btn) {
  btn.textContent = "…";
  btn.disabled = true;
  setStatus("Iniciando descarga…");
  try {
    const dest = await descargarArchivo(result.url, result.nombre, (m) => setStatus(m));
    btn.textContent = "✓ OK";
    btn.classList.add("ok");
    setStatus(`Guardado: ${dest}`, "var(--ok)");
  } catch (e) {
    btn.textContent = "Reintentar";
    btn.disabled = false;
    btn.classList.add("error");
    setStatus(`Error: ${e.message}`, "var(--err)");
  }
}

async function handleSearch() {
  if (busy) return;
  const artist = els.artist.value.trim();
  const song = els.song.value.trim();

  if (!artist) return setStatus("Completa el campo Artista", "var(--err)");
  if (!song) return setStatus("Completa el campo Cancion", "var(--err)");

  setBusy(true);
  els.results.innerHTML = "";
  els.count.textContent = "";
  setStatus("Iniciando busqueda en GProTab.net…");

  try {
    const results = await buscarTablaturas(artist, song, (m) => setStatus(m));
    setBusy(false);
    if (results.length === 0) {
      setStatus("No encontrado. Proba en ingles o nombre mas corto.", "var(--warn)");
      return;
    }
    els.count.textContent = `  Top ${results.length} resultados — ordenados por calidad`;
    setStatus("Toca Bajar en el resultado que quieras");
    renderResults(results);
  } catch (e) {
    setBusy(false);
    setStatus(`Error: ${e.message}`, "var(--err)");
  }
}

// ---------------------------------------------------------------------------
// Panel de configuracion
// ---------------------------------------------------------------------------

function openSettings() {
  els.dirSelect.value = getDownloadDir();
  els.settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  els.settingsOverlay.classList.add("hidden");
}

function saveSettings() {
  setDownloadDir(els.dirSelect.value);
  closeSettings();
  setStatus("Carpeta de descarga guardada", "var(--ok)");
}

els.searchBtn.addEventListener("click", handleSearch);
els.settingsBtn.addEventListener("click", openSettings);
els.settingsClose.addEventListener("click", closeSettings);
els.settingsSave.addEventListener("click", saveSettings);
els.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === els.settingsOverlay) closeSettings();
});
