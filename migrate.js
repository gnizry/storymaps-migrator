// Core logic: read classic story maps and build new ArcGIS StoryMaps drafts.
// No UI code here, so it can be unit-tested in Node.
(function (root) {
  "use strict";

  const SHARING = "https://www.arcgis.com/sharing/rest";

  const FIELD_ALIASES = {
    name: ["name", "title"],
    caption: ["caption", "description", "desc"],
    pic: ["url", "pic_url", "picture", "image", "media"],
    lon: ["long", "lon", "longitude"],
    lat: ["lat", "latitude"],
  };

  // ------------------------------------------------------------------ http
  let fetchImpl = (typeof fetch !== "undefined") ? fetch.bind(root) : null;
  function setFetch(f) { fetchImpl = f; }

  async function getJSON(url, params) {
    const q = new URLSearchParams(Object.assign({ f: "json" }, params || {}));
    const r = await fetchImpl(url + (url.includes("?") ? "&" : "?") + q.toString());
    const j = await r.json();
    if (j && j.error) throw new Error(url + ": " + (j.error.message || JSON.stringify(j.error)));
    return j;
  }

  async function postForm(url, fields, token) {
    const fd = new FormData();
    fd.append("f", "json");
    if (token) fd.append("token", token);
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      if (v && v.blob) fd.append(k, v.blob, v.filename);
      else fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    const r = await fetchImpl(url, { method: "POST", body: fd });
    const j = await r.json();
    if (j && j.error) throw new Error(url + ": " + (j.error.message || JSON.stringify(j.error)));
    if (j && j.success === false) throw new Error(url + ": request failed");
    return j;
  }

  const itemInfo = (id) => getJSON(`${SHARING}/content/items/${id}`);
  const itemData = (id) => getJSON(`${SHARING}/content/items/${id}/data`);

  // ------------------------------------------------------------------ classify
  function classify(item) {
    const kw = (item.typeKeywords || []).map((k) => k.toLowerCase());
    const url = (item.url || "").toLowerCase();
    const has = (s) => kw.includes(s) || url.includes("/" + s + "/");
    if (item.type === "StoryMap") return { key: "new", label: "StoryMap חדש", target: "כבר בפורמט החדש" };
    if (has("maptour")) return { key: "maptour", label: "Map Tour", target: "Story + Guided Map Tour", auto: true };
    if (has("mapjournal")) return { key: "mapjournal", label: "Map Journal", target: "Story + Sidecar" };
    if (has("mapseries")) return { key: "mapseries", label: "Map Series", target: "Story / Briefing" };
    if (has("cascade")) return { key: "cascade", label: "Cascade", target: "Story + Immersive" };
    if (has("shortlist")) return { key: "shortlist", label: "Shortlist", target: "Story + Explorer Map Tour" };
    if (kw.includes("swipespyglass") || url.includes("storytellingswipe")) return { key: "swipe", label: "Swipe", target: "Story + Swipe" };
    if (url.includes("/elevations/")) return { key: "app", label: "Elevation Profile", target: "Instant App / Experience Builder" };
    if (url.includes("/onepane/")) return { key: "app", label: "OnePane", target: "Instant App" };
    if (item.type === "Web Mapping Application") return { key: "app", label: "אפליקציה", target: "Instant App / Experience Builder" };
    return { key: "other", label: item.type, target: "" };
  }

  // Accepts an item id of a gallery app, a group id, or a single item
  async function listSource(id) {
    let groupId = null;
    try {
      const g = await getJSON(`${SHARING}/community/groups/${id}`);
      if (g && g.id) groupId = g.id;
    } catch (e) { /* not a group */ }
    if (!groupId) {
      const info = await itemInfo(id);
      if (info.type === "Web Mapping Application") {
        const d = await itemData(id).catch(() => ({}));
        const v = (d && d.values) || {};
        if (v.group) groupId = v.group;
        else return [info];
      } else return [info];
    }
    let all = [], start = 1;
    while (start > 0) {
      const r = await getJSON(`${SHARING}/content/groups/${groupId}/search`, { q: "*", num: 100, start });
      all = all.concat(r.results || []);
      start = r.nextStart;
    }
    return all;
  }

  // ------------------------------------------------------------------ helpers
  function pick(attrs, key) {
    const lower = {};
    Object.keys(attrs).forEach((k) => (lower[k.toLowerCase()] = k));
    for (const c of FIELD_ALIASES[key]) if (c in lower) return attrs[lower[c]];
    return null;
  }
  const R = 6378137.0;
  function mercToLonLat(x, y) {
    return [x / R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
  }
  function lonLatToMerc(lon, lat) {
    return [lon * Math.PI / 180 * R, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R];
  }
  function cleanMedia(u) {
    if (!u) return null;
    u = String(u).trim();
    const kind = u.includes("#isVideo") ? "video" : "image";
    u = u.replace(/#is(Image|Video)$/, "").replace(/^http:\/\//, "https://");
    return { url: u, kind };
  }
  function captionToParagraphs(c) {
    if (!c) return [];
    c = String(c).replace(/\r/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d)>/gi, "\n")
      .replace(/<(p|div|li|h\d|ul|ol|span|font)[^>]*>/gi, "")
      .replace(/<\/(ul|ol|span|font)>/gi, "")
      .replace(/<b>/gi, "<strong>").replace(/<\/b>/gi, "</strong>")
      .replace(/<i>/gi, "<em>").replace(/<\/i>/gi, "</em>")
      .replace(/&nbsp;/g, " ");
    return c.split("\n").map((p) => p.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
  }
  function stripTags(s) {
    return String(s || "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
  }
  const isHebrew = (s) => /[֐-׿]/.test(s || "");
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const nid = () => "n-" + hex(6);
  const rid = () => "r-" + hex(6);
  const uuid = () => (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID()
    : `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

  // ------------------------------------------------------------------ Map Tour extraction
  async function extractMapTour(appId) {
    const info = await itemInfo(appId);
    const data = await itemData(appId);
    const v = data.values || {};
    if (!v.webmap) throw new Error("לפריט אין מפת רשת. האם זה Map Tour?");
    const wm = await itemData(v.webmap);
    const src = v.sourceLayer || "";
    const layers = wm.operationalLayers || [];
    const matches = (l) => src && (src === l.id || src.startsWith(l.id) || (l.id || "").startsWith(src));
    let tl = layers.find(matches) || layers.find((l) => l.featureCollection);
    if (!tl) throw new Error("לא נמצאה שכבת נקודות הסיור במפה");

    let features = [];
    if (tl.featureCollection) {
      (tl.featureCollection.layers || []).forEach((fl) => (features = features.concat((fl.featureSet || {}).features || [])));
    } else if (tl.url) {
      const q = await getJSON(tl.url.replace(/\/$/, "") + "/query", { where: "1=1", outFields: "*", returnGeometry: "true", outSR: "4326" });
      features = (q.features || []).map((f) => { f.geometry = Object.assign({}, f.geometry, { _wgs84: true }); return f; });
    } else throw new Error("סוג שכבת סיור לא נתמך");

    const oid = (f) => { const a = f.attributes; for (const k of ["__OBJECTID", "OBJECTID", "ObjectId", "FID", "objectid"]) if (k in a) return a[k]; return null; };
    const byId = new Map(features.map((f) => [oid(f), f]));
    const ordered = v.order ? v.order.filter((o) => o.visible !== false && byId.has(o.id)).map((o) => byId.get(o.id)) : features;

    const warnings = [];
    const places = ordered.map((f) => {
      const a = f.attributes, g = f.geometry || {};
      let lon = parseFloat(pick(a, "lon")), lat = parseFloat(pick(a, "lat"));
      if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) {
        lon = lat = null;
        if (g.x !== undefined && g.y !== undefined) {
          const gx = parseFloat(g.x), gy = parseFloat(g.y);
          const wkid = (g.spatialReference || {}).wkid;
          if (g._wgs84 || wkid === 4326 || (Math.abs(gx) <= 180 && Math.abs(gy) <= 90)) { lon = gx; lat = gy; }
          else [lon, lat] = mercToLonLat(gx, gy);
        }
      }
      const name = stripTags(pick(a, "name"));
      const media = cleanMedia(pick(a, "pic"));
      if (media && media.kind === "video") warnings.push(`"${name}": וידאו - נוסף כקישור, יש להטמיע ידנית`);
      if (lon === null) warnings.push(`"${name}": אין מיקום - הנקודה לא תיכלל`);
      return { name, paragraphs: captionToParagraphs(pick(a, "caption")), media: media && media.url, mediaKind: media && media.kind, lon, lat };
    });

    return {
      appId,
      title: v.title || info.title,
      subtitle: v.subtitle || info.snippet || "",
      itemTitle: info.title,
      tags: info.tags || [],
      firstRecordAsIntro: !!v.firstRecordAsIntro,
      webmapId: v.webmap,
      basemap: wm.baseMap,
      spatialReference: wm.spatialReference || { wkid: 102100 },
      referenceLayers: layers.filter((l) => l !== tl && l.url && !l.featureCollection),
      places,
      warnings,
    };
  }

  // ------------------------------------------------------------------ story JSON
  function newStoryTemplate(byline, locale) {
    const rootId = nid(), cover = nid(), nav = nid(), credits = nid(), theme = rid();
    return {
      root: rootId,
      nodes: {
        [rootId]: { type: "story", data: { storyTheme: theme }, config: { coverDate: "first-published", storyLocale: locale || "en-US" }, children: [cover, nav, credits] },
        [cover]: { type: "storycover", data: { type: "minimal", title: "", summary: "", byline: byline || "", titlePanelPosition: "start" } },
        [nav]: { type: "navigation", data: { links: [] }, config: { isHidden: true } },
        [credits]: { type: "credits" },
      },
      resources: { [theme]: { type: "story-theme", data: { themeId: "summit", themeBaseVariableOverrides: {} } } },
    };
  }

  function setCover(props, title, summary) {
    for (const n of Object.values(props.nodes)) if (n.type === "storycover") { n.data.title = title; n.data.summary = summary; }
  }

  function addTour(props, tour, basemapWebmapId, introParagraphs) {
    const nodes = props.nodes, res = props.resources;
    const basemapRes = rid();
    res[basemapRes] = { type: "webmap", data: { type: "minimal", itemType: "Web Map", itemId: basemapWebmapId } };
    const geometries = {}, places = [];
    for (const p of tour.places) {
      if (p.lon === null || p.lon === undefined) continue;
      const fid = uuid();
      const [x, y] = lonLatToMerc(p.lon, p.lat);
      geometries[fid] = { id: fid, type: "POINT_NUMBERED_TOUR", nodes: [{ long: p.lon, lat: p.lat, proX: x, proY: y }] };
      const titleId = nid();
      nodes[titleId] = { type: "text", data: { text: p.name, type: "h3" } };
      const paras = p.paragraphs.slice();
      if (p.mediaKind === "video" && p.media) paras.push(`<a href="${p.media}" target="_blank">וידאו</a>`);
      const contents = paras.map((t) => { const id = nid(); nodes[id] = { type: "text", data: { text: t, type: "paragraph" } }; return id; });
      const place = { id: nid(), featureId: fid, contents, title: titleId };
      if (p.media && p.mediaKind === "image") {
        const ir = rid(), img = nid(), car = nid();
        res[ir] = { type: "image", data: { src: p.media, provider: "uri" } };
        nodes[img] = { type: "image", data: { image: ir }, config: { placement: { type: "fit", fit: { color: "backgroundColor" } } } };
        nodes[car] = { type: "carousel", children: [img] };
        place.media = car;
      }
      places.push(place);
    }
    const mapId = nid(), tourId = nid();
    nodes[mapId] = { type: "tour-map", data: { geometries, alt: "", basemap: { type: "resource", value: basemapRes } } };
    nodes[tourId] = { type: "tour", data: { type: "guided-tour", subtype: "media-focused", narrativePanelPosition: "start", narrativePanelSize: "small", accentColor: "accentColor1", map: mapId, places } };
    const added = (introParagraphs || []).map((t) => { const id = nid(); nodes[id] = { type: "text", data: { text: t, type: "paragraph" } }; return id; });
    added.push(tourId);
    const children = nodes[props.root].children;
    let at = children.findIndex((c) => (nodes[c] || {}).type === "credits");
    if (at < 0) at = children.length;
    children.splice(at, 0, ...added);
    return places.length;
  }

  function buildTourStory(tour, basemapWebmapId, byline) {
    let t = tour, intro = null;
    if (tour.firstRecordAsIntro && tour.places.length) { intro = tour.places[0].paragraphs; t = Object.assign({}, tour, { places: tour.places.slice(1) }); }
    const props = newStoryTemplate(byline, isHebrew(tour.title) ? "he-IL" : "en-US");
    setCover(props, tour.title, tour.subtitle);
    const count = addTour(props, t, basemapWebmapId, intro);
    return { props, count };
  }

  // ------------------------------------------------------------------ writing to ArcGIS Online
  async function storymapsVersion() {
    try { const r = await fetchImpl("https://storymaps.arcgis.com/version?f=json"); const j = await r.json(); if (j.version) return j.version; } catch (e) { /* ignore */ }
    return "24.12";
  }

  // session: { portal: "https://org.maps.arcgis.com", token, username }
  async function createBasemapWebmap(session, tour) {
    const wm = { operationalLayers: tour.referenceLayers, baseMap: tour.basemap, spatialReference: tour.spatialReference, version: "2.31", authoringApp: "storymaps-migrator", authoringAppVersion: "1" };
    const r = await postForm(`${session.portal}/sharing/rest/content/users/${encodeURIComponent(session.username)}/addItem`, {
      type: "Web Map", title: `${tour.itemTitle} - מפת בסיס לסיור (StoryMaps)`, tags: ["StoryMaps migration"].concat(tour.tags).join(","),
      snippet: `Basemap for the migrated tour of classic app ${tour.appId}`, text: JSON.stringify(wm),
    }, session.token);
    return r.id;
  }

  async function createStoryDraft(session, title, tags, props) {
    const ver = await storymapsVersion();
    const draft = `draft_${Date.now()}.json`;
    const keywords = ["arcgis-storymaps", "StoryMap", "Web Application", "smstatusdraft", `smversiondraft:${ver}`,
      "smeditorapp:storymaps-migrator", `smdraftresourceid:${draft}`].join(",");
    const base = `${session.portal}/sharing/rest/content/users/${encodeURIComponent(session.username)}`;
    const add = await postForm(`${base}/addItem`, {
      type: "StoryMap", title, typeKeywords: keywords, tags: tags.join(","), text: " ",
      thumbnailurl: "https://storymaps.arcgis.com/static/images/item-default-thumbnails/item.jpg",
    }, session.token);
    const id = add.id;
    const blob = new Blob([JSON.stringify(props)], { type: "application/json" });
    await postForm(`${base}/items/${id}/addResources`, {
      file: { blob, filename: draft }, fileName: draft, access: "private",
      properties: { editInfo: { editor: session.username, modified: String(Date.now()), id: hex(21), app: "storymaps-migrator" } },
    }, session.token);
    return id;
  }

  async function migrateMapTour(session, tour, log) {
    log("יוצר מפת בסיס...");
    const wmId = await createBasemapWebmap(session, tour);
    log("מפת בסיס: " + wmId);
    const { props, count } = buildTourStory(tour, wmId, session.username);
    log(`בונה סיפור עם ${count} נקודות...`);
    const id = await createStoryDraft(session, tour.title, ["StoryMaps migration"].concat(tour.tags), props);
    return { storyId: id, webmapId: wmId, count, editUrl: `https://storymaps.arcgis.com/stories/${id}/edit` };
  }

  const api = { setFetch, getJSON, itemInfo, itemData, classify, listSource, extractMapTour, buildTourStory, migrateMapTour, captionToParagraphs, _internal: { mercToLonLat, lonLatToMerc, cleanMedia } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Migrator = api;
})(typeof window !== "undefined" ? window : globalThis);
