/* Hope Online Tuition School — site behaviour */
(function () {
  "use strict";
  document.documentElement.classList.add("js"); // enables fade-in animations

  /* ---------- English / Burmese language switch ----------
     Burmese text lives in js/translations.js as  "English text": "Burmese text".
     Any English text without an entry there simply stays in English. */
  var dict = window.HOPE_MY || {};
  var norm = function (s) { return s.replace(/\s+/g, " ").trim(); };
  var textItems = [];

  // Options without a value would send the translated text; fix their value in English.
  document.querySelectorAll("option:not([value])").forEach(function (o) { o.value = o.text; });

  document.body.querySelectorAll("*").forEach(function (el) {
    if (el.closest("svg, script, style, [data-no-translate]")) return;
    var direct = Array.prototype.filter.call(el.childNodes, function (n) {
      return n.nodeType === 3 && n.textContent.trim();
    });
    if (!direct.length) return;
    if (el.querySelector("input, select, textarea")) {
      // Translate only the loose text so form fields are never re-created
      direct.forEach(function (n) { textItems.push({ node: n, key: norm(n.textContent), en: n.textContent }); });
    } else {
      textItems.push({ el: el, key: norm(el.innerHTML), en: el.innerHTML });
    }
  });
  document.querySelectorAll("[placeholder]").forEach(function (el) {
    var en = el.getAttribute("placeholder");
    textItems.push({ attr: el, key: norm(en), en: en });
  });
  var titleEn = document.title;

  function fillYear() {
    document.querySelectorAll("[data-year]").forEach(function (el) {
      el.textContent = new Date().getFullYear();
    });
  }

  function setLang(lang) {
    var my = lang === "my";
    textItems.forEach(function (it) {
      var t = my ? dict[it.key] : null;
      if (it.node) { it.node.textContent = t || it.en; }
      else if (it.attr) { it.attr.setAttribute("placeholder", t || it.en); }
      else if (it.el.isConnected) {
        if (t) { it.el.innerHTML = t; it.done = true; }
        else if (it.done) { it.el.innerHTML = it.en; it.done = false; }
      }
    });
    document.title = (my && dict[norm(titleEn)]) || titleEn;
    document.documentElement.lang = my ? "my" : "en";
    fillYear();
    try { localStorage.setItem("hope-lang", lang); } catch (e) { /* storage unavailable */ }
  }

  var savedLang = "en";
  try { savedLang = localStorage.getItem("hope-lang") || "en"; } catch (e) { /* storage unavailable */ }
  setLang(savedLang);

  document.querySelectorAll(".lang-switch").forEach(function (btn) {
    btn.addEventListener("click", function () {
      setLang(document.documentElement.lang === "my" ? "en" : "my");
    });
  });

  // Header shadow once the page is scrolled
  var header = document.querySelector(".site-header");
  function onScroll() {
    if (header) header.classList.toggle("scrolled", window.scrollY > 10);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Mobile menu
  var toggle = document.querySelector(".menu-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var open = document.body.classList.toggle("menu-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  // Highlight the current page in the menu
  var page = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav-links a").forEach(function (a) {
    if (a.getAttribute("href") === page && !a.classList.contains("btn")) a.classList.add("active");
  });

  // Fade sections in as they scroll into view
  var items = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("visible"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    items.forEach(function (el) { io.observe(el); });
  } else {
    items.forEach(function (el) { el.classList.add("visible"); });
  }

  // Pre-select the package when arriving from the pricing page (enrol.html?plan=focus)
  var planSelect = document.getElementById("plan");
  var planParam = new URLSearchParams(location.search).get("plan");
  if (planSelect && planParam && planSelect.querySelector('option[value="' + planParam + '"]')) {
    planSelect.value = planParam;
  }

  // Simple forms (contact). A form with data-table="..." is saved to that
  // Supabase table (see js/supabase.js). The enrol form is handled in js/enrol.js.
  document.querySelectorAll("form[data-hope-form]").forEach(function (form) {
    form.setAttribute("novalidate", "");

    function validateField(field) {
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

    form.querySelectorAll(".field").forEach(function (field) {
      field.addEventListener("change", function () {
        if (field.classList.contains("invalid")) validateField(field);
      });
    });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var firstBad = null;
      form.querySelectorAll(".field").forEach(function (field) {
        if (!validateField(field) && !firstBad) firstBad = field;
      });
      if (firstBad) {
        firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
        var input = firstBad.querySelector("input, select, textarea");
        if (input) input.focus({ preventScroll: true });
        return;
      }

      var wrap = form.parentElement;
      var table = form.getAttribute("data-table");
      var button = form.querySelector("button[type=submit]");

      if (!table || !window.hopeSave) { wrap.classList.add("form-sent"); return; }

      var row = {};
      new FormData(form).forEach(function (value, key) { row[key] = String(value).trim(); });

      button.disabled = true;
      window.hopeSave(table, row).then(function () {
        wrap.classList.add("form-sent");
      }).catch(function (err) {
        console.error(err);
        button.disabled = false;
        window.hopeSaveError();
      });
    });
  });
})();
