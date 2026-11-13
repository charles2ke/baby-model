import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'docs/screenshots';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

const PASSWORD = 'correct-horse-battery-staple';

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password (minimum 12 characters)').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Ask your documents' })).toBeVisible();
}

/** Submits the sign-in form; callers check whether it let them in. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password (minimum 12 characters)').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Every page does one thing, so tests move between them through the tab bar. */
async function openTab(page: Page, name: string): Promise<void> {
  await page.locator('#tabbar').getByRole('link', { name }).click();
}

async function addDocument(
  page: Page,
  title: string,
  category: string,
  content: string,
): Promise<void> {
  await openTab(page, 'Add');
  // Exact labels: the Documents page also has "Search titles" and "Filter by category".
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Category', { exact: true }).selectOption(category);
  await page.getByLabel('Paste text').fill(content);
  await page.getByRole('button', { name: 'Save securely' }).click();
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
}

test('a user signs up, stores documents and gets grounded answers', async ({ page }) => {
  await page.goto('/');
  // Signed-out visitors only ever get the sign-in page, without the tab bar.
  await expect(page.locator('#tabbar')).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/01-sign-in.png`, fullPage: true });

  const email = uniqueEmail('portal');
  await signUp(page, email);

  // A brand new vault says so on the Ask page instead of answering nothing.
  await expect(page.locator('#ask-empty')).toBeVisible();

  await addDocument(
    page,
    'Annual blood panel 2024',
    'health',
    'Annual blood panel taken on 12 March 2024. HDL cholesterol was 62 mg/dL and LDL cholesterol was 98 mg/dL. Blood pressure measured 118 over 76.',
  );
  await addDocument(
    page,
    'Mortgage summary',
    'finance',
    'The mortgage on the apartment is fixed at 3.4 percent until 2031. The monthly repayment is 1450 EUR.',
  );
  await addDocument(
    page,
    'MSc transcript',
    'education',
    'Completed an MSc in Statistics at Trinity College in 2019 with first class honours.',
  );
  await expect(page.locator('#document-count')).toHaveText('3 documents stored');
  await page.screenshot({ path: `${SHOTS}/02-documents.png`, fullPage: true });

  await openTab(page, 'Ask');
  await expect(page.locator('#ask-empty')).toBeHidden();
  await page.getByLabel('Question').fill('What was my HDL cholesterol?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.locator('#answer')).toContainText('62 mg/dL');
  await expect(page.locator('.citations')).toContainText('Annual blood panel 2024');
  await page.screenshot({ path: `${SHOTS}/03-grounded-answer.png`, fullPage: true });

  await page.getByLabel('Question').fill('Who won the football world cup in 1998?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.locator('#answer')).toContainText('only answer from your own documents');
  await page.screenshot({ path: `${SHOTS}/04-refuses-outside-knowledge.png`, fullPage: true });
});

test('documents are private to the account that uploaded them', async ({ page, context }) => {
  const owner = uniqueEmail('owner');
  await signUp(page, owner);
  await addDocument(
    page,
    'Payslip',
    'finance',
    'My net monthly pay is 4200 EUR after tax deductions.',
  );

  const intruderPage = await context.browser()!.newPage();
  await signUp(intruderPage, uniqueEmail('intruder'));
  await intruderPage.getByLabel('Question').fill('What is my net monthly pay?');
  await intruderPage.getByRole('button', { name: 'Ask' }).click();
  await expect(intruderPage.locator('#answer')).toContainText(
    'none of them contain that information',
  );
  await intruderPage.screenshot({ path: `${SHOTS}/05-isolated-accounts.png`, fullPage: true });
  await openTab(intruderPage, 'Documents');
  await expect(intruderPage.locator('#document-list')).toContainText('No documents yet');
  // There is nothing to search in an empty vault.
  await expect(intruderPage.getByLabel('Search titles')).toBeHidden();
  await intruderPage.close();
});

test('a user can sign out, sign back in, delete a document and erase the account', async ({
  page,
}) => {
  const email = uniqueEmail('lifecycle');
  await signUp(page, email);
  await addDocument(page, 'Notes', 'other', 'Remember to renew the passport in June 2027.');

  await openTab(page, 'Account');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Sign in or create/ })).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password (minimum 12 characters)').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Ask your documents' })).toBeVisible();

  await openTab(page, 'Documents');
  await expect(page.getByText('Notes')).toBeVisible();
  await expect(page.locator('#document-count')).toHaveText('1 document stored');
  // Deleting a document is irreversible, so it asks first.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete Notes' }).click();
  await expect(page.locator('#document-list')).toContainText('No documents yet');
  await expect(page.locator('#document-count')).toHaveText('Nothing stored yet');

  await openTab(page, 'Account');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByText('Account and all documents erased.')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/06-account-erased.png`, fullPage: true });
});

test('every page does one thing and works on a small mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, uniqueEmail('mobile'));

  await addDocument(
    page,
    'Travel insurance',
    'other',
    'The travel insurance policy number is TI-99213 and the cover expires in August 2026.',
  );
  await expect(page.locator('main section.page:visible')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/08-mobile-documents.png`, fullPage: true });

  await openTab(page, 'Ask');
  await expect(page.locator('main section.page:visible')).toHaveCount(1);
  await expect(page.getByLabel('Paste text')).toBeHidden();
  await page.getByLabel('Question').fill('What is my travel insurance policy number?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.locator('#answer')).toContainText('TI-99213');
  await page.screenshot({ path: `${SHOTS}/07-mobile-ask.png`, fullPage: true });

  // The tab bar stays reachable at the bottom of the small screen.
  await expect(page.locator('#tabbar')).toBeVisible();
  await expect(page.locator('#tab-ask')).toHaveAttribute('aria-current', 'page');
});

test('the sign-in password can be revealed before submitting', async ({ page }) => {
  await page.goto('/');
  const password = page.getByLabel('Password (minimum 12 characters)');
  await password.fill(PASSWORD);
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide' }).click();
  await expect(password).toHaveAttribute('type', 'password');
});

test('a status message does not linger on the next page', async ({ page }) => {
  await signUp(page, uniqueEmail('status'));
  await addDocument(page, 'Warranty', 'other', 'The laptop warranty runs until May 2028.');
  await expect(page.locator('#status')).toContainText('Document stored and encrypted.');
  await openTab(page, 'Ask');
  await expect(page.locator('#status')).toHaveText('');
});

test('the theme can be pinned to light or dark and survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, uniqueEmail('theme'));

  await page.getByRole('button', { name: 'Light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Light theme' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'System theme' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.screenshot({ path: `${SHOTS}/09-light-theme.png`, fullPage: true, animations: 'disabled' });

  // The choice is remembered across reloads, before the first paint.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: `${SHOTS}/10-dark-theme.png`, fullPage: true, animations: 'disabled' });

  // `System theme` follows the device, so it flips with the emulated setting.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'System theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'System theme' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('real-world exports are imported and become answerable', async ({ page }) => {
  await signUp(page, uniqueEmail('import'));

  await openTab(page, 'Add');
  await page.getByLabel('Source').selectOption('bank-csv');
  await page.getByLabel('…or paste the contents of the export').fill(
    [
      'Date,Description,Amount,Currency,Balance',
      '2024-03-01,ACME ENERGY direct debit,-84.20,EUR,1203.55',
      '2024-03-02,Monthly salary,3200.00,EUR,4403.55',
    ].join('\n'),
  );
  await page.getByRole('button', { name: 'Save securely' }).click();
  await expect(page.getByText('Account statement (CSV import)')).toBeVisible();

  await openTab(page, 'Add');
  await page.getByLabel('Source').selectOption('fhir');
  await page.getByLabel('…or paste the contents of the export').fill(
    JSON.stringify({
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Observation',
            code: { text: 'HDL cholesterol' },
            valueQuantity: { value: 62, unit: 'mg/dL' },
            effectiveDateTime: '2024-03-12',
          },
        },
      ],
    }),
  );
  await page.getByRole('button', { name: 'Save securely' }).click();
  await expect(page.getByText('Health records (FHIR export)')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/11-imported-real-world-data.png`, fullPage: true });

  await openTab(page, 'Ask');
  await page.getByLabel('Question').fill('What was my monthly salary payment?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.locator('#answer')).toContainText('3200.00 EUR');
  await expect(page.locator('.citations')).toContainText('Account statement (CSV import)');
  await page.screenshot({ path: `${SHOTS}/12-answer-from-imported-statement.png`, fullPage: true });

  // A file the connector cannot read is refused instead of stored.
  await openTab(page, 'Add');
  await page.getByLabel('Source').selectOption('fhir');
  await page.getByLabel('…or paste the contents of the export').fill('not a health export');
  await page.getByRole('button', { name: 'Save securely' }).click();
  await expect(page.locator('#status')).toContainText('not valid JSON');
});

test('a skill reshapes the answer without leaving the documents', async ({ page }) => {
  await signUp(page, uniqueEmail('skills'));

  await addDocument(
    page,
    'Vaccination record',
    'health',
    'Tetanus booster given in 2021. Tetanus vaccination first given in 2011. Tetanus booster due again in 2031.',
  );

  await openTab(page, 'Ask');
  await page.getByLabel('Question').fill('What is the history of my tetanus booster?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.locator('#answer')).toContainText('Skill applied: Build a timeline');
  await expect(page.locator('#answer p').first()).toContainText('• Tetanus vaccination first given in 2011.');
  await expect(page.locator('.citations')).toContainText('Vaccination record');
  await page.screenshot({ path: `${SHOTS}/13-skill-timeline.png`, fullPage: true });
});

test('documents can be searched, filtered and opened where an answer quoted them', async ({ page }) => {
  await signUp(page, uniqueEmail('reader'));
  await addDocument(
    page,
    'Passport renewal',
    'other',
    'Remember to renew the passport in June 2027. <b>Bring</b> two photos.',
  );
  await addDocument(
    page,
    'Home insurance',
    'finance',
    'The home insurance policy renews every January.\nPolicy number: HI-4471\nInsurer: Harbour Mutual',
  );
  await addDocument(
    page,
    'GP visit notes',
    'health',
    [
      'Visit with Dr Byrne at the Main Street clinic.',
      'Blood type: O positive',
      'Allergies: penicillin',
      'Next check-up booked for 3 September 2025.',
    ].join('\n'),
  );

  // A title search ignores case, and combines with the category filter.
  const list = page.locator('#document-list');
  const summary = page.locator('#document-filter-summary');
  await expect(summary).toBeHidden();
  await page.getByLabel('Search titles').fill('INSURANCE');
  await expect(list.locator('li')).toHaveCount(1);
  await expect(list).toContainText('Home insurance');
  await expect(summary).toHaveText('Showing 1 of 3 documents');
  await page.getByLabel('Filter by category').selectOption('health');
  await expect(list).toContainText('No documents match your search.');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(list.locator('li')).toHaveCount(3);
  await expect(summary).toBeHidden();
  await expect(page.getByLabel('Search titles')).toHaveValue('');
  await page.getByLabel('Search titles').fill('visit');
  await page.getByLabel('Filter by category').selectOption('health');
  await expect(list.locator('li')).toHaveCount(1);
  await expect(summary).toHaveText('Showing 1 of 3 documents');
  await page.screenshot({ path: `${SHOTS}/15-document-filters.png`, fullPage: true, animations: 'disabled' });

  // A title opens the document as written; markup in it stays plain text.
  await page.getByLabel('Search titles').fill('');
  await page.getByLabel('Filter by category').selectOption('');
  await page.getByRole('link', { name: 'Passport renewal', exact: true }).click();
  const reader = page.locator('#document-page');
  await expect(reader.getByRole('heading', { name: 'Passport renewal' })).toBeVisible();
  await expect(page.locator('#reader-meta')).toContainText('other');
  await expect(page.locator('#reader-content')).toHaveText(
    'Remember to renew the passport in June 2027. <b>Bring</b> two photos.',
  );
  await expect(page.locator('#reader-content b')).toHaveCount(0);
  await expect(page.locator('#reader-note')).toBeHidden();
  await expect(page.locator('#tab-documents')).toHaveClass(/active/);
  await expect(page.locator('main section.page:visible')).toHaveCount(1);
  await page.getByRole('link', { name: 'All documents' }).click();
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();

  // A citation opens its document with the quoted passage marked.
  await openTab(page, 'Ask');
  await page.getByLabel('Question').fill('What is my blood type?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.locator('#answer')).toContainText('Blood type: O positive');
  await page.locator('.citations').getByRole('link', { name: 'GP visit notes' }).click();
  await expect(reader.getByRole('heading', { name: 'GP visit notes' })).toBeVisible();
  await expect(page.locator('#reader-content mark')).toHaveText(['Blood type: O positive']);
  await expect(page.locator('#reader-content')).toContainText('Allergies: penicillin');
  await expect(page.locator('#reader-note')).toBeVisible();
  // Only the document is in the address; what was quoted from it stays in memory.
  expect(new URL(page.url()).hash).toMatch(/^#\/documents\/\d+$/);
  await page.screenshot({ path: `${SHOTS}/14-document-reader.png`, fullPage: true, animations: 'disabled' });

  // Reopening the document later shows it without the old highlight.
  await page.getByRole('link', { name: 'All documents' }).click();
  await page.getByRole('link', { name: 'GP visit notes', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'GP visit notes' })).toBeVisible();
  await expect(page.locator('#reader-content')).toContainText('Blood type: O positive');
  await expect(page.locator('#reader-content mark')).toHaveCount(0);
});

test('a user can sign out other sessions and change the password', async ({ page, browser }) => {
  const NEW_PASSWORD = 'a-brand-new-long-passphrase';
  const email = uniqueEmail('security');
  await signUp(page, email);
  const laptop = await browser.newContext();
  const other = await laptop.newPage();
  await signIn(other, email, PASSWORD);
  await expect(other.getByRole('heading', { name: 'Ask your documents' })).toBeVisible();

  await openTab(page, 'Account');
  const sessions = page.locator('#sessions-summary');
  await expect(sessions).toHaveText('1 other session is signed in to your account.');
  await page.screenshot({ path: `${SHOTS}/16-account-security.png`, fullPage: true, animations: 'disabled' });

  // Signing out everywhere else asks first, and keeps this session.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Sign out other sessions' }).click();
  await expect(page.locator('#status')).toHaveText('Signed out 1 other session.');
  await expect(sessions).toHaveText('No other session is signed in to your account.');
  await other.reload();
  await expect(other.getByRole('heading', { name: /Sign in or create/ })).toBeVisible();

  // A password change needs the current password and a matching confirmation.
  await signIn(other, email, PASSWORD);
  await expect(other.getByRole('heading', { name: 'Ask your documents' })).toBeVisible();
  await page.getByLabel('Current password').fill('not-the-current-password');
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('#status')).toHaveText('Your current password is incorrect');
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('Confirm new password').fill(`${NEW_PASSWORD}!`);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('#status')).toHaveText(
    'The new password and its confirmation do not match.',
  );
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('#status')).toHaveText('Password changed and 1 other session signed out.');
  await expect(page.getByLabel('Current password')).toHaveValue('');
  await expect(page.getByLabel('New password', { exact: true })).toHaveValue('');
  await other.reload();
  await expect(other.getByRole('heading', { name: /Sign in or create/ })).toBeVisible();
  await laptop.close();

  // This session carries on, with the token issued along with the new password.
  await addDocument(page, 'Locker code', 'other', 'The gym locker code is 4821.');

  // From now on only the new password signs in.
  await openTab(page, 'Account');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, email, PASSWORD);
  await expect(page.locator('#status')).toHaveText('Invalid credentials');
  await signIn(page, email, NEW_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Ask your documents' })).toBeVisible();
});
