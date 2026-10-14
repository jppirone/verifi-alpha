// ============================================================================================================
// js/alpha-gate.js - a front page gate for the Applitrust alpha pages. A quick deterrent, NOT security.
//
// What it does: hides the page until a shared access phrase is typed once per browser session (sessionStorage, so closing the tab asks again).
// The phrase itself is NOT in this file: only a salted PBKDF2-SHA256 hash of it (310000 rounds), so reading this file does not reveal it.
// What it does not do: it covers the PAGES only. The backend functions can still be called directly by anyone who knows their addresses,
// and anyone who reads the page source can load the page's own scripts. It never touches the address, so the sign in links keep working.
//
// To switch it off for launch: change GATE_ENABLED below to false (one line) and publish. Nothing else needs to change.
// It is a classic (non-module) script loaded FIRST in the head of index.html, candidate.html, employer.html and staff.html.
// ============================================================================================================
var GATE_ENABLED = true;

(function () {
  "use strict";
  if (!GATE_ENABLED) return;
  var KEY = "applitrust_alpha_gate", SALT = "+Dxl6APLwLwYAwxhTJ2N7w==", HASH = "OBb25NVE+uIjUpfmFcVK7HBLA02kmSOcVpioqLi8FLo=", ITER = 310000;
  var TAG = KEY + "_v", VER = HASH.slice(0, 16);

  // unlocked only if it was unlocked with THIS phrase: a browser session that entered an older phrase is asked again
  var open = false;
  try { open = sessionStorage.getItem(KEY) === "open" && sessionStorage.getItem(TAG) === VER; } catch (e) { open = false; }
  if (open) return;

  var root = document.documentElement;
  root.setAttribute("data-alpha-gate", "locked");
  var style = document.createElement("style");
  style.textContent = 'html[data-alpha-gate="locked"] body > :not(#alphaGate) { display: none !important; }' +
    " #alphaGate { max-width: 360px; margin: 120px auto 0; padding: 0 16px; display: flex; flex-direction: column; gap: 12px; font-family: system-ui, sans-serif; }" +
    " #alphaGate h1 { font-size: 20px; font-weight: 700; margin: 0; }" +
    " #alphaGate p { margin: 0; font-size: 14px; line-height: 1.5; }" +
    " #alphaGate input { font: inherit; padding: 8px 10px; border: 1px solid #999; border-radius: 4px; }" +
    " #alphaGate button { font: inherit; padding: 8px 14px; border: 1px solid #333; border-radius: 4px; background: #333; color: #fff; cursor: pointer; align-self: flex-start; }" +
    " #alphaGate .gate-msg { font-size: 13px; min-height: 1.5em; }";
  (document.head || root).appendChild(style);

  function el(tag, text) { var n = document.createElement(tag); if (text) n.textContent = text; return n; }
  function fromB64(s) { var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function toB64(buf) { var a = new Uint8Array(buf), s = ""; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function matches(pw) {
    if (!window.crypto || !window.crypto.subtle) return Promise.reject(new Error("no crypto"));
    return window.crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]).then(function (k) {
      return window.crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromB64(SALT), iterations: ITER, hash: "SHA-256" }, k, 256);
    }).then(function (bits) { return toB64(bits) === HASH; });
  }

  function build() {
    if (document.getElementById("alphaGate")) return;
    var form = el("form"); form.id = "alphaGate"; form.setAttribute("autocomplete", "off");
    var label = el("label", "Access phrase"); label.htmlFor = "alphaGatePhrase";
    var input = el("input"); input.type = "password"; input.id = "alphaGatePhrase"; input.required = true;
    var msg = el("p"); msg.className = "gate-msg";
    var button = el("button", "Continue");
    form.appendChild(el("h1", "Applitrust alpha"));
    form.appendChild(el("p", "This is a private test site. Enter the access phrase you were given."));
    form.appendChild(label); form.appendChild(input); form.appendChild(button); form.appendChild(msg);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      button.disabled = true; msg.textContent = "Checking...";
      matches(input.value).then(function (ok) {
        if (ok) {
          try { sessionStorage.setItem(KEY, "open"); sessionStorage.setItem(TAG, VER); } catch (e2) { /* the page opens for this load anyway */ }
          root.removeAttribute("data-alpha-gate");
          form.parentNode.removeChild(form);
        } else {
          msg.textContent = "That phrase did not match.";
          input.value = ""; button.disabled = false; input.focus();
        }
      }, function () { msg.textContent = "This page must be opened over https."; button.disabled = false; });
    });
    document.body.appendChild(form);
    input.focus();
  }
  if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
})();
