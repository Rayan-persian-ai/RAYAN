// Sandboxed live preview of AI-generated HTML (opaque origin: no access to RAYAN cookies or storage).
window.addEventListener("message", function (e) {
  var d = e.data;
  if (!d || d.type !== "rayan-preview" || typeof d.html !== "string") return;
  document.open();
  document.write(d.html);
  document.close();
}, { once: true });
