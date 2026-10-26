/* My Bookshelf — standalone app.
 * Data lives in Supabase when config.js is filled in, otherwise on this
 * device only (localStorage) with a yellow "Not connected yet" note.
 * Book catalogue: Open Library (openlibrary.org), free and public.
 */
(function () {
  "use strict";

  var BUILTIN_MOODS = ["adult vampire fantasy", "cozy", "dark", "romantasy", "spicy", "dark fantasy", "feel-good", "mystery"];
  var SPINE_COLORS = ["#b3576e", "#7a8a5a", "#4a7a8a", "#c9a227", "#8a5a9e", "#d97a4a", "#5a8a7a", "#a34a5a"];

  var state = {
    books: [],
    sessions: [],
    goal: 0,
    customMoods: [],
    homeShelf: "tbr",
    page: "home",
    jarMode: "shelf", // "shelf" | "suggest"
    pickedMoods: [],
    surprise: false,
    shownSuggestions: {},
    currentModalBookId: null,
    currentPreview: null
  };

  /* ---------------- setup: Supabase or on-device mode ---------------- */

  var cfg = (window.MY_BOOKSHELF_CONFIG || {});
  var connected = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  var supabase = null;
  if (connected && window.supabase) {
    try { supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey); }
    catch (e) { connected = false; }
  }
  if (!connected) {
    document.getElementById("setupBanner").classList.remove("hidden");
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);
  }
  function yearNow() { return new Date().getFullYear(); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function normKey(title, author) {
    return (title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + "|" + (author || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function coverUrl(coverId, size) {
    return coverId ? "https://covers.openlibrary.org/b/id/" + coverId + "-" + (size || "M") + ".jpg" : "";
  }
  function $ (id) { return document.getElementById(id); }

  /* ---------------- data layer (Supabase or localStorage) ---------------- */

  function lsGet(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function lsSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }

  function showDbError(msg) {
    var el = $("dbError");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function clearDbError() {
    var el = $("dbError");
    if (el) { el.textContent = ""; el.classList.add("hidden"); }
  }
  async function dbWrite(promise, failMsg) {
    try {
      var res = await promise;
      if (res && res.error) { showDbError(failMsg + " — the database said: " + res.error.message); return false; }
      clearDbError();
      return true;
    } catch (e) {
      showDbError(failMsg + " — " + (e && e.message ? e.message : "the database could not be reached"));
      return false;
    }
  }

  var db = {
    async loadAll() {
      if (connected) {
        clearDbError();
        try {
          var b = await supabase.from("books").select("*").order("created_at", { ascending: true });
          var s = await supabase.from("reading_sessions").select("*").order("session_date", { ascending: false });
          var g = await supabase.from("settings").select("*").eq("id", 1).single();
          var m = await supabase.from("custom_moods").select("*").order("created_at", { ascending: true });
          if (b.error) { showDbError("Couldn't load your books — the database said: " + b.error.message + ". Nothing was deleted; the app just could not reach your saved books."); }
          state.books = b.data || [];
          state.sessions = s.data || [];
          state.goal = (g.data && g.data.goal_number) || 0;
          state.customMoods = (m.data || []).map(function (r) { return r.mood; });
        } catch (e) {
          showDbError("Couldn't reach your database: " + (e && e.message ? e.message : "network error") + ". Your books are safe in the database; check your connection and reopen the app.");
          state.books = []; state.sessions = []; state.goal = 0; state.customMoods = [];
        }
      } else {
        state.books = lsGet("mbs_books", []);
        state.sessions = lsGet("mbs_sessions", []);
        state.goal = lsGet("mbs_goal", 0);
        state.customMoods = lsGet("mbs_moods", []);
      }
    },
    async addBook(book) {
      book.id = uid();
      book.created_at = new Date().toISOString();
      if (connected) {
        var ok = await dbWrite(supabase.from("books").insert(book), "Couldn't save \"" + book.title + "\"");
        if (!ok) return null;
        state.books.push(book);
      }
      else { state.books.push(book); lsSet("mbs_books", state.books); }
      return book;
    },
    async updateBook(id, patch) {
      var book = state.books.find(function (b) { return b.id === id; });
      if (!book) return;
      if (connected) {
        var ok = await dbWrite(supabase.from("books").update(patch).eq("id", id), "Couldn't save your changes");
        if (!ok) return;
        Object.assign(book, patch);
      }
      else { Object.assign(book, patch); lsSet("mbs_books", state.books); }
    },
    async deleteBook(id) {
      if (connected) {
        var ok = await dbWrite(supabase.from("books").delete().eq("id", id), "Couldn't remove that book");
        if (!ok) return;
        state.books = state.books.filter(function (b) { return b.id !== id; });
      }
      else { state.books = state.books.filter(function (b) { return b.id !== id; }); lsSet("mbs_books", state.books); }
    },
    async addSession(session) {
      session.id = uid();
      if (connected) {
        var ok = await dbWrite(supabase.from("reading_sessions").insert(session), "Couldn't save that reading session");
        if (!ok) return null;
        state.sessions.unshift(session);
      }
      else { state.sessions.unshift(session); lsSet("mbs_sessions", state.sessions); }
      return session;
    },
    async deleteSession(id) {
      if (connected) {
        var ok = await dbWrite(supabase.from("reading_sessions").delete().eq("id", id), "Couldn't remove that session");
        if (!ok) return;
        state.sessions = state.sessions.filter(function (s) { return s.id !== id; });
      }
      else { state.sessions = state.sessions.filter(function (s) { return s.id !== id; }); lsSet("mbs_sessions", state.sessions); }
    },
    async setGoal(n) {
      if (connected) {
        var ok = await dbWrite(supabase.from("settings").upsert({ id: 1, goal_number: n }), "Couldn't save your goal");
        if (!ok) return;
        state.goal = n;
      }
      else { state.goal = n; lsSet("mbs_goal", n); }
    },
    async addMood(mood) {
      var clean = mood.trim().toLowerCase();
      if (!clean) return false;
      if (BUILTIN_MOODS.indexOf(clean) !== -1) return false;
      if (state.customMoods.some(function (m) { return m.toLowerCase() === clean; })) return false;
      if (connected) {
        var ok = await dbWrite(supabase.from("custom_moods").insert({ mood: clean }), "Couldn't save that mood");
        if (!ok) return false;
        state.customMoods.push(clean);
      }
      else { state.customMoods.push(clean); lsSet("mbs_moods", state.customMoods); }
      return true;
    },
    async removeMood(mood) {
      if (connected) {
        var ok = await dbWrite(supabase.from("custom_moods").delete().eq("mood", mood), "Couldn't remove that mood");
        if (!ok) return;
      }
      state.customMoods = state.customMoods.filter(function (m) { return m !== mood; });
      state.pickedMoods = state.pickedMoods.filter(function (m) { return m !== mood; });
      if (!connected) lsSet("mbs_moods", state.customMoods);
    }
  };

  /* ---------------- Open Library catalogue ---------------- */

  async function searchCatalogue(query, limit) {
    var url = "https://openlibrary.org/search.json?q=" + encodeURIComponent(query) +
      "&limit=" + (limit || 15) +
      "&fields=key,title,author_name,first_publish_year,cover_i,number_of_pages_median,subject";
    var res = await fetch(url);
    var data = await res.json();
    return (data.docs || []).map(function (d) {
      return {
        workKey: d.key || "",
        title: d.title || "Untitled",
        author: (d.author_name && d.author_name[0]) || "Unknown author",
        year: d.first_publish_year || null,
        coverId: d.cover_i || null,
        pages: d.number_of_pages_median || null,
        subjects: d.subject || []
      };
    });
  }

  async function fetchSynopsis(book) {
    // Prefer the saved work key; fall back to an exact title + author search.
    var workKey = book.work_key || book.workKey || "";
    if (!workKey && book.title) {
      try {
        var results = await searchCatalogue(book.title + " " + (book.author || ""), 3);
        var exact = results.find(function (r) {
          return r.title.toLowerCase() === (book.title || "").toLowerCase();
        });
        workKey = (exact || results[0] || {}).workKey || "";
      } catch (e) { workKey = ""; }
    }
    if (!workKey) return null;
    try {
      var res = await fetch("https://openlibrary.org" + workKey + ".json");
      var data = await res.json();
      var desc = data.description;
      if (typeof desc === "string") return desc;
      if (desc && typeof desc.value === "string") return desc.value;
      return null;
    } catch (e) { return null; }
  }

  /* ---------------- plants (little SVG pots tucked on shelves) ---------------- */

  function plantSVG() {
    return '<div class="plant" aria-hidden="true">' +
      '<svg viewBox="0 0 56 74" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M28 34 C20 22 10 20 6 10 C18 12 26 20 28 34 Z" fill="#5d8a5a"/>' +
      '<path d="M28 34 C36 20 46 18 52 8 C40 10 31 20 28 34 Z" fill="#466b45"/>' +
      '<path d="M28 34 C28 24 24 14 18 6 C26 12 30 22 28 34 Z" fill="#7aa878"/>' +
      '<path d="M16 34 L40 34 L37 58 L19 58 Z" fill="#b3576e"/>' +
      '<path d="M14 34 L42 34 L42 40 L14 40 Z" fill="#8a4444"/>' +
      '</svg></div>';
  }

  /* ---------------- rendering: Home shelf ---------------- */

  function bookThumb(book) {
    if (book.cover_url) {
      return '<img src="' + esc(book.cover_url) + '" alt="Cover of ' + esc(book.title) + '" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
        '<span class="spine-fallback" style="display:none">' + esc(book.title) + '</span>';
    }
    return '<span class="spine-fallback">' + esc(book.title) + '</span>';
  }

  function renderHome() {
    var shelf = state.homeShelf;
    var books = state.books.filter(function (b) { return b.status === shelf; });
    ["tbr", "read", "dnf"].forEach(function (s) {
      var n = state.books.filter(function (b) { return b.status === s; }).length;
      var el = $("count-" + s);
      if (el) el.textContent = n ? "(" + n + ")" : "";
    });
    var area = $("shelfArea");
    if (!books.length) {
      area.innerHTML = "";
      return;
    }
    var html = '<div class="shelf-row">';
    books.forEach(function (book, i) {
      if (i > 0 && i % 5 === 0) html += plantSVG();
      var starCount = Math.max(0, Math.min(5, parseInt(book.stars, 10) || 0));
      var stars = starCount ? '<span class="book-stars">' + "★".repeat(starCount) + '</span>' : '';
      html += '<button class="book" type="button" data-book-id="' + esc(book.id) + '">' +
        bookThumb(book) +
        '<span class="book-title">' + esc(book.title) + '</span>' + stars + '</button>';
    });
    html += plantSVG() + "</div><div class='shelf-plank'></div>";
    area.innerHTML = html;
    area.querySelectorAll("[data-book-id]").forEach(function (btn) {
      btn.addEventListener("click", function () { openBook(btn.getAttribute("data-book-id")); });
    });
  }

  /* ---------------- rendering: Goal ---------------- */

  function renderGoal() {
    var y = yearNow();
    $("goalYear").textContent = y;
    var tbr = state.books.filter(function (b) { return b.status === "tbr"; }).length;
    var read = state.books.filter(function (b) { return b.status === "read" && b.finished_year === y; });
    $("statTbr").textContent = tbr;
    $("statGoal").textContent = state.goal;
    $("statRead").textContent = read.length;
    var left = Math.max(0, state.goal - read.length);
    $("goalLeft").textContent = state.goal > 0
      ? "You have " + left + " book" + (left === 1 ? "" : "s") + " left to complete your yearly reading goal."
      : "Set a goal number below and your shelf will fill in as you finish books.";
    $("goalInput").value = state.goal || "";
    var shelf = $("goalShelf");
    var plank = $("goalPlank");
    if (state.goal <= 0) {
      shelf.style.display = "none";
      if (plank) plank.style.display = "none";
      shelf.innerHTML = "";
      return;
    }
    shelf.style.display = "flex";
    if (plank) plank.style.display = "block";
    var html = "";
    read.forEach(function (book, i) {
      var color = SPINE_COLORS[i % SPINE_COLORS.length];
      html += '<button class="goal-spine" type="button" title="' + esc(book.title) + '" data-book-id="' + esc(book.id) + '" style="background:' + color + '"></button>';
    });
    for (var i = read.length; i < state.goal; i++) {
      html += '<span class="goal-spine empty">' + (i + 1) + '</span>';
    }
    shelf.innerHTML = html;
    shelf.querySelectorAll("[data-book-id]").forEach(function (btn) {
      btn.addEventListener("click", function () { openBook(btn.getAttribute("data-book-id")); });
    });
  }

  /* ---------------- rendering: Jar moods ---------------- */

  function allMoods() { return BUILTIN_MOODS.concat(state.customMoods); }

  function renderJar() {
    $("jarModeCopy").textContent = state.jarMode === "shelf"
      ? "This one picks from your own shelves. Pick one or more moods below, then tap the jar and it will shake out a book from your To Be Read shelf."
      : "This one looks outside your shelves. Pick one or more moods below, then tap the jar and it will suggest a book from Open Library that is not on any of your shelves.";
    $("modeShelfBtn").classList.toggle("active", state.jarMode === "shelf");
    $("modeSuggestBtn").classList.toggle("active", state.jarMode === "suggest");
    var chips = $("moodChips");
    var html = "";
    allMoods().forEach(function (mood) {
      var sel = state.pickedMoods.indexOf(mood) !== -1;
      html += '<button class="chip' + (sel ? " selected" : "") + '" type="button" data-mood="' + esc(mood) + '">' + esc(mood) + '</button>';
    });
    html += '<button class="chip' + (state.surprise ? " selected" : "") + '" type="button" data-mood="__surprise">Surprise me — any mood</button>';
    chips.innerHTML = html;
    chips.querySelectorAll("[data-mood]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var mood = btn.getAttribute("data-mood");
        if (mood === "__surprise") {
          state.surprise = !state.surprise;
          if (state.surprise) state.pickedMoods = [];
        } else {
          state.surprise = false;
          var i = state.pickedMoods.indexOf(mood);
          if (i === -1) state.pickedMoods.push(mood); else state.pickedMoods.splice(i, 1);
        }
        renderJar();
      });
    });
    var saved = $("savedMoods");
    if (!state.customMoods.length) { saved.innerHTML = ""; return; }
    saved.innerHTML = "<p class='muted small'><strong>My saved moods</strong></p>" + state.customMoods.map(function (m) {
      return '<div class="saved-mood-row"><span>' + esc(m) + '</span>' +
        '<button class="mini-btn" type="button" data-remove-mood="' + esc(m) + '">Remove</button></div>';
    }).join("");
    saved.querySelectorAll("[data-remove-mood]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await db.removeMood(btn.getAttribute("data-remove-mood"));
        renderJar();
      });
    });
  }

  /* ---------------- rendering: Log ---------------- */

  function renderLog() {
    var y = yearNow();
    $("logYear").textContent = y;
    var finished = state.books.filter(function (b) { return b.status === "read" && b.finished_year === y; });
    var finishedPages = finished.reduce(function (sum, b) { return sum + (b.pages || 0); }, 0);
    var yearSessions = state.sessions.filter(function (s) {
      return s.session_date && s.session_date.indexOf(String(y)) === 0;
    });
    var sp = yearSessions.reduce(function (sum, s) { return sum + (s.pages || 0); }, 0);
    var sc = yearSessions.reduce(function (sum, s) { return sum + (s.chapters || 0); }, 0);
    var sm = yearSessions.reduce(function (sum, s) { return sum + (s.minutes || 0); }, 0);
    $("logBooks").textContent = finished.length;
    $("logPages").textContent = finishedPages + sp;
    $("logChapters").textContent = sc;
    $("logMinutes").textContent = sm;
    $("logBreakdown").textContent = finishedPages + " pages from finished books + " + sp + " pages from sessions.";
    var sel = $("sessionBook");
    sel.innerHTML = '<option value="">Just a session (no book)</option>' + state.books.map(function (b) {
      return '<option value="' + esc(b.id) + '">' + esc(b.title) + '</option>';
    }).join("");
    var list = $("sessionList");
    if (!state.sessions.length) { list.innerHTML = '<p class="muted">No sessions logged yet.</p>'; return; }
    list.innerHTML = state.sessions.map(function (s) {
      var parts = [];
      if (s.pages) parts.push(s.pages + " pages");
      if (s.chapters) parts.push(s.chapters + " chapters");
      if (s.minutes) parts.push(s.minutes + " min");
      var book = s.book_id ? state.books.find(function (b) { return b.id === s.book_id; }) : null;
      var name = book ? book.title : (s.book_title || "Session");
      return '<div class="session-row"><span><strong>' + esc(name) + '</strong> — ' + esc(s.session_date || "") + ' · ' + parts.join(", ") + '</span>' +
        '<button class="mini-btn" type="button" data-del-session="' + esc(s.id) + '">Remove</button></div>';
    }).join("");
    list.querySelectorAll("[data-del-session]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await db.deleteSession(btn.getAttribute("data-del-session"));
        renderAll();
      });
    });
  }

  function renderAll() { renderHome(); renderGoal(); renderJar(); renderLog(); }

  /* ---------------- tabs & shelf switch ---------------- */

  function showPage(page) {
    state.page = page;
    document.querySelectorAll(".page").forEach(function (p) { p.classList.remove("active"); });
    $("page-" + page).classList.add("active");
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-page") === page);
    });
    window.scrollTo(0, 0);
  }

  /* ---------------- book detail / About modal ---------------- */

  function starRow(book) {
    var html = '<div class="stars-row">';
    for (var i = 1; i <= 5; i++) {
      html += '<button class="rate-btn' + ((book.stars || 0) >= i ? " selected" : "") + '" type="button" data-stars="' + i + '" aria-label="' + i + ' stars">&#9733;</button>';
    }
    return html + "</div>";
  }
  function spiceRow(book) {
    var html = '<div class="spice-row">';
    for (var i = 1; i <= 5; i++) {
      html += '<button class="rate-btn' + ((book.spice || 0) >= i ? " spice-selected" : "") + '" type="button" data-spice="' + i + '" aria-label="Spice level ' + i + '">' + i + '</button>';
    }
    return html + "</div>";
  }

  function openBook(id) {
    var book = state.books.find(function (b) { return b.id === id; });
    if (!book) return;
    state.currentModalBookId = id;
    state.currentPreview = null;
    renderModal(book, false);
    $("bookModal").classList.remove("hidden");
  }

  function openPreview(result) {
    state.currentModalBookId = null;
    state.currentPreview = result;
    var already = state.books.find(function (b) { return normKey(b.title, b.author) === normKey(result.title, result.author); });
    renderModal({
      id: null, title: result.title, author: result.author, year: result.year,
      cover_url: coverUrl(result.coverId, "L"), pages: result.pages,
      work_key: result.workKey, status: already ? already.status : null,
      tags: [], stars: null, spice: null, reread: null, notes: ""
    }, true, already);
    $("bookModal").classList.remove("hidden");
  }

  function openSuggestionPreview(book) {
    var already = state.books.find(function (b) { return normKey(b.title, b.author) === normKey(book.title, book.author); });
    var coverId = null;
    if (book.cover_url) {
      var m = book.cover_url.match(/\/b\/id\/(\d+)-/);
      if (m) coverId = m[1];
    }
    state.currentModalBookId = null;
    state.currentPreview = { title: book.title, author: book.author, year: book.year, pages: book.pages, coverId: coverId, workKey: book.work_key };
    renderModal({
      id: null, title: book.title, author: book.author, year: book.year,
      cover_url: book.cover_url, pages: book.pages,
      work_key: book.work_key, status: already ? already.status : null,
      tags: [], stars: null, spice: null, reread: null, notes: ""
    }, true, already);
    $("bookModal").classList.remove("hidden");
  }

  function closeModal() {
    $("bookModal").classList.add("hidden");
    state.currentModalBookId = null;
    state.currentPreview = null;
  }

  function renderModal(book, isPreview, already) {
    var c = $("modalContent");
    var tags = book.tags || [];
    var html = '<div class="modal-book">' +
      (book.cover_url ? '<img src="' + esc(book.cover_url) + '" alt="Cover of ' + esc(book.title) + '">' : "") +
      '<div class="modal-meta"><h2>' + esc(book.title) + '</h2>' +
      '<p class="muted">' + esc(book.author || "") + (book.year ? " · " + book.year : "") + (book.pages ? " · " + book.pages + " pages" : "") + '</p>' +
      (book.status ? '<p><strong>Shelf:</strong> ' + (book.status === "tbr" ? "To Be Read" : book.status === "read" ? "Read" : "DNF") + '</p>' : "") +
      "</div></div>" +
      '<div class="about-box"><h3>About this book</h3><p id="aboutText" class="muted">Loading the synopsis…</p></div>';

    if (isPreview) {
      html += already
        ? '<p class="muted">This book is already on your ' + (already.status === "tbr" ? "To Be Read" : already.status === "read" ? "Read" : "DNF") + ' shelf.</p>'
        : '<button id="previewAddBtn" class="btn-primary" type="button" style="margin-top:12px">Add to my TBR shelf</button>';
    } else {
      html += '<div class="status-row">' +
        '<button class="mini-btn" type="button" data-move="tbr">Move to TBR</button>' +
        '<button class="mini-btn" type="button" data-move="read">Mark as Read</button>' +
        '<button class="mini-btn" type="button" data-move="dnf">Mark as DNF</button></div>';
      html += '<h3>Your tags</h3><div class="tag-row">' + tags.map(function (t) {
        return '<button class="chip selected" type="button" data-untag="' + esc(t) + '">' + esc(t) + ' &times;</button>';
      }).join("") + "</div>" +
        '<div class="row"><input id="bookTagInput" type="text" placeholder="Add a mood tag, e.g. cozy">' +
        '<button id="bookTagAddBtn" class="btn-secondary" type="button">Add tag</button></div>';
      if (book.status === "read") {
        html += '<h3>Your rating</h3><p class="muted small">Stars</p>' + starRow(book) +
          '<p class="muted small">Spice level (1–5)</p>' + spiceRow(book) +
          '<p class="muted small">Would you read it again?</p><div class="reread-row">' +
          '<button class="mini-btn" type="button" data-reread="yes"' + (book.reread === "yes" ? ' style="background:var(--mahogany);color:#fff"' : "") + '>Yes</button>' +
          '<button class="mini-btn" type="button" data-reread="no"' + (book.reread === "no" ? ' style="background:var(--mahogany);color:#fff"' : "") + '>No</button></div>';
      }
      html += '<label class="field-label" for="bookNotes">Notes</label>' +
        '<textarea id="bookNotes" rows="3" placeholder="What did you think?">' + esc(book.notes || "") + '</textarea>' +
        '<button id="notesSaveBtn" class="btn-secondary" type="button" style="margin-top:8px">Save notes</button>' +
        '<div style="margin-top:14px"><button id="bookDeleteBtn" class="danger-btn" type="button">Remove this book</button></div>';
    }
    c.innerHTML = html;

    fetchSynopsis(book).then(function (syn) {
      var el = $("aboutText");
      if (el) el.textContent = syn || "No synopsis listed for this book in the catalogue.";
    });

    if (isPreview) {
      var addBtn = $("previewAddBtn");
      if (addBtn) addBtn.addEventListener("click", async function () {
        var r = state.currentPreview;
        var saved = await db.addBook({
          title: r.title, author: r.author, year: r.year,
          cover_url: coverUrl(r.coverId, "L"), pages: r.pages,
          work_key: r.workKey, status: "tbr", tags: []
        });
        if (!saved) return;
        closeModal(); renderAll();
      });
      return;
    }

    c.querySelectorAll("[data-move]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var to = btn.getAttribute("data-move");
        var patch = { status: to, finished_year: to === "read" ? yearNow() : null };
        await db.updateBook(book.id, patch);
        closeModal(); renderAll();
      });
    });
    c.querySelectorAll("[data-stars]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await db.updateBook(book.id, { stars: parseInt(btn.getAttribute("data-stars"), 10) });
        openBook(book.id); renderHome();
      });
    });
    c.querySelectorAll("[data-spice]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await db.updateBook(book.id, { spice: parseInt(btn.getAttribute("data-spice"), 10) });
        openBook(book.id); renderHome();
      });
    });
    c.querySelectorAll("[data-reread]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await db.updateBook(book.id, { reread: btn.getAttribute("data-reread") });
        openBook(book.id); renderHome();
      });
    });
    c.querySelectorAll("[data-untag]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var tag = btn.getAttribute("data-untag");
        var next = (book.tags || []).filter(function (t) { return t !== tag; });
        await db.updateBook(book.id, { tags: next });
        openBook(book.id); renderHome();
      });
    });
    $("bookTagAddBtn").addEventListener("click", async function () {
      var val = $("bookTagInput").value.trim().toLowerCase();
      if (!val) return;
      var tags = book.tags || [];
      if (tags.indexOf(val) === -1) tags.push(val);
      await db.updateBook(book.id, { tags: tags });
      openBook(book.id); renderHome();
    });
    $("notesSaveBtn").addEventListener("click", async function () {
      await db.updateBook(book.id, { notes: $("bookNotes").value });
      closeModal(); renderAll();
    });
    $("bookDeleteBtn").addEventListener("click", async function () {
      if (!confirm("Remove \"" + book.title + "\" from your shelves?")) return;
      await db.deleteBook(book.id);
      closeModal(); renderAll();
    });
  }

  /* ---------------- add a book: catalogue search + by hand ---------------- */

  var manualCoverData = "";
  $("manualCover").addEventListener("change", function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      manualCoverData = reader.result;
      var img = $("manualCoverPreview");
      img.src = manualCoverData;
      img.classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  });

  async function runSearch() {
    var q = $("searchInput").value.trim();
    if (!q) return;
    $("searchStatus").textContent = "Searching the catalogue…";
    $("searchResults").innerHTML = "";
    try {
      var results = await searchCatalogue(q, 15);
      if (!results.length) { $("searchStatus").textContent = "Nothing found. Try another title, or add it by hand below."; return; }
      $("searchStatus").textContent = results.length + " found. Tap About to read what it is about first, or Add to put it straight on your TBR shelf.";
      $("searchResults").innerHTML = results.map(function (r, i) {
        return '<div class="result-row">' +
          (r.coverId ? '<img src="' + coverUrl(r.coverId, "M") + '" alt="">' : "") +
          '<div class="result-info"><strong>' + esc(r.title) + '</strong>' +
          '<span>' + esc(r.author) + (r.year ? " · " + r.year : "") + (r.pages ? " · " + r.pages + " pages" : "") + '</span></div>' +
          '<div class="result-actions">' +
          '<button class="mini-btn" type="button" data-about="' + i + '">About</button>' +
          '<button class="mini-btn" type="button" data-add="' + i + '">Add</button></div></div>';
      }).join("");
      $("searchResults").querySelectorAll("[data-about]").forEach(function (btn) {
        btn.addEventListener("click", function () { openPreview(results[parseInt(btn.getAttribute("data-about"), 10)]); });
      });
      $("searchResults").querySelectorAll("[data-add]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var r = results[parseInt(btn.getAttribute("data-add"), 10)];
          var saved = await db.addBook({
            title: r.title, author: r.author, year: r.year,
            cover_url: coverUrl(r.coverId, "L"), pages: r.pages,
            work_key: r.workKey, status: "tbr", tags: []
          });
          if (!saved) return;
          btn.textContent = "Added ✓"; btn.disabled = true;
          renderAll();
        });
      });
    } catch (e) {
      $("searchStatus").textContent = "Search needs internet and did not go through. Check your connection and try again, or add the book by hand below.";
    }
  }

  /* ---------------- jar: shelf picks + new-book suggestions ---------------- */

  function shelvedKeys() {
    var set = {};
    state.books.forEach(function (b) { set[normKey(b.title, b.author)] = true; });
    return set;
  }

  function pickCardHTML(book, extra) {
    return '<div class="pick-card pick-tap" title="Tap to read About this book">' +
      (book.cover_url ? '<img src="' + esc(book.cover_url) + '" alt="">' : "") +
      '<div class="pick-info"><strong>' + esc(book.title) + '</strong>' +
      '<span class="muted">' + esc(book.author || "") + (book.year ? " · " + book.year : "") + (book.pages ? " · " + book.pages + " pages" : "") + '</span>' +
      (extra || "") + "</div></div>";
  }

  function jarButtonsHTML(mode) {
    var clearBtn = '<div style="margin-top:10px;text-align:center"><button id="clearPickBtn" class="mini-btn" type="button">Clear this pick &times;</button></div>';
    if (mode === "shelf") {
      return '<div class="row" style="margin-top:10px"><button id="shakeAgainBtn" class="btn-secondary" type="button">Shake again</button>' +
        '<button id="viewPickBtn" class="btn-primary" type="button">View book</button></div>' + clearBtn;
    }
    return '<div class="row" style="margin-top:10px"><button id="aboutPickBtn" class="btn-secondary" type="button">About this book</button>' +
      '<button id="addPickBtn" class="btn-primary" type="button">Add to my TBR shelf</button></div>' +
      '<div class="row" style="margin-top:10px"><button id="anotherPickBtn" class="btn-secondary" type="button">Another suggestion</button></div>' + clearBtn;
  }

  function showPick(book, mode, matchedTags, closest) {
    var extra = "";
    if (matchedTags && matchedTags.length) {
      extra = '<div style="margin-top:8px">' +
        (closest ? '<span class="closest-label">Closest match — </span>' : "") +
        matchedTags.map(function (t) { return '<span class="match-chip">' + esc(t) + '</span>'; }).join("") + "</div>";
    }
    $("jarResult").innerHTML = "<h3>The jar has spoken" + (matchedTags && matchedTags.length ? " — " + esc(matchedTags.join(", ")) : "") + "</h3>" +
      pickCardHTML(book, extra) + jarButtonsHTML(mode);
    var pickCard = $("jarResult").querySelector(".pick-card");
    if (pickCard) pickCard.addEventListener("click", function () {
      if (mode === "shelf") { closeModal(); openBook(book.id); }
      else { closeModal(); openSuggestionPreview(book); }
    });
    var clearBtn = $("clearPickBtn");
    if (clearBtn) clearBtn.addEventListener("click", function () { $("jarResult").innerHTML = ""; });
    if (mode === "shelf") {
      $("shakeAgainBtn").addEventListener("click", doShake);
      $("viewPickBtn").addEventListener("click", function () { closeModal(); openBook(book.id); });
    } else {
      $("aboutPickBtn").addEventListener("click", function () { closeModal(); openSuggestionPreview(book); });
      $("addPickBtn").addEventListener("click", async function () {
        var saved = await db.addBook({
          title: book.title, author: book.author, year: book.year,
          cover_url: book.cover_url, pages: book.pages,
          work_key: book.work_key, status: "tbr", tags: matchedTags || []
        });
        if (!saved) return;
        $("jarResult").innerHTML += '<p class="muted">Added to your TBR shelf.</p>';
        renderAll();
      });
      $("anotherPickBtn").addEventListener("click", doShake);
    }
  }

  function shelfPick() {
    var tbr = state.books.filter(function (b) { return b.status === "tbr"; });
    if (!tbr.length) {
      $("jarResult").innerHTML = '<p class="muted">Your To Be Read shelf is empty, so the jar has nothing to pick from yet. Add a book first, or switch to Suggest something new.</p>';
      return;
    }
    var pool = tbr;
    if (!state.surprise && state.pickedMoods.length) {
      pool = tbr.filter(function (b) {
        var tags = (b.tags || []).map(function (t) { return t.toLowerCase(); });
        return state.pickedMoods.some(function (m) { return tags.indexOf(m.toLowerCase()) !== -1; });
      });
    }
    if (!pool.length) {
      $("jarResult").innerHTML = '<p class="muted">Nothing on your To Be Read shelf matches ' +
        esc(state.pickedMoods.join(", ")) + '.</p>' +
        '<button id="fallbackSuggestBtn" class="btn-primary" type="button">Suggest a new book for these moods instead</button>';
      $("fallbackSuggestBtn").addEventListener("click", function () {
        state.jarMode = "suggest";
        renderJar();
        doShake();
      });
      return;
    }
    var book = pool[Math.floor(Math.random() * pool.length)];
    showPick(book, "shelf", null, false);
  }

  function tagMatchesIn(haystack, tag) {
    var t = tag.toLowerCase();
    if (haystack.indexOf(t) !== -1) return true;
    var words = t.split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) return false;
    return words.every(function (w) { return haystack.indexOf(w) !== -1; });
  }

  async function suggestPick() {
    var tags = state.pickedMoods.slice();
    if (state.surprise || !tags.length) {
      tags = allMoods();
      var tag = tags[Math.floor(Math.random() * tags.length)];
      tags = [tag];
    }
    $("jarStatus").textContent = "Searching the catalogue for " + tags.join(", ") + "…";
    var shelved = shelvedKeys();
    var pool = [];
    try {
      var searches = await Promise.all(tags.map(function (tag) {
        return searchCatalogue(tag, 30).catch(function () { return []; });
      }));
      searches.forEach(function (results) {
        results.forEach(function (r) {
          var key = normKey(r.title, r.author);
          if (shelved[key] || state.shownSuggestions[key]) return;
          var hay = ((r.title || "") + " " + r.author + " " + (r.subjects || []).join(" ")).toLowerCase();
          var matched = tags.filter(function (tag) { return tagMatchesIn(hay, tag); });
          if (!matched.length) return;
          pool.push({ book: r, matched: matched, score: matched.length });
        });
      });
    } catch (e) { /* fall through to the no-results message */ }
    $("jarStatus").textContent = "";
    if (!pool.length) {
      $("jarResult").innerHTML = '<p class="muted">Nothing in the catalogue matched ' + esc(tags.join(", ")) +
        ' that is not already on your shelves. Try different moods, or fewer of them at once.</p>';
      return;
    }
    var best = Math.max.apply(null, pool.map(function (p) { return p.score; }));
    var top = pool.filter(function (p) { return p.score === best; });
    var pick = top[Math.floor(Math.random() * top.length)];
    state.shownSuggestions[normKey(pick.book.title, pick.book.author)] = true;
    var book = {
      title: pick.book.title, author: pick.book.author, year: pick.book.year,
      cover_url: coverUrl(pick.book.coverId, "L"), pages: pick.book.pages,
      work_key: pick.book.workKey
    };
    showPick(book, "suggest", pick.matched, best < tags.length);
  }

  function doShake() {
    if (state.jarMode === "shelf" && !state.surprise && !state.pickedMoods.length) {
      $("jarResult").innerHTML = '<p class="muted">Pick a mood first, or tap Surprise me — any mood, then shake the jar.</p>';
      return;
    }
    var jar = $("jarGraphic");
    jar.classList.remove("shaking");
    void jar.offsetWidth;
    jar.classList.add("shaking");
    $("jarResult").innerHTML = '<p class="muted">Shaking…</p>';
    setTimeout(function () {
      if (state.jarMode === "shelf") shelfPick(); else suggestPick();
    }, 650);
  }

  /* ---------------- wiring ---------------- */

  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { showPage(btn.getAttribute("data-page")); });
  });
  document.querySelectorAll(".shelf-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".shelf-tab").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      state.homeShelf = btn.getAttribute("data-shelf");
      renderHome();
    });
  });
  $("addBookBtn").addEventListener("click", function () { $("addPanel").classList.toggle("hidden"); });
  $("searchBtn").addEventListener("click", runSearch);
  $("searchInput").addEventListener("keydown", function (e) { if (e.key === "Enter") runSearch(); });
  $("manualAddBtn").addEventListener("click", async function () {
    var title = $("manualTitle").value.trim();
    if (!title) { alert("Add a title first."); return; }
    var saved = await db.addBook({
      title: title, author: $("manualAuthor").value.trim() || "Unknown author",
      year: parseInt($("manualYear").value, 10) || null,
      pages: parseInt($("manualPages").value, 10) || null,
      cover_url: manualCoverData || "", status: "tbr", tags: []
    });
    if (!saved) return;
    $("manualTitle").value = ""; $("manualAuthor").value = "";
    $("manualYear").value = ""; $("manualPages").value = "";
    $("manualCover").value = ""; manualCoverData = "";
    $("manualCoverPreview").classList.add("hidden");
    $("addPanel").classList.add("hidden");
    renderAll();
  });
  $("modeShelfBtn").addEventListener("click", function () { state.jarMode = "shelf"; renderJar(); });
  $("modeSuggestBtn").addEventListener("click", function () { state.jarMode = "suggest"; renderJar(); });
  $("addMoodBtn").addEventListener("click", async function () {
    var val = $("customMoodInput").value.trim();
    if (!val) return;
    await db.addMood(val);
    if (state.pickedMoods.indexOf(val.toLowerCase()) === -1) state.pickedMoods.push(val.toLowerCase());
    $("customMoodInput").value = "";
    renderJar();
  });
  $("shakeBtn").addEventListener("click", doShake);
  $("jarGraphic").addEventListener("click", doShake);
  $("jarGraphic").addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") doShake(); });
  $("goalSaveBtn").addEventListener("click", async function () {
    var n = parseInt($("goalInput").value, 10);
    if (isNaN(n) || n < 0) return;
    await db.setGoal(n);
    renderGoal();
  });
  $("sessionDate").value = todayStr();
  $("sessionSaveBtn").addEventListener("click", async function () {
    var pages = parseInt($("sessionPages").value, 10) || 0;
    var chapters = parseInt($("sessionChapters").value, 10) || 0;
    var minutes = parseInt($("sessionMinutes").value, 10) || 0;
    if (!pages && !chapters && !minutes) { alert("Add pages, chapters, or minutes first."); return; }
    var bookId = $("sessionBook").value || null;
    var book = bookId ? state.books.find(function (b) { return b.id === bookId; }) : null;
    await db.addSession({
      book_id: bookId, book_title: book ? book.title : null,
      pages: pages, chapters: chapters, minutes: minutes,
      session_date: $("sessionDate").value || todayStr()
    });
    $("sessionPages").value = ""; $("sessionChapters").value = ""; $("sessionMinutes").value = "";
    renderAll();
  });
  $("modalClose").addEventListener("click", closeModal);
  $("bookModal").addEventListener("click", function (e) { if (e.target === $("bookModal")) closeModal(); });

  /* ---------------- go ---------------- */

  db.loadAll().then(function () { renderAll(); });
})();
