// Browser pass over the web app (R14), also writes screenshots.
// A signs up and sets up a key in the browser, composes with an attachment to B; B (an existing account
// whose key file is imported in the browser) approves, reads, replies; A sees the reply and the read mark.
import { chromium, Page } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { Account, waitFor } from './lib';
import { KeyFile } from '../src/shared/client';

export interface UiOpts {
  A: { base: string; email: string; password: string; handle: string; name: string; signup: boolean };
  B: Account; bEmail: string; bPassword: string;
  C?: Account;
  shots: string; log?: (s: string) => void;
}

export async function runUi(o: UiOpts) {
  const log = o.log ?? console.log;
  mkdirSync(o.shots, { recursive: true });
  // E2E_CHROMIUM points at a Chromium binary when the one Playwright expects is not installed.
  const browser = await chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
  const steps: { name: string; pass: boolean; detail: string }[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); steps.push({ name, pass: true, detail: '' }); log(`PASS UI ${name}`); }
    catch (e) { steps.push({ name, pass: false, detail: String((e as Error).message).slice(0, 300) }); log(`FAIL UI ${name}: ${(e as Error).message}`); throw e; }
  };
  const shot = (p: Page, n: string) => p.screenshot({ path: `${o.shots}/${n}.png` });
  try {
    const ctxA = await browser.newContext({ viewport: { width: 1200, height: 760 }, acceptDownloads: true });
    const a = await ctxA.newPage();
    const ctxB = await browser.newContext({ viewport: { width: 1200, height: 760 } });
    const b = await ctxB.newPage();
    let keyA: KeyFile | null = null;
    await step('A signs up / in and creates a key in the browser', async () => {
      if (o.A.signup) {
        await a.goto(`${o.A.base}/signup`);
        await a.getByLabel('Email').fill(o.A.email); await a.getByLabel('Password').fill(o.A.password);
        await a.getByLabel('Handle').fill(o.A.handle); await a.getByLabel('Display name').fill(o.A.name);
        await shot(a, 'signup');
        await a.getByRole('button', { name: 'Create account' }).click();
      } else {
        await a.goto(`${o.A.base}/login`);
        await a.getByLabel('Email').fill(o.A.email); await a.getByLabel('Password').fill(o.A.password);
        await a.getByRole('button', { name: 'Sign in' }).click();
      }
      await a.getByRole('heading', { name: 'Set up encryption' }).waitFor();
      await shot(a, 'setup-encryption');
      await a.getByRole('button', { name: 'Create a new key' }).click();
      const dl = a.waitForEvent('download');
      await a.getByRole('button', { name: 'Download key file' }).click();
      const d = await dl;
      keyA = JSON.parse(readFileSync(await d.path(), 'utf8'));
      if (!keyA || keyA.type !== 'agent-mail-key') throw new Error('key file not downloaded');
      await a.getByRole('button', { name: 'Go to inbox' }).click();
      await a.getByRole('heading', { name: 'Inbox' }).waitFor();
    });
    await step('A composes an encrypted message with an attachment to B', async () => {
      await a.getByRole('link', { name: 'Compose' }).click();
      await a.getByLabel('To').fill(o.B.address);
      await a.getByLabel('Subject').fill('Project kickoff');
      await a.getByLabel('Message').fill('Hi! Notes from today are attached. Can your agent pull out the action items?');
      await a.getByLabel('Attach files').setInputFiles({ name: 'kickoff-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('1. Ship agent-mail 0.1\n2. Two instances talking\n3. Grok Bot connector\n') });
      await shot(a, 'compose');
      await a.getByRole('button', { name: 'Send', exact: true }).click();
      await a.locator('.msg.out').first().waitFor();
      await waitFor('Delivered', async () => { await a.reload(); return (await a.locator('.msg.out footer').first().textContent())?.includes('Delivered'); }, 40000);
    });
    await step('B signs in, imports its key file, sees the request, approves', async () => {
      await b.goto(`${o.B.base}/login`);
      await b.getByLabel('Email').fill(o.bEmail); await b.getByLabel('Password').fill(o.bPassword);
      await b.getByRole('button', { name: 'Sign in' }).click();
      await b.getByRole('heading', { name: 'Set up encryption' }).waitFor();
      const kf = o.B.keys.at(-1)!;
      await b.locator('input[type=file]').setInputFiles({ name: 'key.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(kf)) });
      await b.getByRole('link', { name: /Requests/ }).click();
      await b.getByText('Project kickoff').waitFor();
      await shot(b, 'requests');
      await b.getByRole('button', { name: 'Approve' }).first().click();
      await b.getByRole('link', { name: /Inbox/ }).click();
      await b.getByText('Project kickoff').first().waitFor();
      await shot(b, 'inbox');
    });
    await step('B reads (with receipts on), decrypts the attachment and replies', async () => {
      await o.B.api('/api/settings', { method: 'PUT', body: { readReceipts: true } });
      await b.getByText('Project kickoff').first().click();
      await b.getByText('Can your agent pull out the action items?').waitFor();
      const dl = b.waitForEvent('download');
      await b.getByRole('button', { name: /kickoff-notes\.txt/ }).click();
      const d = await dl;
      const text = readFileSync(await d.path(), 'utf8');
      if (!text.includes('Two instances talking')) throw new Error('attachment did not decrypt');
      await b.getByLabel('Reply').fill('Got it. Action items: ship 0.1, test both instances, hook up the connector.');
      await b.getByRole('button', { name: 'Send reply' }).click();
      await b.getByText('hook up the connector').waitFor();
      await shot(b, 'thread-reply');
    });
    await step('A sees the reply and the read mark', async () => {
      await waitFor('reply at A', async () => { await a.goto(`${o.A.base}/`); return (await a.locator('.threads').textContent())?.includes('Action items'); }, 40000);
      await shot(a, 'inbox-a');
      await a.locator('.threads a').first().click();
      await a.getByText('hook up the connector').waitFor();
      await waitFor('Read by', async () => { await a.reload(); return (await a.locator('.msg.out footer').first().textContent())?.includes('Read by'); }, 40000);
      await shot(a, 'thread');
    });
    if (o.C) await step('Group thread with three members', async () => {
      await a.getByRole('link', { name: 'Compose' }).click();
      await a.getByLabel('To').fill(`${o.B.address}, ${o.C!.address}`);
      await a.getByLabel('Subject').fill('Standup');
      await a.getByLabel('Message').fill('Quick group check-in: what is everyone working on?');
      await a.getByRole('button', { name: 'Send', exact: true }).click();
      await a.locator('.members').waitFor();
      await waitFor('group delivered', async () => { await a.reload(); return (await a.locator('.msg.out footer').first().textContent())?.includes('Delivered'); }, 40000);
      await shot(a, 'group');
    });
    await step('Settings and Contacts', async () => {
      await a.getByRole('link', { name: 'Settings' }).click();
      await a.getByLabel('Token label').fill('Grok Bot');
      await a.getByRole('button', { name: 'Create token' }).click();
      await a.locator('code.token').waitFor();
      await a.locator('code.token').evaluate(el => { el.textContent = 'am_••••••••••••••••••••••••••••••••'; });
      await shot(a, 'settings');
      await a.getByRole('link', { name: 'Contacts' }).click();
      await a.locator('table').waitFor();
      await shot(a, 'contacts');
      const m = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true });
      const mp = await m.newPage();
      await mp.goto(`${o.B.base}/login`);
      await mp.getByLabel('Email').fill(o.bEmail); await mp.getByLabel('Password').fill(o.bPassword);
      await mp.getByRole('button', { name: 'Sign in' }).click();
      await mp.getByRole('heading', { name: 'Set up encryption' }).waitFor();
      await mp.locator('input[type=file]').setInputFiles({ name: 'key.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(o.B.keys.at(-1))) });
      await mp.getByRole('heading', { name: 'Inbox' }).waitFor();
      await mp.screenshot({ path: `${o.shots}/inbox-mobile.png` });
      await mp.locator('.threads a').first().click();
      await mp.getByText('hook up the connector').waitFor();
      await mp.screenshot({ path: `${o.shots}/thread-mobile.png` });
    });
    await o.B.api('/api/settings', { method: 'PUT', body: { readReceipts: false } });
  } finally {
    await browser.close();
  }
  return steps;
}
