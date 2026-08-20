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

/**
 * A plausible candidate CV, with the fields the resume extractor looks for.
 *
 * `discriminator` puts one line of unique text in the file, and it exists
 * because of a real failure it caused. Every mocked download used to return
 * byte-identical bytes, so two test candidates who both "sent a CV" sent *the
 * same file* — and the CRM, correctly, treats one résumé hash as one candidate
 * and folded the second person into the first. That is the exact-duplicate rule
 * working exactly as the mailbox pipeline needs it to; it was the fixture that
 * was lying, by making two different people indistinguishable in a way two
 * different people never are.
 *
 * The line is content, not metadata, so it survives extraction and changes the
 * hash. Nothing reads it.
 */
export const SAMPLE_RESUME_PDF = (discriminator?: string): Buffer =>
  makeTextPdf([
    ...(discriminator ? [`Reference: ${discriminator}`, ''] : []),
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

/**
 * An Aadhaar card, carrying the markers `DOCUMENT_MARKERS.aadhaar` looks for.
 *
 * Same person as the CV above, deliberately: §17 compares identity across every
 * document a contact sends, and two fixtures disagreeing about a name would have
 * the harness raising a mismatch on every run.
 */
export const SAMPLE_AADHAAR_PDF = (): Buffer =>
  makeTextPdf([
    'GOVERNMENT OF INDIA',
    'UNIQUE IDENTIFICATION AUTHORITY OF INDIA',
    '',
    'ASHA KUMARI',
    'Date of Birth: 14/03/1994',
    'Female',
    '',
    '2345 6789 0123',
    'AADHAAR - Aam Aadmi ka Adhikar',
    '',
    'Address: 14 Bharathi Street, Tiruchirappalli,',
    'Tamil Nadu 620001',
  ]);

/**
 * The one fixture that is chosen rather than fixed.
 *
 * Every mocked download used to serve the CV, whatever had been asked for, so
 * the identity-document steps could only ever exercise the "that is not the
 * document we asked for" path. Picking on the filename lets the harness walk the
 * ordinary case as well — which is the case a real contact is in.
 */
export function fixtureFor(filename?: string, discriminator?: string): Buffer {
  const name = filename ?? '';
  if (/aadhaa?r/i.test(name)) return SAMPLE_AADHAAR_PDF();
  if (/passport/i.test(name)) return SAMPLE_PASSPORT_PDF();
  return SAMPLE_RESUME_PDF(discriminator);
}

/**
 * A passport bio page, carrying the MRZ band `DOCUMENT_MARKERS.passport` looks
 * for and the expiry date §12 now reads off the page instead of asking for.
 *
 * Same person as the CV, for the reason the Aadhaar fixture gives.
 */
export const SAMPLE_PASSPORT_PDF = (): Buffer =>
  makeTextPdf([
    'REPUBLIC OF INDIA',
    'PASSPORT',
    '',
    'Type: P    Country Code: IND    Passport No.: Z1234567',
    'Surname: KUMARI',
    'Given Name: ASHA',
    'Nationality: INDIAN',
    'Date of Birth: 14/03/1994',
    'Place of Birth: TIRUCHIRAPPALLI',
    'Date of Issue: 12/05/2021    Date of Expiry: 11/05/2031',
    'Place of Issue: MADURAI',
    '',
    'P<INDKUMARI<<ASHA<<<<<<<<<<<<<<<<<<<<<<<<<<<',
    'Z1234567<4IND9403144F3105114<<<<<<<<<<<<<<02',
  ]);
