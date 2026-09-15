import { describe, expect, it } from 'vitest';
import {
  IntegrationError,
  decodeEncodedWords,
  decodeQuotedPrintable,
  detectDelimiter,
  formatIcalDate,
  getIntegration,
  listIntegrations,
  parseAmount,
  parseCsvLine,
  runIntegration,
} from '../../server/src/lib/integrations.js';

function convert(id: string, raw: string): { title: string; content: string } {
  const integration = getIntegration(id);
  if (!integration) {
    throw new Error(`missing integration ${id}`);
  }
  return integration.convert(raw);
}

describe('integration catalogue', () => {
  it('lists every connector without exposing its implementation', () => {
    const summaries = listIntegrations();
    expect(summaries.map((summary) => summary.id)).toEqual([
      'fhir',
      'bank-csv',
      'email',
      'icalendar',
    ]);
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty('convert');
      expect(summary.description.length).toBeGreaterThan(10);
      expect(summary.fileExtensions.length).toBeGreaterThan(0);
    }
  });

  it('has no connector for an unknown id', () => {
    expect(getIntegration('dropbox')).toBeUndefined();
  });

  it('never leaks an unexpected failure to the caller', () => {
    const broken = {
      ...(getIntegration('fhir') as NonNullable<ReturnType<typeof getIntegration>>),
      convert: () => {
        throw new TypeError('internal detail');
      },
    };
    expect(() => runIntegration(broken, 'x')).toThrow('That export could not be read');
    expect(() => runIntegration(getIntegration('fhir') as NonNullable<ReturnType<typeof getIntegration>>, 'nope')).toThrow(
      'not valid JSON',
    );
  });
});

describe('FHIR health records', () => {
  const bundle = {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      { resource: { resourceType: 'Patient', name: [{ given: ['Ada'], family: 'Lovelace' }], birthDate: '1985-12-10', gender: 'female' } },
      {
        resource: {
          resourceType: 'Observation',
          code: { text: 'HDL cholesterol' },
          valueQuantity: { value: 62, unit: 'mg/dL' },
          effectiveDateTime: '2024-03-12',
        },
      },
      {
        resource: {
          resourceType: 'Condition',
          code: { coding: [{ display: 'Type 2 diabetes mellitus' }] },
          clinicalStatus: { coding: [{ code: 'active' }] },
          onsetDateTime: '2021-06-01',
        },
      },
      {
        resource: {
          resourceType: 'MedicationRequest',
          medicationCodeableConcept: { text: 'Metformin 500 mg' },
          dosageInstruction: [{ text: 'twice daily with food' }],
          authoredOn: '2023-01-04',
        },
      },
      {
        resource: {
          resourceType: 'AllergyIntolerance',
          code: { text: 'Penicillin' },
          criticality: 'high',
          recordedDate: '2010-02-02',
        },
      },
      {
        resource: {
          resourceType: 'Immunization',
          vaccineCode: { text: 'Influenza vaccine' },
          occurrenceDateTime: '2024-10-01',
        },
      },
      { resource: { resourceType: 'Procedure', code: { text: 'Appendectomy' }, performedDateTime: '2015-08-19' } },
      {
        resource: {
          resourceType: 'DiagnosticReport',
          code: { text: 'Lipid panel' },
          conclusion: 'Within reference range',
          issued: '2024-03-13',
        },
      },
      { resource: { resourceType: 'CarePlan', id: 'plan-1' } },
      { resource: { resourceType: 'Coverage' } },
      { resource: null },
    ],
  };

  it('renders a patient portal bundle as readable text', () => {
    const result = convert('fhir', JSON.stringify(bundle));
    expect(result.title).toBe('Health records for Ada Lovelace');
    expect(result.content).toContain('Patient: Ada Lovelace, born 1985-12-10, gender female');
    expect(result.content).toContain('HDL cholesterol: 62 mg/dL (recorded 2024-03-12)');
    expect(result.content).toContain('Condition: Type 2 diabetes mellitus, status active (recorded 2021-06-01)');
    expect(result.content).toContain('Medication: Metformin 500 mg, twice daily with food (recorded 2023-01-04)');
    expect(result.content).toContain('Allergy: Penicillin, criticality high (recorded 2010-02-02)');
    expect(result.content).toContain('Immunisation: Influenza vaccine (recorded 2024-10-01)');
    expect(result.content).toContain('Procedure: Appendectomy (recorded 2015-08-19)');
    expect(result.content).toContain('Report: Lipid panel. Within reference range (recorded 2024-03-13)');
    expect(result.content).toContain('CarePlan: plan-1');
    expect(result.content).toContain('Coverage: recorded');
  });

  it('accepts a bare array of resources and single resources', () => {
    expect(convert('fhir', JSON.stringify([{ resourceType: 'Observation', code: { text: 'Weight' }, valueString: '72 kg' }])).content).toBe(
      'Weight: 72 kg',
    );
    expect(convert('fhir', JSON.stringify({ resourceType: 'Observation', code: {}, valueCodeableConcept: { text: 'Negative' } })).content).toBe(
      'Observation: Negative',
    );
  });

  it('falls back gracefully on sparse resources', () => {
    const sparse = [
      { resourceType: 'Patient', name: [{ text: 'Unknown person' }] },
      { resourceType: 'Patient', name: [] },
      { resourceType: 'Observation', code: { coding: [] }, effectivePeriod: { start: '2020-01-01' } },
      { resourceType: 'Condition' },
      { resourceType: 'MedicationRequest' },
      { resourceType: 'AllergyIntolerance' },
      { resourceType: 'Immunization' },
      { resourceType: 'Procedure' },
      { resourceType: 'DiagnosticReport', code: { text: 'X-ray' }, effectiveDateTime: '2022-05-05' },
      { resourceType: 'Observation', code: { text: 'Steps' }, valueQuantity: { value: 8000 } },
      { resourceType: 'DiagnosticReport' },
      { id: 'no-type' },
    ];
    const result = convert('fhir', JSON.stringify(sparse));
    expect(result.title).toBe('Health records for Unknown person');
    expect(result.content).toContain('Patient: unnamed');
    expect(result.content).toContain('Observation: recorded (recorded 2020-01-01)');
    expect(result.content).toContain('Condition: unspecified');
    expect(result.content).toContain('Medication: unspecified');
    expect(result.content).toContain('Allergy: unspecified');
    expect(result.content).toContain('Immunisation: unspecified');
    expect(result.content).toContain('Procedure: unspecified');
    expect(result.content).toContain('Report: X-ray (recorded 2022-05-05)');
    expect(result.content).toContain('Steps: 8000');
    expect(result.content).toContain('Report: unspecified');
  });

  it('rejects files that are not FHIR', () => {
    expect(() => convert('fhir', '   ')).toThrow(IntegrationError);
    expect(() => convert('fhir', 'not json')).toThrow('That file is not valid JSON');
    expect(() => convert('fhir', '"a string"')).toThrow('does not contain FHIR resources');
    expect(() => convert('fhir', JSON.stringify({ resourceType: 'Bundle', entry: [] }))).toThrow(
      'Nothing could be read',
    );
  });
});

describe('bank statement CSV', () => {
  it('reads a typical bank export', () => {
    const csv = [
      'Date,Description,Amount,Currency,Balance',
      '2024-03-01,"ACME ENERGY, direct debit",-84.20,EUR,"1,203.55"',
      '2024-03-02,Salary,3200.00,EUR,4403.55',
      '2024-03-03,Unreadable,,EUR,',
    ].join('\n');
    const result = convert('bank-csv', csv);
    expect(result.title).toBe('Account statement (CSV import)');
    expect(result.content).toContain('Statement with 2 transactions, 3200.00 EUR paid in and 84.20 EUR paid out.');
    expect(result.content).toContain('On 2024-03-01, ACME ENERGY, direct debit: -84.20 EUR, balance 1203.55 EUR.');
    expect(result.content).toContain('On 2024-03-02, Salary: +3200.00 EUR, balance 4403.55 EUR.');
  });

  it('reads separate money in and money out columns', () => {
    const csv = [
      'Transaction Date;Details;Paid out;Paid in',
      '01/04/2024;Rent;1.200,00;',
      '02/04/2024;;;"2.000,00"',
    ].join('\n');
    const result = convert('bank-csv', csv);
    expect(result.content).toContain('On 01/04/2024, Rent: -1200.00.');
    expect(result.content).toContain('On 02/04/2024, Transaction: +2000.00.');
  });

  it('reads a money-in only export with short rows', () => {
    const csv = ['Date,Description,Paid in', '2024-05-01,Refund,25.00', '2024-05-02'].join('\n');
    expect(convert('bank-csv', csv).content).toContain('On 2024-05-01, Refund: +25.00.');
  });

  it('rejects CSV files it cannot understand', () => {
    expect(() => convert('bank-csv', 'a,b,c\n1,2,3')).toThrow('no recognisable date and amount columns');
    expect(() => convert('bank-csv', 'Date,Description,Amount\n')).toThrow('no transactions');
  });

  it('parses quoted CSV fields and amounts', () => {
    expect(parseCsvLine('a,"b,c","say ""hi""",')).toEqual(['a', 'b,c', 'say "hi"', '']);
    expect(parseCsvLine('a;b;c', ';')).toEqual(['a', 'b', 'c']);
    expect(detectDelimiter('Date;Details;Amount')).toBe(';');
    expect(detectDelimiter('Date,Details,Amount')).toBe(',');
    expect(parseAmount('(12.00)')).toBe(-12);
    expect(parseAmount('€ 1.234,56')).toBeCloseTo(1234.56);
    expect(parseAmount('1,234.56')).toBeCloseTo(1234.56);
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount('--')).toBeUndefined();
  });
});

describe('email messages', () => {
  it('imports a plain-text message', () => {
    const eml = [
      'From: Dr Smith <smith@clinic.example>',
      'To: ada@example.com',
      'Cc: office@clinic.example',
      'Subject: =?utf-8?B?QXBwb2ludG1lbnQ=?= confirmation',
      'Date: Tue, 12 Mar 2024 09:00:00 +0000',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Your appointment is confirmed for 19 March at 09:30 in Room =33.',
    ].join('\r\n');
    const result = convert('email', eml);
    expect(result.title).toBe('Email: Appointment confirmation');
    expect(result.content).toContain('From: Dr Smith <smith@clinic.example>');
    expect(result.content).toContain('To: ada@example.com');
    expect(result.content).toContain('Cc: office@clinic.example');
    expect(result.content).toContain('Date: Tue, 12 Mar 2024 09:00:00 +0000');
    expect(result.content).toContain('Room 3.');
  });

  it('prefers the text part of a multipart message', () => {
    const eml = [
      'From: hr@example.com',
      'Subject: Contract',
      'Content-Type: multipart/alternative; boundary="sep"',
      '',
      '--sep',
      'Content-Type: text/plain',
      '',
      'Your salary is 52000 EUR per year.',
      '--sep',
      'Content-Type: text/html',
      '',
      '<p>Your salary is 52000 EUR per year.</p>',
      '--sep--',
    ].join('\n');
    expect(convert('email', eml).content).toContain('Your salary is 52000 EUR per year.');
  });

  it('falls back to the first part and strips HTML', () => {
    const eml = [
      'Subject: Newsletter',
      'Content-Type: multipart/mixed; boundary="x"',
      '',
      '--x',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('<style>p{}</style><p>Board meeting&nbsp;&amp; review</p><br/>Ends &lt;soon&gt; &quot;ok&quot;, &amp;lt;not unescaped twice&amp;gt;, &#39;quoted&apos;').toString('base64'),
      '--x--',
    ].join('\n');
    const result = convert('email', eml);
    expect(result.content).toContain('Board meeting & review');
    expect(result.content).toContain('Ends <soon> "ok"');
    expect(result.content).toContain('&lt;not unescaped twice&gt;');
    expect(result.content).toContain("'quoted'");
  });

  it('uses the first part when no part declares a type', () => {
    const eml = [
      'Subject: Minutes',
      'Content-Type: multipart/mixed; boundary="y"',
      '',
      '--y',
      '',
      'The minutes were approved.',
      '--y--',
    ].join('\n');
    expect(convert('email', eml).content).toContain('The minutes were approved.');
  });

  it('keeps messages without a body or with unknown subjects', () => {
    expect(convert('email', 'From: a@example.com').content).toBe('Subject: Email message\nFrom: a@example.com');
    expect(() => convert('email', 'just some text')).toThrow('not an email message');
  });

  it('decodes header and body encodings', () => {
    expect(decodeEncodedWords('=?utf-8?Q?caf=C3=A9_bill?=')).toBe('café bill');
    expect(decodeEncodedWords('=?utf-8?x?oops?=')).toBe('=?utf-8?x?oops?=');
    expect(decodeQuotedPrintable('line =\r\ncontinues = here')).toBe('line continues = here');
  });
});

describe('calendar exports', () => {
  it('imports events from an ICS file', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'PRODID:-//Example//EN',
      'BEGIN:VEVENT',
      'SUMMARY:Dentist appointment',
      'DTSTART;TZID=Europe/Dublin:20240312T090000',
      'DTEND:20240312T093000',
      'LOCATION:12 Main Street\\, Dublin',
      'DESCRIPTION:Bring the insurance card\\nand a photo ID',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'SUMMARY:All day',
      ' conference',
      'DTSTART;VALUE=DATE:20240401',
      'INVALID-LINE',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'END:VEVENT',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = convert('icalendar', ics);
    expect(result.title).toBe('Calendar events (ICS import)');
    expect(result.content).toContain('Calendar export with 3 events.');
    expect(result.content).toContain(
      'On 2024-03-12 09:00 until 2024-03-12 09:30: Dentist appointment, at 12 Main Street, Dublin. Bring the insurance card and a photo ID.',
    );
    expect(result.content).toContain('On 2024-04-01: All day conference.');
    expect(result.content).toContain('Undated: Appointment.');
  });

  it('rejects calendars without events', () => {
    expect(() => convert('icalendar', 'BEGIN:VCALENDAR\nEND:VCALENDAR')).toThrow('no events');
  });

  it('formats iCalendar dates', () => {
    expect(formatIcalDate('20240312T090000Z')).toBe('2024-03-12 09:00');
    expect(formatIcalDate('20240312')).toBe('2024-03-12');
    expect(formatIcalDate('tomorrow')).toBe('tomorrow');
  });
});
