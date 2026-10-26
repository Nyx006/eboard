/* ============================================================
   E-BOARD DIRECTIONS — standalone route visualizer.

   Not part of the student SPA (index.html + script.js). Reads the
   listing and the campus list from localStorage (eboard_v12,
   eboard_schools), then drives EBoardRouter (routing.js) directly to
   compute and animate the same road route the directory sorts by.

   File layout:
     1. Pure math helpers (bearing, interpolation, segment merging) —
        no DOM access, unit-tested from directions.test.js via the
        module.exports guard below.
     2. Everything else (map, panel, animation, event wiring), gated
        behind `typeof document !== 'undefined'` so this file can be
        `require()`d in Node for the pure-function tests without a
        browser/DOM present.
   ============================================================ */

/* Google Maps Platform API key, used for the Street View metadata
   lookup and the Street View Panorama JS widget. Needs "Maps
   JavaScript API" and "Street View Static API" enabled -- those are
   the only two Google APIs this file calls.

   The key itself lives in config.js (git-ignored; see
   config.example.js for the template and setup instructions), loaded
   as a <script> before this file in directions.html, and read here
   off window.GOOGLE_MAPS_API_KEY. Never hardcode a real key in this
   file -- it's tracked in git.

   The `typeof window !== 'undefined'` guard is for directions.test.js,
   which requires() this file in plain Node (no window/config.js
   there) to unit-test the pure math functions below -- without it,
   referencing window at all would throw in that context. Missing
   config.js (404) or a blank key both land here as the same "" as
   before: Street View gracefully disabled, toggle still appears, but
   clicking it explains why instead of attempting any network call. */
const GOOGLE_MAPS_API_KEY = (typeof window !== 'undefined' && window.GOOGLE_MAPS_API_KEY) || '';

/* ---------- 1. pure math ---------- */

/* Initial great-circle bearing from a to b, in degrees, [0, 360). */
function bearingDeg(a, b) {
    const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
    const phi1 = a[0] * toRad, phi2 = b[0] * toRad;
    const dLon = (b[1] - a[1]) * toRad;
    const y = Math.sin(dLon) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
    return (Math.atan2(y, x) * toDeg + 360) % 360;
}

/* Signed smallest angle to rotate `from` to reach `to`, in (-180, 180].
   Handles the 0/360 wraparound: circularDiffDeg(350, 10) === 20, not 340. */
function circularDiffDeg(from, to) {
    let diff = (to - from) % 360;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return diff;
}

/* Prefix-sum distances (metres) at each vertex of an OSM-node path. */
function buildCumulativeDistances(path) {
    const cum = [0];
    for (let i = 1; i < path.length; i++) {
        cum.push(cum[i - 1] + EBoardRouter.haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
    }
    return cum;
}

/* Position at `targetDist` metres along `path`, using the precomputed
   `cum` prefix sums. Binary search over `cum` finds the bracketing
   segment in O(log n) regardless of how far into the route we are —
   the alternative (re-summing edge lengths from the start every
   frame) is O(n) per frame and gets slower the longer the route runs.
   Clamped to the endpoints outside [0, total]. */
function interpolateAlongPath(path, cum, targetDist) {
    const total = cum[cum.length - 1];
    if (targetDist <= 0) return { lat: path[0][0], lng: path[0][1], index: 0 };
    if (targetDist >= total) {
        const last = path.length - 1;
        return { lat: path[last][0], lng: path[last][1], index: last - 1 };
    }

    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= targetDist) lo = mid; else hi = mid - 1;
    }
    const i = lo;
    const segLen = cum[i + 1] - cum[i];
    const t = segLen === 0 ? 0 : (targetDist - cum[i]) / segLen;
    return {
        lat: path[i][0] + (path[i + 1][0] - path[i][0]) * t,
        lng: path[i][1] + (path[i + 1][1] - path[i][1]) * t,
        index: i
    };
}

function segmentDistance(path, startIdx, endIdx) {
    let d = 0;
    for (let i = startIdx; i < endIdx; i++) {
        d += EBoardRouter.haversine(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
    }
    return d;
}

/* The raw Dijkstra path has a vertex at every OSM node — hundreds of
   one-metre steps on a real route. Merges consecutive vertices into
   one segment as long as each new edge stays within `thresholdDeg` of
   the SEGMENT'S STARTING bearing (not the previous edge's bearing).
   Comparing to the start avoids drift: a road that gently curves
   through many <35° edge-to-edge changes would never trigger a split
   under an edge-to-edge comparison even after turning 90° overall;
   comparing every edge back to where the segment started catches that. */
/* Edges shorter than this have no meaningful bearing. The common case:
   a pin that sits exactly on a graph vertex (0 m snap) makes the path's
   first edge pin -> vertex zero-length, and bearingDeg() of two identical
   points is 0 deg = "N". Before 2026-10-14 that became its own 0 m
   segment, "Head N from <listing> · 0 m". Such edges now stay inside the
   current segment and never set or change a bearing. */
const MIN_BEARING_EDGE_M = 0.5;

function mergeSegmentsByBearing(path, thresholdDeg) {
    if (thresholdDeg === undefined) thresholdDeg = 35;
    if (path.length < 2) return [];
    const edgeLen = i => EBoardRouter.haversine(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);

    // The starting bearing comes from the first edge with a real length.
    let first = 0;
    while (first < path.length - 2 && edgeLen(first) < MIN_BEARING_EDGE_M) first++;

    const segments = [];
    let startIdx = 0;
    let startBearing = bearingDeg(path[first], path[first + 1]);

    for (let i = first + 1; i < path.length - 1; i++) {
        if (edgeLen(i) < MIN_BEARING_EDGE_M) continue; // no bearing; stays in the current segment
        const edgeBearing = bearingDeg(path[i], path[i + 1]);
        if (Math.abs(circularDiffDeg(startBearing, edgeBearing)) > thresholdDeg) {
            segments.push({ startIdx, endIdx: i, distanceM: segmentDistance(path, startIdx, i), bearingDeg: startBearing });
            startIdx = i;
            startBearing = edgeBearing;
        }
    }
    segments.push({ startIdx, endIdx: path.length - 1, distanceM: segmentDistance(path, startIdx, path.length - 1), bearingDeg: startBearing });
    return segments;
}

const COMPASS_LABELS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compassLabel(bearing) {
    return COMPASS_LABELS[Math.round(bearing / 22.5) % 16];
}
function turnLabel(deltaDeg) {
    if (Math.abs(deltaDeg) < 20) return 'Continue straight';
    return deltaDeg > 0 ? 'Turn right' : 'Turn left';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { bearingDeg, circularDiffDeg, buildCumulativeDistances, interpolateAlongPath, mergeSegmentsByBearing, compassLabel, turnLabel };
}

/* ---------- 2. page wiring (browser only) ---------- */

function boot() {
    const ALBAY_BOUNDS = [[13.0000, 123.5000], [13.4500, 124.0000]];
    const WALK_MIN_PER_KM = 12; // matches script.js's details-page assumption (5 km/h)

    // This is a playback speed for the route preview, not a walking
    // pace -- it's deliberately faster than the real ~1.39 m/s (5 km/h)
    // WALK_MIN_PER_KM implies, which the panel's "Est. walk time" stat
    // still uses. A true walking pace was tried as the 1x baseline and
    // turned out too slow to sit and watch (a 550 m route took ~6.5 min
    // at 1x); this value -- 8x that walking pace -- was chosen instead
    // as what's actually watchable, with 1x/2x/4x/8x scaling from it.
    const ANIM_BASE_SPEED_MPS = 8 * (1000 / (WALK_MIN_PER_KM * 60)); // ~11.1 m/s

    let map, routeLine, campusMarker, avatarMarker;
    let currentPath = [], cumDist = [0], totalDist = 0, segments = [];
    let currentCampusName = '';
    /* Who the route runs from and to, for the panel text. Campus mode
       sets (listing -> campus); GPS mode sets (your location -> listing). */
    let routeFromName = '', routeToName = '';

    /* ---- live location ----
       originMode is 'campus' (the original behaviour) or 'gps'.
       myPos is the latest fix; lastRoutedFrom is the fix the current
       route was computed from, so the router only re-runs once the
       student has actually moved. */
    let originMode = 'campus';
    let myPos = null, lastRoutedFrom = null;
    let myMarker = null, myAccuracyCircle = null, watchId = null;

    // Re-run Dijkstra once the student has moved this far. Every fix
    // moves the blue dot; only a real move rebuilds the route, so a
    // phone jittering by a few metres while standing still doesn't
    // redraw the panel over and over.
    const GPS_RECOMPUTE_M = 30;
    // Further than this from any mapped road means the fix is outside
    // the bundled Legazpi road data -- better to say so than to snap
    // the route to a road kilometres away and present it as fact.
    const GPS_MAX_SNAP_M = 2000;
    let traveledM = 0, speedMultiplier = 1, playing = false, lastFrameTime = null, animFrameId = null;
    let graphInitMs = null;

    const WAYPOINT_INTERVAL_M = 80;

    // Same value, and same purpose, as streetview-coverage.js's RADIUS_M:
    // both the metadata request's `radius` and the cutoff used to decide
    // whether an "OK" result actually counts as coverage (see
    // fetchStreetViewMetadata below for why "OK" alone isn't enough).
    // Keep these two files' numbers identical, or this UI and the
    // coverage table it's meant to match will disagree on what "covered"
    // means for the exact same coordinate.
    const STREET_VIEW_RADIUS_M = 50;

    let waypoints = [];
    let streetViewActive = false;
    let panorama = null;
    let mapsScriptPromise = null;
    let metadataCache = new Map();   // waypoint index -> { available, lat, lng }
    let svRequestToken = 0;          // bumped per route/waypoint-change so a slow, now-stale
                                      // metadata fetch can't overwrite a newer one
    let currentWaypointIndex = -1;

    const params = new URLSearchParams(location.search);
    const houseId = Number(params.get('id'));
    let originIdx = Number(params.get('school'));
    if (!Number.isInteger(originIdx) || originIdx < 0) originIdx = 0;

    const houses = JSON.parse(localStorage.getItem('eboard_v12')) || [];
    const schools = JSON.parse(localStorage.getItem('eboard_schools')) || [];
    const house = houses.find(h => h.id === houseId);

    if (!house || schools.length === 0) {
        document.getElementById('property-name').innerText = 'Property not found';
        document.getElementById('route-subtitle').innerText =
            'Open this page from a listing card in the E-Board directory.';
        return;
    }
    if (originIdx >= schools.length) originIdx = 0;

    document.getElementById('property-name').innerText = house.name;
    // Return to wherever this page was opened from: the card on the
    // homepage grid (from=grid, or anything unrecognised) sends the user
    // back to plain index.html; the details-view button (from=details)
    // sends them back to this exact listing via ?property=<id>, which
    // script.js reads on load to reopen that details view directly.
    document.getElementById('back-to-directory').href =
        params.get('from') === 'details' ? `index.html?property=${house.id}` : 'index.html';

    const select = document.getElementById('campus-select');
    select.innerHTML = schools.map(s => `<option>${s.name}</option>`).join('');
    select.selectedIndex = originIdx;
    // Picking a campus takes over from live tracking, otherwise the next
    // GPS fix would pull the route straight back to "from your location".
    select.onchange = () => {
        if (watchId !== null) stopGps(false);
        computeRoute(select.selectedIndex);
    };

    // Guards against "Uncaught Error: Map container is already initialized"
    // -- Leaflet stamps a _leaflet_id property directly on the DOM node the
    // first time L.map() succeeds on it and refuses a second call on that
    // same node, throwing instead of reinitializing. boot() itself only
    // ever runs once per script execution (checked directly: one L.map()
    // call site, one `if (typeof document...) boot()` at the bottom of
    // this file) -- so a second call reaching this line means something
    // outside this file's control re-ran it against a DOM node Leaflet
    // already touched (observed with a local dev server's live-reload
    // cycle; also possible via a browser back/forward-cache restore).
    // Clearing the marker lets Leaflet treat the node as fresh again
    // instead of leaving the map pane permanently dead.
    const mapContainer = document.getElementById('directions-map-el');
    if (mapContainer._leaflet_id) mapContainer._leaflet_id = null;

    map = L.map(mapContainer, { maxBounds: ALBAY_BOUNDS, maxBoundsViscosity: 1.0, minZoom: 10 }).setView(house.coords, 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    L.marker(house.coords).addTo(map).bindPopup(escapeHtml(house.name)); // popups render HTML; name is landowner input

    // On mobile, .directions-map's height comes from a vh unit, and some
    // mobile browsers don't settle vh to its final value until just after
    // the first layout pass. Leaflet measures its container synchronously
    // at construction and caches that size, so a map built against a
    // stale/zero height silently never renders any tiles — no error,
    // just a blank box. Same setTimeout(…, 200) + invalidateSize()
    // pattern script.js's initMap() already uses for the details-page
    // map, given a beat here for the same reason: let layout settle
    // first, then force Leaflet to re-measure.
    setTimeout(() => map.invalidateSize(), 200);

    document.getElementById('scrubber').addEventListener('input', onScrub);
    // ANIM_BASE_SPEED_MPS above is now the old 8x rate, so 1x here is
    // exactly what 8x used to be -- watchable by design, no longer a
    // walking pace. setSpeedInternal() also drives the active-button
    // highlight (toggles .active by matching data-speed).
    setSpeedInternal(1);

    /* Campus mode: the walk runs from the boarding house to the campus.
       route() takes the property as origin (path[0]) and the campus as
       the last point -- everything else in this file (avatar start,
       waypoints, Street View heading) just follows currentPath in
       order, so reversing these two arguments reverses the whole walk.
       That is exactly what GPS mode does: see computeRouteFromMe(). */
    function computeRoute(idx) {
        originMode = 'campus';
        currentCampusName = schools[idx].name;
        document.getElementById('route-subtitle').innerText = `To ${currentCampusName}`;
        runRoute(house.coords, schools[idx].coords, house.name, currentCampusName);
    }

    /* GPS mode: the student is standing somewhere and wants to get TO
       the boarding house, so the origin is their live position and the
       destination is the listing -- the reverse of campus mode. */
    function computeRouteFromMe() {
        if (!myPos) return;
        originMode = 'gps';
        document.getElementById('route-subtitle').innerText = `From your location to ${house.name}`;
        lastRoutedFrom = myPos.slice();
        runRoute(myPos, house.coords, 'your location', house.name);
    }

    function runRoute(fromCoords, toCoords, fromName, toName) {
        routeFromName = fromName;
        routeToName = toName;

        const t0 = performance.now();
        const result = EBoardRouter.route(fromCoords, toCoords);
        const routeMs = performance.now() - t0;

        currentPath = result.path;
        cumDist = buildCumulativeDistances(currentPath);
        totalDist = cumDist[cumDist.length - 1];
        segments = mergeSegmentsByBearing(currentPath, 35);

        waypoints = buildWaypoints();
        // Diagnostic: waypoint 0 (traveled distance 0) is supposed to be
        // the origin's exact coordinate, since route()'s returned path
        // always starts with the "from" argument verbatim. In campus mode
        // that origin is the listing, so a mismatch means the stored
        // coordinate drifted; in GPS mode it is the live fix. Logged every
        // recompute so a mismatch is visible without a debugger.
        if (waypoints[0]) {
            console.log(`[E-Board Directions] origin (${routeFromName}):`, fromCoords,
                ' waypoint[0] (traveled=0):', [waypoints[0].lat, waypoints[0].lng]);
        }
        metadataCache = new Map();
        svRequestToken++;
        currentWaypointIndex = -1;

        document.getElementById('route-warning').style.display = result.estimated ? 'block' : 'none';
        document.getElementById('stat-distance').innerText = result.km.toFixed(2) + ' km';
        document.getElementById('stat-walktime').innerText = Math.round(result.km * WALK_MIN_PER_KM) + ' min';

        const initNote = graphInitMs !== null ? ` (graph loaded in ${graphInitMs.toFixed(0)} ms)` : '';
        document.getElementById('compute-note').innerText = result.estimated
            ? `Computed in ${routeMs.toFixed(1)} ms (straight-line estimate — no road graph used).`
            : `Computed in ${routeMs.toFixed(1)} ms over ${(result.nodes ?? 0).toLocaleString()} nodes${initNote}.`;

        drawRouteLine(result);
        renderSegmentList();
        resetAnimation();
    }

    function drawRouteLine(result) {
        if (routeLine) map.removeLayer(routeLine);
        if (campusMarker) map.removeLayer(campusMarker);

        routeLine = L.polyline(currentPath, {
            color: '#9B72FF', weight: 5, opacity: 0.85,
            dashArray: result.estimated ? '8, 10' : null
        }).addTo(map);
        // currentPath[0] is the origin -- the destination is the last
        // point. Which is which depends on the mode, so the popup is
        // named rather than hardcoded to "Campus".
        campusMarker = L.circleMarker(currentPath[currentPath.length - 1], { color: 'red' })
            .addTo(map).bindPopup(escapeHtml(routeToName));

        map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
    }

    // house.name is landowner-entered text (script.js's saveNewListing()
    // reads it straight from a form field) -- this is the first place in
    // this file that puts it into innerHTML rather than .innerText, so
    // it needs escaping here even though nowhere else in directions.js
    // has needed to.
    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    function renderSegmentList() {
        const list = document.getElementById('segment-list');
        // In campus mode these are (listing -> campus); in GPS mode they
        // are (your location -> listing).
        const propertyName = escapeHtml(routeFromName);
        const campusName = escapeHtml(routeToName);
        let prevBearing = null;
        list.innerHTML = segments.map((seg, i) => {
            const compass = compassLabel(seg.bearingDeg);
            const isFirst = i === 0;
            const isLast = i === segments.length - 1;
            // One pattern on every line, "action (compass)" (2026-10-14).
            // The last line used to always say "Continue ... to <campus>",
            // even when it was a turn; it now uses the real turn.
            let label;
            if (isFirst && isLast) {
                label = `Start (${compass}) from ${propertyName} to ${campusName}`;
            } else if (isFirst) {
                label = `Start (${compass}) from ${propertyName}`;
            } else if (isLast) {
                label = `${turnLabel(circularDiffDeg(prevBearing, seg.bearingDeg))} (${compass}) to ${campusName}`;
            } else {
                label = `${turnLabel(circularDiffDeg(prevBearing, seg.bearingDeg))} (${compass})`;
            }
            prevBearing = seg.bearingDeg;
            return `<li class="segment-item">${label} <span class="seg-dist">${Math.round(seg.distanceM)} m</span></li>`;
        }).join('');
    }

    function formatMeters(m) {
        return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
    }

    /* ======================= live location =======================
       Routes from where the student actually is, using the same
       EBoardRouter the campus mode uses -- no third-party directions
       service. The only new input is the browser's Geolocation API.   */

    function gpsStatus(msg, kind) {
        const el = document.getElementById('gps-status');
        if (!el) return;
        el.innerText = msg;
        el.className = 'gps-status' + (kind ? ' gps-' + kind : '');
    }

    function setGpsButton(on) {
        const btn = document.getElementById('gps-btn');
        if (!btn) return;
        btn.innerText = on ? '■ Stop following me' : '📍 Use my current location';
        btn.classList.toggle('active', on);
    }

    /* recompute=false is used when the caller is ABOUT to compute a
       route itself (the campus picker), so the route isn't built twice. */
    function stopGps(recompute = true) {
        if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
        if (myMarker) { map.removeLayer(myMarker); myMarker = null; }
        if (myAccuracyCircle) { map.removeLayer(myAccuracyCircle); myAccuracyCircle = null; }
        myPos = null; lastRoutedFrom = null;
        setGpsButton(false);
        gpsStatus('');
        // Fall back to the campus route the page opened with.
        if (recompute) computeRoute(document.getElementById('campus-select').selectedIndex);
    }

    function toggleGps() {
        if (watchId !== null) { stopGps(); return; }

        if (!('geolocation' in navigator)) {
            gpsStatus('This browser does not support location.', 'err');
            return;
        }
        /* The single most common reason this fails. Browsers only expose
           geolocation in a secure context: https://, or localhost. Opened
           over a plain http:// LAN address -- which is exactly what
           happens when a phone is pointed at a laptop running XAMPP --
           the call does not error quickly, it just never succeeds. Said
           plainly here rather than leaving the user watching a spinner. */
        if (!window.isSecureContext) {
            gpsStatus('Location needs a secure connection. This page is on ' +
                      location.protocol + '// — open E-BOARD over https:// ' +
                      '(or on localhost) and the browser will allow GPS.', 'err');
            return;
        }

        gpsStatus('Getting your location…', 'wait');
        setGpsButton(true);
        watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
            enableHighAccuracy: true,   // the phone's GPS, not the coarse network fix
            maximumAge: 5000,
            timeout: 20000
        });
    }

    function onPosition(pos) {
        if (watchId === null) return;      // a late callback after stopGps()
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        const accuracy = pos.coords.accuracy;   // metres, 95% confidence
        myPos = [lat, lng];

        // The blue dot and its accuracy ring. Kept separate from the 🚶
        // animation avatar on purpose: the avatar replays the route, this
        // is where the student really is.
        if (!myMarker) {
            myMarker = L.circleMarker(myPos, {
                radius: 8, color: '#fff', weight: 3,
                fillColor: '#1a73e8', fillOpacity: 1
            }).addTo(map).bindPopup('You are here');
            myAccuracyCircle = L.circle(myPos, {
                radius: accuracy, color: '#1a73e8', weight: 1,
                fillColor: '#1a73e8', fillOpacity: 0.12
            }).addTo(map);
        } else {
            myMarker.setLatLng(myPos);
            myAccuracyCircle.setLatLng(myPos).setRadius(accuracy);
        }

        /* Is this fix anywhere near the road data the app carries? The
           router would happily snap a fix in Manila to the nearest
           Legazpi road and return a confident-looking route. */
        const snap = EBoardRouter.nearestNodeDistance(lat, lng);
        if (snap !== null && snap > GPS_MAX_SNAP_M) {
            /* Out of range is a waiting state, not a failure: the watch is
               deliberately left running, so travelling into Legazpi starts
               the routing on its own with nothing to press. Worded and
               coloured to say that, rather than looking like a dead end
               next to a red "Stop following me" button. */
            gpsStatus(`You're outside the area E-BOARD has road data for — the ` +
                      `nearest mapped road is ${(snap / 1000).toFixed(1)} km away. ` +
                      `Still following you: the route will compute as soon as ` +
                      `you're in range.`, 'wait');
            return;
        }

        const moved = lastRoutedFrom
            ? EBoardRouter.haversine(lastRoutedFrom[0], lastRoutedFrom[1], lat, lng)
            : Infinity;
        if (moved >= GPS_RECOMPUTE_M) computeRouteFromMe();

        gpsStatus(`Located to within ${Math.round(accuracy)} m. ` +
                  `Following you as you walk — the route updates every ` +
                  `${GPS_RECOMPUTE_M} m.`, 'ok');
    }

    /* Only a denied permission is fatal. POSITION_UNAVAILABLE and TIMEOUT
       are transient -- a phone walking under a roof, into a jeepney, or
       past a tall building loses its fix for a moment and gets it back.
       watchPosition() keeps trying on its own after a non-fatal error, so
       tearing the watch down here would end tracking permanently for a
       hiccup that resolves itself seconds later. The route already on
       screen stays up; the status line says it has gone stale. */
    function onPositionError(err) {
        if (watchId === null) return;      // a late callback after stopGps()

        if (err.code === 1) {              // PERMISSION_DENIED
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
            setGpsButton(false);
            gpsStatus('You declined location access. Allow it for this site in ' +
                      'your browser settings, then tap the button again.', 'err');
            return;
        }

        const transient = {
            2: 'Lost your location for a moment — still trying. ' +
               'Moving somewhere with a clearer view of the sky helps.',
            3: 'Waiting for a GPS fix — still trying.'
        };
        gpsStatus(transient[err.code] || ('Location problem: ' + err.message), 'wait');
    }

    function placeAvatar(dist) {
        const pos = interpolateAlongPath(currentPath, cumDist, dist);
        const latlng = [pos.lat, pos.lng];
        if (!avatarMarker) {
            avatarMarker = L.marker(latlng, {
                icon: L.divIcon({ className: 'avatar-marker', html: '🚶', iconSize: [22, 22], iconAnchor: [11, 11] })
            }).addTo(map);
        } else {
            avatarMarker.setLatLng(latlng);
        }
        return latlng;
    }

    function updateProgressText() {
        document.getElementById('stat-travelled').innerText = formatMeters(traveledM);
        document.getElementById('stat-remaining').innerText = formatMeters(Math.max(0, totalDist - traveledM));
        document.getElementById('scrubber').value = Math.round(traveledM);
    }

    function resetAnimation() {
        stopAnimation();
        traveledM = 0;
        document.getElementById('scrubber').max = Math.max(1, Math.round(totalDist));
        placeAvatar(0);
        updateProgressText();
        maybeUpdateStreetView(0);
    }

    function startAnimation() {
        if (traveledM >= totalDist) traveledM = 0; // replay from the start once finished
        playing = true;
        document.getElementById('play-btn').innerText = '⏸';
        lastFrameTime = performance.now();
        animFrameId = requestAnimationFrame(tick);
    }

    function stopAnimation() {
        playing = false;
        document.getElementById('play-btn').innerText = '▶';
        if (animFrameId) cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }

    function tick(now) {
        const dt = (now - lastFrameTime) / 1000;
        lastFrameTime = now;
        traveledM = Math.min(totalDist, traveledM + ANIM_BASE_SPEED_MPS * speedMultiplier * dt);

        const pos = placeAvatar(traveledM);
        map.panTo(pos, { animate: false }); // third-person follow-cam: keeps the avatar centered every frame
        updateProgressText();
        maybeUpdateStreetView(traveledM);

        if (traveledM >= totalDist) { stopAnimation(); return; }
        animFrameId = requestAnimationFrame(tick);
    }

    function onScrub(e) {
        stopAnimation(); // pause on scrub, like a video player — otherwise the running tick() fights the drag
        traveledM = Number(e.target.value);
        const pos = placeAvatar(traveledM);
        map.panTo(pos, { animate: false });
        updateProgressText();
        maybeUpdateStreetView(traveledM);
    }

    function setSpeedInternal(n) {
        speedMultiplier = n;
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.speed) === n));
    }

    /* ---------- Street View ---------- */

    /* Samples currentPath every WAYPOINT_INTERVAL_M via the same
       interpolateAlongPath the avatar uses, so this always matches
       whatever route is currently drawn — including the 2-point
       Haversine fallback, which just yields one waypoint pair.
       Each waypoint's heading points toward the next one (direction
       of travel); the last waypoint reuses the previous heading since
       there's no "next" to aim at. */
    function buildWaypoints() {
        const wps = [];
        for (let d = 0; d <= totalDist; d += WAYPOINT_INTERVAL_M) {
            const pos = interpolateAlongPath(currentPath, cumDist, d);
            wps.push({ dist: d, lat: pos.lat, lng: pos.lng, heading: 0 });
        }
        if (wps.length === 0 || wps[wps.length - 1].dist < totalDist) {
            const pos = interpolateAlongPath(currentPath, cumDist, totalDist);
            wps.push({ dist: totalDist, lat: pos.lat, lng: pos.lng, heading: 0 });
        }
        for (let i = 0; i < wps.length; i++) {
            if (i < wps.length - 1) {
                wps[i].heading = bearingDeg([wps[i].lat, wps[i].lng], [wps[i + 1].lat, wps[i + 1].lng]);
            } else if (i > 0) {
                wps[i].heading = wps[i - 1].heading;
            }
        }
        return wps;
    }

    function nearestWaypointIndex(distanceM) {
        if (waypoints.length === 0) return -1;
        const idx = Math.round(distanceM / WAYPOINT_INTERVAL_M);
        return Math.max(0, Math.min(waypoints.length - 1, idx));
    }

    /* The only place that talks to the network. Always resolves (never
       throws) with { available: false } on anything short of a clean
       "OK" *within STREET_VIEW_RADIUS_M* — a bad key, a quota error, a
       network blip, genuinely no imagery, and an out-of-range match all
       look the same to the caller: no panorama, show the fallback
       message.

       The distance check exists because Google's metadata endpoint does
       not reliably enforce its own `radius` parameter — verified
       directly against the raw API: a radius=50 request for Bicol
       University (Main) came back status:"OK" with a panorama 5,552 m
       away. Trusting status alone would render that as if it were
       coverage. streetview-coverage.js (this project's standalone
       coverage-table script) treats anything past the radius as no
       coverage; this mirrors that exact rule so the two never disagree
       about the same coordinate. */
    async function fetchStreetViewMetadata(lat, lng) {
        try {
            const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&radius=${STREET_VIEW_RADIUS_M}&key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}`;
            // Diagnostic: key redacted so this is always safe to leave on
            // and safe to paste into a bug report. Logs the queried
            // coordinate and the full raw response so a mismatch against
            // another tool's result (e.g. streetview-coverage.js) is
            // visible directly, without re-deriving the URL by hand.
            console.log('[E-Board Directions] Street View metadata query:', { lat, lng, radius: STREET_VIEW_RADIUS_M },
                url.replace(GOOGLE_MAPS_API_KEY, '<key>'));
            const res = await fetch(url);
            const data = await res.json();
            console.log('[E-Board Directions] Street View metadata response:', data);
            if (data.status === 'OK' && data.location) {
                const distanceM = EBoardRouter.haversine(lat, lng, data.location.lat, data.location.lng);
                console.log('[E-Board Directions] distance queried point -> returned panorama:', distanceM.toFixed(1), 'm',
                    '(cutoff', STREET_VIEW_RADIUS_M, 'm)');
                if (distanceM > STREET_VIEW_RADIUS_M) return { available: false };
                return { available: true, lat: data.location.lat, lng: data.location.lng };
            }
            return { available: false };
        } catch (err) {
            console.error('[E-Board Directions] Street View metadata request failed:', err);
            return { available: false };
        }
    }

    function loadGoogleMapsScript() {
        if (mapsScriptPromise) return mapsScriptPromise;
        mapsScriptPromise = new Promise((resolve, reject) => {
            if (window.google && window.google.maps && window.google.maps.StreetViewPanorama) {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}`;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Google Maps JavaScript API failed to load'));
            document.head.appendChild(script);
        });
        return mapsScriptPromise;
    }

    function showStreetViewUnavailable(message) {
        const msg = document.getElementById('sv-unavailable-msg');
        msg.innerText = message || '📷 No street imagery available here.';
        msg.style.display = 'flex';
    }
    function hideStreetViewUnavailable() {
        document.getElementById('sv-unavailable-msg').style.display = 'none';
    }

    /* Checks the cache, calls the metadata endpoint if needed, and only
       ever creates/moves the panorama after that check comes back OK —
       this is the "metadata first, panorama second" ordering the whole
       feature depends on. A stale response (route recomputed, or the
       user scrubbed past this waypoint again before the fetch landed)
       is dropped via the svRequestToken check. */
    async function updateStreetViewForWaypoint(idx) {
        const wp = waypoints[idx];
        if (!wp) return;
        const routeToken = svRequestToken;

        let meta = metadataCache.get(idx);
        if (meta === undefined) {
            meta = await fetchStreetViewMetadata(wp.lat, wp.lng);
            metadataCache.set(idx, meta);
        }
        // Bail if the route was recomputed, Street View was switched off,
        // or the avatar has since moved to a different waypoint while this
        // fetch was in flight (e.g. scrubbed quickly past several) — an
        // out-of-order response must never clobber a newer one.
        if (routeToken !== svRequestToken || !streetViewActive || idx !== currentWaypointIndex) return;

        if (!meta.available) {
            showStreetViewUnavailable();
            return;
        }
        if (!panorama) {
            panorama = new google.maps.StreetViewPanorama(document.getElementById('street-view-el'), {
                position: { lat: meta.lat, lng: meta.lng },
                pov: { heading: wp.heading, pitch: 0 },
                zoom: 1,
                addressControl: false,
                fullscreenControl: false
            });
        } else {
            panorama.setPosition({ lat: meta.lat, lng: meta.lng });
            panorama.setPov({ heading: wp.heading, pitch: 0 });
        }
        hideStreetViewUnavailable();
    }

    /* Called from tick()/onScrub()/resetAnimation() alongside the 2D
       avatar update. A no-op unless Street View is actually on screen
       (no reason to fetch metadata for a pane nobody's looking at), and
       only fires a new lookup when the nearest waypoint actually
       changes — not every frame. */
    function maybeUpdateStreetView(distanceM) {
        if (!streetViewActive || waypoints.length === 0) return;
        const idx = nearestWaypointIndex(distanceM);
        if (idx === currentWaypointIndex) return;
        currentWaypointIndex = idx;
        updateStreetViewForWaypoint(idx);
    }

    async function setViewMode(mode) {
        const mapBtn = document.getElementById('view-toggle-map');
        const svBtn = document.getElementById('view-toggle-sv');
        const mapEl = document.getElementById('directions-map-el');
        const svPane = document.getElementById('street-view-pane');

        if (mode === 'streetview') {
            if (!GOOGLE_MAPS_API_KEY) {
                streetViewActive = true;
                mapBtn.classList.remove('active'); svBtn.classList.add('active');
                mapEl.style.display = 'none'; svPane.style.display = 'block';
                showStreetViewUnavailable('Street View is not configured — add an API key to config.js (see config.example.js).');
                return;
            }
            try {
                await loadGoogleMapsScript();
            } catch (err) {
                console.error('[E-Board Directions] Street View unavailable:', err);
                streetViewActive = false;
                mapBtn.classList.add('active'); svBtn.classList.remove('active');
                mapEl.style.display = 'block'; svPane.style.display = 'none';
                map.invalidateSize(); // was hidden (display:none) while Street View was showing
                return;
            }
            streetViewActive = true;
            mapBtn.classList.remove('active'); svBtn.classList.add('active');
            mapEl.style.display = 'none'; svPane.style.display = 'block';
            currentWaypointIndex = -1; // force a refresh for wherever traveledM currently is
            maybeUpdateStreetView(traveledM);
        } else {
            streetViewActive = false;
            mapBtn.classList.add('active'); svBtn.classList.remove('active');
            mapEl.style.display = 'block'; svPane.style.display = 'none';
            map.invalidateSize(); // was hidden (display:none) while Street View was showing
        }
    }

    // Exposed for the inline onclick= handlers in directions.html.
    window.toggleAnimation = () => { playing ? stopAnimation() : startAnimation(); };
    window.setSpeed = setSpeedInternal;
    window.setViewMode = setViewMode;
    // Called from the onclick in directions.html. These are declared
    // inside boot(), so they are NOT on window by themselves.
    window.toggleGps = toggleGps;
    window.stopGps = stopGps;

    document.getElementById('route-subtitle').innerText = 'Loading Legazpi road network…';
    const initStart = performance.now();
    // computeRoute() lives in .finally(), not duplicated in both .then()
    // and .catch() -- a .then().catch() chain re-runs the .catch() handler
    // if the .then() handler itself throws, which would have called
    // computeRoute() twice from one EBoardRouter.init() resolution.
    EBoardRouter.init()
        .then(() => {
            graphInitMs = performance.now() - initStart;
        })
        .catch(err => {
            console.error('[E-Board Directions] routing unavailable:', err);
        })
        .finally(() => {
            computeRoute(originIdx); // EBoardRouter.route() falls back to the Haversine estimate on its own
        });
}

if (typeof document !== 'undefined') boot();
