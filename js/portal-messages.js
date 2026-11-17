/* Hope Education — private messages between a student and their teacher.
   Used by student.html and teacher.html (supabase/007_student_features.sql).

   window.hopeMessages({
     rpc:        function (name, args) → Promise   (the portal's signed-in call)
     t:          function (text) → translated text
     threadsRpc: "student_dm_threads" or "teacher_dm_threads"
     idKey:      "teacher_id" or "student_id"   (the other person in each thread)
     nameKey:    "teacher_name" or "student_name"
     onUnread:   function (total)   (updates the tab badge)
   }) → { load(), stop(), render() }

   Messages are shown with textContent only, never as HTML. */
window.hopeMessages = function (opts) {
  "use strict";
  var POLL_MS = 4000;
  var threads = [], current = null, lastId = 0, timer = null;
  var $ = function (s) { return document.querySelector(s); };
  var t = opts.t;
  var list = $("#dm-list"), input = $("#dm-input");

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function showError(msg) { var e = $("#dm-error"); e.textContent = msg || ""; e.hidden = !msg; }

  function renderThreads() {
    var box = $("#dm-threads");
    box.replaceChildren();
    box.appendChild(el("h2", null, t("Messages")));
    if (!threads.length) {
      box.appendChild(el("p", "small-note", t(opts.idKey === "teacher_id"
        ? "You can message your teachers once you are assigned to a class."
        : "No students yet. An admin will assign students to you.")));
      return;
    }
    threads.forEach(function (th) {
      var b = el("button", "dm-thread" + (current && String(current[opts.idKey]) === String(th[opts.idKey]) ? " is-open" : ""));
      b.type = "button";
      var txt = el("span");
      txt.appendChild(el("strong", null, th[opts.nameKey]));
      txt.appendChild(el("small", null, th.subjects || ""));
      b.appendChild(txt);
      if (th.unread) b.appendChild(el("span", "tab-count", String(th.unread)));
      b.addEventListener("click", function () { open(th); });
      box.appendChild(b);
    });
  }

  function loadThreads() {
    return opts.rpc(opts.threadsRpc, {}).then(function (rows) {
      threads = rows || [];
      renderThreads();
      if (opts.onUnread) opts.onUnread(threads.reduce(function (n, x) { return n + (x.unread || 0); }, 0));
    }).catch(function (err) { if (err.message !== "signed out") console.error(err); });
  }

  function addMessage(m) {
    var d = new Date(m.created_at);
    var wrap = el("div", "chat-msg" + (m.mine ? " mine" : ""));
    wrap.appendChild(el("div", "bubble", m.body));
    wrap.appendChild(el("span", "when", d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })));
    list.appendChild(wrap);
    lastId = Math.max(lastId, m.id);
  }

  function loadNew(force) {
    if (!current) return Promise.resolve();
    var stick = force || list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    var who = current;
    return opts.rpc("dm_list", { p_other: String(who[opts.idKey]), p_after_id: lastId }).then(function (rows) {
      if (who !== current) return;
      if (rows && rows.length) {
        var e = $("#dm-empty"); if (e) e.remove();
        rows.forEach(addMessage);
        if (stick) list.scrollTop = list.scrollHeight;
        if (who.unread) { who.unread = 0; renderThreads(); loadThreads(); }
      } else if (!list.children.length) {
        var p = el("p", "empty-state", t("No messages yet. Say hello!"));
        p.id = "dm-empty";
        list.appendChild(p);
      }
      showError("");
    }).catch(function (err) {
      if (err.message !== "signed out") showError(t("Could not load new messages. Retrying…"));
    });
  }

  function open(th) {
    current = th;
    lastId = 0;
    list.replaceChildren();
    $("#dm-title").textContent = th[opts.nameKey];
    $("#dm-chat").hidden = false;
    renderThreads();
    stopTimer();
    loadNew(true);
    timer = setInterval(function () { if (document.visibilityState === "visible") loadNew(false); }, POLL_MS);
    input.focus();
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  $("#dm-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = input.value.trim();
    if (!body || !current) return;
    var btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    opts.rpc("dm_send", { p_other: String(current[opts.idKey]), p_body: body }).then(function (res) {
      if (!res || res.error) { showError(t((res && res.error) || "Could not send. Please try again.")); return; }
      input.value = "";
      input.style.height = "";
      return loadNew(true);
    }).catch(function (err) {
      if (err.message !== "signed out") showError(t("Could not send. Please try again."));
    }).then(function () { btn.disabled = false; input.focus(); });
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#dm-form").requestSubmit(); }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });

  return {
    load: function () { return loadThreads().then(function () { if (current) open(current); }); },
    stop: stopTimer,
    render: renderThreads,
    refreshUnread: loadThreads
  };
};
