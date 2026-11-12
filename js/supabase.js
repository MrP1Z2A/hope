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
