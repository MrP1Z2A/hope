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
    if (view !== "#s-dash") { stopPolling(); if (messages) messages.stop(); }
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
    switchTab(currentTab);
    loadCounts();
  }

  /* ---------- Tabs ---------- */
  var currentTab = "lessons";
  var messages = null;   // private messages with teachers (js/portal-messages.js)
  var countsTimer = null;

  function switchTab(name) {
    currentTab = name;
    document.querySelectorAll(".admin-tabs [data-tab]").forEach(function (b) {
      b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false");
    });
    document.querySelectorAll(".admin-panel").forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    if (name === "chat") startPolling(); else stopPolling();
    if (name !== "messages" && messages) messages.stop();
    if (name === "lessons") { loadClasses(); loadLessons(); loadRequestForm(); }
    else if (name === "homework") { loadHomework(); loadNotes(); }
    else if (name === "messages") messages.load();
    else if (name === "attendance") loadMonth();
  }
  document.querySelectorAll(".admin-tabs [data-tab]").forEach(function (b) {
    b.addEventListener("click", function () { switchTab(b.dataset.tab); });
  });

  function setCount(sel, n) { var c = $(sel); c.textContent = n; c.hidden = !n; }
  function loadCounts() {
    if (!me || $("#s-dash").hidden) return;
    rpc("student_counts", {}, true).then(function (c) {
      setCount("#c-homework", c.homework_due);
      setCount("#c-messages", c.unread);
    }).catch(function () { /* badges only */ });
    clearTimeout(countsTimer);
    countsTimer = setTimeout(loadCounts, 30000);
  }

  var toastTimer;
  function toast(msg, isError) {
    var e = $("#toast");
    e.textContent = msg;
    e.classList.toggle("is-error", !!isError);
    e.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { e.hidden = true; }, isError ? 8000 : 4000);
  }

  /* ---------- Request a lesson ---------- */
  var myClasses = [], makeupOptions = [], myRequests = [];
  var REQUEST_STATUS = { pending: "Waiting for your teacher", accepted: "Accepted", declined: "Declined", withdrawn: "Withdrawn" };

  function loadRequestForm() {
    return Promise.all([
      rpc("student_classes", {}, true),
      rpc("student_makeup_options", {}, true),
      rpc("student_requests", {}, true)
    ]).then(function (res) {
      myClasses = res[0] || []; makeupOptions = res[1] || []; myRequests = res[2] || [];
      renderRequestForm();
      renderRequests();
    }).catch(function (err) { if (err.message !== "signed out") console.error(err); });
  }

  function renderRequestForm() {
    $("#rq-card").hidden = !myClasses.length;
    var cls = $("#rq-class"), keep = cls.value;
    cls.replaceChildren.apply(cls, myClasses.map(function (c) {
      var o = el("option", null, c.subject + " – " + c.teacher_name);
      o.value = String(c.assignment_id);
      return o;
    }));
    if (keep && cls.querySelector('option[value="' + keep + '"]')) cls.value = keep;
    renderMakeupSelect();
  }
  function renderMakeupSelect() {
    var sel = $("#rq-makeup"), keep = sel.value;
    var none = el("option", null, t("Not a make-up lesson"));
    none.value = "";
    var opts = [none].concat(makeupOptions.filter(function (m) { return String(m.assignment_id) === $("#rq-class").value; })
      .map(function (m) {
        var o = el("option", null, fmtWhen(m.starts_at, 90).split(" · ")[0] + " · " + t(RULE[m.rule] || m.rule));
        o.value = String(m.lesson_id);
        return o;
      }));
    sel.replaceChildren.apply(sel, opts);
    if (keep && sel.querySelector('option[value="' + keep + '"]')) sel.value = keep;
  }
  $("#rq-class").addEventListener("change", renderMakeupSelect);

  function renderRequests() {
    var box = $("#rq-list");
    if (!myRequests.length) { box.replaceChildren(el("p", "small-note", t("No requests yet."))); return; }
    box.replaceChildren.apply(box, myRequests.map(function (r) {
      var card = el("article", "card lesson-row");
      var main = el("div", "lesson-main");
      var left = el("div");
      left.appendChild(el("strong", "lesson-when", fmtWhen(r.starts_at, r.duration_min)));
      left.appendChild(el("span", "lesson-who", r.subject + " · " + t("Teacher") + ": " + r.teacher_name +
        (r.makeup_for ? " · " + t("Make-up lesson") : "")));
      main.appendChild(left);
      main.appendChild(el("span", "status-pill request-" + r.status, t(REQUEST_STATUS[r.status])));
      card.appendChild(main);
      if (r.message) card.appendChild(el("p", "lesson-reason small-note", t("Your message") + ": " + r.message));
      if (r.reply) {
        card.appendChild(el("span", "small-note lesson-tag", t("Reply from your teacher")));
        card.appendChild(el("p", "lesson-note", r.reply));
      }
      if (r.status === "pending") {
        var b = el("button", "btn btn--outline btn--sm", t("Withdraw request"));
        b.type = "button";
        b.addEventListener("click", function () {
          b.disabled = true;
          rpc("student_withdraw_request", { p_request_id: r.id }, true).then(function (res) {
            if (!res || res.error) { toast(t((res && res.error) || "Could not save."), true); return; }
            loadRequestForm();
          }).catch(function (err) { if (err.message !== "signed out") toast(t("Could not save."), true); })
            .then(function () { b.disabled = false; });
        });
        card.appendChild(b);
      }
      return card;
    }));
  }

  $("#rq-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var date = $("#rq-date").value, time = $("#rq-time").value;
    if (!$("#rq-class").value) { toast(t("Choose a class."), true); return; }
    if (!date || !time) { toast(t("Choose the date and start time."), true); return; }
    var when = new Date(date + "T" + time);
    if (isNaN(when.getTime())) { toast(t("Choose the date and start time."), true); return; }
    if (when.getTime() < Date.now() + 12 * 3600e3) { toast(t("Ask for a time at least 12 hours from now."), true); return; }
    var btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    rpc("student_request_lesson", { p_assignment_id: Number($("#rq-class").value), p_starts_at: when.toISOString(),
      p_makeup_for: $("#rq-makeup").value ? Number($("#rq-makeup").value) : null, p_message: $("#rq-message").value.trim() }, true)
      .then(function (res) {
        if (!res || res.error) { toast(t((res && res.error) || "Could not send. Please try again."), true); return; }
        toast(t("Request sent. Your teacher will answer here."));
        $("#rq-message").value = ""; $("#rq-makeup").value = "";
        loadRequestForm();
      }).catch(function (err) { if (err.message !== "signed out") toast(t("Could not send. Please try again."), true); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Homework ---------- */
  var homework = [], notes = [];
  var HW_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf", "application/msword",
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

  function loadHomework() {
    return rpc("student_homework", {}, true).then(function (rows) { homework = rows || []; renderHomework(); })
      .catch(function (err) { if (err.message !== "signed out") console.error(err); });
  }
  function loadNotes() {
    return rpc("student_notes", {}, true).then(function (rows) { notes = rows || []; renderNotes(); })
      .catch(function (err) { if (err.message !== "signed out") console.error(err); });
  }

  /* Open one of my homework files (a private link that works for 10 minutes). */
  function openFile(path) {
    fetch(CFG.url + "/storage/v1/object/sign/homework-files/" + path.split("/").map(encodeURIComponent).join("/"), {
      method: "POST",
      headers: { apikey: CFG.publishableKey, "x-student-token": session.token, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 600 })
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("sign")); })
      .then(function (res) { window.open(CFG.url + "/storage/v1" + (res.signedURL || res.signedUrl), "_blank", "noopener"); })
      .catch(function () { toast(t("Could not open the file."), true); });
  }

  function uploadHomeworkFile(file) {
    var ext = (file.name.split(".").pop() || "file").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "file";
    var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2);
    var path = me.student_id + "/" + id + "." + ext;
    return fetch(CFG.url + "/storage/v1/object/homework-files/" + path, {
      method: "POST",
      headers: { apikey: CFG.publishableKey, "x-student-token": session.token,
                 "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" },
      body: file
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (txt) { throw new Error("upload " + r.status + " " + txt); });
      return path;
    });
  }

  function homeworkCard(hw) {
    var card = el("article", "card lesson-row");
    var main = el("div", "lesson-main");
    var left = el("div");
    left.appendChild(el("strong", "lesson-when", hw.title));
    left.appendChild(el("span", "lesson-who", hw.subject + " · " + t("Teacher") + ": " + hw.teacher_name +
      (hw.due_at ? " · " + t("Due") + " " + fmtWhen(hw.due_at, 0).split(" · ")[0] : "")));
    main.appendChild(left);
    var state = hw.reviewed_at ? ["Reviewed", "status-active"] : hw.submitted_at ? ["Handed in", "status-payment-pending"]
              : (hw.due_at && new Date(hw.due_at).getTime() < Date.now()) ? ["Late", "status-payment-failed"] : ["To do", ""];
    main.appendChild(el("span", "status-pill " + state[1], t(state[0])));
    card.appendChild(main);
    if (hw.details) card.appendChild(el("p", "lesson-note", hw.details));

    if (hw.submitted_at) {
      card.appendChild(el("span", "small-note lesson-tag", t("Your answer")));
      if (hw.body) card.appendChild(el("p", "lesson-reason", hw.body));
      if (hw.file_path) {
        var fb = el("button", "btn-link", "📎 " + (hw.file_name || t("Attached file")));
        fb.type = "button";
        fb.addEventListener("click", function () { openFile(hw.file_path); });
        card.appendChild(fb);
      }
    }
    if (hw.feedback) {
      card.appendChild(el("span", "small-note lesson-tag", t("Feedback from your teacher")));
      card.appendChild(el("p", "lesson-note", hw.feedback));
    }
    if (!hw.reviewed_at) {
      var open = el("button", "btn btn--outline btn--sm", t(hw.submitted_at ? "Change my answer" : "Hand in"));
      open.type = "button";
      open.addEventListener("click", function () { open.replaceWith(homeworkForm(hw)); });
      card.appendChild(open);
    }
    return card;
  }

  function homeworkForm(hw) {
    var f = el("form", "absence-form");
    f.noValidate = true;
    var id = "hw-" + hw.id;
    var lab = el("label", null, t("Your answer"));
    lab.htmlFor = id;
    var body = el("textarea");
    body.id = id; body.rows = 4; body.maxLength = 5000;
    body.value = hw.body || "";
    var flab = el("label", null, t("Attach a file (photo, PDF or Word, up to 10 MB)"));
    flab.htmlFor = id + "-file";
    var file = el("input");
    file.type = "file"; file.id = id + "-file";
    file.accept = "image/png,image/jpeg,image/webp,application/pdf,.doc,.docx";
    var err = el("p", "admin-error");
    err.hidden = true;
    var row = el("div", "btn-row");
    var send = el("button", "btn btn--gold btn--sm", t("Hand in"));
    send.type = "submit";
    var back = el("button", "btn btn--outline btn--sm", t("Back"));
    back.type = "button";
    back.addEventListener("click", renderHomework);
    row.appendChild(send); row.appendChild(back);
    [lab, body, flab, file, err, row].forEach(function (x) { f.appendChild(x); });
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var fl = file.files[0];
      var fail = function (msg) { err.textContent = t(msg); err.hidden = false; };
      if (!body.value.trim() && !fl && !hw.file_path) { fail("Write an answer or attach a file."); return; }
      if (fl && fl.size > 10 * 1024 * 1024) { fail("The file must be 10 MB or smaller."); return; }
      if (fl && HW_TYPES.indexOf(fl.type) === -1) { fail("Use a photo, PDF or Word file."); return; }
      send.disabled = true;
      (fl ? uploadHomeworkFile(fl) : Promise.resolve(null)).then(function (path) {
        return rpc("student_submit_homework", { p_homework_id: hw.id, p_body: body.value.trim(),
          p_file_path: path, p_file_name: fl ? fl.name : null }, true);
      }).then(function (res) {
        if (!res || res.error) { fail((res && res.error) || "Could not send. Please try again."); return; }
        toast(t("Homework handed in."));
        loadHomework(); loadCounts();
      }).catch(function (e) {
        if (e.message !== "signed out") { console.error(e); fail("Could not send. Please try again."); }
      }).then(function () { send.disabled = false; });
    });
    setTimeout(function () { body.focus(); }, 0);
    return f;
  }

  function renderHomework() {
    var box = $("#hw-list");
    if (!homework.length) { box.replaceChildren(el("p", "small-note", t("No homework yet."))); return; }
    box.replaceChildren.apply(box, homework.map(homeworkCard));
  }
  function renderNotes() {
    var box = $("#notes-list");
    if (!notes.length) { box.replaceChildren(el("p", "small-note", t("No notes from your teachers yet."))); return; }
    box.replaceChildren.apply(box, notes.map(function (n) {
      var card = el("article", "card lesson-row");
      card.appendChild(el("strong", "lesson-when", fmtWhen(n.starts_at, 0).split(" · ")[0] + " · " + n.subject));
      card.appendChild(el("span", "lesson-who", t("Teacher") + ": " + n.teacher_name));
      card.appendChild(el("p", "lesson-note", n.teacher_note));
      return card;
    }));
  }

  /* ---------- Attendance history ---------- */
  var RULE = {
    may: "May be rescheduled", not_required: "Not required to be rescheduled",
    courtesy: "May be rescheduled once, as a courtesy", used: "Not rescheduled; lesson counted as used",
    review: "Reviewed case by case"
  };
  var monthLessons = [], monthStats = null;
  (function () { var d = new Date(); $("#sa-month").value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); })();
  $("#sa-month").addEventListener("change", loadMonth);

  function loadMonth() {
    var m = ($("#sa-month").value || monthStart().slice(0, 7)) + "-01";
    return Promise.all([rpc("student_month_lessons", { p_month: m }, true), rpc("student_attendance", { p_month: m }, true)])
      .then(function (res) { monthLessons = res[0] || []; monthStats = res[1]; renderMonth(); })
      .catch(function (err) { if (err.message !== "signed out") console.error(err); });
  }
  function renderMonth() {
    var s = $("#sa-summary");
    s.replaceChildren();
    if (monthStats && monthStats.counted) {
      var r = Number(monthStats.rate);
      s.appendChild(el("span", "status-pill " + (r >= 80 ? "status-active" : r >= 75 ? "status-payment-pending" : "status-payment-failed"), r + "%"));
      s.appendChild(el("span", null, t("Attended") + " " + monthStats.attended + " / " + monthStats.counted + " · " +
        t("Approved absences") + " " + monthStats.approved + " · " + t("Unapproved absences") + " " + monthStats.unapproved +
        (monthStats.emergency ? " · " + t("Emergency") + " " + monthStats.emergency : "")));
    } else {
      s.appendChild(el("span", null, t("No marked lessons this month.")));
    }
    var box = $("#sa-lessons");
    if (!monthLessons.length) { box.replaceChildren(el("p", "small-note", t("No lessons this month."))); return; }
    box.replaceChildren.apply(box, monthLessons.map(function (l) {
      var card = lessonCard(l, false);
      if (l.rule) card.appendChild(el("p", "lesson-rule", t(RULE[l.rule]) + (l.rescheduled ? " · " + t("Rescheduled") : "")));
      return card;
    }));
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
        renderRequestForm(); renderRequests();
        renderHomework(); renderNotes();
        renderMonth();
        messages.render();
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
  messages = window.hopeMessages({
    rpc: function (name, args) { return rpc(name, args, true); },
    t: t,
    threadsRpc: "student_dm_threads",
    idKey: "teacher_id",
    nameKey: "teacher_name",
    onUnread: function (n) { setCount("#c-messages", n); }
  });
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
