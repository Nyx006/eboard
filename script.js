const albayBounds = [
    [13.0000, 123.5000],
    [13.4500, 124.0000]
];

// The area routing.js's road graph actually covers -- mirrors that
// file's BBOX constant exactly. albayBounds above is deliberately
// wider (it just constrains how far the listing-form maps can pan);
// this is the tighter box a pin must fall inside to be routable at
// all. A coordinate outside it makes EBoardRouter.route() fall back to
// a straight-line Haversine estimate instead of a real walking route,
// so the listing forms reject manual/dragged/clicked pins outside it.
// Keep in sync with routing.js's BBOX if that ever changes.
const ROUTING_BBOX = { south: 13.090, west: 123.690, north: 13.220, east: 123.800 };

// Threshold for the "this pin is far from any mapped road" warning on
// the listing forms -- not blocking, just informational.
const PIN_PROXIMITY_WARNING_M = 50;

const placeholderExterior = 'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=800&q=80';

/* The only two identities this app can ever sign in as -- one student
   slot, one landowner slot. currentUser.id is always one of these two
   values regardless of what name is typed at registration (see
   handleAuth() below), which is exactly why conversations must be keyed
   on these ids, not on a display name: a name can vary per session, the
   id can't. Moved up here (out of the auth-handling section further
   down) because defaultConvos, much earlier in load order, needs it --
   a `const` referenced before its own declaration throws, so this has
   to sit above everything that uses it. */
const ROLE_IDENTITY = {
    student:   { id: 'stu-1', name: 'Paolo Cruz',   label: 'BOARDER' },
    landowner: { id: 'own-1', name: 'Ana Ramos', label: 'LANDOWNER' }
};

// Demo "account creation" date for the landowner profile's "Member since"
// row -- this app has no real registration/timestamp tracking (see
// ROLE_IDENTITY's comment above), so this is a hardcoded literal, same
// convention as defaultReviews' createdAt dates below. Student profiles
// don't show a member-since date -- not part of the student profile spec
// (name/school/verified-badge only).
const LANDOWNER_MEMBER_SINCE = '2025-08-14T00:00:00Z';

/* Campuses selectable in #school-select. Coordinates verified against
   OpenStreetMap (Nominatim/Overpass) on 2026-08-24. Adding a campus is
   a one-line addition here — the dropdown is populated from this array. */
const SCHOOLS = [
    { name: "University of Santo Tomas - Legazpi (Rawis)", coords: [13.163772, 123.751261] },
    { name: "Bicol University (Main)", coords: [13.144314, 123.723146] },
    { name: "Bicol University (Daraga Campus)", coords: [13.148080, 123.718054] },
    { name: "University of Santo Tomas - Legazpi (Peñaranda)", coords: [13.149116, 123.753447] },
    { name: "Divine Word College of Legazpi", coords: [13.138088, 123.735962] }
];

const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year', 'Graduate Studies'];

/* Shared by the sign-up form and the "My Profile" edit form -- a
   student's stated school for their profile is NOT limited to the five
   SCHOOLS campuses above (that list is only ever used as a distance-
   calculation origin, see its own comment); "Other" plus a free-text
   field covers everyone else. currentValue may be any string (a known
   campus name, a free-text "other" school, or '') -- selects the
   matching option, or falls back to "Other" with the text field
   populated when it doesn't match one of the five. */
function populateSchoolSelect(selectEl, currentValue) {
    selectEl.innerHTML = '<option value="">Select your school</option>' +
        SCHOOLS.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('') +
        '<option value="__other__">Other</option>';
    if (currentValue && SCHOOLS.some(s => s.name === currentValue)) selectEl.value = currentValue;
    else if (currentValue) selectEl.value = '__other__';
}
function wireSchoolSelectOther(selectEl, otherInputEl, currentValue) {
    populateSchoolSelect(selectEl, currentValue);
    if (currentValue && !SCHOOLS.some(s => s.name === currentValue)) otherInputEl.value = currentValue;
    otherInputEl.style.display = selectEl.value === '__other__' ? 'block' : 'none';
    selectEl.onchange = () => { otherInputEl.style.display = selectEl.value === '__other__' ? 'block' : 'none'; };
}
function readSchoolSelectValue(selectEl, otherInputEl) {
    return selectEl.value === '__other__' ? otherInputEl.value.trim() : selectEl.value;
}
function populateYearLevelSelect(selectEl, currentValue) {
    selectEl.innerHTML = '<option value="">Select year level</option>' +
        YEAR_LEVELS.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join('');
    if (currentValue) selectEl.value = currentValue;
}

// directions.html is a standalone page (its own <script>, no access to
// this file's JS state) and needs the same campus list for its origin
// selector, so it's mirrored into localStorage here.
localStorage.setItem('eboard_schools', JSON.stringify(SCHOOLS));

// Stand-in for real session auth (Laravel sessions land in September —
// see CLAUDE.md). sessionStorage, not localStorage: closing the browser
// tab signs the user out, but a reload (e.g. clicking through to
// directions.html and back) keeps them signed in.
const SESSION_KEY = 'eboard_session';
const SCHOOL_SESSION_KEY = 'eboard_school_idx';

/* Shaped to match the verification_documents table planned in the
   Laravel schema (user_id, document_type, file_path, file_hash, status,
   reviewed_by, reviewed_at, remarks, checklist) so that migration is a
   direct mapping. One record per (user_id, document_type) — re-uploading
   updates it in place rather than keeping old submissions around.

   file_path (the actual document image, a data URL) is retained only
   until a decision is recorded, then deleted -- see purgeExpiredRejectedDocs()
   and uploadVerificationDoc()'s hashing. Identity documents are
   sensitive personal data under RA 10173; once reviewed, the useful
   artifact is the decision (status/reviewed_by/reviewed_at/checklist),
   not the file, so there is no benefit to retaining it and real risk in
   doing so. file_hash (SHA-256 of the original upload) survives the
   deletion, so a specific document can still be proven to be the one
   reviewed without keeping the document itself.

   v17 (bumped from v16): per adviser decision, business permit and
   proof-of-ownership documents were dropped -- government ID only. Any
   v16 records of those two document_types were demo data with no real
   counterpart to migrate, so this is a clean-slate key bump (same
   "new key, not a migration" pattern routing.js's FILTER_VERSION uses)
   rather than a filter applied to old records -- it also guarantees no
   stale permit/ownership record can linger and get counted by
   computeVerificationTier()'s docs.length check above. */
const VERIFICATION_KEY = 'eboard_verification_v17';

// A rejected document's file_path is kept only this long after the
// decision, giving the landowner a chance to see what was flagged
// before resubmitting -- then purgeExpiredRejectedDocs() deletes it.
// Approved documents' files are deleted immediately, not windowed.
const REJECTED_DOC_RETENTION_DAYS = 7;

// One record per user, upserted like verificationDocs -- confirms a
// physical site visit, which no remote document check can establish.
const SITE_VERIFICATION_KEY = 'eboard_site_verification_v17';

const LANDOWNER_ID = 'own-1';
const DOCUMENT_TYPES = [
    { key: 'government_id', label: 'Valid Government ID' }
];

const STUDENT_ID = 'stu-1';
const STUDENT_DOCUMENT_TYPES = [
    { key: 'school_id', label: 'Valid School ID' }
];

/* Separate from VERIFICATION_KEY on purpose, not a version bump of it --
   student school-ID review uses its own checklist (name matches/school
   matches/current-or-recent academic year/legible), which doesn't map
   onto the landowner government-ID checklist (name/unexpired/legible/QR).
   Same record SHAPE as verification_documents (see that comment above:
   user_id, document_type, file_path, file_hash, status, reviewed_by,
   reviewed_at, remarks, checklist, submitted_at, consent) -- but a
   DIFFERENT retention rule per counsel's advice: a landowner is allowed to
   see a student's ID (with consent, for verification/complaint-resolution
   purposes), so an APPROVED student ID's file is kept for as long as the
   student keeps it on their account, instead of being purged immediately
   like the landowner's government ID is. A REJECTED student ID still
   follows the same 7-day purge window as everything else (see
   purgeExpiredRejectedStudentDocs() below). `consent` is
   { version, agreedAt } -- recorded fresh on every upload, see
   uploadStudentVerificationDoc(). */
const STUDENT_VERIFICATION_KEY = 'eboard_student_verification_v1';

// Bump this when the consent notice's content meaningfully changes -- each
// upload records the version in force at the time, on the doc record
// itself (see uploadStudentVerificationDoc()), not a separate log.
const STUDENT_ID_CONSENT_VERSION = 'v1';

// Singleton student profile (school + whatever else the student sets about
// themselves), mirrors landownerProfile's pattern -- own key/version track,
// not related to VERIFICATION_KEY or STUDENT_VERIFICATION_KEY.
const STUDENT_PROFILE_KEY = 'eboard_student_profile_v1';

/* Road-network distance via Dijkstra (see routing.js).
   Cached per school+house pair so sorting doesn't recompute on every keystroke. */
const routeCache = new Map();

function getRoute(destCoords) {
    const key = `${currentSchoolCoords[0]},${currentSchoolCoords[1]}|${destCoords[0]},${destCoords[1]}`;
    if (routeCache.has(key)) return routeCache.get(key);
    const r = EBoardRouter.route(currentSchoolCoords, destCoords);
    routeCache.set(key, r);
    return r;
}

function getPathDist(lat1, lon1, lat2, lon2) {
    return getRoute([lat2, lon2]).km.toFixed(2);
}

/* House rules a landowner marks Allowed ('yes') / Not allowed ('no') /
   not specified (key absent) on a listing's `rules` object. One list
   drives the add/edit form (renderRulesFieldset), the details page
   (renderRulesSection) and the student filters (passesFilters), so the
   three can't drift apart. Structured rather than free text because the
   panel asked for a "pets allowed" filter, which free text can't drive;
   anything not covered here goes in the listing's free-text otherRules. */
const HOUSE_RULES = [
    { key: 'pets',            label: 'Pets',             icon: '🐾' },
    { key: 'smoking',         label: 'Smoking',          icon: '🚬' },
    { key: 'cooking',         label: 'Cooking',          icon: '🍳' },
    { key: 'visitors',        label: 'Visitors',         icon: '👥' },
    { key: 'alcohol',         label: 'Alcohol',          icon: '🍺' },
    { key: 'overnightGuests', label: 'Overnight guests', icon: '🌙' }
];

/* roomCapacity, rules, otherRules, minStay and curfew were added for the
   panel's listing-form feedback -- see DEMO_LISTING_EXTRAS below for the
   backfill onto browsers that saved these three before the fields existed. */
const DEMO_LISTING_EXTRAS = {
    1: { roomCapacity: 2, rules: { pets: 'no', smoking: 'no', cooking: 'yes', visitors: 'yes', alcohol: 'no', overnightGuests: 'no' },
         otherRules: 'Lights out at 11 PM. Visitors stay in the receiving area.', minStay: '1 semester', curfew: '10:00 PM' },
    2: { roomCapacity: 1, rules: { pets: 'yes', smoking: 'no', cooking: 'yes', visitors: 'yes', overnightGuests: 'no' },
         otherRules: 'Small pets only (cats, small dogs). Owner must clean up after them.', minStay: '1 month', curfew: 'None' },
    3: { roomCapacity: 4, rules: { smoking: 'no', cooking: 'no', visitors: 'no', alcohol: 'no' },
         otherRules: '', minStay: '1 school year', curfew: '9:00 PM' }
};

const defaultHouses = [
    { id: 1, name: "Rawis Boarding house", owner: "Mr. Lopez", price: 5500, available: 0, total: 5, location: "Purok 6, Rawis", coords: [13.164005, 123.750120], verificationTier: 'FULLY_VERIFIED', amenities: ["🛏️ Bed", "📶 WiFi", "⚡ Electricity"], streetPhotos: [placeholderExterior], ...DEMO_LISTING_EXTRAS[1] },
    { id: 2, name: "Legazpi Student Hub", owner: "Mrs. Santos", price: 6000, available: 1, total: 3, location: "Rawis Main St.", coords: [13.163495, 123.752880], verificationTier: 'ID_VERIFIED', amenities: ["🍳 Kitchen", "📷 CCTV", "❄️ Aircon"], streetPhotos: [placeholderExterior], ...DEMO_LISTING_EXTRAS[2] },
    { id: 3, name: "Purok 6 Annex", owner: "Mr. Briz", price: 4500, available: 3, total: 10, location: "Purok 6, Rawis", coords: [13.165000, 123.749484], verificationTier: 'UNVERIFIED', amenities: ["💧 Water", "📷 CCTV", "⚡ Electricity"], streetPhotos: [placeholderExterior], ...DEMO_LISTING_EXTRAS[3] }
];

/* One seeded thread between the app's one real student and one real
   landowner (see ROLE_IDENTITY above) -- there's exactly one possible
   pair, so there's exactly one demo conversation, not two unreachable
   ones keyed by flavor-text owner names like the old "Mr. Lopez"/
   "Student <first name>" rows were. Last message is left unread from the
   student on purpose: signing in as the landowner on a fresh load
   should immediately show a real, non-zero badge count -- an honest
   smoke test that routing/unread tracking actually works, not a
   coincidence of a hardcoded number. */
const defaultConvos = [
    { id: 1, studentId: ROLE_IDENTITY.student.id, studentName: ROLE_IDENTITY.student.name,
      landownerId: ROLE_IDENTITY.landowner.id, landownerName: ROLE_IDENTITY.landowner.name,
      propertyId: 2, propertyName: "Legazpi Student Hub", lastMsg: "Is the room still available?",
      history: [
          { role: "student", text: "Is water included in the rent?", at: "2026-08-10T09:00:00Z", read: true },
          { role: "landowner", text: "Yes, water is included.", at: "2026-08-10T09:05:00Z", read: true },
          { role: "student", text: "Is the room still available?", at: "2026-08-19T14:30:00Z", read: false }
      ] }
];

const defaultReviews = [
    { id: 101, propertyId: 2, studentId: 'stu-2', studentName: "Angela R.", rating: 5,
      comment: "Very clean and the landlady is responsive. Water never runs out.",
      status: 'approved', createdAt: '2026-07-14T09:20:00Z', moderatedBy: 'System Admin' },
    { id: 102, propertyId: 3, studentId: 'stu-3', studentName: "Kim P.", rating: 3,
      comment: "Affordable and close to campus, but the WiFi drops in the evening.",
      status: 'approved', createdAt: '2026-07-28T14:05:00Z', moderatedBy: 'System Admin' },
    { id: 103, propertyId: 2, studentId: 'stu-4', studentName: "Marco D.", rating: 1,
      comment: "worst place ever do not stay here!!!",
      status: 'pending', createdAt: '2026-08-19T18:41:00Z', moderatedBy: null }
];

// Shaped to match a planned review_reports table: one row per report,
// not nested inside the review it's about, matching how
// verification_documents is its own table rather than living inside
// a user record.
const REVIEW_REPORTS_KEY = 'eboard_review_reports_v15';
const REPORT_REASONS = ['Spam', 'Fake / not a real stay', 'Offensive language', 'Other'];

/* v19 (renamed from eboard_convs_v18): conversations were keyed by
   studentId/landownerId only, which meant every inquiry from a given
   student collapsed into one thread regardless of which of the
   landowner's listings it was about -- a landowner with multiple
   properties couldn't tell which one a message concerned. Now keyed by
   studentId/landownerId/propertyId; propertyName remains a label
   snapshot only, same convention as student/landownerName.

   No migration this time (unlike v12->v18): v18 messages carry no
   propertyId at all -- the previous migration had already merged
   everything into one thread per (student, landowner) pair, discarding
   per-property attribution in the process. There's no way to correctly
   attribute old messages to a specific listing after that; guessing
   would be fabricating data, not recovering it. This is demo data, so
   v18 is simply abandoned in localStorage, same precedent as the
   verification-tier refactor's key bump. */
const CONVERSATIONS_KEY = 'eboard_convs_v19';

// V13 adds Module 4 (Ratings & Reviews). Module 5 (Admin Dashboard) now
// lives in its own site — see admin.html / admin.js — but still reads
// and writes these same localStorage keys.
let houses = JSON.parse(localStorage.getItem('eboard_v12')) || defaultHouses;
let conversations = JSON.parse(localStorage.getItem(CONVERSATIONS_KEY)) || defaultConvos;
let landownerProfile = JSON.parse(localStorage.getItem('eboard_profile_v12')) || { verificationTier: 'UNVERIFIED' };
let reviews = JSON.parse(localStorage.getItem('eboard_reviews_v13')) || defaultReviews;
let auditLogs = JSON.parse(localStorage.getItem('eboard_audit_v13')) || [];
let verificationDocs = JSON.parse(localStorage.getItem(VERIFICATION_KEY)) || [];
let siteVerifications = JSON.parse(localStorage.getItem(SITE_VERIFICATION_KEY)) || [];
let reviewReports = JSON.parse(localStorage.getItem(REVIEW_REPORTS_KEY)) || [];
let studentVerificationDocs = JSON.parse(localStorage.getItem(STUDENT_VERIFICATION_KEY)) || [];
// Singleton, same pattern as landownerProfile above -- there is exactly
// one student account (ROLE_IDENTITY.student), so no id-keying needed.
// `school` is free text the student types themselves (not limited to the
// SCHOOLS campus-distance list above -- that dropdown is unrelated to
// identity, see its own comment).
let studentProfile = JSON.parse(localStorage.getItem(STUDENT_PROFILE_KEY)) || { school: '' };
let currentUser = null;

/* Migration: listings created before v13 predate the approval workflow.
   Grandfather them in as approved so existing demo data stays visible. */
houses.forEach(h => { if (!h.status) h.status = 'approved'; });

/* Migration: ROLE_IDENTITY.landowner.name used to read "<name>Landowner"
   -- the role label had been concatenated onto the name by mistake --
   and a house's owner field / a conversation's landownerName snapshot
   were both set from that same wrong string. Now that the constant
   above reads the corrected name, normalize any already-saved record
   still carrying the old string so it keeps matching (houses.owner is a
   real comparison key throughout this file; landownerName is a
   display-only label snapshot -- see the comment on defaultConvos).
   Matched by the "Landowner" suffix rather than the exact old string so
   the old name doesn't have to appear in the code; no flavor-text owner
   (Mr. Lopez etc.) ends that way. */
const LANDOWNER_NAME = ROLE_IDENTITY.landowner.name;
houses.forEach(h => { if (h.owner?.endsWith('Landowner')) h.owner = LANDOWNER_NAME; });
conversations.forEach(c => { if (c.landownerName?.endsWith('Landowner')) c.landownerName = LANDOWNER_NAME; });

/* Migration: the old single-ladder SITE_VERIFIED tier (a site visit
   silently overriding/hiding whatever the ID check found) is replaced by
   two independent checks that combine into ID_VERIFIED / SITE_VISITED /
   FULLY_VERIFIED -- see computeVerificationTier()'s comment. Flavor-text
   listing owners (Mr. Lopez etc.) have no real records behind their
   tier -- it's a static demo value -- so they get a direct swap to the
   closest new equivalent (both checks implied "verified" under the old
   top tier). The real account instead gets a fresh sync, which
   recomputes correctly from its actual documents/site-visit records
   regardless of what stale string (or none at all, pre-four-tier-system)
   was sitting in landownerProfile.verificationTier beforehand. */
houses.forEach(h => { if (h.verificationTier === 'SITE_VERIFIED') h.verificationTier = 'FULLY_VERIFIED'; });
if (!['UNVERIFIED', 'DOCUMENTS_SUBMITTED', 'ID_VERIFIED', 'SITE_VISITED', 'FULLY_VERIFIED'].includes(landownerProfile.verificationTier)) {
    syncVerificationTier();
}

/* Migration: a landownerProfile saved before the profile view existed
   has no memberSince -- backfill the same demo constant a fresh profile
   would get, rather than leaving the profile view's "Member since" row
   permanently blank for anyone who saved data before this feature. */
if (!landownerProfile.memberSince) landownerProfile.memberSince = LANDOWNER_MEMBER_SINCE;

/* Migration: the three demo listings saved by a browser before
   roomCapacity/rules/otherRules/minStay/curfew existed get those fields
   from DEMO_LISTING_EXTRAS. Matched on id AND original owner so a
   listing that merely reuses id 1-3 isn't touched, and each field is
   filled only where absent -- a value a landowner set is never
   overwritten. */
const DEMO_OWNERS = { 1: 'Mr. Lopez', 2: 'Mrs. Santos', 3: 'Mr. Briz' };
houses.forEach(h => {
    const extras = DEMO_LISTING_EXTRAS[h.id];
    if (!extras || h.owner !== DEMO_OWNERS[h.id]) return;
    for (const [field, value] of Object.entries(extras)) {
        if (h[field] === undefined) h[field] = value;
    }
});

/* Migration (privacy, 2026-10-14): the three demo pins originally sat
   on real boarding houses in Purok 6, Rawis -- one of them a
   researcher's residence -- while carrying invented prices, rules and
   owners, and two carried a verification badge nobody earned. They
   were moved 110 m, to points 4-8 m from a road (chosen with
   EBoardRouter.nearestNodeDistance()); defaultHouses above holds the
   new values, repeated here for browsers that saved the old ones.

   Deliberately does NOT list the old coordinates: this file is public,
   and naming them here would republish exactly what the move removes.
   It doesn't need to -- no account can edit these three listings
   (their owners are flavor-text names; landowners only edit their own,
   and the admin console doesn't edit coordinates), so any demo pin not
   already at its new spot is an old one. Matched on id + original
   owner; within ~1 m (1e-5 degrees) counts as already moved, so a value
   that round-tripped through JSON doesn't re-trigger it. Fires once. */
const DEMO_NEW_COORDS = { 1: [13.164005, 123.750120], 2: [13.163495, 123.752880], 3: [13.165000, 123.749484] };
const nearlyEqual = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-5;
houses.forEach(h => {
    const newPin = DEMO_NEW_COORDS[h.id];
    if (!newPin || h.owner !== DEMO_OWNERS[h.id] || !Array.isArray(h.coords)) return;
    if (!(nearlyEqual(h.coords[0], newPin[0]) && nearlyEqual(h.coords[1], newPin[1]))) {
        h.coords = [...newPin];
    }
});

/* On a brand-new session nothing has been saved yet — the demo data
   above lives only in memory until some mutation calls saveData().
   Standalone pages that read this data straight from localStorage
   (admin.js, directions.js) need it to already be there, so persist
   the bootstrap state once up front instead of waiting for the first
   edit.

   Every key is passed as mutated, so the in-memory state is what gets
   written. BUG (fixed 2026-10-13): this used to be saveData() with no
   argument, which RELOADS every key from localStorage right before
   writing it -- silently discarding every migration above (owner-name
   suffix, SITE_VERIFIED swap, memberSince, the demo-listing backfill),
   since they only ever existed in memory. A fresh visitor never noticed
   (nothing saved yet to reload), which is why it went unseen. */
saveData(['houses', 'conversations', 'landownerProfile', 'reviews', 'auditLogs',
          'verificationDocs', 'siteVerifications', 'reviewReports',
          'studentVerificationDocs', 'studentProfile']);

let currentSchoolCoords = SCHOOLS[0].coords;
let currentSchoolName = SCHOOLS[0].name;
let selectedRole = '';
let currentChatId = null;
let currentPropertyContext = null;
let currentPropertyId = null;
let isRegistrationMode = false;
let map = null;
let editingHouseId = null;

/* Two tabs (or two logged-in roles, one per tab -- login lives in
   sessionStorage, which is per-tab, not shared) can each hold their own
   in-memory copy of this app's state. The messaging bug this generalizes
   from: saveData() used to persist whatever was currently in memory for
   EVERY key on EVERY call, so mutating one stale copy and saving it
   would silently clobber a newer write another tab made to ANY key --
   not just the one this call meant to change (e.g. a landowner tab
   uploading an ID could silently revert an admin's unrelated listing
   approval, just because that tab's in-memory `houses` predated it).

   The fix has two halves:
   1. Each of these reload*() functions re-reads ONE key fresh from
      localStorage. Call the relevant one immediately before
      finding/mutating that key -- not just before saveData() -- so the
      mutation always applies on top of the latest persisted state.
   2. saveData() itself now takes the list of keys THIS call actually
      changed in memory, and reloads every OTHER key fresh right before
      writing it back -- see saveData()'s own comment below. */
function reloadHouses() { houses = JSON.parse(localStorage.getItem('eboard_v12')) || houses; }
function reloadConversations() { conversations = JSON.parse(localStorage.getItem(CONVERSATIONS_KEY)) || conversations; }
function reloadLandownerProfile() { landownerProfile = JSON.parse(localStorage.getItem('eboard_profile_v12')) || landownerProfile; }
function reloadReviews() { reviews = JSON.parse(localStorage.getItem('eboard_reviews_v13')) || reviews; }
function reloadAuditLogs() { auditLogs = JSON.parse(localStorage.getItem('eboard_audit_v13')) || auditLogs; }
function reloadVerificationDocs() { verificationDocs = JSON.parse(localStorage.getItem(VERIFICATION_KEY)) || verificationDocs; }
function reloadSiteVerifications() { siteVerifications = JSON.parse(localStorage.getItem(SITE_VERIFICATION_KEY)) || siteVerifications; }
function reloadReviewReports() { reviewReports = JSON.parse(localStorage.getItem(REVIEW_REPORTS_KEY)) || reviewReports; }
function reloadStudentVerificationDocs() { studentVerificationDocs = JSON.parse(localStorage.getItem(STUDENT_VERIFICATION_KEY)) || studentVerificationDocs; }
function reloadStudentProfile() { studentProfile = JSON.parse(localStorage.getItem(STUDENT_PROFILE_KEY)) || studentProfile; }

/* `mutated` names the key(s) (matching the reload*() functions above,
   e.g. ['houses']) that THIS call is responsible for persisting from
   memory. Every key NOT named is reloaded fresh from localStorage right
   before being written back, so a save triggered by one action can't
   stomp a different key another tab (admin.html alongside index.html,
   most commonly) changed in the meantime. With no argument every key
   reloads -- NOT a safe no-op after an in-memory change, since the
   change is discarded by the reload. The one-time bootstrap save after
   this file's migrations used to call it that way and silently undid
   every migration; it now names every key instead (see its comment
   above). On a fresh profile with nothing saved yet, JSON.parse(null)
   is null and the `||` keeps the in-memory default either way. */
function saveData(mutated = []) {
    const keep = new Set(mutated);
    if (!keep.has('houses'))                  reloadHouses();
    if (!keep.has('conversations'))            reloadConversations();
    if (!keep.has('landownerProfile'))         reloadLandownerProfile();
    if (!keep.has('reviews'))                  reloadReviews();
    if (!keep.has('auditLogs'))                reloadAuditLogs();
    if (!keep.has('verificationDocs'))         reloadVerificationDocs();
    if (!keep.has('siteVerifications'))        reloadSiteVerifications();
    if (!keep.has('reviewReports'))            reloadReviewReports();
    if (!keep.has('studentVerificationDocs'))  reloadStudentVerificationDocs();
    if (!keep.has('studentProfile'))           reloadStudentProfile();

    try {
        localStorage.setItem('eboard_v12', JSON.stringify(houses));
        localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
        localStorage.setItem('eboard_profile_v12', JSON.stringify(landownerProfile));
        localStorage.setItem('eboard_reviews_v13', JSON.stringify(reviews));
        localStorage.setItem('eboard_audit_v13', JSON.stringify(auditLogs));
        localStorage.setItem(VERIFICATION_KEY, JSON.stringify(verificationDocs));
        localStorage.setItem(SITE_VERIFICATION_KEY, JSON.stringify(siteVerifications));
        localStorage.setItem(REVIEW_REPORTS_KEY, JSON.stringify(reviewReports));
        localStorage.setItem(STUDENT_VERIFICATION_KEY, JSON.stringify(studentVerificationDocs));
        localStorage.setItem(STUDENT_PROFILE_KEY, JSON.stringify(studentProfile));
    } catch (e) {
        alert("Browser storage limit reached. Try uploading fewer or smaller photos.");
    }
}

function hideAllViews() {
    document.getElementById('student-view').style.display = 'none';
    document.getElementById('landowner-view').style.display = 'none';
    document.getElementById('details-view').style.display = 'none';
    document.getElementById('messages-view').style.display = 'none';
}

function selectRole(r) { selectedRole = r; pendingAction = null; setAuthReason(''); document.getElementById('portal-selection').style.display = 'none'; document.getElementById('auth-screen').style.display = 'flex'; updateAuthUI(); }

/* ---- GUEST BROWSING ----
   Panel feedback: a student should be able to look around -- listings,
   campus, filters, details, routes, Street View -- without registering.
   A guest is selectedRole 'student' with currentUser null; most code
   already guards on currentUser?.…, and directions.html never reads the
   session at all. Reviewing, messaging and scheduling a visit still need
   an account: requireAccount() sends a guest to sign in, then
   resumePendingAction() carries on with what they tapped. */
let pendingAction = null; // { action: 'review' | 'chat' | 'schedule', propertyId }

function isGuest() { return selectedRole === 'student' && !currentUser; }

function enterAsGuest() {
    selectedRole = 'student';
    currentUser = null;
    pendingAction = null;
    setAuthReason('');
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ guest: true }));
    enterApp();
    loadRoadNetwork();
}

function setAuthReason(text) {
    const el = document.getElementById('auth-reason');
    el.innerText = text;
    el.style.display = text ? 'block' : 'none';
}

// The student sign-in screen, reached from inside the app (a gated
// action, or a guest's header "Sign in" button) rather than the portal.
function showStudentSignIn(reason) {
    closeAllOverlays();
    selectedRole = 'student';
    isRegistrationMode = false;
    setAuthReason(reason || '');
    document.getElementById('main-app').style.display = 'none';
    document.getElementById('auth-screen').style.display = 'flex';
    updateAuthUI();
    window.scrollTo(0, 0);
}

const ACCOUNT_REASONS = {
    review:   'Sign in to write a review. You can keep browsing without an account.',
    chat:     'Sign in to message the owner. You can keep browsing without an account.',
    schedule: 'Sign in to schedule a visit. You can keep browsing without an account.'
};

// True when there's a signed-in user. Otherwise remembers what the guest
// was trying to do, sends them to sign in, and returns false.
function requireAccount(action) {
    if (currentUser) return true;
    pendingAction = { action, propertyId: currentPropertyId };
    showStudentSignIn(ACCOUNT_REASONS[action]);
    return false;
}

// After a guest signs in from a gated action: back to that listing, and
// straight into the review / chat / schedule they originally tapped.
function resumePendingAction() {
    const p = pendingAction;
    pendingAction = null;
    if (!p || !houses.some(h => h.id === p.propertyId)) return;
    openDetails(p.propertyId);
    const h = houses.find(x => x.id === p.propertyId);
    if (p.action === 'review' && !hasAlreadyReviewed(p.propertyId)) openReviewModal();
    else if (p.action === 'chat') openChatForProperty(h);
    else if (p.action === 'schedule' && h.available > 0) openScheduleModal();
}
function toggleAuthMode() { isRegistrationMode = !isRegistrationMode; updateAuthUI(); }
function updateAuthUI() {
    const t = document.getElementById('auth-title'), b = document.getElementById('auth-btn'), m = document.getElementById('auth-msg'), tl = document.querySelector('.auth-toggle-text a'), rf = document.getElementById('reg-fields'), cp = document.getElementById('reg-confirm-pass');
    const rfStudent = document.getElementById('reg-fields-student');
    const rfLandowner = document.getElementById('reg-fields-landowner');
    if (isRegistrationMode) {
        t.innerText = "Sign Up"; b.innerText = "Sign Up"; m.innerText = "Already have account?"; tl.innerText = "Sign In"; rf.style.display = 'block'; cp.style.display = 'block';
        // Role-specific sign-up fields -- what each role's profile shows
        // (see the profile modals) is what gets captured here. Re-wired
        // every time this runs (role switch, reopening Sign Up) rather
        // than once, so the fields always reflect the current selectedRole
        // and any already-saved profile values (e.g. re-registering).
        rfStudent.style.display = selectedRole === 'student' ? 'block' : 'none';
        rfLandowner.style.display = selectedRole === 'landowner' ? 'block' : 'none';
        if (selectedRole === 'student') {
            wireSchoolSelectOther(document.getElementById('reg-school'), document.getElementById('reg-school-other'), studentProfile.school || '');
            populateYearLevelSelect(document.getElementById('reg-year-level'), studentProfile.yearLevel || '');
        } else if (selectedRole === 'landowner') {
            document.getElementById('reg-about').value = landownerProfile.about || '';
        }
    } else {
        t.innerText = "Sign In"; b.innerText = "Sign In"; m.innerText = "Need account?"; tl.innerText = "Sign Up"; rf.style.display = 'none'; cp.style.display = 'none';
        rfStudent.style.display = 'none';
        rfLandowner.style.display = 'none';
    }
    // Guest browsing is a student-portal option only.
    document.getElementById('guest-entry').style.display = selectedRole === 'student' ? 'block' : 'none';
}
function handleAuth() {
    const identity = ROLE_IDENTITY[selectedRole];
    const fn = document.getElementById('reg-fn').value.trim();
    const ln = document.getElementById('reg-ln').value.trim();

    currentUser = {
        id: identity.id,
        name: (isRegistrationMode && fn) ? `${fn} ${ln}`.trim() : identity.name,
        role: selectedRole
    };

    /* Sign-up captures the same profile fields the profile modals display
       -- written into the existing ROLE_IDENTITY-keyed singleton records
       (studentProfile/landownerProfile), not a new account registry: this
       is still the one hardcoded student/landowner slot, "registering"
       just seeds/updates its profile, same as it already overwrites
       currentUser.name above. Only written on registration, never on a
       plain sign-in. The password input has no `id` (see index.html) on
       purpose -- there's nothing to read here even by accident, since
       it isn't checked or hashed yet and saving it in plaintext would be
       worse than not collecting it at all. */
    if (isRegistrationMode && selectedRole === 'student') {
        const school = readSchoolSelectValue(document.getElementById('reg-school'), document.getElementById('reg-school-other'));
        const yearLevel = document.getElementById('reg-year-level').value;
        reloadStudentProfile();
        if (school) studentProfile.school = school;
        if (yearLevel) studentProfile.yearLevel = yearLevel;
        saveData(['studentProfile']);
    } else if (isRegistrationMode && selectedRole === 'landowner') {
        const about = document.getElementById('reg-about').value.trim(); // optional -- blank is a valid "no bio yet"
        reloadLandownerProfile();
        landownerProfile.about = about;
        saveData(['landownerProfile']);
    }

    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        role: currentUser.role, name: currentUser.name, id: currentUser.id
    }));

    setAuthReason('');
    enterApp();
    // Campus routing is a student concept only — a landowner managing
    // listings has no use for it, so don't fetch ~24,045 nodes on their
    // dashboard. Mirrored in restoreSession() below; keep both in sync.
    if (selectedRole === 'student') loadRoadNetwork();
    if (selectedRole === 'student') resumePendingAction();
}

/* Shared by a fresh sign-in (handleAuth) and a restored session
   (restoreSession) so the two paths can never drift apart. Does NOT
   call loadRoadNetwork() itself — that's gated on role at each call
   site (see the comment above), since only students need it. */
function enterApp() {
    document.getElementById('portal-selection').style.display = 'none';
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('main-app').style.display = 'block';
    const guest = isGuest();
    document.querySelector('.user-name').innerText = guest ? 'Guest' : currentUser.name;
    document.getElementById('display-user-role').innerText = guest ? 'NOT SIGNED IN' : ROLE_IDENTITY[selectedRole].label;

    document.getElementById('nav-messages').style.display = 'inline';
    // A class, not style.display: style.css forces these two to
    // inline-flex !important on mobile (see .guest-hidden there).
    document.getElementById('nav-messages').classList.toggle('guest-hidden', guest);
    document.getElementById('nav-myprofile').classList.toggle('guest-hidden', guest);
    const authBtn = document.getElementById('header-auth-btn');
    authBtn.innerText = guest ? 'Sign in' : 'Logout';
    authBtn.onclick = guest ? () => showStudentSignIn('') : logout;
    updateMessageBadge();

    goHome();
    renderAll();
}

/* Runs once at page load. If a session was left behind by a previous
   load in this tab (e.g. the "Back to directory" link from
   directions.html), skip straight past the portal/auth screens instead
   of dropping a signed-in user back at the login form. */
function restoreSession() {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (!saved) return;

    if (saved.guest) {
        currentUser = null;
        selectedRole = 'student';
    } else {
        currentUser = { id: saved.id, name: saved.name, role: saved.role };
        selectedRole = saved.role;
    }

    const savedSchoolIdx = sessionStorage.getItem(SCHOOL_SESSION_KEY);
    if (savedSchoolIdx !== null && SCHOOLS[savedSchoolIdx]) {
        document.getElementById('school-select').selectedIndex = savedSchoolIdx;
        currentSchoolCoords = SCHOOLS[savedSchoolIdx].coords;
        currentSchoolName = SCHOOLS[savedSchoolIdx].name;
    }

    enterApp();
    // See the matching comment in handleAuth() — students only.
    if (selectedRole === 'student') loadRoadNetwork();
}

/* Pulls the Legazpi road graph from OpenStreetMap, then re-sorts every
   listing using true road distance. Runs once per session. Students
   only — see the call sites in handleAuth()/restoreSession(). */
function loadRoadNetwork() {
    if (EBoardRouter.isReady()) return;

    // ?refreshRoads=1 bypasses the cached graph and the bundled snapshot
    // and fetches live from Overpass for this load — handy
    // while testing without needing any permanent UI for it.
    const forceRefresh = new URLSearchParams(location.search).has('refreshRoads');

    /* In the page flow at the top of the listings area, not
       position:fixed. As a fixed overlay it sat on top of whatever was
       under it -- on phones the header wraps taller than the 80px the
       old mobile override assumed, so it covered the Logout button on
       every index load, and it floated above open modals (it covered the
       review modal's title when returning from directions.html). In the
       flow it can't overlap a control, and an open modal covers it.

       Only shown if loading takes longer than BANNER_DELAY_MS: a cached
       graph is ready in ~20-200 ms, so a returning visitor never sees it
       flash (and the grid doesn't jump). Failure is always shown. */
    const BANNER_DELAY_MS = 400;
    const banner = document.createElement('div');
    banner.id = 'routing-status';
    banner.style.cssText = 'margin:0 0 20px;background:#9B72FF;color:#fff;text-align:center;' +
        'padding:12px 22px;border-radius:10px;font-size:14px;font-weight:600;';
    banner.innerText = 'Loading Legazpi road network…';
    const showBanner = () => { if (!banner.isConnected) document.querySelector('#student-view .content').prepend(banner); };
    const bannerTimer = setTimeout(showBanner, BANNER_DELAY_MS);

    EBoardRouter.init({ forceRefresh })
        .then((graph) => {
            console.log('[E-Board] road network ready:', graph.coords.size, 'nodes');
            routeCache.clear();          // discard fallback estimates
            renderAll();                 // re-sort by true road distance; also refreshes card distances

            // renderAll() only touches the grid/dashboard — if the user
            // already had a property's details view open (map + distance
            // banner), it was built from the stale cached estimate and
            // won't redraw on its own. Re-run it now that real routes
            // are available.
            if (currentPropertyId && document.getElementById('details-view').style.display === 'block') {
                openDetails(currentPropertyId);
            }

            clearTimeout(bannerTimer);
            if (!banner.isConnected) return; // finished before the banner was ever shown
            banner.style.background = '#28a745';
            banner.innerText = 'Road network loaded — routing active';
            setTimeout(() => banner.remove(), 2500);
        })
        .catch(err => {
            console.error('[E-Board] routing unavailable:', err);
            clearTimeout(bannerTimer);
            showBanner();
            banner.style.background = '#dc3545';
            banner.innerText = 'Road network unavailable — showing estimated distances';
            setTimeout(() => banner.remove(), 5000);
        });
}
function backToPortal() { pendingAction = null; setAuthReason(''); document.getElementById('auth-screen').style.display = 'none'; document.getElementById('portal-selection').style.display = 'flex'; }
function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SCHOOL_SESSION_KEY); // don't leak the last user's campus choice to the next sign-in
    location.reload();
}

/* BUG: every modal (.modal, z-index 3000 -- landowner/student profile,
   schedule, add/edit listing, review, image viewer) is a fixed,
   full-viewport backdrop, and .main-header (z-index 1000, its own
   stacking context via position:sticky) paints underneath it -- by
   design, a modal is supposed to block the page behind it. But that
   made the E-Board logo (onclick="goHome()") look dead the instant a
   modal was open: the click never reached the logo at all, it hit the
   modal's backdrop instead, which (except image-view-modal, already
   click-to-close) had no handler of its own -- nothing visibly
   happened, which reads as "glitching," most commonly hit right after
   opening My Profile.

   Raising just the logo's z-index does NOT work here -- .main-header
   already creates its own stacking context, so a child's z-index can
   only reorder it among the header's OTHER children, never let it
   escape above a sibling stacking context (the modal) with a higher
   z-index of its own. The actual fix is each modal's own backdrop: all
   of them (see the onclick="event.stopPropagation()" added to their
   .modal-form-content, so clicks on the form itself don't bubble up)
   now close on a click outside their content box, same convention
   image-view-modal already used. One click anywhere outside the box --
   including where the logo visually sits underneath it -- gets you back
   to a clickable header; a second click on the logo goes home. */
function closeAllOverlays() {
    closeScheduleModal();
    closeAddListing();
    closeEditListing();
    closeReviewModal();
    closeImageModal();
    closeLandownerProfileModal();
    closeStudentProfileModal();
    closeChat();
}

function goHome() {
    closeAllOverlays();
    hideAllViews();
    destroyDetailsMap();
    if (selectedRole === 'student')        document.getElementById('student-view').style.display = 'block';
    else                                   document.getElementById('landowner-view').style.display = 'block';
}

/* ---- LANDOWNER VERIFICATION (document review) ----
   Replaces the old self-service phone-OTP "Verify Now" flow (any 6
   digits used to flip isVerified straight to true). Real review now: a
   government ID, approved or rejected by an admin in admin.js's
   Landowner Accounts tab, plus an optional in-person site visit an
   admin can record separately. landownerProfile.verificationTier stays
   as a field, but it's derived — see syncVerificationTier() below —
   never set directly here again.

   Per adviser decision, business permit and proof-of-property-ownership
   documents were dropped from verification entirely (government ID
   only) — DOCUMENT_TYPES above now holds just the one entry. The tier
   name DOCUMENTS_SUBMITTED is kept as-is (renaming it would ripple
   through both apps' localStorage-derived state for no behavioral
   gain); only its displayed label changed, to "ID Submitted" — see
   TIER_BADGE-adjacent display maps below and in admin.js.

   ID review and a site visit verify two DIFFERENT things -- identity vs.
   "the property exists and the owner is present at it" -- so they're
   tracked as two independent checks, not steps on one ladder. Previously
   a site visit silently overrode/hid the ID result (SITE_VERIFIED meant
   "site visited," full stop, regardless of whether the ID was ever
   reviewed); now the tier reflects the actual combination of both
   checks, computed fresh from the two inputs every time -- nothing here
   is ever set directly from anything other than docs/siteVerifiedRecord. */
function computeVerificationTier(docs, siteVerifiedRecord) {
    const idDoc = docs.find(d => d.document_type === 'government_id');
    const idReviewed = idDoc?.status === 'approved';
    const siteVisited = !!siteVerifiedRecord;
    if (idReviewed && siteVisited) return 'FULLY_VERIFIED';
    if (siteVisited) return 'SITE_VISITED';
    if (idReviewed) return 'ID_VERIFIED';
    if (docs.length > 0) return 'DOCUMENTS_SUBMITTED'; // covers pending and rejected-not-yet-resubmitted alike
    return 'UNVERIFIED';
}

/* Keeps the badge/status machinery working: the card badge and
   details-page badge both read h.verificationTier, so this is the only
   place that needs to know about documents or site visits at all. */
function syncVerificationTier() {
    // Reload everything this reads/writes right before doing either --
    // callers don't have to remember to, and it keeps this correct
    // regardless of which caller reached it (uploadVerificationDoc()
    // here; markSiteVerified()/resetVerificationData()/
    // submitDocDecision() in admin.js). verificationDocs is deliberately
    // NOT reloaded here -- the caller just mutated it in memory and
    // hasn't saved yet, so reloading would wipe out that in-progress
    // change before it's ever persisted.
    reloadHouses();
    reloadLandownerProfile();
    reloadSiteVerifications();
    const siteRecord = siteVerifications.find(v => v.user_id === LANDOWNER_ID);
    const tier = computeVerificationTier(verificationDocs.filter(d => d.user_id === LANDOWNER_ID), siteRecord);
    landownerProfile.verificationTier = tier;
    houses.forEach(h => { if (h.owner === 'Ana Ramos') h.verificationTier = tier; });
}

/* SHA-256 of the ORIGINAL uploaded file, not the resized/recompressed
   copy resizeAndCompress() produces below -- the hash is meant to let
   us later prove a specific document was the one reviewed, so it has
   to be a hash of what the landowner actually submitted. crypto.subtle
   requires a secure context (https, or http on localhost/127.0.0.1,
   which is what this project is served from) -- falls back to null
   rather than blocking the upload if it's ever unavailable. */
async function sha256Hex(file) {
    try {
        const buf = await file.arrayBuffer();
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
        console.warn('[E-Board] could not hash upload (crypto.subtle unavailable?):', err.message);
        return null;
    }
}

function uploadVerificationDoc(docType, file) {
    if (!file) return;
    Promise.all([resizeAndCompress(file), sha256Hex(file)]).then(([dataUrl, hash]) => {
        const now = new Date().toISOString();
        reloadVerificationDocs();
        let doc = verificationDocs.find(d => d.user_id === LANDOWNER_ID && d.document_type === docType);
        if (doc) {
            Object.assign(doc, {
                file_path: dataUrl, file_hash: hash, status: 'pending',
                reviewed_by: null, reviewed_at: null, remarks: null, checklist: null, submitted_at: now
            });
        } else {
            verificationDocs.push({
                id: Date.now(), user_id: LANDOWNER_ID, document_type: docType,
                file_path: dataUrl, file_hash: hash, status: 'pending', reviewed_by: null, reviewed_at: null,
                remarks: null, checklist: null, submitted_at: now
            });
        }
        syncVerificationTier(); // also reloads+updates houses & landownerProfile, see its own comment
        saveData(['verificationDocs', 'houses', 'landownerProfile']);
        renderAll();
    });
}

/* Client-only app, no server/cron -- purging a rejected document's file
   past its retention window happens lazily, on the next render, rather
   than on a background timer. Approved documents are purged immediately
   at the moment of decision (see admin.js), not handled here.

   LIMITATION: this is a client-side approximation of a retention
   policy, not an enforced one. The window has only elapsed once someone
   opens either app and this function runs -- a document can sit past
   its 7 days, still fully present, if nobody loads a page in the
   meantime. A real backend would run this as a scheduled server-side
   job (e.g. a daily cron sweep) so deletion is guaranteed to happen on
   schedule regardless of whether anyone is using the app. */
function purgeExpiredRejectedDocs() {
    reloadVerificationDocs();
    const windowMs = REJECTED_DOC_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let purged = false;
    verificationDocs.forEach(d => {
        if (d.status === 'rejected' && d.file_path && (Date.now() - new Date(d.reviewed_at).getTime()) > windowMs) {
            d.file_path = null;
            purged = true;
            logAudit('document.file_purged', 'verification_documents', d.id,
                `${DOCUMENT_TYPES.find(t => t.key === d.document_type)?.label || d.document_type} — rejected document deleted after ${REJECTED_DOC_RETENTION_DAYS}-day retention window`);
        }
    });
    if (purged) saveData(['verificationDocs', 'auditLogs']);
}

/* Shared by the card grid and the details page. UNVERIFIED and
   DOCUMENTS_SUBMITTED both show no badge at all: nothing was
   established for the first, and "documents submitted" is a pending
   state, not a verification outcome -- a student glancing at a card
   shouldn't read either one as reassurance. That pending state stays
   visible only to the landowner themselves (the dashboard's Account
   Status) and to the admin (Landowner Accounts tab); it's deliberately
   never surfaced in the directory. The other three each get their own
   badge, one per combination of the two independent checks (see
   computeVerificationTier() above) -- FULLY_VERIFIED (both) is styled
   distinctly (violet) from ID_VERIFIED (amber) and SITE_VISITED (teal)
   so a student can tell at a glance which combination it is, not just
   that "something" was checked. */
const TIER_BADGE = {
    UNVERIFIED: null,
    DOCUMENTS_SUBMITTED: null,
    ID_VERIFIED: { label: 'ID Verified', cls: 'tier-badge tier-id-verified' },
    SITE_VISITED: { label: 'Site Visited', cls: 'tier-badge tier-site-visited' },
    FULLY_VERIFIED: { label: 'Fully Verified', cls: 'tier-badge tier-fully-verified' }
};
function tierBadgeHtml(tier) {
    const cfg = TIER_BADGE[tier];
    return cfg ? `<span class="${cfg.cls}">${cfg.label}</span>` : '';
}

/* Spells out the two checks the single badge above collapses into one
   label -- "ID verified · Site visited on 22 Sep 2026" -- for the two
   places there's room for it: the landowner profile modal and the
   details page's "About the landowner" section. Only ever reads
   existing records, never sets anything.

   Plain words, not checkmark symbols -- a bare ✓ count (one vs. two)
   was the only signal distinguishing "one check done" from "both done,"
   which doesn't read cleanly and doesn't scale to describing an
   incomplete check at all. Once one of the two checks has happened, both
   are always named explicitly, worded as done or pending, so nothing
   here depends on a symbol to be understood (e.g. ID_VERIFIED-only
   reads "ID verified · Site visit pending").

   For the real landowner account, derives both checks (and the site
   visit's actual date) straight from verificationDocs/siteVerifications
   -- the same records computeVerificationTier() itself reads. Flavor-
   text listing owners (e.g. "Mr. Lopez") have no such records behind
   them at all -- their badge is a static demo value, not a real review
   -- so for them this infers the same two checks from that same tier
   value instead, with no date to show (none exists). Either way the
   breakdown never disagrees with the badge, because both read from the
   same source. Renders nothing at all when NEITHER check has happened,
   matching the badge itself being hidden in that state (UNVERIFIED/
   DOCUMENTS_SUBMITTED) -- there'd be nothing to elaborate on underneath
   an invisible badge. */
function verificationBreakdownHtml(ownerName, tier) {
    const isRealAccount = ownerName === ROLE_IDENTITY.landowner.name;
    let idReviewed, siteVisited, siteVisitedDate = null;
    if (isRealAccount) {
        const idDoc = verificationDocs.find(d => d.user_id === ROLE_IDENTITY.landowner.id && d.document_type === 'government_id');
        const siteRecord = siteVerifications.find(v => v.user_id === ROLE_IDENTITY.landowner.id);
        idReviewed = idDoc?.status === 'approved';
        siteVisited = !!siteRecord;
        siteVisitedDate = siteRecord ? new Date(siteRecord.verified_at) : null;
    } else {
        idReviewed = tier === 'ID_VERIFIED' || tier === 'FULLY_VERIFIED';
        siteVisited = tier === 'SITE_VISITED' || tier === 'FULLY_VERIFIED';
    }
    if (!idReviewed && !siteVisited) return '';
    const idText = idReviewed ? 'ID verified' : 'ID verification pending';
    const dateText = siteVisitedDate
        ? ' on ' + siteVisitedDate.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
    const siteText = siteVisited ? `Site visited${dateText}` : 'Site visit pending';
    return `<p class="mod-meta" style="font-size:13px;">${idText} &nbsp;·&nbsp; ${siteText}</p>`;
}

function renderVerificationSection() {
    const panel = document.getElementById('verification-cards');
    if (!panel) return;
    const myDocs = verificationDocs.filter(d => d.user_id === LANDOWNER_ID);

    panel.innerHTML = DOCUMENT_TYPES.map(t => {
        const doc = myDocs.find(d => d.document_type === t.key);
        const status = doc ? doc.status : 'none';
        const pillClass = { none: 'pill-pending', pending: 'pill-pending', approved: 'pill-ok', rejected: 'pill-bad' }[status];
        const pillLabel = { none: 'Not submitted', pending: 'Pending Review', approved: 'Approved', rejected: 'Rejected' }[status];

        // file_path is null once a decision's been made and (for an
        // approval, immediately; for a rejection, after the retention
        // window) the file itself has been deleted -- only the decision
        // record remains, so the thumbnail is replaced with that fact
        // rather than a broken <img src="null">.
        const thumb = doc && doc.file_path
            ? `<img class="verification-thumb" src="${doc.file_path}" onclick="openImageModal('${doc.file_path}')">`
            : (doc ? `<p class="mod-meta" style="font-style:italic;">Reviewed — document not retained.</p>` : '');
        const remarks = (status === 'rejected' && doc.remarks)
            ? `<p class="mod-meta" style="color:#b02a37;">Reason: ${escapeHtml(doc.remarks)}</p>` : '';

        return `
            <div class="mod-card verification-doc-card status-${status}">
                ${thumb}
                <div class="mod-body">
                    <h4>${t.label}</h4>
                    <p class="mod-meta">Status: <span class="pill ${pillClass}">${pillLabel}</span></p>
                    ${remarks}
                </div>
                <div class="verification-upload-row">
                    <input type="file" accept="image/*" onchange="uploadVerificationDoc('${t.key}', this.files[0])">
                </div>
            </div>`;
    }).join('');
}

/* ---- STUDENT VERIFICATION (school ID review) ----
   Structural mirror of the landowner government-ID flow just above --
   same upsert-by-(user_id, document_type) shape, same resizeAndCompress/
   sha256Hex reuse -- but a genuinely separate array
   (studentVerificationDocs/STUDENT_VERIFICATION_KEY), not a shared one,
   because the admin checklist for a school ID (name matches account,
   school matches stated school, current/recent academic year, legible)
   is different content from the government-ID checklist and the two
   should stay independently reviewable. There's no tier ladder here like
   computeVerificationTier() -- just a single Student Verified badge, on
   or off, since that's all the spec asked for. Retention now DIFFERS from
   the landowner flow -- see STUDENT_VERIFICATION_KEY's own comment above
   and uploadStudentVerificationDoc()/removeMyStudentVerificationDoc()
   below. */
function isStudentVerified() {
    return studentVerificationDocs.find(d => d.user_id === STUDENT_ID && d.document_type === 'school_id')?.status === 'approved';
}

/* Consent is captured fresh on every upload, not just the first -- the
   checkbox this reads (#student-id-consent-checkbox) lives in
   renderMyStudentVerificationPanel(), which is fully re-rendered after a
   successful upload, so a re-upload (e.g. resubmitting after a rejection)
   always starts from an unticked box again. The disabled file input
   (#student-id-file-input, see renderStudentVerificationSection() below)
   is the UI-level gate; this check is the actual enforcement, in case
   that's ever bypassed. */
function uploadStudentVerificationDoc(file) {
    if (!file) return;
    if (!document.getElementById('student-id-consent-checkbox')?.checked) {
        alert('Please read the notice and check the consent box before uploading.');
        return;
    }
    const consent = { version: STUDENT_ID_CONSENT_VERSION, agreedAt: new Date().toISOString() };
    Promise.all([resizeAndCompress(file), sha256Hex(file)]).then(([dataUrl, hash]) => {
        const now = new Date().toISOString();
        reloadStudentVerificationDocs();
        let doc = studentVerificationDocs.find(d => d.user_id === STUDENT_ID && d.document_type === 'school_id');
        if (doc) {
            Object.assign(doc, {
                file_path: dataUrl, file_hash: hash, status: 'pending',
                reviewed_by: null, reviewed_at: null, remarks: null, checklist: null, submitted_at: now, consent
            });
        } else {
            doc = {
                id: Date.now(), user_id: STUDENT_ID, document_type: 'school_id',
                file_path: dataUrl, file_hash: hash, status: 'pending', reviewed_by: null, reviewed_at: null,
                remarks: null, checklist: null, submitted_at: now, consent
            };
            studentVerificationDocs.push(doc);
        }
        logAudit('student_document.consent_recorded', 'student_verification_documents', doc.id,
            `School ID upload consent recorded (notice ${consent.version})`);
        saveData(['studentVerificationDocs', 'auditLogs']);
        renderAll();
        renderMyStudentVerificationPanel(); // rebuilds the notice block too, resetting the checkbox
    });
}

/* Self-service withdrawal -- "at any time," per the student-facing notice.
   A doc with no decision yet (still pending) has nothing worth preserving,
   so withdrawing it removes the whole record, back to "Not submitted" --
   otherwise the thumb-fallback text elsewhere ("Reviewed — document not
   retained") would misdescribe a submission that was never actually
   reviewed. Once a decision exists (approved or rejected), only the image
   goes -- the decision, reviewer, checklist and hash stay, so the history
   (and, per product decision, the Student Verified badge -- see
   isStudentVerified(), which keys off `status`, not `file_path`) survives. */
function removeMyStudentVerificationDoc() {
    reloadStudentVerificationDocs();
    const doc = studentVerificationDocs.find(d => d.user_id === STUDENT_ID && d.document_type === 'school_id');
    if (!doc || !doc.file_path) return;

    if (doc.status === 'pending') {
        if (!confirm("Withdraw your uploaded school ID? Since it hasn't been reviewed yet, this removes your submission entirely -- you can upload again anytime.")) return;
        studentVerificationDocs = studentVerificationDocs.filter(d => d.id !== doc.id);
        logAudit('student_document.withdrawn', 'student_verification_documents', doc.id,
            `${STUDENT_DOCUMENT_TYPES[0].label} — withdrawn by student before review`);
    } else {
        if (!confirm('Remove your uploaded school ID photo? Landowners will no longer be able to see it. The review decision on your account is kept.')) return;
        doc.file_path = null;
        logAudit('student_document.removed_by_student', 'student_verification_documents', doc.id,
            `${STUDENT_DOCUMENT_TYPES[0].label} — photo removed by student; ${doc.status} decision and hash retained`);
    }
    saveData(['studentVerificationDocs', 'auditLogs']);
    renderAll();
    renderMyStudentVerificationPanel();
}

// Mirrors purgeExpiredRejectedDocs() exactly -- see its comment above for
// the client-only-app limitation, which applies identically here.
function purgeExpiredRejectedStudentDocs() {
    reloadStudentVerificationDocs();
    const windowMs = REJECTED_DOC_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let purged = false;
    studentVerificationDocs.forEach(d => {
        if (d.status === 'rejected' && d.file_path && (Date.now() - new Date(d.reviewed_at).getTime()) > windowMs) {
            d.file_path = null;
            purged = true;
            logAudit('document.file_purged', 'student_verification_documents', d.id,
                `${STUDENT_DOCUMENT_TYPES.find(t => t.key === d.document_type)?.label || d.document_type} — rejected document deleted after ${REJECTED_DOC_RETENTION_DAYS}-day retention window`);
        }
    });
    if (purged) saveData(['studentVerificationDocs', 'auditLogs']);
}

function renderStudentVerificationSection() {
    const panel = document.getElementById('student-verification-cards');
    if (!panel) return;
    const myDocs = studentVerificationDocs.filter(d => d.user_id === STUDENT_ID);

    panel.innerHTML = STUDENT_DOCUMENT_TYPES.map(t => {
        const doc = myDocs.find(d => d.document_type === t.key);
        const status = doc ? doc.status : 'none';
        const pillClass = { none: 'pill-pending', pending: 'pill-pending', approved: 'pill-ok', rejected: 'pill-bad' }[status];
        const pillLabel = { none: 'Not submitted', pending: 'Pending Review', approved: 'Approved', rejected: 'Rejected' }[status];

        const thumb = doc && doc.file_path
            ? `<img class="verification-thumb" src="${doc.file_path}" onclick="openImageModal('${doc.file_path}')">`
            : (doc ? `<p class="mod-meta" style="font-style:italic;">Reviewed — document not retained.</p>` : '');
        const remarks = (status === 'rejected' && doc.remarks)
            ? `<p class="mod-meta" style="color:#b02a37;">Reason: ${escapeHtml(doc.remarks)}</p>` : '';
        // "At any time," per the notice above -- available whenever there's
        // an actual image to take down, regardless of status.
        const removeBtn = (doc && doc.file_path)
            ? `<button class="btn-reject" style="margin-top:10px;" onclick="removeMyStudentVerificationDoc()">Remove My School ID</button>` : '';

        return `
            <div class="mod-card verification-doc-card status-${status}">
                ${thumb}
                <div class="mod-body">
                    <h4>${t.label}</h4>
                    <p class="mod-meta">Status: <span class="pill ${pillClass}">${pillLabel}</span></p>
                    ${remarks}
                    ${removeBtn}
                </div>
                <div class="verification-upload-row">
                    <input type="file" id="student-id-file-input" accept="image/*" disabled onchange="uploadStudentVerificationDoc(this.files[0])">
                </div>
            </div>`;
    }).join('');
}

// ---- SCHEDULE VISIT LOGIC ----
function openScheduleModal() { if (!requireAccount('schedule')) return; document.getElementById('schedule-modal').style.display = 'block'; }
function closeScheduleModal() { document.getElementById('schedule-modal').style.display = 'none'; }
function submitSchedule(e) {
    e.preventDefault();
    const date = document.getElementById('sched-date').value;
    const time = document.getElementById('sched-time').value;
    const dateObj = new Date(date + 'T' + time);
    const niceDate = dateObj.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const niceTime = dateObj.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    alert(`Success! Your visit is scheduled for ${niceDate} at ${niceTime}. The landowner has been notified.`);
    closeScheduleModal();
    document.getElementById('schedule-form').reset();
}

// ---- INBOX & CHAT ----

/* Real per-role unread count, replacing the hardcoded "1" that lived in
   index.html's #msg-badge markup (that markup is now just the pre-JS
   placeholder -- this overwrites it as soon as anything runs). Counts,
   across only the current role's own conversations, history entries
   authored by the *other* role that haven't been marked read yet.
   Hides the badge entirely at zero rather than showing "0". */
function updateMessageBadge() {
    const badge = document.getElementById('msg-badge');
    if (!badge || !currentUser) return;
    const mine = selectedRole === 'landowner'
        ? conversations.filter(c => c.landownerId === currentUser.id)
        : conversations.filter(c => c.studentId === currentUser.id);
    const unread = mine.reduce((sum, c) => sum + c.history.filter(m => m.role !== selectedRole && !m.read).length, 0);
    badge.innerText = unread;
    badge.style.display = unread > 0 ? 'inline-block' : 'none';
}

function openInbox() {
    hideAllViews();
    currentPropertyContext = null;
    destroyDetailsMap();
    document.getElementById('messages-view').style.display = 'block';
    document.getElementById('inbox-title').innerText = selectedRole === 'landowner' ? "Student Inquiries" : "Messages";
    renderInbox();
    updateMessageBadge();
}

function renderInbox() {
    const list = document.getElementById('inbox-list'); list.innerHTML = '';
    // Keyed on the signed-in identity's id (see ROLE_IDENTITY), not a
    // display name -- this is the actual fix for the routing bug: a
    // real conversation now shows up for whichever real participant it
    // actually belongs to, on either side.
    const relevantConvos = selectedRole === 'landowner'
        ? conversations.filter(c => c.landownerId === currentUser.id)
        : conversations.filter(c => c.studentId === currentUser.id);

    // Newest activity first, like Messenger -- keyed on the timestamp of
    // each conversation's own last message (already stored as `at` on
    // every history entry, see sendMessage()), not insertion order. A
    // conversation can exist with empty history (openChatForProperty
    // creates one on "Chat with Owner" before any message is sent) --
    // those have no timestamp to sort by, so they sink to the bottom
    // rather than being sorted as if they were oldest.
    const lastMessageAt = c => c.history.length ? c.history[c.history.length - 1].at : null;
    relevantConvos.sort((a, b) => {
        const atA = lastMessageAt(a), atB = lastMessageAt(b);
        if (atA === null && atB === null) return 0;
        if (atA === null) return 1;
        if (atB === null) return -1;
        return new Date(atB) - new Date(atA);
    });

    relevantConvos.forEach(c => {
        // Same unread definition as updateMessageBadge() -- a message
        // from the OTHER role, not yet marked read. Cleared the instant
        // openChat() runs (it flips m.read and now re-renders this list
        // too, see its own comment), so this and the header badge always
        // agree.
        const unreadCount = c.history.filter(m => m.role !== selectedRole && !m.read).length;
        const isUnread = unreadCount > 0;
        const counterpartName = selectedRole === 'landowner' ? c.studentName : c.landownerName;
        // Property name is now the primary heading, not a secondary tag --
        // that's the actual disambiguator: a landowner with several
        // listings has one card per property, and the property name is
        // what tells them apart at a glance (counterpart name alone
        // wouldn't, since a given landowner/student pair can now have
        // multiple threads, one per property). counterpartName and
        // propertyName are free-text-derived (a student's name is typed
        // at registration) and land in the same innerHTML sink lastMsg
        // does -- escaped for the same reason lastMsg was in the prior fix.

        // A landowner viewing their inbox gets a proper tappable chip --
        // avatar + name + school/verified-badge -- as the entry point to
        // that student's profile, same prominence as the landowner-profile
        // entry points elsewhere (card/details page). Gated on selectedRole
        // so a student's own inbox never shows this about themselves.
        // onclick="event.stopPropagation()" keeps the chip's own click
        // from also firing the card's outer openChat(). The badge sits in
        // .name-badge-row next to the name (not mixed into the school-text
        // meta line below) -- same alignment as the chat header and the
        // student profile modal, see .name-badge-row's comment in style.css.
        const studentBadge = isStudentVerified()
            ? '<span class="tier-badge tier-student-verified" style="font-size:9px;">Student Verified</span>' : '';
        const studentMetaLine = studentProfile.school
            ? `<div class="student-chip-meta">${escapeHtml(studentProfile.school)}</div>` : '';
        const counterpartLine = selectedRole === 'landowner'
            ? `<div class="student-chip" onclick="event.stopPropagation(); openStudentProfile('${c.studentId}')">
                    ${initialsAvatarHtml(counterpartName, c.studentId, 32)}
                    <div style="min-width:0;">
                        <div class="name-badge-row">
                            <span class="student-chip-name">${escapeHtml(counterpartName)}</span>
                            ${studentBadge}
                        </div>
                        ${studentMetaLine}
                    </div>
                </div>`
            : `<div style="font-size:13px; color:#999; margin:4px 0;">with ${escapeHtml(counterpartName)}</div>`;

        // Unread indicator reuses the exact .badge class the header's
        // #msg-badge already uses (same red circle + white count) --
        // "consistent with the header badge" means visually the same
        // element, not a lookalike. Property name gets a heavier weight
        // when unread (600 read / 800 unread, both still visually
        // "bold" via the existing <strong>, but distinct from each
        // other); the last message -- plain-weight today -- gets bolded
        // and darkened only in the unread state, since that's the part
        // with no other unread signal at all otherwise.
        const unreadBadge = isUnread
            ? `<span class="badge" style="vertical-align:middle; margin-left:8px;">${unreadCount}</span>` : '';
        const nameWeight = isUnread ? 800 : 600;
        const msgStyle = isUnread ? 'font-weight:700; color:#222;' : 'font-weight:400; color:#666;';

        list.innerHTML += `<div class="inbox-card ${isUnread ? 'inbox-card-unread' : ''}" onclick="openChat(${c.id})"><div><strong style="color:#9B72FF; font-size:20px; font-weight:${nameWeight};">${escapeHtml(c.propertyName || 'General Inquiry')}</strong>${unreadBadge}${counterpartLine}<small style="${msgStyle} font-size:15px;">${escapeHtml(c.lastMsg)}</small></div><div style="color:#9B72FF; font-weight:bold; align-self:center; font-size:24px;">❯</div></div>`;
    });
}

function openChat(convId) {
    reloadConversations();
    const conv = conversations.find(c => c.id === convId);
    if (!conv) return;
    currentChatId = convId;

    const counterpartName = selectedRole === 'landowner' ? conv.studentName : conv.landownerName;
    document.getElementById('chat-with-name').innerText = counterpartName; // .innerText, already safe
    // A landowner can now have multiple open threads with the same
    // student (one per property) -- without this, two chats both headed
    // "Paolo Cruz" would be indistinguishable once open.
    document.getElementById('chat-with-property').innerText = conv.propertyName || 'General Inquiry'; // .innerText, already safe

    // Same student-meta gate as renderInbox() above -- a landowner sees
    // the student's school, an avatar, and a verified badge in the chat
    // header too -- the whole identity block (avatar + name + meta) is
    // the tappable entry point to that student's profile, same treatment
    // as the inbox chip. The badge sits in its own element next to
    // #chat-with-name (inside .name-badge-row, see index.html) rather
    // than mixed into the school text -- that's what was wrapping badly
    // (the pill's own two words breaking mid-badge in the narrow header)
    // instead of the row cleanly dropping the whole badge to a new line.
    // New elements (no prior escaping precedent to preserve, unlike
    // chat-with-name/-property above), so innerHTML + escapeHtml here
    // rather than .innerText.
    const identityEl = document.getElementById('chat-header-identity');
    const avatarEl = document.getElementById('chat-with-avatar');
    const badgeEl = document.getElementById('chat-with-badge');
    const metaEl = document.getElementById('chat-with-student-meta');
    if (selectedRole === 'landowner') {
        avatarEl.innerHTML = initialsAvatarHtml(counterpartName, conv.studentId, 40);
        avatarEl.style.display = '';
        badgeEl.innerHTML = isStudentVerified()
            ? '<span class="tier-badge tier-student-verified" style="font-size:9px;">Student Verified</span>' : '';
        metaEl.innerHTML = escapeHtml(studentProfile.school || '');
        metaEl.style.display = studentProfile.school ? 'block' : 'none';
        identityEl.classList.add('is-clickable');
        identityEl.onclick = () => openStudentProfile(conv.studentId);
    } else {
        avatarEl.innerHTML = '';
        avatarEl.style.display = 'none';
        badgeEl.innerHTML = '';
        metaEl.style.display = 'none';
        metaEl.innerHTML = '';
        identityEl.classList.remove('is-clickable');
        identityEl.onclick = null;
    }

    document.getElementById('chat-overlay').style.display = 'flex';

    // Opening a thread is what marks the other side's messages read --
    // flips the flag, then refreshes the header badge AND re-renders the
    // inbox list (same pattern sendMessage() already uses below) so this
    // conversation's bold/unread-count styling clears immediately rather
    // than waiting for the next unrelated render; message text itself is
    // escaped in renderChatHistory() below, untouched by this change.
    let changed = false;
    conv.history.forEach(m => { if (m.role !== selectedRole && !m.read) { m.read = true; changed = true; } });
    if (changed) saveData(['conversations']);

    renderChatHistory(convId);
    renderInbox();
    updateMessageBadge();
}

function closeChat() { document.getElementById('chat-overlay').style.display = 'none'; }

function renderChatHistory(convId) {
    const body = document.getElementById('chat-body'); body.innerHTML = '';
    const conv = conversations.find(c => c.id === convId);
    if(conv) conv.history.forEach(m => { const isMe = m.role === selectedRole; body.innerHTML += `<div class="msg-bubble ${isMe ? 'msg-me' : 'msg-them'}">${escapeHtml(m.text)}</div>`; });
    body.scrollTop = body.scrollHeight;
}

/* Entry point for a listing's "Chat with Owner" button (see its
   onclick wiring further down). Every listing routes to this app's one
   real landowner login (ROLE_IDENTITY.landowner) regardless of that
   listing's own flavor-text owner field (e.g. "Mr. Lopez") -- there is
   exactly one landowner account that can ever open an inbox here, so
   h.owner becomes landownerName, a label only, not a routing key.
   propertyId IS part of the key, though: one thread per listing, not one
   thread per (student, landowner) covering every property they've ever
   discussed -- that's the whole point of this change. */
function openChatForProperty(h) {
    if (!requireAccount('chat')) return;
    reloadConversations();
    let conv = conversations.find(c =>
        c.studentId === currentUser.id && c.landownerId === ROLE_IDENTITY.landowner.id && c.propertyId === h.id);
    if (!conv) {
        conv = {
            id: Date.now(), studentId: currentUser.id, studentName: currentUser.name,
            landownerId: ROLE_IDENTITY.landowner.id, landownerName: h.owner || ROLE_IDENTITY.landowner.name,
            propertyId: h.id, propertyName: h.name, lastMsg: '', history: []
        };
        conversations.push(conv);
        saveData(['conversations']);
    }
    openChat(conv.id);
}

function sendMessage() {
    const input = document.getElementById('chat-input'); if(!input.value) return;
    reloadConversations();
    const conv = conversations.find(c => c.id === currentChatId);
    if (!conv) return;

    conv.history.push({ role: selectedRole, text: input.value, at: new Date().toISOString(), read: false });
    conv.lastMsg = input.value;
    saveData(['conversations']); input.value = '';
    renderChatHistory(currentChatId); renderInbox();
    updateMessageBadge();
}

// ---- RENDERING & SORTING ----
function populateSchoolDropdown() {
    const select = document.getElementById('school-select');
    select.innerHTML = SCHOOLS.map(s =>
        `<option value="${s.coords[0]},${s.coords[1]}">${s.name}</option>`
    ).join('');
}

function updateSchool() {
    const select = document.getElementById('school-select');
    const coordsArr = select.value.split(',');
    currentSchoolCoords = [parseFloat(coordsArr[0]), parseFloat(coordsArr[1])];
    currentSchoolName = select.options[select.selectedIndex].text;
    sessionStorage.setItem(SCHOOL_SESSION_KEY, String(select.selectedIndex));
    renderAll();
}

function renderAll() {
    const grid = document.getElementById('boarding-house-grid');
    const dash = document.getElementById('dashboard-body');
    if(!grid || !dash) return;
    grid.innerHTML = ''; dash.innerHTML = '';
    const query = document.getElementById('search-input')?.value.toLowerCase() || "";

    purgeExpiredRejectedDocs();

    const verifySpan = document.getElementById('stat-verify');
    if (verifySpan) {
        const siteRecord = siteVerifications.find(v => v.user_id === LANDOWNER_ID);
        const tier = computeVerificationTier(verificationDocs.filter(d => d.user_id === LANDOWNER_ID), siteRecord);
        // No checkmark suffix on the verified states -- a bare ✔ vs ✔✔
        // count was the only thing distinguishing "one check done" from
        // "both done," which doesn't read cleanly. The label text itself
        // (ID Verified / Site Visited / Fully Verified) already says
        // which one it is.
        const verifyDisplay = {
            UNVERIFIED:          { text: 'Unverified ⚠', color: '#dc3545' },
            DOCUMENTS_SUBMITTED: { text: 'ID Submitted ⏳', color: '#9A6B00' },
            ID_VERIFIED:         { text: 'ID Verified', color: '#28a745' },
            SITE_VISITED:        { text: 'Site Visited', color: '#006D72' },
            FULLY_VERIFIED:      { text: 'Fully Verified', color: '#5B21B6' }
        }[tier];
        verifySpan.innerHTML = `<span style="color:${verifyDisplay.color}; font-weight:bold;">${verifyDisplay.text}</span>`;
    }
    renderVerificationSection();

    purgeExpiredRejectedStudentDocs();
    renderStudentVerificationSection();

    // Calculate dynamic distance for sorting
    houses.forEach(h => {
        h.tempDist = parseFloat(getPathDist(currentSchoolCoords[0], currentSchoolCoords[1], h.coords[0], h.coords[1]));
    });

    // Sort array so the nearest house is first
    houses.sort((a, b) => a.tempDist - b.tempDist);

    // Read once per render, not once per card — the dropdown doesn't
    // change mid-loop, and every card links to the same origin campus.
    const schoolIdx = document.getElementById('school-select').selectedIndex;
    const filters = readFilters();
    let approvedCount = 0, shownCount = 0;

    houses.forEach(h => {
        const dist = h.tempDist.toFixed(2);
        const isFull = h.available <= 0;
        const sClass = isFull ? "status-full" : "status-vacant";
        const coverImage = (h.streetPhotos && h.streetPhotos.length > 0) ? h.streetPhotos[0] : placeholderExterior;
        const fullOverlay = isFull ? `<div class="full-overlay">Fully Booked</div>` : '';
        
        if (h.status === 'approved') approvedCount++;
        // Approved-only, search text, and the student filters -- see passesFilters().
        if (passesFilters(h, query, filters)) {
            shownCount++;
            const stats = getRatingStats(h.id);
            const ratingRow = stats.count > 0
                ? `<p class="card-rating">${renderStars(stats.avg)}
                     <span class="card-rating-num">${stats.avg.toFixed(1)}</span>
                     <span class="card-rating-count">(${stats.count})</span></p>`
                : `<p class="card-rating card-rating-none">No reviews yet</p>`;

            grid.innerHTML += `
                <div class="airbnb-card" onclick="openDetails(${h.id})">
                    <div class="card-img-box" style="background-image: url('${coverImage}');">
                        <div class="dist-tag">${dist}km away</div>
                        ${fullOverlay}
                    </div>
                    <div class="card-info">
                        <div class="card-title">
                            ${h.name} 
                            ${tierBadgeHtml(h.verificationTier)}
                        </div>
                        ${ratingRow}
                        <p class="card-owner" data-owner="${escapeHtml(h.owner)}"
                           onclick="event.stopPropagation(); openLandownerProfile(this.dataset.owner)">
                           ${initialsAvatarHtml(h.owner, h.owner, 26)} ${escapeHtml(h.owner)}
                        </p>
                        <p class="card-location">📍 ${h.location}</p>
                        <p class="card-location">${h.available}/${h.total} spots remaining</p>
                        <p class="card-price"><b>₱${h.price}</b> / month</p>
                        <a class="directions-btn"
                           href="directions.html?id=${h.id}&school=${schoolIdx}&from=grid"
                           onclick="event.stopPropagation()">Directions</a>
                    </div>
                </div>`;
        }

        dash.innerHTML += `<tr>
            <td style="font-weight:600; color:#9B72FF; font-size:16px;">${h.name}</td>
            <td>${h.location}</td>
            <td>₱ ${h.price}</td>
            <td>${h.available} / ${h.total}</td>
            <td class="${sClass}">${h.available>0?'Vacant':'Full'}<br>
                <span class="pill ${h.status === 'approved' ? 'pill-ok' : h.status === 'rejected' ? 'pill-bad' : 'pill-pending'}">
                    ${h.status === 'approved' ? 'Live' : h.status === 'rejected' ? 'Rejected' : 'Under Review'}
                </span></td>
            <td>
                <div class="table-action-btns">
                    <button class="edit-btn" onclick="openDetails(${h.id})">View</button>
                    <button class="edit-btn" onclick="openEditListing(${h.id})">Edit</button>
                    <button class="delete-btn" onclick="deleteListing(${h.id})">Remove</button>
                </div>
            </td>
        </tr>`;
    });
    document.getElementById('stat-total').innerText = houses.length;
    document.getElementById('stat-active').innerText = houses.filter(h => h.available > 0).length;
    updateFilterSummary(filters, shownCount, approvedCount);
    if (shownCount === 0 && approvedCount > 0) {
        grid.innerHTML = `<div class="grid-empty">
            <p>No listings match your search and filters.</p>
            <button type="button" class="filter-clear" onclick="clearFilters(true)">Clear search and filters</button>
        </div>`;
    }
}

/* ---- STUDENT FILTERS ----
   Price and distance filtering existed before a script.js rewrite
   dropped them (recovered from the pre-git backup); pets and boarders
   per room were added for the panel's feedback, using the new listing
   fields. Minimum stay and curfew are free text, so they're shown on
   the details page but deliberately not filterable. Only the student
   grid is filtered -- not the landowner dashboard, which renderAll()
   also builds, and not showRecommendations(). */
function readFilters() {
    const val = id => document.getElementById(id);
    return {
        maxPrice: parseInt(val('filter-price')?.value || 0),
        maxDist: parseFloat(val('filter-dist')?.value || 0),
        maxRoom: parseInt(val('filter-room')?.value || 0),
        pets: !!val('filter-pets')?.checked,
        vacantOnly: !!val('filter-vacant')?.checked
    };
}

function passesFilters(house, query, f) {
    if (house.status !== 'approved') return false; // students only ever see approved listings
    if (query && !(house.name.toLowerCase().includes(query) ||
                   house.location.toLowerCase().includes(query))) return false;
    if (f.maxPrice > 0 && house.price > f.maxPrice) return false;
    if (f.maxDist > 0 && house.tempDist > f.maxDist) return false; // road distance once the graph loads
    // A listing that hasn't said how many share a room can't promise "solo" or "up to 2".
    if (f.maxRoom > 0 && !(house.roomCapacity > 0 && house.roomCapacity <= f.maxRoom)) return false;
    // Only an explicit "Allowed" counts; "not specified" doesn't.
    if (f.pets && house.rules?.pets !== 'yes') return false;
    if (f.vacantOnly && house.available <= 0) return false;
    return true;
}

function activeFilterCount(f) {
    return [f.maxPrice > 0, f.maxDist > 0, f.maxRoom > 0, f.pets, f.vacantOnly].filter(Boolean).length;
}

function updateFilterSummary(f, shown, total) {
    const n = activeFilterCount(f);
    const countEl = document.getElementById('filter-count');
    if (countEl) countEl.innerText = n ? `· ${n} active` : '';
    const resultEl = document.getElementById('result-count');
    if (!resultEl) return;
    resultEl.innerText = shown === total
        ? `${total} listing${total === 1 ? '' : 's'}`
        : `${shown} of ${total} listings match your search and filters`;
}

// The panel's button clears just the filters; the empty-state button
// also clears the search text, since either can be what hid everything.
function clearFilters(alsoSearch = false) {
    ['filter-price', 'filter-dist', 'filter-room'].forEach(id => { document.getElementById(id).value = '0'; });
    ['filter-pets', 'filter-vacant'].forEach(id => { document.getElementById(id).checked = false; });
    if (alsoSearch) document.getElementById('search-input').value = '';
    renderAll();
}

function deleteListing(id) {
    if(confirm("Are you sure you want to remove this property?")) {
        reloadHouses();
        houses = houses.filter(h => h.id !== id);
        saveData(['houses']);
        renderAll();
    }
}

function openImageModal(src) {
    document.getElementById('image-view-modal').style.display = 'block';
    document.getElementById('expanded-img').src = src;
}

function closeImageModal() {
    document.getElementById('image-view-modal').style.display = 'none';
}

function openDetails(id) {
    hideAllViews();
    document.getElementById('details-view').style.display = 'block';
    
    const h = houses.find(house => house.id === id);
    const dist = getPathDist(currentSchoolCoords[0], currentSchoolCoords[1], h.coords[0], h.coords[1]);
    const isFull = h.available <= 0;
    
    currentPropertyContext = h.name;
    currentPropertyId = h.id;
    renderReviews(h.id);

    // Same-tab navigation, no target="_blank" — Directions replaces the
    // current page here, unlike the (also same-tab) card button. The
    // from=details flag tells directions.html to send the user back to
    // this details page rather than the grid (from=grid does the reverse).
    document.getElementById('details-directions-btn').href =
        `directions.html?id=${currentPropertyId}&school=${document.getElementById('school-select').selectedIndex}&from=details`;

    document.getElementById('details-distance-text').innerText = dist;
    document.getElementById('details-commute-text').innerText = Math.round(dist * 12);
    document.getElementById('details-status-text').innerText = isFull ? "Full" : "Vacant";
    document.getElementById('details-status-text').className = isFull ? "status-full" : "status-vacant";
    
    const gallery = document.getElementById('details-image-gallery');
    gallery.innerHTML = '';
    if (h.streetPhotos && h.streetPhotos.length > 0) {
        h.streetPhotos.forEach(photo => {
            gallery.innerHTML += `<img src="${photo}" class="gallery-img" alt="Property View" onclick="openImageModal(this.src)">`;
        });
    } else {
        gallery.innerHTML = `<img src="${placeholderExterior}" class="gallery-img" alt="Default View" onclick="openImageModal(this.src)">`;
    }

    document.getElementById('details-card-content').innerHTML = `
        <h2 style="font-size:38px; color:#222; font-weight:700;">${h.name} ${tierBadgeHtml(h.verificationTier)}</h2>
        <p style="color:#666; font-size:18px; margin:15px 0;">📍 ${h.location}</p>
        <p style="font-size:32px; font-weight:bold; color:#333; margin-top:20px;">₱${h.price} <span style="font-size:18px; color:#777; font-weight:normal;">/ month</span></p>`;

    // "About the landowner" sits directly above Ratings & Reviews -- reads
    // naturally as "who's renting this out" right before "what students
    // think of it," rather than competing with the name/price for
    // attention at the very top of the page.
    document.getElementById('landowner-about-section').innerHTML = `
        <div class="landowner-about" data-owner="${escapeHtml(h.owner)}">
            <div class="landowner-about-identity" onclick="openLandownerProfile(this.parentElement.dataset.owner)">
                ${initialsAvatarHtml(h.owner, h.owner, 48)}
                <div>
                    <p class="landowner-about-label">About the landowner</p>
                    <p class="landowner-about-name">${escapeHtml(h.owner)} ${tierBadgeHtml(h.verificationTier)}</p>
                    ${verificationBreakdownHtml(h.owner, h.verificationTier)}
                </div>
            </div>
            <button type="button" class="landowner-about-btn"
                onclick="openLandownerProfile(this.parentElement.dataset.owner)">View Profile</button>
        </div>`;

    const recSection = document.getElementById('recommendation-section');
    const scheduleBtn = document.getElementById('details-schedule-btn');
    
    if (isFull) { 
        recSection.style.display = 'block'; showRecommendations(h.id); scheduleBtn.style.display = 'none'; 
    } else { 
        recSection.style.display = 'none'; scheduleBtn.style.display = 'block'; 
    }

    const aGrid = document.getElementById('details-amenities-grid'); aGrid.innerHTML = '';
    h.amenities.forEach(a => aGrid.innerHTML += `<div class="amenity-item">${a}</div>`);
    renderRulesSection(h);
    document.getElementById('details-contact-btn').onclick = () => openChatForProperty(h);
    
    initMap(h.coords, h.name);
}

/* "Rooms & house rules" on the details page. Every field is optional on
   the record (listings saved before these fields existed lack them), so
   anything missing reads "Not specified" rather than blank/undefined.
   Free text is landowner input -- always escaped. */
function renderRulesSection(h) {
    const notSpecified = '<span class="rules-unset">Not specified</span>';
    const text = v => (v && String(v).trim()) ? escapeHtml(String(v).trim()) : notSpecified;
    const chips = value => HOUSE_RULES.filter(r => h.rules?.[r.key] === value)
        .map(r => `<span class="rule-chip rule-chip-${value}">${value === 'yes' ? '✓' : '✗'} ${r.label}</span>`).join('');
    const allowed = chips('yes'), notAllowed = chips('no');

    document.getElementById('details-rules-section').innerHTML = `
        <h3 style="margin-bottom: 20px; font-size: 22px;">Rooms &amp; House Rules</h3>
        <div class="rules-facts">
            <div class="rules-fact"><span class="rules-fact-label">Boarders per room</span><span class="rules-fact-value">${h.roomCapacity ? (h.roomCapacity === 1 ? '1 (solo room)' : h.roomCapacity) : notSpecified}</span></div>
            <div class="rules-fact"><span class="rules-fact-label">Minimum stay</span><span class="rules-fact-value">${text(h.minStay)}</span></div>
            <div class="rules-fact"><span class="rules-fact-label">Curfew</span><span class="rules-fact-value">${text(h.curfew)}</span></div>
        </div>
        <div class="rules-group"><p class="rules-group-label">Allowed</p><div class="rule-chips">${allowed || notSpecified}</div></div>
        <div class="rules-group"><p class="rules-group-label">Not allowed</p><div class="rule-chips">${notAllowed || notSpecified}</div></div>
        ${h.otherRules && h.otherRules.trim() ? `<div class="rules-group"><p class="rules-group-label">Other rules</p><p class="rules-other">${escapeHtml(h.otherRules.trim())}</p></div>` : ''}`;
}

/* BUG (fixed 2026-10-13): map creation is deferred 200 ms (below), and
   nothing cancelled a pending one. Two openDetails() calls inside that
   window -- returning from directions.html, or a guest signing in from
   a gated action and resumePendingAction() reopening the listing --
   queued two L.map() calls on the same container: the second threw "Map
   container is already initialized", and a later map.remove() threw
   "Map container is being reused by another instance", which aborted
   sign-in before the chat/review it was resuming could open. Every
   teardown now goes through destroyDetailsMap(), which also cancels a
   pending creation. */
let mapInitTimer = null;
function destroyDetailsMap() {
    clearTimeout(mapInitTimer);
    mapInitTimer = null;
    if (map) { map.remove(); map = null; }
}

function initMap(coords, name) {
    destroyDetailsMap();
    mapInitTimer = setTimeout(() => {
        mapInitTimer = null;
        map = L.map('details-map', { zoomControl: false, maxBounds: albayBounds, maxBoundsViscosity: 1.0, minZoom: 10 }).setView(coords, 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
        L.marker(coords).addTo(map).bindPopup(name).openPopup();
        L.circleMarker(currentSchoolCoords, { color: 'red' }).addTo(map).bindPopup("Campus");

        const r = getRoute(coords);
        // Solid line = computed road route. Dashed = straight-line fallback.
        const line = L.polyline(r.path, {
            color: '#9B72FF',
            weight: 5,
            opacity: 0.85,
            dashArray: r.estimated ? '8, 10' : null
        }).addTo(map);

        map.fitBounds(line.getBounds(), { padding: [40, 40] });
        map.invalidateSize();
    }, 200);
}

function closeDetails() { 
    destroyDetailsMap();
    currentPropertyContext = null;
    goHome();
}

function showRecommendations(currentId) {
    const list = document.getElementById('recommendation-list'); list.innerHTML = '';
    let recs = houses.filter(h => h.id !== currentId && h.available > 0 && h.status === 'approved');
    recs.forEach(h => h.tempDist = getPathDist(currentSchoolCoords[0], currentSchoolCoords[1], h.coords[0], h.coords[1]));
    recs.sort((a, b) => a.tempDist - b.tempDist);
    if(recs.length === 0) { list.innerHTML = `<p style="color:#666;">No available accommodations nearby.</p>`; return; }
    recs.forEach(r => { 
        list.innerHTML += `<div class="rec-card" onclick="closeDetails(); setTimeout(() => openDetails(${r.id}), 100);"><strong style="font-size:18px; color:#222;">${r.name}</strong><br><span style="color:#9B72FF; font-weight:bold; font-size:18px;">₱${r.price}</span><br><span style="font-size:13px; color:#666; display:block; margin-top:10px;">🏃 ${r.tempDist}km away</span></div>`; 
    });
}

function resizeAndCompress(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_WIDTH = 500;
                let width = img.width;
                let height = img.height;
                if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.3)); 
            };
        };
    });
}

// ---- ADD/EDIT LISTING: shared pin <-> manual-coordinate-field sync ----
//
// Both forms have exactly one canonical coordinate per listing, held in
// the hidden <prefix>-lat/-lng inputs saveNewListing()/saveEditListing()
// already read. Every input method (map click, marker drag, typing into
// the manual fields) goes through tryAcceptPinCoords() below, which is
// the only thing that writes those hidden fields -- so the manual
// fields and the pin can never disagree, because neither of them IS the
// state, they're both just views of it that get repainted together by
// displayPinCoords().

function isInsideRoutingBbox(lat, lng) {
    return lat >= ROUTING_BBOX.south && lat <= ROUTING_BBOX.north &&
           lng >= ROUTING_BBOX.west && lng <= ROUTING_BBOX.east;
}

function showCoordError(prefix, show, message) {
    const el = document.getElementById(`${prefix}-coord-error`);
    el.innerText = message || '';
    el.style.display = show ? 'block' : 'none';
}

// Best-effort: EBoardRouter's graph may still be loading, or may have
// failed to load at all (offline), when this runs -- either way this
// just leaves the warning hidden rather than blocking on it. Re-run
// once the graph does finish loading (see the EBoardRouter.init() calls
// in openAddListing/openEditListing below) so a pin placed before the
// graph was ready still gets checked once it is.
function updateProximityWarning(prefix, lat, lng) {
    const warnEl = document.getElementById(`${prefix}-proximity-warning`);
    if (!EBoardRouter.isReady()) { warnEl.style.display = 'none'; return; }
    const offset = EBoardRouter.nearestNodeDistance(lat, lng);
    if (offset !== null && offset > PIN_PROXIMITY_WARNING_M) {
        warnEl.innerText = `⚠ This pin is about ${offset.toFixed(0)} m from the nearest mapped road. ` +
            `Routing accuracy may be reduced — consider moving the pin closer to the street.`;
        warnEl.style.display = 'block';
    } else {
        warnEl.style.display = 'none';
    }
}

// Repaints the hidden fields (canonical) and the manual-entry fields
// (display) from one accepted coordinate. No bbox check here -- by the
// time this runs that's already been decided, either by
// tryAcceptPinCoords() below or, for an existing listing's already-
// saved coordinate being loaded into the Edit form, deliberately not
// at all (that data displays and gets a warning, but isn't discarded
// just for having been saved before this validation existed).
function displayPinCoords(prefix, lat, lng) {
    document.getElementById(`${prefix}-lat`).value = lat;
    document.getElementById(`${prefix}-lng`).value = lng;
    document.getElementById(`${prefix}-manual-lat`).value = lat.toFixed(6);
    document.getElementById(`${prefix}-manual-lng`).value = lng.toFixed(6);
    updateProximityWarning(prefix, lat, lng);
}

// The one gate a user-initiated pin change (click, drag, or a completed
// manual entry) goes through. Returns true if accepted -- in which case
// every field/warning has already been repainted via displayPinCoords()
// -- or false if rejected as outside the routing area, in which case
// nothing was written and the caller must not move the visual pin
// either (see the dragend handlers below, which snap the marker back).
function tryAcceptPinCoords(prefix, lat, lng) {
    if (!isInsideRoutingBbox(lat, lng)) {
        showCoordError(prefix, true,
            'This location is outside the mapped area for Legazpi City ' +
            '(13.090–13.220°N, 123.690–123.800°E) and cannot be routed — it would fall ' +
            'back to a straight-line distance estimate instead of a real walking route.');
        return false;
    }
    showCoordError(prefix, false);
    displayPinCoords(prefix, lat, lng);
    return true;
}

// Shared by both forms' markers: on drag end, try to accept the dropped
// position; if rejected, snap the marker back to the last accepted
// coordinate (still sitting in the hidden fields, untouched by a
// rejection) so the visual pin never ends up disagreeing with the
// stored one.
function wireMarkerDrag(prefix, marker) {
    marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        if (tryAcceptPinCoords(prefix, lat, lng)) return;
        const prevLat = parseFloat(document.getElementById(`${prefix}-lat`).value);
        const prevLng = parseFloat(document.getElementById(`${prefix}-lng`).value);
        if (!isNaN(prevLat) && !isNaN(prevLng)) marker.setLatLng([prevLat, prevLng]);
    });
}

// Wired to the manual lat/lng inputs' `change` event (fires on blur/
// commit, not per keystroke) rather than `input` -- displayPinCoords()
// reformats both fields to 6 decimals, which would fight the user's
// cursor mid-keystroke on `input`, and re-centering the map on every
// digit typed would be jarring. Both fields empty/partial is a normal
// mid-entry state, not an error, so it's silently ignored, not flagged.
function onManualCoordChange(prefix, map, getMarker, setMarker) {
    const latEl = document.getElementById(`${prefix}-manual-lat`);
    const lngEl = document.getElementById(`${prefix}-manual-lng`);
    if (latEl.value.trim() === '' || lngEl.value.trim() === '') { showCoordError(prefix, false); return; }

    const lat = parseFloat(latEl.value), lng = parseFloat(lngEl.value);
    if (isNaN(lat) || isNaN(lng)) { showCoordError(prefix, true, 'Enter valid numeric coordinates.'); return; }
    if (!tryAcceptPinCoords(prefix, lat, lng)) return;

    const latlng = [lat, lng];
    const marker = getMarker();
    if (marker) { marker.setLatLng(latlng); }
    else { setMarker(L.marker(latlng, { draggable: true }).addTo(map)); wireMarkerDrag(prefix, getMarker()); }
    map.panTo(latlng);
}

// ---- ADD LISTING ----
let addMap, selectionMarker;
/* ---- ROOMS & HOUSE RULES (listing form) ----
   The same block appears in the add and edit forms; `prefix` is 'add'
   or 'edit', matching the element ids in index.html. */
function renderRulesFieldset(prefix) {
    const fs = document.getElementById(prefix + '-rules');
    fs.querySelectorAll('.rule-row').forEach(r => r.remove());
    fs.insertAdjacentHTML('beforeend', HOUSE_RULES.map(r => `
        <div class="rule-row" role="radiogroup" aria-label="${r.label}">
            <span class="rule-name">${r.icon} ${r.label}</span>
            <div class="rule-options">
                <label><input type="radio" name="${prefix}-rule-${r.key}" value="yes"><span>Allowed</span></label>
                <label><input type="radio" name="${prefix}-rule-${r.key}" value="no"><span>Not allowed</span></label>
                <label><input type="radio" name="${prefix}-rule-${r.key}" value="" checked><span>Not set</span></label>
            </div>
        </div>`).join(''));
}

function readListingExtras(prefix) {
    const rules = {};
    HOUSE_RULES.forEach(r => {
        const v = document.querySelector(`input[name="${prefix}-rule-${r.key}"]:checked`)?.value;
        if (v) rules[r.key] = v; // "Not set" stores nothing, same as an old listing
    });
    return {
        roomCapacity: parseInt(document.getElementById(prefix + '-room-capacity').value),
        rules,
        otherRules: document.getElementById(prefix + '-other-rules').value.trim(),
        minStay: document.getElementById(prefix + '-min-stay').value.trim(),
        curfew: document.getElementById(prefix + '-curfew').value.trim()
    };
}

function fillListingExtras(prefix, h) {
    document.getElementById(prefix + '-room-capacity').value = h.roomCapacity ?? '';
    HOUSE_RULES.forEach(r => {
        const v = h.rules?.[r.key] || '';
        const radio = document.querySelector(`input[name="${prefix}-rule-${r.key}"][value="${v}"]`);
        if (radio) radio.checked = true;
    });
    document.getElementById(prefix + '-other-rules').value = h.otherRules || '';
    document.getElementById(prefix + '-min-stay').value = h.minStay || '';
    document.getElementById(prefix + '-curfew').value = h.curfew || '';
}

// Boarders sharing one room can't exceed the whole house's capacity.
function roomCapacityError(roomCapacity, total) {
    if (!Number.isInteger(roomCapacity) || roomCapacity < 1) return 'Please enter how many boarders share one room (at least 1).';
    if (Number.isInteger(total) && roomCapacity > total) return `Boarders per room (${roomCapacity}) can't be more than the total capacity (${total}).`;
    return null;
}

function openAddListing() {
    document.getElementById('add-listing-modal').style.display = 'block';
    // Needed for the pin-proximity warning -- landowners otherwise never
    // load the road graph at all (see loadRoadNetwork()'s student-only
    // gating), but this form is exactly the moment routing quality
    // starts to matter to one. Re-checks whatever pin is already placed
    // once the graph resolves; a no-op if nothing's placed yet.
    EBoardRouter.init().then(() => {
        const lat = parseFloat(document.getElementById('add-lat').value);
        const lng = parseFloat(document.getElementById('add-lng').value);
        if (!isNaN(lat) && !isNaN(lng)) updateProximityWarning('add', lat, lng);
    }).catch(() => {}); // offline/unreachable -- warning just won't show, not fatal
    setTimeout(() => {
        if (!addMap) {
            addMap = L.map('add-map', { maxBounds: albayBounds, maxBoundsViscosity: 1.0, minZoom: 10 }).setView(currentSchoolCoords, 16);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(addMap);
            addMap.on('click', e => {
                if (!tryAcceptPinCoords('add', e.latlng.lat, e.latlng.lng)) return;
                if (selectionMarker) selectionMarker.setLatLng(e.latlng);
                else { selectionMarker = L.marker(e.latlng, { draggable: true }).addTo(addMap); wireMarkerDrag('add', selectionMarker); }
            });
            document.getElementById('add-manual-lat').addEventListener('change',
                () => onManualCoordChange('add', addMap, () => selectionMarker, m => selectionMarker = m));
            document.getElementById('add-manual-lng').addEventListener('change',
                () => onManualCoordChange('add', addMap, () => selectionMarker, m => selectionMarker = m));
        }
        addMap.invalidateSize();
    }, 250);
}

function closeAddListing() {
    document.getElementById('add-listing-modal').style.display = 'none';
    showCoordError('add', false);
    document.getElementById('add-proximity-warning').style.display = 'none';
}

function saveNewListing(e) {
    e.preventDefault();
    const lat = document.getElementById('add-lat').value;
    const lng = document.getElementById('add-lng').value;
    if(!lat || !lng || isNaN(lat) || isNaN(lng)) return alert("Please mark location on map.");
    const extras = readListingExtras('add');
    const roomError = roomCapacityError(extras.roomCapacity, parseInt(document.getElementById('add-total').value));
    if (roomError) return alert(roomError);

    const saveBtn = document.getElementById('save-property-btn');
    saveBtn.innerText = "Saving & Compressing Photos...";
    saveBtn.disabled = true;

    const amenities = []; 
    document.querySelectorAll('#add-listing-modal .amenities-toggle-grid input:checked').forEach(c => amenities.push(c.value));
    
    const fileInput = document.getElementById('add-street-photo');
    let photosArray = [];

    const finalizeSave = () => {
        if(photosArray.length === 0) photosArray.push(placeholderExterior);
        reloadHouses();
        houses.push({
            id: Date.now(), 
            name: document.getElementById('add-name').value, 
            price: parseInt(document.getElementById('add-price').value), 
            total: parseInt(document.getElementById('add-total').value), 
            available: parseInt(document.getElementById('add-available').value), 
            location: document.getElementById('add-loc').value, 
            coords: [parseFloat(lat), parseFloat(lng)], 
            amenities: amenities, 
            owner: "Ana Ramos",
            verificationTier: landownerProfile.verificationTier,
            status: 'pending',
            streetPhotos: photosArray,
            ...extras
        });
        saveData(['houses']); renderAll(); closeAddListing(); document.getElementById('listing-form').reset();
        if(selectionMarker) { addMap.removeLayer(selectionMarker); selectionMarker = null; }
        saveBtn.innerText = "Save Property"; saveBtn.disabled = false;
    };

    if (fileInput.files && fileInput.files.length > 0) {
        let compressPromises = [];
        let fileCount = Math.min(fileInput.files.length, 3);
        for(let i = 0; i < fileCount; i++) { compressPromises.push(resizeAndCompress(fileInput.files[i])); }
        Promise.all(compressPromises).then(results => { photosArray = results; finalizeSave(); });
    } else {
        finalizeSave();
    }
}

// ---- EDIT LISTING ----
let editMap, editSelectionMarker;
function openEditListing(id) {
    editingHouseId = id;
    const h = houses.find(house => house.id === id);

    document.getElementById('edit-name').value = h.name;
    document.getElementById('edit-loc').value = h.location;
    document.getElementById('edit-price').value = h.price;
    document.getElementById('edit-total').value = h.total;
    document.getElementById('edit-available').value = h.available;
    // Direct display, not tryAcceptPinCoords() -- this is an already-saved
    // coordinate being loaded in, not a new one being proposed. A listing
    // saved before this validation existed shouldn't lose its coordinate
    // just from opening the edit form; it still gets flagged if it's
    // outside the routing area, just not discarded.
    displayPinCoords('edit', h.coords[0], h.coords[1]);
    if (!isInsideRoutingBbox(h.coords[0], h.coords[1])) {
        showCoordError('edit', true,
            'This listing\'s saved location is outside the mapped area for Legazpi City ' +
            '(13.090–13.220°N, 123.690–123.800°E) and cannot be routed.');
    }

    const checkboxes = document.querySelectorAll('#edit-listing-modal .amenities-toggle-grid input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = h.amenities.includes(cb.value); });
    fillListingExtras('edit', h);

    document.getElementById('edit-listing-modal').style.display = 'block';
    // See openAddListing()'s identical call for why this is needed here.
    EBoardRouter.init().then(() => {
        const lat = parseFloat(document.getElementById('edit-lat').value);
        const lng = parseFloat(document.getElementById('edit-lng').value);
        if (!isNaN(lat) && !isNaN(lng)) updateProximityWarning('edit', lat, lng);
    }).catch(() => {});

    setTimeout(() => {
        if (!editMap) {
            editMap = L.map('edit-map', { maxBounds: albayBounds, maxBoundsViscosity: 1.0, minZoom: 10 }).setView(h.coords, 16);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(editMap);
            editMap.on('click', e => {
                if (!tryAcceptPinCoords('edit', e.latlng.lat, e.latlng.lng)) return;
                if (editSelectionMarker) editSelectionMarker.setLatLng(e.latlng);
                else { editSelectionMarker = L.marker(e.latlng, { draggable: true }).addTo(editMap); wireMarkerDrag('edit', editSelectionMarker); }
            });
            document.getElementById('edit-manual-lat').addEventListener('change',
                () => onManualCoordChange('edit', editMap, () => editSelectionMarker, m => editSelectionMarker = m));
            document.getElementById('edit-manual-lng').addEventListener('change',
                () => onManualCoordChange('edit', editMap, () => editSelectionMarker, m => editSelectionMarker = m));
        } else {
            editMap.setView(h.coords, 16);
        }

        if (editSelectionMarker) editMap.removeLayer(editSelectionMarker);
        editSelectionMarker = L.marker(h.coords, { draggable: true }).addTo(editMap);
        wireMarkerDrag('edit', editSelectionMarker);
        editMap.invalidateSize();
    }, 250);
}

function closeEditListing() {
    document.getElementById('edit-listing-modal').style.display = 'none';
    editingHouseId = null;
    showCoordError('edit', false);
    document.getElementById('edit-proximity-warning').style.display = 'none';
}

function saveEditListing(e) {
    e.preventDefault();
    if (!editingHouseId) return;

    const lat = document.getElementById('edit-lat').value;
    const lng = document.getElementById('edit-lng').value;
    if(!lat || !lng || isNaN(lat) || isNaN(lng)) return alert("Please mark location on map.");
    const extras = readListingExtras('edit');
    const roomError = roomCapacityError(extras.roomCapacity, parseInt(document.getElementById('edit-total').value));
    if (roomError) return alert(roomError);

    const updateBtn = document.getElementById('update-property-btn');
    updateBtn.innerText = "Updating...";
    updateBtn.disabled = true;

    // Reload right before finding it, not just before saving -- and find
    // by id (not a cached index) since a concurrent edit in another tab
    // could change the array's length/order between this reload and the
    // async photo-compression branch below.
    reloadHouses();
    const h = houses.find(house => house.id === editingHouseId);
    if (!h) {
        alert("This listing no longer exists -- it may have been removed elsewhere.");
        updateBtn.innerText = "Update Property"; updateBtn.disabled = false;
        return;
    }
    h.name = document.getElementById('edit-name').value;
    h.location = document.getElementById('edit-loc').value;
    h.price = parseInt(document.getElementById('edit-price').value);
    h.total = parseInt(document.getElementById('edit-total').value);
    h.available = parseInt(document.getElementById('edit-available').value);
    h.coords = [parseFloat(lat), parseFloat(lng)];
    Object.assign(h, extras);

    const amenities = [];
    document.querySelectorAll('#edit-listing-modal .amenities-toggle-grid input:checked').forEach(c => amenities.push(c.value));
    h.amenities = amenities;

    const fileInput = document.getElementById('edit-street-photo');

    const finalizeEdit = () => {
        saveData(['houses']); renderAll(); closeEditListing(); document.getElementById('edit-listing-form').reset();
        updateBtn.innerText = "Update Property"; updateBtn.disabled = false;
    };

    if (fileInput.files && fileInput.files.length > 0) {
        updateBtn.innerText = "Compressing New Photos...";
        let compressPromises = [];
        let fileCount = Math.min(fileInput.files.length, 3);
        for(let i = 0; i < fileCount; i++) { compressPromises.push(resizeAndCompress(fileInput.files[i])); }
        Promise.all(compressPromises).then(results => { h.streetPhotos = results; finalizeEdit(); });
    } else {
        finalizeEdit();
    }
}
/* =====================================================================
   MODULE 4 : RATINGS & REVIEWS
   Students rate a property once. Submissions enter a moderation queue
   and only surface publicly after an administrator approves them, so a
   single malicious post cannot damage a landowner's listing instantly.

   That pre-publication gate doesn't catch everything — a review can
   pass moderation and only later turn out to be fake or in bad faith.
   The second safety net is post-publication reporting: any student can
   flag an already-published review as not made in good faith, a
   landowner can flag reviews on their own listings, and an admin
   triages flagged reviews in admin.html's Reported Reviews tab (remove
   the review, or dismiss the report). A reported review stays visible
   while under review — reporting never hides it unilaterally.
   ===================================================================== */

let pendingStarValue = 0;

function getRatingStats(propertyId) {
    const approved = reviews.filter(r => r.propertyId === propertyId && r.status === 'approved');
    if (approved.length === 0) return { count: 0, avg: null };
    const sum = approved.reduce((acc, r) => acc + r.rating, 0);
    return { count: approved.length, avg: +(sum / approved.length).toFixed(1) };
}

// Same shape as getRatingStats() above, but averaged across every listing
// a given owner name has, for the landowner profile modal.
function getLandownerRatingStats(ownerName) {
    const propertyIds = houses.filter(h => h.owner === ownerName).map(h => h.id);
    const approved = reviews.filter(r => propertyIds.includes(r.propertyId) && r.status === 'approved');
    if (approved.length === 0) return { count: 0, avg: null };
    const sum = approved.reduce((acc, r) => acc + r.rating, 0);
    return { count: approved.length, avg: +(sum / approved.length).toFixed(1) };
}

/* Median time between a student's first message in a thread and the
   landowner's first reply, across every thread that landowner has. Only
   meaningful for the one real landowner account: openChatForProperty()
   always routes every conversation's landownerId to
   ROLE_IDENTITY.landowner.id regardless of a listing's own (often
   flavor-text) owner field, so this is the only id that can ever appear
   as a conversation's landownerId (see that function's comment). Safe to
   take history.find() for "first of each role" rather than comparing
   timestamps for ordering: every conversation is created with an empty
   history by openChatForProperty(), which is reachable only from the
   student-facing "Chat with Owner" button, so history[0] is always the
   student's message -- the first landowner-authored entry that ever
   appears is therefore always the reply, never a reply to a LATER
   student message. Returns null (not enough data) when no thread has a
   reply yet -- caller shows nothing rather than a zero/placeholder. */
function getLandownerResponseTimeMs(landownerId) {
    const diffs = [];
    conversations.filter(c => c.landownerId === landownerId).forEach(c => {
        const firstStudentMsg = c.history.find(m => m.role === 'student');
        const firstReply = c.history.find(m => m.role === 'landowner');
        if (!firstStudentMsg || !firstReply) return;
        diffs.push(new Date(firstReply.at).getTime() - new Date(firstStudentMsg.at).getTime());
    });
    if (diffs.length === 0) return null;
    diffs.sort((a, b) => a - b);
    const mid = Math.floor(diffs.length / 2);
    return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
}

// Display-only formatter for getLandownerResponseTimeMs()'s result.
function formatResponseTime(ms) {
    const minutes = ms / 60000;
    if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
    const hours = minutes / 60;
    if (hours < 48) return `${Math.round(hours)} hr`;
    return `${Math.round(hours / 24)} days`;
}

/* Initials-avatar helper: a colored circle with a person's initials,
   color seeded deterministically from their account id (or, for a
   flavor-text listing owner with no real account, the name itself --
   see the landowner profile modal's caller). Stands in for a real photo
   -- no upload flow exists for one, and adding one would introduce a new
   personal-data field with its own retention question for no requested
   benefit. Duplicated in admin.js per this codebase's existing
   duplication-over-shared-module convention (see escapeHtml/renderStars). */
const AVATAR_PALETTE = ['#9B72FF', '#008489', '#FFB400', '#28a745', '#3B82F6', '#b02a37'];
function initialsFromName(name) {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    return parts.length === 1
        ? parts[0][0].toUpperCase()
        : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function avatarColorForId(id) {
    let hash = 0;
    const str = String(id ?? '');
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}
function initialsAvatarHtml(name, id, sizePx = 44) {
    return `<span class="initials-avatar" style="width:${sizePx}px; height:${sizePx}px; ` +
        `font-size:${Math.round(sizePx * 0.4)}px; background:${avatarColorForId(id)};">` +
        `${escapeHtml(initialsFromName(name))}</span>`;
}

/* ---- LANDOWNER PROFILE MODAL ----
   Reachable from any listing (card grid + details page -- see their
   wiring). A plain modal, not a hideAllViews()-managed view: it's opened
   from several different places with no natural "back to" origin to
   track, and modals already just close back to whatever's underneath.

   ownerName is a house's free-text `owner` field, not an id -- most
   listings in this demo (the three seeded ones) belong to flavor-text
   owners with no real account behind them at all (see defaultHouses).
   The modal degrades gracefully for those: name/avatar/tier/listings/
   rating all work off the owner name alone, but "member since" and
   "response time" only render for the one real account, since those
   would otherwise be fabricated for a name nobody actually signed up
   as. */
function openLandownerProfile(ownerName) {
    renderLandownerProfileModal(ownerName);
    document.getElementById('landowner-profile-modal').style.display = 'block';
}
function closeLandownerProfileModal() {
    document.getElementById('landowner-profile-modal').style.display = 'none';
}

/* "My Profile" header link -- opens the SAME modal a viewer would see,
   just for the signed-in user's own role, with isSelf:true adding the
   self-only extras (Edit button, and a link to the verification upload
   each role would otherwise have to go hunting for). Reuses the read-
   only render functions rather than a separate view, so "the profile as
   others see it" is literally the same code path, not a lookalike. */
function openMyProfile() {
    if (!currentUser) return;
    if (selectedRole === 'landowner') {
        renderLandownerProfileModal(ROLE_IDENTITY.landowner.name, { isSelf: true });
        document.getElementById('landowner-profile-modal').style.display = 'block';
    } else {
        renderStudentProfileModal(ROLE_IDENTITY.student.id, { isSelf: true });
        document.getElementById('student-profile-modal').style.display = 'block';
    }
}

function renderLandownerProfileModal(ownerName, opts = {}) {
    const isRealAccount = ownerName === ROLE_IDENTITY.landowner.name;
    const isSelf = !!opts.isSelf && isRealAccount;
    const listings = houses.filter(h => h.owner === ownerName && h.status === 'approved');
    const tier = listings[0]?.verificationTier;
    const ratingStats = getLandownerRatingStats(ownerName);
    const responseMs = isRealAccount ? getLandownerResponseTimeMs(ROLE_IDENTITY.landowner.id) : null;

    const memberSinceRow = isRealAccount && landownerProfile.memberSince
        ? `<p class="mod-meta">Member since ${new Date(landownerProfile.memberSince).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}</p>`
        : '';
    // The "About" bio is a public part of the profile (shown to anyone
    // viewing it, not just self) -- only the real account can ever have
    // one set (flavor-text listing owners have no sign-up to have set it).
    const aboutRow = isRealAccount && landownerProfile.about
        ? `<p class="mod-meta">${escapeHtml(landownerProfile.about)}</p>` : '';
    const responseRow = responseMs !== null
        ? `<p class="mod-meta">Typical response time: ${formatResponseTime(responseMs)}</p>` : '';
    const ratingRow = ratingStats.count > 0
        ? `<p class="mod-meta">${renderStars(ratingStats.avg)}
             <span class="card-rating-num">${ratingStats.avg.toFixed(1)}</span>
             <span class="card-rating-count">(${ratingStats.count} review${ratingStats.count === 1 ? '' : 's'})</span></p>`
        : `<p class="mod-meta card-rating-none">No reviews yet</p>`;

    const listingRows = listings.length === 0
        ? `<p class="mod-meta">No active listings.</p>`
        : listings.map(h => `
            <div class="mod-card" style="padding:16px 20px;">
                <div class="mod-body">
                    <h4 style="font-size:16px;">${escapeHtml(h.name)}</h4>
                    <p class="mod-meta">📍 ${escapeHtml(h.location)} &nbsp;·&nbsp; ₱${h.price}/month</p>
                </div>
            </div>`).join('');

    // Self-only actions: tier is already shown above (memberSinceRow et
    // al already read from the real account's own state), so this just
    // adds editing and a shortcut to wherever ID verification lives --
    // "since that's where they'd look for it," not duplicated in-modal.
    const selfActions = isSelf ? `
        <div class="mod-actions" style="margin-top:16px;">
            <button class="btn-approve" onclick="renderMyLandownerProfileEdit()">Edit Profile</button>
            <button class="btn-primary" onclick="goToLandownerVerification()">Manage ID Verification</button>
        </div>` : '';

    document.getElementById('landowner-profile-body').innerHTML = `
        <div style="display:flex; align-items:center; gap:16px; margin-bottom:14px;">
            ${initialsAvatarHtml(ownerName, isRealAccount ? ROLE_IDENTITY.landowner.id : ownerName, 64)}
            <div>
                <h3 style="margin:0;">${escapeHtml(ownerName)}</h3>
                ${tierBadgeHtml(tier)}
            </div>
        </div>
        ${verificationBreakdownHtml(ownerName, tier)}
        ${memberSinceRow}
        ${aboutRow}
        ${ratingRow}
        ${responseRow}
        <h4 style="margin:20px 0 10px;">Listings</h4>
        ${listingRows}
        ${selfActions}`;
}

/* Swaps the modal body to an edit form for the real landowner account's
   own profile -- only reachable via the isSelf actions above. Cancel
   just re-renders the read-only view rather than tracking separate
   "was editing" state. */
function renderMyLandownerProfileEdit() {
    document.getElementById('landowner-profile-body').innerHTML = `
        <h3 style="margin-bottom:14px;">Edit Profile</h3>
        <label style="display:block; font-size:13px; color:#666; margin-bottom:6px;">About (optional)</label>
        <textarea id="myprofile-edit-about" placeholder="A short line about yourself"
            style="width:100%; padding:16px; border:1px solid #ddd; border-radius:10px; min-height:90px; font-family:inherit; font-size:15px; resize:vertical; margin-bottom:20px;">${escapeHtml(landownerProfile.about || '')}</textarea>
        <div class="mod-actions">
            <button class="btn-approve" onclick="saveMyLandownerProfile()">Save</button>
            <button class="btn-reject" onclick="renderLandownerProfileModal(ROLE_IDENTITY.landowner.name, { isSelf: true })">Cancel</button>
        </div>`;
}
function saveMyLandownerProfile() {
    const about = document.getElementById('myprofile-edit-about').value.trim();
    reloadLandownerProfile(); // don't stomp a concurrent admin verification-tier change
    landownerProfile.about = about;
    saveData(['landownerProfile']);
    renderLandownerProfileModal(ROLE_IDENTITY.landowner.name, { isSelf: true });
}

// Closes the profile modal and scrolls the landowner's own dashboard to
// the verification section -- see its id in index.html.
function goToLandownerVerification() {
    closeLandownerProfileModal();
    goHome();
    document.getElementById('landowner-verification-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---- STUDENT PROFILE MODAL ----
   Visible to a landowner only once that student has actually messaged
   them -- gated on a conversation existing between the two ids, checked
   at the moment the landowner clicks the student's name (the only
   student-initiated contact path in this app). Deliberately minimal to
   another viewer: name, school, verified badge -- no ID image, no
   student number, no contact details, per spec. The self view (opened
   via openMyProfile(), isSelf:true) additionally shows year level and
   the actual verification status/reason, since that's the student's own
   business to see even though it's never shown to a landowner. */
function openStudentProfile(studentId) {
    if (selectedRole !== 'landowner') return;
    const hasThread = conversations.some(c => c.studentId === studentId && c.landownerId === ROLE_IDENTITY.landowner.id);
    if (!hasThread) return;
    // Reload for freshness -- the student may have just removed their
    // photo, or an admin just approved it, in another tab -- then log the
    // view, but only when the image actually qualifies to be shown (see
    // renderStudentProfileModal()'s matching gate below); no point logging
    // "viewed" when there was nothing to see.
    reloadStudentVerificationDocs();
    const idDoc = studentVerificationDocs.find(d => d.user_id === studentId && d.document_type === 'school_id');
    if (idDoc?.status === 'approved' && idDoc.file_path) {
        logAudit('student_document.viewed_by_landowner', 'student_verification_documents', idDoc.id,
            `School ID viewed by ${ROLE_IDENTITY.landowner.name} (landowner)`);
        saveData(['auditLogs']);
    }
    renderStudentProfileModal(studentId);
    document.getElementById('student-profile-modal').style.display = 'block';
}
function closeStudentProfileModal() {
    document.getElementById('student-profile-modal').style.display = 'none';
}
function renderStudentProfileModal(studentId, opts = {}) {
    const isSelf = !!opts.isSelf && studentId === ROLE_IDENTITY.student.id;
    const name = studentId === ROLE_IDENTITY.student.id ? ROLE_IDENTITY.student.name : studentId;
    const verifiedBadge = isStudentVerified()
        ? `<span class="tier-badge tier-student-verified">Student Verified</span>` : '';

    // Shown to any viewer (landowner or self), same as School below --
    // year level isn't sensitive the way the ID document/number are, and
    // a landowner seeing it was the actual point of asking for it at
    // sign-up.
    const yearLevelRow = studentProfile.yearLevel
        ? `<p class="mod-meta">${escapeHtml(studentProfile.yearLevel)}</p>` : '';

    let verificationStatusRow = '';
    if (isSelf) {
        const doc = studentVerificationDocs.find(d => d.user_id === STUDENT_ID && d.document_type === 'school_id');
        const status = doc ? doc.status : 'none';
        const statusLabel = { none: 'Not submitted', pending: 'Pending Review', approved: 'Approved', rejected: 'Rejected' }[status];
        const reasonText = status === 'rejected' && doc.remarks ? ` — ${escapeHtml(doc.remarks)}` : '';
        verificationStatusRow = `<p class="mod-meta">School ID status: <strong>${statusLabel}</strong>${reasonText}</p>`;
    }

    // Per counsel's advice: a landowner who's messaged this student may see
    // the ID image itself, but only once it's actually approved -- a
    // pending or rejected doc shows no image (there's nothing verified to
    // back it yet). Never shown in the self view -- the student already
    // sees their own image in the upload panel (renderStudentVerificationSection()).
    const idDoc = studentVerificationDocs.find(d => d.user_id === studentId && d.document_type === 'school_id');
    const idImageRow = (!isSelf && idDoc?.status === 'approved' && idDoc.file_path)
        ? `<div style="margin-top:14px;">
             <p class="mod-meta" style="margin-bottom:6px;">School ID on file:</p>
             <img class="verification-thumb" style="max-width:220px;" src="${idDoc.file_path}" onclick="openImageModal('${idDoc.file_path}')">
           </div>`
        : '';

    const selfActions = isSelf ? `
        <div class="mod-actions" style="margin-top:16px;">
            <button class="btn-approve" onclick="renderMyStudentProfileEdit()">Edit Profile</button>
            <button class="btn-primary" onclick="renderMyStudentVerificationPanel()">Upload / Manage School ID</button>
        </div>` : '';

    // "Back to browsing" is a plain shortcut to the directory grid -- it's
    // only meaningful for the student's own profile (isSelf implies the
    // signed-in role is student, see openMyProfile()), not the read-only
    // view a landowner gets of a student they've messaged.
    const backToBrowsingBtn = isSelf
        ? `<button class="btn-primary" style="display:block; margin-bottom:16px;" onclick="closeStudentProfileModal(); goHome();">← Back to Browsing</button>`
        : '';

    document.getElementById('student-profile-body').innerHTML = `
        ${backToBrowsingBtn}
        <div style="display:flex; align-items:center; gap:16px; margin-bottom:14px;">
            ${initialsAvatarHtml(name, studentId, 64)}
            <div style="min-width:0;">
                <div class="name-badge-row">
                    <h3 style="margin:0;">${escapeHtml(name)}</h3>
                    ${verifiedBadge}
                </div>
            </div>
        </div>
        <p class="mod-meta">School: ${escapeHtml(studentProfile.school || 'Not specified')}</p>
        ${yearLevelRow}
        ${verificationStatusRow}
        ${idImageRow}
        ${selfActions}`;
}

/* Swaps the modal body to the school-ID upload/status panel -- this is
   now the ONLY place that panel lives (it used to also sit inline on the
   student directory page, which is a browsing view and shouldn't carry
   account/verification chrome). Back re-renders the profile view rather
   than tracking separate "was editing" state, same convention as the
   Edit Profile swap above.

   The notice + consent checkbox live here, as a SIBLING of
   #student-verification-cards, not inside it -- renderStudentVerificationSection()
   only ever replaces that inner container's innerHTML (e.g. right after an
   upload, or from the cross-tab storage-event listener), so a background
   re-render can never silently reset a tick the student is mid-way through
   making here. A fresh call to THIS function (on entering the panel, or
   after a successful upload/removal) is what resets the checkbox --
   deliberately, since every upload needs fresh, explicit consent, not just
   the first. */
function renderMyStudentVerificationPanel() {
    document.getElementById('student-profile-body').innerHTML = `
        <button class="btn-primary" style="display:block; margin-bottom:16px;" onclick="renderStudentProfileModal(ROLE_IDENTITY.student.id, { isSelf: true })">← Back to Profile</button>
        <h3 style="margin-bottom:14px;">School ID Verification</h3>
        <p style="color:#666; font-size:14px; margin-bottom:16px;">
            Submit a valid school ID to show as Student Verified to landowners you message.
        </p>
        <div style="background:#F8F6FF; border:1px solid #E0D5FF; border-radius:12px; padding:18px 20px; margin-bottom:20px;">
            <h4 style="font-size:15px; margin-bottom:10px;">Before you upload</h4>
            <ul style="margin:0 0 14px 18px; padding:0; font-size:13px; color:#555; line-height:1.6;">
                <li><strong>What's collected:</strong> a photo of your school ID.</li>
                <li><strong>Why:</strong> for an administrator to verify you're a student; so landowners you've messaged can see it; and to help resolve complaints involving you.</li>
                <li><strong>Who can see it:</strong> administrators, and landowners you've sent a message to.</li>
                <li><strong>How long it's kept:</strong> if approved, for as long as you keep it on your account; if rejected, for 7 days, then deleted.</li>
                <li>You can remove it from My Profile at any time.</li>
            </ul>
            <label style="display:flex; align-items:flex-start; gap:10px; font-size:13px; color:#333; cursor:pointer;">
                <input type="checkbox" id="student-id-consent-checkbox" onchange="updateStudentIdConsentGate()" style="margin-top:2px;">
                I have read this notice and consent to my school ID being collected and shared as described.
            </label>
        </div>
        <div id="student-verification-cards" class="verification-grid"></div>`;
    renderStudentVerificationSection();
}

// Disable-until-checked, same pattern admin's document-review checklist
// gate (updateDocReviewGate()/updateStudentDocReviewGate() in admin.js)
// uses for its radio groups -- here it's one checkbox gating one input.
// Only a UX nicety, not the real guard: uploadStudentVerificationDoc()
// re-checks the box itself before actually accepting a file.
function updateStudentIdConsentGate() {
    const checked = document.getElementById('student-id-consent-checkbox')?.checked;
    const input = document.getElementById('student-id-file-input');
    if (input) input.disabled = !checked;
}

function renderMyStudentProfileEdit() {
    document.getElementById('student-profile-body').innerHTML = `
        <h3 style="margin-bottom:14px;">Edit Profile</h3>
        <label style="display:block; font-size:13px; color:#666; margin-bottom:6px;">School</label>
        <select id="myprofile-edit-school" style="margin-bottom:12px;"></select>
        <input type="text" id="myprofile-edit-school-other" placeholder="Enter your school" style="display:none; margin-bottom:12px;">
        <label style="display:block; font-size:13px; color:#666; margin-bottom:6px;">Year Level</label>
        <select id="myprofile-edit-year-level" style="margin-bottom:20px;"></select>
        <div class="mod-actions">
            <button class="btn-approve" onclick="saveMyStudentProfile()">Save</button>
            <button class="btn-reject" onclick="renderStudentProfileModal(ROLE_IDENTITY.student.id, { isSelf: true })">Cancel</button>
        </div>`;
    wireSchoolSelectOther(document.getElementById('myprofile-edit-school'), document.getElementById('myprofile-edit-school-other'), studentProfile.school || '');
    populateYearLevelSelect(document.getElementById('myprofile-edit-year-level'), studentProfile.yearLevel || '');
}
function saveMyStudentProfile() {
    const school = readSchoolSelectValue(document.getElementById('myprofile-edit-school'), document.getElementById('myprofile-edit-school-other'));
    const yearLevel = document.getElementById('myprofile-edit-year-level').value;
    reloadStudentProfile();
    studentProfile.school = school;
    studentProfile.yearLevel = yearLevel;
    saveData(['studentProfile']);
    renderAll();
    renderStudentProfileModal(ROLE_IDENTITY.student.id, { isSelf: true });
}

function renderStars(value) {
    const rounded = Math.round(value);
    let out = '';
    for (let i = 1; i <= 5; i++) {
        out += `<span class="star ${i <= rounded ? 'star-on' : 'star-off'}">★</span>`;
    }
    return out;
}

function hasAlreadyReviewed(propertyId) {
    return reviews.some(r => r.propertyId === propertyId && r.studentId === currentUser?.id);
}

function openReviewModal() {
    if (!currentPropertyId) return;
    if (!requireAccount('review')) return;
    const h = houses.find(x => x.id === currentPropertyId);
    document.getElementById('review-prop-name').innerText = h ? h.name : '';
    pendingStarValue = 0;
    setStar(0);
    document.getElementById('review-comment').value = '';
    document.getElementById('review-modal').style.display = 'block';
}

function closeReviewModal() { document.getElementById('review-modal').style.display = 'none'; }

const STAR_WORDS = ['Tap a star to rate', 'Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];

function setStar(val) {
    pendingStarValue = val;
    document.querySelectorAll('#star-picker .star-choice').forEach(el => {
        el.classList.toggle('picked', parseInt(el.dataset.val) <= val);
    });
    document.getElementById('star-label').innerText = STAR_WORDS[val];
}

function submitReview(e) {
    e.preventDefault();
    if (pendingStarValue < 1) return alert("Please select a star rating first.");
    reloadReviews(); // fresh before the duplicate check too, not just the push
    if (hasAlreadyReviewed(currentPropertyId)) {
        return alert("You have already reviewed this property.");
    }

    reviews.push({
        id: Date.now(),
        propertyId: currentPropertyId,
        studentId: currentUser.id,
        studentName: currentUser.name,
        rating: pendingStarValue,
        comment: document.getElementById('review-comment').value.trim(),
        status: 'pending',
        createdAt: new Date().toISOString(),
        moderatedBy: null
    });

    logAudit('review.submitted', 'reviews', currentPropertyId,
             `${pendingStarValue}-star review awaiting moderation`);
    saveData(['reviews', 'auditLogs']);
    closeReviewModal();
    renderReviews(currentPropertyId);
    alert("Thank you. Your review has been sent to an administrator for checking.");
}

/* Numbered prompt() for the reason, matching every other "give a
   reason" flow already in this app (rejectProperty/rejectDocument in
   admin.js) rather than introducing a new modal for just this one
   feature. Available to any signed-in student on any review, and to
   the landowner who owns the property the review is on — enforced
   again here (not just in the button's visibility) since a button
   being hidden doesn't stop someone calling this directly. */
function reportReview(reviewId) {
    const review = reviews.find(r => r.id === reviewId);
    if (!review || !currentUser) return;
    if (review.status !== 'approved') return; // nothing published yet to report

    const h = houses.find(x => x.id === review.propertyId);
    const allowed = currentUser.role === 'student' ||
        (currentUser.role === 'landowner' && h?.owner === 'Ana Ramos');
    if (!allowed) return;

    reloadReviewReports();
    const already = reviewReports.some(rep =>
        rep.reviewId === reviewId && rep.reporterId === currentUser.id && rep.status === 'open');
    if (already) return alert("You've already reported this review — an administrator will look into it.");

    const choice = prompt(
        "Report this review as not made in good faith. Choose a reason:\n" +
        REPORT_REASONS.map((r, i) => `${i + 1}) ${r}`).join('\n') +
        "\n\nEnter a number:"
    );
    if (choice === null) return;
    const idx = parseInt(choice, 10) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= REPORT_REASONS.length) {
        return alert("Please enter a valid number from the list.");
    }

    reviewReports.push({
        id: Date.now(),
        reviewId,
        propertyId: review.propertyId,
        reporterRole: currentUser.role,
        reporterId: currentUser.id,
        reporterName: currentUser.name,
        reason: REPORT_REASONS[idx],
        createdAt: new Date().toISOString(),
        status: 'open'
    });

    logAudit('review.reported', 'reviews', reviewId,
        `${REPORT_REASONS[idx]} — reported by ${currentUser.name} (${currentUser.role})`);
    saveData(['reviewReports', 'auditLogs']);
    alert("Thanks — this review has been flagged for an administrator. It stays visible while under review.");
}

function renderReviews(propertyId) {
    const summary = document.getElementById('rating-summary');
    const list = document.getElementById('reviews-list');
    const btn = document.getElementById('write-review-btn');
    if (!summary || !list) return;

    const h = houses.find(x => x.id === propertyId);
    const stats = getRatingStats(propertyId);

    summary.innerHTML = stats.count === 0
        ? `<p class="no-reviews">No reviews yet — be the first to rate this property.</p>`
        : `<div class="rating-score">${stats.avg.toFixed(1)}</div>
           <div>
               <div class="rating-stars">${renderStars(stats.avg)}</div>
               <div class="rating-count">Based on ${stats.count} verified review${stats.count === 1 ? '' : 's'}</div>
           </div>`;

    // Only students review, and only once per property.
    if (btn) {
        // Guests see it too, relabelled -- tapping it asks them to sign in
        // (see requireAccount()).
        const guest = isGuest();
        const eligible = guest || (currentUser?.role === 'student' && !hasAlreadyReviewed(propertyId));
        btn.innerText = guest ? 'Sign in to review' : 'Write a Review';
        btn.style.display = eligible ? 'inline-block' : 'none';
    }

    // Report is available to any signed-in student (on any review, not
    // just ones they didn't write), and to the landowner who owns this
    // specific property — mirrored inside reportReview() itself since a
    // hidden button is only a UI nicety, not enforcement.
    const canReport = currentUser?.role === 'student' ||
        (currentUser?.role === 'landowner' && h?.owner === 'Ana Ramos');

    const visible = reviews
        .filter(r => r.propertyId === propertyId && r.status === 'approved')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    list.innerHTML = visible.map(r => `
        <div class="review-card">
            <div class="review-top">
                <strong>${escapeHtml(r.studentName)}</strong>
                <span class="review-date">${new Date(r.createdAt).toLocaleDateString()}</span>
            </div>
            <div class="rating-stars small">${renderStars(r.rating)}</div>
            ${r.comment ? `<p class="review-body">${escapeHtml(r.comment)}</p>` : ''}
            ${canReport ? `<button class="report-review-btn" onclick="reportReview(${r.id})">🚩 Report</button>` : ''}
        </div>`).join('');

    // A student's own pending review is shown back to them only.
    const mine = reviews.find(r => r.propertyId === propertyId &&
                                   r.studentId === currentUser?.id &&
                                   r.status === 'pending');
    if (mine) {
        list.innerHTML += `<div class="review-card pending-own">
            <div class="review-top"><strong>Your review</strong>
            <span class="pill pill-pending">Awaiting moderation</span></div>
            <div class="rating-stars small">${renderStars(mine.rating)}</div>
            ${mine.comment ? `<p class="review-body">${escapeHtml(mine.comment)}</p>` : ''}
        </div>`;
    }
}

/* Reviews are free text rendered into innerHTML — escape before display
   so a comment containing markup cannot inject script. */
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}


/* The administrator console itself now lives in its own site
   (admin.html + admin.js), which reads/writes the same eboard_v12 /
   eboard_reviews_v13 / eboard_profile_v12 / eboard_audit_v13
   localStorage keys. logAudit() stays here too — the student-side
   submitReview() above still logs to the shared audit trail when a
   review enters moderation, so both sites append to eboard_audit_v13. */
function logAudit(action, entityType, entityId, label) {
    reloadAuditLogs(); // don't unshift onto a stale copy and lose the other app's entries on the next save
    auditLogs.unshift({
        id: Date.now() + Math.random(),
        userId: currentUser?.id || null,
        userName: currentUser?.name || 'System',
        action, entityType, entityId,
        label: label || '',
        createdAt: new Date().toISOString()
    });
    if (auditLogs.length > 300) auditLogs.length = 300;  // keep storage bounded
}

/* directions.html's "Back to directory" link points here with
   ?property=<id> so the user lands back on the exact listing they were
   routing from, not the grid. Only fires for a signed-in student (the
   only role directions.html is reachable from), and only after
   restoreSession() has already run enterApp() -> renderAll(), since
   openDetails() needs the rendered/sorted `houses` state to be current.
   The param is stripped via history.replaceState so an F5 afterwards
   reopens on the grid instead of silently re-triggering this. */
function openPropertyFromQueryParam() {
    if (selectedRole !== 'student') return; // signed-in student or guest
    const params = new URLSearchParams(location.search);
    if (!params.has('property')) return;

    const propertyId = Number(params.get('property'));
    if (houses.some(h => h.id === propertyId)) openDetails(propertyId);

    const url = new URL(location.href);
    url.searchParams.delete('property');
    history.replaceState(null, '', url);
}

/* Fires in every OTHER tab/window on this origin when localStorage
   changes here -- never in the tab that made the change. Without this,
   a tab only picks up another tab's writes the next time IT happens to
   mutate something, and until then its own view keeps showing whatever
   was true when this tab last loaded or last wrote -- the messaging bug
   this generalizes from. This matters most for index.html open next to
   admin.html: a landowner adding a listing or uploading an ID while an
   admin approves/rejects something should show up here live, not only
   after this tab's next unrelated save. Reloads just the key that
   changed, then re-renders whatever's currently visible that depends on
   it -- renderAll() is safe to call regardless of which view is active
   (guarded on its own DOM lookups), and mirrors loadRoadNetwork()'s
   existing "also refresh an open details page" pattern above. */
window.addEventListener('storage', (e) => {
    if (!currentUser && !isGuest()) return; // a guest still gets live listing updates
    switch (e.key) {
        case CONVERSATIONS_KEY:
            reloadConversations();
            updateMessageBadge();
            if (document.getElementById('messages-view').style.display === 'block') renderInbox();
            break;
        case 'eboard_v12': // houses
            reloadHouses();
            renderAll();
            if (currentPropertyId && document.getElementById('details-view').style.display === 'block') {
                openDetails(currentPropertyId);
            }
            break;
        case VERIFICATION_KEY:
            reloadVerificationDocs();
            renderAll();
            break;
        case SITE_VERIFICATION_KEY:
            reloadSiteVerifications();
            renderAll();
            break;
        case 'eboard_profile_v12': // landownerProfile
            reloadLandownerProfile();
            renderAll();
            break;
        case 'eboard_reviews_v13':
            reloadReviews();
            if (document.getElementById('details-view').style.display === 'block') renderReviews(currentPropertyId);
            break;
        case REVIEW_REPORTS_KEY:
            reloadReviewReports();
            break;
        case 'eboard_audit_v13':
            reloadAuditLogs();
            break;
        case STUDENT_VERIFICATION_KEY:
            reloadStudentVerificationDocs();
            if (document.getElementById('messages-view').style.display === 'block') renderInbox();
            break;
        case STUDENT_PROFILE_KEY:
            reloadStudentProfile();
            if (document.getElementById('messages-view').style.display === 'block') renderInbox();
            break;
    }
});

// ---- INIT ----
populateSchoolDropdown();
renderRulesFieldset('add');
renderRulesFieldset('edit');
restoreSession();
openPropertyFromQueryParam();
