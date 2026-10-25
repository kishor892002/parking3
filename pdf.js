/* Minimal PDF writer (no dependencies).
 * Builds a single A4 page with text and an optional JPEG image (the payment QR),
 * so the bill and the QR code end up in one PDF file.
 */
(function (root) {
  'use strict';

  const PAGE_W = 595;   // A4 in points
  const PAGE_H = 842;
  const MARGIN = 56;

  // Keep text printable ASCII (standard PDF fonts); escape PDF string characters.
  const clean = s => String(s)
    .replace(/[   ]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/([\\()])/g, '\\$1');

  const num = n => Number(n.toFixed(2));

  function base64ToBytes(dataUri) {
    const b64 = dataUri.slice(dataUri.indexOf(',') + 1);
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64')); // Node (tests)
  }

  /**
   * doc = {
   *   title, subtitle,
   *   rows: [[label, value], ...],
   *   totalLabel, total,
   *   qrMatrix: { size, modules } | null,   (generated QR, preferred)
   *   qr: { data, width, height } | null,   (JPEG fallback)
   *   qrCaption, qrNote,
   *   paid: boolean,
   *   footer
   * }
   * Returns a Uint8Array containing the PDF.
   */
  function build(doc) {
    const ops = [];
    const text = (x, y, size, str, bold, gray) => {
      const color = gray ? '0.42 0.46 0.54 rg' : '0.11 0.14 0.2 rg';
      ops.push(`BT ${color} /${bold ? 'F2' : 'F1'} ${size} Tf ${num(x)} ${num(y)} Td (${clean(str)}) Tj ET`);
    };
    const textCentered = (y, size, str, bold, gray) => {
      // Helvetica averages ~0.52 em per character; good enough for centring.
      const w = clean(str).length * size * (bold ? 0.56 : 0.5);
      text(Math.max(MARGIN, (PAGE_W - w) / 2), y, size, str, bold, gray);
    };
    const line = (x1, x2, yy) =>
      ops.push(`0.89 0.91 0.94 RG 0.8 w ${num(x1)} ${num(yy)} m ${num(x2)} ${num(yy)} l S`);

    let y = PAGE_H - MARGIN;

    // Header
    ops.push('0.15 0.39 0.92 rg ' + `${MARGIN} ${y - 30} 34 34 re f`);
    ops.push(`BT 1 1 1 rg /F2 20 Tf ${MARGIN + 11} ${y - 22} Td (P) Tj ET`);
    text(MARGIN + 46, y - 12, 20, 'ParkEase', true);
    text(MARGIN + 46, y - 28, 10, 'Vehicle Parking Management', false, true);
    y -= 56;
    line(MARGIN, PAGE_W - MARGIN, y);

    // Title
    y -= 34;
    text(MARGIN, y, 18, doc.title, true);
    if (doc.paid) {
      ops.push('0.09 0.64 0.29 rg');
      ops.push(`BT /F2 16 Tf ${PAGE_W - MARGIN - 44} ${y} Td (PAID) Tj ET`);
    }
    y -= 12;

    // Detail rows
    doc.rows.forEach(([label, value]) => {
      y -= 24;
      text(MARGIN, y, 11, label, false, true);
      text(MARGIN + 150, y, 11, value, false);
      line(MARGIN, PAGE_W - MARGIN, y - 8);
    });

    // Total
    y -= 36;
    text(MARGIN, y, 14, doc.totalLabel, true);
    text(MARGIN + 150, y, 18, doc.total, true);

    // Payment QR: either a generated matrix (drawn as vector squares)
    // or a fallback JPEG image.
    const matrix = doc.qrMatrix || null;
    const image = matrix ? null : (doc.qr || null);
    if (matrix || image) {
      const qrW = 210;
      const qrH = matrix ? qrW : qrW * image.height / image.width;
      y -= 30;
      textCentered(y, 12, doc.qrCaption || 'Scan to pay', true);
      y -= 12;
      const qx = (PAGE_W - qrW) / 2;
      const qy = y - qrH;
      if (matrix) {
        const quiet = 4;
        const cell = qrW / (matrix.size + quiet * 2);
        ops.push(`1 1 1 rg ${num(qx)} ${num(qy)} ${num(qrW)} ${num(qrH)} re f`);
        ops.push('0 0 0 rg');
        matrix.modules.forEach((row, r) => {
          let c = 0;
          while (c < matrix.size) {
            if (!row[c]) { c++; continue; }
            let end = c;
            while (end < matrix.size && row[end]) end++;
            const rx = qx + (c + quiet) * cell;
            const ry = qy + qrH - (r + quiet + 1) * cell;
            // tiny overlap hides hairline seams between neighbouring squares
            ops.push(`${num(rx)} ${num(ry)} ${num((end - c) * cell + 0.15)} ${num(cell + 0.15)} re`);
            c = end;
          }
        });
        ops.push('f');
      } else {
        ops.push(`q ${num(qrW)} 0 0 ${num(qrH)} ${num(qx)} ${num(qy)} cm /Im1 Do Q`);
      }
      y = qy - 18;
      if (doc.qrNote) textCentered(y, 10, doc.qrNote, false, true);
    }

    // Footer
    textCentered(MARGIN, 9, doc.footer || 'Thank you for parking with us.', false, true);

    const content = ops.join('\n');

    // ----- Assemble PDF objects -----
    const enc = new TextEncoder();
    const parts = [];
    const offsets = [];
    let offset = 0;
    const push = d => {
      const b = typeof d === 'string' ? enc.encode(d) : d;
      parts.push(b);
      offset += b.length;
    };
    const obj = (n, body) => { offsets[n] = offset; push(`${n} 0 obj\n${body}\nendobj\n`); };

    const hasImg = !!image;
    const xobject = hasImg ? ' /XObject << /Im1 7 0 R >>' : '';
    const total = hasImg ? 7 : 6;

    push('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
           `/Resources << /Font << /F1 4 0 R /F2 5 0 R >>${xobject} >> /Contents 6 0 R >>`);
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    obj(6, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

    if (hasImg) {
      const bytes = base64ToBytes(image.data);
      offsets[7] = offset;
      push(`7 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
           `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
      push(bytes);
      push('\nendstream\nendobj\n');
    }

    const xrefPos = offset;
    let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= total; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    push(xref + `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

    const out = new Uint8Array(offset);
    let pos = 0;
    parts.forEach(p => { out.set(p, pos); pos += p.length; });
    return out;
  }

  function download(doc, filename) {
    const blob = new Blob([build(doc)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const api = { build, download };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ParkPdf = api;
})(typeof window !== 'undefined' ? window : globalThis);
