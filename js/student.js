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
    loadClasses();
    loadLessons();
  }

  /* ---------- My lessons and the Absence Form ---------- */
  var STATUS = {
    scheduled: "Scheduled", attended: "Attended", late: "Late", absent_approved: "Approved absence",
    absent_unapproved: "Unapproved absence", absent_emergency: "Emergency absence", cancelled: "Cancelled"
  };
  var DAY = 24 * 3600 * 1000;
  var myLessons = [], myAttendance = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fmtWhen(iso, mins) {
    var d = new Date(iso), end = new Date(d.getTime() + mins * 60000);
    var loc = document.documentElement.lang === "my" ? "my-MM" : undefined;
    return d.toLocaleDateString(loc, { weekday: "short", day: "numeric", month: "short" }) + " · " +
      d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" }) + "–" +
      end.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  }
  function monthStart() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01";
  }

  function loadLessons() {
    var now = Date.now();
    return Promise.all([
      rpc("student_lessons", { p_from: new Date(now - 35 * DAY).toISOString(), p_to: new Date(now + 60 * DAY).toISOString() }, true),
      rpc("student_attendance", { p_month: monthStart() }, true)
    ]).then(function (res) {
      myLessons = res[0] || [];
      myAttendance = res[1];
      renderLessons();
    }).catch(function (err) { if (err.message !== "signed out") console.error(err); });
  }

  function lessonCard(l, upcoming) {
    var card = el("article", "card lesson-row");
    var main = el("div", "lesson-main");
    var left = el("div");
    left.appendChild(el("strong", "lesson-when", fmtWhen(l.starts_at, l.duration_min)));
    left.appendChild(el("span", "lesson-who", l.subject + " · " + t("Teacher") + ": " + l.teacher_name));
    var side = el("div", "lesson-side");
    side.appendChild(el("span", "status-pill lesson-" + l.status, t(STATUS[l.status] || l.status)));
    var start = new Date(l.starts_at).getTime(), end = start + l.duration_min * 60000;
    if (upcoming && l.status === "scheduled" && /^https:\/\/[^\s<>"]+$/i.test(l.class_link || "")) {
      var a = el("a", "btn btn--gold btn--sm", t("Join class"));
      a.href = l.class_link; a.target = "_blank"; a.rel = "noopener";
      side.appendChild(a);
    }
    main.appendChild(left);
    main.appendChild(side);
    card.appendChild(main);
    if (l.makeup_for) card.appendChild(el("span", "small-note lesson-tag", t("Make-up lesson")));
    if (l.absence_reason) card.appendChild(el("p", "lesson-reason small-note", t("Your reason") + ": " + l.absence_reason));
    if (l.teacher_note) {
      card.appendChild(el("span", "small-note lesson-tag", t("Note from your teacher")));
      card.appendChild(el("p", "lesson-note", l.teacher_note));
    }

    // The Absence Form: only for lessons that haven't finished and aren't marked yet.
    if (upcoming && l.status === "scheduled" && end > Date.now()) {
      var btn = el("button", "btn btn--outline btn--sm", t("I can't attend"));
      btn.type = "button";
      btn.addEventListener("click", function () { btn.replaceWith(absenceForm(l, start)); });
      card.appendChild(btn);
    }
    return card;
  }

  function absenceForm(l, start) {
    var early = start - Date.now() >= DAY;
    var f = el("form", "absence-form");
    f.noValidate = true;
    f.appendChild(el("p", null, early
      ? t("You are telling us 24 hours or more before the lesson, so this is an approved absence (maximum 2 per month).")
      : t("This lesson is less than 24 hours away, so it is an unapproved absence unless it is an emergency.")));
    var id = "abs-" + l.id;
    var lab = el("label", null, t("Reason"));
    lab.htmlFor = id;
    var reason = el("textarea");
    reason.id = id; reason.rows = 2; reason.maxLength = 500; reason.required = true;
    f.appendChild(lab); f.appendChild(reason);
    var emergency = null;
    if (!early) {
      var emLab = el("label", "consent");
      emergency = el("input");
      emergency.type = "checkbox";
      emLab.appendChild(emergency);
      emLab.appendChild(el("span", null, t("This is an emergency (illness, family emergency, internet or power problem)")));
      f.appendChild(emLab);
    }
    var err = el("p", "admin-error");
    err.hidden = true;
    f.appendChild(err);
    var row = el("div", "btn-row");
    var send = el("button", "btn btn--gold btn--sm", t("Send"));
    send.type = "submit";
    var back = el("button", "btn btn--outline btn--sm", t("Back"));
    back.type = "button";
    back.addEventListener("click", renderLessons);
    row.appendChild(send); row.appendChild(back);
    f.appendChild(row);
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (reason.value.trim().length < 3) { err.textContent = t("Please write the reason."); err.hidden = false; return; }
      send.disabled = true;
      rpc("student_report_absence", { p_lesson_id: l.id, p_reason: reason.value.trim(), p_emergency: !!(emergency && emergency.checked) }, true)
        .then(function (res) {
          if (!res || res.error) { err.textContent = t((res && res.error) || "Could not send. Please try again."); err.hidden = false; return; }
          loadLessons();
        }).catch(function (e) {
          if (e.message !== "signed out") { err.textContent = t("Could not send. Please try again."); err.hidden = false; }
        }).then(function () { send.disabled = false; });
    });
    setTimeout(function () { reason.focus(); }, 0);
    return f;
  }

  function renderLessons() {
    var now = Date.now();
    // Upcoming = not finished yet (a cancelled future lesson stays here so the student sees it is off).
    var upcoming = myLessons.filter(function (l) {
      return new Date(l.starts_at).getTime() + l.duration_min * 60000 > now;
    });
    var recent = myLessons.filter(function (l) {
      return new Date(l.starts_at).getTime() + l.duration_min * 60000 <= now;
    }).reverse().slice(0, 10);
    $("#s-lessons").hidden = !myLessons.length;

    var line = $("#s-attendance");
    line.replaceChildren();
    if (myAttendance && myAttendance.counted) {
      var r = Number(myAttendance.rate);
      line.appendChild(el("span", "status-pill " + (r >= 80 ? "status-active" : r >= 75 ? "status-payment-pending" : "status-payment-failed"), r + "%"));
      line.appendChild(el("span", null, t("Attendance this month") + ": " + myAttendance.attended + " / " + myAttendance.counted +
        " · " + t("Keep at least 80%.")));
    } else {
      line.appendChild(el("span", null, t("Attendance this month") + ": —"));
    }

    var up = $("#s-upcoming");
    up.replaceChildren.apply(up, upcoming.length ? upcoming.map(function (l) { return lessonCard(l, true); })
                                                 : [el("p", "small-note", t("No upcoming lessons yet."))]);
    var rc = $("#s-recent");
    rc.replaceChildren.apply(rc, recent.length ? recent.map(function (l) { return lessonCard(l, false); })
                                               : [el("p", "small-note", t("No lessons yet."))]);
  }

  /* ---------- My classes (teachers and class links, set in the admin and teacher portals) ---------- */
  var classes = [];
  function loadClasses() {
    rpc("student_my_teachers", {}, true).then(function (rows) {
      classes = rows || [];
      renderClasses();
    }).catch(function (err) { if (err.message !== "signed out") console.error(err); });
  }
  function renderClasses() {
    var box = $("#s-class-list");
    $("#s-classes").hidden = !classes.length;
    box.replaceChildren.apply(box, classes.map(function (c) {
      var row = document.createElement("div");
      row.className = "class-row";
      var text = document.createElement("div");
      var subject = document.createElement("strong");
      subject.textContent = c.subject;
      var teacher = document.createElement("span");
      teacher.className = "small-note";
      teacher.textContent = t("Teacher") + ": " + c.teacher_name;
      text.appendChild(subject);
      text.appendChild(teacher);
      row.appendChild(text);
      if (/^https:\/\/[^\s<>"]+$/i.test(c.class_link || "")) {
        var a = document.createElement("a");
        a.className = "btn btn--gold btn--sm";
        a.href = c.class_link;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = t("Join class");
        row.appendChild(a);
      } else {
        var none = document.createElement("span");
        none.className = "small-note";
        none.textContent = t("Class link coming soon");
        row.appendChild(none);
      }
      return row;
    }));
  }

  // Re-write the greeting when the language is switched (main.js handles the fixed text).
  document.querySelectorAll(".lang-switch").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (me && !$("#s-dash").hidden) {
        $("#s-hello").textContent = t("Hello") + ", " + me.student_name;
        $("#s-who").textContent = t("Student ID") + ": " + me.student_id;
        renderClasses();
        renderLessons();
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
