/* Hope Education — student portal (student.html)

   Students sign in on login.html with their Student ID and password (created when
   an admin accepts their payment; see supabase/004_students.sql). This page sends
   them there if they are not signed in, and to the main website when they sign out.
   The 12-hour session token is sent with every request in the "x-student-token" header.
   The chat is checked for new messages every few seconds.

   Security note: chat messages and names are shown with textContent only,
   never as HTML, so nothing typed into the chat can run code. */
(function () {
  "use strict";

  var CFG = window.HOPE_SUPABASE;
  var SESSION_KEY = "hope-student-session";
  var POLL_MS = 4000;

  var session = null;
  var me = null;
  var lastId = 0;
  var lastDay = "";
  var pollTimer = null;

  function $(sel) { return document.querySelector(sel); }
  /* Translate a fixed message when the page is in Burmese. */
  function t(text) {
    return (document.documentElement.lang === "my" && window.HOPE_MY && window.HOPE_MY[text]) || text;
  }

  /* ---------- Session ---------- */
  function saveSession(s) {
    session = s;
    try { if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); else sessionStorage.removeItem(SESSION_KEY); }
    catch (e) { /* storage unavailable */ }
  }
  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; }
  }

  /* Call a database function. With a session, the student's token is sent too. */
  function rpc(name, args, useSession) {
    var headers = { apikey: CFG.publishableKey, "Content-Type": "application/json" };
    if (useSession) {
      if (!session || new Date(session.expires_at).getTime() < Date.now()) {
        signOutLocal(t("Your session has ended. Please sign in again."));
        return Promise.reject(new Error("signed out"));
      }
      headers["x-student-token"] = session.token;
    }
    return fetch(CFG.url + "/rest/v1/rpc/" + name, {
      method: "POST", headers: headers, body: JSON.stringify(args || {})
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        if (!r.ok) {
          if (useSession && (r.status === 401 || r.status === 403)) {
            signOutLocal(t("Your session has ended. Please sign in again."));
            throw new Error("signed out");
          }
          throw new Error((data && data.message) || "Request failed");
        }
        return data;
      });
    });
  }

  /* ---------- Views ---------- */
  function show(view) {
    ["#s-change", "#s-dash"].forEach(function (id) { $(id).hidden = id !== view; });
    if (view === "#s-dash") startPolling(); else stopPolling();
  }

  function showError(sel, msg) {
    var el = $(sel);
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  /* Not signed in (or the session ended): go to the sign-in page. */
  function signOutLocal(message) {
    saveSession(null);
    me = null;
    stopPolling();
    location.replace("login.html?role=student" + (message ? "&ended=1" : ""));
  }

  /* Sign out: end the session on the server, then go back to the main website. */
  function signOut(ev) {
    var token = session && session.token;
    if (ev && ev.target) ev.target.disabled = true;
    saveSession(null);
    me = null;
    stopPolling();
    var done = function () { location.replace("index.html"); };
    if (!token) { done(); return; }
    fetch(CFG.url + "/rest/v1/rpc/student_logout", {
      method: "POST",
      keepalive: true,
      headers: { apikey: CFG.publishableKey, "x-student-token": token, "Content-Type": "application/json" },
      body: "{}"
    }).catch(function () { /* it also expires on its own */ }).then(done);
  }

  function enterPortal() {
    if (me.must_change_password) {
      $("#s-pw-current").value = "";
      $("#s-change-intro").hidden = false;
      $("#s-change-cancel").hidden = true;
      $("#s-change-signout").hidden = false;
      showError("#s-change-error", "");
      show("#s-change");
      $("#s-pw-current").focus();
      return;
    }
    $("#s-hello").textContent = t("Hello") + ", " + me.student_name;
    $("#s-who").textContent = t("Student ID") + ": " + me.student_id;
    show("#s-dash");
  }

  // Re-write the greeting when the language is switched (main.js handles the fixed text).
  document.querySelectorAll(".lang-switch").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (me && !$("#s-dash").hidden) {
        $("#s-hello").textContent = t("Hello") + ", " + me.student_name;
        $("#s-who").textContent = t("Student ID") + ": " + me.student_id;
      }
    });
  });

  $("#s-sign-out").addEventListener("click", signOut);
  $("#s-change-signout").addEventListener("click", signOut);

  /* ---------- Change password ---------- */
  $("#s-open-change").addEventListener("click", function () {
    $("#s-pw-current").value = "";
    $("#s-change-intro").hidden = true;
    $("#s-change-cancel").hidden = false;
    $("#s-change-signout").hidden = true;
    showError("#s-change-error", "");
    show("#s-change");
    $("#s-pw-current").focus();
  });
  $("#s-change-cancel").addEventListener("click", function () { enterPortal(); });

  $("#s-change-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var cur = $("#s-pw-current").value, pw1 = $("#s-pw-new").value, pw2 = $("#s-pw-confirm").value;
    if (pw1.length < 8) { showError("#s-change-error", t("The new password must be at least 8 characters.")); return; }
    if (pw1 !== pw2) { showError("#s-change-error", t("The two new passwords do not match.")); return; }
    var btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    rpc("student_change_password", { p_current: cur, p_new: pw1 }, true)
      .then(function (res) {
        if (!res || res.error) { showError("#s-change-error", t((res && res.error) || "Could not save the password.")); return; }
        me.must_change_password = false;
        ["#s-pw-current", "#s-pw-new", "#s-pw-confirm"].forEach(function (s) { $(s).value = ""; });
        enterPortal();
      })
      .catch(function (err) { if (err.message !== "signed out") showError("#s-change-error", t("Could not save the password.")); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Chat ---------- */
  var list = $("#chat-list");

  function dayLabel(d) {
    return d.toLocaleDateString(document.documentElement.lang === "my" ? "my-MM" : undefined,
      { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }

  function addMessage(m) {
    var d = new Date(m.created_at);
    var day = d.toDateString();
    if (day !== lastDay) {
      var sep = document.createElement("div");
      sep.className = "chat-day";
      sep.textContent = dayLabel(d);
      list.appendChild(sep);
      lastDay = day;
    }
    var wrap = document.createElement("div");
    wrap.className = "chat-msg" + (m.mine ? " mine" : "");
    if (!m.mine) {
      var who = document.createElement("span");
      who.className = "who";
      who.textContent = m.sender_name;
      wrap.appendChild(who);
    }
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.body;
    var when = document.createElement("span");
    when.className = "when";
    when.textContent = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    wrap.appendChild(bubble);
    wrap.appendChild(when);
    list.appendChild(wrap);
    lastId = Math.max(lastId, m.id);
  }

  function nearBottom() { return list.scrollHeight - list.scrollTop - list.clientHeight < 80; }

  function loadNew(forceScroll) {
    if (!session) return Promise.resolve();
    var stick = forceScroll || nearBottom() || lastId === 0;
    return rpc("student_chat_list", { p_after_id: lastId }, true).then(function (rows) {
      if (lastId === 0 && (!rows || !rows.length) && !list.children.length) {
        var empty = document.createElement("p");
        empty.className = "empty-state";
        empty.id = "chat-empty";
        empty.textContent = t("No messages yet. Say hello!");
        list.appendChild(empty);
      }
      if (rows && rows.length) {
        var e = $("#chat-empty"); if (e) e.remove();
        rows.forEach(addMessage);
        if (stick) list.scrollTop = list.scrollHeight;
      }
      showError("#chat-error", "");
    }).catch(function (err) {
      if (err.message !== "signed out") showError("#chat-error", t("Could not load new messages. Retrying…"));
    });
  }

  function startPolling() {
    stopPolling();
    loadNew(true);
    pollTimer = setInterval(function () {
      if (document.visibilityState === "visible") loadNew(false);
    }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && pollTimer) loadNew(false);
  });

  var input = $("#chat-input");
  $("#chat-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = input.value.trim();
    if (!body) return;
    var btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    rpc("student_chat_send", { p_body: body }, true).then(function (res) {
      if (!res || res.error) { showError("#chat-error", t((res && res.error) || "Could not send. Please try again.")); return; }
      input.value = "";
      input.style.height = "";
      return loadNew(true);
    }).catch(function (err) {
      if (err.message !== "signed out") showError("#chat-error", t("Could not send. Please try again."));
    }).then(function () { btn.disabled = false; input.focus(); });
  });

  // Enter sends, Shift+Enter makes a new line; the box grows with the text.
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#chat-form").requestSubmit();
    }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });

  /* ---------- Start ---------- */
  session = readSession();
  if (session && session.token) {
    rpc("student_me", {}, true).then(function (info) {
      if (!info || !info.student_id) { signOutLocal("ended"); return; }
      me = info;
      enterPortal();
    }).catch(function (err) { if (err.message !== "signed out") signOutLocal("ended"); });
  } else {
    signOutLocal();   // not signed in: go to the sign-in page
  }
})();
