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

async function addDocument(
  page: Page,
  title: string,
  category: string,
  content: string,
): Promise<void> {
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Category').selectOption(category);
  await page.getByLabel('Paste text').fill(content);
  await page.getByRole('button', { name: 'Save securely' }).click();
  await expect(page.getByText(title)).toBeVisible();
}

test('a user signs up, stores documents and gets grounded answers', async ({ page }) => {
  await page.goto('/');
  await page.screenshot({ path: `${SHOTS}/01-sign-in.png`, fullPage: true });

  const email = uniqueEmail('portal');
  await signUp(page, email);

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
  await page.screenshot({ path: `${SHOTS}/02-documents.png`, fullPage: true });

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
  await expect(intruderPage.locator('#document-list')).toContainText('No documents yet');
  await intruderPage.screenshot({ path: `${SHOTS}/05-isolated-accounts.png`, fullPage: true });
  await intruderPage.close();
});

test('a user can sign out, sign back in, delete a document and erase the account', async ({
  page,
}) => {
  const email = uniqueEmail('lifecycle');
  await signUp(page, email);
  await addDocument(page, 'Notes', 'other', 'Remember to renew the passport in June 2027.');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: /Sign in or create/ })).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password (minimum 12 characters)').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Notes')).toBeVisible();

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('#document-list')).toContainText('No documents yet');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByText('Account and all documents erased.')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/06-account-erased.png`, fullPage: true });
});
