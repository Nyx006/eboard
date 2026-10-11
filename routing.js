/* ============================================================
   E-BOARD ROUTING ENGINE
   Graph-theory pathfinding over the Legazpi City road network.

   Pipeline:
     1. Load road ways + nodes: the bundled OpenStreetMap snapshot
        (roadgraph.json), or live from the Overpass API if forced or
        the snapshot is unavailable
     2. Build an undirected weighted graph (nodes = intersections /
        road vertices, edges = street segments, weight = metres)
     3. Snap arbitrary coordinates to the nearest graph node
     4. Run Dijkstra's algorithm with a binary min-heap
     5. Return true road distance + the polyline of the actual route

   Falls back to Haversine estimation ONLY if the road network
   cannot be loaded, and flags the result so the UI can say so.
   ============================================================ */

const EBoardRouter = (function () {

    // Bounding box for Legazpi City (south, west, north, east)
    const BBOX = [13.090, 123.690, 13.220, 123.800];

    const OVERPASS_ENDPOINTS = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter'
    ];

    // Caching the built graph means a normal session only parses the
    // road data once every 7 days, not on every page load.
    //
    // roadgraph.json is a real Overpass snapshot bundled with the app,
    // and it is loaded FIRST; live Overpass is only tried if the
    // snapshot itself can't be fetched, or when ?refreshRoads=1 forces
    // it. This used to be the other way round (Overpass first, snapshot
    // as an offline fallback), which had two problems once the app was
    // deployed for evaluation:
    //   - Overpass is a shared public API with no SLA. Measured on
    //     2026-10-11, the first endpoint timed out and the road network
    //     took ~45 s to load on a desktop connection; respondents on one
    //     campus Wi-Fi IP also risk its per-IP rate limiting. The
    //     snapshot is ~440 KB gzipped from a static host.
    //   - Methodologically, every respondent should evaluate routes over
    //     the SAME road data, not whatever Overpass returned on the day
    //     (or the snapshot, if Overpass happened to be down).
    const CACHE_KEY = 'eboard_roadgraph_v1';
    const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const SNAPSHOT_FILE = 'roadgraph.json';

    // Road types students can actually traverse. motorway/trunk (and
    // their _link variants) are excluded — this is a pedestrian router
    // and those roads are not walkable.
    const ROUTABLE = [
        'primary', 'secondary', 'tertiary',
        'unclassified', 'residential', 'living_street', 'service',
        'pedestrian', 'footway', 'path', 'track', 'steps',
        'primary_link', 'secondary_link', 'tertiary_link'
    ];

    let graph = null;      // { adj: Map<id, [{to, w}]>, coords: Map<id, [lat,lng]> }
    let loading = null;    // in-flight promise, prevents duplicate fetches
    let lastError = null;

    /* ---------- geometry ---------- */

    function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371000; // metres
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLon = (lon2 - lon1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
                  Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /* ---------- binary min-heap (priority queue for Dijkstra) ---------- */

    class MinHeap {
        constructor() { this.h = []; }
        get size() { return this.h.length; }
        push(item) {
            this.h.push(item);
            let i = this.h.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (this.h[p].d <= this.h[i].d) break;
                [this.h[p], this.h[i]] = [this.h[i], this.h[p]];
                i = p;
            }
        }
        pop() {
            const top = this.h[0];
            const last = this.h.pop();
            if (this.h.length) {
                this.h[0] = last;
                let i = 0;
                for (;;) {
                    const l = 2 * i + 1, r = l + 1;
                    let s = i;
                    if (l < this.h.length && this.h[l].d < this.h[s].d) s = l;
                    if (r < this.h.length && this.h[r].d < this.h[s].d) s = r;
                    if (s === i) break;
                    [this.h[s], this.h[i]] = [this.h[i], this.h[s]];
                    i = s;
                }
            }
            return top;
        }
    }

    /* ---------- graph construction ---------- */

    function buildOverpassQuery() {
        const [s, w, n, e] = BBOX;
        const filter = ROUTABLE.join('|');
        // Also pull landuse=military areas (ways and multipolygon
        // relations) in the same request, so buildGraph() can keep
        // pedestrian routes out of compounds like the Naval Forces
        // Southern Luzon Command base. `out body` already returns every
        // tag on the matched ways (access, motor_vehicle included) —
        // no separate tag whitelist is needed for that part.
        return `[out:json][timeout:90];
(
  way["highway"~"^(${filter})$"](${s},${w},${n},${e});
  way["landuse"="military"](${s},${w},${n},${e});
  relation["landuse"="military"](${s},${w},${n},${e});
);
out body;
>>;
out skel qt;`;
    }

    async function fetchRoadNetwork() {
        const query = buildOverpassQuery();
        let lastErr;

        for (const endpoint of OVERPASS_ENDPOINTS) {
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    body: 'data=' + encodeURIComponent(query),
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return await res.json();
            } catch (err) {
                lastErr = err;
                console.warn('[EBoardRouter] endpoint failed:', endpoint, err.message);
            }
        }
        throw lastErr || new Error('All Overpass endpoints unreachable');
    }

    // Bump this whenever buildGraph()'s filtering logic changes (which
    // ways/edges get excluded, or how) — the cache below stamps every
    // entry with this number and refuses to reuse one written under a
    // different version, no matter how fresh its timestamp is. Without
    // this, a graph cached before a filtering fix (like the switch from
    // whole-way to per-edge military exclusion) can silently keep
    // serving the old, buggier routes for up to 7 days. Cache entries
    // written before this versioning existed have no filterVersion field
    // at all, which fails the equality check below just as reliably.
    const FILTER_VERSION = 2;

    // Access values that block a pedestrian from lawfully using a way.
    // motor_vehicle=private is included even though it nominally only
    // restricts vehicles, because in practice it's how a lot of
    // restricted compounds (military bases included) tag their gates —
    // erring conservative here is the right tradeoff for a routing tool
    // students actually walk.
    const BLOCKED_ACCESS = new Set(['private', 'no', 'military']);

    function buildGraph(osm) {
        const coords = new Map();  // node id -> [lat, lng]
        const adj = new Map();     // node id -> [{ to, w }]
        const wayById = new Map();

        for (const el of osm.elements) {
            if (el.type === 'node') coords.set(el.id, [el.lat, el.lon]);
            else if (el.type === 'way') wayById.set(el.id, el);
        }

        /* ---- landuse=military areas: real polygon containment ----
           A rectangular bbox around an irregular compound catches
           ordinary streets that pass near a corner but never actually
           enter it (e.g. an unrelated highway=unclassified road ended
           up excluded this way once — see routing.js history). Each
           military way/relation is instead tested as its actual ring(s)
           via ray casting. The bbox is kept as a cheap reject-early
           pre-filter — checking it first means the O(vertices) polygon
           test only ever runs for nodes that are already bbox-inside,
           not all ~24,045 nodes against every area. */
        function ringOf(way) {
            return (way.nodes || []).map(id => coords.get(id)).filter(Boolean);
        }
        function boxOf(ring) {
            const box = { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity };
            for (const [lat, lng] of ring) {
                box.minLat = Math.min(box.minLat, lat); box.maxLat = Math.max(box.maxLat, lat);
                box.minLng = Math.min(box.minLng, lng); box.maxLng = Math.max(box.maxLng, lng);
            }
            return box;
        }
        // Standard ray-casting point-in-polygon test: count how many
        // times a ray cast east from (lat, lng) crosses the ring's
        // edges; odd = inside. `ring` need not be explicitly closed.
        function pointInPolygon(lat, lng, ring) {
            let inside = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const [yi, xi] = ring[i], [yj, xj] = ring[j];
                if (((yi > lat) !== (yj > lat)) &&
                    (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
                    inside = !inside;
                }
            }
            return inside;
        }

        const militaryAreas = []; // { box, rings: [[lat,lng], ...][] }
        for (const el of osm.elements) {
            if (el.tags?.landuse !== 'military') continue;
            console.log('[EBoardRouter] military area:', el.type, el.id);
            const rings = [];
            if (el.type === 'way') {
                const ring = ringOf(el);
                if (ring.length >= 3) rings.push(ring);
            } else if (el.type === 'relation') {
                for (const member of el.members || []) {
                    if (member.type !== 'way') continue;
                    const memberWay = wayById.get(member.ref);
                    const ring = memberWay ? ringOf(memberWay) : [];
                    if (ring.length >= 3) rings.push(ring);
                }
            }
            if (rings.length === 0) continue;
            const box = rings.reduce((acc, ring) => {
                const b = boxOf(ring);
                return {
                    minLat: Math.min(acc.minLat, b.minLat), maxLat: Math.max(acc.maxLat, b.maxLat),
                    minLng: Math.min(acc.minLng, b.minLng), maxLng: Math.max(acc.maxLng, b.maxLng)
                };
            }, { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity });
            militaryAreas.push({ box, rings });
        }

        const isInMilitaryArea = (nodeId) => {
            const c = coords.get(nodeId);
            if (!c) return false;
            const [lat, lng] = c;
            return militaryAreas.some(area => {
                if (lat < area.box.minLat || lat > area.box.maxLat ||
                    lng < area.box.minLng || lng > area.box.maxLng) return false; // cheap pre-filter
                return area.rings.some(ring => pointInPolygon(lat, lng, ring));
            });
        };

        const link = (a, b, w) => {
            if (!adj.has(a)) adj.set(a, []);
            adj.get(a).push({ to: b, w });
        };

        let excludedByAccessTag = 0;
        let excludedByMotorVehicle = 0;
        let excludedEdgesByMilitaryArea = 0;
        const waysAffectedByMilitaryArea = new Set();

        for (const el of osm.elements) {
            if (el.type !== 'way' || !el.nodes) continue;
            // The query now also returns landuse=military ways/relations
            // (fetched to build militaryAreas above) — those aren't
            // roads, so skip anything that isn't one of our routable
            // highway types before ever linking nodes.
            if (!ROUTABLE.includes(el.tags?.highway)) continue;

            // access/motor_vehicle tags apply to the whole way, so this
            // stays a whole-way exclusion. Counted separately from the
            // access tag below since motor_vehicle is nominally a
            // vehicle restriction, not a pedestrian one — see
            // BLOCKED_ACCESS's comment for why it's still excluded here.
            if (BLOCKED_ACCESS.has(el.tags?.access)) {
                excludedByAccessTag++;
                continue;
            }
            if (el.tags?.motor_vehicle === 'private') {
                excludedByMotorVehicle++;
                continue;
            }

            // Military-area containment is checked per EDGE, not per way.
            // A single OSM way can run for hundreds of metres — e.g. way
            // 92630100 near UST Legazpi has 28 nodes, and only the last
            // ~23 of them are actually inside a base; dropping the whole
            // way because one distant node is inside it excluded a
            // perfectly walkable stretch and forced a 640m detour that
            // had nothing to do with the compound at all.
            for (let i = 0; i < el.nodes.length - 1; i++) {
                const a = el.nodes[i], b = el.nodes[i + 1];
                const ca = coords.get(a), cb = coords.get(b);
                if (!ca || !cb) continue;
                if (isInMilitaryArea(a) || isInMilitaryArea(b)) {
                    excludedEdgesByMilitaryArea++;
                    waysAffectedByMilitaryArea.add(el.id);
                    continue;
                }
                const w = haversine(ca[0], ca[1], cb[0], cb[1]);
                // undirected: students can walk either way
                link(a, b, w);
                link(b, a, w);
            }
        }

        console.log(`[EBoardRouter] excluded ${excludedByAccessTag} way(s) by access tag, ` +
            `${excludedByMotorVehicle} way(s) by motor_vehicle=private, ` +
            `${excludedEdgesByMilitaryArea} edge(s) across ${waysAffectedByMilitaryArea.size} way(s) inside military areas ` +
            `(${militaryAreas.length} area(s) found)`);

        // Drop orphan nodes so snapping never lands somewhere unreachable
        for (const id of [...coords.keys()]) {
            if (!adj.has(id)) coords.delete(id);
        }

        let edgeCount = 0;
        for (const list of adj.values()) edgeCount += list.length;
        console.log(`[EBoardRouter] ${coords.size} nodes, ${edgeCount / 2} undirected edges, ` +
            `${osm.elements.length} raw OSM elements`);

        return { adj, coords };
    }

    /* ---------- snapping ---------- */

    function nearestNode(g, lat, lng) {
        let best = null, bestD = Infinity;
        for (const [id, c] of g.coords) {
            const d = haversine(lat, lng, c[0], c[1]);
            if (d < bestD) { bestD = d; best = id; }
        }
        return { id: best, offset: bestD };
    }

    /* ---------- Dijkstra ---------- */

    function dijkstra(g, startId, goalId) {
        const dist = new Map([[startId, 0]]);
        const prev = new Map();
        const settled = new Set();
        const pq = new MinHeap();
        pq.push({ id: startId, d: 0 });

        while (pq.size) {
            const { id, d } = pq.pop();
            if (settled.has(id)) continue;
            settled.add(id);
            if (id === goalId) break;

            for (const edge of g.adj.get(id) || []) {
                if (settled.has(edge.to)) continue;
                const nd = d + edge.w;                    // relaxation
                if (nd < (dist.get(edge.to) ?? Infinity)) {
                    dist.set(edge.to, nd);
                    prev.set(edge.to, id);
                    pq.push({ id: edge.to, d: nd });
                }
            }
        }

        if (!dist.has(goalId)) return null;

        const path = [];
        for (let at = goalId; at !== undefined; at = prev.get(at)) {
            path.push(g.coords.get(at));
            if (at === startId) break;
        }
        // settled.size is exactly the number of distinct nodes Dijkstra
        // finalized before stopping (goal reached, or queue exhausted) --
        // not graph.coords.size, which is the whole graph regardless of
        // how much of it this particular route touched.
        return { metres: dist.get(goalId), path: path.reverse(), nodesExplored: settled.size };
    }

    /* ---------- localStorage cache ----------
       Stores the built graph (adj + coords), not the raw Overpass
       response -- it's already exactly what routing needs and is
       meaningfully smaller, which matters for fitting in a same-origin
       quota that's typically only ~5-10MB. Maps aren't JSON-serialisable
       directly, so each becomes an array of [key, value] entries and
       back. */

    function serializeGraph(g) {
        return { adj: Array.from(g.adj.entries()), coords: Array.from(g.coords.entries()) };
    }
    function deserializeGraph(obj) {
        return { adj: new Map(obj.adj), coords: new Map(obj.coords) };
    }

    function readCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.timestamp !== 'number' || !parsed.graph) return null;
            if (parsed.filterVersion !== FILTER_VERSION) {
                console.log(`[EBoardRouter] cached road graph is from filter version ${parsed.filterVersion ?? '(none)'}, ` +
                    `current is ${FILTER_VERSION} — re-fetching`);
                return null;
            }
            // Entries written before snapshot-first loading have no
            // source field and may have been built from live Overpass
            // data -- same reasoning as the filterVersion check above.
            if (parsed.source !== 'snapshot') {
                console.log('[EBoardRouter] cached road graph was not built from the bundled snapshot — re-loading');
                return null;
            }
            if (Date.now() - parsed.timestamp > CACHE_MAX_AGE_MS) {
                console.log('[EBoardRouter] cached road graph is over 7 days old, re-fetching');
                return null;
            }
            return deserializeGraph(parsed.graph);
        } catch (err) {
            console.warn('[EBoardRouter] cached road graph unreadable, ignoring:', err.message);
            return null;
        }
    }

    function writeCache(g) {
        try {
            const payload = JSON.stringify({ timestamp: Date.now(), filterVersion: FILTER_VERSION, source: 'snapshot', graph: serializeGraph(g) });
            localStorage.setItem(CACHE_KEY, payload);
            console.log(`[EBoardRouter] cached road graph (${(payload.length / 1024).toFixed(0)} KB, filter v${FILTER_VERSION})`);
        } catch (err) {
            // Most likely QuotaExceededError. Non-fatal either way: the
            // in-memory graph from this load still works fine, it just
            // won't be there to skip the fetch next time.
            console.warn('[EBoardRouter] could not cache road graph, probably over the localStorage quota -- will fetch again next load:', err.message);
        }
    }

    /* ---------- public API ---------- */

    /**
     * @param {{ forceRefresh?: boolean }} [options] - forceRefresh
     *   bypasses the in-memory graph, the localStorage cache AND the
     *   bundled snapshot, and fetches live from Overpass (the result
     *   isn't cached -- see init()'s writeCache call). Also reachable via the
     *   ?refreshRoads=1 query param (see script.js's loadRoadNetwork()).
     */
    async function init(options) {
        const forceRefresh = options?.forceRefresh === true;
        if (graph && !forceRefresh) return graph;
        if (loading) return loading;

        loading = (async () => {
            if (!forceRefresh) {
                const cached = readCache();
                if (cached) {
                    graph = cached;
                    console.log(`[EBoardRouter] graph loaded from cache: ${graph.coords.size} nodes`);
                    return graph;
                }
            }

            // Snapshot first, live Overpass only as a last resort (or when
            // explicitly forced) -- see the comment on SNAPSHOT_FILE.
            let osm, source;
            if (!forceRefresh) {
                try {
                    const res = await fetch(SNAPSHOT_FILE);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    osm = await res.json();
                    source = 'snapshot';
                    console.log(`[EBoardRouter] using bundled ${SNAPSHOT_FILE} snapshot`);
                } catch (snapshotErr) {
                    console.warn(`[EBoardRouter] bundled ${SNAPSHOT_FILE} unavailable, trying live Overpass:`, snapshotErr.message);
                }
            }
            if (!osm) {
                osm = await fetchRoadNetwork();
                source = 'overpass';
            }

            graph = buildGraph(osm);
            // Only the snapshot-built graph is cached. A live Overpass graph
            // is still used for this load, but caching it would let it
            // stand in for the snapshot for up to 7 days on this browser --
            // exactly the per-respondent variation the snapshot avoids.
            if (source === 'snapshot') writeCache(graph);
            console.log(`[EBoardRouter] graph ready: ${graph.coords.size} nodes`);
            return graph;
        })().catch(err => {
            lastError = err;
            loading = null;
            throw err;
        });

        return loading;
    }

    /**
     * Route between two [lat, lng] points.
     * Returns { km, path, estimated, nodes, nodesExplored }.
     * `estimated: true` means the road graph was unavailable and the
     * figure is a straight-line approximation — surface this in the UI.
     * `nodes` is the total node count of the loaded graph (fixed per
     * graph build, same for every route). `nodesExplored` is how many
     * distinct nodes this specific Dijkstra run actually settled before
     * stopping -- it varies per route and is normally far smaller than
     * `nodes`. Neither is present when `estimated` is true, since no
     * graph search ran.
     */
    function route(from, to) {
        const fallback = () => ({
            km: +(haversine(from[0], from[1], to[0], to[1]) / 1000 * 1.15).toFixed(2),
            path: [from, to],
            estimated: true
        });

        if (!graph) return fallback();

        const a = nearestNode(graph, from[0], from[1]);
        const b = nearestNode(graph, to[0], to[1]);
        if (!a.id || !b.id) return fallback();

        const result = dijkstra(graph, a.id, b.id);
        if (!result) return fallback();

        // add the short walk from the exact point to its snapped road node
        const total = result.metres + a.offset + b.offset;

        return {
            km: +(total / 1000).toFixed(2),
            path: [from, ...result.path, to],
            estimated: false,
            nodes: graph.coords.size,
            nodesExplored: result.nodesExplored
        };
    }

    function isReady() { return graph !== null; }
    function error() { return lastError; }

    /**
     * Distance in metres from an arbitrary point to the nearest node in
     * the loaded road graph -- the same "snap offset" route() already
     * folds into its total distance for both endpoints, exposed here
     * for callers that just want to know how close a single point is
     * to any mapped road (e.g. warning a landowner that a listing pin
     * is far from the street), without needing a second point to route
     * to. Returns null if the graph isn't loaded -- callers should skip
     * the check in that case, not treat null as "0 m away."
     */
    function nearestNodeDistance(lat, lng) {
        if (!graph) return null;
        return nearestNode(graph, lat, lng).offset;
    }

    return { init, route, isReady, error, haversine, nearestNodeDistance };
})();
