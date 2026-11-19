/* Hope Education — digital student ID card (css/id-card.css).
   Used by the student portal (My ID card) and the admin portal (Students → ID card).

   window.hopeIdCard(info, photoUrl) → element with the front and back of the card
     info: { student_id, student_name, subjects, card_valid_until, card_issued_at }
     photoUrl: a (temporary) link to the photo, or null
   window.hopePrintIdCard(element) prints the card at its real size (85.6 × 54 mm).

   The card is in English (like an official document) and all text is set with
   textContent, never as HTML. */
(function () {
  "use strict";

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function fmtDate(d) {
    if (!d) return "—";
    var date = new Date(String(d).length === 10 ? d + "T00:00:00" : d);
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  function site(path) { return new URL(path, location.href).href.replace(/^https?:\/\//, ""); }

  window.hopeIdCard = function (info, photoUrl) {
    var pair = el("div", "id-card-pair");
    pair.setAttribute("data-no-translate", "");

    // ----- Front: band, logo, name, subjects, valid until, photo -----
    var front = el("div", "id-card idc-front");
    front.setAttribute("role", "img");
    front.setAttribute("aria-label", "Student ID card, front: " + info.student_name + ", Student ID " + info.student_id);
    var band = el("div", "idc-band");
    band.appendChild(el("span", "idc-band-title", "Student"));
    var mark = el("span", "idc-band-mark");
    mark.appendChild(el("b", null, "ID"));
    mark.appendChild(document.createTextNode("Card"));
    band.appendChild(mark);
    front.appendChild(band);

    var body = el("div", "idc-front-body");
    var left = el("div", "idc-front-text");
    var logo = el("div", "idc-logo");
    var logoImg = el("img");
    logoImg.src = "images/logo.jpg";
    logoImg.alt = "Hope Online Tuition School";
    logo.appendChild(logoImg);
    left.appendChild(logo);
    left.appendChild(el("p", "idc-name", info.student_name));
    left.appendChild(el("p", "idc-line", "CIE IGCSE" + (info.subjects ? " · " + info.subjects : " · One-to-one tutoring")));
    body.appendChild(left);
    var photo = el("div", "idc-photo");
    if (photoUrl) {
      var img = el("img");
      img.src = photoUrl;
      img.alt = "";
      photo.appendChild(img);
    } else {
      photo.appendChild(el("span", null, "No photo yet"));
    }
    body.appendChild(photo);
    front.appendChild(body);
    front.appendChild(el("p", "idc-valid", "Valid until " + fmtDate(info.card_valid_until)));
    front.appendChild(el("span", "idc-gold"));

    // ----- Back: ownership, portal, if found, Student no -----
    var back = el("div", "id-card idc-back");
    back.setAttribute("role", "img");
    back.setAttribute("aria-label", "Student ID card, back: Student no " + info.student_id);
    back.appendChild(el("span", "idc-strip"));
    var inner = el("div", "idc-back-in");   // padding lives here: "cqw" on the card itself would use the page width
    back.appendChild(inner);
    inner.appendChild(el("p", "idc-back-top", "This card is the property of Hope Education."));
    var cols = el("div", "idc-back-cols");
    var c1 = el("div"), c2 = el("div");
    var p1 = el("p"); p1.appendChild(el("b", null, "Student portal:")); p1.appendChild(el("u", null, site("login.html"))); c1.appendChild(p1);
    var p2 = el("p"); p2.appendChild(el("b", null, "Questions?")); p2.appendChild(document.createTextNode("Message us in the student portal or at "));
    p2.appendChild(el("u", null, site("contact.html"))); c1.appendChild(p2);
    var p3 = el("p"); p3.appendChild(el("b", null, "If found,")); p3.appendChild(document.createTextNode("please return it to Hope Education through "));
    p3.appendChild(el("u", null, site("contact.html"))); c2.appendChild(p3);
    var p4 = el("p"); p4.appendChild(el("b", null, "Issued")); p4.appendChild(document.createTextNode(fmtDate(info.card_issued_at))); c2.appendChild(p4);
    cols.appendChild(c1); cols.appendChild(c2);
    inner.appendChild(cols);
    var no = el("p", "idc-back-no");
    no.appendChild(el("span", null, "Student no:"));
    no.appendChild(document.createTextNode(String(info.student_id)));
    inner.appendChild(no);

    pair.appendChild(front);
    pair.appendChild(back);
    return pair;
  };

  window.hopePrintIdCard = function (pair) {
    var holder = el("div", "id-card-print");
    holder.appendChild(pair.cloneNode(true));
    document.body.appendChild(holder);
    document.body.classList.add("printing-card");
    var imgs = holder.querySelectorAll("img");
    var waits = Array.prototype.map.call(imgs, function (i) {
      return i.complete ? Promise.resolve() : new Promise(function (r) { i.onload = i.onerror = r; });
    });
    Promise.all(waits).then(function () {
      window.print();
      setTimeout(function () { document.body.classList.remove("printing-card"); holder.remove(); }, 500);
    });
  };
})();
