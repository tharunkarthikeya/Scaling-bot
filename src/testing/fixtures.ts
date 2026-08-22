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
 * The same, with one real page object per page.
 *
 * §14 wants the whole booklet, and `TUNABLES.passportMinPdfPages` is 2, so a
 * single-page passport is reported incomplete however well it scanned. That
 * verdict is correct and is not something a fixture should route around — the
 * honest way to exercise the complete-booklet path is a file that genuinely
 * has the pages, which is what this builds.
 *
 * `scanPageObjects` counts `/Type /Page` objects off the raw bytes rather than
 * reading `/Count`, so the pages have to be real objects; a padded `/Count`
 * would be a lie the counter is specifically written not to believe.
 */
export function makeMultiPageTextPdf(pages: string[][]): Buffer {
  // 1 catalog, 2 page tree, 3 font, then a page object and a content stream per
  // page — so page i is object 4 + 2i and its stream is 5 + 2i.
  const pageObjNum = (i: number) => 4 + i * 2;

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(' ')}] ` +
      `/Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  pages.forEach((lines, i) => {
    const content =
      'BT\n/F1 13 Tf\n1 0 0 1 56 780 Tm\n16 TL\n' +
      lines.map((l) => `(${escapePdfText(l)}) Tj T*`).join('\n') +
      '\nET\n';

    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObjNum(i) + 1} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    );
  });

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
    // A valid TD3 band. Every check digit is computed with the ICAO 9303
    // 7-3-1 weighting rather than typed by hand, because the previous digits
    // did not validate and the live service said so: a real submission scored
    // 0.40 with "MRZ check digits did not validate" as its first complaint,
    // which put it under the 0.85 `keepExtraction` threshold and meant no
    // extracted values were ever kept.
    //   passport Z1234567< -> 1   dob 940314 -> 3   expiry 310511 -> 3
    //   personal (filler)  -> 0   composite      -> 4
    'P<INDKUMARI<<ASHA<<<<<<<<<<<<<<<<<<<<<<<<<<<',
    'Z1234567<1IND9403143F3105113<<<<<<<<<<<<<<04',
  ]);

/**
 * The whole booklet, for the case the single-page fixture cannot reach.
 *
 * `SAMPLE_PASSPORT_PDF` is one page, which §14 correctly calls incomplete, so
 * `keepExtraction` discards its values and no test using it can show an
 * extraction actually being stored. This is the same fictional person with the
 * pages §14 asks for, so the complete-booklet path is exercised on a document
 * that genuinely satisfies it rather than on a relaxed rule.
 *
 * Confidence is the extractor's to decide and no fixture can assert it. What
 * this fixture removes is every *other* reason the verdict came back
 * incomplete: the MRZ check digits validate, and the pages are present.
 */
export const REALISTIC_PASSPORT_PDF = (): Buffer =>
  makeMultiPageTextPdf([
    [
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
      'Z1234567<1IND9403143F3105113<<<<<<<<<<<<<<04',
    ],
    [
      'REPUBLIC OF INDIA',
      '',
      'Name of Father: RAMESH KUMAR',
      'Name of Mother: LAKSHMI KUMARI',
      'Name of Spouse: --',
      'Address: 14 BHARATHI STREET',
      '         TIRUCHIRAPPALLI, TAMIL NADU 620001',
      '',
      'Old Passport No. / Date of Issue: --',
      'File No.: TN1234567890',
    ],
    [
      'OBSERVATIONS',
      '',
      'ECR / ECNR: ECNR',
      '',
      'This passport contains 36 pages.',
    ],
    ['VISAS', '', '(no entries)'],
    ['', '(this page intentionally blank)'],
  ]);
