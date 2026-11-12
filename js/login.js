/* Hope Education — sign-in page (login.html)

   Choose Student or Faculty, then sign in. On success the session token is saved
   for this browser tab and the person is taken to their portal:
     Student → student.html
     Faculty → admin.html   (admins sign in with their Admin ID as their Faculty ID;
                              teacher accounts will also sign in here once they exist)
   The portals send people back here if they are not signed in, and back to the
   main website when they sign out.

   Links: login.html?role=faculty opens with Faculty selected
          (older ?role=admin / ?role=teacher links also open Faculty);
          ...&ended=1 shows "Your session has ended". */
(function () {
  "use strict";

  var CFG = window.HOPE_SUPABASE;
  var ROLES = {
    student: { rpc: "student_login", idArg: "p_student_id", key: "hope-student-session", page: "student.html",
               idPattern: /^\d{6,12}$/, missing: "Enter your Student ID and password.",
               wrong: "Wrong Student ID or password." },
    faculty: { rpc: "admin_login", idArg: "p_admin_id", key: "hope-admin-session", page: "admin.html",
               idPattern: /^[A-Za-z0-9_-]{2,30}$/, missing: "Enter your Faculty ID and password.",
               wrong: "Wrong Faculty ID or password." }
  };

  var form = document.getElementById("login-form");
  var idInput = document.getElementById("login-id");
  var pwInput = document.getElementById("login-pw");
  var errorBox = document.getElementById("login-error");
  var params = new URLSearchParams(location.search);
  var requested = params.get("role");
  var role = (requested === "faculty" || requested === "admin" || requested === "teacher") ? "faculty" : "student";

  function t(text) {
    return (document.documentElement.lang === "my" && window.HOPE_MY && window.HOPE_MY[text]) || text;
  }
  function showError(msg) { errorBox.textContent = msg ? t(msg) : ""; errorBox.hidden = !msg; }

  function readSession(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || "null"); } catch (e) { return null; }
  }

  function selectRole(r) {
    role = r;
    document.querySelectorAll(".role-tabs [data-role]").forEach(function (b) {
      b.setAttribute("aria-checked", b.dataset.role === r ? "true" : "false");
    });
    document.querySelectorAll("[data-for-role]").forEach(function (el) {
      el.hidden = el.getAttribute("data-for-role") !== r;
    });
    idInput.setAttribute("inputmode", r === "student" ? "numeric" : "text");
    idInput.setAttribute("autocapitalize", r === "faculty" ? "characters" : "off");
    showError("");
    try { history.replaceState(null, "", "login.html?role=" + r); } catch (e) { /* not important */ }
  }

  document.querySelectorAll(".role-tabs [data-role]").forEach(function (b) {
    b.addEventListener("click", function () { selectRole(b.dataset.role); idInput.focus(); });
  });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var cfg = ROLES[role];
    var id = idInput.value.trim();
    var pw = pwInput.value;
    if (!cfg.idPattern.test(id) || !pw) { showError(cfg.missing); return; }

    var btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    var args = {};
    args[cfg.idArg] = id;
    args.p_password = pw;

    fetch(CFG.url + "/rest/v1/rpc/" + cfg.rpc, {
      method: "POST",
      headers: { apikey: CFG.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify(args)
    }).then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || res.error || !res.token) {
          // Keep the lockout message; otherwise use this page's wording ("Faculty ID", "Student ID").
          var msg = res && res.error && res.error.indexOf("Too many") === 0 ? res.error : cfg.wrong;
          showError(msg);
          btn.disabled = false;
          return;
        }
        try { sessionStorage.setItem(cfg.key, JSON.stringify({ token: res.token, expires_at: res.expires_at })); }
        catch (e) { /* the portal will ask to sign in again */ }
        pwInput.value = "";
        location.replace(cfg.page);
      })
      .catch(function (err) {
        console.error(err);
        showError("Could not sign in. Please try again.");
        btn.disabled = false;
      });
  });

  // Start
  selectRole(role);
  if (params.get("ended")) {
    showError("Your session has ended. Please sign in again.");
  } else {
    // Already signed in on this tab? Go straight to the portal.
    var s = readSession(ROLES[role].key);
    if (s && s.token && new Date(s.expires_at).getTime() > Date.now()) location.replace(ROLES[role].page);
  }
})();
