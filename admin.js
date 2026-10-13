/* ============================================================
   E-BOARD ADMIN CONSOLE — standalone.

   Not part of the student/landowner SPA (index.html + script.js).
   Reads and writes the same localStorage keys that site uses, so
   an approval made here shows up there and vice versa. It does NOT
   share any JS with script.js — everything this page needs is
   duplicated below, on purpose, so the two sites can be read and
   explained independently.
   ============================================================ */

const DEMO_ADMIN = { email: 'admin@eboard.ph', password: 'eboard2026', name: 'System Admin' };
const ADMIN_SESSION_KEY = 'eboard_admin_session';

/* Same shape/keys as script.js's copy — see its comment for why:
   mirrors the planned verification_documents table so the eventual
   Laravel migration is a direct mapping. One record per
   (user_id, document_type). file_path is retained only until a decision
   is recorded (see the review-modal flow below and
   purgeExpiredRejectedDocs()) — identity documents are sensitive
   personal data under RA 10173, and the useful artifact after review is
   the decision, not the file. file_hash (SHA-256 of the original
   upload, computed in script.js at upload time) survives the deletion
   so a specific document can still be proven to be the one reviewed.

   v17 (bumped from v16): per adviser decision, business permit and
   proof-of-ownership documents were dropped -- government ID only. See
   script.js's copy of this comment for why this is a clean key bump
   rather than a migration of the old records. */
const VERIFICATION_KEY = 'eboard_verification_v17';

// Mirrors script.js's copy exactly.
const REJECTED_DOC_RETENTION_DAYS = 7;

// One record per user, confirms a physical site visit -- the one thing
// no remote document check can establish.
const SITE_VERIFICATION_KEY = 'eboard_site_verification_v17';

const LANDOWNER_ID = 'own-1';
const DOCUMENT_TYPES = [
    { key: 'government_id', label: 'Valid Government ID' }
];

/* Display data for the "Landowner Accounts" tab's card list -- NOT an
   account/auth registry, and adding to it doesn't change how identities
   work (that's still ROLE_IDENTITY.landowner in script.js, one hardcoded
   id/slot). This exists purely so the tab renders by iterating over
   landowners instead of hardcoding one card. Exactly one entry today,
   matching LANDOWNER_ID; a second real landowner slot would still need
   changes well beyond this array (currentUser is a single hardcoded
   'own-1' throughout script.js, landownerProfile is a singleton, house
   ownership is matched by exact name string) -- out of scope here.

   name doubles as both the displayed name and the exact string a
   house's `owner` field is matched against -- same single value
   ROLE_IDENTITY.landowner.name holds in script.js. Both used to read
   "<name>Landowner" (the role label had been concatenated onto the
   name by mistake); now both agree on the plain name. See the migration in
   the houses-loading block below for already-saved data that still has
   the old string. */
const LANDOWNERS = [
    { id: LANDOWNER_ID, name: 'Ana Ramos' }
];

const STUDENT_ID = 'stu-1';
const STUDENT_DOCUMENT_TYPES = [
    { key: 'school_id', label: 'Valid School ID' }
];

// Mirrors script.js's copy exactly -- see its comment there for why this
// is a separate key/array from VERIFICATION_KEY rather than a shared one
// (the review checklists differ in content) and its own version track
// rather than a bump of anything existing.
const STUDENT_VERIFICATION_KEY = 'eboard_student_verification_v1';
const STUDENT_PROFILE_KEY = 'eboard_student_profile_v1';

// Same "display data only, not an account registry" caveat as LANDOWNERS
// above -- see its comment. One entry today, matching STUDENT_ID/
// ROLE_IDENTITY.student in script.js.
const STUDENTS = [
    { id: STUDENT_ID, name: 'Paolo Cruz' }
];

// Same key script.js's copy of this data writes to — one row per
// report, not nested inside the review it's about.
const REVIEW_REPORTS_KEY = 'eboard_review_reports_v15';

/* Loaded fresh on every page load (including a manual refresh), which
   is exactly the "re-read localStorage" behavior we need: the
   directory tab may have approved/added something since this page was
   last open. Fallbacks are empty, not demo data — seeding the demo
   dataset is index.html/script.js's job; this page only ever reflects
   what the directory has actually saved. */
let houses = JSON.parse(localStorage.getItem('eboard_v12')) || [];
let reviews = JSON.parse(localStorage.getItem('eboard_reviews_v13')) || [];
let landownerProfile = JSON.parse(localStorage.getItem('eboard_profile_v12')) || { verificationTier: 'UNVERIFIED' };
let auditLogs = JSON.parse(localStorage.getItem('eboard_audit_v13')) || [];
let verificationDocs = JSON.parse(localStorage.getItem(VERIFICATION_KEY)) || [];
let siteVerifications = JSON.parse(localStorage.getItem(SITE_VERIFICATION_KEY)) || [];
let reviewReports = JSON.parse(localStorage.getItem(REVIEW_REPORTS_KEY)) || [];
let studentVerificationDocs = JSON.parse(localStorage.getItem(STUDENT_VERIFICATION_KEY)) || [];
let studentProfile = JSON.parse(localStorage.getItem(STUDENT_PROFILE_KEY)) || { school: '' };

/* index.html/script.js can be open in another tab at the same time as
   this console -- a landowner adding a listing or uploading an ID while
   an admin approves/rejects something is exactly the case this guards
   against. saveAdminData() used to persist whatever was currently in
   memory for EVERY key on EVERY call, so an action here that only meant
   to change one key (e.g. approving a listing) could silently clobber
   an unrelated key the other tab had just changed (e.g. reverting a
   verification decision, or dropping a listing the other tab just
   added) -- see script.js's copy of this comment, which this mirrors.

   Each reload*() below re-reads ONE key fresh from localStorage; call
   the relevant one immediately before finding/mutating that key, not
   just before saveAdminData(). saveAdminData()'s `mutated` argument
   names the key(s) THIS call is responsible for persisting from memory
   -- every other key reloads fresh right before being written back. */
function reloadHouses() { houses = JSON.parse(localStorage.getItem('eboard_v12')) || houses; }
function reloadReviews() { reviews = JSON.parse(localStorage.getItem('eboard_reviews_v13')) || reviews; }
function reloadLandownerProfile() { landownerProfile = JSON.parse(localStorage.getItem('eboard_profile_v12')) || landownerProfile; }
function reloadAuditLogs() { auditLogs = JSON.parse(localStorage.getItem('eboard_audit_v13')) || auditLogs; }
function reloadVerificationDocs() { verificationDocs = JSON.parse(localStorage.getItem(VERIFICATION_KEY)) || verificationDocs; }
function reloadSiteVerifications() { siteVerifications = JSON.parse(localStorage.getItem(SITE_VERIFICATION_KEY)) || siteVerifications; }
function reloadReviewReports() { reviewReports = JSON.parse(localStorage.getItem(REVIEW_REPORTS_KEY)) || reviewReports; }
function reloadStudentVerificationDocs() { studentVerificationDocs = JSON.parse(localStorage.getItem(STUDENT_VERIFICATION_KEY)) || studentVerificationDocs; }
function reloadStudentProfile() { studentProfile = JSON.parse(localStorage.getItem(STUDENT_PROFILE_KEY)) || studentProfile; }

function saveAdminData(mutated = []) {
    const keep = new Set(mutated);
    if (!keep.has('houses'))                  reloadHouses();
    if (!keep.has('reviews'))                  reloadReviews();
    if (!keep.has('landownerProfile'))         reloadLandownerProfile();
    if (!keep.has('auditLogs'))                reloadAuditLogs();
    if (!keep.has('verificationDocs'))         reloadVerificationDocs();
    if (!keep.has('siteVerifications'))        reloadSiteVerifications();
    if (!keep.has('reviewReports'))            reloadReviewReports();
    if (!keep.has('studentVerificationDocs'))  reloadStudentVerificationDocs();
    if (!keep.has('studentProfile'))           reloadStudentProfile();

    localStorage.setItem('eboard_v12', JSON.stringify(houses));
    localStorage.setItem('eboard_reviews_v13', JSON.stringify(reviews));
    localStorage.setItem('eboard_profile_v12', JSON.stringify(landownerProfile));
    localStorage.setItem('eboard_audit_v13', JSON.stringify(auditLogs));
    localStorage.setItem(VERIFICATION_KEY, JSON.stringify(verificationDocs));
    localStorage.setItem(SITE_VERIFICATION_KEY, JSON.stringify(siteVerifications));
    localStorage.setItem(REVIEW_REPORTS_KEY, JSON.stringify(reviewReports));
    localStorage.setItem(STUDENT_VERIFICATION_KEY, JSON.stringify(studentVerificationDocs));
    localStorage.setItem(STUDENT_PROFILE_KEY, JSON.stringify(studentProfile));
}

/* Migration: normalizes any already-saved listing's owner field from
   the old concatenated "<name>Landowner" to the corrected name (see
   LANDOWNERS above) -- mirrors the same migration in script.js,
   including matching by suffix rather than the exact old string.
   Guarded, unlike script.js's unconditional post-migration save: houses
   defaults to [] here (see the comment above), and [] is truthy, so an
   unconditional save would write an empty array into eboard_v12 on a
   first-ever admin.html load before index.html has seeded anything --
   permanently suppressing index.html's `|| defaultHouses` fallback on
   its next load. Only save if there was actually something to fix. */
let houseDataMigrated = false;
houses.forEach(h => { if (h.owner?.endsWith('Landowner')) { h.owner = LANDOWNERS[0].name; houseDataMigrated = true; } });
// Same SITE_VERIFIED -> FULLY_VERIFIED swap as script.js's copy -- see its
// comment for why (old single-ladder tier replaced by two independent
// checks). Folded into the same guarded save as the owner-name migration
// above rather than a second unconditional one.
houses.forEach(h => { if (h.verificationTier === 'SITE_VERIFIED') { h.verificationTier = 'FULLY_VERIFIED'; houseDataMigrated = true; } });
if (houseDataMigrated) saveAdminData(['houses']);

/* Mirrors script.js's copy exactly -- see its comment for the reasoning
   (ID review and a site visit are two independent checks, not steps on
   one ladder). */
function computeVerificationTier(docs, siteVerifiedRecord) {
    const idDoc = docs.find(d => d.document_type === 'government_id');
    const idReviewed = idDoc?.status === 'approved';
    const siteVisited = !!siteVerifiedRecord;
    if (idReviewed && siteVisited) return 'FULLY_VERIFIED';
    if (siteVisited) return 'SITE_VISITED';
    if (idReviewed) return 'ID_VERIFIED';
    if (docs.length > 0) return 'DOCUMENTS_SUBMITTED';
    return 'UNVERIFIED';
}

/* Keeps h.verificationTier / landownerProfile.verificationTier — which
   the directory site's badge and card rendering already read — in sync
   with document decisions and site visits recorded here. */
function syncVerificationTier() {
    // Reload what this reads/writes right before doing either -- see
    // script.js's copy of this comment. verificationDocs/siteVerifications
    // are deliberately NOT reloaded here: every caller (submitDocDecision,
    // markSiteVerified, resetVerificationData) just mutated one of those
    // two in memory and hasn't saved yet, so reloading would wipe out
    // that in-progress change before it's ever persisted.
    reloadHouses();
    reloadLandownerProfile();
    const siteRecord = siteVerifications.find(v => v.user_id === LANDOWNER_ID);
    const tier = computeVerificationTier(verificationDocs.filter(d => d.user_id === LANDOWNER_ID), siteRecord);
    landownerProfile.verificationTier = tier;
    houses.forEach(h => { if (h.owner === 'Ana Ramos') h.verificationTier = tier; });
}

/* Client-only app, no server/cron -- purging a rejected document's file
   past its retention window happens lazily, on the next render of this
   console, rather than on a background timer. Mirrors script.js's copy;
   either app purges it, whichever is opened first after the window
   elapses. Approved documents are purged immediately at the moment of
   decision (see submitDocDecision below), not handled here.

   LIMITATION: this is a client-side approximation of a retention
   policy, not an enforced one -- the window has only elapsed once
   someone opens one of the two apps and this function runs. A document
   can sit past its 7 days, still fully present, if nobody loads a page
   in the meantime. A real backend would run this as a scheduled
   server-side job (e.g. a daily cron sweep), guaranteeing deletion on
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
    if (purged) saveAdminData(['verificationDocs', 'auditLogs']);
}

// Mirrors purgeExpiredRejectedDocs() exactly, operating on the separate
// student-documents array -- see STUDENT_VERIFICATION_KEY's comment above
// for why it's a separate array rather than a shared one.
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
    if (purged) saveAdminData(['studentVerificationDocs', 'auditLogs']);
}

/* ---------- image enlarge modal (duplicated from index.html/script.js) ---------- */
function openImageModal(src) {
    document.getElementById('image-view-modal').style.display = 'block';
    document.getElementById('expanded-img').src = src;
}
function closeImageModal() {
    document.getElementById('image-view-modal').style.display = 'none';
}

/* ---------- session (sessionStorage, so closing the tab signs out) ---------- */

function adminLogin(e) {
    e.preventDefault();
    const email = document.getElementById('admin-email').value.trim();
    const password = document.getElementById('admin-password').value;

    if (email !== DEMO_ADMIN.email || password !== DEMO_ADMIN.password) {
        document.getElementById('admin-login-error').style.display = 'block';
        return;
    }

    sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify({ name: DEMO_ADMIN.name, email }));
    showConsole();
}

function adminLogout() {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    location.reload();
}

function showConsole() {
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY));
    document.getElementById('admin-login-screen').style.display = 'none';
    document.getElementById('admin-console').style.display = 'block';
    document.getElementById('admin-display-name').innerText = session.name;
    renderAdmin();
}

/* ---------- shared helpers (duplicated from script.js) ---------- */

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function renderStars(value) {
    const rounded = Math.round(value);
    let out = '';
    for (let i = 1; i <= 5; i++) {
        out += `<span class="star ${i <= rounded ? 'star-on' : 'star-off'}">★</span>`;
    }
    return out;
}

function emptyState(msg) {
    return `<div class="empty-state">✓ ${msg}</div>`;
}

function logAudit(action, entityType, entityId, label) {
    reloadAuditLogs(); // don't unshift onto a stale copy and lose index.html's entries on the next save
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY));
    auditLogs.unshift({
        id: Date.now() + Math.random(),
        userId: 'adm-1',
        userName: session?.name || 'System',
        action, entityType, entityId,
        label: label || '',
        createdAt: new Date().toISOString()
    });
    if (auditLogs.length > 300) auditLogs.length = 300;  // keep storage bounded
}

/* =====================================================================
   ADMINISTRATOR CONSOLE
   Property verification, review moderation, landowner accounts, audit.
   Ported from script.js's Module 5 — same function names and DOM ids.
   ===================================================================== */

function switchAdminTab(tab, btn) {
    ['listings', 'reviews', 'reported', 'owners', 'students', 'audit'].forEach(t => {
        document.getElementById('admin-panel-' + t).style.display = (t === tab) ? 'block' : 'none';
    });
    document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

function renderAdmin() {
    purgeExpiredRejectedDocs();
    purgeExpiredRejectedStudentDocs();

    const pendingProps   = houses.filter(h => h.status === 'pending');
    const pendingReviews = reviews.filter(r => r.status === 'pending');
    const openReports    = reviewReports.filter(rep => rep.status === 'open');
    const liveProps      = houses.filter(h => h.status === 'approved');

    document.getElementById('adm-stat-listings').innerText = pendingProps.length;
    document.getElementById('adm-stat-reviews').innerText  = pendingReviews.length;
    document.getElementById('adm-stat-reported').innerText = openReports.length;
    const siteRecord = siteVerifications.find(v => v.user_id === LANDOWNER_ID);
    const ownerTier = computeVerificationTier(verificationDocs.filter(d => d.user_id === LANDOWNER_ID), siteRecord);
    // "Unverified" here specifically means identity unconfirmed -- only
    // ID_VERIFIED and FULLY_VERIFIED involve an approved ID review.
    // SITE_VISITED alone does NOT confirm identity (that's the whole
    // point of treating the two checks independently now -- see
    // computeVerificationTier()'s comment in script.js), so it counts as
    // unverified here even though it didn't under the old single ladder.
    document.getElementById('adm-stat-owners').innerText   = (ownerTier === 'ID_VERIFIED' || ownerTier === 'FULLY_VERIFIED') ? 0 : 1;
    document.getElementById('adm-stat-live').innerText     = liveProps.length;

    renderAdminListings(pendingProps);
    renderAdminReviews(pendingReviews);
    renderAdminReportedReviews(openReports);
    renderAdminOwners();
    renderAdminStudents();
    renderAuditLog();
}

function renderAdminListings(pending) {
    const panel = document.getElementById('admin-panel-listings');
    // Always shown, regardless of whether anything's pending -- listing
    // drift/duplicates from testing can happen with zero pending items.
    const resetControl = `
        <div class="mod-card" style="flex-direction:column; align-items:stretch;">
            <div class="mod-body">
                <h4>Reset Demo Data</h4>
                <p class="mod-meta">Clears every saved listing -- including stray test duplicates and any
                   coordinates edited since -- and reseeds the app's default three listings.</p>
            </div>
            <div class="mod-actions">
                <button class="btn-reject" onclick="resetListingsToSeed()">Reset Listings to Seed Data</button>
            </div>
        </div>`;
    if (pending.length === 0) {
        panel.innerHTML = resetControl + emptyState('No listings awaiting verification.');
        return;
    }
    panel.innerHTML = resetControl + pending.map(h => `
        <div class="mod-card">
            <div class="mod-body">
                <h4>${escapeHtml(h.name)}</h4>
                <p class="mod-meta">📍 ${escapeHtml(h.location)} &nbsp;·&nbsp; ₱${h.price}/month
                   &nbsp;·&nbsp; ${h.available} of ${h.total} rooms vacant</p>
                <p class="mod-meta">Owner: ${escapeHtml(h.owner || 'Unknown')}
                   &nbsp;·&nbsp; Coordinates: ${h.coords[0].toFixed(5)}, ${h.coords[1].toFixed(5)}</p>
            </div>
            <div class="mod-actions">
                <button class="btn-approve" onclick="approveProperty(${h.id})">Approve</button>
                <button class="btn-reject" onclick="rejectProperty(${h.id})">Reject</button>
            </div>
        </div>`).join('');
}

/* Demonstration utility for the thesis defense -- same rationale as
   resetVerificationData() below. Clears every property listing (stray
   test duplicates and drifted coordinates included -- see the
   streetview-coverage.js investigation this was written for: a
   hand-typed "seed" coordinate had drifted 300-550 m from what was
   actually saved) and hands off to index.html, which reseeds its own
   known-good default three listings on a fresh load, same as a
   brand-new browser profile would see.

   Deliberately does NOT call saveAdminData() -- that writes admin.js's
   in-memory `houses` (the very list being discarded) straight back to
   eboard_v12, undoing the removal below before the redirect even
   happens. Only the audit-log key is persisted directly instead, since
   that's the one piece of state this action should actually keep.

   Not a real admin capability: a production system would never let an
   admin unilaterally erase every landowner's listings with one click. */
function resetListingsToSeed() {
    if (!confirm(
        "Reset all property listings to the app's default seed data?\n\n" +
        "This permanently discards every listing currently saved -- including any " +
        "duplicates or coordinate edits made during testing -- and returns you to " +
        "index.html, which reseeds its own default three listings. This cannot be undone."
    )) return;

    logAudit('listings.reset', 'properties', 'all', 'All property listings cleared for reseed (demonstration utility)');
    localStorage.setItem('eboard_audit_v13', JSON.stringify(auditLogs));
    localStorage.removeItem('eboard_v12');
    location.href = 'index.html';
}

function approveProperty(id) {
    reloadHouses();
    const h = houses.find(x => x.id === id);
    if (!h) return;
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY));
    h.status = 'approved';
    h.approvedBy = session.name;
    h.approvedAt = new Date().toISOString();
    logAudit('property.approved', 'properties', id, h.name);
    saveAdminData(['houses', 'auditLogs']); renderAdmin();
}

function rejectProperty(id) {
    reloadHouses();
    const h = houses.find(x => x.id === id);
    if (!h) return;
    const reason = prompt(`Reason for rejecting "${h.name}":`);
    if (reason === null) return;
    h.status = 'rejected';
    h.rejectionReason = reason;
    logAudit('property.rejected', 'properties', id, `${h.name} — ${reason || 'no reason given'}`);
    saveAdminData(['houses', 'auditLogs']); renderAdmin();
}

function renderAdminReviews(pending) {
    const panel = document.getElementById('admin-panel-reviews');
    if (pending.length === 0) {
        panel.innerHTML = emptyState('No reviews awaiting moderation.');
        return;
    }
    panel.innerHTML = pending.map(r => {
        const h = houses.find(x => x.id === r.propertyId);
        return `
        <div class="mod-card">
            <div class="mod-body">
                <div class="rating-stars small">${renderStars(r.rating)}</div>
                <h4 style="margin-top:6px;">${escapeHtml(h ? h.name : 'Unknown property')}</h4>
                <p class="mod-meta">By ${escapeHtml(r.studentName)} ·
                   ${new Date(r.createdAt).toLocaleDateString()}</p>
                <p class="review-body">${escapeHtml(r.comment) || '<em>No written comment</em>'}</p>
            </div>
            <div class="mod-actions">
                <button class="btn-approve" onclick="approveReview(${r.id})">Publish</button>
                <button class="btn-reject" onclick="rejectReview(${r.id})">Reject</button>
            </div>
        </div>`;
    }).join('');
}

function approveReview(id) {
    reloadReviews();
    const r = reviews.find(x => x.id === id);
    if (!r) return;
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY));
    r.status = 'approved';
    r.moderatedBy = session.name;
    r.moderatedAt = new Date().toISOString();
    logAudit('review.approved', 'reviews', id, `${r.rating}-star by ${r.studentName}`);
    saveAdminData(['reviews', 'auditLogs']); renderAdmin();
}

function rejectReview(id) {
    reloadReviews();
    const r = reviews.find(x => x.id === id);
    if (!r) return;
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY));
    r.status = 'rejected';
    r.moderatedBy = session.name;
    r.moderatedAt = new Date().toISOString();
    logAudit('review.rejected', 'reviews', id, `${r.rating}-star by ${r.studentName}`);
    saveAdminData(['reviews', 'auditLogs']); renderAdmin();
}

/* Post-publication safety net, separate from the pending-review queue
   above: these are reviews that already cleared moderation and are
   live, but a student or the landowner on that property flagged one as
   not made in good faith. The review stays visible the whole time it's
   here -- reporting is not a takedown, only a signal for an admin to
   look at. Triage ends one of two ways: remove the review (it was
   actually bad), or dismiss the report (the review stands). */
function renderAdminReportedReviews(openReports) {
    const panel = document.getElementById('admin-panel-reported');
    if (openReports.length === 0) {
        panel.innerHTML = emptyState('No reported reviews awaiting triage.');
        return;
    }
    panel.innerHTML = openReports.map(rep => {
        const r = reviews.find(x => x.id === rep.reviewId);
        const h = r ? houses.find(x => x.id === r.propertyId) : null;
        return `
        <div class="mod-card">
            <div class="mod-body">
                <p class="mod-meta">Reported by ${escapeHtml(rep.reporterName)} (${escapeHtml(rep.reporterRole)}) ·
                   ${new Date(rep.createdAt).toLocaleDateString()}</p>
                <p class="mod-meta">Reason: <strong>${escapeHtml(rep.reason)}</strong></p>
                ${r ? `
                <div class="rating-stars small">${renderStars(r.rating)}</div>
                <h4 style="margin-top:6px;">${escapeHtml(h ? h.name : 'Unknown property')}</h4>
                <p class="mod-meta">By ${escapeHtml(r.studentName)} ·
                   ${new Date(r.createdAt).toLocaleDateString()}</p>
                <p class="review-body">${escapeHtml(r.comment) || '<em>No written comment</em>'}</p>
                ` : `<p class="review-body"><em>This review no longer exists.</em></p>`}
            </div>
            <div class="mod-actions">
                <button class="btn-reject" onclick="removeReportedReview(${rep.id})">Remove Review</button>
                <button class="btn-approve" onclick="dismissReviewReport(${rep.id})">Dismiss Report</button>
            </div>
        </div>`;
    }).join('');
}

/* Removing the review resolves every open report on it, not just the
   one the admin happened to click from -- otherwise a review reported
   by three students would vanish from the list for two of those reports
   and reappear as "no longer exists" once someone reopened the tab. */
function removeReportedReview(reportId) {
    const preview = reviewReports.find(x => x.id === reportId);
    if (!preview) return;
    const previewReview = reviews.find(x => x.id === preview.reviewId);
    if (!confirm(`Remove this ${previewReview ? previewReview.rating + '-star ' : ''}review permanently? This cannot be undone.`)) return;

    // Reload right after the (blocking, but cross-tab-interruptible)
    // confirm dialog closes, not just before saving -- and re-find by id
    // rather than trusting the pre-confirm lookups above, in case
    // another tab already resolved/removed this in the meantime.
    reloadReviews();
    reloadReviewReports();
    const rep = reviewReports.find(x => x.id === reportId);
    if (!rep) return;
    const r = reviews.find(x => x.id === rep.reviewId);

    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY));
    reviews = reviews.filter(x => x.id !== rep.reviewId);
    reviewReports.forEach(x => {
        if (x.reviewId === rep.reviewId && x.status === 'open') {
            x.status = 'resolved';
            x.resolvedBy = session.name;
            x.resolvedAt = new Date().toISOString();
        }
    });
    logAudit('review.removed', 'reviews', rep.reviewId,
        r ? `${r.rating}-star by ${r.studentName} — removed following report (${rep.reason})`
          : `Removed following report (${rep.reason})`);
    saveAdminData(['reviews', 'reviewReports', 'auditLogs']); renderAdmin();
}

function dismissReviewReport(reportId) {
    reloadReviewReports();
    const rep = reviewReports.find(x => x.id === reportId);
    if (!rep) return;
    const r = reviews.find(x => x.id === rep.reviewId);

    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY));
    rep.status = 'dismissed';
    rep.resolvedBy = session.name;
    rep.resolvedAt = new Date().toISOString();
    logAudit('review_report.dismissed', 'review_reports', rep.id,
        `Report (${rep.reason}) on ${r ? `${r.rating}-star by ${r.studentName}` : 'a deleted review'} dismissed`);
    saveAdminData(['reviewReports', 'auditLogs']); renderAdmin();
}

// Internal admin summary only (not the public directory badge, which
// has its own dedicated tier-badge styling in style.css, one class per
// tier -- see TIER_BADGE in script.js) -- reuses the existing 3-color
// pill palette rather than inventing a 4th/5th, since ID_VERIFIED,
// SITE_VISITED, and FULLY_VERIFIED are all "good" states here and the
// label text already distinguishes which combination it is.
const OWNER_TIER_PILL = {
    UNVERIFIED:          { cls: 'pill-pending', label: 'Unverified' },
    DOCUMENTS_SUBMITTED: { cls: 'pill-pending', label: 'ID Submitted' },
    ID_VERIFIED:         { cls: 'pill-ok',      label: 'ID Verified' },
    SITE_VISITED:        { cls: 'pill-ok',      label: 'Site Visited' },
    FULLY_VERIFIED:      { cls: 'pill-ok',      label: 'Fully Verified' }
};

// null = show the card list; an id = show that landowner's detail view.
// Module-level so it survives the renderAdmin() re-renders every other
// admin action triggers (approve a listing, moderate a review, etc.) --
// the tab stays on whichever view the admin had open.
let selectedOwnerId = null;

function openOwnerDetail(id) {
    selectedOwnerId = id;
    renderAdminOwners();
}

function closeOwnerDetail() {
    selectedOwnerId = null;
    renderAdminOwners();
}

function renderAdminOwners() {
    const panel = document.getElementById('admin-panel-owners');
    const owner = selectedOwnerId && LANDOWNERS.find(o => o.id === selectedOwnerId);
    if (owner) renderOwnerDetail(panel, owner);
    else renderOwnerList(panel);
}

/* One inbox-style card per landowner -- same visual pattern as the
   messaging inbox (index.html's #inbox-list / renderInbox() in
   script.js): a clickable row with the summary on the left and a
   chevron on the right. Iterates LANDOWNERS rather than assuming one
   entry, so a second real landowner later needs nothing more than a
   second array entry to show up here. */
function renderOwnerList(panel) {
    if (LANDOWNERS.length === 0) {
        panel.innerHTML = emptyState('No landowner accounts yet.');
        return;
    }
    panel.innerHTML = LANDOWNERS.map(o => {
        const owned = houses.filter(h => h.owner === o.name).length;
        const myDocs = verificationDocs.filter(d => d.user_id === o.id);
        const siteRecord = siteVerifications.find(v => v.user_id === o.id);
        const tier = computeVerificationTier(myDocs, siteRecord);
        const { cls: pillCls, label: pillLabel } = OWNER_TIER_PILL[tier];
        const awaitingReview = myDocs.filter(d => d.status === 'pending').length;

        return `
            <div class="inbox-card" onclick="openOwnerDetail('${o.id}')">
                <div>
                    <strong style="color:#9B72FF; font-size:20px;">${escapeHtml(o.name)}</strong><br>
                    <span style="font-size:13px; color:#999;">${owned} propert${owned === 1 ? 'y' : 'ies'} listed
                        &nbsp;·&nbsp; <span class="pill ${pillCls}">${pillLabel}</span></span><br>
                    <small style="color:#666; font-size:15px;">${awaitingReview} item${awaitingReview === 1 ? '' : 's'} awaiting review</small>
                </div>
                <div style="color:#9B72FF; font-weight:bold; align-self:center; font-size:24px;">❯</div>
            </div>`;
    }).join('');
}

/* Detail view for one landowner: their ID document with review
   controls, their listings, and the site-visit control -- everything
   renderAdminOwners used to render unconditionally for the single
   hardcoded landowner, now behind the card click. */
function renderOwnerDetail(panel, owner) {
    const myDocs = verificationDocs.filter(d => d.user_id === owner.id);
    const siteRecord = siteVerifications.find(v => v.user_id === owner.id);
    const tier = computeVerificationTier(myDocs, siteRecord);
    const { cls: overallPill, label: overallLabel } = OWNER_TIER_PILL[tier];
    const listings = houses.filter(h => h.owner === owner.name);

    const docCards = DOCUMENT_TYPES.map(t => {
        const doc = myDocs.find(d => d.document_type === t.key);
        if (!doc) {
            return `
                <div class="mod-card verification-doc-card status-none">
                    <div class="mod-body">
                        <h4>${t.label}</h4>
                        <p class="mod-meta">Status: <span class="pill pill-pending">Not submitted</span></p>
                    </div>
                </div>`;
        }

        // file_path is null once a decision's been recorded and the file
        // deleted (immediately on approval, or after the retention
        // window on rejection) -- see submitDocDecision/
        // purgeExpiredRejectedDocs. Only the decision record remains.
        const thumb = doc.file_path
            ? `<img class="verification-thumb" src="${doc.file_path}" onclick="openImageModal('${doc.file_path}')">`
            : `<p class="mod-meta" style="font-style:italic;">Document not retained.</p>`;

        if (doc.status === 'pending') {
            return `
                <div class="mod-card verification-doc-card status-pending">
                    ${thumb}
                    <div class="mod-body">
                        <h4>${t.label}</h4>
                        <p class="mod-meta">Status: <span class="pill pill-pending">Pending Review</span></p>
                        <p class="mod-meta">Submitted ${new Date(doc.submitted_at).toLocaleDateString()}</p>
                    </div>
                    <div class="mod-actions">
                        <button class="btn-approve" onclick="openDocReviewModal(${doc.id})">Review</button>
                    </div>
                </div>`;
        }

        const pillClass = doc.status === 'approved' ? 'pill-ok' : 'pill-bad';
        const pillLabel = doc.status === 'approved' ? 'Approved' : 'Rejected';
        const remarks = doc.status === 'rejected' && doc.remarks
            ? `<p class="mod-meta" style="color:#b02a37;">Reason: ${escapeHtml(doc.remarks)}</p>` : '';
        const chk = doc.checklist;
        const qrDisplay = { yes: '✔', no: '✖', na: 'N/A' }[chk?.qrVerified] || '—';
        const checklistLine = chk ? `
            <p class="mod-meta" style="font-size:12px;">Checklist:
                Name matches ${chk.nameMatches ? '✔' : '✖'} ·
                Unexpired/non-expiring ${chk.idUnexpired ? '✔' : '✖'} ·
                Legible ${chk.legible ? '✔' : '✖'} ·
                QR verified ${qrDisplay}</p>` : '';
        const hashLine = doc.file_hash
            ? `<p class="mod-meta" style="font-size:11px; color:#999;">SHA-256:
                <code style="word-break:break-all;">${escapeHtml(doc.file_hash)}</code></p>` : '';
        return `
            <div class="mod-card verification-doc-card status-${doc.status}">
                ${thumb}
                <div class="mod-body">
                    <h4>${t.label}</h4>
                    <p class="mod-meta">Status: <span class="pill ${pillClass}">${pillLabel}</span></p>
                    <p class="mod-meta">${escapeHtml(doc.reviewed_by || '')} · ${new Date(doc.reviewed_at).toLocaleDateString()}</p>
                    ${remarks}
                    ${checklistLine}
                    ${hashLine}
                </div>
            </div>`;
    }).join('');

    const todayISO = new Date().toISOString().slice(0, 10);
    const siteControl = siteRecord
        ? `<p class="mod-meta">Site visit confirmed by ${escapeHtml(siteRecord.verified_by)} on
             ${new Date(siteRecord.verified_at).toLocaleDateString()}</p>
           <div class="mod-actions">
               <input type="date" id="site-verify-date" value="${todayISO}" max="${todayISO}">
               <button class="btn-approve" onclick="markSiteVerified()">Update Site Visit</button>
           </div>`
        : `<div class="mod-actions">
               <input type="date" id="site-verify-date" value="${todayISO}" max="${todayISO}">
               <button class="btn-approve" onclick="markSiteVerified()">Mark Site Verified</button>
           </div>`;

    const listingCards = listings.length === 0
        ? emptyState('No listings from this landowner yet.')
        : listings.map(h => {
            const statusPill = { approved: 'pill-ok', pending: 'pill-pending', rejected: 'pill-bad' }[h.status] || 'pill-pending';
            return `
                <div class="mod-card">
                    <div class="mod-body">
                        <h4>${escapeHtml(h.name)}</h4>
                        <p class="mod-meta">📍 ${escapeHtml(h.location)} &nbsp;·&nbsp; ₱${h.price}/month
                           &nbsp;·&nbsp; ${h.available} of ${h.total} rooms vacant</p>
                    </div>
                    <span class="pill ${statusPill}">${escapeHtml(h.status)}</span>
                </div>`;
        }).join('');

    panel.innerHTML = `
        <button onclick="closeOwnerDetail()" style="background:none; border:none; color:#9B72FF;
            font-weight:600; font-size:14px; cursor:pointer; font-family:inherit; padding:0; margin-bottom:20px;
            display:flex; align-items:center; gap:6px;">‹ Back to Landowner Accounts</button>
        <div class="mod-card" style="flex-direction:column; align-items:stretch;">
            <div class="mod-body">
                <h4>${escapeHtml(owner.name)}</h4>
                <p class="mod-meta">Landowner · ${listings.length} propert${listings.length === 1 ? 'y' : 'ies'} listed</p>
                <p class="mod-meta">Overall tier: <span class="pill ${overallPill}">${overallLabel}</span></p>
                ${siteControl}
            </div>
            <div class="mod-actions">
                <button class="btn-reject" onclick="resetVerificationData()">Reset Verification Data</button>
            </div>
        </div>
        <div class="verification-grid">${docCards}</div>
        <div class="dashboard-header" style="margin-top:30px;"><h3>Listings</h3></div>
        ${listingCards}`;
}

/* A site visit requires a physical visit, so unlike document review
   there's nothing to upload or check remotely -- just who confirmed it
   and when. Uses session.name as "the administrator who visited," same
   convention as doc.reviewed_by, rather than a separate free-text name
   field. Upserts (like uploadVerificationDoc's find-or-push) so
   re-marking updates the existing record instead of accumulating
   duplicates -- no separate "unverify" control, wasn't asked for. */
function markSiteVerified() {
    const dateStr = document.getElementById('site-verify-date').value;
    if (!dateStr) return alert('Pick the visit date first.');

    reloadSiteVerifications();
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY));
    let record = siteVerifications.find(v => v.user_id === LANDOWNER_ID);
    if (record) {
        Object.assign(record, { verified_by: session.name, verified_at: new Date(dateStr).toISOString() });
    } else {
        siteVerifications.push({ id: Date.now(), user_id: LANDOWNER_ID, verified_by: session.name, verified_at: new Date(dateStr).toISOString() });
    }
    syncVerificationTier(); // also reloads+updates houses & landownerProfile, see its own comment
    logAudit('account.site_verified', 'landowners', LANDOWNER_ID, `Site visit confirmed by ${session.name} on ${dateStr} — Ana Ramos`);
    saveAdminData(['siteVerifications', 'houses', 'landownerProfile', 'auditLogs']); renderAdmin();
}

/* Demonstration utility for the thesis defense -- wipes every submitted
   verification document, its approval/rejection state, and any site
   visit record for the demo landowner, returning them to Unverified, so
   the whole document-review flow can be re-run from a clean slate
   without editing localStorage by hand. Not a real admin capability: a
   production system would never let an admin unilaterally destroy a
   landowner's submitted paperwork with one click and no trace beyond an
   audit log line. */
function resetVerificationData() {
    if (!confirm(
        "Reset all verification documents and site-visit records for this landowner?\n\n" +
        "This permanently clears every submitted document, its approval/rejection " +
        "state, and any recorded site visit, returning the account to Unverified. " +
        "This cannot be undone."
    )) return;

    reloadVerificationDocs();
    reloadSiteVerifications();
    verificationDocs = verificationDocs.filter(d => d.user_id !== LANDOWNER_ID);
    siteVerifications = siteVerifications.filter(v => v.user_id !== LANDOWNER_ID);
    syncVerificationTier(); // also reloads+updates houses & landownerProfile, see its own comment
    logAudit('verification.reset', 'verification_documents', LANDOWNER_ID,
        'All verification documents and site-visit records reset for Ana Ramos (demonstration utility)');
    saveAdminData(['verificationDocs', 'siteVerifications', 'houses', 'landownerProfile', 'auditLogs']); renderAdmin();
}

/* =====================================================================
   STUDENT ACCOUNTS TAB
   Direct structural mirror of the Landowner Accounts block above --
   same card-list-then-detail pattern, same module-level selected-id
   state, same emptyState/inbox-card conventions. Deliberately simpler
   than the landowner detail view: no listings section (students don't
   own listings) and no site-visit control (no physical-visit concept
   for a student) -- just name, their self-reported school (read-only
   here -- the student edits it in script.js, admin only reviews the ID
   against it), and the one school-ID document.
   ===================================================================== */

const STUDENT_STATUS_PILL = {
    none:     { cls: 'pill-pending', label: 'Unverified' },
    pending:  { cls: 'pill-pending', label: 'ID Submitted' },
    approved: { cls: 'pill-ok',      label: 'Student Verified' },
    rejected: { cls: 'pill-bad',     label: 'Rejected' }
};

let selectedStudentId = null;

function openStudentDetail(id) {
    selectedStudentId = id;
    renderAdminStudents();
}

function closeStudentDetail() {
    selectedStudentId = null;
    renderAdminStudents();
}

function renderAdminStudents() {
    const panel = document.getElementById('admin-panel-students');
    if (!panel) return; // guards against a stale cached admin.html without the new tab markup
    const student = selectedStudentId && STUDENTS.find(s => s.id === selectedStudentId);
    if (student) renderStudentDetail(panel, student);
    else renderStudentList(panel);
}

function renderStudentList(panel) {
    if (STUDENTS.length === 0) {
        panel.innerHTML = emptyState('No student accounts yet.');
        return;
    }
    panel.innerHTML = STUDENTS.map(s => {
        const doc = studentVerificationDocs.find(d => d.user_id === s.id && d.document_type === 'school_id');
        const status = doc ? doc.status : 'none';
        const { cls: pillCls, label: pillLabel } = STUDENT_STATUS_PILL[status];
        const awaitingReview = status === 'pending' ? 1 : 0;

        return `
            <div class="inbox-card" onclick="openStudentDetail('${s.id}')">
                <div>
                    <strong style="color:#9B72FF; font-size:20px;">${escapeHtml(s.name)}</strong><br>
                    <span style="font-size:13px; color:#999;">${escapeHtml(studentProfile.school || 'No school on file')}
                        &nbsp;·&nbsp; <span class="pill ${pillCls}">${pillLabel}</span></span><br>
                    <small style="color:#666; font-size:15px;">${awaitingReview} item${awaitingReview === 1 ? '' : 's'} awaiting review</small>
                </div>
                <div style="color:#9B72FF; font-weight:bold; align-self:center; font-size:24px;">❯</div>
            </div>`;
    }).join('');
}

function renderStudentDetail(panel, student) {
    const doc = studentVerificationDocs.find(d => d.user_id === student.id && d.document_type === 'school_id');
    const t = STUDENT_DOCUMENT_TYPES[0];

    let docCard;
    if (!doc) {
        docCard = `
            <div class="mod-card verification-doc-card status-none">
                <div class="mod-body">
                    <h4>${t.label}</h4>
                    <p class="mod-meta">Status: <span class="pill pill-pending">Not submitted</span></p>
                </div>
            </div>`;
    } else {
        const thumb = doc.file_path
            ? `<img class="verification-thumb" src="${doc.file_path}" onclick="openImageModal('${doc.file_path}')">`
            : `<p class="mod-meta" style="font-style:italic;">Document not retained.</p>`;
        // Recorded at upload time (script.js's uploadStudentVerificationDoc())
        // -- shown here purely as a transparency aid for the reviewer, not
        // itself part of the checklist gate.
        const consentLine = doc.consent
            ? `<p class="mod-meta" style="font-size:11px; color:#999;">Consent: notice ${escapeHtml(doc.consent.version)},
                agreed ${new Date(doc.consent.agreedAt).toLocaleString()}</p>` : '';

        if (doc.status === 'pending') {
            docCard = `
                <div class="mod-card verification-doc-card status-pending">
                    ${thumb}
                    <div class="mod-body">
                        <h4>${t.label}</h4>
                        <p class="mod-meta">Status: <span class="pill pill-pending">Pending Review</span></p>
                        <p class="mod-meta">Submitted ${new Date(doc.submitted_at).toLocaleDateString()}</p>
                        ${consentLine}
                    </div>
                    <div class="mod-actions">
                        <button class="btn-approve" onclick="openStudentDocReviewModal(${doc.id})">Review</button>
                    </div>
                </div>`;
        } else {
            const pillClass = doc.status === 'approved' ? 'pill-ok' : 'pill-bad';
            const pillLabel = doc.status === 'approved' ? 'Approved' : 'Rejected';
            const remarks = doc.status === 'rejected' && doc.remarks
                ? `<p class="mod-meta" style="color:#b02a37;">Reason: ${escapeHtml(doc.remarks)}</p>` : '';
            const chk = doc.checklist;
            const checklistLine = chk ? `
                <p class="mod-meta" style="font-size:12px;">Checklist:
                    Name matches ${chk.nameMatches ? '✔' : '✖'} ·
                    School matches ${chk.schoolMatches ? '✔' : '✖'} ·
                    Current/recent academic year ${chk.recentAcademicYear ? '✔' : '✖'} ·
                    Legible ${chk.legible ? '✔' : '✖'}</p>` : '';
            const hashLine = doc.file_hash
                ? `<p class="mod-meta" style="font-size:11px; color:#999;">SHA-256:
                    <code style="word-break:break-all;">${escapeHtml(doc.file_hash)}</code></p>` : '';
            docCard = `
                <div class="mod-card verification-doc-card status-${doc.status}">
                    ${thumb}
                    <div class="mod-body">
                        <h4>${t.label}</h4>
                        <p class="mod-meta">Status: <span class="pill ${pillClass}">${pillLabel}</span></p>
                        <p class="mod-meta">${escapeHtml(doc.reviewed_by || '')} · ${new Date(doc.reviewed_at).toLocaleDateString()}</p>
                        ${remarks}
                        ${checklistLine}
                        ${hashLine}
                        ${consentLine}
                    </div>
                </div>`;
        }
    }

    panel.innerHTML = `
        <button onclick="closeStudentDetail()" style="background:none; border:none; color:#9B72FF;
            font-weight:600; font-size:14px; cursor:pointer; font-family:inherit; padding:0; margin-bottom:20px;
            display:flex; align-items:center; gap:6px;">‹ Back to Student Accounts</button>
        <div class="mod-card" style="flex-direction:column; align-items:stretch;">
            <div class="mod-body">
                <h4>${escapeHtml(student.name)}</h4>
                <p class="mod-meta">Student · School: ${escapeHtml(studentProfile.school || 'Not specified')}</p>
            </div>
        </div>
        <div class="verification-grid">${docCard}</div>`;
}

/* ---------- document review modal: checklist-gated decisions ----------
   "The decision should not be recordable without the checklist" is
   enforced by disabling both buttons (updateDocReviewGate) until all
   four items have an explicit answer -- not just checked at submit
   time. Yes/No radio pairs, not checkboxes: a checklist item is an
   assertion the reviewer is confirming or denying, and rejecting a
   document needs to be answerable with "No" on the relevant item rather
   than forced to an all-true checklist just to proceed. The fourth item
   (QR verification) is Yes/No/Not-applicable instead, since it only
   applies to a PhilSys National ID specifically -- "answered" for the
   gate still just means some radio in the group is checked, N/A
   included. */
let docReviewId = null;
const DOC_REVIEW_CHECKLIST_FIELDS = [
    ['chk-name', 'nameMatches'],
    ['chk-id-unexpired', 'idUnexpired'],
    ['chk-legible', 'legible'],
    ['chk-qr', 'qrVerified']
];

function openDocReviewModal(id) {
    const doc = verificationDocs.find(d => d.id === id);
    if (!doc) return;
    docReviewId = id;

    const label = DOCUMENT_TYPES.find(t => t.key === doc.document_type)?.label || doc.document_type;
    document.getElementById('doc-review-label').innerText = label;
    document.getElementById('doc-review-thumb-wrap').innerHTML = doc.file_path
        ? `<img class="verification-thumb" src="${doc.file_path}" onclick="openImageModal('${doc.file_path}')">`
        : `<p class="mod-meta" style="font-style:italic;">Document not retained.</p>`;

    document.querySelectorAll('#doc-review-modal input[type="radio"]').forEach(r => r.checked = false);
    document.getElementById('doc-review-reason').value = '';
    document.getElementById('doc-review-approve-btn').disabled = true;
    document.getElementById('doc-review-reject-btn').disabled = true;

    document.getElementById('doc-review-modal').style.display = 'block';
}

function closeDocReviewModal() {
    document.getElementById('doc-review-modal').style.display = 'none';
    docReviewId = null;
}

function updateDocReviewGate() {
    const allAnswered = DOC_REVIEW_CHECKLIST_FIELDS.every(([name]) =>
        document.querySelector(`input[name="${name}"]:checked`));
    document.getElementById('doc-review-approve-btn').disabled = !allAnswered;
    document.getElementById('doc-review-reject-btn').disabled = !allAnswered;
}

function readDocReviewChecklist() {
    const checklist = {};
    DOC_REVIEW_CHECKLIST_FIELDS.forEach(([name, field]) => {
        const val = document.querySelector(`input[name="${name}"]:checked`)?.value;
        // qrVerified keeps its raw yes/no/na value -- "not applicable" isn't
        // equivalent to false. The other three are plain Yes/No assertions.
        checklist[field] = field === 'qrVerified' ? val : val === 'yes';
    });
    return checklist;
}

function submitDocDecision(decision) {
    reloadVerificationDocs();
    const doc = verificationDocs.find(d => d.id === docReviewId);
    if (!doc) return;

    const reason = document.getElementById('doc-review-reason').value.trim();
    if (decision === 'rejected' && !reason) {
        alert('A reason is required to reject a document.');
        return;
    }

    const checklist = readDocReviewChecklist();
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY));
    const label = DOCUMENT_TYPES.find(t => t.key === doc.document_type)?.label || doc.document_type;

    doc.status = decision;
    doc.reviewed_by = session.name;
    doc.reviewed_at = new Date().toISOString();
    doc.checklist = checklist;
    doc.remarks = decision === 'rejected' ? reason : null;

    // Approved documents' files are deleted immediately, not windowed --
    // only a rejection gets the retention window (purgeExpiredRejectedDocs).
    if (decision === 'approved') {
        doc.file_path = null;
        logAudit('document.file_purged', 'verification_documents', doc.id,
            `${label} — Ana Ramos — file deleted immediately on approval`);
    }

    syncVerificationTier(); // also reloads+updates houses & landownerProfile, see its own comment
    logAudit(`document.${decision}`, 'verification_documents', doc.id,
        `${label} — Ana Ramos${decision === 'rejected' ? ` — ${reason}` : ''} — checklist: ` +
        `name matches ${checklist.nameMatches ? 'Y' : 'N'}, unexpired/non-expiring ${checklist.idUnexpired ? 'Y' : 'N'}, ` +
        `legible ${checklist.legible ? 'Y' : 'N'}, QR verified ${checklist.qrVerified}`);

    saveAdminData(['verificationDocs', 'houses', 'landownerProfile', 'auditLogs']);
    closeDocReviewModal();
    renderAdmin();
}

/* ---------- student document review modal: checklist-gated decisions ----
   1:1 structural mirror of the landowner review-modal block above, over
   studentVerificationDocs instead of verificationDocs, with a different
   (all plain yes/no, no third "N/A" option) checklist -- see
   STUDENT_DOC_REVIEW_CHECKLIST_FIELDS and #student-doc-review-modal in
   admin.html for the four items. */
let studentDocReviewId = null;
const STUDENT_DOC_REVIEW_CHECKLIST_FIELDS = [
    ['chk-s-name', 'nameMatches'],
    ['chk-s-school', 'schoolMatches'],
    ['chk-s-year', 'recentAcademicYear'],
    ['chk-s-legible', 'legible']
];

function openStudentDocReviewModal(id) {
    const doc = studentVerificationDocs.find(d => d.id === id);
    if (!doc) return;
    studentDocReviewId = id;

    const label = STUDENT_DOCUMENT_TYPES.find(t => t.key === doc.document_type)?.label || doc.document_type;
    document.getElementById('student-doc-review-label').innerText = label;
    document.getElementById('student-doc-review-thumb-wrap').innerHTML = doc.file_path
        ? `<img class="verification-thumb" src="${doc.file_path}" onclick="openImageModal('${doc.file_path}')">`
        : `<p class="mod-meta" style="font-style:italic;">Document not retained.</p>`;

    document.querySelectorAll('#student-doc-review-modal input[type="radio"]').forEach(r => r.checked = false);
    document.getElementById('student-doc-review-reason').value = '';
    document.getElementById('student-doc-review-approve-btn').disabled = true;
    document.getElementById('student-doc-review-reject-btn').disabled = true;

    document.getElementById('student-doc-review-modal').style.display = 'block';
}

function closeStudentDocReviewModal() {
    document.getElementById('student-doc-review-modal').style.display = 'none';
    studentDocReviewId = null;
}

function updateStudentDocReviewGate() {
    const allAnswered = STUDENT_DOC_REVIEW_CHECKLIST_FIELDS.every(([name]) =>
        document.querySelector(`input[name="${name}"]:checked`));
    document.getElementById('student-doc-review-approve-btn').disabled = !allAnswered;
    document.getElementById('student-doc-review-reject-btn').disabled = !allAnswered;
}

function readStudentDocReviewChecklist() {
    const checklist = {};
    STUDENT_DOC_REVIEW_CHECKLIST_FIELDS.forEach(([name, field]) => {
        checklist[field] = document.querySelector(`input[name="${name}"]:checked`)?.value === 'yes';
    });
    return checklist;
}

function submitStudentDocDecision(decision) {
    reloadStudentVerificationDocs();
    const doc = studentVerificationDocs.find(d => d.id === studentDocReviewId);
    if (!doc) return;

    const reason = document.getElementById('student-doc-review-reason').value.trim();
    if (decision === 'rejected' && !reason) {
        alert('A reason is required to reject a document.');
        return;
    }

    const checklist = readStudentDocReviewChecklist();
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY));
    const label = STUDENT_DOCUMENT_TYPES.find(t => t.key === doc.document_type)?.label || doc.document_type;
    const studentName = STUDENTS.find(s => s.id === doc.user_id)?.name || doc.user_id;

    doc.status = decision;
    doc.reviewed_by = session.name;
    doc.reviewed_at = new Date().toISOString();
    doc.checklist = checklist;
    doc.remarks = decision === 'rejected' ? reason : null;

    // Retention DIFFERS from the landowner flow here, per counsel's advice:
    // a landowner is allowed to see a student's approved ID (for
    // verification and complaint resolution, with the student's consent
    // captured at upload -- see script.js's uploadStudentVerificationDoc()),
    // so an approved file is kept instead of purged immediately. A rejected
    // file still follows the same 7-day window as everything else
    // (purgeExpiredRejectedStudentDocs() above). The student can also
    // withdraw an approved/rejected file themselves at any time
    // (script.js's removeMyStudentVerificationDoc()) -- that's the only
    // other way this file_path goes away now.

    logAudit(`student_document.${decision}`, 'student_verification_documents', doc.id,
        `${label} — ${studentName}${decision === 'rejected' ? ` — ${reason}` : ''} — checklist: ` +
        `name matches ${checklist.nameMatches ? 'Y' : 'N'}, school matches ${checklist.schoolMatches ? 'Y' : 'N'}, ` +
        `recent academic year ${checklist.recentAcademicYear ? 'Y' : 'N'}, legible ${checklist.legible ? 'Y' : 'N'}`);

    saveAdminData(['studentVerificationDocs', 'auditLogs']);
    closeStudentDocReviewModal();
    renderAdmin();
}

/* Filtering only -- what gets logged (logAudit() above) is untouched.
   Categorized by entityType (already on every stored record, see
   logAudit()) rather than parsing the action string -- entityType is
   the stabler, more structured field, and every category maps to an
   exact, exhaustive set of entityTypes with no overlap. "Verification"
   spans both landowner and student document records plus the site-visit
   action (entityType 'landowners', from markSiteVerified()) -- ID
   approvals/rejections, site visits, and the file-deletion entries that
   follow a decision are all part of the same verification workflow. */
const AUDIT_CATEGORIES = {
    all:          { label: 'All', match: () => true },
    verification: { label: 'Verification', match: l => ['verification_documents', 'student_verification_documents', 'landowners'].includes(l.entityType) },
    listings:     { label: 'Listings', match: l => l.entityType === 'properties' },
    reviews:      { label: 'Reviews', match: l => ['reviews', 'review_reports'].includes(l.entityType) }
};
// Module-level, survives renderAdmin() re-renders -- same pattern as
// selectedOwnerId/selectedStudentId above, so switching tabs and coming
// back doesn't reset the filter.
let auditCategoryFilter = 'all';

// 10 entries per page instead of one long scroll (panel feedback). Same
// module-level persistence as auditCategoryFilter; a category change
// starts over at page 1. logAudit caps the log at 300, so <= 30 pages.
const AUDIT_PAGE_SIZE = 10;
let auditPage = 1;

function setAuditCategoryFilter(category) {
    auditCategoryFilter = category;
    auditPage = 1;
    renderAuditLog();
}

function setAuditPage(page) {
    auditPage = page;
    renderAuditLog();
}

function renderAuditLog() {
    const panel = document.getElementById('admin-panel-audit');
    if (auditLogs.length === 0) {
        panel.innerHTML = emptyState('No recorded activity yet.');
        return;
    }

    const filterBar = `<div class="audit-filter-bar">${Object.entries(AUDIT_CATEGORIES).map(([key, cfg]) =>
        `<button class="audit-filter-btn ${auditCategoryFilter === key ? 'active' : ''}" onclick="setAuditCategoryFilter('${key}')">${cfg.label}</button>`
    ).join('')}</div>`;

    const filtered = auditLogs.filter(AUDIT_CATEGORIES[auditCategoryFilter].match);
    if (filtered.length === 0) {
        panel.innerHTML = filterBar + emptyState(`No ${AUDIT_CATEGORIES[auditCategoryFilter].label} activity recorded yet.`);
        return;
    }

    // Clamp: the log can shrink under the current page (another tab, or a
    // category with fewer entries) -- never show an empty page 4 of 2.
    const pageCount = Math.max(1, Math.ceil(filtered.length / AUDIT_PAGE_SIZE));
    auditPage = Math.min(Math.max(1, auditPage), pageCount);
    const pageRows = filtered.slice((auditPage - 1) * AUDIT_PAGE_SIZE, auditPage * AUDIT_PAGE_SIZE);
    const pager = `
        <div class="audit-pager">
            <button class="audit-page-btn" onclick="setAuditPage(${auditPage - 1})" ${auditPage <= 1 ? 'disabled' : ''}>‹ Prev</button>
            <span class="audit-page-info">Page ${auditPage} of ${pageCount} · ${filtered.length} entr${filtered.length === 1 ? 'y' : 'ies'}</span>
            <button class="audit-page-btn" onclick="setAuditPage(${auditPage + 1})" ${auditPage >= pageCount ? 'disabled' : ''}>Next ›</button>
        </div>`;

    panel.innerHTML = filterBar + `
        <div style="overflow-x:auto; background:white; border-radius:15px; padding:20px;
                    box-shadow:0 5px 20px rgba(0,0,0,0.05);">
        <table class="dashboard-table">
            <thead><tr><th>Timestamp</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>${pageRows.map(l => `
                <tr>
                    <td style="white-space:nowrap;">${new Date(l.createdAt).toLocaleString()}</td>
                    <td>${escapeHtml(l.userName)}</td>
                    <td><code class="audit-action">${escapeHtml(l.action)}</code></td>
                    <td>${escapeHtml(l.label)}</td>
                </tr>`).join('')}
            </tbody>
        </table>${pager}</div>`;
}

/* Fires in every OTHER tab/window on this origin when localStorage
   changes here -- most commonly index.html open alongside this console.
   A landowner adding a listing or uploading an ID should show up in the
   relevant queue here live, not only the next time this console happens
   to save something itself. Reloads just the key that changed, then
   re-renders -- renderAdmin() redraws every panel/stat regardless of
   which tab is active, same as it already does after every admin
   action, so it's safe to call unconditionally here. */
window.addEventListener('storage', (e) => {
    switch (e.key) {
        case 'eboard_v12':                 reloadHouses(); break;
        case 'eboard_reviews_v13':         reloadReviews(); break;
        case 'eboard_profile_v12':         reloadLandownerProfile(); break;
        case 'eboard_audit_v13':           reloadAuditLogs(); break;
        case VERIFICATION_KEY:             reloadVerificationDocs(); break;
        case SITE_VERIFICATION_KEY:        reloadSiteVerifications(); break;
        case REVIEW_REPORTS_KEY:           reloadReviewReports(); break;
        case STUDENT_VERIFICATION_KEY:     reloadStudentVerificationDocs(); break;
        case STUDENT_PROFILE_KEY:          reloadStudentProfile(); break;
        default: return;
    }
    if (document.getElementById('admin-console').style.display === 'block') renderAdmin();
});

/* ---- INIT ---- */
if (sessionStorage.getItem(ADMIN_SESSION_KEY)) showConsole();
