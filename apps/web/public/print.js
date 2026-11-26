// Receives already-escaped HTML (rendered by RAYAN's safe Markdown renderer) from the same origin and opens the print dialog (Save as PDF).
window.addEventListener("message", function (e) {
  if (e.origin !== location.origin) return;
  var d = e.data;
  if (!d || d.type !== "rayan-print" || typeof d.html !== "string") return;
  document.title = (d.title || "rayan").replace(/\.pdf$/i, "");
  document.getElementById("doc").innerHTML = d.html;
  setTimeout(function () { window.print(); }, 300);
}, { once: true });
