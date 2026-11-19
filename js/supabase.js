/* Hope Education — connection to the Supabase database.

   Only the PUBLISHABLE key belongs here. It is safe to be public: the database
   rules (supabase/schema.sql) only let visitors ADD enrolments and messages,
   never read or change them.
   NEVER put the secret key (sb_secret_...) in this file or anywhere in the website. */
window.HOPE_SUPABASE = {
  url: "https://ckexvmscsxcbutxzztjx.supabase.co",
  publishableKey: "sb_publishable__KywYShskZGpVOukrRH5wA_uAHnxq0D"
};

/* Website settings that admins change in the admin portal (prices, QR code).
   Returns a Promise of { key: value }. Fetched once per page. */
var hopeSettingsPromise = null;
window.hopeSettings = function () {
  if (!hopeSettingsPromise) {
    var cfg = window.HOPE_SUPABASE;
    hopeSettingsPromise = fetch(cfg.url + "/rest/v1/site_settings?select=key,value", {
      headers: { apikey: cfg.publishableKey }
    }).then(function (res) { return res.ok ? res.json() : []; })
      .then(function (rows) {
        var s = {};
        rows.forEach(function (r) { s[r.key] = r.value; });
        return s;
      })
      .catch(function () { return {}; });
  }
  return hopeSettingsPromise;
};

/* Public address of the payment QR code uploaded by an admin. */
window.hopeQrUrl = function (version) {
  return window.HOPE_SUPABASE.url + "/storage/v1/object/public/site-assets/payment-qr?v=" + encodeURIComponent(version);
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

/* Turn a chosen picture into the ID-card photo: cropped to 3:4 from the centre,
   600 × 800 pixels, JPEG. Resolves with a File named "photo.jpg" (well under 2 MB). */
window.hopeIdPhoto = function (file) {
  return new Promise(function (resolve, reject) {
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) { reject(new Error("type")); return; }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var W = 600, H = 800, sw = img.naturalWidth, sh = img.naturalHeight;
      if (sw < 150 || sh < 200) { URL.revokeObjectURL(url); reject(new Error("small")); return; }
      var cropW = Math.min(sw, sh * 3 / 4), cropH = cropW * 4 / 3;
      var canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, (sw - cropW) / 2, Math.max(0, (sh - cropH) / 2), cropW, cropH, 0, 0, W, H);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error("convert")); return; }
        resolve(new File([blob], "photo.jpg", { type: "image/jpeg" }));
      }, "image/jpeg", 0.88);
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("read")); };
    img.src = url;
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
