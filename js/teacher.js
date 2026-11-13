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
    loadStudents();
  }

  // Re-write the dynamic text when the language is switched (main.js handles the fixed text).
  document.querySelectorAll(".lang-switch").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (me && !$("#t-dash").hidden) { writeGreeting(); renderStudents(); }
    });
  });

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
    }).catch(function (err) {
      if (err.message !== "signed out") showError("#t-error", t("Could not load your students. Please try again."));
    });
  }
  $("#t-refresh").addEventListener("click", loadStudents);

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
