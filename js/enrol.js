/* Hope Online Tuition School — step-by-step enrolment form (enrol.html)
   Steps 1–4 happen on this page. Steps 5 (payment) and 6 (confirmation and
   Student ID) happen after Hope Education confirms the tutor.

   Submissions are saved to the Supabase "enrolments" table (js/supabase.js). */
(function () {
  "use strict";

  var LAST_STEP = 4;          // last step completed on the website
  var DRAFT_KEY = "hope-enrol-draft";

  var form = document.getElementById("enrol-form");
  if (!form) return;

  var steps = form.querySelectorAll(".wizard-step");
  var listItems = document.querySelectorAll(".enrol-steps li");
  var backBtn = form.querySelector("[data-back]");
  var nextBtn = form.querySelector("[data-next]");
  var sendBtn = form.querySelector("[data-send]");
  var under18 = document.getElementById("under18");
  var current = 1;

  /* ---------- Showing steps ---------- */
  function showStep(n) {
    current = n;
    steps.forEach(function (s) { s.hidden = Number(s.dataset.step) !== n; });
    listItems.forEach(function (li) {
      var k = Number(li.dataset.step);
      li.classList.toggle("current", k === n);
      li.classList.toggle("done", k < n);
    });
    backBtn.hidden = n === 1;
    nextBtn.hidden = n === LAST_STEP;
    sendBtn.hidden = n !== LAST_STEP;
    saveDraft();
  }

  function scrollToForm() {
    var top = form.closest(".form-card").getBoundingClientRect().top + window.scrollY - 100;
    if (window.scrollY > top) window.scrollTo({ top: top, behavior: "smooth" });
  }

  /* ---------- Parent / guardian fields for students under 18 ---------- */
  function toggleGuardian() {
    form.querySelectorAll("[data-guardian]").forEach(function (el) {
      el.hidden = !under18.checked;
      if (el.hidden) el.classList.remove("invalid");
    });
  }
  under18.addEventListener("change", toggleGuardian);

  /* ---------- Checking answers ---------- */
  function validateField(field) {
    if (field.closest("[hidden]")) return true;
    var inputs = field.querySelectorAll("input, select, textarea");
    var ok = true;
    if (field.hasAttribute("data-require-one")) {
      ok = Array.prototype.some.call(inputs, function (i) { return i.checked; });
    } else {
      inputs.forEach(function (i) { if (!i.checkValidity()) ok = false; });
    }
    field.classList.toggle("invalid", !ok);
    return ok;
  }

  function validateStep(n) {
    var firstBad = null;
    steps[n - 1].querySelectorAll(".field").forEach(function (f) {
      if (!validateField(f) && !firstBad) firstBad = f;
    });
    if (firstBad) {
      firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
      var input = firstBad.querySelector("input, select, textarea");
      if (input) input.focus({ preventScroll: true });
    }
    return !firstBad;
  }

  form.querySelectorAll(".field").forEach(function (f) {
    f.addEventListener("change", function () {
      if (f.classList.contains("invalid")) validateField(f);
    });
  });

  /* ---------- Moving between steps ---------- */
  function goNext() {
    if (!validateStep(current)) return;
    if (current === 3) {
      form.elements.policy_accepted_at.value = new Date().toISOString();
    }
    showStep(current + 1);
    scrollToForm();
  }

  nextBtn.addEventListener("click", goNext);
  backBtn.addEventListener("click", function () { showStep(current - 1); scrollToForm(); });

  /* ---------- Sending ---------- */
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (current !== LAST_STEP) { goNext(); return; } // Enter key moves to the next step
    if (!validateStep(current)) return;

    var wrap = form.parentElement;
    function done() {
      wrap.classList.add("form-sent");
      listItems.forEach(function (li) {
        var k = Number(li.dataset.step);
        li.classList.toggle("done", k <= LAST_STEP);
        li.classList.toggle("current", k === LAST_STEP + 1);
      });
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* storage unavailable */ }
    }
    if (!window.hopeSave) { done(); return; }

    sendBtn.disabled = true;
    window.hopeSave("enrolments", buildRow())
      .then(done)
      .catch(function (err) {
        console.error(err);
        sendBtn.disabled = false;
        window.hopeSaveError();
      });
  });

  /* One row for the "enrolments" table in Supabase (see supabase/schema.sql). */
  function buildRow() {
    var f = form.elements;
    var text = function (name) { var v = (f[name] && f[name].value || "").trim(); return v || null; };
    var under = under18.checked;
    return {
      student_name: text("student_name"),
      email: text("email"),
      phone: text("phone"),
      under_18: under,
      guardian_name: under ? text("guardian_name") : null,
      guardian_contact: under ? text("guardian_contact") : null,
      curriculum: text("curriculum"),
      school_year: text("school_year"),
      subjects: Array.prototype.map.call(form.querySelectorAll('input[name="subjects"]:checked'), function (i) { return i.value; }),
      recent_grade: text("recent_grade"),
      goal: text("goal"),
      help_needed: text("help_needed"),
      preferred_times: text("preferred_times"),
      policy_version: text("policy_version"),
      policy_agreed: f.policy_agreed.checked,
      guardian_agreed: under ? f.guardian_agreed.checked : false,
      policy_accepted_at: text("policy_accepted_at") || new Date().toISOString(),
      package: text("package"),
      language: document.documentElement.lang === "my" ? "my" : "en"
    };
  }

  /* ---------- Save progress so students can come back later ---------- */
  function saveDraft() {
    var data = { step: current, values: {} };
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked) data.values[el.name + "=" + el.value] = true;
      } else if (el.value) {
        data.values[el.name] = el.value;
      }
    });
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
  }

  function loadDraft() {
    var data = null;
    try { data = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { /* ignore */ }
    if (!data || !data.values) return 1;
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === "checkbox" || el.type === "radio") {
        el.checked = !!data.values[el.name + "=" + el.value];
      } else if (data.values[el.name] && !(el.name === "package" && el.value)) {
        el.value = data.values[el.name];
      }
    });
    return Math.min(Math.max(Number(data.step) || 1, 1), LAST_STEP);
  }

  form.addEventListener("input", saveDraft);
  form.addEventListener("change", saveDraft);

  var startStep = loadDraft();
  toggleGuardian();
  showStep(startStep);
})();
