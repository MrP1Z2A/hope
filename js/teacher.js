/* Hope Education — teacher portal (teacher.html)

   Teachers sign in on login.html (Faculty) with the Faculty ID and password an admin
   gave them (see supabase/005_teachers.sql). This page sends them there if they are
   not signed in, and to the main website when they sign out.
   The 12-hour session token is sent with every request in the "x-teacher-token" header.

   Shows the students an admin assigned to this teacher, what each student told us when
   enrolling, and lets the teacher set the online class link the student sees.

   Security note: student details are shown with textContent only, never as HTML. */
(function () {
  "use strict";

  var CFG = window.HOPE_SUPABASE;
  var SESSION_KEY = "hope-teacher-session";
  var PACKAGES = { starter: "Starter", focus: "Focus", exam: "Exam Prep", unsure: "Not sure yet" };

  var session = null;
  var me = null;
  var students = [];

  function $(sel) { return document.querySelector(sel); }
  function t(text) {
    return (document.documentElement.lang === "my" && window.HOPE_MY && window.HOPE_MY[text]) || text;
  }

  // Build elements safely: text is always inserted as text, never HTML.
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }
  function isHttps(url) { return /^https:\/\/[^\s<>"]+$/i.test(url || ""); }

  var toastTimer;
  function toast(msg, isError) {
    var el = $("#toast");
    el.textContent = msg;
    el.classList.toggle("is-error", !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, isError ? 8000 : 4000);
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

  /* Call a database function as the signed-in teacher. */
  function rpc(name, args) {
    if (!session || new Date(session.expires_at).getTime() < Date.now()) {
      signOutLocal(true);
      return Promise.reject(new Error("signed out"));
    }
    return fetch(CFG.url + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: { apikey: CFG.publishableKey, "Content-Type": "application/json", "x-teacher-token": session.token },
      body: JSON.stringify(args || {})
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) { signOutLocal(true); throw new Error("signed out"); }
          throw new Error((data && data.message) || "Request failed");
        }
        return data;
      });
    });
  }

  /* ---------- Views ---------- */
  function show(view) { ["#t-change", "#t-dash"].forEach(function (id) { $(id).hidden = id !== view; }); }
  function showError(sel, msg) { var el = $(sel); el.textContent = msg || ""; el.hidden = !msg; }

  function signOutLocal(ended) {
    saveSession(null);
    me = null;
    location.replace("login.html?role=faculty" + (ended ? "&ended=1" : ""));
  }

  function signOut(ev) {
    var token = session && session.token;
    if (ev && ev.target) ev.target.disabled = true;
    saveSession(null);
    me = null;
    var done = function () { location.replace("index.html"); };
    if (!token) { done(); return; }
    fetch(CFG.url + "/rest/v1/rpc/teacher_logout", {
      method: "POST",
      keepalive: true,
      headers: { apikey: CFG.publishableKey, "x-teacher-token": token, "Content-Type": "application/json" },
      body: "{}"
    }).catch(function () { /* it also expires on its own */ }).then(done);
  }
  $("#t-sign-out").addEventListener("click", signOut);
  $("#t-change-signout").addEventListener("click", signOut);

  function writeGreeting() {
    $("#t-hello").textContent = t("Hello") + ", " + me.teacher_name;
    $("#t-who").textContent = t("Faculty ID") + ": " + me.teacher_id;
  }

  function enterPortal() {
    if (me.must_change_password) {
      $("#t-pw-current").value = "";
      $("#t-change-intro").hidden = false;
      $("#t-change-cancel").hidden = true;
      $("#t-change-signout").hidden = false;
      showError("#t-change-error", "");
      show("#t-change");
      $("#t-pw-current").focus();
      return;
    }
    writeGreeting();
    show("#t-dash");
    loadStudents().then(function () { switchTab(currentTab); });
  }

  // Re-write the dynamic text when the language is switched (main.js handles the fixed text).
  document.querySelectorAll(".lang-switch").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (me && !$("#t-dash").hidden) {
        writeGreeting(); renderStudents(); fillStudentSelect(); renderLessons(); renderAttendance();
      }
    });
  });

  /* ---------- Tabs ---------- */
  var currentTab = "lessons";
  function switchTab(name) {
    currentTab = name;
    document.querySelectorAll(".admin-tabs [data-tab]").forEach(function (b) {
      b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false");
    });
    document.querySelectorAll(".admin-panel").forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    if (name === "lessons") loadLessons();
    else if (name === "attendance") loadAttendance();
    else loadStudents();
  }
  document.querySelectorAll(".admin-tabs [data-tab]").forEach(function (b) {
    b.addEventListener("click", function () { switchTab(b.dataset.tab); });
  });
  document.querySelectorAll("[data-refresh]").forEach(function (b) {
    b.addEventListener("click", function () { switchTab(currentTab); });
  });

  /* ---------- Lessons ---------- */
  var STATUS = {
    scheduled: "Scheduled", attended: "Attended", late: "Late", absent_approved: "Approved absence",
    absent_unapproved: "Unapproved absence", absent_emergency: "Emergency absence", cancelled: "Cancelled"
  };
  var RULE = {
    may: "May be rescheduled", not_required: "Not required to be rescheduled",
    courtesy: "May be rescheduled once, as a courtesy", used: "Not rescheduled; lesson counted as used",
    review: "Reviewed case by case"
  };
  var DAY = 24 * 3600 * 1000;
  var lessons = [];

  function fmtWhen(iso, mins) {
    var d = new Date(iso), end = new Date(d.getTime() + mins * 60000);
    var loc = document.documentElement.lang === "my" ? "my-MM" : undefined;
    return d.toLocaleDateString(loc, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) + " · " +
      d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" }) + "–" +
      end.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  }
  function statusPill(status) {
    return h("span", { class: "status-pill lesson-" + status, text: t(STATUS[status] || status) });
  }

  function loadLessons() {
    var now = Date.now();
    showError("#t-error", "");
    return rpc("teacher_lessons", { p_from: new Date(now - 35 * DAY).toISOString(), p_to: new Date(now + 120 * DAY).toISOString() })
      .then(function (rows) { lessons = rows || []; renderLessons(); fillMakeupSelect(); })
      .catch(function (err) {
        if (err.message !== "signed out") showError("#t-error", t("Could not load lessons. Please try again."));
      });
  }

  function lessonRow(l) {
    var started = new Date(l.starts_at).getTime() <= Date.now();
    var statusSel = h("select", { "aria-label": t("Status") }, Object.keys(STATUS).map(function (k) {
      return h("option", { value: k, selected: k === l.status, text: t(STATUS[k]),
                           disabled: !started && (k === "attended" || k === "late" || k === "absent_unapproved") });
    }));
    var note = h("textarea", { rows: "2", maxlength: "2000", "aria-label": t("Note or homework for the student") });
    note.value = l.teacher_note || "";
    var saveBtn = h("button", { type: "submit", class: "btn btn--gold btn--sm", text: t("Save") });

    var form = h("form", { class: "lesson-mark", novalidate: true, onsubmit: function (ev) {
      ev.preventDefault();
      if (statusSel.value === "cancelled" && l.status !== "cancelled" &&
          !confirm(t("Cancel this lesson? It won't count towards attendance."))) return;
      saveBtn.disabled = true;
      rpc("teacher_mark_lesson", { p_lesson_id: l.id, p_status: statusSel.value, p_note: note.value }).then(function (res) {
        if (!res || res.error) { toast(t((res && res.error) || "Could not save."), true); return; }
        toast(t("Saved."));
        loadLessons();
      }).catch(function (err) { if (err.message !== "signed out") toast(t("Could not save."), true); })
        .then(function () { saveBtn.disabled = false; });
    } }, [
      h("label", { class: "lesson-mark-field" }, [h("span", { text: t("Status") }), statusSel]),
      h("label", { class: "lesson-mark-field lesson-mark-note" }, [h("span", { text: t("Note or homework for the student") }), note]),
      saveBtn
    ]);

    var extra = [];
    if (l.makeup_for) extra.push(h("span", { class: "small-note lesson-tag", text: t("Make-up lesson") }));
    if (l.absence_reason) extra.push(h("p", { class: "lesson-reason", text: t("Student's reason") + ": " + l.absence_reason }));
    if (l.rule) extra.push(h("p", { class: "lesson-rule", text: t(RULE[l.rule]) + (l.rescheduled ? " · " + t("Rescheduled") : "") }));

    var link = /^https:\/\/[^\s<>"]+$/i.test(l.class_link || "") && l.status === "scheduled" &&
      new Date(l.starts_at).getTime() + l.duration_min * 60000 > Date.now()
      ? h("a", { class: "btn btn--outline btn--sm", href: l.class_link, target: "_blank", rel: "noopener", text: t("Open class") }) : null;

    return h("article", { class: "card lesson-row" }, [
      h("div", { class: "lesson-main" }, [
        h("div", null, [
          h("strong", { class: "lesson-when", text: fmtWhen(l.starts_at, l.duration_min) }),
          h("span", { class: "lesson-who", text: l.student_name + " · " + l.subject })
        ]),
        h("div", { class: "lesson-side" }, [statusPill(l.status), link])
      ]),
      extra.length ? h("div", { class: "lesson-extra" }, extra) : null,
      h("details", { class: "lesson-details" }, [h("summary", { text: t("Mark attendance or add a note") }), form])
    ]);
  }

  function fillList(sel, rows, emptyText) {
    var box = $(sel);
    if (!rows.length) { box.replaceChildren(h("p", { class: "empty-state", text: t(emptyText) })); return; }
    box.replaceChildren.apply(box, rows.map(lessonRow));
  }

  function renderLessons() {
    var now = Date.now();
    var toMark = lessons.filter(function (l) { return l.status === "scheduled" && new Date(l.starts_at).getTime() <= now; });
    var upcoming = lessons.filter(function (l) { return new Date(l.starts_at).getTime() > now; });
    var past = lessons.filter(function (l) { return new Date(l.starts_at).getTime() <= now && l.status !== "scheduled"; }).reverse();
    fillList("#t-to-mark", toMark, "Nothing to mark.");
    fillList("#t-upcoming", upcoming, "No upcoming lessons. Add some above.");
    fillList("#t-past", past, "No marked lessons yet.");
    var c = $("#t-mark-count");
    c.textContent = toMark.length;
    c.hidden = !toMark.length;
  }

  /* Add lessons form */
  function fillStudentSelect() {
    var sel = $("#la-student"), keep = sel.value;
    sel.replaceChildren.apply(sel, students.map(function (s) {
      return h("option", { value: String(s.assignment_id), text: s.student_name + " – " + s.subject });
    }));
    if (keep) sel.value = keep;
    $("#lesson-add button[type=submit]").disabled = !students.length;
    fillMakeupSelect();
  }
  function fillMakeupSelect() {
    var sel = $("#la-makeup"), keep = sel.value;
    var a = students.filter(function (s) { return String(s.assignment_id) === $("#la-student").value; })[0];
    var options = [h("option", { value: "", text: t("Not a make-up lesson") })];
    if (a) {
      lessons.filter(function (l) {
        return l.student_id === a.student_id && l.rule && !l.rescheduled && (l.rule === "may" || l.rule === "courtesy" || l.rule === "review");
      }).forEach(function (l) {
        options.push(h("option", { value: String(l.id), text: fmtWhen(l.starts_at, l.duration_min) + " · " + t(STATUS[l.status]) }));
      });
    }
    sel.replaceChildren.apply(sel, options);
    if (keep && sel.querySelector('option[value="' + keep + '"]')) sel.value = keep;
  }
  $("#la-student").addEventListener("change", fillMakeupSelect);
  $("#la-makeup").addEventListener("change", function () {
    if ($("#la-makeup").value) $("#la-repeat").value = "1";
  });

  $("#lesson-add").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var date = $("#la-date").value, time = $("#la-time").value;
    var mins = parseInt($("#la-length").value, 10), times = parseInt($("#la-repeat").value, 10);
    var makeup = $("#la-makeup").value;
    if (!$("#la-student").value) { toast(t("Choose a student."), true); return; }
    if (!date || !time) { toast(t("Choose the date and start time."), true); return; }
    if (!(mins >= 15 && mins <= 240)) { toast(t("Lesson length must be 15 to 240 minutes."), true); return; }
    if (makeup) times = 1;
    var first = new Date(date + "T" + time);   // the browser's local time
    if (isNaN(first.getTime())) { toast(t("Choose the date and start time."), true); return; }
    if (first.getTime() < Date.now() - DAY) { toast(t("Lessons can't start in the past."), true); return; }
    var starts = [];
    for (var i = 0; i < times; i++) {
      var d = new Date(first);
      d.setDate(first.getDate() + 7 * i);    // same local time each week
      starts.push(d.toISOString());
    }
    var btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    rpc("teacher_add_lessons", { p_assignment_id: Number($("#la-student").value), p_starts: starts,
                                 p_duration_min: mins, p_makeup_for: makeup ? Number(makeup) : null })
      .then(function (res) {
        if (!res || res.error) {
          toast(t((res && res.error) || "Could not add the lessons.") + (res && res.clash_at ? " " + fmtWhen(res.clash_at, mins) : ""), true);
          return;
        }
        toast(res.added === 1 ? t("Lesson added.") : res.added + " " + t("lessons added."));
        $("#la-makeup").value = "";
        loadLessons();
      }).catch(function (err) { if (err.message !== "signed out") toast(t("Could not add the lessons."), true); })
      .then(function () { btn.disabled = !students.length; });
  });

  /* ---------- Attendance ---------- */
  var attendance = [];
  function thisMonth() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  $("#t-month").value = thisMonth();
  $("#t-month").addEventListener("change", loadAttendance);

  function loadAttendance() {
    var m = $("#t-month").value || thisMonth();
    return rpc("teacher_attendance", { p_month: m + "-01" }).then(function (rows) {
      attendance = rows || [];
      renderAttendance();
    }).catch(function (err) {
      if (err.message !== "signed out") showError("#t-error", t("Could not load attendance. Please try again."));
    });
  }
  function renderAttendance() {
    var box = $("#t-attendance");
    if (!attendance.length) { box.replaceChildren(h("p", { class: "empty-state", text: t("No students yet. An admin will assign students to you.") })); return; }
    box.replaceChildren(h("table", { class: "admin-table" }, [
      h("thead", null, [h("tr", null, ["Student", "Marked", "Attended", "Approved absences", "Unapproved absences", "Emergency", "Rate"]
        .map(function (x) { return h("th", { text: t(x) }); }))]),
      h("tbody", null, attendance.map(function (a) {
        return h("tr", null, [
          h("td", null, [h("strong", { text: a.student_name }), h("br"), h("small", { text: t("Student ID") + " " + a.student_id })]),
          h("td", { text: String(a.counted) }),
          h("td", { text: String(a.attended) }),
          h("td", { text: String(a.approved) + (a.approved > 2 ? " ⚠" : "") }),
          h("td", { text: String(a.unapproved) }),
          h("td", { text: String(a.emergency) }),
          h("td", null, [rateBadge(a.rate)])
        ]);
      }))
    ]));
  }
  function rateBadge(rate) {
    if (rate === null || rate === undefined) return h("span", { class: "small-note", text: "—" });
    var r = Number(rate);
    return h("span", { class: "status-pill " + (r >= 80 ? "status-active" : r >= 75 ? "status-payment-pending" : "status-payment-failed"),
                       text: r + "%" });
  }

  /* ---------- Change password ---------- */
  $("#t-open-change").addEventListener("click", function () {
    $("#t-pw-current").value = "";
    $("#t-change-intro").hidden = true;
    $("#t-change-cancel").hidden = false;
    $("#t-change-signout").hidden = true;
    showError("#t-change-error", "");
    show("#t-change");
    $("#t-pw-current").focus();
  });
  $("#t-change-cancel").addEventListener("click", function () { enterPortal(); });

  $("#t-change-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var cur = $("#t-pw-current").value, pw1 = $("#t-pw-new").value, pw2 = $("#t-pw-confirm").value;
    if (pw1.length < 8) { showError("#t-change-error", t("The new password must be at least 8 characters.")); return; }
    if (pw1 !== pw2) { showError("#t-change-error", t("The two new passwords do not match.")); return; }
    var btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    rpc("teacher_change_password", { p_current: cur, p_new: pw1 })
      .then(function (res) {
        if (!res || res.error) { showError("#t-change-error", t((res && res.error) || "Could not save the password.")); return; }
        me.must_change_password = false;
        ["#t-pw-current", "#t-pw-new", "#t-pw-confirm"].forEach(function (s) { $(s).value = ""; });
        enterPortal();
      })
      .catch(function (err) { if (err.message !== "signed out") showError("#t-change-error", t("Could not save the password.")); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- My students ---------- */
  function loadStudents() {
    var box = $("#t-students");
    if (!students.length) box.replaceChildren(h("p", { class: "empty-state", text: t("Loading…") }));
    showError("#t-error", "");
    return rpc("teacher_my_students").then(function (rows) {
      students = rows || [];
      renderStudents();
      fillStudentSelect();
    }).catch(function (err) {
      if (err.message !== "signed out") showError("#t-error", t("Could not load your students. Please try again."));
    });
  }

  function info(label, value) {
    if (!value) return null;
    return [h("dt", { text: t(label) }), h("dd", { text: value })];
  }

  function studentCard(s) {
    var linkInput = h("input", { type: "url", inputmode: "url", maxlength: "500", id: "link-" + s.assignment_id,
                                 autocomplete: "off" });
    linkInput.value = s.class_link || "";
    var openLink = h("a", { class: "btn btn--gold btn--sm", target: "_blank", rel: "noopener", text: t("Open class") });
    function updateOpen() {
      var ok = isHttps(s.class_link);
      openLink.hidden = !ok;
      if (ok) openLink.href = s.class_link; else openLink.removeAttribute("href");
    }
    updateOpen();

    var saveBtn = h("button", { type: "submit", class: "btn btn--outline btn--sm", text: t("Save link") });
    var linkForm = h("form", { class: "class-link-form", novalidate: true, onsubmit: function (ev) {
      ev.preventDefault();
      var v = linkInput.value.trim();
      if (v && !isHttps(v)) { toast(t("The class link must start with https://"), true); return; }
      saveBtn.disabled = true;
      rpc("teacher_set_class_link", { p_assignment_id: s.assignment_id, p_link: v }).then(function (res) {
        if (!res || res.error) { toast(t((res && res.error) || "Could not save the link."), true); return; }
        s.class_link = v || null;
        updateOpen();
        toast(t(v ? "Class link saved. Your student can see it now." : "Class link removed."));
      }).catch(function (err) {
        if (err.message !== "signed out") toast(t("Could not save the link."), true);
      }).then(function () { saveBtn.disabled = false; });
    } }, [
      h("label", { for: "link-" + s.assignment_id, text: t("Online class link (Zoom, Google Meet…)") }),
      h("div", { class: "inline-row" }, [linkInput, saveBtn])
    ]);

    var details = [
      info("Email", s.email),
      info("Curriculum", s.curriculum),
      info("School year", s.school_year),
      info("Most recent grade", s.recent_grade),
      info("Package", s.package && t(PACKAGES[s.package] || s.package)),
      info("Preferred times", s.preferred_times),
      info("Goal", s.goal),
      info("Needs help with", s.help_needed)
    ].filter(Boolean).reduce(function (a, b) { return a.concat(b); }, []);

    return h("article", { class: "card teacher-student" }, [
      h("div", { class: "teacher-student-head" }, [
        h("div", null, [
          h("h3", { text: s.student_name }),
          h("span", { class: "small-note", text: t("Student ID") + " " + s.student_id })
        ]),
        h("span", { class: "subject-pill", text: s.subject })
      ]),
      details.length ? h("dl", { class: "teacher-student-info" }, details) : null,
      h("div", { class: "teacher-student-link" }, [linkForm, openLink])
    ]);
  }

  function renderStudents() {
    var box = $("#t-students");
    if (!students.length) {
      box.replaceChildren(h("p", { class: "empty-state",
        text: t("No students yet. An admin will assign students to you.") }));
      return;
    }
    box.replaceChildren.apply(box, students.map(studentCard));
  }

  /* ---------- Start ---------- */
  session = readSession();
  if (session && session.token) {
    rpc("teacher_me").then(function (res) {
      if (!res || !res.teacher_id) { signOutLocal(true); return; }
      me = res;
      enterPortal();
    }).catch(function (err) { if (err.message !== "signed out") signOutLocal(true); });
  } else {
    signOutLocal(false);   // not signed in: go to the sign-in page
  }
})();
