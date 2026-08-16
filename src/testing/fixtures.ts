/**
 * Test fixtures. Only reachable when MOCK_WHATSAPP_MEDIA is on.
 */

function escapePdfText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Builds a real, single-page PDF containing the given lines as selectable text.
 *
 * A blank PDF is useless for testing OCR — the extractor correctly rejects it
 * for having nothing to transcribe, which tells you nothing about whether your
 * integration works. This produces a file with actual readable content.
 */
export function makeTextPdf(lines: string[]): Buffer {
  const content =
    'BT\n/F1 13 Tf\n1 0 0 1 56 780 Tm\n16 TL\n' +
    lines.map((l) => `(${escapePdfText(l)}) Tj T*`).join('\n') +
    '\nET\n';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** A plausible candidate CV, with the fields the resume extractor looks for. */
export const SAMPLE_RESUME_PDF = (): Buffer =>
  makeTextPdf([
    'ASHA KUMARI',
    'Certified Welder (6G) - Structural and Pipe Welding',
    '',
    'Email: asha.kumari@example.com',
    'Phone: +91 90000 00001',
    'Address: Tiruchirappalli, Tamil Nadu, India',
    'Date of Birth: 14 March 1994',
    'Nationality: Indian',
    'Passport Number: Z1234567',
    '',
    'EXPERIENCE',
    'Senior Welder, Larsen and Toubro, Chennai',
    'January 2019 to present. Structural welding on refinery projects.',
    '',
    'Welder, Gulf Steel Works, Sharjah, UAE',
    'June 2016 to December 2018. Pipe welding, offshore fabrication.',
    '',
    'EDUCATION',
    'Diploma in Mechanical Engineering, Government Polytechnic, 2015',
    'ITI Welder Certification, National Trade Certificate, 2013',
    '',
    'SKILLS',
    'SMAW, GTAW, MIG welding, blueprint reading, pipe fitting',
  ]);
