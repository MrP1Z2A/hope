/* Hope Education — connection to the Supabase database.

   Only the PUBLISHABLE key belongs here. It is safe to be public: the database
   rules (supabase/schema.sql) only let visitors ADD enrolments and messages,
   never read or change them.
   NEVER put the secret key (sb_secret_...) in this file or anywhere in the website. */
window.HOPE_SUPABASE = {
  url: "https://ckexvmscsxcbutxzztjx.supabase.co",
  publishableKey: "sb_publishable__KywYShskZGpVOukrRH5wA_uAHnxq0D"
};

/* Message shown when saving fails, in the visitor's language. */
window.hopeSaveError = function () {
  alert(document.documentElement.lang === "my"
    ? "တောင်းပန်ပါသည်၊ ပို့၍ မရပါ။ ထပ်ကြိုးစားပါ။"
    : "Sorry, it could not be sent. Please try again.");
};

/* Upload a file to a private storage bucket. Resolves with the stored path.
   Visitors can upload but cannot view or replace files (see supabase/002_payment.sql). */
window.hopeUpload = function (bucket, file) {
  var cfg = window.HOPE_SUPABASE;
  var ext = (file.name.split(".").pop() || "file").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
  var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
         : Date.now() + "-" + Math.random().toString(36).slice(2);
  var path = new Date().toISOString().slice(0, 7) + "/" + id + "." + ext;  // e.g. 2026-11/<random>.jpg
  return fetch(cfg.url + "/storage/v1/object/" + bucket + "/" + path, {
    method: "POST",
    headers: {
      apikey: cfg.publishableKey,
      "Content-Type": file.type || "application/octet-stream",
      "x-upsert": "false"
    },
    body: file
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) { throw new Error("Upload failed (" + res.status + "): " + t); });
    }
    return path;
  });
};

/* Save one row to a table. Returns a Promise that rejects if saving failed. */
window.hopeSave = function (table, row) {
  var cfg = window.HOPE_SUPABASE;
  return fetch(cfg.url + "/rest/v1/" + table, {
    method: "POST",
    headers: {
      apikey: cfg.publishableKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(row)
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) { throw new Error("Save failed (" + res.status + "): " + t); });
    }
  });
};
