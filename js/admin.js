/* Hope Education — admin portal (admin.html)

   Admins are kept in the Supabase "admins" table (see supabase/003_admin.sql).
   Signing in happens on login.html (Faculty); this page sends you there if you are not signed in.
   Signing in calls admin_login(), which checks the hashed password and returns a
   12-hour session token. Every request sends that token in the "x-admin-token"
   header, and the database rules only allow admin actions for a valid token.

   Security note: all student-entered data is shown with textContent only, never
   as HTML, so nothing typed into a form can run code in the admin's browser. */
(function () {
  "use strict";

  var CFG = window.HOPE_SUPABASE;
  var SESSION_KEY = "hope-admin-session";
  var STATUSES = ["New request", "Payment Pending", "Active", "Payment Failed", "Waitlisted", "Cancelled"];
  var PACKAGES = { starter: "Starter – 4 lessons / month", focus: "Focus – 8 lessons / month",
                   exam: "Exam Prep – 12 lessons / month", unsure: "Not sure yet" };

  var session = null;
  var me = null;
  var currentTab = "enrolments";

  /* ---------- Small helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }

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
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return e;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) + " " +
           d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  function yesNo(v) { return v ? "Yes" : "No"; }
  function orDash(v) { return (v === null || v === undefined || v === "") ? "—" : String(v); }

  var toastTimer;
  function toast(msg, isError) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("is-error", !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 8000 : 4000);
  }
  function fail(err) {
    console.error(err);
    if (String(err && err.message) !== "signed out") toast("Something went wrong: " + (err && err.message || err), true);
  }

  /* ---------- Session ---------- */
  function saveSession(s) {
    session = s;
    try { if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); else sessionStorage.removeItem(SESSION_KEY); }
    catch (e) { /* storage unavailable: session lasts until the page closes */ }
    return s;
  }
  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; }
  }

  function ensureFresh() {
    if (!session) return Promise.reject(new Error("signed out"));
    if (new Date(session.expires_at).getTime() > Date.now()) return Promise.resolve();
    signOutLocal("Your session has ended. Please sign in again.");
    return Promise.reject(new Error("signed out"));
  }

  /* Request to Supabase as the signed-in admin. */
  function api(path, opts) {
    opts = opts || {};
    return ensureFresh().then(function () {
      var headers = { apikey: CFG.publishableKey, "x-admin-token": session.token };
      Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });
      return fetch(CFG.url + path, { method: opts.method || "GET", headers: headers, body: opts.body });
    }).then(function (r) {
      if (r.status === 401) { signOutLocal("Your session has ended. Please sign in again."); throw new Error("signed out"); }
      return r.text().then(function (t) {
        if (!r.ok) {
          var msg = t;
          try { msg = JSON.parse(t).message || t; } catch (e) { /* plain text */ }
          throw new Error(msg);
        }
        try { return t ? JSON.parse(t) : null; } catch (e) { return t; }
      });
    });
  }
  function rest(path, method, body, prefer) {
    var headers = { "Content-Type": "application/json" };
    if (prefer) headers.Prefer = prefer;
    return api("/rest/v1/" + path, { method: method || "GET", headers: headers, body: body ? JSON.stringify(body) : undefined });
  }
  /* PATCH one row and make sure it really changed (the rules may silently allow 0 rows). */
  function updateRow(table, id, changes) {
    return rest(table + "?id=eq." + encodeURIComponent(id), "PATCH", changes, "return=representation")
      .then(function (rows) {
        if (!rows || !rows.length) throw new Error("Not saved — you may not have permission.");
        return rows[0];
      });
  }

  /* ---------- Sign in / out (signing in happens on login.html) ---------- */
  function goToLogin(ended) {
    location.replace("login.html?role=faculty" + (ended ? "&ended=1" : ""));
  }

  function signOutLocal(message) {
    saveSession(null);
    me = null;
    goToLogin(!!message);
  }

  /* Check the saved session is still valid and get the admin's name. */
  function loadMe() {
    return rest("rpc/admin_me", "POST", {}).then(function (info) {
      if (!info || !info.admin_id) {
        signOutLocal("Your session has ended. Please sign in again.");
        throw new Error("signed out");
      }
      me = info;
      showDashboard();
    });
  }

  /* Sign out: end the session on the server, then go back to the main website. */
  $("#sign-out").addEventListener("click", function (ev) {
    var token = session && session.token;
    ev.target.disabled = true;
    saveSession(null);
    me = null;
    var done = function () { location.replace("index.html"); };
    if (!token) { done(); return; }
    fetch(CFG.url + "/rest/v1/rpc/admin_logout", {
      method: "POST",
      keepalive: true,
      headers: { apikey: CFG.publishableKey, "x-admin-token": token, "Content-Type": "application/json" },
      body: "{}"
    }).catch(function () { /* it also expires on its own after 12 hours */ }).then(done);
  });

  /* ---------- Dashboard ---------- */
  function showDashboard() {
    $("#dash-view").hidden = false;
    $("#admin-hello").textContent = "Hello, " + me.admin_name;
    $("#admin-who").textContent = "Admin ID: " + me.admin_id;
    switchTab(currentTab);
    refreshCounts();
  }

  function switchTab(name) {
    currentTab = name;
    document.querySelectorAll(".admin-tabs [data-tab]").forEach(function (b) {
      b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false");
    });
    document.querySelectorAll(".admin-panel").forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    loaders[name]();
  }

  document.querySelectorAll(".admin-tabs [data-tab]").forEach(function (b) {
    b.addEventListener("click", function () { switchTab(b.dataset.tab); });
  });
  document.querySelectorAll("[data-refresh]").forEach(function (b) {
    b.addEventListener("click", function () { loaders[currentTab](); refreshCounts(); });
  });

  function refreshCounts() {
    Promise.all([
      rest("enrolments?select=id&status=eq.Payment%20Pending"),
      rest("contact_messages?select=id&handled=is.false")
    ]).then(function (res) {
      setCount("#pending-count", res[0].length);
      setCount("#message-count", res[1].length);
    }).catch(fail);
  }
  function setCount(sel, n) { var el = $(sel); el.textContent = n; el.hidden = !n; }

  function statusPill(status) {
    return h("span", { class: "status-pill status-" + status.toLowerCase().replace(/\s+/g, "-"), text: status });
  }

  function emptyState(text) { return h("p", { class: "empty-state", text: text }); }

  /* ---------- Enrolments ---------- */
  function loadEnrolments() {
    var filter = $("#enrol-filter").value;
    var q = "enrolments?select=id,created_at,student_name,email,package,status,student_id&order=created_at.desc";
    if (filter) q += "&status=eq." + encodeURIComponent(filter);
    var box = $("#enrol-list");
    box.replaceChildren(emptyState("Loading…"));
    rest(q).then(function (rows) {
      if (!rows.length) { box.replaceChildren(emptyState("No enrolments here.")); return; }
      var tbody = h("tbody", null, rows.map(function (r) {
        return h("tr", { tabindex: "0", onclick: function () { openEnrolment(r.id); },
                         onkeydown: function (e) { if (e.key === "Enter") openEnrolment(r.id); } }, [
          h("td", { text: "#" + r.id }),
          h("td", { text: fmtDate(r.created_at) }),
          h("td", null, [h("strong", { text: r.student_name }), h("br"), h("small", { text: r.email })]),
          h("td", { text: PACKAGES[r.package] || orDash(r.package) }),
          h("td", null, [statusPill(r.status)]),
          h("td", { text: r.student_id ? String(r.student_id) : "—" })
        ]);
      }));
      box.replaceChildren(h("table", { class: "admin-table" }, [
        h("thead", null, [h("tr", null, ["No.", "Sent", "Student", "Package", "Status", "Student ID"].map(function (t) { return h("th", { text: t }); }))]),
        tbody
      ]));
    }).catch(fail);
  }
  $("#enrol-filter").addEventListener("change", loadEnrolments);

  var dialog = $("#enrol-dialog");
  dialog.querySelector("[data-close]").addEventListener("click", function () { dialog.close(); });

  function detailList(title, pairs) {
    return h("section", { class: "detail-block" }, [
      h("h3", { text: title }),
      h("dl", null, pairs.reduce(function (acc, p) {
        acc.push(h("dt", { text: p[0] }));
        acc.push(h("dd", { text: orDash(p[1]) }));
        return acc;
      }, []))
    ]);
  }

  /* Login details box (shown once after accepting a payment or resetting a password). */
  function credentialsBox(info) {
    if (!info.temp_password) {
      return h("div", { class: "credentials" }, [
        h("h3", { text: "Student ID " + info.student_id }),
        h("p", { class: "small-note", text: "This student already has a password, so no new one was made. " +
          "If they need a new one, use Students → Reset password." })
      ]);
    }
    var portalUrl = new URL("student.html", location.href).href;
    var subject = "Your Hope Education student account";
    var message =
      "Dear " + info.student_name + ",\n\n" +
      "Your payment has been accepted and you are now enrolled at Hope Education.\n\n" +
      "Student ID: " + info.student_id + "\n" +
      "Temporary password: " + info.temp_password + "\n\n" +
      "Sign in to the student portal: " + portalUrl + "\n" +
      "You will be asked to choose your own password the first time you sign in.\n\n" +
      "Please keep these details private.\n\nHope Education";
    var mailto = "mailto:" + encodeURIComponent(info.email).replace(/%40/g, "@") +
      "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(message);

    return h("div", { class: "credentials" }, [
      h("h3", { text: "Send these login details to the student" }),
      h("dl", null, [
        h("dt", { text: "Student ID" }), h("dd", { text: String(info.student_id) }),
        h("dt", { text: "Temporary password" }), h("dd", { text: info.temp_password }),
        h("dt", { text: "Email" }), h("dd", { text: info.email })
      ]),
      h("div", { class: "btn-row" }, [
        h("a", { class: "btn btn--gold btn--sm", href: mailto, text: "Email the student" }),
        h("button", { type: "button", class: "btn btn--outline btn--sm", text: "Copy message", onclick: function (e) {
          navigator.clipboard.writeText(message).then(function () {
            e.target.textContent = "Copied";
          }, function () { toast("Could not copy. Select the details and copy them by hand.", true); });
        } })
      ]),
      h("p", { class: "small-note", text: "The password is shown only this once and is not stored in readable form. " +
        "\"Email the student\" opens your email app with the message ready to send. " +
        "If it is lost, use Students → Reset password." })
    ]);
  }

  function openEnrolment(id, banner) {
    var body = $("#dlg-body");
    $("#dlg-title").textContent = "Enrolment #" + id;
    body.replaceChildren(emptyState("Loading…"));
    if (!dialog.open) dialog.showModal();

    rest("enrolments?select=*&id=eq." + encodeURIComponent(id)).then(function (rows) {
      var r = rows[0];
      if (!r) { body.replaceChildren(emptyState("Not found.")); return; }
      $("#dlg-title").textContent = r.student_name;

      var head = h("div", { class: "detail-head" }, [
        statusPill(r.status),
        r.student_id ? h("span", { class: "student-id-badge", text: "Student ID " + r.student_id }) : null,
        h("span", { class: "small-note", text: "Enrolment #" + r.id + " · sent " + fmtDate(r.created_at) })
      ]);

      // Receipt
      var receiptBox = h("div", { class: "receipt-box" }, [emptyState(r.receipt_path ? "Loading receipt…" : "No receipt uploaded.")]);
      if (r.receipt_path) {
        api("/storage/v1/object/sign/payment-receipts/" + r.receipt_path.split("/").map(encodeURIComponent).join("/"), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 600 })
        }).then(function (res) {
          var url = CFG.url + "/storage/v1" + (res.signedURL || res.signedUrl);
          var isPdf = /\.pdf$/i.test(r.receipt_path);
          receiptBox.replaceChildren(
            isPdf ? h("p", null, [h("a", { href: url, target: "_blank", rel: "noopener", class: "btn btn--outline btn--sm", text: "Open receipt (PDF)" })])
                  : h("a", { href: url, target: "_blank", rel: "noopener", title: "Open full size" }, [h("img", { src: url, alt: "Payment receipt" })]),
            h("p", { class: "small-note", text: "Link works for 10 minutes. Close and reopen to refresh." })
          );
        }).catch(function (err) {
          receiptBox.replaceChildren(emptyState("Could not load receipt: " + err.message));
        });
      }

      // Actions
      var actions = h("section", { class: "detail-block detail-actions" }, [h("h3", { text: "Actions" })]);
      if (r.status !== "Active") {
        actions.appendChild(h("div", { class: "btn-row" }, [
          h("button", { type: "button", class: "btn btn--gold", text: "Accept payment and enrol", onclick: function (e) {
            if (!confirm("Accept the payment and enrol " + r.student_name + "?\nThis gives them a permanent Student ID.")) return;
            e.target.disabled = true;
            rest("rpc/accept_enrolment", "POST", { p_enrolment_id: r.id }).then(function (info) {
              toast(r.student_name + " is enrolled. Student ID: " + info.student_id);
              openEnrolment(r.id, credentialsBox(info)); loadEnrolments(); refreshCounts();
            }).catch(function (err) { e.target.disabled = false; fail(err); });
          } }),
          (r.status === "Payment Pending" || r.status === "New request") ?
            h("button", { type: "button", class: "btn btn--outline", text: "Reject payment", onclick: function (e) {
              if (!confirm("Reject this payment? The enrolment will be marked Payment Failed.")) return;
              e.target.disabled = true;
              updateRow("enrolments", r.id, { status: "Payment Failed" }).then(function () {
                toast("Payment rejected.");
                openEnrolment(r.id); loadEnrolments(); refreshCounts();
              }).catch(function (err) { e.target.disabled = false; fail(err); });
            } }) : null
        ]));
      }

      // Status (Active can only be set with "Accept payment and enrol", which issues the Student ID)
      var statusSelect = h("select", { id: "dlg-status" }, STATUSES.filter(function (s) {
        return s !== "Active" || r.status === "Active";
      }).map(function (s) { return h("option", { value: s, selected: s === r.status, text: s }); }));
      actions.appendChild(h("div", { class: "field" }, [
        h("label", { for: "dlg-status", text: "Status" }),
        h("div", { class: "inline-row" }, [statusSelect,
          h("button", { type: "button", class: "btn btn--outline btn--sm", text: "Save status", onclick: function () {
            updateRow("enrolments", r.id, { status: statusSelect.value }).then(function () {
              toast("Status saved."); openEnrolment(r.id); loadEnrolments(); refreshCounts();
            }).catch(fail);
          } })])
      ]));

      var notes = h("textarea", { id: "dlg-notes", rows: "3" });
      notes.value = r.admin_notes || "";
      actions.appendChild(h("div", { class: "field" }, [
        h("label", { for: "dlg-notes", text: "Admin notes (only admins see these)" }),
        notes,
        h("div", null, [h("button", { type: "button", class: "btn btn--outline btn--sm", text: "Save notes", onclick: function () {
          updateRow("enrolments", r.id, { admin_notes: notes.value.trim() || null })
            .then(function () { toast("Notes saved."); }).catch(fail);
        } })])
      ]));

      actions.appendChild(h("div", { class: "danger-zone" }, [
        h("button", { type: "button", class: "btn-link-danger", text: "Delete this enrolment", onclick: function () {
          if (!confirm("Delete enrolment #" + r.id + " for " + r.student_name + "? This cannot be undone.")) return;
          rest("enrolments?id=eq." + r.id, "DELETE", null, "return=representation").then(function (rows) {
            if (!rows || !rows.length) throw new Error("Not deleted — you may not have permission.");
            toast("Enrolment deleted."); dialog.close(); loadEnrolments(); refreshCounts();
          }).catch(fail);
        } })
      ]));

      body.replaceChildren(
        head,
        h("section", { class: "detail-block" }, [h("h3", { text: "Payment receipt" }), receiptBox,
          h("dl", null, [
            h("dt", { text: "Transaction number" }), h("dd", { text: orDash(r.payment_reference) }),
            h("dt", { text: "Payment sent" }), h("dd", { text: fmtDate(r.payment_submitted_at) }),
            h("dt", { text: "Payment verified" }), h("dd", { text: fmtDate(r.payment_verified_at) })
          ])]),
        actions,
        detailList("Student", [
          ["Name", r.student_name], ["Email", r.email], ["Phone / WhatsApp", r.phone],
          ["Under 18", yesNo(r.under_18)], ["Parent or guardian", r.guardian_name], ["Parent contact", r.guardian_contact]
        ]),
        detailList("Learning needs", [
          ["Curriculum", r.curriculum], ["School year", r.school_year], ["Subjects", (r.subjects || []).join(", ")],
          ["Most recent grade", r.recent_grade], ["Goal", r.goal], ["Needs help with", r.help_needed],
          ["Preferred times", r.preferred_times]
        ]),
        detailList("Package and policies", [
          ["Package", PACKAGES[r.package] || r.package], ["Policy version", r.policy_version],
          ["Agreed to policies", yesNo(r.policy_agreed)], ["Parent agreed", r.under_18 ? yesNo(r.guardian_agreed) : "—"],
          ["Agreed at", fmtDate(r.policy_accepted_at)], ["Website language", r.language === "my" ? "Burmese" : "English"]
        ])
      );
      if (banner) body.prepend(banner);
    }).catch(fail);
  }

  /* ---------- Messages ---------- */
  function loadMessages() {
    var box = $("#message-list");
    box.replaceChildren(emptyState("Loading…"));
    rest("contact_messages?select=*&order=handled.asc,created_at.desc").then(function (rows) {
      if (!rows.length) { box.replaceChildren(emptyState("No messages yet.")); return; }
      box.replaceChildren.apply(box, rows.map(function (m) {
        var check = h("input", { type: "checkbox", checked: m.handled });
        check.addEventListener("change", function () {
          updateRow("contact_messages", m.id, { handled: check.checked })
            .then(function () { card.classList.toggle("is-handled", check.checked); refreshCounts(); })
            .catch(function (err) { check.checked = !check.checked; fail(err); });
        });
        var card = h("article", { class: "card message-card" + (m.handled ? " is-handled" : "") }, [
          h("div", { class: "message-head" }, [
            h("strong", { text: m.name }),
            h("a", { href: "mailto:" + encodeURIComponent(m.email).replace(/%40/g, "@"), text: m.email }),
            h("span", { class: "small-note", text: fmtDate(m.created_at) })
          ]),
          h("p", { class: "message-text", text: m.message }),
          h("label", { class: "consent" }, [check, h("span", { text: "Handled" })])
        ]);
        return card;
      }));
    }).catch(fail);
  }

  /* ---------- Students ---------- */
  function loadStudents() {
    var box = $("#student-list");
    box.replaceChildren(emptyState("Loading…"));
    // Password columns are never readable through the website, so list the columns we need.
    Promise.all([
      rest("students?select=student_id,student_name,email,created_at,last_login_at,must_change_password&order=student_id.asc"),
      rest("teacher_students?select=id,student_id,subject,teachers(teacher_name)&order=subject.asc")
    ]).then(function (res) {
      var rows = res[0];
      var byStudent = {};
      res[1].forEach(function (a) { (byStudent[a.student_id] = byStudent[a.student_id] || []).push(a); });
      if (!rows.length) { box.replaceChildren(emptyState("No students yet. Students appear here after their payment is accepted.")); return; }
      box.replaceChildren(h("table", { class: "admin-table" }, [
        h("thead", null, [h("tr", null, ["Student ID", "Name", "Email", "Teachers", "Last sign-in", ""].map(function (t) { return h("th", { text: t }); }))]),
        h("tbody", null, rows.map(function (s) {
          var mine = byStudent[s.student_id] || [];
          return h("tr", null, [
            h("td", null, [h("strong", { text: String(s.student_id) })]),
            h("td", { text: s.student_name }),
            h("td", { text: s.email }),
            h("td", null, [mine.length
              ? h("ul", { class: "cell-list" }, mine.map(function (a) {
                  return h("li", { text: a.subject + " – " + ((a.teachers && a.teachers.teacher_name) || "?") });
                }))
              : h("small", { text: "None yet" })]),
            h("td", { text: s.last_login_at ? fmtDate(s.last_login_at) : "Never" }),
            h("td", null, [h("div", { class: "btn-row" }, [
              h("button", { type: "button", class: "btn btn--gold btn--sm", text: "Assign teacher", onclick: function () { openAssign(s); } }),
              h("button", { type: "button", class: "btn btn--outline btn--sm", text: "Reset password", onclick: function (e) {
              if (!confirm("Give " + s.student_name + " a new temporary password?\nTheir old password stops working and they are signed out.")) return;
              e.target.disabled = true;
              rest("rpc/admin_reset_student_password", "POST", { p_student_id: s.student_id }).then(function (info) {
                $("#dlg-title").textContent = info.student_name;
                $("#dlg-body").replaceChildren(credentialsBox(info));
                if (!dialog.open) dialog.showModal();
                loadStudents();
              }).catch(function (err) { e.target.disabled = false; fail(err); });
            } })])])
          ]);
        }))
      ]));
    }).catch(fail);
  }

  /* ---------- Assign teachers to a student (one row per subject) ---------- */
  function openAssign(s) {
    var body = $("#dlg-body");
    $("#dlg-title").textContent = s.student_name;
    body.replaceChildren(emptyState("Loading…"));
    if (!dialog.open) dialog.showModal();

    Promise.all([
      rest("teacher_students?select=id,subject,class_link,teacher_id,teachers(teacher_name)&student_id=eq." + s.student_id + "&order=subject.asc"),
      rest("teachers?select=teacher_id,teacher_name&active=is.true&order=teacher_name.asc"),
      rest("enrolments?select=subjects&student_id=eq." + s.student_id + "&order=created_at.desc&limit=1")
    ]).then(function (res) {
      var current = res[0], teachers = res[1];
      var subjects = (res[2][0] && res[2][0].subjects) || [];

      var list = current.length
        ? h("ul", { class: "assign-list" }, current.map(function (a) {
            return h("li", null, [
              h("span", null, [h("strong", { text: a.subject }), " – " + ((a.teachers && a.teachers.teacher_name) || a.teacher_id),
                a.class_link ? h("small", { class: "small-note", text: "  · class link set" }) : null]),
              h("button", { type: "button", class: "btn-link-danger", text: "Remove", onclick: function () {
                if (!confirm("Remove " + a.subject + " with " + ((a.teachers && a.teachers.teacher_name) || a.teacher_id) + "?")) return;
                rest("teacher_students?id=eq." + a.id, "DELETE", null, "return=representation").then(function (rows) {
                  if (!rows || !rows.length) throw new Error("Not removed — you may not have permission.");
                  toast("Removed."); openAssign(s); loadStudents();
                }).catch(fail);
              } })
            ]);
          }))
        : emptyState("No teachers assigned yet.");

      if (!teachers.length) {
        body.replaceChildren(h("section", { class: "detail-block" }, [h("h3", { text: "Teachers" }), list]),
          emptyState("Add a teacher in the Teachers tab first."));
        return;
      }

      var teacherSel = h("select", { id: "as-teacher", required: true }, teachers.map(function (tc) {
        return h("option", { value: tc.teacher_id, text: tc.teacher_name + " (" + tc.teacher_id + ")" });
      }));
      var subjectInput = h("input", { id: "as-subject", type: "text", maxlength: "100", list: "as-subjects", required: true, autocomplete: "off" });
      if (subjects.length) subjectInput.value = subjects[0];
      var linkInput = h("input", { id: "as-link", type: "url", maxlength: "500", autocomplete: "off" });

      var form = h("form", { class: "assign-form", novalidate: true, onsubmit: function (ev) {
        ev.preventDefault();
        var subject = subjectInput.value.trim(), link = linkInput.value.trim();
        if (!subject) { toast("Enter the subject.", true); return; }
        if (link && !/^https:\/\/[^\s<>"]+$/i.test(link)) { toast("The class link must start with https://", true); return; }
        var btn = form.querySelector("button[type=submit]");
        btn.disabled = true;
        rest("teacher_students", "POST", { teacher_id: teacherSel.value, student_id: s.student_id, subject: subject, class_link: link || null },
             "return=representation").then(function (rows) {
          if (!rows || !rows.length) throw new Error("Not saved — you may not have permission.");
          toast(s.student_name + " assigned."); openAssign(s); loadStudents();
        }).catch(function (err) {
          btn.disabled = false;
          if (/duplicate key/i.test(err.message)) toast("That teacher already teaches this subject to " + s.student_name + ".", true);
          else fail(err);
        });
      } }, [
        h("div", { class: "field" }, [h("label", { for: "as-teacher", text: "Teacher" }), teacherSel]),
        h("div", { class: "field" }, [h("label", { for: "as-subject", text: "Subject" }), subjectInput,
          h("datalist", { id: "as-subjects" }, subjects.map(function (x) { return h("option", { value: x }); }))]),
        h("div", { class: "field field--full" }, [h("label", { for: "as-link", text: "Online class link (optional — the teacher can add it)" }), linkInput]),
        h("div", { class: "field--full" }, [h("button", { type: "submit", class: "btn btn--gold", text: "Assign teacher" })])
      ]);

      body.replaceChildren(
        h("div", { class: "detail-head" }, [h("span", { class: "student-id-badge", text: "Student ID " + s.student_id }),
          subjects.length ? h("span", { class: "small-note", text: "Enrolled for: " + subjects.join(", ") }) : null]),
        h("section", { class: "detail-block" }, [h("h3", { text: "Teachers" }), list]),
        h("section", { class: "detail-block detail-actions" }, [h("h3", { text: "Assign a teacher" }), form])
      );
    }).catch(fail);
  }

  /* ---------- Teachers ---------- */
  function teacherCredentialsBox(info) {
    var portalUrl = new URL("login.html?role=faculty", location.href).href;
    var subject = "Your Hope Education teacher account";
    var message =
      "Dear " + info.teacher_name + ",\n\n" +
      "Your Hope Education teacher account is ready.\n\n" +
      "Faculty ID: " + info.teacher_id + "\n" +
      "Temporary password: " + info.temp_password + "\n\n" +
      "Sign in (choose Faculty): " + portalUrl + "\n" +
      "You will be asked to choose your own password the first time you sign in.\n\n" +
      "Please keep these details private.\n\nHope Education";
    var mailto = info.email ? "mailto:" + encodeURIComponent(info.email).replace(/%40/g, "@") +
      "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(message) : null;

    return h("div", { class: "credentials" }, [
      h("h3", { text: "Send these login details to the teacher" }),
      h("dl", null, [
        h("dt", { text: "Faculty ID" }), h("dd", { text: info.teacher_id }),
        h("dt", { text: "Temporary password" }), h("dd", { text: info.temp_password }),
        h("dt", { text: "Email" }), h("dd", { text: info.email || "—" })
      ]),
      h("div", { class: "btn-row" }, [
        mailto ? h("a", { class: "btn btn--gold btn--sm", href: mailto, text: "Email the teacher" }) : null,
        h("button", { type: "button", class: "btn btn--outline btn--sm", text: "Copy message", onclick: function (e) {
          navigator.clipboard.writeText(message).then(function () {
            e.target.textContent = "Copied";
          }, function () { toast("Could not copy. Select the details and copy them by hand.", true); });
        } })
      ]),
      h("p", { class: "small-note", text: "The password is shown only this once and is not stored in readable form. " +
        "If it is lost, use Teachers → Reset password." })
    ]);
  }
  function showTeacherCredentials(info) {
    $("#dlg-title").textContent = info.teacher_name;
    $("#dlg-body").replaceChildren(teacherCredentialsBox(info));
    if (!dialog.open) dialog.showModal();
  }

  function loadTeachers() {
    var box = $("#teacher-list");
    box.replaceChildren(emptyState("Loading…"));
    Promise.all([
      rest("teachers?select=teacher_id,teacher_name,email,active,last_login_at,must_change_password&order=teacher_name.asc"),
      rest("teacher_students?select=teacher_id,student_id")
    ]).then(function (res) {
      var rows = res[0];
      var counts = {};
      res[1].forEach(function (a) {
        counts[a.teacher_id] = counts[a.teacher_id] || {};
        counts[a.teacher_id][a.student_id] = true;
      });
      if (!rows.length) { box.replaceChildren(emptyState("No teachers yet. Add one above.")); return; }
      box.replaceChildren(h("table", { class: "admin-table" }, [
        h("thead", null, [h("tr", null, ["Faculty ID", "Name", "Email", "Students", "Last sign-in", "Status", ""].map(function (t) { return h("th", { text: t }); }))]),
        h("tbody", null, rows.map(function (tc) {
          return h("tr", null, [
            h("td", null, [h("strong", { text: tc.teacher_id })]),
            h("td", { text: tc.teacher_name }),
            h("td", { text: orDash(tc.email) }),
            h("td", { text: String(Object.keys(counts[tc.teacher_id] || {}).length) }),
            h("td", { text: tc.last_login_at ? fmtDate(tc.last_login_at) : "Never" }),
            h("td", null, [h("span", { class: "status-pill " + (tc.active ? "status-active" : "status-inactive"), text: tc.active ? "Active" : "Turned off" })]),
            h("td", null, [h("div", { class: "btn-row" }, [
              h("button", { type: "button", class: "btn btn--outline btn--sm", text: "Reset password", onclick: function (e) {
                if (!confirm("Give " + tc.teacher_name + " a new temporary password?\nTheir old password stops working and they are signed out.")) return;
                e.target.disabled = true;
                rest("rpc/admin_reset_teacher_password", "POST", { p_teacher_id: tc.teacher_id }).then(function (info) {
                  showTeacherCredentials(info); loadTeachers();
                }).catch(function (err) { e.target.disabled = false; fail(err); });
              } }),
              h("button", { type: "button", class: "btn btn--outline btn--sm", text: tc.active ? "Turn off" : "Turn on", onclick: function (e) {
                if (tc.active && !confirm("Turn off " + tc.teacher_name + "'s account?\nThey are signed out and can't sign in until you turn it on again. " +
                                          "Their students stay assigned.")) return;
                e.target.disabled = true;
                rest("teachers?teacher_id=eq." + encodeURIComponent(tc.teacher_id) + "&select=teacher_id", "PATCH",
                     { active: !tc.active }, "return=representation").then(function (r) {
                  if (!r || !r.length) throw new Error("Not saved — you may not have permission.");
                  toast(tc.teacher_name + (tc.active ? " is turned off." : " is turned on."));
                  loadTeachers();
                }).catch(function (err) { e.target.disabled = false; fail(err); });
              } })
            ])])
          ]);
        }))
      ]));
    }).catch(fail);
  }

  $("#teacher-add").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var id = $("#tch-id").value.trim(), name = $("#tch-name").value.trim(), email = $("#tch-email").value.trim();
    if (!/^[A-Za-z0-9_-]{2,30}$/.test(id)) { toast("Faculty ID: 2–30 letters, numbers, - or _ (no spaces).", true); return; }
    if (!name) { toast("Enter the teacher's name.", true); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Check the email address.", true); return; }
    var btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    rest("rpc/admin_create_teacher", "POST", { p_teacher_id: id, p_teacher_name: name, p_email: email || null }).then(function (info) {
      ev.target.reset();
      toast(info.teacher_name + " added.");
      showTeacherCredentials(info);
      loadTeachers();
    }).catch(fail).then(function () { btn.disabled = false; });
  });

  /* ---------- Student chat moderation ---------- */
  function loadChat() {
    var box = $("#chat-mod-list");
    box.replaceChildren(emptyState("Loading…"));
    rest("student_messages?select=id,body,created_at,student_id,students(student_name)&deleted=eq.false&order=id.desc&limit=200")
      .then(function (rows) {
        if (!rows.length) { box.replaceChildren(emptyState("No chat messages yet.")); return; }
        box.replaceChildren.apply(box, rows.map(function (m) {
          var name = (m.students && m.students.student_name) || "Student";
          var card = h("article", { class: "card mod-msg" }, [
            h("div", { class: "mod-meta", text: name + " · Student ID " + m.student_id + " · " + fmtDate(m.created_at) }),
            h("p", { class: "mod-body", text: m.body }),
            h("button", { type: "button", class: "btn-link-danger", text: "Remove", onclick: function () {
              if (!confirm("Remove this message from the student chat?")) return;
              updateRow("student_messages", m.id, { deleted: true, deleted_by: me.admin_id })
                .then(function () { card.remove(); toast("Message removed."); })
                .catch(fail);
            } })
          ]);
          return card;
        }));
      }).catch(fail);
  }

  /* ---------- Website settings ---------- */
  function loadWebsite() {
    rest("site_settings?select=key,value").then(function (rows) {
      var s = {};
      rows.forEach(function (r) { s[r.key] = r.value; });
      ["starter", "focus", "exam"].forEach(function (p) { $("#price-" + p).value = s["price_" + p] || ""; });
      var img = $("#qr-current");
      if (s.payment_qr_version) {
        img.src = window.hopeQrUrl(s.payment_qr_version);
        img.hidden = false; $("#qr-none").hidden = true;
      } else {
        img.hidden = true; $("#qr-none").hidden = false;
      }
    }).catch(fail);
  }

  function saveSettings(pairs) {
    var now = new Date().toISOString();
    return rest("site_settings?on_conflict=key", "POST", pairs.map(function (p) {
      return { key: p[0], value: p[1], updated_at: now };
    }), "resolution=merge-duplicates,return=representation").then(function (rows) {
      if (!rows || rows.length !== pairs.length) throw new Error("Not saved — you may not have permission.");
    });
  }

  $("#prices-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var pairs = ["starter", "focus", "exam"].map(function (p) {
      return ["price_" + p, $("#price-" + p).value.trim() || null];
    });
    saveSettings(pairs).then(function () { toast("Prices saved. The website now shows them."); }).catch(fail);
  });

  $("#qr-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var file = $("#qr-file").files[0];
    if (!file) { toast("Choose an image first.", true); return; }
    if (file.size > 2 * 1024 * 1024) { toast("The image must be under 2 MB.", true); return; }
    if (["image/png", "image/jpeg", "image/webp"].indexOf(file.type) === -1) { toast("Use a PNG, JPG or WEBP image.", true); return; }
    var btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    api("/storage/v1/object/site-assets/payment-qr", {
      method: "POST", headers: { "Content-Type": file.type, "x-upsert": "true", "Cache-Control": "max-age=60" }, body: file
    }).then(function () {
      return saveSettings([["payment_qr_version", String(Date.now())]]);
    }).then(function () {
      toast("QR code uploaded. The Enrol page now shows it.");
      $("#qr-file").value = "";
      loadWebsite();
    }).catch(fail).then(function () { btn.disabled = false; });
  });

  var loaders = { enrolments: loadEnrolments, messages: loadMessages, students: loadStudents, teachers: loadTeachers, chat: loadChat, website: loadWebsite };

  /* ---------- Start ---------- */
  session = readSession();
  if (session && session.token) {
    loadMe().catch(function (err) { if (String(err.message) !== "signed out") signOutLocal("Please sign in again."); });
  } else {
    goToLogin(false);
  }
})();
